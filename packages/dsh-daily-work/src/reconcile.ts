/**
 * Reconciliation: resolving what actually happened after an interruption.
 *
 * The five positions this project keeps separate:
 *
 *   1. task intent durably admitted        (our run record: state >= prepared)
 *   2. child Session / Inbox accepted      (DSH: the child exists and took the prompt)
 *   3. Inbox claimed                       (DSH: the prompt left the pending list)
 *   4. message entered a real model request (DSH: the Session log shows it)
 *   5. task effect or result confirmed     (an artifact or an independent check)
 *
 * A crash can land between any two. The whole point of this module is to decide,
 * from evidence, where a task actually got to - and to say `unknown` when the
 * evidence does not settle it.
 *
 * The rule that governs every branch here:
 *
 *   NEVER auto-replay. An interrupted turn, a lost reply and a disposal error are
 *   not permissions to retry. They are reasons to look.
 *
 * A second rule, equally load-bearing: a lost parent notification is NOT a child
 * failure. If the child's Session shows the work completed, the work completed;
 * the missing notice is a delivery problem, not a work problem.
 */
import type { AdmissionState } from './states.ts'
import type { TaskRecord } from './record.ts'

/**
 * What a probe of the child's real Session/descriptor tells us.
 *
 * Every field is EVIDENCE, observed from DSH, never inferred from our own
 * optimism. `undefined` means "not observed", which is different from `false`.
 */
export interface ChildEvidence {
  /** The task this evidence belongs to. */
  readonly taskId: string
  /** The child id that was reserved and (possibly) launched. */
  readonly childId: string
  /** Does a Session with this id exist on the medium? */
  readonly sessionExists: boolean
  /**
   * Does a live Agent with this id exist in this process? A resumed Session may
   * exist on disk with no live Agent, and that is a different situation.
   */
  readonly agentLive: boolean
  /** Did the child's Session record the prompt entering a request? */
  readonly requestObserved: boolean
  /**
   * Did the child's Session reach a terminal turn, and with what reason?
   * `'completed'` is the only reason that means the child finished its turn.
   */
  readonly turnOutcome: 'completed' | 'interrupted' | 'error' | undefined
  /** Did the child produce a result we can point at (an artifact ref)? */
  readonly resultRef: string | undefined
  /**
   * Did the launch fail in a way that proves the child was never created?
   * Only `true` here licenses returning to `prepared`.
   */
  readonly launchProvenNotCreated: boolean
  /** A human-readable note for the record when the outcome is uncertain. */
  readonly note?: string
}

/** The decision reconciliation reached, and why. */
export interface Reconciliation {
  readonly taskId: string
  /** The state the task should move to. */
  readonly next: AdmissionState
  /** Whether the slot should be released. Only confirmed/cancelled release. */
  readonly releaseSlot: boolean
  /** Why, in words a human reading the record can check against the evidence. */
  readonly reason: string
}

/**
 * Decide the true state of one task from evidence.
 *
 * Deliberately conservative: every branch that cannot PROVE a safe conclusion
 * returns `unknown`, which holds the slot and its reservation.
 *
 * @param task - the stored task record, whose `state` is our last belief.
 * @param evidence - what the real environment shows now.
 * @returns the state to move to, and whether that frees the slot.
 */
