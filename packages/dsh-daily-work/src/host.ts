/**
 * The host-side work service.
 *
 * This is the one place that owns the run record, the credit reservation and the
 * admission decisions. It is mounted ONCE by the host profile, not per agent
 * preset: the record is a host-scoped resource and duplicating the handle would
 * duplicate the single-writer assumption the storage domain cannot enforce.
 *
 * What this service does NOT do:
 *   - it does not read the LLM. There is exactly one model loop in DSH and it is
 *     not here. This service produces events and resource constraints.
 *   - it does not copy DSH's Session. Sessions stay the record of what happened.
 *   - it does not auto-retry an unknown outcome. Unknown is a resting state that
 *     a reconciliation resolves.
 *
 * The top-up algorithm, in the order the plan requires:
 *   event arrives -> read real state -> atomic reserve -> launch OUTSIDE the lock
 *   -> save the admission result.
 * After every await we re-check that this service is not disposed and that the
 * caller's signal is not aborted. A stale generation must not publish
 * authoritative state; the check that enforces that is the exact-owner guard in
 * `tool-protocol-guards.ts`, which compares the calling Agent by OBJECT against
 * the live registry. There is deliberately no run-epoch check here: the run
 * record has no `epoch` field, and the topology measurement behind that decision
 * is recorded in `qualification/results/R9-recovery-topology/`.
 */
import type { Context } from '@deepseek-ai/cordis'
import { Service } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { defineDomain, domainTable, type Domain } from '@deepseek-ai/dsh-storage-domain'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { admissionReason, countRun, mayAdmit, type Counts, type TaskLiveness } from './counting.ts'
import {
  ChildAdmissionGate,
  mountChildAdmissionGuard,
  type CapacitySnapshot,
  type ChildRefusal,
} from './capacity.ts'
import { acquireHomeLock, type HeldHomeLock } from './homelock.ts'
import {
  installDailyWorkTargetSetting,
  type TargetSettingHandle,
} from './target-setting.ts'
import { createContinuableLaunchPort } from './launch-port.ts'
import {
  applySpend,
  budgetReport,
  childCeiling,
  childCommitted,
  holdUnknown,
  initialRunRecord,
  isHalted,
  retainAsUnknown,
  runRecordSchema,
  type BudgetReport,
  type RunRecord,
  type TaskRecord,
} from './record.ts'
import { assertTransition, holdsSlot, type AdmissionState } from './states.ts'

/** The domain name. Doubles as the backend unit name, so it must match UNIT_NAME_RE. */
export const WORK_DOMAIN_NAME = 'dsh_daily_work'

/**
 * The record schema version.
 *
 * A change here requires an offline conversion or a new namespace with an
 * explicit cutover. The storage domain does not migrate for us, and silently
 * reading an older shape as if it were current is exactly what the plan forbids.
 */
export const WORK_SCHEMA_VERSION = 1

/**
 * The provider name the base bundle mounts for continuable children.
 *
 * Used only when `subagentProvider` is absent from config. The value is the one
 * `packages/bundle/base` sets and the shipped presets rely on, so defaulting to
 * it cannot select a provider the deployment does not have — and if the
 * deployment mounts none, the launch port is not installed at all and the drain
 * path reports `no launch port installed` rather than failing obscurely.
 */
export const DEFAULT_SUBAGENT_PROVIDER = 'spawn'

export const workDomainSpec = defineDomain({
  name: WORK_DOMAIN_NAME,
  version: WORK_SCHEMA_VERSION,
  global: {
    schema: z.object({ initialized: z.boolean() }),
    initial: { initialized: false },
  },
  tables: {
    runs: domainTable<string, RunRecord>(runRecordSchema),
  },
})

/** Everything the service needs to decide and to launch. */
export interface LaunchRequest {
  readonly taskId: string
  readonly childId: string
  readonly prompt: string
  readonly reservedCost: number
}

/** The result of asking the service to launch one child. */
export interface LaunchOutcome {
  readonly taskId: string
  readonly childId: string
  readonly accepted: boolean
  /** Present when the launch was refused or failed before admission. */
  readonly reason?: string
}

/**
 * The launch port.
 *
 * The service does not know how to start a child. It asks. The real
 * implementation calls `ctx.subagents.startContinuable`; tests supply a scripted
 * one. Keeping this a port is what lets the top-up logic be tested against a
 * controlled barrier without a second model loop.
 *
 * Contract: `launch` resolves when the child's inbox has ACCEPTED the prompt.
 * It must NOT resolve on completion. Returning early would make admission look
 * like execution, which is the single most dangerous confusion in this system.
 */
export interface LaunchPort {
  launch(request: LaunchRequest, signal: AbortSignal): Promise<{ childId: string }>
}

/**
 * The result of taking continuation ownership from the Goal driver.
 *
 * Every field is an observation, so a reader can check the claim instead of
 * trusting the note. `objectivePreserved` and `revisionUnchanged` are the two
 * that matter: they are what make this a handover rather than a deletion.
 */
export interface ContinuationHandover {
  readonly goalPresent: boolean
  readonly disarmed: boolean
  readonly objectivePreserved?: boolean
  readonly revisionUnchanged?: boolean
  readonly phaseBefore?: string
  readonly phaseAfter?: string
  readonly activationAfter?: string
  readonly note: string
}

export interface WorkServiceConfig {
  /**
   * The COMPOSITION default for the sustained child target N. Root is not part of it.
   *
   * This value seeds a new run and is the fallback when no settings provider is
   * mounted. The live, UI-settable value is `targetActiveChildren` in the
   * `daily-work` settings namespace (`src/target-setting.ts`); `createRun` reads
   * it through {@link WorkService.targetActiveChildren} unless the caller names
   * one explicitly. Both exist on purpose: a host with no settings provider
   * still has a defined target, and a host WITH one is adjustable without a
   * restart.
   */
  readonly targetChildren: number
  /**
   * Delegation depth granted to children. 1 forbids grandchildren.
   *
   * Enforced at the DEPLOYMENT BOUNDARY by `src/capacity.ts`, not merely passed
   * to the provider. `resolveChildDepth(parent, request.maxDepth)` treats a
   * caller's value as an absolute cap, so a caller passing `99` LIFTS the
   * ceiling and an omitted value is not a refusal either (docs/GAPS.md
   * G-SEAM-18). The boundary check reads the child's own durable
   * `delegationDepth`, which no request field can lower.
   */
  readonly maxDepth: number
  /**
   * The continuable-child provider the production launch port uses, e.g. 'spawn'.
   *
   * Named in config rather than hardcoded because the provider roster belongs to
   * the host composition: the base bundle mounts `subagent-spawn-in-process` and
   * sets `subagentProvider: spawn`, and a deployment that mounts a different
   * provider must be able to say so without patching this package.
   *
   * OPTIONAL, defaulting to `'spawn'`. It is the one field with a safe default:
   * the value is only read when the service installs its DEFAULT launch port, and
   * that path already returns early when no subagent runtime is mounted. A test
   * that installs its own port never reads it. The other fields have no safe
   * default — a guessed budget ceiling or depth would be a policy the operator
   * never authorized — so they stay required.
   */
  readonly subagentProvider?: string
  /** Hard budget ceiling for a new run. */
  readonly budgetCeiling: number
  readonly currency: string
  readonly priceVersion: string
  /**
   * Path of the deployment-boundary ownership file, or absent for no guard.
   *
   * The service cannot derive this: the store root belongs to the storage-json
   * backend's config, and reaching into that backend for its private `root`
   * would be a private-ABI dependency this project forbids. So the operator
   * names it, and its absence is reported rather than hidden.
   */
  readonly homeLockPath?: string
}

