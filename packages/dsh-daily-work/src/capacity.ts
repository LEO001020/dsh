/**
 * The host-wide child capacity gate and the deployment depth ceiling.
 *
 * WHY THIS FILE EXISTS AT ALL. The audit's key point is that
 * `maxActiveSubagents: 30` in config is NOT sufficient and checking one tool is
 * NOT sufficient. Measured from this checkout:
 *
 *   - `maxActiveSubagents` is PER-FAMILY, not host-wide. The pool is a
 *     `WeakMap<Agent, ActivationPool>` keyed by the ROOT
 *     (`packages/subagent/subagent/src/continuation-activation.ts:180`,
 *     `rootPool()` at :605, `pool.reserve(this.maxActiveSubagents())` at :489).
 *     Two roots therefore each get a full pool: 2 x 30 = 60 children on a
 *     "30 child" deployment. The audit's own gap register already records this
 *     ("`maxActiveSubagents` is per-family, not host-wide", docs/GAPS.md
 *     G-SEAM-18).
 *   - the config value is read by the CONTINUABLE path only. The one-shot path
 *     `SubagentRuntime.start` (`packages/subagent/subagent/src/index.ts:591`)
 *     reaches `provider.start(resolved)` with no pool at all.
 *   - `workflow-ptc` `startChild`
 *     (`packages/workflow/workflow-ptc/src/host.ts:197-211`) calls
 *     `subagents.start()` with NO `maxDepth`, so a workflow launched from a
 *     depth-1 child opens a depth-2 child.
 *   - `resolveChildDepth(parent, request.maxDepth)`
 *     (`packages/subagent/subagent/src/child-agent.ts:50`) treats the caller's
 *     value as an ABSOLUTE CAP the child must not exceed, so a caller passing
 *     `99` LIFTS the deployment's intended ceiling, and an OMITTED value is not
 *     a refusal either.
 *
 * THE ONE SEAM THAT COVERS EVERY IN-PROCESS PATH. Tracing each creation path to
 * its Agent materialization:
 *
 *   continuable   `subagents.startContinuable` (continuation.ts:104)
 *                 -> `materialize` (continuation-activation.ts:481)
 *                 -> `ownerCtx.agents.create(...)` (:640)
 *   one-shot      `subagents.start` (index.ts:591)
 *                 -> provider.start -> `startInProcessRun`
 *                 -> `parent.ctx.agents.create(...)` (subagent-in-process-driver:132)
 *   cold resume   `sendMessage` -> `coldResume` (continuation.ts:406)
 *                 -> `materialize` -> `ownerCtx.agents.resume(...)` (:633)
 *   workflow/PTC  `startChild` -> `subagents.start` -> one-shot path above
 *   direct SDK    `ctx.agents.create` / `ctx.agents.resume`
 *                 (packages/core/agent/src/index.ts:171 AgentFactory)
 *
 * Every in-process child therefore passes through `AgentRegistry.create` or
 * `AgentRegistry.resume`, and both funnel into `agents.announce()`
 * (`packages/core/agent/src/index.ts:534`), which dispatches the `serial`
 * `agent/created` event at :547. A throwing `serial` listener REJECTS the
 * announcement:
 *
 *   "Announce an agent previously inserted with enter. ... @returns completion
 *    of the serial creation listeners; a listener failure rejects."
 *   "Reject if the id is already registered or a serial `agent/created`
 *    listener fails."                        -- index.ts:416-417, 529
 *
 * and `AgentLoop.publish` is rollback-covered around it
 * ("A setup throw/rejection, commit throw, or owner disposal rolls the scope
 * back without publishing either id." -- core/agent/src/index.ts:110-112).
 *
 * So `agent/created` is the earliest PUBLIC point common to all five paths, and
 * refusing there means the creating call rejects and the caller receives no
 * child. The honest limit of this point is stated rather than glossed: the
 * agent has already been inserted by `enter()` when the listener runs, so it is
 * briefly visible in the registry store during the rollback window. DSH's own
 * creation contract pairs that window with `agent/disposed`, which is why the
 * slot ledger is keyed by child id and released from `agent/disposed` — a
 * refusal takes no slot, so a rollback's disposal can never free a slot this
 * gate never took.
 *
 * WHAT THIS GATE IS NOT. It is not a distributed lease and not a cross-process
 * cap: it counts children materialized in THIS host process. An out-of-process
 * provider (`acp`, `codex`, `claude-code`, `dsh-sdk`) publishes no local Agent
 * and therefore consumes no local slot; its capacity belongs to that runtime.
 * Stated here because a reader could otherwise read "global" as "network-wide".
 *
 * @module capacity
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { delegationDepthOf } from '@deepseek-ai/dsh-subagent'

/**
 * The deployment's hard child capacity, all roots combined.
 *
 * This is the audit's `hardChildCapacity=30` (ARCHITECTURE.zh-CN.md section 14).
 * It is a DEPLOYMENT constant, not a setting: the UI can choose a sustained
 * target `N` in 1..30, and `N` is bounded by this number rather than able to
 * change it. A value that the model or the UI could raise would not be a cap.
 */
