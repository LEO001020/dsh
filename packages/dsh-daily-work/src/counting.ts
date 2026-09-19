/**
 * Precise counting.
 *
 * DSH `Agent.status === 'running'` covers the driver lifetime and does NOT
 * prove tokens are being produced. Merging distinct quantities into one green
 * number is how a system claims ten workers while running two. So this module
 * computes every count separately and refuses to reduce them.
 *
 * The distinction that matters most:
 *   - `activeAssignments` = a child that started real work and still owns a task
 *   - an idle child with no open task is NOT a worker and is not counted
 *   - `providerWaiting`   = queued upstream. NOT physical concurrency.
 *
 * Tool parallel width, subagent count and HTTP request count are three
 * different numbers and are reported as three different numbers.
 */
import type { RunRecord } from './record.ts'
import { childCeiling, childCommitted, isHalted } from './record.ts'
import { holdsSlot } from './states.ts'

/** Per-task liveness facts observed from DSH, not from our own optimism. */
export interface TaskLiveness {
  readonly taskId: string
  /**
   * The child has started real model/tool work. Observed, not inferred from the
   * fact that a launch function returned.
   */
  readonly startedRealWork: boolean
  /** The child is currently inside its own tool call. */
  readonly waitingOnOwnedTool: boolean
  /** The child is queued at the provider rather than executing. */
  readonly providerWaiting: boolean
}

export interface Counts {
  /** The user's chosen target N. Root is not part of it. */
  readonly desiredTarget: number
  /** Tasks the root has submitted and that are ready to run. */
  readonly readyTasks: number
  /** Tasks whose intent AND credit are durably written. */
  readonly durablyAdmitted: number
  /** Launch calls currently in flight. */
  readonly launching: number
  /** Children that started real work and still hold an open task. */
  readonly activeAssignments: number
  /** Active children currently blocked inside their own tool call. */
  readonly waitingOwnedTool: number
  /** Children queued at the provider. Reported separately from execution. */
  readonly providerWaiting: number
  /** Cancellation requested, not yet confirmed. Still holds a slot. */
  readonly stopping: number
  /** Outcome not establishable from local evidence. Still holds a slot. */
  readonly quarantinedUnknown: number
  /** Tasks whose result is confirmed. */
  readonly confirmed: number
  /** Cancelled and confirmed. */
  readonly cancelled: number
  /**
   * How far below target we are, with the reason. Never silently reduced:
   * a deficit is a reported fact, not a new target.
   */
  readonly capacityDeficit: number
  readonly deficitReason: DeficitReason
}

export type DeficitReason =
  /** At or above target. */
  | 'none'
  /** Fewer ready tasks than target. Not a failure; the root has not asked for more. */
  | 'insufficient_ready_tasks'
  /** Slots are held by work whose release is not yet confirmed. */
  | 'slots_held_by_unconfirmed'
  /** Budget or authorization blocks new admission. */
  | 'budget_blocked'
  /** Actual spend exceeded its reservation; a human must resolve it. */
  | 'budget_overage_halt'
  /** The run is paused or closing. */
  | 'run_not_open'

/**
 * Count a run.
 *
 * `liveness` supplies the observed facts per task. An absent entry means
 * "not observed to have started", which is the conservative reading: an
 * unobserved child is not counted as a worker.
 */
export function countRun(
  record: RunRecord,
  liveness: ReadonlyMap<string, TaskLiveness>,
  readyTasks: number,
): Counts {
  let durablyAdmitted = 0
  let launching = 0
  let activeAssignments = 0
  let waitingOwnedTool = 0
  let providerWaiting = 0
  let stopping = 0
  let quarantinedUnknown = 0
  let confirmed = 0
  let cancelled = 0
  let held = 0

  for (const task of Object.values(record.tasks)) {
    // One rule, one source of truth (INV-C1): a slot is held exactly when the
    // state says so. Any other way of computing the occupancy would be a second
    // opinion that could silently disagree with the state machine.
    if (holdsSlot(task.state)) held += 1
    if (task.state !== 'cancelled' && task.state !== 'confirmed') durablyAdmitted += 1

    const live = liveness.get(task.taskId)
    switch (task.state) {
      case 'launching':
        launching += 1
        break
      case 'executing':
        // An executing task is an ACTIVE ASSIGNMENT only once real work has been
        // observed. Admission is not execution.
        if (live?.startedRealWork === true) {
          activeAssignments += 1
          if (live.waitingOnOwnedTool) waitingOwnedTool += 1
          if (live.providerWaiting) providerWaiting += 1
        }
        break
      case 'cancel_requested':
        stopping += 1
        break
      case 'unknown':
        quarantinedUnknown += 1
        break
      case 'confirmed':
        confirmed += 1
        break
      case 'cancelled':
        cancelled += 1
        break
      case 'prepared':
      case 'accepted':
      case 'settling':
        break
    }
  }

  const deficit = Math.max(0, record.requestedTarget - held)

  return {
    desiredTarget: record.requestedTarget,
    readyTasks,
    durablyAdmitted,
    launching,
    activeAssignments,
    waitingOwnedTool,
    providerWaiting,
    stopping,
    quarantinedUnknown,
    confirmed,
    cancelled,
    capacityDeficit: deficit,
    deficitReason: explainDeficit(record, deficit, readyTasks, 0),
  }
}