/**
 * The default root reserve for a ceiling.
 *
 * A tenth of the ceiling, floored at 1 and capped at 20 units. The floor exists
 * because a reserve smaller than one unit cannot pay for a single call, which
 * would make the reserve decorative; the cap exists because the reserve is for
 * the root's OWN integration and re-planning work, which does not grow with the
 * size of the delegated budget. The cap is deliberately in the run's currency
 * unit rather than a fraction, since a fraction of a large ceiling would reserve
 * credit the root cannot plausibly spend while starving the children.
 *
 * This is a default, not a policy: `createRun` accepts an explicit value, and
 * the ceiling itself is the user's authorization.
 */
function defaultRootReserve(ceiling: number): number {
  if (ceiling <= 0) return 0
  return Math.min(20, Math.max(1, Math.round(ceiling / 10)))
}

export class WorkService extends Service {
  static readonly inject = ['storageDomain', 'agents']

  private readonly config: WorkServiceConfig
  private domain: Domain<typeof workDomainSpec> | undefined
  private launchPort: LaunchPort | undefined
  private readonly liveness = new Map<string, Map<string, TaskLiveness>>()
  private readonly readyTaskCount = new Map<string, number>()
  /**
   * One coalesced drain request per run.
   *
   * Not one per event: a completion storm must not produce a storm of
   * concurrent drains, each of which would re-read the same state and try to
   * launch the same replacement. A drain that is already scheduled absorbs
   * later requests.
   */
  private readonly pendingDrain = new Map<string, Promise<LaunchOutcome[]>>()
  /** This process's deployment-boundary lock token, when a guard is configured. */
  /**
   * The held kernel lock, or undefined when no guard is configured.
   *
   * Holding the object IS the exclusion; there is no separate token to compare,
   * because the kernel object cannot be swapped the way a lock file can.
   */
  private homeLock: HeldHomeLock | undefined
  private disposed = false
  /**
   * The host-wide child slot ledger and the deployment depth ceiling.
   *
   * One per HOST, not one per run: the plan's cap is "child 全局 hard
   * capacity = 30，所有 root 合计". The service is mounted once by the host
   * profile for exactly this reason.
   */
  private readonly gate: ChildAdmissionGate
  /** The UI-settable sustained target. A live reader; see `target-setting.ts`. */
  private targetSetting: TargetSettingHandle | undefined
  /** Refusals the boundary produced, in order, so a report can surface them. */
  private readonly childRefusals: ChildRefusal[] = []

  constructor(ctx: Context, config: WorkServiceConfig) {
    super(ctx, 'dailyWork')
    this.config = config
    this.gate = new ChildAdmissionGate()
    mountChildAdmissionGuard(ctx, {
      gate: this.gate,
      maxDepth: config.maxDepth,
      onRefusal: (refusal) => {
        // Bounded: a refusal storm must not grow without limit. The COUNT is kept
        // in the gate snapshot, so dropping the oldest text loses no fact.
        if (this.childRefusals.length >= 64) this.childRefusals.shift()
        this.childRefusals.push(refusal)
      },
    })
  }

  /**
   * The sustained child target, read LIVE.
   *
   * Read from the settings section when one is installed, otherwise from
   * composition config. Called on every admission decision rather than captured
   * at construction, which is what makes a UI change take effect without a
   * restart — the same property `SubagentRuntime` gets from its
   * `settingsSource` thunk (packages/subagent/subagent/src/index.ts:229).
   */
  targetActiveChildren(): number {
    return this.targetSetting?.target() ?? this.config.targetChildren
  }

  /** The UI-settable target handle, or undefined when no settings provider is mounted. */
  get targetSettingHandle(): TargetSettingHandle | undefined {
    return this.targetSetting
  }

  /**
   * Install the `daily-work` settings section.
   *
   * Separate from the constructor so a test can mount the settings service
   * AFTER the work service, which is the composition order the profile loader
   * can produce. Idempotent per service instance: a second call replaces the
   * handle, which is what an HMR reload of the settings plugin needs.
   *
   * @param owner - the context whose unload suppresses the settings fallback.
   */
  installTargetSetting(owner: Context): TargetSettingHandle {
    this.targetSetting = installDailyWorkTargetSetting(owner, {
      targetActiveChildren: this.config.targetChildren,
    })
    return this.targetSetting
  }

  /** The host-wide capacity reading, every occupancy class separate. */
  capacity(): CapacitySnapshot {
    return this.gate.snapshot()
  }

  /**
   * The host-wide slot ledger itself.
   *
   * Exposed because the boundary check and the report must read ONE ledger, and
   * a test that re-derived occupancy from the record would be measuring a second
   * opinion. Read-only by convention: the only mutators are `admit`, `transition`
   * and the `agent/created` / `agent/disposed` listeners.
   */
  get capacityGate(): ChildAdmissionGate {
    return this.gate
  }

  /** Refusals the deployment boundary produced, newest last. */
  refusals(): readonly ChildRefusal[] {
    return [...this.childRefusals]
  }

  /**
   * Resolve the target a new run records.
   *
   * The default is the LIVE setting, not the composition value captured at
   * construction: a user who raises N through the UI must get the raised target
   * on the next run without restarting the host. A caller-supplied value wins,
   * because the caller is a host authorization edge and the live setting is a
   * default.
   *
   * The value is validated as a non-negative safe integer but NOT clamped to the
   * hard capacity, for the reason given at the call site: a target is a promise
   * about intent, and the gate is the thing that refuses children.
   */
  private resolveRequestedTarget(explicit: number | undefined): number {
    const target = explicit ?? this.targetActiveChildren()
    if (!Number.isSafeInteger(target) || target < 0 || Object.is(target, -0)) {
      throw new Error(
        `dailyWork: target children must be a non-negative safe integer, got ${String(target)}`,
      )
    }
    return target
  }

