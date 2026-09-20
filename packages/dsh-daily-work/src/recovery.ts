/**
 * Acting on a reconciliation decision: relaunching a proven-unlaunched task.
 *
 * WHY THIS FILE EXISTS, and what it does NOT do.
 *
 * `reconcileTask` can decide that a reserved task provably never created a
 * child (`reconcile.ts:92-99`) and return it to `prepared`. That decision is
 * necessary but not sufficient: something has to actually launch the task, and
 * `WorkService.drain` cannot. `drain` calls `admit`, and `admit` refuses a task
 * that still holds its slot (`host.ts`: `task "..." is already admitted as
 * prepared`) because `prepared` is a slot-holding state
 * (`states.ts:56-64`). So a reconciled `prepared` task is invisible to the
 * ordinary top-up path and would sit there forever while the run reports a
 * capacity deficit.
 *
 * That gap is exactly gate D03: "durable task+childId written, startContinuable
 * not yet called -> recovery launches the original childId's assignment exactly
 * once."
 *
 * This module is the missing half. It is deliberately NOT a second scheduler and
 * NOT a new state: it drives the EXISTING state machine through an EXISTING legal
 * transition and calls the EXISTING launch port.
 *
 * WHAT MAKES IT EXACTLY-ONCE, stated honestly.
 *
 * The claim is the state transition, not a lock. `transition` runs on the
 * domain's single per-domain write chain (`storage-domain/src/domain.ts:332-346`:
 * "Atomic read-modify-write on the domain's write chain: `fn` sees the value
 * current at its queue slot, so concurrent updates never interleave"), and
 * `prepared -> launching` is legal exactly once because the transition table has
 * no `launching -> launching` edge (`states.ts:81-94`). A second recovery
 * racing on the same task therefore loses at `assertTransition` rather than
 * launching a second child.
 *
 * What that does NOT give you: exactly-once EXTERNAL effects. A crash after the
 * claim and before the launch leaves `launching`, which is the D04 window, and
 * reconciliation resolves it to `unknown` -- never to a blind retry. The
 * guarantee here is narrower and is the one the plan asks for: a task that
 * provably never launched is launched once, under its ORIGINAL reserved id, and
 * an ambiguous outcome is never converted into a second launch.
 */
import type { LaunchPort } from './host.ts'
import type { WorkService } from './host.ts'
import type { TaskRecord } from './record.ts'

/** What a relaunch attempt did, and why. */
export interface RelaunchOutcome {
  readonly taskId: string
  /** The id that was launched, or the reserved id that was refused. */
  readonly childId: string
  readonly launched: boolean
  /** Present when nothing was launched, in words a reader can check. */
  readonly reason?: string
}

/**
 * Relaunch one task that reconciliation returned to `prepared`.
 *
 * Preconditions, all checked rather than assumed:
 *   - the task exists in the run
 *   - its state is exactly `prepared`. Any other state means either a launch is
 *     already in flight (`launching`), the child was admitted (`accepted`), or
 *     the outcome is unsettled (`unknown`) -- none of which is a licence to
 *     launch, and the last of which is the double-launch this refuses.
 *   - it still carries a reserved `childId`. Without one there is no identity to
 *     relaunch under, and minting a fresh one would break the reconciliation
 *     relation (`record.ts:46-53`).
 *
 * The prompt and cost are taken from the CALLER's launch request, because the
 * record deliberately stores a digest of the assignment rather than its body
 * (`record.ts:56-57`: "Digest of the assignment as submitted. A changed digest
 * is a new task."). The caller is responsible for supplying the same
 * assignment; this function asserts the digest matches what was admitted, so a
 * changed assignment is refused instead of silently launched as if it were the
 * original.
 *
 * @param input.service - the open work service owning the run.
 * @param input.port - the launch port; the only thing that knows how to start a child.
 * @param input.runId - the run the task belongs to.
 * @param input.taskId - the task to relaunch.
 * @param input.assignmentDigest - the assignment digest, which must equal the admitted one.
 * @param input.signal - caller cancellation, observed before the launch.
 * @returns what happened, including the refusal reason when nothing launched.
 */