export const HARD_CHILD_CAPACITY = 30

/**
 * The occupancy classes the plan names, as one closed set.
 *
 * `reserved + starting + active_assignment + stopping + unknown_quarantined`
 * is the audit's formula. Two of these are worth spelling out because they are
 * where an optimistic implementation loses the property:
 *
 *   - `active_assignment` covers a child that is waiting on ITS OWN tool or
 *     provider. Waiting is not finishing, so it still occupies. A gate that
 *     released a slot at "the model call returned" would admit a replacement
 *     while the child was still running.
 *   - `stopping` covers a cancel that has only been REQUESTED. A sent cancel is
 *     not a confirmed cancel, so the slot is still held.
 */
export const OCCUPANCY_BUCKETS = [
  /** Reservation written; nothing materialized yet. */
  'reserved',
  /** A creation call is in flight. */
  'starting',
  /** Materialized and still owns its assignment, including while blocked on its own tool or provider. */
  'active_assignment',
  /** Cancellation requested, not confirmed. */
  'stopping',
  /** Outcome not establishable from local evidence. Held, never auto-released. */
  'unknown_quarantined',
] as const

export type OccupancyBucket = (typeof OCCUPANCY_BUCKETS)[number]

/** A refusal from the capacity gate or the deployment depth ceiling. */
export class ChildCapacityError extends Error {
  /** Stable machine code so a wire layer can map this without parsing prose. */
  readonly code: 'HOST_CAPACITY_REACHED' | 'DEPTH_CEILING_EXCEEDED'
  /** Children occupying the host at the moment of refusal. */
  readonly occupied: number
  /** The deployment cap that produced the refusal. */
  readonly capacity: number

  constructor(
    code: ChildCapacityError['code'],
    message: string,
    occupied: number,
    capacity: number,
  ) {
    super(message)
    this.name = 'ChildCapacityError'
    this.code = code
    this.occupied = occupied
    this.capacity = capacity
  }
}

/** One held slot, released exactly once. */
export interface ChildSlot {
  /** The bucket this slot currently occupies. */
  readonly bucket: OccupancyBucket
  /**
   * Move this slot to another occupancy class. Every class occupies, so this
   * changes the REPORTED reason and never the total.
   */
  setBucket(bucket: OccupancyBucket): void
  /** Declare the child session id backing this slot, when one is known. */
  setChildId(childId: string): void
  /** Give the slot back. Idempotent. */
  release(): void
}

/** The gate's state as a reader needs it, every class separately. */
export interface CapacitySnapshot {
  readonly capacity: number
  /** Physical in-process children currently materialized. */
  readonly liveChildren: number
  /**
   * Executors whose task slot names no live child: reserved, starting, stopping,
   * or quarantined with nothing materialized behind it. Each one occupies.
   */
  readonly unbackedReservations: number
  /**
   * Executors whose outcome is not establishable from local evidence, backed or
   * not. A DIAGNOSTIC SUBSET of `occupied`, never an addition to it: an
   * executor that is quarantined AND live is one executor, and counting it twice
   * would halve the effective cap in exactly the situation where the cap matters
   * most.
   */
  readonly unknownQuarantined: number
  /**
   * `liveChildren + unbackedReservations`. Never > capacity.
   *
   * This is a SUM OVER EXECUTORS, which is what the plan's
   * `reserved + starting + active_assignment + stopping + unknown_quarantined`
   * is: five mutually exclusive states of ONE executor, not five things to add
   * up independently. Every one of the five occupies; none of them is a
   * multiplier.
   */
  readonly occupied: number
  /** The largest `occupied` ever observed. A cap claim is only as good as this. */
  readonly highWater: number
  /** Refusals by code, so a report can distinguish depth from capacity. */
  readonly refusals: Readonly<Record<ChildCapacityError['code'], number>>
}