  /** Set the launch port. Exactly one may be installed; a second call replaces it. */
  setLaunchPort(port: LaunchPort): void {
    this.launchPort = port
  }

  /**
   * Install the PRODUCTION launch port for a root, unless one is already set.
   *
   * WHY THIS EXISTS. `host-plugin.ts` used to construct the service, register
   * the disposer and call `open()` — and never install a port. The drain branch
   * below documents what that meant: every `submit` recorded a task, moved it to
   * `unknown` with `uncertainty: 'no launch port installed'`, and launched
   * nothing. The N=10 concurrency result was therefore a result about the
   * service with a port a TEST had installed, which is what a port seam is for,
   * but the composed daily profile could not launch a single child. The gap
   * between "the mechanism is proven" and "the product does it" was one missing
   * call.
   *
   * WHY IT IS BOUND HERE, AT createRun. The port needs the exact live root
   * Agent, and `createRun` is the only place that object is in hand. Binding it
   * to a session-id string instead would reintroduce the stale-owner problem
   * `tool-protocol-guards.ts` exists to close: authority must follow the object,
   * not an id that survives replacement.
   *
   * WHY IT DOES NOT OVERWRITE AN INSTALLED PORT. A test that installs a
   * scripted port must keep it; silently replacing it with the real one would
   * make every scripted test reach a real provider and would hide the very seam
   * being tested. So the production port is a DEFAULT, not an override.
   *
   * @param root - the exact live root Agent this run belongs to.
   */
  private installDefaultLaunchPort(root: Agent): void {
    if (this.launchPort !== undefined) return
    const subagents = this.ctx.get('subagents')
    if (subagents === undefined) {
      // No subagent runtime: leaving the port unset is correct, because the
      // drain path reports `no launch port installed` rather than pretending a
      // task failed cleanly. Inventing a port here would fabricate the ability.
      return
    }
    this.launchPort = createContinuableLaunchPort({
      subagents,
      parent: root,
      // The composition's provider name, or the base bundle's `spawn` when the
      // operator named none. See the field's doc comment for why this one field
      // may default and the others may not.
      provider: this.config.subagentProvider ?? DEFAULT_SUBAGENT_PROVIDER,
      maxDepth: this.config.maxDepth,
    })
  }

  /**
   * Open the domain.
   *
   * Called explicitly by the mounting plugin inside its own effect, so the
   * handle's lifetime is owned by that effect rather than by this constructor.
   * Opening twice is a caller bug and the facility rejects it; we surface that
   * rather than swallowing it.
   *
   * The deployment-boundary guard runs FIRST, before the domain is touched, so
   * a second host is refused before it can read a stale snapshot and republish
   * it over the live host's writes.
   */
  async open(): Promise<void> {
    if (this.domain !== undefined) throw new Error('dailyWork: domain is already open')
    await this.acquireHomeLock()
    const facility = this.ctx.get('storageDomain')
    if (facility === undefined) {
      await this.releaseHomeLock()
      throw new Error('dailyWork: the storageDomain service is not mounted; cannot persist run records')
    }
    try {
      this.domain = await facility.open(workDomainSpec)
    } catch (error) {
      // The domain never opened, so this process holds no store: releasing the
      // claim here is what stops a failed boot from blocking the next one.
      await this.releaseHomeLock()
      throw error
    }
  }

  /** Close the domain. Refuses new writes first, then releases the handle. */
  async close(): Promise<void> {
    this.disposed = true
    const domain = this.domain
    this.domain = undefined
    try {
      if (domain !== undefined) await domain.close()
    } finally {
      // In a finally because a failed teardown must not leave the deployment
      // boundary claimed by a process that is no longer serving the store.
      await this.releaseHomeLock()
    }
  }

  /**
   * Take the deployment-boundary lock, or refuse to start.
   *
   * The exclusion itself lives in `homelock.ts`: a KERNEL-held lock (a named
   * Win32 semaphore, or `flock` on a verified inode), not the read/rename/link
   * protocol this method used to implement. That protocol had a legal
   * interleaving in which two contenders both won, reproduced on this machine in
   * `qualification/results/M10.0-audit-repro/stale_lock_windows.py`; the fix is
   * to stop making a replaceable FILE the mutual-exclusion object.
   *
   * The kernel releases the lock on process death, so a crashed holder never
   * blocks a successor and no pid/TTL heuristic is needed.
   */
  private async acquireHomeLock(): Promise<void> {
    const path = this.config.homeLockPath
    if (path === undefined) return
    this.homeLock = await acquireHomeLock(path)
  }

  /**
   * Give up the deployment-boundary lock.
   *
   * Releasing closes the kernel handle, which is the whole operation: the old
   * protocol had to delete a file and therefore had to reason about whether the
   * path still belonged to this holder. There is no file to reason about now.
   */
  private async releaseHomeLock(): Promise<void> {
    const held = this.homeLock
    if (held === undefined) return
    this.homeLock = undefined
    await held.release()
  }

  private runs() {
    const domain = this.domain
    if (domain === undefined) throw new Error('dailyWork: domain is not open')
    return domain.table('runs')
  }