export async function relaunchPrepared(input: {
  readonly service: WorkService
  readonly port: LaunchPort
  readonly runId: string
  readonly taskId: string
  readonly assignmentDigest: string
  readonly signal: AbortSignal
}): Promise<RelaunchOutcome> {
  const { service, port, runId, taskId, assignmentDigest, signal } = input

  const record = service.getRun(runId)
  if (record === undefined) {
    return { taskId, childId: '', launched: false, reason: `run "${runId}" does not exist` }
  }
  const task: TaskRecord | undefined = record.tasks[taskId]
  if (task === undefined) {
    return { taskId, childId: '', launched: false, reason: `task "${taskId}" is not in run "${runId}"` }
  }
  if (task.state !== 'prepared') {
    // The refusal that matters most: a task in `launching`, `accepted` or
    // `unknown` may already have a child. Launching again from here is the
    // duplicate the whole reconciliation design exists to prevent.
    return {
      taskId,
      childId: task.childId ?? '',
      launched: false,
      reason: `task "${taskId}" is ${task.state}; only a task proven never to have launched (prepared) may be relaunched`,
    }
  }
  const childId = task.childId
  if (childId === undefined || childId === '') {
    return {
      taskId,
      childId: '',
      launched: false,
      reason: `task "${taskId}" has no reserved childId; a relaunch would have to invent an identity, which the record's reconciliation relation forbids`,
    }
  }
  if (task.assignmentDigest !== assignmentDigest) {
    return {
      taskId,
      childId,
      launched: false,
      reason: `the supplied assignment digest does not match the admitted one for "${taskId}"; a changed assignment is a new task, not a relaunch`,
    }
  }
  if (record.phase !== 'open') {
    return {
      taskId,
      childId,
      launched: false,
      reason: `run "${runId}" is ${record.phase}; a relaunch is new admission and a non-open run refuses it`,
    }
  }

  signal.throwIfAborted()

  // THE CLAIM. `prepared -> launching` is legal exactly once; a concurrent
  // recovery loses here rather than launching a second child.
  try {
    await service.transition({ runId, taskId, to: 'launching' })
  } catch (error) {
    return {
      taskId,
      childId,
      launched: false,
      reason: `could not claim the task for relaunch: ${error instanceof Error ? error.message : String(error)}`,
    }
  }

  try {
    // The reserved id is passed through, so a child that somehow already exists
    // surfaces as DUPLICATE_CHILD at the provider boundary rather than being
    // silently duplicated under a fresh identity.
    await port.launch(
      { taskId, childId, prompt: assignmentDigest, reservedCost: 0 },
      signal,
    )
  } catch (error) {
    // The launch failed and we cannot tell whether the child was created, so
    // this is `unknown` with the reservation held -- never a clean failure and
    // never a retry.
    await service.transition({
      runId,
      taskId,
      to: 'unknown',
      uncertainty: `relaunch failed: ${error instanceof Error ? error.message : String(error)}`,
      releaseReservation: false,
    })
    return {
      taskId,
      childId,
      launched: false,
      reason: `relaunch failed and the outcome is unknown: ${error instanceof Error ? error.message : String(error)}`,
    }
  }

  // Admission, not execution: the child's inbox accepted the prompt. This is
  // the same edge `drain` records after its own launch.
  await service.transition({ runId, taskId, to: 'accepted' })
  return { taskId, childId, launched: true }
}

/*
 * WHAT IS DELIBERATELY NOT HERE, and why — the F8 / REC-09 / REC-10 decision.
 *
 * This module used to also export a settlement guard: `WorkerSettlement`,
 * `applyWorkerSettlement`, and a `RefusalLedger` over a separate
 * `dsh_daily_work_refusals` domain. The guard refused a settlement whose run
 * `epoch` was not the record's current epoch, leaving the task unmoved and its
 * reservation held, and retained the refusal as diagnostic evidence. It was
 * correct, it was tested, and it was **deleted rather than wired**, because the
 * topology measurement showed it guards a path that does not exist.
 *
 * THE MEASUREMENT. A stale-generation settlement requires a settlement PRODUCER
 * — something that receives a child's completion and offers it to this package.
 * No such producer exists:
 *
 *   - `WorkService.transition` (host.ts:884) is the only method that can write a
 *     task's terminal state, its reservation release and its tombstone, and no
 *     production call site targets `settling`, `confirmed`, `cancelled`,
 *     `executing` or `cancel_requested`. The only call sites that do are this
 *     file's deleted guard and `durability-runner.ts`, a hand-run CLI in no
 *     production import graph.
 *   - the launch port resolves at the ADMISSION edge and is never called back on
 *     completion (launch-port.ts:9-20, quoting the pinned DSH contract).
 *   - no completion listener, inbox callback, outbox consumer, IPC channel,
 *     socket or second process exists in this package's non-test source; the two
 *     `ctx.on` registrations in capacity.ts:593,617 touch only the capacity
 *     ledger, never task state.
 *   - nothing ever bumped the epoch: `initialRunRecord` wrote the literal 1 and
 *     no other code wrote or read it. A real SIGKILL plus a real re-adoption left
 *     it at 1, so even a wired guard would have compared 1 to 1 forever.
 *
 * So the guard was not merely unreachable — the input it refuses cannot be
 * constructed. Wiring it would have meant INVENTING a cross-process settlement
 * producer, which the audit forbids ("Do not create a cross-process worker solely
 * to make REC-09/REC-10 pass"). The honest resolution was the other direction:
 * delete the guard, delete the run record's `epoch` field (it had no real
 * consumer), and have v2 not claim the guarantee.
 *
 * WHAT THIS REMOVAL IS AND IS NOT. It removes a CLAIM that was never true — an
 * epoch that looked like a guard only because nothing checked it — and it removes
 * no mechanism the product relied on. It is the same shape as G-SEAM-50, where
 * CMP-06's sandbox-policy protection is unreachability rather than immutability.
 * The v1 cases REC-09 and REC-10 stay FAIL historically; nothing here makes them
 * pass.
 *
 * `relaunchPrepared` above is a DIFFERENT claim and is deliberately kept: gate
 * D03 asks that a task proven never to have launched is relaunched exactly once
 * under its ORIGINAL reserved childId. That is a statement about recovery
 * deciding, not about generation fencing, and it is not this slice's to delete.
 */