/** One physical child, keyed by its session id. */
interface LiveChild {
  bucket: OccupancyBucket
}

/** One work-service task slot, keyed by task id. */
interface TaskSlot {
  bucket: OccupancyBucket
  childId: string | undefined
}

/**
 * How one executor is currently counted.
 *
 * `folded` means the executor's task slot names a live child, so the physical
 * child is the single thing counted. `unbacked` means the task slot holds a
 * place with no live child behind it — reserved, starting, stopping, or
 * quarantined with nothing materialized.
 */
interface OccupancyTally {
  readonly liveChildren: number
  readonly unbackedReservations: number
  readonly unknownQuarantined: number
  readonly occupied: number
}

/**
 * Whether one agent is a session-backed CHILD, using DSH's own classification
 * vocabulary rather than a guess.
 *
 * `childSessionMeta` (`packages/subagent/subagent/src/child-agent.ts:129`)
 * stamps `origin: 'subagent'` and `delegationDepth: childDepth` on every
 * in-process child, and `resolveChildDepth` guarantees `childDepth >= 1`
 * (`delegationDepthOf(parent) + 1`). A root carries neither. A session fork
 * created by the session controller carries `parentSession` but neither
 * `origin` nor a delegation depth (`packages/api/session-controller/src/commands.ts:264`
 * sets `parentSession` and `isSeeded` only), so a fork is NOT a child and must
 * not be counted — over-counting forks would refuse legitimate user work.
 *
 * `delegationDepthOf` is used for the depth half because it is the monotone
 * floor DSH itself enforces: "The persisted session header is authoritative and
 * monotone: runtime AgentOptions.subagentDepth may DEEPEN the count but can
 * never lower it" (depth.ts:17-19). Reading it here means a resumed child
 * cannot be misclassified as top-level.
 */
export function isSessionBackedChild(agent: Agent): boolean {
  const header = agent.session.header
  if (header.origin === 'subagent') return true
  return delegationDepthOf(agent) > 0
}

/**
 * The host-wide child slot ledger.
 *
 * ONE synchronous ledger, because a check-then-act pair separated by an await
 * is exactly how a system oversubscribes. `reserve` is synchronous and
 * increments before returning, so no two callers can both observe the last free
 * slot.
 *
 * Two kinds of slot feed one number, and the folding rule is the part that has
 * to be right:
 *
 *   occupied = liveChildren + unbackedReservations
 *
 * A task slot whose child is live is FOLDED into the physical child rather than
 * added to it, because counting both would report one child as two and halve
 * the effective capacity. That folding is NOT conditional on the bucket: a
 * quarantined executor whose child is live is still ONE executor, and the
 * quarantine is reported as its own diagnostic count rather than as extra
 * occupancy. Counting a live quarantined executor twice would halve the cap in
 * precisely the situation the cap exists for — a host whose executors' fates are
 * unestablished — which is the opposite failure from oversubscribing and just as
 * wrong.
 *
 * The quarantine still OCCUPIES, which is the half the plan requires
 * ("对账不明的执行者不提前 release"): a quarantined task with no live child is an
 * unbacked reservation and is counted as one.
 *
 * SINGLE SOURCE. {@link ChildAdmissionGate.classify} is the one place that
 * decides which class an executor is in, and both `occupied` and `snapshot()`
 * read its result. Two derivations of the same number is exactly how a gate and
 * its reported reading drift apart (the defect class this project recorded as
 * G-FIX-01).
 */
export class ChildAdmissionGate {
  private readonly capacity: number
  /** Physical children by session id. */
  private readonly live = new Map<string, LiveChild>()
  /** Work-service task slots by task id. */
  private readonly tasks = new Map<string, TaskSlot>()
  private high = 0
  private readonly refusalCounts: Record<ChildCapacityError['code'], number> = {
    HOST_CAPACITY_REACHED: 0,
    DEPTH_CEILING_EXCEEDED: 0,
  }

