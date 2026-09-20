/**
 * The completion observer: DSH's `subagent/end` used as a MECHANICAL wake.
 *
 * ---------------------------------------------------------------------------
 * WHAT V5 §7.4 PERMITS, AND WHAT IT FORBIDS
 * ---------------------------------------------------------------------------
 *
 * §7.4: "Use DSH's real `subagent/end` event as a MECHANICAL wake/reconcile
 * signal. **Do not use it as a second parent-result delivery mechanism.** DSH's
 * manager remains owner of parent delivery."
 *
 * That sentence is the whole design of this file, and it is the one place a
 * careless implementation would go wrong. The event carries
 * `lastAssistantMessage` (`dsh-subagent/src/types.ts:100-116`), so it is
 * tempting to hand that content to the root — or to write it into the run record
 * as the task's result. Both would be a SECOND delivery path racing DSH's own,
 * and the two would disagree eventually. This module reads the payload ONLY for
 * its identity (`id`) and its terminal fact (`stopReason`); it never reads
 * `lastAssistantMessage`, and there is a test that pins that.
 *
 * ---------------------------------------------------------------------------
 * WHAT IT DOES, AND THE THREE THINGS IT DELIBERATELY DOES NOT
 * ---------------------------------------------------------------------------
 *
 * On one `subagent/end` it does exactly two things:
 *
 *   1. RECONCILE the canonical work state for the child the event names, from
 *      evidence this package holds. See `reconcileTask` for why the event alone
 *      is not sufficient evidence of quiescence.
 *   2. WAKE capacity by calling `requestDrain`, so a freed slot is refilled
 *      without the root asking again.
 *
 * It does NOT:
 *
 *   - invent a retry task from a failure `stopReason`. §7.4: "Failure stop
 *     reason: report to root/model — do not semantically invent a retry task."
 *     Deciding that a failure warrants another attempt is a SEMANTIC judgement,
 *     which belongs to the root. A mechanical listener that retried would be
 *     building the second controller V5 §0 forbids.
 *   - release a slot on the event alone. §7.4: "release slot only when
 *     quiescence is established; preserve unknown/quarantine if not."
 *   - deliver any result content. See above.
 *
 * ---------------------------------------------------------------------------
 * WHY THE RECONCILE IS CONSERVATIVE, AND WHAT THAT COSTS
 * ---------------------------------------------------------------------------
 *
 * `subagent/end` proves the RUN ended. It does not by itself prove the child
 * Agent is disposed, and this package's slot rule is that a slot is released
 * only on evidence (see `states.ts` on `unknown` being "deliberately NOT an
 * error state that auto-retries"). The physical child slot is released by
 * `agent/disposed` in `capacity.ts:617`, which is a DIFFERENT and stronger
 * event; the run-task slot is this module's business.
 *
 * The cost of being conservative is named rather than hidden: a completion whose
 * canonical state cannot be established leaves the task in `unknown` holding its
 * slot, and the run then has an honest deficit rather than an over-admission.
 * That is the direction this project's whole capacity design already chooses
 * (see `tryReserveAdmission` on `releaseReservation: false`), so this file is
 * consistent with it rather than inventing a second policy.
 *
 * @module completion
 */
import type { Context } from '@deepseek-ai/cordis'
import type { SubagentRunEndInfo } from '@deepseek-ai/dsh-subagent'
import type { WorkService } from './host.ts'
import { canTransition, type AdmissionState } from './states.ts'

export interface CompletionObserverOptions {
  readonly service: WorkService
}

/**
 * Mount the completion observer on `ctx`.
 *
 * Registered through `ctx.on`, so the listener is owned by the caller's fiber
 * and removed with it — the same ownership rule `mountChildAdmissionGuard`
 * documents (`capacity.ts:586-587`). A listener that outlived its service would
 * wake a disposed run.
 *
 * @returns nothing; ownership is the caller's fiber.
 */
export function mountWorkCompletionObserver(ctx: Context, options: CompletionObserverOptions): void {
  const { service } = options
  ctx.on('subagent/end', (info: SubagentRunEndInfo) => {
    // Deliberately fire-and-forget: the event is a synchronous emit and a
    // listener that awaited would block the registry's own lifecycle for as long
    // as a launch takes. The rejection is swallowed WITH A REASON: a wake that
    // fails must not become an unhandled rejection (which terminates the process
    // under Node's default policy), and it must not be silently lost either, so
    // the failure is reported through the service's own refusal log.
    void handleCompletion(service, info).catch(error => {
      service.recordCompletionFailure({
        childId: String(info.id),
        stopReason: String(info.stopReason),
        message: error instanceof Error ? error.message : String(error),
      })
    })
  })
}

/**
 * The mechanical half, as a named function so it can be driven directly.
 *
 * Exported for the tests, which is honest: an arm that can only be reached
 * through a real provider is an arm that cannot isolate the reconcile decision
 * from the transport.
 */