  /**
   * Create a run for an exact live Agent.
   *
   * The root Agent is stored as an identity, not as a string: authority is bound
   * to the live object, so a stale callback carrying the same session id cannot
   * write authoritative state (INV-L3). The enforcement is object identity in
   * `tool-protocol-guards.ts`; this record deliberately carries NO run `epoch`,
   * because no settlement path exists that could present a stale one (see
   * `qualification/results/R9-recovery-topology/`).
   *
   * `rootReserve` carves the root's own credit out of the ceiling at creation
   * time. It defaults to a fraction of the ceiling rather than to zero, because
   * a zero reserve would make INV-C2 ("root retains reserved inference credit")
   * a sentence with nothing behind it: ten children could commit the whole
   * ceiling and the root would have no credit left to integrate results or
   * submit replacements, which is precisely the failure C05 names. The default
   * is one tenth, bounded so a small ceiling still leaves the root something
   * usable and a large one does not reserve more than a root can spend.
   */
  async createRun(input: {
    runId: string
    root: Agent
    authorizationRef: string
    targetChildren?: number
    restartResumeAuthorized?: boolean
    rootReserve?: number
    now?: string
  }): Promise<RunRecord> {
    this.assertOpen()
    const now = input.now ?? new Date().toISOString()
    const ceiling = this.config.budgetCeiling
    // The production launch port is bound to THIS exact root before any task can
    // be admitted, so a submit through the composed profile reaches the real
    // continuable seam instead of reporting `no launch port installed`.
    this.installDefaultLaunchPort(input.root)
    // Exactly ONE continuation owner per root. A managed run wakes its root when
    // a child settles, and DSH's Goal round-driver ALSO auto-continues an idle
    // agent; leaving both armed is a double-continuation loop. Taking it here --
    // at the only moment the exact live root is in hand, and before the run can
    // accept any work -- is what makes the "one owner" rule true in the product
    // rather than only in the tests that call `takeContinuation` directly.
    //
    // The handover result is RECORDED rather than acted on, so a reader can check
    // that the durable objective and its revision survived instead of trusting
    // that `disarm` was mild. Nothing here fails the run if the goal service is
    // absent: with no Goal mounted there is nothing to contend with.
    const continuation = this.takeContinuation(input.root)
    const rootReserve = input.rootReserve ?? defaultRootReserve(ceiling)
    if (rootReserve < 0) throw new Error(`dailyWork: rootReserve ${rootReserve} cannot be negative`)
    if (rootReserve > ceiling) {
      throw new Error(
        `dailyWork: rootReserve ${rootReserve} exceeds the ceiling ${ceiling}; the reserve is a part of the `
        + 'ceiling, not an addition to it',
      )
    }
    const record = initialRunRecord({
      runId: input.runId,
      rootSessionId: input.root.session.header.id,
      authorizationRef: input.authorizationRef,
      // An explicit `targetChildren` is a HOST authorization edge: the UI reaches
      // this through the live setting, a test fixture names it directly. It is
      // deliberately NOT bounded by HARD_CHILD_CAPACITY here, and the reason is
      // stated rather than left implicit: this number is a TARGET, and the only
      // thing that can actually refuse a child is the capacity gate. Bounding a
      // target would not bound a child; it would only make the recorded target
      // disagree with the deficit the host reports. A target above the cap
      // therefore surfaces as a permanent, honestly-labelled deficit, while the
      // gate refuses the child that would exceed 30. The UI CONTROL path is
      // bounded at both boundaries by `src/target-setting.ts`.
      requestedTarget: this.resolveRequestedTarget(input.targetChildren),
      maxDepth: this.config.maxDepth,
      // Stored, not merely logged: see continuationHandoverSchema. A run whose
      // continuation was never handed over is indistinguishable from one whose
      // handover was recorded as "no goal present" unless the result is on the
      // record, and those are different facts about who drives this root.
      continuation: continuation,
      policyDigest: this.config.priceVersion,
      budget: {
        currency: this.config.currency,
        priceVersion: this.config.priceVersion,
        spent: 0,
        reserved: 0,
        unknownReserved: 0,
        ceiling,
        rootReserve,
        rootSpent: 0,
        overage: 0,
      },
      restartResumeAuthorized: input.restartResumeAuthorized ?? false,
      now,
    })
    await this.runs().put(input.runId, record)
    return record
  }

  /** Read a run. Returns the stored object; callers must treat it as immutable. */
  getRun(runId: string): RunRecord | undefined {
    this.assertOpen()
    return this.runs().get(runId)
  }

  /** The current counts for a run, computed from stored state plus observed liveness. */
  counts(runId: string): Counts {
    const record = this.requireRun(runId)
    return countRun(record, this.liveness.get(runId) ?? new Map(), this.readyTaskCount.get(runId) ?? 0)
  }

  /** Record how many ready tasks the root currently has. Mechanical, no model call. */
  setReadyTasks(runId: string, ready: number): void {
    this.readyTaskCount.set(runId, ready)
  }

  /** Record observed liveness for one task. Mechanical, no model call. */
  observe(runId: string, liveness: TaskLiveness): void {
    let perRun = this.liveness.get(runId)
    if (perRun === undefined) {
      perRun = new Map()
      this.liveness.set(runId, perRun)
    }
    perRun.set(liveness.taskId, liveness)
  }

  /**
   * Take over continuation for a root, so exactly ONE owner drives it.
   *
   * Why this exists: DSH's Goal is a durable objective PLUS an independent
   * round driver that auto-continues an idle agent. A managed work run is also a
   * continuation driver, because it wakes the root when a child settles. Two
   * drivers on one root is a double-continuation loop, and the plan requires
   * exactly one.
   *
   * The resolution is deliberately the mildest one available. `disarm` removes
   * only the PROCESS-LOCAL continuation authority:
   *
   *   - it does NOT clear the durable objective
   *   - it does NOT bump the goal revision
   *   - it does NOT fake completion
   *
   * so the goal stays visible and honest on the medium, and a later
   * human-authorized `resume` records a new activation edge. Nothing here
   * touches the goal's private activation state.
   *
   * @param root - the exact live Agent whose continuation we are taking over.
   * @returns what was found and what was changed, for the record.
   */
  takeContinuation(root: Agent): ContinuationHandover {
    const goals = this.ctx.get('goals')
    if (goals === undefined) {
      // No Goal service in this profile. There is nothing to contend with, so
      // this is a complete, honest answer rather than a failure.
      return { goalPresent: false, disarmed: false, note: 'no goal service is mounted in this profile' }
    }
    const before = goals.get(root)
    if (before === undefined) {
      return { goalPresent: false, disarmed: false, note: 'the root has no current goal' }
    }
    goals.disarm(root)
    const after = goals.get(root)
    return {
      goalPresent: true,
      disarmed: true,
      // Recorded so a reader can check the claim rather than trust it.
      objectivePreserved: after?.objective === before.objective,
      revisionUnchanged: after?.revision === before.revision,
      phaseBefore: before.phase,
      phaseAfter: after?.phase,
      activationAfter: after?.activation,
      note: 'process-local continuation removed; the durable objective and revision are untouched',
    }
  }

  /** Every run id this host knows about. Used to map a live session to its run. */
  listRunIds(): string[] {
    this.assertOpen()
    return [...this.runs().keys()]
  }

  /**
   * Request that a run move to closing.
   *
   * This backs the model's `finish` action, and it is deliberately NOT a
   * confirmation. It stops new admissions and leaves the acceptance decision to
   * the runner. Letting the model's own finish call mark work verified would
   * make the model the oracle for its own output, which the verification gate
   * exists to prevent.
   */
  async beginClosing(runId: string, now = new Date().toISOString()): Promise<RunRecord> {
    return this.mutate(runId, record => ({
      ...record,
      phase: record.phase === 'open' ? 'closing' : record.phase,
      updatedAt: now,
    }))
  }

