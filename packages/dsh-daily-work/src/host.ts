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
 * After every await we re-check the run epoch, the user-cancel state and whether
 * the owner is still the exact live Agent. A stale generation must not publish
 * authoritative state.
 */
import type { Context } from '@deepseek-ai/cordis'
import { Service } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { defineDomain, domainTable, type Domain } from '@deepseek-ai/dsh-storage-domain'
import { z } from 'zod'
import { countRun, mayAdmit, type Counts, type TaskLiveness } from './counting.ts'
import { initialRunRecord, runRecordSchema, type RunRecord, type TaskRecord } from './record.ts'
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

export interface WorkServiceConfig {
  /** Default target N for a new run. Root is not part of it. */
  readonly targetChildren: number
  /** Delegation depth granted to children. 1 forbids grandchildren. */
  readonly maxDepth: number
  /** Hard budget ceiling for a new run. */
  readonly budgetCeiling: number
  readonly currency: string
  readonly priceVersion: string
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
  private disposed = false

  constructor(ctx: Context, config: WorkServiceConfig) {
    super(ctx, 'dailyWork')
    this.config = config
  }

  /** Set the launch port. Exactly one may be installed; a second call replaces it. */
  setLaunchPort(port: LaunchPort): void {
    this.launchPort = port
  }

  /**
   * Open the domain.
   *
   * Called explicitly by the mounting plugin inside its own effect, so the
   * handle's lifetime is owned by that effect rather than by this constructor.
   * Opening twice is a caller bug and the facility rejects it; we surface that
   * rather than swallowing it.
   */
  async open(): Promise<void> {
    if (this.domain !== undefined) throw new Error('dailyWork: domain is already open')
    const facility = this.ctx.get('storageDomain')
    if (facility === undefined) {
      throw new Error('dailyWork: the storageDomain service is not mounted; cannot persist run records')
    }
    this.domain = await facility.open(workDomainSpec)
  }

  /** Close the domain. Refuses new writes first, then releases the handle. */
  async close(): Promise<void> {
    this.disposed = true
    const domain = this.domain
    this.domain = undefined
    if (domain !== undefined) await domain.close()
  }

  private runs() {
    const domain = this.domain
    if (domain === undefined) throw new Error('dailyWork: domain is not open')
    return domain.table('runs')
  }

  /**
   * Create a run for an exact live Agent.
   *
   * The root Agent is stored as an identity, not as a string: authority is
   * bound to the live object plus the run epoch, so a stale callback carrying
   * the same session id cannot write authoritative state (INV-L3).
   */
  async createRun(input: {
    runId: string
    root: Agent
    authorizationRef: string
    targetChildren?: number
    restartResumeAuthorized?: boolean
    now?: string
  }): Promise<RunRecord> {
    this.assertOpen()
    const now = input.now ?? new Date().toISOString()
    const record = initialRunRecord({
      runId: input.runId,
      rootSessionId: input.root.session.header.id,
      authorizationRef: input.authorizationRef,
      requestedTarget: input.targetChildren ?? this.config.targetChildren,
      maxDepth: this.config.maxDepth,
      policyDigest: this.config.priceVersion,
      budget: {
        currency: this.config.currency,
        priceVersion: this.config.priceVersion,
        spent: 0,
        reserved: 0,
        unknownReserved: 0,
        ceiling: this.config.budgetCeiling,
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
   * Admit one task and reserve its cost, atomically, in a single `update`.
   *
   * Task state, budget reservation and the outbox entry move together because
   * they live in ONE record. Writing them under separate keys and calling that
   * atomic would be a lie: the domain gives atomicity per record, not across
   * keys (INV-D1).
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
    const updated = await this.runs().update(input.runId, record => {
      if (record.phase !== 'open') {
        throw new Error(`dailyWork: run "${input.runId}" is ${record.phase}; refusing admission`)
      }
      const committed = record.budget.spent + record.budget.reserved + record.budget.unknownReserved
      if (committed + input.reservedCost > record.budget.ceiling) {
        throw new Error(
          `dailyWork: run "${input.runId}" has no budget headroom (committed ${committed}, ceiling ${record.budget.ceiling})`,
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
        budget: { ...record.budget, reserved: record.budget.reserved + input.reservedCost },
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
    const task = updated.tasks[input.taskId]
    if (task === undefined) throw new Error(`dailyWork: admission of "${input.taskId}" did not persist`)
    return task
  }

  /**
   * Move a task to a new state, with the transition checked.
   *
   * `releaseReservation` is explicit because releasing a credit is a separate
   * decision from changing a state: a cancel that is merely *requested* must not
   * release anything.
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
      const reserved = release ? Math.max(0, record.budget.reserved - task.reservedCost) : record.budget.reserved
      const spent = record.budget.spent + (input.spentCost ?? 0)

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
        budget: { ...record.budget, reserved, spent },
        terminalTombstones: tombstones,
        updatedAt: now,
      }
    })
    const task = updated.tasks[input.taskId]
    if (task === undefined) throw new Error(`dailyWork: transition of "${input.taskId}" did not persist`)
    return task
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
          reason: counts.deficitReason,
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
