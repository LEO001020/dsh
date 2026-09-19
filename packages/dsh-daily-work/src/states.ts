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
  accepted: ['executing', 'settling', 'cancel_requested', 'unknown'],
  executing: ['settling', 'cancel_requested', 'unknown'],
  settling: ['confirmed', 'unknown', 'cancel_requested'],
  confirmed: [],
  cancel_requested: ['cancelled', 'unknown'],
  cancelled: [],
  // Reconciliation is the only way out, and it may conclude anything.
  unknown: ['accepted', 'executing', 'settling', 'confirmed', 'cancelled', 'cancel_requested'],
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
