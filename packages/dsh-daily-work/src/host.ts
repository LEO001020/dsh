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
import { createHash, randomUUID } from 'node:crypto'
import { z } from 'zod'
import {
  admissionReason,
  countRun,
  heldSlots,
  mayAdmit,
  targetRefusalReason,
  type Counts,
  type DeficitReason,
  type TaskLiveness,
} from './counting.ts'
import {
  ChildAdmissionGate,
  ChildCapacityError,
  mountChildAdmissionGuard,
  type CapacitySnapshot,
  type ChildRefusal,
} from './capacity.ts'
import { acquireHomeLock, type HeldHomeLock } from './homelock.ts'
import {
  installDailyWorkTargetSetting,
  MAX_TARGET_ACTIVE_CHILDREN,
  MIN_TARGET_ACTIVE_CHILDREN,
  type TargetSettingHandle,
} from './target-setting.ts'
import {
  formatAuthorizationRef,
  parseAuthorizationRef,
  type WorkAuthorizationEvidence,
} from './authorization.ts'
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
  type ReadyAssignment,
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
  /**
   * Capability classes this assignment may use, when the caller knows them.
   *
   * Optional and additive: a caller that does not name any gets the drain's
   * existing default (`['reader']`), so every pre-existing construction site
   * keeps its exact behaviour. A READY assignment carries its own list, which is
   * the only reason this field exists — dropping it would silently widen or
   * narrow a permission the submitter stated.
   */
  readonly allowedCapabilities?: readonly string[]
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
 * What one atomic admission reservation did.
 *
 * A refusal is a VALUE, not an exception, because a refusal is the expected
 * answer under contention: the caller asked whether a slot was available and the
 * answer is no. Throwing would make the common case look like a fault, and it
 * would put the decision outside the caller's control flow. INSIDE the storage
 * transform a throw is the right primitive (it makes the domain skip the write);
 * this type is how that throw reaches the caller as an ordinary answer.
 */
export interface AdmissionReservation {
  /** Whether the reservation committed. */
  readonly reserved: boolean
  /** Why not, when it did not. `'none'` when it did. */
  readonly reason: DeficitReason
  /** The task after the commit. Undefined when refused. */
  readonly task?: TaskRecord
  /**
   * The message a refusal carries, so `admit` can re-throw the EXACT wording its
   * callers already assert on without re-deriving the decision. Present only on a
   * refusal.
   */
  readonly refusalMessage?: string
  /**
   * The run's reservation generation AFTER this attempt, whether it committed or
   * not. A caller can use it to prove its own write landed, and to notice that a
   * competing admission advanced it.
   */
  readonly generation: number
  /**
   * The occupancy the transform COMPUTED inside the update, before this
   * admission. This is the number the decision was made against.
   *
   * It is reported separately from {@link heldReservations} because the two
   * answer different questions and the difference is the evidence: a caller
   * storming this method can read the sequence of values each attempt observed,
   * and a serialized implementation shows a DISTINCT value per winner (0, 1, 2)
   * where the racing version showed the same value for every attempt. That
   * sequence is the direct measurement that the transform saw its predecessors'
   * commits, which is what the atomicity claim rests on.
   */
  readonly observedOccupancy: number
  /**
   * The run's occupancy AFTER this attempt: `observedOccupancy + 1` when the
   * reservation committed, and `observedOccupancy` when it was refused. This is
   * the authoritative figure a reader should compare against the target, and it
   * is the same derivation `counts().heldReservations` reports.
   */
  readonly heldReservations: number
  readonly target: number
}

/**
 * A refusal raised INSIDE a storage transform, so the domain skips the write.
 *
 * The distinction this type carries is part of the fix: a refusal must abort the
 * `update` (so nothing is written) AND be distinguishable from a real storage
 * fault when it reaches the caller. A plain `Error` cannot do the second job
 * without string matching, and string matching is how a refusal and a fault get
 * confused in a report.
 */
class AdmissionRefused extends Error {
  readonly reason: DeficitReason
  readonly generation: number
  readonly held: number
  readonly target: number

  constructor(message: string, reason: DeficitReason, generation: number, held: number, target: number) {
    super(message)
    this.name = 'AdmissionRefused'
    this.reason = reason
    this.generation = generation
    this.held = held
    this.target = target
  }
}

/** One completion wake that failed, kept so a report can surface it. */
export interface CompletionFailure {
  readonly childId: string
  readonly stopReason: string
  readonly message: string
}

/**
 * A submission whose taskId already names DIFFERENT work (V5 §7.2).
 *
 * Its own type rather than a bare `Error` for the same reason
 * `AdmissionRefused` is: a caller must be able to tell "you contradicted
 * yourself" from "the store failed", and string matching is how those two get
 * confused in a report. The two digests are carried so the message can name
 * both without the caller having to re-read the record.
 */
export class ReadyConflictError extends Error {
  readonly taskId: string
  readonly existingDigest: string
  readonly submittedDigest: string

  constructor(taskId: string, existingDigest: string, submittedDigest: string) {
    super(
      `dailyWork: task "${taskId}" is already submitted as ready with a different assignment `
      + `(existing ${existingDigest}, submitted ${submittedDigest}); a changed assignment under the same `
      + 'taskId is an explicit conflict — submit it under a new taskId',
    )
    this.name = 'ReadyConflictError'
    this.taskId = taskId
    this.existingDigest = existingDigest
    this.submittedDigest = submittedDigest
  }
}

/**
 * Digest of a submitted assignment, over the prompt text.
 *
 * A named function rather than an inline call so the duplicate rule has ONE
 * preimage. If the digest were computed in two places and the two disagreed,
 * the idempotent arm would silently become a conflict arm — a retried submit
 * would start erroring, which is the worst possible failure for a retry path.
 *
 * `createHash` is already imported for child ids; this reuses it rather than
 * adding a second hashing idiom.
 */
function assignmentDigestOf(prompt: string): string {
  return `sha256:${createHash('sha256').update(prompt, 'utf8').digest('hex')}`
}

/** One caller's queued work, with its own signal and its own answer. */
interface DrainWorkItem {
  readonly requests: readonly LaunchRequest[]
  readonly signal: AbortSignal
  readonly resolve: (outcomes: LaunchOutcome[]) => void
  readonly reject: (error: unknown) => void
  /**
   * Whether this item's work comes from the run's DURABLE ready table rather
   * than from `requests` (V5 §7.3).
   *
   * A flag rather than a second leader: §7.3 requires ONE per-run leader "for
   * efficiency only", and two leader maps would be two leaders racing on the
   * same slots — the exact defect CAP-10 measured. So a ready-driven pass goes
   * through the same generation/dirty loop as a caller-driven one, and only the
   * SOURCE of the requests differs.
   */
  readonly fromReadyTable?: boolean
}

/**
 * A signal that never aborts, for a drain no caller is waiting on.
 *
 * `requestDrain` is a wake, not a request: no caller's cancellation can apply to
 * it. Passing a per-call `AbortController` whose signal is never aborted would
 * allocate an object per wake for the same meaning, and passing `undefined`
 * would force every read of `entry.signal` to handle a case that cannot happen.
 */
const NEVER_ABORTED: AbortSignal = new AbortController().signal

/**
 * The per-run drain leader's generation state (V3 §H3's dirty loop).
 *
 * `requestedGeneration` advances on every arrival; `handledGeneration` advances
 * after each completed pass. The leader runs while they differ, which is what
 * makes "one drain loop body per run at a time" true: an arrival during a pass
 * cannot start a sibling, it can only ask for another pass.
 */
interface DrainLeaderState {
  requestedGeneration: number
  handledGeneration: number
  runner: Promise<void> | undefined
  readonly pending: DrainWorkItem[]
}

/**
 * The reason a drain outcome carries for a refused reservation.
 *
 * The reservation already decided and stated its reason; this only translates it
 * into the vocabulary `LaunchOutcome.reason` has always used, so callers that
 * assert on `'budget_blocked'` / `'budget_overage_halt'` / `'none'` keep working.
 *
 * EACH REASON IS MAPPED EXPLICITLY. A `default:` branch would let a future
 * `DeficitReason` silently inherit a translation chosen for a different one,
 * which is the drift this whole change is about — so the switch is exhaustive and
 * TypeScript enforces it.
 */