  /**
   * @param capacity - the deployment cap. Defaults to {@link HARD_CHILD_CAPACITY}.
   */
  constructor(capacity: number = HARD_CHILD_CAPACITY) {
    if (!Number.isSafeInteger(capacity) || capacity < 1) {
      throw new TypeError(`child capacity must be a positive safe integer, got ${String(capacity)}`)
    }
    this.capacity = capacity
  }

  /** The deployment cap this ledger enforces. */
  get limit(): number {
    return this.capacity
  }

  /**
   * THE one occupancy classifier. Every reading of this ledger goes through it,
   * so a reported number cannot be derived a second way and drift.
   *
   * An executor is counted exactly once:
   *
   *   - a live child is counted as a live child. Its task slot, if it has one,
   *     is FOLDED into it — including a quarantined one, because a quarantined
   *     executor that is live is still one executor.
   *   - a task slot with no live child behind it is an unbacked reservation and
   *     is counted as one, whatever its bucket. That is what makes `reserved`,
   *     `starting`, `stopping` and a bare `unknown_quarantined` all occupy.
   *
   * The quarantine count is reported alongside as a DIAGNOSTIC subset and is
   * never added to `occupied`.
   */
  private classify(): OccupancyTally {
    let unbacked = 0
    let quarantined = 0
    for (const task of this.tasks.values()) {
      if (task.bucket === 'unknown_quarantined') quarantined += 1
      if (task.childId !== undefined && this.live.has(task.childId)) continue
      unbacked += 1
    }
    return {
      liveChildren: this.live.size,
      unbackedReservations: unbacked,
      unknownQuarantined: quarantined,
      occupied: this.live.size + unbacked,
    }
  }

  /**
   * Executors occupying the host right now. Derived on every read from the two
   * maps, never cached, so no second opinion can drift from the ledger.
   */
  get occupied(): number {
    return this.classify().occupied
  }

  /** A full reading, every class separate. */
  snapshot(): CapacitySnapshot {
    const tally = this.classify()
    return {
      capacity: this.capacity,
      liveChildren: tally.liveChildren,
      unbackedReservations: tally.unbackedReservations,
      unknownQuarantined: tally.unknownQuarantined,
      occupied: tally.occupied,
      highWater: this.high,
      refusals: { ...this.refusalCounts },
    }
  }

  /** Whether a physical child with this session id is currently held. */
  hasChild(childId: string): boolean {
    return this.live.has(childId)
  }

  /**
   * Take the slot for one materialized in-process child.
   *
   * Called from the `agent/created` listener, which runs BEFORE the creating
   * call resolves. Throws {@link ChildCapacityError} when the host is full, so
   * the announcement rejects and the caller receives no child.
   *
   * THE FOLD APPLIES HERE TOO, and this is the case that would otherwise
   * deadlock the host. A task slot is taken BEFORE the launch, and it names the
   * child id it reserved. Materializing that exact child does not raise
   * occupancy by one — it converts an unbacked reservation into a backed one, so
   * the executor count is unchanged. Charging room again would refuse a child
   * its OWN reservation, and at N=30 with thirty reservations the host would
   * admit zero children: it would wedge at precisely the capacity it exists to
   * sustain, and the harder it was driven the more completely it would stop.
   * Measured before the fix: three reservations at capacity 3 materialized
   * zero children.
   *
   * A child with NO reservation behind it is a genuinely new executor and is
   * checked against the cap as before. That is the path a workflow's
   * `startChild`, a direct `ctx.agents.create` and an out-of-band delegation
   * take, and they must still be bounded.
   *
   * @param childId - the child's durable session id.
   * @returns the held slot; `release()` is idempotent.
   */
  reserveChild(childId: string): ChildSlot {
    const existing = this.live.get(childId)
    if (existing !== undefined) {
      // Re-publishing the same identity is not a second child. Returning the
      // existing slot keeps `agent/disposed` from freeing a slot a live
      // sibling still owns.
      return this.slotForChild(childId)
    }
    if (!this.reservationFor(childId)) this.assertRoom('a child agent')
    this.live.set(childId, { bucket: 'active_assignment' })
    this.observeHighWater()
    return this.slotForChild(childId)
  }

