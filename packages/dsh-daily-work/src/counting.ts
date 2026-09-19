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
    deficitReason: explainDeficit(record, deficit, readyTasks),
  }
}

function explainDeficit(record: RunRecord, deficit: number, readyTasks: number): DeficitReason {
  if (deficit === 0) return 'none'
  if (record.phase !== 'open') return 'run_not_open'
  if (budgetExhausted(record)) return 'budget_blocked'
  if (readyTasks < record.requestedTarget) return 'insufficient_ready_tasks'
  return 'slots_held_by_unconfirmed'
}

/** Total committed against the ceiling: spent, reserved, and conservatively held unknowns. */
function committedCost(record: RunRecord): number {
  return record.budget.spent + record.budget.reserved + record.budget.unknownReserved
}

/**
 * Whether the authorized budget leaves no room for any further commitment.
 *
 * Equality counts as exhausted: at `committed === ceiling` no new task, however
 * cheap, can be admitted, because every real task also drags retry, compaction
 * and search calls behind it. Refusing here is the correct direction for a hard
 * budget (INV-C5: report blocked, never silently degrade).
 */
function budgetExhausted(record: RunRecord): boolean {
  return committedCost(record) >= record.budget.ceiling
}

/**
 * Whether new work may be admitted.
 *
 * Two independent gates, both of which must pass:
 *
 *   budget  - no headroom left, and the new commitment must fit under the
 *             ceiling. Committing exactly the ceiling is allowed; exceeding it
 *             is not. This is the SAME predicate `explainDeficit` reports as
 *             `budget_blocked`, deliberately: a system whose reason for a
 *             deficit disagrees with its admission gate would report "blocked"
 *             while still admitting.
 *   slots   - the target must not already be fully occupied.
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
  if (budgetExhausted(record)) return false
  if (committedCost(record) + outstandingCost > record.budget.ceiling) return false
  return counts.capacityDeficit > 0
}