function refusalReasonForOutcome(
  record: RunRecord,
  counts: Counts,
  reservation: AdmissionReservation,
  outstandingCost: number,
): string {
  switch (reservation.reason) {
    // A HEALTHY FULL WAVE. Held is exactly the target, so there is no deficit to
    // explain and the refusal is simply "the target is reached". This reading is
    // load-bearing and is asserted by `concurrency.test.ts` ("does not admit an
    // eleventh child while ten hold their slots"): `'none'` here means the run is
    // full, NOT that nothing was decided.
    case 'none':
      return 'none'
    // A VIOLATION, and its own reading. The old code could not express this: an
    // overshoot and a healthy full wave both read `'none'`, which is exactly the
    // invisibility CAP-10 recorded.
    case 'target_exceeded':
      return reservation.refusalMessage ?? 'target_exceeded'
    case 'budget_blocked':
    case 'budget_overage_halt':
      return reservation.reason
    // The host cap. `runDrain` pre-checks the gate and reports
    // `'host_capacity_reached'` itself, so this branch is reached when the cap was
    // crossed between that check and the reservation — the case the pre-check
    // cannot see. It reports the same vocabulary word either way, which is the
    // point: a caller must not have to know which of the two layers noticed.
    case 'host_capacity_reached':
      return 'host_capacity_reached'
    // The run is closed. `counts.deficitReason` can carry the more specific
    // 'budget_blocked' / 'budget_overage_halt' readings for a closed run, and
    // callers assert on those, so prefer it when it says something more specific.
    case 'run_not_open':
      return counts.deficitReason === 'none' ? 'run_not_open' : counts.deficitReason
    // The request-specific refusals: already admitted, a tombstone, a stale
    // revision. The MESSAGE is the informative part here — the record's own
    // wording is what `durability-records.test.ts` matches on ("already admitted
    // as prepared") — so it is carried out rather than flattened to one word.
    case 'slots_held_by_unconfirmed':
      return reservation.refusalMessage ?? admissionReason(record, counts, outstandingCost)
    case 'insufficient_ready_tasks':
      return 'insufficient_ready_tasks'
  }
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
   * One drain LEADER per run, with its generation counters (V3 §H3).
   *
   * Replaces the old `pendingDrain: Map<string, Promise<LaunchOutcome[]>>`, whose
   * coalescing was a one-shot `await` that let every waiter start its own pass.
   * See `drain` for the mechanism and for why correctness no longer depends on
   * this map at all.
   */
  private readonly drainLeaders = new Map<string, DrainLeaderState>()
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
  /**
   * Completion wakes that failed, in order.
   *
   * A completion listener is fire-and-forget (it must not block DSH's emit), so
   * its rejection has no caller to reach. See `recordCompletionFailure` for why
   * it lands here instead of being dropped or rethrown.
   */
  private readonly completionFailures: CompletionFailure[] = []

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

  // -------------------------------------------------------------------------
  // THE HUMAN-AUTHORIZATION DOMAIN API (V3 phase R4, defect F1 / G-SEAM-31)
  //
  // ONE domain operation per human intent, and every adapter is a thin caller.
  // `createRun` above is the RECORD-WRITE primitive; the four methods below are
  // the product's authorization surface. The distinction is load-bearing: a
  // `createRun` caller that is not one of these is a caller that fabricated an
  // authorization edge, which is exactly what G-SEAM-31 refuses to do.
  //
  // WHY THE RUN ID IS DERIVED RATHER THAN SUPPLIED. `/work start` retried after
  // a crash must OBSERVE the existing run, not mint a second one (V3 I2). A
  // caller-supplied id would let two different retries name two different runs
  // for the same authorization; a derived id makes the run's identity a FUNCTION
  // of the authorizing action, so a second call derives the SAME key.
  //
  // AND THE DERIVED ID IS ONLY HALF THE ANSWER — this was measured, not reasoned.
  // The first version of this API checked `findRunForSession` and then called
  // `createRun`, and its comment claimed the check could not race because the id
  // was derived. That was FALSE: `createRun` ends in `this.runs().put(runId,
  // record)`, and `put` is an unconditional insert-or-overwrite
  // (`storage-domain/src/domain.ts:307-313`). Two concurrent `/work start` calls
  // for one session BOTH reported `Run authorized`, and the second write left the
  // record carrying the SECOND command's id. Driving the two writes directly
  // measured the destructive half: a run holding one admitted task came back with
  // ZERO tasks after a second create at the same key. A derived id therefore makes
  // the collision CERTAIN rather than harmless; what makes it safe is the atomic
  // insert below, which is why both are needed together.
  // -------------------------------------------------------------------------

  /**
   * Serialize one authorization per root session, in process, across awaits.
   *
   * WHY THIS IS NEEDED, AND WHY IT IS NOT A COMMENT ABOUT THE DERIVED ID.
   * The first version of `authorizeRun` checked `findRunForSession` and then
   * called `createRun`, and its comment claimed the check could not race because
   * the run id was derived from the session. That claim was FALSE and was
   * measured false: `createRun` ends in `this.runs().put(runId, record)`, and
   * `put` is an unconditional insert-or-overwrite
   * (`storage-domain/src/domain.ts:307-313`). Two concurrent `/work start` calls
   * for one session both reported `Run authorized`, and the record afterwards
   * carried the SECOND command's id. Driving the two writes at one key directly
   * measured the destructive half: a run holding one admitted task came back with
   * ZERO tasks. A derived id makes the collision CERTAIN; it does not make it
   * harmless.
   *
   * WHY AN IN-PROCESS CHAIN RATHER THAN A DOMAIN PRIMITIVE, stated precisely
   * because it bounds the guarantee. The public `Domain`/`KvTable` surface has no
   * "insert only if absent": `put` always overwrites, `update` is atomic but
   * REJECTS on a missing key, and `Domain` exposes no `enqueue`. So there is no
   * domain primitive that can reserve a key this call is about to create. What the
   * domain DOES provide is one serialized write chain per domain, and this chain
   * reproduces that discipline one level up, at the granularity that matters:
   * one root session.
   *
   * WHAT IT GUARANTEES: two `authorizeRun` calls for the SAME session, in this
   * host process, cannot interleave — the second runs its existence check only
   * after the first has finished writing. That covers the real hazard, because
   * `WorkService` is mounted ONCE per host (`cordis.patch.yml`: "Mounted ONCE, at
   * host level, because the run record is a host-scoped resource") and the
   * deployment additionally refuses a second host over one store through the
   * kernel-held home lock (`homelock.ts`, gate D-02).
   *
   * WHAT IT DOES NOT GUARANTEE, so a reader does not over-read it: two SEPARATE
   * HOST PROCESSES sharing one store would still be unserialized here. That
   * configuration is already refused by the home lock rather than by this chain,
   * and it is recorded as unsupported rather than silently tolerated.
   */
  private readonly pendingAuthorization = new Map<string, Promise<unknown>>()

  /**
   * Run `body` with no other authorization for `sessionId` interleaving.
   *
   * The map entry is a promise the caller AWAITS rather than a lock it acquires,
   * so a failed predecessor cannot deadlock a successor: the chain link is
   * settled in a `finally`, and the successor awaits it with its rejection
   * contained.
   */
  private async serializeAuthorization<T>(sessionId: string, body: () => Promise<T>): Promise<T> {
    const inFlight = this.pendingAuthorization.get(sessionId)
    if (inFlight !== undefined) {
      // Contained: the predecessor's failure is ITS caller's to report. A
      // successor must still get its turn, or one failed start would wedge the
      // session's authorization path permanently.
      await inFlight.catch(() => undefined)
    }
    const task = body()
    this.pendingAuthorization.set(sessionId, task)
    try {
      return await task
    } finally {
      if (this.pendingAuthorization.get(sessionId) === task) {
        this.pendingAuthorization.delete(sessionId)
      }
    }
  }

  /**
   * Derive the run id for one authorizing action on one root session.
   *
   * Deterministic in (rootSessionId, action, generation): the same human action
   * replayed after a crash names the same run. NOT deterministic in the
   * commandId, and that is the point — a retry is a NEW command with a NEW id,
   * and it must still land on the run the first attempt created.
   *
   * THE GENERATION EXISTS SO THIS NEVER OVERWRITES A DURABLE RECORD. `runs().put`
   * replaces whatever is at the key, so a derived id that a CLOSED run already
   * occupies would destroy that run's audit trail on the next `/work start`. The
   * generation counts the runs this session has already discharged, so a new
   * authorization after a close lands on a fresh key. (Nothing writes `closed`
   * today — `grep` for it finds no writer — so the count is currently always 0.
   * It is written anyway because the failure it prevents is a silent loss of a
   * record, and that is not a failure to leave to a later reader's memory.)
   */
  private deriveRunId(rootSessionId: string, action: string): string {
    let generation = 0
    for (const runId of this.listRunIds()) {
      const record = this.getRun(runId)
      if (record?.rootSessionId === rootSessionId && record.phase === 'closed') generation += 1
    }
    const base = `run-${action}-${rootSessionId}`
    return generation === 0 ? base : `${base}-g${String(generation + 1)}`
  }

  /**
   * The run a root session already owns, if any.
   *
   * Read from the service, which is the authority on which runs exist. A run in
   * a terminal phase is NOT returned: `closed` means the user's authorization
   * has been discharged, so a later `start` is a new authorization rather than a
   * duplicate of an old one.
   */
  findRunForSession(rootSessionId: string): RunRecord | undefined {
    this.assertOpen()
    for (const runId of this.listRunIds()) {
      const record = this.getRun(runId)
      if (record === undefined) continue
      if (record.rootSessionId !== rootSessionId) continue
      if (record.phase === 'closed') continue
      return record
    }
    return undefined
  }

  /**
   * Authorize a run for one exact live root Agent — the ONE product entry point.
   *
   * Idempotent in the sense V3 I2 requires: if the root already has a run that is
   * not `closed`, this OBSERVES it and returns it with `created: false` rather
   * than creating a duplicate. A retry after a crash between the record write and
   * `command/done` therefore lands on the existing run, which is the behaviour the
   * requirement names.
   *
   * WHERE THE IDEMPOTENCE IS ENFORCED, stated exactly because an earlier version
   * of this comment claimed a property the code did not have. It is enforced by
   * the existence check BELOW, and that check is made safe by running the whole
   * check-then-create sequence under `serializeAuthorization`, so a second
   * concurrent call for the same session cannot enter the check until the first has
   * written. It is NOT enforced by the derived run id: the derived id only makes
   * two racing calls name the SAME key, which turns a silent duplicate into a
   * certain overwrite rather than preventing either. The two are needed together —
   * the id makes the collision detectable and the serializer makes it impossible.
   *
   * WHAT REMAINS TRUE WITHOUT THE SERIALIZER, so the guarantee is not overstated:
   * a SEQUENTIAL retry (the crash case the requirement names) is already correct,
   * because it reads the run the first attempt wrote. The serializer closes the
   * CONCURRENT case, which is the one a check-then-act cannot close alone.
   *
   * AUTHORITY IS BOUND TO THE LIVE OBJECT, not to a session-id string, for the
   * reason `createRun`'s own doc gives: a resume publishes a NEW Agent under the
   * SAME id, and authority must follow the object (INV-L3). The caller supplies
   * the Agent it holds; `createRun` records that object's session identity and
   * binds the production launch port to it.
   *
   * @param input.root - the exact live root Agent this run belongs to.
   * @param input.evidence - what authorized it; stored as the durable ref.
   * @param input.targetChildren - the target N. Bounded to [1, 30] because this
   *   is the AUTHORIZATION edge, and a target above the deployment's hard child
   *   capacity would be a promise the gate cannot keep. `createRun`'s own
   *   unbounded path is unchanged for callers that are not this edge.
   * @returns the run record plus whether this call created it.
   */
  async authorizeRun(input: {
    root: Agent
    evidence: WorkAuthorizationEvidence
    targetChildren?: number
    restartResumeAuthorized?: boolean
    now?: string
  }): Promise<{ readonly record: RunRecord; readonly created: boolean }> {
    this.assertOpen()
    const rootSessionId = input.root.session.header.id

    // Validate BEFORE taking the serializer: a malformed request must not occupy
    // the session's authorization slot while it throws.
    const target = input.targetChildren
    if (target !== undefined) {
      if (!Number.isSafeInteger(target)
        || target < MIN_TARGET_ACTIVE_CHILDREN
        || target > MAX_TARGET_ACTIVE_CHILDREN) {
        throw new Error(
          `dailyWork: an authorized target must be a whole number in `
          + `[${MIN_TARGET_ACTIVE_CHILDREN}, ${MAX_TARGET_ACTIVE_CHILDREN}]; got ${String(target)}. `
          + `${MAX_TARGET_ACTIVE_CHILDREN} is the deployment's hard child capacity, so a larger target `
          + 'is a refusal rather than a bigger budget.',
        )
      }
    }

    // THE CHECK-AND-CREATE RUNS UNDER THE SERIALIZER, and that placement IS the
    // fix rather than a detail of it. With the check outside, two concurrent
    // calls both observe no run, both proceed, and the second `put` overwrites the
    // first — measured: both reported `Run authorized`, and a run holding one
    // admitted task came back with zero tasks.
    return await this.serializeAuthorization(rootSessionId, async () => {
      const existing = this.findRunForSession(rootSessionId)
      if (existing !== undefined) return { record: existing, created: false }

      const record = await this.createRun({
        runId: this.deriveRunId(rootSessionId, input.evidence.action),
        root: input.root,
        authorizationRef: formatAuthorizationRef(input.evidence),
        ...target === undefined ? {} : { targetChildren: target },
        ...input.restartResumeAuthorized === undefined
          ? {} : { restartResumeAuthorized: input.restartResumeAuthorized },
        ...input.now === undefined ? {} : { now: input.now },
      })
      return { record, created: true }
    })
  }

  /**
   * Change one run's sustained target — the domain operation behind `/work target`.
   *
   * Delegates to `setTargetChildren`, which already owns the semantics the plan
   * prohibits changing (no cancellation, no re-budgeting of running tasks, no
   * touching the ceiling). This wrapper exists only so the command adapter has
   * ONE named domain call rather than reaching into a record-level method whose
   * contract is broader than the adapter needs.
   */
  async authorizeSetTarget(runId: string, target: number): Promise<RunRecord> {
    if (!Number.isSafeInteger(target)
      || target < MIN_TARGET_ACTIVE_CHILDREN
      || target > MAX_TARGET_ACTIVE_CHILDREN) {
      throw new Error(
        `dailyWork: a target must be a whole number in `
        + `[${MIN_TARGET_ACTIVE_CHILDREN}, ${MAX_TARGET_ACTIVE_CHILDREN}]; got ${String(target)}`,
      )
    }
    return await this.setTargetChildren(runId, target)
  }

  /**
   * The domain operation behind `/work stop`.
   *
   * WHAT IT DOES. Moves the run to `paused` (a user stop outranks top-up,
   * INV-G4) and records the reason on the outbox so a reader sees WHY. It does
   * NOT drain, and it deliberately does NOT release any child slot.
   *
   * WHY STOP MUST NOT FREE CAPACITY. A stop stops NEW admissions; the children
   * already running still hold real slots in the host ledger, because they are
   * still running and still spending. Releasing their slots here would let a
   * subsequent run admit replacements on top of live children, which would
   * exceed the hard capacity of 30 — the over-admission class this project
   * records as G-SEAM-45. Slots are released by the children SETTLING (the
   * `agent/disposed` listener in `capacity.ts`), never by a stop.
   */
  async authorizeStop(runId: string, reason: string, now?: string): Promise<RunRecord> {
    return await this.pause(runId, reason, now)
  }

  /**
   * The domain operation behind `/work status`: a pure read, no mutation.
   *
   * Returns the record-derived counts plus the authorization evidence, so a
   * status surface can show WHAT authorized the run without a second call and
   * without re-deriving the ref's meaning in a UI.
   */
  authorizeReadStatus(runId: string): {
    readonly record: RunRecord
    readonly counts: Counts
    readonly evidence: WorkAuthorizationEvidence | undefined
  } {
    const record = this.requireRun(runId)
    return {
      record,
      counts: this.counts(runId),
      evidence: parseAuthorizationRef(record.authorizationRef),
    }
  }

  /** Read a run. Returns the stored object; callers must treat it as immutable. */
  getRun(runId: string): RunRecord | undefined {
    this.assertOpen()
    return this.runs().get(runId)
  }

  /** The current counts for a run, computed from stored state plus observed liveness. */
  counts(runId: string): Counts {
    const record = this.requireRun(runId)
    return countRun(record, this.liveness.get(runId) ?? new Map(), this.readyTaskCountFor(record))
  }

  /**
   * How many assignments this run has ready, as a reader should see it.
   *
   * THE DURABLE TABLE IS THE AUTHORITY NOW, and this is the connection that was
   * missing before this slice: `readyTasks` was fed only by `setReadyTasks`, a
   * process-local setter whose only callers were tests, so the deficit reader's
   * `insufficient_ready_tasks` arm (`counting.ts:287`) could not be produced by
   * anything durable. A run with 60 pending assignments and a target of 30
   * reported a deficit whose reason did not know those assignments existed.
   *
   * WHY THE FOLD IS A MAXIMUM rather than a replacement. `setReadyTasks` still
   * serves a caller with a view this package does not hold — and the pre-existing
   * arms that set it assert on the deficit reasons it produces. Folding by
   * maximum keeps those readings and adds the durable one, which is the safe
   * direction for a number whose only use is to EXPLAIN a deficit: over-reporting
   * ready work can never hide a shortage, whereas under-reporting would report
   * `insufficient_ready_tasks` for work that is durably waiting.
   */
  private readyTaskCountFor(record: RunRecord): number {
    const observed = this.readyTaskCount.get(record.runId) ?? 0
    const durable = Object.keys(record.readyAssignments ?? {}).length
    return Math.max(observed, durable)
  }

  /** Record how many ready tasks the root currently has. Mechanical, no model call. */
  setReadyTasks(runId: string, ready: number): void {
    this.readyTaskCount.set(runId, ready)
  }

  /**
   * The run and task a reserved child id belongs to, if any.
   *
   * WHY THIS EXISTS, and why it is a scan. DSH's `subagent/end` names a child by
   * its SessionId (`dsh-subagent/src/types.ts:104`), and this package reserved
   * that exact id before launching (`launch-port.ts:78`, asserted at `:92-97`),
   * so the mapping is exact rather than heuristic. But the record stores tasks
   * keyed by taskId, so the lookup is over the runs this host holds.
   *
   * The scan is bounded by `listRunIds()` — a host holds few runs — and it is a
   * READ, so a linear search costs nothing a map would save. The alternative, an
   * in-memory childId index, would be a second copy of durable state that a
   * restart would have to rebuild, and this project has already recorded what a
   * process-local side table costs when it disagrees with the record (`G-SEAM-45`
   * / CAP-10).
   *
   * @returns undefined for a child this package does not own. That is a normal
   *   answer, not an error: DSH can create children outside WorkService
   *   admission.
   */
  findTaskByChildId(childId: string): { readonly runId: string; readonly taskId: string } | undefined {
    if (this.disposed || this.domain === undefined) return undefined
    for (const runId of this.listRunIds()) {
      const record = this.runs().get(runId)
      if (record === undefined) continue
      for (const task of Object.values(record.tasks)) {
        if (task.childId === childId) return { runId, taskId: task.taskId }
      }
      // A task that is still READY has a reserved childId but no task row yet.
      // It is deliberately NOT returned: the completion event names a child that
      // was STARTED, and a ready assignment has not been. Returning it would let
      // a completion for some other child reconcile an assignment that never ran.
    }
    return undefined
  }

  /**
   * Record that a completion wake failed, so the failure is visible rather than
   * swallowed.
   *
   * The listener is fire-and-forget (it must not block the registry's emit), so
   * its rejection has nowhere to go. Dropping it would violate the project's rule
   * that a failure is reported rather than hidden, and letting it propagate would
   * terminate the process under Node's default unhandled-rejection policy. So it
   * lands in the same bounded refusal log the capacity guard uses, with its own
   * wording so a reader can tell a completion failure from a capacity refusal.
   *
   * Bounded for the same reason: a failing wake storm must not grow without
   * limit. The count of dropped entries is not kept, because the log's purpose is
   * diagnosis and the first 64 are the informative ones.
   */
  recordCompletionFailure(failure: {
    readonly childId: string
    readonly stopReason: string
    readonly message: string
  }): void {
    if (this.completionFailures.length >= 64) this.completionFailures.shift()
    this.completionFailures.push(failure)
  }

  /** The completion failures this process recorded, oldest first. */
  completionFailureLog(): readonly CompletionFailure[] {
    return [...this.completionFailures]
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
   * Durably record that the model decided on this work, whether or not a slot
   * exists for it right now (V5 §7.2 / WORK-READY).
   *
   * WHY THIS REPLACES AN IMMEDIATE `drain` AT THE SUBMIT EDGE. `work submit`
   * used to call `drain(runId, [one request])` and nothing else. A refusal is a
   * VALUE and writes nothing — deliberately, so a refusal storm is free — but
   * the consequence at THIS edge was that the semantic assignment the model had
   * already decided existed only in the tool-call argument and was **lost** when
   * the run was full. The root then had to re-derive it after every completion,
   * which converts a mechanical target into model polling. That is the defect
   * V5 §7 names, and this method is the durable half of the fix.
   *
   * WHAT THIS DOES NOT DO: it does not admit, does not take a slot, does not
   * commit credit and does not launch. `requestDrain` is a separate call, and
   * admission still happens only inside `tryReserveAdmission`. Keeping the two
   * apart is what lets a submission succeed while the target is full, which is
   * the whole point.
   *
   * THE DUPLICATE RULE (V5 §7.2), and why each half is the shape it is:
   *
   *   - IDENTICAL assignment under a taskId already ready -> **idempotent**. The
   *     stored record stands and the transform returns the record UNCHANGED, so
   *     the domain performs no write at all. That is stronger than writing an
   *     identical value: a retried tool call (the model re-sending after a
   *     transport failure) leaves no trace to reconcile and does not re-order
   *     the assignment behind newer work.
   *   - CHANGED assignment under the same taskId -> **explicit conflict**, an
   *     error naming both digests. Silently replacing would let a second
   *     submission redefine work the root may already be relying on, and
   *     silently keeping the old one would report success for a goal the caller
   *     did not get. Neither is honest, so it is refused and the caller chooses
   *     a new taskId.
   *
   * A taskId that is already ADMITTED is a different fact (the work is running,
   * not pending) and `tryReserveAdmission` already refuses a re-admission with
   * its own wording, so this method does not duplicate that decision. It refuses
   * only against a READY record.
   *
   * @returns the stored assignment and whether this call created it.
   * @throws when the assignment conflicts with an existing READY record.
   */
  async submitReady(input: {
    runId: string
    taskId: string
    prompt: string
    reservedCost: number
    allowedCapabilities?: readonly string[]
    childId?: string
    sourceCallId?: string
    now?: string
  }): Promise<{ readonly assignment: ReadyAssignment; readonly created: boolean }> {
    this.assertOpen()
    if (input.taskId.length === 0) throw new Error('dailyWork: submitReady requires a taskId')
    if (input.prompt.length === 0) throw new Error('dailyWork: submitReady requires a non-empty prompt')
    if (!Number.isFinite(input.reservedCost) || input.reservedCost < 0) {
      throw new Error(
        `dailyWork: reservedCost ${String(input.reservedCost)} must be a non-negative finite number`,
      )
    }
    const now = input.now ?? new Date().toISOString()
    const digest = assignmentDigestOf(input.prompt)
    // The child id is reserved HERE, at submission, not at launch. That is the
    // half of the record that makes a crash between submission and admission
    // recoverable: the record names the exact child a later admission must
    // create, so reconciliation is keyed on a persisted identity instead of one
    // invented after the fact. `childId` may be supplied so a caller that has
    // already minted one (a re-submission after a restart) keeps it.
    const childId = input.childId ?? `child-${input.taskId}`
    let created = false
    const updated = await this.runs().update(input.runId, record => {
      const existing = record.readyAssignments?.[input.taskId]
      if (existing !== undefined) {
        if (existing.assignmentDigest === digest && existing.prompt === input.prompt) return record
        throw new ReadyConflictError(input.taskId, existing.assignmentDigest, digest)
      }
      // The sequence is `max(existing) + 1` rather than `count + 1`, so a
      // submission after an admitted one still sorts after it. `count + 1` would
      // reuse a sequence number and make "oldest ready" ambiguous, which is a
      // starvation risk under sustained load rather than a cosmetic problem.
      const sequences = Object.values(record.readyAssignments ?? {}).map(a => a.sequence)
      const sequence = sequences.length === 0 ? 1 : Math.max(...sequences) + 1
      const assignment: ReadyAssignment = {
        taskId: input.taskId,
        childId,
        prompt: input.prompt,
        assignmentDigest: digest,
        reservedCost: input.reservedCost,
        allowedCapabilities: [...input.allowedCapabilities ?? ['reader']],
        sequence,
        createdAt: now,
        updatedAt: now,
        ...input.sourceCallId === undefined ? {} : { sourceCallId: input.sourceCallId },
      }
      created = true
      return {
        ...record,
        readyAssignments: { ...record.readyAssignments, [input.taskId]: assignment },
        updatedAt: now,
      }
    })
    const assignment = updated.readyAssignments?.[input.taskId]
    if (assignment === undefined) {
      throw new Error(`dailyWork: the ready assignment for "${input.taskId}" did not persist`)
    }
    return { assignment, created }
  }

  /**
   * The READY assignments of a run, OLDEST FIRST by durable submission sequence.
   *
   * The order is the record's own `sequence`, not insertion order of the stored
   * object and not `createdAt`: two submissions inside one millisecond would be
   * unordered by a clock, and an unordered drain starves an assignment under
   * sustained load. An absent table means none, which is what a record written
   * before this table existed means.
   */
  readyAssignments(runId: string): readonly ReadyAssignment[] {
    const record = this.requireRun(runId)
    return Object.values(record.readyAssignments ?? {}).sort((a, b) => a.sequence - b.sequence)
  }

  /**
   * Drop one READY assignment, because it was admitted or because its intent is
   * withdrawn.
   *
   * SEPARATE FROM THE ADMISSION, AND THAT IS A STATED COST. The ideal is one
   * atomic update that admits the task and retires the intent together. That is
   * not what this is, and the window it leaves is named rather than glossed: if
   * the process dies between the admission committing and this call, the record
   * holds BOTH an admitted task and its READY row. The recovery rule for that
   * state is written at the call site in `runDrainPass` — the READY row is
   * dropped when its taskId is already admitted, because an admitted task is
   * stronger evidence than a pending intent. The direction is chosen so the
   * failure is a redundant row, never a lost assignment.
   *
   * @returns whether a record was removed.
   */
  async clearReadyAssignment(runId: string, taskId: string, now?: string): Promise<boolean> {
    this.assertOpen()
    let removed = false
    await this.runs().update(runId, record => {
      if (record.readyAssignments?.[taskId] === undefined) return record
      removed = true
      const next = { ...record.readyAssignments }
      delete next[taskId]
      return { ...record, readyAssignments: next, updatedAt: now ?? new Date().toISOString() }
    })
    return removed
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
    const reservation = await this.tryReserveAdmission(input)
    if (!reservation.reserved) {
      // The refusals that `admit`'s callers already assert on are re-stated here
      // with the wording they use. The DECISION was made inside the update; only
      // the reporting happens out here.
      throw new Error(reservation.refusalMessage)
    }
    if (reservation.task === undefined) {
      throw new Error(`dailyWork: admission of "${input.taskId}" did not persist`)
    }
    return reservation.task
  }

  /**
   * THE AUTHORITATIVE TARGET ADMISSION. Reserve one target slot and one credit
   * reservation, or refuse, in ONE storage-domain update.
   *
   * WHY THIS METHOD EXISTS — the defect it closes (CAP-10 / G-SEAM-45).
   *
   * `drain` used to decide admission from a record it had read BEFORE the write,
   * and then write. That is check-then-act: K concurrent drains all read the same
   * `capacityDeficit`, all conclude there is room, and all admit. Measured with
   * zero real children: target 3, two slots free, three concurrent drains ->
   * three admitted, FOUR tasks holding slots, and `capacityDeficit` reading 0, so
   * the overshoot was invisible to the very reader that exists to report it.
   *
   * The budget check did not have this hole, and the contrast is the whole
   * finding: the budget check lives INSIDE the single record `update`, so the
   * domain's write chain serializes it and CAP-09 passes; the target check lived
   * OUTSIDE it, so it is not, and CAP-10 fails. The fix is therefore not a better
   * coalescer. It is to move the target check to where the budget check already
   * is — inside one `update` — so both are protected by the same mechanism.
   *
   * WHY THE DECISION MUST BE INSIDE THE TRANSFORM, NOT BEFORE IT. The domain's
   * contract is exact (`storage-domain/src/domain.ts:83-89`): "Atomic
   * read-modify-write on the domain's write chain: `fn` sees the value current at
   * its queue slot, so concurrent updates never interleave." A transform that
   * computes occupancy from the `current` it is handed is therefore serialized
   * against every other write to this run, including a competing admission's.
   * Reading `getRun()` outside and passing the answer in would reintroduce
   * exactly the race being fixed, because that read is not on the chain.
   *
   * Steps, in the order V3 §H1 requires them, all inside one transform:
   *   1. validate run identity, revision and active state
   *   2. validate the task is ready and not already reserved/admitted
   *   3. compute target occupancy from the authoritative stored states
   *   4. refuse if occupancy >= target
   *   5. verify outstanding reservations + spent + this request fit policy
   *   6. reserve one target slot   (the task record itself, in `prepared`)
   *   7. reserve the credit        (`budget.reserved += reservedCost`)
   *   8. transition the task to reserved/starting  (`prepared`)
   *   9. record a durable launch intention (the `admit-<taskId>` outbox entry)
   *  10. commit
   *
   * The physical launch happens only AFTER this returns `reserved: true`; see
   * `runDrain`, which launches on the committed path alone.
   *
   * A REFUSAL WRITES NOTHING. The transform throws the internal refusal before
   * returning, so the domain performs no `put` at all: a refused attempt consumes
   * no slot, no credit and no generation. That is stronger than writing an
   * unchanged record, and it is what makes a refusal storm free.
   *
   * NOT THROWING FOR A FULL TARGET IS THE POINT. "The target is full" is the
   * expected answer under contention, not a fault. It is returned as a value so
   * the caller's control flow stays its own.
   *
   * @returns whether the reservation committed, plus the authoritative occupancy
   *   it was decided against. Throws only for a malformed request or a storage
   *   failure.
   */
  async tryReserveAdmission(input: {
    runId: string
    taskId: string
    childId: string
    assignmentDigest: string
    reservedCost: number
    allowedCapabilities: readonly string[]
    /**
     * The reservation generation the caller believes is current, when it has one.
     * A mismatch is refused rather than written: a decision made against a
     * generation this run has moved past must not commit on stale reasoning.
     */
    expectedRunRevision?: number
    now?: string
  }): Promise<AdmissionReservation> {
    this.assertOpen()
    if (!Number.isFinite(input.reservedCost) || input.reservedCost < 0) {
      throw new Error(
        `dailyWork: reservedCost ${String(input.reservedCost)} must be a non-negative finite number`,
      )
    }
    const now = input.now ?? new Date().toISOString()
    // ---- THE HOST-WIDE SLOT IS TAKEN INSIDE THE UPDATE, AND WHY THAT MOVED ----
    //
    // The plan's rule is "pre-publication 同步 reserve；失败清理后 release；不能
    // '先启动再计数'": the slot must be held before the child can materialize. It
    // does NOT require the slot to be held before the RECORD write, because the
    // record write is durable state and not publication — the child materializes
    // in `port.launch`, which `runDrainPass` calls only after this method returns
    // `reserved: true`.
    //
    // The take used to happen HERE, before the `update`, with a release on every
    // non-committing path. That is correct for capacity but it is VISIBLE: the
    // gate's `highWater` records the peak occupancy, so a refused attempt
    // momentarily pushed it to `target + 1`. `runDrainPass` compensated with a
    // read-only pre-check that refused before the take — and that compensation is
    // where CAP-10's MISS was measured. See `runDrainPass` for the numbers.
    //
    // Taking the slot inside the transform removes the tension instead of
    // trading one direction for the other:
    //
    //   - a REFUSAL now happens before the take, so a refused attempt cannot move
    //     `highWater` at all, and the pre-check that caused the miss is gone;
    //   - the take is now serialized by the SAME per-domain write chain as the
    //     occupancy decision, which is strictly stronger than taking it outside;
    //   - the host cap is still enforced, inside the chain, and reported as the
    //     same typed `host_capacity_reached` refusal.
    //
    // THE SIDE EFFECT IS ACKNOWLEDGED, not glossed. The domain's contract says
    // `fn` is a "synchronous pure transform". Mutating this process's slot ledger
    // is a side effect on state OUTSIDE the record, and it is safe here for three
    // reasons that must all hold: (1) it is synchronous, so it cannot interleave
    // with the checks above it; (2) it happens LAST, after every refusal, so no
    // refusal can leave a slot taken; (3) `reserveTask` is idempotent per task id,
    // so even a hypothetical re-run of the transform would not double-take. What
    // it does NOT have is rollback: if `putRecord` then fails, the caller releases
    // the slot in its catch, and `tookSlot` below is what makes that exact.
    //
    // ---- THE HOST CAP IS REPORTED AS A TYPED REFUSAL, NOT THROWN ------------
    //
    // `reserveTask` calls `ChildAdmissionGate.assertRoom`, which THROWS
    // `ChildCapacityError('HOST_CAPACITY_REACHED')` when the ledger is at the cap
    // (`capacity.ts:434`, `:502-505`). Left unwrapped, that throw would escape a
    // method whose return type says it answers with a refusal — so a caller
    // written against `AdmissionReservation` would get an exception instead of
    // `{ reserved: false, reason: 'host_capacity_reached' }`. It is therefore
    // translated into the same typed refusal the rest of this transform uses.
    //
    // `assertRoom` throws BEFORE `tasks.set`, so an at-cap attempt takes no slot;
    // `tookSlot` stays false and the catch releases nothing.
    let tookSlot = false
    // Set by the transform on its COMMIT path only, so the outcome the caller
    // receives is the one the transform actually decided rather than a value
    // re-derived outside the update (which would be a second opinion).
    let committed: { task: TaskRecord; held: number; target: number; generation: number } | undefined
    let updated: RunRecord
    try {
      updated = await this.runs().update(input.runId, record => {
        // ---- 1. run identity, revision and active state ----------------------
        const generation = record.reservationGeneration ?? 0
        const target = record.requestedTarget
        const held = heldSlots(record)
        if (record.phase !== 'open') {
          throw new AdmissionRefused(
            `dailyWork: run "${input.runId}" is ${record.phase}; refusing admission`,
            'run_not_open',
            generation,
            held,
            target,
          )
        }
        if (input.expectedRunRevision !== undefined && input.expectedRunRevision !== generation) {
          throw new AdmissionRefused(
            `dailyWork: run "${input.runId}" is at reservation generation ${generation} but the caller decided `
            + `from ${input.expectedRunRevision}; refusing to commit an admission on a stale revision`,
            'slots_held_by_unconfirmed',
            generation,
            held,
            target,
          )
        }
        if (isHalted(record.budget)) {
          throw new AdmissionRefused(
            `dailyWork: run "${input.runId}" is halted on a recorded budget overage (${record.budget.halt?.reason}); `
            + 'refusing admission until a human resolves it',
            'budget_overage_halt',
            generation,
            held,
            target,
          )
        }

        // ---- 2. the task is ready and not already reserved/admitted ----------
        const existing = record.tasks[input.taskId]
        if (existing !== undefined && holdsSlot(existing.state)) {
          throw new AdmissionRefused(
            `dailyWork: task "${input.taskId}" is already admitted as ${existing.state}`,
            'slots_held_by_unconfirmed',
            generation,
            held,
            target,
          )
        }
        if (record.terminalTombstones.includes(input.taskId)) {
          throw new AdmissionRefused(
            `dailyWork: task "${input.taskId}" is a closed tombstone and cannot be reopened`,
            'slots_held_by_unconfirmed',
            generation,
            held,
            target,
          )
        }

        // ---- 3. AUTHORITATIVE occupancy, from the stored states --------------
        //
        // `held` was computed above by `heldSlots(record)`, the SAME function
        // `countRun` uses, over the same `holdsSlot` predicate the state machine
        // uses. Not `capacityDeficit` (which clamps at zero and therefore cannot
        // express an overshoot), and not a side counter (which can lag the
        // authoritative states). This is the single derivation.

        // ---- 4. the credit must fit policy -----------------------------------
        //
        // CHECKED BEFORE THE TARGET, and the order is load-bearing rather than
        // arbitrary. It is the order the previous implementation had (`admit`
        // checked phase, halt, budget; `mayAdmit` checked budget before slots) and
        // the tests pin it: `capacity.test.ts` "the ROOT keeps its own inference
        // budget" asserts a greedy request of 9501 at a FULL target is refused
        // with `/no budget headroom/`, because the informative reason is that the
        // credit does not fit, not that the run happens to be full. Reporting the
        // target there would hide the budget fact behind a slot fact that is
        // equally true and less useful.
        const budget = record.budget
        const alreadyCommitted = childCommitted(budget)
        const limit = childCeiling(budget)
        if (alreadyCommitted + input.reservedCost > limit) {
          throw new AdmissionRefused(
            `dailyWork: run "${input.runId}" has no budget headroom (committed ${alreadyCommitted}, child ceiling ${limit}, `
            + `root reserve ${budget.rootReserve ?? 0} of ceiling ${budget.ceiling})`,
            'budget_blocked',
            generation,
            held,
            target,
          )
        }

        // ---- 5. refuse if occupancy >= target --------------------------------
        //
        // THE FIX, in one comparison. It is inside the transform, so it runs at
        // this update's queue slot and K concurrent callers cannot all pass it:
        // each sees the record as the previous one committed it.
        if (held >= target) {
          throw new AdmissionRefused(
            `dailyWork: run "${input.runId}" already holds ${held} of its target ${target} slots; `
            + 'refusing admission rather than exceeding the target',
            // A run exactly at target is a healthy full wave and keeps the
            // `'none'` reading its callers already assert. A run ABOVE target is a
            // violation and says so, which is the number the old code could not
            // express.
            held > target ? 'target_exceeded' : 'none',
            generation,
            held,
            target,
          )
        }

        // ---- 6. take the HOST-WIDE slot --------------------------------------
        //
        // PLACED AFTER EVERY REFUSAL, and that placement is the whole point. The
        // take used to happen before the `update`, so a refused attempt had
        // already moved the ledger's `highWater` to `target + 1`; `runDrainPass`
        // then had to pre-check to avoid that, and the pre-check is where the
        // CAP-10 miss was measured. Taking it here means a refusal cannot move
        // `highWater` at all, so no pre-check is needed and the miss is gone.
        //
        // The cap is checked by `assertRoom` inside `reserveTask`, which throws
        // `ChildCapacityError('HOST_CAPACITY_REACHED')` BEFORE `tasks.set`. It is
        // translated into the same typed refusal as every other refusal here, so
        // the caller receives `{ reserved: false, reason: 'host_capacity_reached' }`
        // rather than an exception from a method whose type promises an answer.
        //
        // SYNCHRONOUS AND IDEMPOTENT: no `await`, so this cannot interleave with
        // the checks above it.
        //
        // `tookSlot` IS EXACT, AND WHY IT NEEDS NO "did the ledger already track
        // this task id" TEST. `reserveTask` is idempotent per task id, so a
        // hypothetical re-reserve would return the existing entry and a release
        // would then give back a slot this call does not own. That case is
        // UNREACHABLE here, and the reachability argument is short: the gate's
        // only other writer for a task id is `syncSlotToState`, which runs after a
        // committed transition, so the gate and the record agree on which tasks
        // hold slots. A duplicate submission is therefore refused at STEP 2
        // ("already admitted as ..."), which is ABOVE this take — so `tookSlot` is
        // set only when this call's own transform is the one that put the entry
        // there. Verified by mutation: making `tookSlot` unconditional here is
        // caught by the duplicate arms, and an `alreadyTracked` refinement was
        // measured to change nothing, which is why it is not carried.
        try {
          this.gate.reserveTask(input.taskId, 'reserved', input.childId)
          tookSlot = true
        } catch (error) {
          if (error instanceof ChildCapacityError && error.code === 'HOST_CAPACITY_REACHED') {
            throw new AdmissionRefused(error.message, 'host_capacity_reached', generation, held, target)
          }
          throw error
        }

        // ---- 7/8/9. reserve the credit, the state, the outbox ----------------
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
        committed = { task, held, target, generation }
        // ---- 10. commit (the domain writes this value) -----------------------
        return {
          ...record,
          reservationGeneration: generation + 1,
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
      })
    } catch (error) {
      // The host-wide slot goes back on EVERY non-committing path where THIS CALL
      // TOOK ONE: a storage failure after the take, or a failure of the `putRecord`
      // that commits the transform's value. Leaving it held would leak capacity one
      // failed attempt at a time, which is the "失败清理后 release" half of the
      // plan's rule.
      //
      // `tookSlot` IS THE EXACT CONDITION, and it is not a refinement. Two distinct
      // paths must NOT release here:
      //
      //   1. A REFUSAL. Every refusal is thrown BEFORE the take, so `tookSlot` is
      //      false and there is nothing to give back. This is what makes a refusal
      //      storm free AND keeps `highWater` at the target — the property that let
      //      the read-only pre-check in `runDrainPass` be deleted.
      //   2. A DUPLICATE FOR A TASK THIS LEDGER ALREADY TRACKS. `reserveTask` is
      //      idempotent per task id: it updates the existing entry and returns a
      //      handle to it rather than taking a second slot. MEASURED before this
      //      guard existed: a duplicate `drain` for an already-admitted task was
      //      correctly refused (`accepted: false`) and then released the WINNER's
      //      slot, leaving the gate at `occupied 0` while the record still held one
      //      admitted task. The host then believed it had room for a child that
      //      already existed — the OVER-admission direction of INV-C1, reached by a
      //      duplicate notification rather than by a race.
      //
      // Because the take is inside the transform, `tookSlot` is set only when this
      // call's own transform ran to its take. A refusal that happens before it
      // leaves it false, and the duplicate case is refused before the take too
      // (step 2 of the transform), so neither can release a slot it does not own.
      if (tookSlot) this.gate.releaseTask(input.taskId)
      if (error instanceof AdmissionRefused) {
        return {
          reserved: false,
          reason: error.reason,
          refusalMessage: error.message,
          generation: error.generation,
          observedOccupancy: error.held,
          heldReservations: error.held,
          target: error.target,
        }
      }
      throw error
    }
    const record = committed
    if (record === undefined || updated.tasks[input.taskId] === undefined) {
      if (tookSlot) this.gate.releaseTask(input.taskId)
      throw new Error(`dailyWork: admission of "${input.taskId}" did not persist`)
    }
    return {
      reserved: true,
      reason: 'none',
      task: updated.tasks[input.taskId],
      generation: updated.reservationGeneration ?? 0,
      observedOccupancy: record.held,
      heldReservations: record.held + 1,
      target: record.target,
    }
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
      case 'completed':
        // `completed` releases the TASK slot for the same reason the other two
        // do: the child's activation is over, so the slot it held must be free
        // or the target can never be sustained. It does NOT release the
        // reservation — see the transition below, which retains it.
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
   * Run one coalesced drain for a run, through a single per-run leader.
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
   *
   * ---- LAYER 1, AND WHAT IT IS NOT ------------------------------------------
   *
   * The previous implementation coalesced like this (`host.ts`, before this
   * change):
   *
   *     const inFlight = this.pendingDrain.get(runId)
   *     if (inFlight !== undefined) await inFlight          // <-- awaits the OTHER drain
   *     const task = this.runDrain(runId, requests, signal) // <-- no re-check
   *     this.pendingDrain.set(runId, task)
   *
   * The comment on that `await` said "Absorb rather than stacking a second
   * concurrent drain that would race on the same slots", and the code did the
   * opposite: after awaiting, it started its OWN `runDrain` unconditionally. K
   * concurrent callers awaited the SAME in-flight drain, and when it settled they
   * all resumed in ONE microtask batch and each started its own pass. The `await`
   * was not the protection; it was the mechanism that synchronized them.
   *
   * The fix here is a generation/dirty loop: one leader per run runs passes while
   * `requestedGeneration > handledGeneration`, and an arrival during a pass only
   * advances `requestedGeneration` and joins the leader. There is no path by
   * which a second `runDrain` starts for the same run.
   *
   * ---- CORRECTNESS DOES NOT DEPEND ON THIS LAYER ----------------------------
   *
   * Stated plainly because it is the audit's point (V3 §H3): even if this
   * in-memory coalescer regresses — or is bypassed entirely by a caller that
   * invokes `runDrain` directly, or by a second host sharing the store — the
   * target cannot be over-admitted, because the decision now lives in
   * `tryReserveAdmission`'s single storage-domain update and is serialized by the
   * domain's write chain (`storage-domain/src/domain.ts:83-89`). This layer is an
   * EFFICIENCY: it stops K callers from each doing a read, a refused write and a
   * rollback when one pass would do.
   *
   * The two layers are therefore independent, and the test that proves the
   * invariant (`f5-admission.test.ts`, "WITH THE COALESCER DEFEATED") deliberately
   * drives the reservation path around this leader to show the invariant holds
   * without it.
   */
  async drain(runId: string, requests: readonly LaunchRequest[], signal: AbortSignal): Promise<LaunchOutcome[]> {
    if (requests.length === 0) return []
    const existing = this.drainLeaders.get(runId)
    const state: DrainLeaderState = existing ?? {
      requestedGeneration: 0,
      handledGeneration: 0,
      runner: undefined,
      pending: [],
    }
    if (existing === undefined) this.drainLeaders.set(runId, state)
    // The arrival: advance the requested generation and queue this caller's work.
    // `resolve` is per-caller, so each caller receives the outcomes for its OWN
    // requests even though one leader pass serves them all.
    state.requestedGeneration += 1
    const promise = new Promise<LaunchOutcome[]>((resolve, reject) => {
      state.pending.push({ requests, signal, resolve, reject })
    })
    if (state.runner === undefined) {
      // The leader's own promise is deliberately NOT awaited by anyone, so it must
      // never reject: an unhandled rejection terminates the process under Node's
      // default policy, which would turn one caller's failure into a host-wide
      // crash. `runDrainLeader` settles its callers itself and then rethrows for
      // its own bookkeeping; this swallow is what keeps that rethrow local. The
      // callers still observe their own rejection, which is the fact that matters.
      state.runner = this.runDrainLeader(runId, state).catch(() => {})
    }
    return await promise
  }

  /**
   * Wake the run's drain because something changed that may have freed a slot
   * (V5 §7.3).
   *
   * THIS IS A WAKE, NOT A REQUEST, and the difference is the whole reason it
   * exists. `drain` answers a caller's own assignments; `requestDrain` says only
   * "look at the durable ready table again". The two callers are V5 §7.2's
   * `work submit` (after a durable insert) and §7.4's completion listener (after
   * a slot is released). Neither has work of its own to submit.
   *
   * IT DOES NOT AWAIT, AND THAT IS DELIBERATE. A completion listener must not
   * block the event that woke it: the listener's own job — reconciling the
   * child's canonical state — must not be held behind a launch that may take as
   * long as a provider call. The returned promise resolves when the pass this
   * wake requested has finished, so a TEST can await the mechanism; a production
   * listener does not have to.
   *
   * IT IS NOT THE CORRECTNESS LAYER, exactly as `drain` is not. If this wake is
   * lost — a crash, a missed event — the target is not over-admitted, because the
   * decision lives in `tryReserveAdmission`. What is lost is promptness, and that
   * is why §7.5's boot sweep exists: a run with ready assignments drains again
   * when the service opens.
   */
  async requestDrain(runId: string): Promise<void> {
    // Nothing to do for a run this host does not hold, or a disposed service.
    // Not an error: a completion event can arrive for a run another host owns.
    if (this.disposed || this.domain === undefined) return
    const record = this.getRun(runId)
    if (record === undefined) return
    const existing = this.drainLeaders.get(runId)
    const state: DrainLeaderState = existing ?? {
      requestedGeneration: 0,
      handledGeneration: 0,
      runner: undefined,
      pending: [],
    }
    if (existing === undefined) this.drainLeaders.set(runId, state)
    state.requestedGeneration += 1
    const promise = new Promise<LaunchOutcome[]>((resolve, reject) => {
      // The ready-table pass does not take its work from this list, so the
      // `requests` array is empty by construction and the outcome the caller
      // receives is the pass's own summary rather than a per-request answer.
      state.pending.push({ requests: [], signal: NEVER_ABORTED, resolve, reject, fromReadyTable: true })
    })
    if (state.runner === undefined) {
      state.runner = this.runDrainLeader(runId, state).catch(() => {})
    }
    await promise
  }

  /**
   * The single per-run drain leader.
   *
   * Runs one pass per requested generation. A pass takes a SNAPSHOT of the
   * pending work at its start, so requests that arrive while it runs are served
   * by the NEXT pass rather than by a concurrent sibling — which is exactly the
   * property the old coalescer claimed and did not have.
   */
  private async runDrainLeader(runId: string, state: DrainLeaderState): Promise<void> {
    let batch: DrainWorkItem[] = []
    try {
      while (state.requestedGeneration > state.handledGeneration) {
        const pass = state.requestedGeneration
        batch = state.pending.splice(0, state.pending.length)
        // An empty batch with a pending generation means every queued caller was
        // already served; advancing the generation is what terminates the loop.
        if (batch.length > 0) {
          const outcomes = await this.runDrainPass(runId, batch)
          for (const entry of batch) {
            const mine = outcomes.get(entry) ?? []
            entry.resolve(mine)
          }
          // Settled: clear the reference so a later failure cannot settle them
          // twice, which a `Promise` silently ignores but a reader should not
          // have to reason about.
          batch = []
        }
        state.handledGeneration = pass
      }
    } catch (error) {
      // The pass threw before it could settle its callers. TWO groups need
      // settling and the distinction is easy to get wrong:
      //
      //   - `batch` holds the callers whose pass was IN FLIGHT when it threw.
      //     They were spliced out of `pending` before the pass began, so a catch
      //     that only walked `pending` would leave them awaiting a promise that
      //     never settles — a hang, which is worse than a rejection because it is
      //     invisible.
      //   - `pending` holds callers that ARRIVED during the failed pass.
      //
      // Both are rejected with the same error, and the generation is advanced so
      // the loop cannot spin on work it has already failed.
      for (const entry of batch) entry.reject(error)
      for (const entry of state.pending.splice(0, state.pending.length)) entry.reject(error)
      state.handledGeneration = state.requestedGeneration
      throw error
    } finally {
      state.runner = undefined
      // Defensive re-election: if work arrived in the window between the loop's
      // final test and this `finally`, the leader that would serve it must exist.
      // The loop's own condition already covers the common case; this covers a
      // future edit that introduces an await in that window.
      if (state.requestedGeneration > state.handledGeneration && state.pending.length > 0) {
        state.runner = this.runDrainLeader(runId, state).catch(() => {})
      } else if (state.pending.length === 0 && state.requestedGeneration === state.handledGeneration) {
        // Nothing queued and nothing requested: drop the state so a long-lived
        // host does not accumulate one entry per run it has ever drained.
        this.drainLeaders.delete(runId)
      }
    }
  }

  /**
   * One drain pass over a snapshot of queued work.
   *
   * The admission decision is NOT made here. It is made inside
   * `tryReserveAdmission`'s storage-domain update, so the pre-checks below are
   * reporting aids and host-wide short-circuits, never the authority. The
   * authority is the reservation, and a request that passes these pre-checks and
   * loses the race at the reservation is refused honestly with the reservation's
   * own reason.
   */
  private async runDrainPass(
    runId: string,
    batch: readonly DrainWorkItem[],
  ): Promise<Map<DrainWorkItem, LaunchOutcome[]>> {
    const outcomes = new Map<DrainWorkItem, LaunchOutcome[]>()
    for (const entry of batch) outcomes.set(entry, [])

    for (const entry of batch) {
      const mine = outcomes.get(entry)!
      // ---- WHERE THIS PASS'S WORK COMES FROM (V5 §7.3) ----------------------
      //
      // A caller-driven item carries its own requests. A ready-driven item
      // carries NONE, and its work is the run's durable ready table read at pass
      // start, OLDEST FIRST. Reading it here rather than at the wake is what
      // makes a wake idempotent and lossless: the pass always decides from the
      // current durable state, so a wake that arrives while a previous pass is
      // still committing cannot act on a stale list.
      //
      // The pass loops until the table yields nothing admit-able, because one
      // wake must be able to fill SEVERAL free slots. A single-request pass would
      // need one wake per slot, which under a completion storm is exactly the
      // polling this slice exists to remove.
      const requests: readonly LaunchRequest[] = entry.fromReadyTable === true
        ? this.readyAssignments(runId).map(a => ({
            taskId: a.taskId,
            childId: a.childId,
            prompt: a.prompt,
            reservedCost: a.reservedCost,
            allowedCapabilities: a.allowedCapabilities,
          }))
        : entry.requests
      // ---- A READY-DRIVEN PASS REFUSES TO CONSUME THE TABLE WITH NO PORT ----
      //
      // WHY THIS GUARD EXISTS, and it is not defensive padding. The
      // caller-driven path below already handles an absent port by admitting the
      // task and then moving it to `unknown` with `uncertainty: 'no launch port
      // installed'` — correct there, because a caller asked for THIS work and
      // must learn it did not run. Applied to the ready table it would be
      // DESTRUCTIVE: a boot sweep (§7.5) with no port installed would convert
      // every durable ready row into an `unknown` TASK, which holds a slot and
      // commits credit. A wake that turns pending intent into quarantined
      // occupancy is worse than not waking.
      //
      // So a ready-driven pass with no port leaves the table EXACTLY as it found
      // it and reports the refusal, which is the honest reading: the work is
      // still pending, and the reason it is not running is a configuration fact
      // about this host rather than anything about the assignment.
      if (entry.fromReadyTable === true && this.launchPort === undefined && requests.length > 0) {
        const first = requests[0]!
        mine.push({
          taskId: first.taskId,
          childId: first.childId,
          accepted: false,
          reason: 'no launch port installed',
        })
        continue
      }
      for (const request of requests) {
        // A caller whose signal is already aborted, or a disposed service, gets NO
        // OUTCOME rather than a refusal, and that is the contract the previous
        // implementation had: `host.test.ts` ("does not launch when the caller
        // signal is already aborted") asserts `outcomes` has length 0 and the port
        // was never called. The distinction is honest: a REFUSAL means the gate
        // evaluated the request and said no, whereas an aborted caller never asked,
        // so reporting `accepted: false` here would invent a decision the gate did
        // not make.
        //
        // It also never releases a slot: an aborted drain simply does not admit.
        if (this.disposed || entry.signal.aborted) break

        const record = this.requireRun(runId)
        const counts = countRun(record, this.liveness.get(runId) ?? new Map(), this.readyTaskCountFor(record))

        // ---- THERE IS NO OCCUPANCY PRE-CHECK HERE ANY MORE, AND WHY ----------
        //
        // This loop used to call `mayAdmit(record, counts, request.reservedCost)`
        // here and refuse on its answer. `record` was read at the TOP of this
        // iteration, so that refusal was decided from a snapshot no write chain
        // protects: in a completion storm the release and the top-up are in flight
        // in the same event-loop interval, the read sees the PRE-release record,
        // and every refill is refused even though the slots are free by the time
        // the reservation would run.
        //
        // MEASURED, target 10, four releases and four refills in ONE interval:
        // `admitted=0`, `held=6`, `deficit=4`, all four refusals reported `'none'`,
        // and `highWater` stayed at 10 — which is the proof the pre-check refused
        // and the reservation never ran. The SAME four refills issued after the
        // releases committed admit exactly four (`admitted=4 of 5`, control arm).
        // So this was a MISSED TOP-UP in the ordinary trigger of the whole
        // subsystem, not a corner case.
        //
        // The reason it was here was real but is now obsolete. It existed to stop
        // a REFUSED attempt from bumping the gate's `highWater` to `target + 1`,
        // because `tryReserveAdmission` used to take the host-wide slot BEFORE the
        // record write and release it afterwards. That take now happens INSIDE the
        // transform, after every refusal (see `tryReserveAdmission` step 6), so a
        // refusal cannot move `highWater` at all and the compensation is no longer
        // needed. Both directions are then satisfied by one mechanism instead of
        // trading one for the other:
        //
        //   - no DUPLICATE: occupancy, target and credit are decided inside the
        //     one storage-domain update, serialized by the domain's write chain;
        //   - no MISS: nothing refuses on a snapshot that a pending release can
        //     invalidate. Every request reaches the authority, and the authority
        //     reads the record as of its own queue slot.
        //
        // WHAT MUST NOT BE REINTRODUCED. A read-only refusal is only safe when the
        // value it reads cannot be changed by a write already queued ahead of it.
        // `this.gate.occupied` is process-local and synchronous, so the host-cap
        // short-circuit below is safe; a DURABLE record field is not, which is why
        // the run's occupancy is not pre-checked.

        // ---- THE HOST-WIDE GATE, which the per-run arithmetic cannot see -----
        //
        // Checked BEFORE the reservation so the outcome reports
        // `host_capacity_reached` rather than surfacing as a generic admission
        // error. WHY THIS IS NOT THE AUTHORITY: it reads `this.gate`, which is
        // this PROCESS's ledger. A second host sharing the store has its own, so
        // this check is a reporting improvement over the authoritative refusal
        // inside the reservation, not a substitute for it. `tryReserveAdmission`
        // takes the host slot itself and refuses on the record's own states.
        if (this.gate.occupied >= this.gate.limit) {
          mine.push({
            taskId: request.taskId,
            childId: request.childId,
            accepted: false,
            reason: 'host_capacity_reached',
          })
          continue
        }

        // ---- THE AUTHORITATIVE RESERVATION ----------------------------------
        //
        // This is the decision. It is one storage-domain update: occupancy,
        // target, budget, task state, credit and the launch intention all move
        // together, serialized by the domain's write chain, so no concurrent
        // caller can observe the pre-write record and admit past the target.
        //
        // `expectedRunRevision` is deliberately NOT passed here. This pass is a
        // top-up attempt, not a compare-and-swap on a revision it decided from:
        // passing the generation it read above would refuse every request in a
        // storm after the first committed, which would under-admit. The
        // generation guard exists for a caller that HAS decided from a specific
        // revision (see `tryReserveAdmission`'s parameter) and is exercised by
        // the fault tests; the drain relies on the reservation itself.
        const reservation = await this.tryReserveAdmission({
          runId,
          taskId: request.taskId,
          childId: request.childId,
          assignmentDigest: request.prompt,
          reservedCost: request.reservedCost,
          // A ready assignment carries its own capability list; a caller-driven
          // request that named none keeps the drain's existing default. This is
          // the same expression as before for every pre-existing caller, so no
          // admission changes behaviour because of this line.
          allowedCapabilities: request.allowedCapabilities ?? ['reader'],
        })
        if (!reservation.reserved) {
          // The refusal came from the atomic update, so its reason is the gate's
          // own answer and cannot have drifted from the decision. `admit`'s
          // callers assert on the same wording, which is why the message is
          // carried out rather than re-derived here.
          mine.push({
            taskId: request.taskId,
            childId: request.childId,
            accepted: false,
            reason: refusalReasonForOutcome(record, counts, reservation, request.reservedCost),
          })
          if (entry.fromReadyTable === true) {
            // ---- TWO DIFFERENT REFUSALS, TWO DIFFERENT RESPONSES (V5 §7.3) ----
            //
            // §7.3's pseudo-code is explicit: "if target/cap/budget blocked:
            // break". A capacity refusal is a fact about the RUN, not about this
            // assignment, so every remaining ready row would be refused
            // identically. Continuing would spend one refused storage-domain
            // update per row to learn the same answer, which is the cost the
            // leader exists to avoid.
            //
            // `slots_held_by_unconfirmed` is the exception and must NOT break:
            // it is the row's own staleness. The taskId is already admitted (or
            // tombstoned), which means the READY row is redundant — the window
            // `clearReadyAssignment` documents. An admitted task is stronger
            // evidence than a pending intent, so the row is dropped and the pass
            // moves on to the next one. Breaking here would let ONE stale row
            // block every row behind it, which is a starvation bug with a
            // plausible-looking justification.
            if (reservation.reason === 'slots_held_by_unconfirmed') {
              await this.clearReadyAssignment(runId, request.taskId)
              continue
            }
            break
          }
          continue
        }

        // ---- THE INTENT IS RETIRED AS SOON AS IT IS ADMITTED ----------------
        //
        // Placed HERE, immediately after the reservation committed, rather than
        // after the launch: from this point the task is durably admitted, so the
        // READY row is already redundant, and clearing it now keeps the window
        // (documented at `clearReadyAssignment`) as small as this design can
        // make it. Clearing it after the launch would leave the window open for
        // as long as a provider call takes.
        //
        // NOT conditional on `entry.fromReadyTable`: the rule is about the
        // taskId, not about which path admitted it. A caller-driven drain that
        // happens to admit a taskId which also has a READY row retires the row
        // for the same reason.
        await this.clearReadyAssignment(runId, request.taskId)

        // ---- THE DURABLE RESERVATION IS COMMITTED. ONLY NOW MAY WE LAUNCH ----
        //
        // Everything below is post-reservation. A crash anywhere after this
        // point leaves a `prepared`/`launching` task holding its slot and its
        // credit, which reconciliation resolves — never a silent release.
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
          mine.push({
            taskId: request.taskId,
            childId: request.childId,
            accepted: false,
            reason: 'no launch port installed',
          })
          continue
        }

        try {
          await port.launch(request, entry.signal)
        } catch (error) {
          // The launch failed. We cannot tell whether the child was created, so
          // this is `unknown`, not a clean failure: retrying blindly here is how a
          // system double-launches (INV-D4).
          //
          // THE RESERVATION IS RECONCILED EXACTLY ONCE, and not here: the task
          // moves to `unknown` with `releaseReservation: false`, so the slot and
          // the credit stay held until a reconciliation decides from evidence.
          // Releasing on the failure itself would free a slot for a child that
          // may exist, which is the over-admission this change exists to stop,
          // one layer down.
          await this.transition({
            runId,
            taskId: request.taskId,
            to: 'unknown',
            uncertainty: `launch failed: ${error instanceof Error ? error.message : String(error)}`,
            releaseReservation: false,
          })
          mine.push({
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
        mine.push({ taskId: request.taskId, childId: request.childId, accepted: true })
      }
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