  /**
   * Pause the run.
   *
   * A pause stops new admissions and does NOT drain. `drainContinuableDescendants`
   * closes admission for that exact parent permanently, so using it for a pause
   * would make a later resume impossible. Pause is therefore a record change plus
   * a refusal to admit; the caller separately interrupts individual children.
   *
   * A user pause outranks top-up (INV-G4).
   */
  async pause(runId: string, reason: string, now = new Date().toISOString()): Promise<RunRecord> {
    return this.mutate(runId, record => ({
      ...record,
      phase: record.phase === 'open' ? 'paused' : record.phase,
      updatedAt: now,
      outbox: {
        ...record.outbox,
        [`pause-${now}`]: {
          id: `pause-${now}`,
          destination: 'root',
          payloadDigest: reason,
          stage: 'pending' as const,
          createdAt: now,
        },
      },
    }))
  }

  /** Resume a paused run. This is a new authorization edge, never an implicit one. */
  async resume(runId: string, now = new Date().toISOString()): Promise<RunRecord> {
    return this.mutate(runId, record => ({
      ...record,
      phase: record.phase === 'paused' ? 'open' : record.phase,
      updatedAt: now,
    }))
  }

  /**
   * Change one run's sustained target.
   *
   * This is the HOST authorization edge for the live target. In production the
   * value arrives through the `daily-work` settings section
   * (`src/target-setting.ts`) and is written by the authenticated UI; this method
   * is the record-level application of it, so a test can exercise the same
   * semantics without a settings provider.
   *
   * What it deliberately does NOT do, because the plan's rules are all
   * prohibitions here:
   *   - it does not touch a running task's own `reservedCost` (INV: "N变化不改正在
   *     运行任务的原budget");
   *   - it does not cancel, kill or drain anything ("N降低停止新接纳，让已运行任务
   *     收敛；急停是单独显式操作");
   *   - it does not touch the budget ceiling, which is a separate authorization.
   *
   * A LOWER therefore only reduces the deficit; existing holders keep their slots
   * until they settle, and no new admission occurs while `held >= target`.
   *
   * @param runId - the run whose target changes.
   * @param target - the new target; a non-negative safe integer.
   */
  async setTargetChildren(runId: string, target: number): Promise<RunRecord> {
    if (!Number.isSafeInteger(target) || target < 0 || Object.is(target, -0)) {
      throw new Error(`dailyWork: target children must be a non-negative safe integer, got ${String(target)}`)
    }
    return this.mutate(runId, record => ({
      ...record,
      requestedTarget: target,
      updatedAt: new Date().toISOString(),
    }))
  }

  /**
   * Admit one task and reserve its cost, atomically, in a single `update`.
   *
   * Task state, budget reservation and the outbox entry move together because
   * they live in ONE record. Writing them under separate keys and calling that
   * atomic would be a lie: the domain gives atomicity per record, not across
   * keys (INV-D1).
   *
   * Two refusals happen here that are worth naming, because they are the C05
   * and C11 gates expressed as arithmetic:
   *
   *   - the commitment is measured against `childCeiling` = `ceiling - rootReserve`,
   *     NOT against `ceiling`. A child admission that would eat into the root's
   *     reserve is therefore refused by the same comparison that refuses an
   *     over-ceiling one. This is the invariant: **for every reachable state,
   *     `spent + reserved + unknownReserved <= ceiling - rootReserve`, so the
   *     root always retains at least `rootReserve - rootSpent` of its own
   *     credit regardless of how many children were admitted.**
   *   - a recorded overage halt refuses admission outright, even when the
   *     arithmetic headroom is positive. See `mayAdmit` for why that ordering
   *     matters.
   *
   * The transform is pure and synchronous. No I/O, no launch, no network inside.
   */
  async admit(input: {
    runId: string
    taskId: string
    childId: string
    assignmentDigest: string
    reservedCost: number
    allowedCapabilities: readonly string[]
    now?: string
  }): Promise<TaskRecord> {
    this.assertOpen()
    const now = input.now ?? new Date().toISOString()
    // The host-wide slot is taken BEFORE the record write and released if the
    // write refuses. WHY BEFORE: the plan's rule is "pre-publication同步
    // reserve；失败清理后release；不能'先启动再计数'". Taking it after the record
    // write would leave a window in which the record says a task exists and the
    // host has not counted it, which is exactly the "start first, count later"
    // shape the rule forbids.
    //
    // The bucket starts at `reserved`, which the plan counts:
    // `occupied = reserved + starting + active_assignment + stopping +
    // unknown_quarantined`. A reservation with no child yet therefore still
    // blocks the 31st admission.
    const slot = this.gate.reserveTask(input.taskId, 'reserved', input.childId)
    const updated = await this.runs().update(input.runId, record => {
      if (record.phase !== 'open') {
        throw new Error(`dailyWork: run "${input.runId}" is ${record.phase}; refusing admission`)
      }
      if (isHalted(record.budget)) {
        throw new Error(
          `dailyWork: run "${input.runId}" is halted on a recorded budget overage (${record.budget.halt?.reason}); `
          + 'refusing admission until a human resolves it',
        )
      }
      const budget = record.budget
      const committed = childCommitted(budget)
      const limit = childCeiling(budget)
      if (committed + input.reservedCost > limit) {
        throw new Error(
          `dailyWork: run "${input.runId}" has no budget headroom (committed ${committed}, child ceiling ${limit}, `
          + `root reserve ${budget.rootReserve ?? 0} of ceiling ${budget.ceiling})`,
        )
      }
      const existing = record.tasks[input.taskId]
      if (existing !== undefined && holdsSlot(existing.state)) {
        throw new Error(`dailyWork: task "${input.taskId}" is already admitted as ${existing.state}`)
      }
      if (record.terminalTombstones.includes(input.taskId)) {
        throw new Error(`dailyWork: task "${input.taskId}" is a closed tombstone and cannot be reopened`)
      }
      const task: TaskRecord = {
        taskId: input.taskId,
        assignmentDigest: input.assignmentDigest,
        childId: input.childId,
        attempt: (existing?.attempt ?? 0) + 1,
        state: 'prepared',
        allowedCapabilities: [...input.allowedCapabilities],
        inputRefs: [],
        outputRefs: [],
        reservedCost: input.reservedCost,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      }
      return {
        ...record,
        tasks: { ...record.tasks, [input.taskId]: task },
        budget: { ...budget, reserved: budget.reserved + input.reservedCost },
        outbox: {
          ...record.outbox,
          [`admit-${input.taskId}`]: {
            id: `admit-${input.taskId}`,
            destination: 'root',
            payloadDigest: input.assignmentDigest,
            stage: 'pending' as const,
            createdAt: now,
          },
        },
        updatedAt: now,
      }
    }).catch((error: unknown) => {
      // The record write refused, so no task exists: give the slot back rather
      // than leaking capacity for a child that was never admitted. This is the
      // "失败清理后 release" half of the plan's rule.
      slot.release()
      throw error
    })
    const task = updated.tasks[input.taskId]
    if (task === undefined) {
      slot.release()
      throw new Error(`dailyWork: admission of "${input.taskId}" did not persist`)
    }
    return task
  }