export function reconcileTask(task: TaskRecord, evidence: ChildEvidence): Reconciliation {
  const id = task.taskId

  // ---- Case A: the launch provably never created a child. ----------------
  // This is the ONLY path back to `prepared`. It requires positive proof, not
  // an absence of evidence: a failed `startContinuable` that rolled the child
  // back, or a reservation that was never handed to the launcher.
  if (evidence.launchProvenNotCreated) {
    return {
      taskId: id,
      next: 'prepared',
      releaseSlot: false,
      reason: 'the launch provably never created a child; the reservation is intact and may be launched again',
    }
  }

  // ---- Case B: no Session exists, and no agent is live. -----------------
  // We reserved an id and cannot find any trace of it. Two readings are
  // possible: the launch never happened, or it happened and the Session was
  // lost. We cannot tell them apart, so this is NOT a licence to relaunch.
  if (!evidence.sessionExists && !evidence.agentLive) {
    return {
      taskId: id,
      next: 'unknown',
      releaseSlot: false,
      reason:
        'no Session and no live Agent for the reserved child id; whether the child was ever created cannot be established from local evidence, so it is quarantined rather than relaunched',
    }
  }

  // ---- Case C: a Session exists but the prompt never reached a request. --
  // The child took the prompt into its inbox but never ran it. DSH's own
  // interrupted-turn repair covers this; we must not inject a second copy.
  if (!evidence.requestObserved) {
    return {
      taskId: id,
      next: 'accepted',
      releaseSlot: false,
      reason:
        'the child Session exists and the prompt is pending; native Inbox recovery owns it, so no duplicate delivery is made',
    }
  }

  // ---- Case D: the request was observed but the turn did not complete. --
  // This is the dangerous window: the model may or may not have produced an
  // effect, and a turn-level checkpoint is not an exactly-once external effect.
  if (evidence.turnOutcome === undefined || evidence.turnOutcome === 'interrupted') {
    return {
      taskId: id,
      next: 'unknown',
      releaseSlot: false,
      reason:
        'the child entered a model request but no terminal turn is recorded; the outcome is unknown and the reservation is held until it can be established',
    }
  }

  if (evidence.turnOutcome === 'error') {
    return {
      taskId: id,
      next: 'unknown',
      releaseSlot: false,
      reason:
        'the child turn ended in error; an error is not proof that no effect occurred, so the outcome is unknown rather than failed-and-retryable',
    }
  }

  // ---- Case E: the turn completed. --------------------------------------
  // Completion is a fact about the CHILD, not about the task. Without a result
  // we can point at, this is `settling`, not `confirmed`: the acceptance runner
  // still has to decide whether the output is actually the work that was asked
  // for.
  if (evidence.resultRef === undefined) {
    return {
      taskId: id,
      next: 'settling',
      releaseSlot: false,
      reason:
        'the child turn completed but no result ref is recorded; the work awaits acceptance rather than being called confirmed',
    }
  }

  return {
    taskId: id,
    next: 'settling',
    releaseSlot: false,
    reason:
      'the child turn completed and produced a result ref; acceptance still decides whether it counts as the requested work',
  }
}

/**
 * Reconcile a whole run.
 *
 * @param tasks - the stored tasks.
 * @param evidenceByTask - what the environment shows for each task.
 * @returns one decision per task, in a stable order.
 */
export function reconcileRun(
  tasks: Readonly<Record<string, TaskRecord>>,
  evidenceByTask: ReadonlyMap<string, ChildEvidence>,
): Reconciliation[] {
  const decisions: Reconciliation[] = []
  for (const taskId of Object.keys(tasks).sort()) {
    const task = tasks[taskId]
    if (task === undefined) continue
    const evidence = evidenceByTask.get(taskId)
    if (evidence === undefined) {
      decisions.push({
        taskId,
        next: 'unknown',
        releaseSlot: false,
        reason: 'no evidence was gathered for this task; an unprobed task stays quarantined',
      })
      continue
    }
    decisions.push(reconcileTask(task, evidence))
  }
  return decisions
}

/**
 * Whether a run may be resumed automatically after a host restart.
 *
 * Reopening a Session does NOT re-authorize unbounded background execution. A
 * run whose authorization expired, or which was never granted restart-resume
 * permission, comes back PAUSED with its pending work visible.
 *
 * @param restartResumeAuthorized - the persisted per-run permission.
 * @param authorizationExpiresAt - ISO-8601 expiry, or undefined for no expiry.
 * @param now - the current time as ISO-8601.
 * @returns the phase the run should adopt, and why.
 */
export function recoveryPhase(
  restartResumeAuthorized: boolean,
  authorizationExpiresAt: string | undefined,
  now: string,
): { readonly phase: 'open' | 'paused'; readonly reason: string } {
  if (!restartResumeAuthorized) {
    return {
      phase: 'paused',
      reason: 'this run was not authorized to continue after a host restart; it resumes paused with its pending work visible',
    }
  }
  if (authorizationExpiresAt !== undefined && Date.parse(authorizationExpiresAt) <= Date.parse(now)) {
    return {
      phase: 'paused',
      reason: `the restart-resume authorization expired at ${authorizationExpiresAt}; a new authorization is required`,
    }
  }
  return {
    phase: 'open',
    reason: 'the run holds a live restart-resume authorization',
  }
}