  /**
   * Whether some task slot already holds a place for this child id.
   *
   * The reserved id is the reconciliation relation between a task and its
   * child, so this is the identity test for "this child is the executor that
   * reservation was taken for" rather than a name comparison.
   */
  private reservationFor(childId: string): boolean {
    for (const task of this.tasks.values()) {
      if (task.childId === childId) return true
    }
    return false
  }

  /**
   * Take a slot for one work-service task that has no materialized child yet.
   *
   * This is what makes `reserved` and `starting` occupy. It is separate from
   * {@link reserveChild} because the two facts arrive at different times: the
   * record reserves before the launch, and the child materializes inside it.
   *
   * @param taskId - the durable task id.
   * @param bucket - the occupancy class to start in.
   * @param childId - the reserved child id, when one is already known.
   */
  reserveTask(taskId: string, bucket: OccupancyBucket, childId?: string): ChildSlot {
    const existing = this.tasks.get(taskId)
    if (existing !== undefined) {
      existing.bucket = bucket
      if (childId !== undefined) existing.childId = childId
      return this.slotForTask(taskId)
    }
    this.assertRoom(`task "${taskId}"`)
    this.tasks.set(taskId, { bucket, childId })
    this.observeHighWater()
    return this.slotForTask(taskId)
  }

  /**
   * Give back the slot for a disposed child. Idempotent, and deliberately
   * silent when nothing is held: a refusal at `agent/created` takes no slot, so
   * the rollback's `agent/disposed` must not free a slot that was never taken.
   *
   * @returns whether a slot was actually released.
   */
  releaseChild(childId: string): boolean {
    return this.live.delete(childId)
  }

  /** Give back a work-service task slot. Idempotent. */
  releaseTask(taskId: string): boolean {
    return this.tasks.delete(taskId)
  }

  /**
   * Refuse a child whose delegation depth exceeds the deployment ceiling.
   *
   * WHY THIS IS HERE AND NOT IN THE CALLER. `resolveChildDepth(parent,
   * maxDepth)` treats the request value as an absolute cap, so a caller passing
   * `99` lifts the ceiling and an omitted value is not a refusal either
   * (docs/GAPS.md G-SEAM-18, measured). Enforcing the ceiling at the
   * deployment boundary is what makes it independent of the caller: the depth
   * is read from the child's own durable header, which
   * `childSessionMeta`/`delegationDepthOf` make monotone, so no request field
   * can lower it.
   *
   * @param agent - the child about to be announced.
   * @param maxDepth - the deployment's ceiling, from host config.
   * @throws {ChildCapacityError} with code `DEPTH_CEILING_EXCEEDED`.
   */
  assertDepthWithin(agent: Agent, maxDepth: number): void {
    if (!Number.isSafeInteger(maxDepth) || maxDepth < 0) {
      throw new TypeError(`deployment maxDepth must be a non-negative safe integer, got ${String(maxDepth)}`)
    }
    const depth = delegationDepthOf(agent)
    if (depth <= maxDepth) return
    this.refusalCounts.DEPTH_CEILING_EXCEEDED += 1
    throw new ChildCapacityError(
      'DEPTH_CEILING_EXCEEDED',
      `dailyWork: refusing child "${agent.session.header.id}" at delegation depth ${depth}; the deployment `
      + `ceiling is ${maxDepth}. A caller-supplied maxDepth cannot raise this: the depth is read from the `
      + 'child\'s own durable header.',
      this.occupied,
      this.capacity,
    )
  }

  /** Record a refusal for the report. Called by {@link assertRoom} and by the mount. */
  private refuse(subject: string): ChildCapacityError {
    this.refusalCounts.HOST_CAPACITY_REACHED += 1
    return new ChildCapacityError(
      'HOST_CAPACITY_REACHED',
      `dailyWork: refusing ${subject} — the host already holds ${this.occupied} children and the hard `
      + `capacity is ${this.capacity}. This is a deployment constant; a UI target N is bounded by it, `
      + 'not able to change it.',
      this.occupied,
      this.capacity,
    )
  }