  /**
   * Move a task to a new state, with the transition checked.
   *
   * `releaseReservation` is explicit because releasing a credit is a separate
   * decision from changing a state: a cancel that is merely *requested* must not
   * release anything.
   *
   * `spentCost` is the ACTUAL cost attributed to this transition, and it is
   * applied through `applySpend`, which is what makes C11 true here: when the
   * actual cost exceeds the reservation this task holds, the excess is recorded
   * in `budget.overage` and an admission halt is set. The full amount is added
   * to `spent` in every case. Nothing is clamped to the reservation, and no
   * code path in this method can leave an overspend looking green.
   *
   * The reservation this spend is measured against is the task's own
   * `reservedCost`, read from the STORED task rather than from the caller. A
   * caller cannot widen the estimate after the fact to hide an overage.
   */
  async transition(input: {
    runId: string
    taskId: string
    to: AdmissionState
    releaseReservation?: boolean
    spentCost?: number
    uncertainty?: string
    now?: string
  }): Promise<TaskRecord> {
    this.assertOpen()
    const now = input.now ?? new Date().toISOString()
    const updated = await this.runs().update(input.runId, record => {
      const task = record.tasks[input.taskId]
      if (task === undefined) throw new Error(`dailyWork: task "${input.taskId}" is not in run "${input.runId}"`)
      assertTransition(task.state, input.to, input.taskId)

      const release = input.releaseReservation ?? (input.to === 'confirmed' || input.to === 'cancelled')
      const spentCost = input.spentCost ?? 0
      const budget = spentCost === 0
        ? {
            ...record.budget,
            reserved: release
              ? Math.max(0, record.budget.reserved - task.reservedCost)
              : record.budget.reserved,
          }
        : applySpend(record.budget, {
            reservationReleased: release ? task.reservedCost : 0,
            reservationCovering: task.reservedCost,
            actualCost: spentCost,
            reason: `task "${input.taskId}" settled as ${input.to}`,
            now,
          })

      const next: TaskRecord = {
        ...task,
        state: input.to,
        updatedAt: now,
        ...(input.spentCost === undefined ? {} : { spentCost: (task.spentCost ?? 0) + input.spentCost }),
        ...(input.uncertainty === undefined ? {} : { uncertainty: input.uncertainty }),
      }
      const tombstones =
        input.to === 'confirmed' || input.to === 'cancelled'
          ? [...new Set([...record.terminalTombstones, input.taskId])]
          : record.terminalTombstones

      return {
        ...record,
        tasks: { ...record.tasks, [input.taskId]: next },
        budget,
        terminalTombstones: tombstones,
        updatedAt: now,
      }
    })
    const task = updated.tasks[input.taskId]
    if (task === undefined) throw new Error(`dailyWork: transition of "${input.taskId}" did not persist`)
    this.syncSlotToState(input.taskId, input.to)
    return task
  }

  /**
   * Keep the host-wide slot's occupancy class in step with the task's state.
   *
   * WHY THIS IS NOT DERIVED FROM THE RECORD. The record is durable and shared;
   * the slot is process-local and must track what THIS host has materialized.
   * Deriving the bucket from the stored state on every read would make the gate
   * agree with a record it cannot actually enforce — a second host reading the
   * same store would then believe it held children it never created.
   *
   * The two mappings that carry the plan's meaning:
   *   - `executing` and `settling` are `active_assignment`. A child blocked
   *     inside its own tool or provider call is `executing` here and STILL
   *     occupies: waiting is not finishing.
   *   - `cancel_requested` is `stopping`. A cancel that has been requested but
   *     not confirmed holds the slot, so it still blocks the 31st admission.
   *
   * `confirmed` and `cancelled` are the only states that release, and they
   * release the TASK slot only. The physical child's own slot is released by
   * `agent/disposed` in `capacity.ts`, because a record transition is not
   * evidence that a process stopped.
   */
  private syncSlotToState(taskId: string, to: AdmissionState): void {
    switch (to) {
      case 'confirmed':
      case 'cancelled':
        this.gate.releaseTask(taskId)
        return
      case 'prepared':
        this.gate.reserveTask(taskId, 'reserved')
        return
      case 'launching':
        this.gate.reserveTask(taskId, 'starting')
        return
      case 'unknown':
        this.gate.reserveTask(taskId, 'unknown_quarantined')
        return
      case 'cancel_requested':
        this.gate.reserveTask(taskId, 'stopping')
        return
      case 'accepted':
      case 'executing':
      case 'settling':
        this.gate.reserveTask(taskId, 'active_assignment')
        return
    }
  }

  /**
   * Record a spend that belongs to no task transition: a retry, a compaction, a
   * summary, or a root call.
   *
   * WHY THIS IS A SEPARATE METHOD from `transition`. The plan's cost rule is
   * "cost covers root + descendants + retries + compaction/summary/search", and
   * three of those five are not task state changes. A compaction request does
   * not move any task, and the root's own integration work belongs to no child.
   * Routing them through `transition` would require inventing a task for each,
   * which would corrupt the counts that C01/C04/C07 depend on.
   *
   * @param input.taskId - the task this spend is measured against, when there is
   *   one. Its STORED `reservedCost` is the estimate the actual is compared to,
   *   so an overage is detected against what was really reserved.
   * @param input.reservationCovering - the estimate to compare against when
   *   there is no task (a compaction reserve, a root-call reserve). Ignored when
   *   `taskId` resolves.
   * @param input.releaseReservation - whether this spend retires the task's
   *   reservation. Defaults to false: a spend that is merely reported must not
   *   free credit, because the work may still be running.
   * @param input.actualCost - what was actually charged. Recorded in full.
   */
  async recordSpend(input: {
    runId: string
    taskId?: string
    reservationCovering?: number
    releaseReservation?: boolean
    actualCost: number
    reason: string
    now?: string
  }): Promise<RunRecord> {
    if (input.actualCost < 0) throw new Error(`dailyWork: actualCost ${input.actualCost} cannot be negative`)
    return this.mutate(input.runId, record => {
      const task = input.taskId === undefined ? undefined : record.tasks[input.taskId]
      if (input.taskId !== undefined && task === undefined) {
        throw new Error(`dailyWork: task "${input.taskId}" is not in run "${input.runId}"`)
      }
      const covering = task?.reservedCost ?? input.reservationCovering ?? 0
      const release = input.releaseReservation ?? false
      if (release && task === undefined) {
        throw new Error(
          'dailyWork: releaseReservation requires a taskId; there is no reservation to retire otherwise',
        )
      }
      return {
        ...record,
        budget: applySpend(record.budget, {
          reservationReleased: release ? (task?.reservedCost ?? 0) : 0,
          reservationCovering: covering,
          actualCost: input.actualCost,
          reason: input.reason,
          now: input.now ?? new Date().toISOString(),
        }),
        updatedAt: input.now ?? new Date().toISOString(),
      }
    })
  }

