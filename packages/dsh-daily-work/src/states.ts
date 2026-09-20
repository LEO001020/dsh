/**
 * Mechanical admission states for one child assignment.
 *
 * These are operational states, not cognitive roles. There is no "planner" or
 * "reviewer" stage here: the root model decides what work means, and this
 * package only tracks whether a unit of work has been admitted, started,
 * settled, or left in doubt.
 *
 * The five positions the delivery plan requires us to keep separate:
 *   1. task intent durably admitted      -> `prepared`
 *   2. child Session/Inbox accepted      -> `accepted`
 *   3. Inbox claimed                     -> (child-side; observed, not asserted)
 *   4. entered a real model request      -> `executing`
 *   5. effect or result confirmed        -> `confirmed`
 *
 * A crash can land between any two. `unknown` is a real answer, not a failure
 * to decide.
 */
export const ADMISSION_STATES = [
  /** Reservation written to the durable record; nothing launched yet. */
  'prepared',
  /** A launch call is in flight. A crash here means we must reconcile. */
  'launching',
  /** The child's inbox accepted the prompt. Admission, NOT execution. */
  'accepted',
  /** The child has started real model/tool work and still owns the task. */
  'executing',
  /** Work appears done; artifacts not yet confirmed by an independent check. */
  'settling',
  /**
   * The child's ACTIVATION is over and quiescent, so the slot is released.
   *
   * WHY THIS STATE HAD TO EXIST, AND WHY ITS ABSENCE WAS THE DEFECT. Two
   * independent facts were being carried by one vocabulary, and only one of them
   * is about capacity:
   *
   *   - CAPACITY: is a child still running for this task? A completed child
   *     whose activation ended is gone, so its slot must be free or the target
   *     can never be sustained. `settling` HOLDS its slot, and nothing in
   *     production ever wrote `confirmed` either (`docs/GAPS.md` G-SEAM-68), so
   *     occupancy was monotone non-decreasing: every child permanently reduced N
   *     by one. That is the mechanism behind "rolling N does not roll".
   *   - VERIFICATION: is the result the work that was asked for? That is the
   *     acceptance runner's judgement, and `confirmed` is its only word for it.
   *
   * Folding them would make the child the oracle for its own work, which is the
   * inversion the verification gate exists to prevent. Keeping them separate is
   * what lets this state release capacity WITHOUT claiming success.
   *
   * NOT TERMINAL, and that is load-bearing: acceptance still has to run, and a
   * terminal state could never be moved to `confirmed`. So this state is
   * slot-free but still open to judgement, which is exactly what "the child is
   * gone, the work is unverified" means.
   *
   * ENTERING IT RETAINS THE RESERVATION rather than releasing the credit. The
   * child ran and spent real money that nobody has measured yet; releasing the
   * reservation would fabricate headroom against a cost that has not been
   * established. So this transition frees a SLOT without freeing BUDGET, and the
   * two axes are genuinely independent here.
   */
  'completed',
  /** The result is confirmed. Only this state is success. */
  'confirmed',
  /** Cancellation was requested. The slot is still held. */
  'cancel_requested',
  /** Cancellation is confirmed. The slot may be released. */
  'cancelled',
  /**
   * The outcome cannot be established from local evidence. The slot stays
   * reserved with conservative quota until a reconciliation resolves it.
   * This is deliberately NOT an error state that auto-retries.
   */
  'unknown',
] as const

export type AdmissionState = (typeof ADMISSION_STATES)[number]

/**
 * States that hold a slot against the configured target N.
 *
 * `settling` holds because work may still change the world.
 * `cancel_requested` holds because a sent cancel is not a confirmed cancel.
 * `unknown` holds because we cannot prove the child stopped.
 *
 * `completed` is ABSENT, and its absence is the point of the state: the child's
 * activation is over, so the slot it held is free. This is the single line that
 * makes a rolling target able to roll — without it every completion left the run
 * one slot poorer (see the state's own doc comment).
 *
 * This is the single source of truth for INV-C1: nothing may compute the
 * in-flight count with a different set.
 */
export const SLOT_HOLDING_STATES: readonly AdmissionState[] = Object.freeze([
  'prepared',
  'launching',
  'accepted',
  'executing',
  'settling',
  'cancel_requested',
  'unknown',
])

/** States from which no further transition is expected without new intent. */
export const TERMINAL_STATES: readonly AdmissionState[] = Object.freeze([
  'confirmed',
  'cancelled',
])

export function holdsSlot(state: AdmissionState): boolean {
  return SLOT_HOLDING_STATES.includes(state)
}

/**
 * Legal transitions. Anything absent here is a bug, not a policy choice, and
 * `assertTransition` throws so it surfaces as a test failure rather than as a
 * silently wrong counter.
 */
const TRANSITIONS: Readonly<Record<AdmissionState, readonly AdmissionState[]>> = Object.freeze({
  prepared: ['launching', 'cancel_requested', 'unknown'],
  // A launch that returns is `accepted`. A launch that fails before the child
  // exists may go back to `prepared`; a launch whose fate is unclear is `unknown`.
  launching: ['accepted', 'prepared', 'unknown', 'cancel_requested'],
  accepted: ['executing', 'settling', 'completed', 'cancel_requested', 'unknown'],
  executing: ['settling', 'completed', 'cancel_requested', 'unknown'],
  // `settling` is the "done but unverified" resting state that still holds a
  // slot. Its exits are acceptance's verdict (`confirmed`), the quiescence
  // release (`completed`), and the two uncertainty paths.
  settling: ['completed', 'confirmed', 'unknown', 'cancel_requested'],
  // A COMPLETED activation can still be judged. Acceptance either confirms the
  // work or quarantines it; the one thing that cannot happen is a return to a
  // running state, because the child that would run it is gone. `cancelled` is
  // reachable because a human may close the run out after the fact.
  completed: ['confirmed', 'unknown', 'cancelled'],
  confirmed: [],
  cancel_requested: ['cancelled', 'unknown'],
  cancelled: [],
  // Reconciliation is the only way out, and it may conclude anything.
  unknown: ['accepted', 'executing', 'settling', 'completed', 'confirmed', 'cancelled', 'cancel_requested'],
})

export function canTransition(from: AdmissionState, to: AdmissionState): boolean {
  return TRANSITIONS[from].includes(to)
}

export class TransitionError extends Error {
  readonly from: AdmissionState
  readonly to: AdmissionState
  readonly taskId: string

  constructor(from: AdmissionState, to: AdmissionState, taskId: string) {
    super(`task "${taskId}": illegal admission transition ${from} -> ${to}`)
    this.name = 'TransitionError'
    this.from = from
    this.to = to
    this.taskId = taskId
  }
}

export function assertTransition(from: AdmissionState, to: AdmissionState, taskId: string): void {
  if (!canTransition(from, to)) throw new TransitionError(from, to, taskId)
}