/**
 * Why this run cannot admit THIS request.
 *
 * Exists because `counts.deficitReason` is computed from the record alone and
 * therefore cannot see the cost of the request in hand. A request whose cost
 * does not fit under the child ceiling would be refused by `mayAdmit` while
 * `deficitReason` reported something else entirely - measured: a request of 91
 * against a child ceiling of 90 reported `slots_held_by_unconfirmed` with no
 * task held at all. That is the drift this module's own header warns about, in
 * the direction that matters: the gate refusing for a reason it does not state.
 *
 * Callers that are refusing a SPECIFIC request must use this function rather
 * than reading `counts.deficitReason`, so the stated reason and the gate that
 * produced it are the same decision.
 *
 * @param outstandingCost - the cost of the request being considered.
 */
export function admissionReason(record: RunRecord, counts: Counts, outstandingCost: number): DeficitReason {
  return explainDeficit(record, counts.capacityDeficit, counts.readyTasks, outstandingCost)
}

function explainDeficit(
  record: RunRecord,
  deficit: number,
  readyTasks: number,
  outstandingCost: number,
): DeficitReason {
  if (deficit === 0) return 'none'
  if (record.phase !== 'open') return 'run_not_open'
  // A recorded overage outranks the plain budget reading: both stop admission,
  // but only this one says the reservation was WRONG and needs a human. The
  // order matters, because "budget_blocked" on an overspent run would read as
  // a normal ceiling stop and hide that the bill exceeded its estimate.
  if (isHalted(record.budget)) return 'budget_overage_halt'
  if (budgetExhausted(record)) return 'budget_blocked'
  // The same comparison `mayAdmit` makes, so a refusal it would make for budget
  // is never reported as a slot problem.
  if (committedCost(record) + outstandingCost > childCeiling(record.budget)) return 'budget_blocked'
  if (readyTasks < record.requestedTarget) return 'insufficient_ready_tasks'
  return 'slots_held_by_unconfirmed'
}

/**
 * Total cost committed against the CHILD ceiling: spent, reserved, and
 * conservatively held unknowns.
 *
 * Note what this is NOT: it is not `spent + reserved + unknownReserved` measured
 * against `ceiling`. The root's reserve is subtracted first, so a run whose
 * children have committed everything they are allowed still reports headroom
 * for the root. See `childCeiling` in `record.ts` for the single definition.
 */
function committedCost(record: RunRecord): number {
  return childCommitted(record.budget)
}

/**
 * Whether the child budget leaves no room for any further commitment.
 *
 * Equality counts as exhausted: at `committed === childCeiling` no new task,
 * however cheap, can be admitted, because every real task also drags retry,
 * compaction and search calls behind it. Refusing here is the correct
 * direction for a hard budget (INV-C5: report blocked, never silently degrade).
 */
function budgetExhausted(record: RunRecord): boolean {
  return committedCost(record) >= childCeiling(record.budget)
}

/**
 * Whether new work may be admitted.
 *
 * Three independent gates, all of which must pass:
 *
 *   phase   - the run must be open.
 *   halt    - no recorded overage is waiting for a human. A halt is checked
 *             BEFORE the arithmetic because an overspent run can still have
 *             arithmetic headroom (the ceiling was not reached; the RESERVATION
 *             was). Admitting into that headroom would spend more credit on the
 *             strength of an estimate that was just proven wrong.
 *   budget  - the new commitment must fit under the CHILD ceiling, which is
 *             `ceiling - rootReserve`. This is what makes INV-C5 mechanical:
 *             a child admission that would eat into the root reserve is refused
 *             by this comparison, not by a separate check somewhere else.
 *   slots   - the target must not already be fully occupied.
 *
 * This is the SAME predicate `explainDeficit` reports as `budget_blocked` /
 * `budget_overage_halt`, deliberately: a system whose reason for a deficit
 * disagrees with its admission gate would report "blocked" while still
 * admitting.
 *
 * Occupancy is taken from `capacityDeficit`, which is derived from the state
 * machine's own `holdsSlot` predicate. Computing occupancy a second way here
 * would create a second opinion that could silently disagree with the state
 * machine, which is exactly how a system oversubscribes.
 *
 * A cancel that has been *requested* but not *confirmed* still holds its slot,
 * so it still blocks admission (INV-C4).
 *
 * @param outstandingCost - the cost about to be reserved for the new task.
 */
export function mayAdmit(record: RunRecord, counts: Counts, outstandingCost: number): boolean {
  if (record.phase !== 'open') return false
  if (isHalted(record.budget)) return false
  if (budgetExhausted(record)) return false
  if (committedCost(record) + outstandingCost > childCeiling(record.budget)) return false
  return counts.capacityDeficit > 0
}