  /**
   * Spend part of the ROOT's own reserve.
   *
   * This is the other half of C05: the reserve is not merely withheld from
   * children, it is spendable by the root. Two properties are enforced here and
   * tested:
   *
   *   - a root spend draws only on `rootReserve - rootSpent`, so the reserve is
   *     a real budget rather than a number that is never used;
   *   - it never touches `spent`, `reserved` or `unknownReserved`, so a root
   *     spend cannot consume child headroom, and a child admission can never
   *     consume the root's.
   *
   * The overage rule applies here too: a root spend larger than the remaining
   * reserve is recorded IN FULL in `rootSpent` and halts admission, rather than
   * being trimmed to fit. Trimming would hide the fact that the reserve was
   * undersized.
   *
   * @returns the run record after the spend, so a caller can read the deficit.
   */
  async spendRoot(input: {
    runId: string
    actualCost: number
    reason: string
    now?: string
  }): Promise<RunRecord> {
    if (input.actualCost < 0) throw new Error(`dailyWork: actualCost ${input.actualCost} cannot be negative`)
    const now = input.now ?? new Date().toISOString()
    return this.mutate(input.runId, record => {
      const reserve = record.budget.rootReserve ?? 0
      const spentRoot = record.budget.rootSpent ?? 0
      const available = Math.max(0, reserve - spentRoot)
      const overage = Math.max(0, input.actualCost - available)
      const nextRootSpent = spentRoot + input.actualCost
      const budget = {
        ...record.budget,
        rootSpent: nextRootSpent,
        ...(overage === 0
          ? {}
          : {
              halt: {
                reason:
                  `${input.reason}: root spend ${input.actualCost} exceeded the remaining root reserve ${available} `
                  + `by ${overage}; the full amount is recorded in rootSpent and new admissions are paused until a `
                  + 'human resolves it',
                at: now,
              },
            }),
      }
      return { ...record, budget, updatedAt: now }
    })
  }

  /**
   * Hold a reservation as permanently UNKNOWN rather than zero.
   *
   * This is the D07/C10 rule applied to cost: a request whose usage we will
   * never learn keeps a conservative reservation. Nothing is released, nothing
   * is zeroed, and the gap remains legible in the record.
   *
   * Two distinct situations, and conflating them would be a real bug:
   *
   *   - `taskId` given: the amount moves from `reserved` to `unknownReserved`.
   *     The commitment total is UNCHANGED - the credit was already committed,
   *     and this only renames why it is held. The amount is clamped to the
   *     TASK's own `reservedCost`, not to the run's `reserved`, so one task's
   *     unknown can never eat a sibling's reservation.
   *   - no `taskId`: the amount was never reserved (a compaction, summary or
   *     search call authorized on the fly). It is ADDED to `unknownReserved`,
   *     which raises the commitment total and can only tighten admission. That
   *     is the conservative direction, and it is the whole point: an
   *     unreported auxiliary charge must not look like a free one.
   *
   * @returns the run record after the change, so a caller can read the deficit.
   */
  async retainUnknown(input: {
    runId: string
    taskId?: string
    amount: number
    reason: string
    now?: string
  }): Promise<RunRecord> {
    if (input.amount < 0) throw new Error(`dailyWork: unknown retention ${input.amount} cannot be negative`)
    const now = input.now ?? new Date().toISOString()
    return this.mutate(input.runId, record => {
      const taskId = input.taskId
      const task = taskId === undefined ? undefined : record.tasks[taskId]
      if (taskId !== undefined && task === undefined) {
        throw new Error(`dailyWork: task "${taskId}" is not in run "${input.runId}"`)
      }
      const budget = task === undefined
        ? holdUnknown(record.budget, input.amount)
        : retainAsUnknown(record.budget, Math.min(input.amount, task.reservedCost))
      const tasks = task === undefined || taskId === undefined
        ? record.tasks
        : { ...record.tasks, [taskId]: { ...task, uncertainty: input.reason, updatedAt: now } }
      return { ...record, tasks, budget, updatedAt: now }
    })
  }

  /**
   * Clear a recorded overage halt. This is a HUMAN authorization edge.
   *
   * It is deliberately not called by any automatic path, and not by `resume`:
   * an overspend is resolved by a person deciding the run may continue, or by
   * the run ending. Clearing it automatically would make the halt decorative.
   * The overage itself is NOT cleared - `budget.overage` and `budget.spent` keep
   * the full amount forever, because the bill is history.
   */
  async resolveHalt(input: {
    runId: string
    authorizationRef: string
    note: string
    now?: string
  }): Promise<RunRecord> {
    const now = input.now ?? new Date().toISOString()
    return this.mutate(input.runId, record => {
      const halt = record.budget.halt
      if (halt === undefined) throw new Error(`dailyWork: run "${input.runId}" has no budget halt to resolve`)
      const { halt: _dropped, ...rest } = record.budget
      return {
        ...record,
        budget: rest,
        updatedAt: now,
        outbox: {
          ...record.outbox,
          [`halt-resolved-${now}`]: {
            id: `halt-resolved-${now}`,
            destination: 'root',
            payloadDigest: `${input.authorizationRef}: ${input.note}`,
            stage: 'pending' as const,
            createdAt: now,
          },
        },
      }
    })
  }

  /**
   * The budget as a reader needs it: the reserve, the child headroom, the
   * overage and the halt, each as its own number.
   *
   * This exists so no caller has to re-derive `ceiling - rootReserve` by hand.
   * A second derivation is how a gate and its reported reason drift apart.
   */
  budget(runId: string): BudgetReport {
    return budgetReport(this.requireRun(runId).budget)
  }