export async function handleCompletion(
  service: WorkService,
  info: Pick<SubagentRunEndInfo, 'id' | 'stopReason'>,
): Promise<void> {
  const childId = String(info.id)
  const located = service.findTaskByChildId(childId)
  if (located !== undefined) {
    // The child is one of THIS package's: reconcile its task, then wake.
    //
    // The reconcile is a separate await from the wake on purpose. If the
    // reconcile throws (a storage fault), the wake still runs in the `finally`
    // below, because a slot that MIGHT be free is worth re-examining either way
    // and a failed reconcile must not silently stop the run from refilling.
    try {
      await reconcileCompletedTask(service, located.runId, located.taskId, info.stopReason)
    } finally {
      await service.requestDrain(located.runId)
    }
    return
  }
  // A child this package does not own: DSH can create children through paths
  // that are not WorkService admission (the preset is being narrowed by P6, and
  // this package must not assume the narrowing is complete). Waking every run
  // would be the wrong response — the event says nothing about whose slot freed
  // — so the correct action is NONE, and it is named here rather than being an
  // implicit fallthrough.
  return
}

/**
 * Move a task to the state a completion establishes, and release its slot only
 * when that state is one that releases.
 *
 * THE STATE CHOICE IS THE SUBSTANCE, and it is deliberately the WEAKER of the
 * two available readings:
 *
 *   - A clean stop (`'stop'`, `'max-turns'`, or any non-error terminal reason)
 *     establishes that the child FINISHED, not that its result was VERIFIED.
 *     The record's own vocabulary separates those: `settling` is "work appears
 *     done; artifacts not yet confirmed by an independent check", and
 *     `confirmed` is "the result is confirmed. Only this state is success"
 *     (`states.ts:28-31`). This module writes `settling` — never `confirmed` —
 *     because confirming is the acceptance runner's job and a completion
 *     listener that confirmed would make the child the oracle for its own work,
 *     which is the exact inversion the verification gate exists to prevent.
 *
 *   - An error stop reason does NOT establish that work finished, so the task
 *     goes to `unknown`: "The outcome cannot be established from local evidence"
 *     (`states.ts:36-41`). The slot stays held and a reconciliation must resolve
 *     it. §7.4's instruction to report the failure to the root and NOT to invent
 *     a retry is satisfied by this state plus the wake: the root sees a task in
 *     `unknown` and an honest deficit, and decides what it means.
 *
 * `settling` holds its slot (`SLOT_HOLDING_STATES`, `states.ts:56-64`). That is
 * correct and not an oversight: work that appears done may still change the
 * world, and the confirmation is what releases. So the REFILL this module
 * triggers is bounded by the same rule as everything else — the wake re-examines
 * the run, and the run's occupancy falls only when something confirms.
 */
async function reconcileCompletedTask(
  service: WorkService,
  runId: string,
  taskId: string,
  stopReason: string,
): Promise<void> {
  const record = service.getRun(runId)
  const task = record?.tasks[taskId]
  if (task === undefined) return
  const target: AdmissionState = establishesCompletion(stopReason) ? 'settling' : 'unknown'
  // `canTransition` rather than `assertTransition`: a completion can arrive for a
  // task the run has already moved on (a duplicate event, or a task cancelled
  // while the child was finishing). An illegal edge there is a REAL race rather
  // than a bug, and throwing would turn it into an unhandled rejection in a
  // listener. The event is a signal, not an authority.
  if (!canTransition(task.state, target)) return
  await service.transition({
    runId,
    taskId,
    to: target,
    ...target === 'unknown'
      ? { uncertainty: `child ended with stop reason ${JSON.stringify(stopReason)}` }
      : {},
  })
}

/**
 * Whether a terminal stop reason establishes that the child FINISHED its work.
 *
 * THE VOCABULARY IS DSH'S OWN, read from the seam rather than guessed
 * (`dsh-subagent/src/types.ts:252-266`, `SubagentStopReasonMap`): `completed`,
 * `aborted`, `error`, `max-tokens`, `refusal`. The type's own doc says a
 * backend may add variants and "consumers branch on the known cases and fall
 * through `default`", so the shape here is an allow-list of the ONE reason that
 * establishes completion, with everything else — including a variant this build
 * has never seen — falling through to "not established".
 *
 * WHY AN ALLOW-LIST AND NOT A FAILURE LIST. The first draft of this function
 * listed failures (`error`, `aborted`, `timeout`, `cancelled`, `interrupted`)
 * and treated everything else as success. Two of those five names DO NOT EXIST
 * in the real vocabulary, and the shape is wrong in the dangerous direction: a
 * future variant like `'partial'` would have been classified as a successful
 * completion by default. Naming the single success case inverts the default so
 * an unknown reason is never read as done.
 *
 * `max-tokens` is NOT completion, and it is the case most likely to be got
 * wrong: the child stopped because it ran out of room, and the seam's own doc
 * says "A non-`completed` reason means `output` may be partial"
 * (`types.ts:295`). Treating it as done would let a truncated result release a
 * slot as if the work had finished.
 *
 * `refusal` is likewise not completion. The child declined the task: the
 * outcome is established, but the WORK is not done, and deciding what a refusal
 * means is the root's judgement — §7.4's "do not semantically invent a retry
 * task" applies to exactly this case.
 */
function establishesCompletion(stopReason: string): boolean {
  switch (stopReason) {
    case 'completed':
      return true
    // `aborted`, `error`, `max-tokens`, `refusal`, and any variant a backend
    // adds later. None of them is evidence that the work finished.
    default:
      return false
  }
}