  private assertRoom(subject: string): void {
    if (this.occupied < this.capacity) return
    throw this.refuse(subject)
  }

  /** Record the high-water mark after every mutation. */
  private observeHighWater(): void {
    const now = this.occupied
    if (now > this.high) this.high = now
  }

  /**
   * One slot handle for a task id. A closure over the ledger rather than a
   * bound object, so `setBucket` always writes the CURRENT entry and a released
   * slot's later writes are inert instead of resurrecting a stale object.
   */
  private slotForTask(taskId: string): ChildSlot {
    const read = (): TaskSlot | undefined => this.tasks.get(taskId)
    return {
      get bucket(): OccupancyBucket {
        return read()?.bucket ?? 'reserved'
      },
      setBucket: (bucket: OccupancyBucket): void => {
        const entry = read()
        if (entry === undefined) return
        entry.bucket = bucket
        this.observeHighWater()
      },
      setChildId: (childId: string): void => {
        const entry = read()
        if (entry !== undefined) entry.childId = childId
      },
      release: (): void => { this.releaseTask(taskId) },
    }
  }

  /** One slot handle for a physical child. Release is `agent/disposed`-driven. */
  private slotForChild(childId: string): ChildSlot {
    const read = (): LiveChild | undefined => this.live.get(childId)
    return {
      get bucket(): OccupancyBucket {
        return read()?.bucket ?? 'active_assignment'
      },
      setBucket: (bucket: OccupancyBucket): void => {
        const entry = read()
        if (entry !== undefined) entry.bucket = bucket
      },
      setChildId: (): void => {
        // A physical slot is already keyed by its child id.
      },
      release: (): void => { this.releaseChild(childId) },
    }
  }
}

/** What a refusal observer receives, so a host can surface it instead of swallowing it. */
export interface ChildRefusal {
  readonly code: ChildCapacityError['code']
  readonly message: string
  readonly childId: string | undefined
  readonly depth: number | undefined
}

/** What the mount needs. */
export interface ChildAdmissionGuardOptions {
  readonly gate: ChildAdmissionGate
  /** The deployment's delegation ceiling, from host config. Never from a request. */
  readonly maxDepth: number
  /** Called on every refusal. A refusal must be visible, not silent. */
  readonly onRefusal?: (refusal: ChildRefusal) => void
}

/**
 * Mount the two deployment-boundary checks on the one event every in-process
 * child passes through.
 *
 * The listener THROWS rather than returning, because `agent/created` is a
 * `serial` event whose contract is "a listener failure rejects". Returning a
 * value would be read as success.
 *
 * `agent/disposed` is `emit` mode with per-listener containment
 * (`core/agent/src/index.ts:511-521`), so the release path cannot break teardown
 * and cannot be skipped by a sibling listener throwing.
 *
 * @param ctx - the host context. Registered through `ctx.on`, so both listeners
 *   are owned by this fiber and removed with it.
 * @param options - the ledger, the deployment ceiling, and the refusal sink.
 * @returns nothing; ownership is the caller's fiber.
 */
export function mountChildAdmissionGuard(ctx: Context, options: ChildAdmissionGuardOptions): void {
  const { gate, maxDepth, onRefusal } = options
  ctx.on('agent/created', ({ agent }) => {
    // A root and a non-subagent session fork are not children and must not
    // consume a child slot: the plan's rule is that root does not count and is
    // not starved. See isSessionBackedChild for why these two durable fields
    // are the right discriminator.
    if (!isSessionBackedChild(agent)) return
    const childId = String(agent.session.header.id)
    try {
      gate.assertDepthWithin(agent, maxDepth)
      gate.reserveChild(childId)
    } catch (error) {
      if (error instanceof ChildCapacityError) {
        onRefusal?.({
          code: error.code,
          message: error.message,
          childId,
          depth: error.code === 'DEPTH_CEILING_EXCEEDED' ? delegationDepthOf(agent) : undefined,
        })
      }
      // Rethrow: a serial listener failure is what rejects the announcement and
      // rolls the unpublished child back.
      throw error
    }
  })
  ctx.on('agent/disposed', ({ agent }) => {
    gate.releaseChild(String(agent.session.header.id))
  })
}