  /**
   * Whether a task may be admitted right now, and why not when it may not.
   *
   * A read-only companion to `admit`, so a caller can report the deficit
   * WITHOUT attempting a write. The plan's rule for a blocked target is that
   * the fact stays unchanged and the deficit is shown: this is the method that
   * shows it. It shares `mayAdmit` with the write path, so the answer cannot
   * disagree with what `admit` would do.
   */
  admissionCheck(runId: string, outstandingCost: number): {
    readonly allowed: boolean
    readonly reason: string
    readonly counts: Counts
    readonly budget: BudgetReport
  } {
    const record = this.requireRun(runId)
    const counts = this.counts(runId)
    const allowed = mayAdmit(record, counts, outstandingCost)
    return {
      allowed,
      // `admissionReason`, not `counts.deficitReason`: the counts alone cannot
      // see this request's cost, so reading them here would let a budget
      // refusal be reported as a slot problem.
      reason: allowed ? 'none' : admissionReason(record, counts, outstandingCost),
      counts,
      budget: budgetReport(record.budget),
    }
  }

  /**
   * Run one coalesced drain for a run.
   *
   * This is the rolling top-up. It is deliberately a plain async function with
   * no timer: it is triggered by events (a child settling) and by the root
   * asking, never by a polling loop that burns model calls.
   *
   * Sequence, per the plan:
   *   1. read the real state (counts from stored record + observed liveness)
   *   2. decide admission from that state
   *   3. atomically reserve
   *   4. launch OUTSIDE the lock
   *   5. save the admission result
   * After each await, re-check that this drain is still the current one for the
   * run and that the service is not disposed.
   */
  async drain(runId: string, requests: readonly LaunchRequest[], signal: AbortSignal): Promise<LaunchOutcome[]> {
    const inFlight = this.pendingDrain.get(runId)
    if (inFlight !== undefined) {
      // Coalesce: a drain is already running for this run. Absorb rather than
      // stacking a second concurrent drain that would race on the same slots.
      await inFlight
    }
    const task = this.runDrain(runId, requests, signal)
    this.pendingDrain.set(runId, task)
    try {
      return await task
    } finally {
      if (this.pendingDrain.get(runId) === task) this.pendingDrain.delete(runId)
    }
  }

  private async runDrain(
    runId: string,
    requests: readonly LaunchRequest[],
    signal: AbortSignal,
  ): Promise<LaunchOutcome[]> {
    const outcomes: LaunchOutcome[] = []
    for (const request of requests) {
      if (this.disposed) break
      if (signal.aborted) break

      const record = this.requireRun(runId)
      const counts = countRun(record, this.liveness.get(runId) ?? new Map(), this.readyTaskCount.get(runId) ?? 0)
      if (!mayAdmit(record, counts, request.reservedCost)) {
        outcomes.push({
          taskId: request.taskId,
          childId: request.childId,
          accepted: false,
          // The reason must be the one the GATE used, which needs this
          // request's cost. `counts.deficitReason` cannot see it and would
          // report a slot problem for a budget refusal.
          reason: admissionReason(record, counts, request.reservedCost),
        })
        continue
      }
      // The HOST-WIDE gate, which the per-run deficit cannot see.
      //
      // WHY A SECOND CHECK IS NOT REDUNDANT. `counts.capacityDeficit` is
      // `requestedTarget - held` for THIS run. It says nothing about the other
      // roots sharing the host, and nothing about children materialized outside
      // this run's record (a workflow's `startChild`, a direct delegation). So a
      // run with a free target slot can still be the request that would push the
      // HOST past 30. `admit` re-checks synchronously and throws, which is the
      // authoritative refusal; this check exists so the outcome reports the
      // host-capacity reason instead of surfacing as a generic admission error.
      if (this.gate.occupied >= this.gate.limit) {
        outcomes.push({
          taskId: request.taskId,
          childId: request.childId,
          accepted: false,
          reason: 'host_capacity_reached',
        })
        continue
      }

      // Step 3: atomic reserve. If this throws (budget, tombstone, duplicate),
      // nothing was launched and we record the refusal honestly.
      try {
        await this.admit({
          runId,
          taskId: request.taskId,
          childId: request.childId,
          assignmentDigest: request.prompt,
          reservedCost: request.reservedCost,
          allowedCapabilities: ['reader'],
        })
      } catch (error) {
        outcomes.push({
          taskId: request.taskId,
          childId: request.childId,
          accepted: false,
          reason: error instanceof Error ? error.message : String(error),
        })
        continue
      }

      await this.transition({ runId, taskId: request.taskId, to: 'launching' })

      // Step 4: launch outside the record lock. The port is the only thing that
      // knows how to start a child; this service never touches ctx.subagents.
      const port = this.launchPort
      if (port === undefined) {
        // No port installed: this is a configuration error, not a task failure.
        // Leave the task in `unknown` so a reconciliation must resolve it, rather
        // than pretending the task failed cleanly.
        await this.transition({
          runId,
          taskId: request.taskId,
          to: 'unknown',
          uncertainty: 'no launch port installed',
          releaseReservation: false,
        })
        outcomes.push({
          taskId: request.taskId,
          childId: request.childId,
          accepted: false,
          reason: 'no launch port installed',
        })
        continue
      }

      try {
        await port.launch(request, signal)
      } catch (error) {
        // The launch failed. We cannot tell whether the child was created, so
        // this is `unknown`, not a clean failure: retrying blindly here is how a
        // system double-launches (INV-D4).
        await this.transition({
          runId,
          taskId: request.taskId,
          to: 'unknown',
          uncertainty: `launch failed: ${error instanceof Error ? error.message : String(error)}`,
          releaseReservation: false,
        })
        outcomes.push({
          taskId: request.taskId,
          childId: request.childId,
          accepted: false,
          reason: 'launch_failed_unknown',
        })
        continue
      }

      // Step 5: the child's inbox accepted the prompt. This is ADMISSION, not
      // execution: we still do not know that the model is producing tokens.
      await this.transition({ runId, taskId: request.taskId, to: 'accepted' })
      outcomes.push({ taskId: request.taskId, childId: request.childId, accepted: true })
    }
    return outcomes
  }

  private async mutate(runId: string, fn: (record: RunRecord) => RunRecord): Promise<RunRecord> {
    this.assertOpen()
    return this.runs().update(runId, fn)
  }

  private requireRun(runId: string): RunRecord {
    const record = this.getRun(runId)
    if (record === undefined) throw new Error(`dailyWork: run "${runId}" does not exist`)
    return record
  }

  private assertOpen(): void {
    if (this.disposed) throw new Error('dailyWork: service is disposed')
    if (this.domain === undefined) throw new Error('dailyWork: domain is not open')
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    dailyWork: WorkService
  }
}
