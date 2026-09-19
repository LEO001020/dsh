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
import type { Context } from '@deepseek-ai/cordis'
import { defineDomain, domainTable, type Domain } from '@deepseek-ai/dsh-storage-domain'
import { z } from 'zod'
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

/** A settlement submitted by a worker, with the generation that produced it. */
export interface WorkerSettlement {
  /** The run the worker believes it is settling. */
  readonly runId: string
  /**
   * The run epoch the worker was admitted under. A worker from a previous host
   * generation carries the epoch it saw, which is what makes it identifiable.
   */
  readonly epoch: number
  readonly taskId: string
  /**
   * The child identity the worker claims. Checked against the record's reserved
   * `childId`, because a settlement attributed to the wrong child is not a
   * settlement.
   */
  readonly childId: string
  readonly to: 'settling' | 'confirmed' | 'cancelled'
  /** Where the evidence for this settlement lives, if the worker supplies one. */
  readonly evidenceRef?: { readonly kind: string; readonly id: string; readonly label?: string }
}

/** What happened to a submitted settlement. */
export interface SettlementOutcome {
  readonly accepted: boolean
  /** Present when the settlement was refused, in words a reader can check. */
  readonly reason?: string
  /** Where the refusal was recorded, when one was. */
  readonly refusalRef?: string
}

/**
 * Apply a worker's settlement only if its epoch is the CURRENT one.
 *
 * WHY THIS EXISTS. `record.ts:383-388` documents the run epoch as "bumped when a
 * run is re-adopted by a new host generation. A callback carrying a stale epoch
 * must be rejected rather than allowed to write authoritative state." Nothing
 * enforced that: `initialRunRecord` sets `epoch` to 1 and no other code reads or
 * writes the field, so a stale worker's settlement could be applied to a run it
 * no longer belongs to. This function is the missing enforcement.
 *
 * The two halves of gate D10, both required:
 *
 *   REFUSE the authoritative write. A settlement whose epoch is not the record's
 *   current epoch does not move the task and does not release its reservation.
 *   The refusal is total: a stale worker cannot confirm, cannot settle and
 *   cannot cancel.
 *
 *   RETAIN the diagnostic evidence. Refusing silently would destroy the only
 *   record that a stale worker exists, which is exactly the fact an operator
 *   needs. The refusal goes to a SEPARATE diagnostic store (see
 *   {@link RefusalLedger}) rather than into the run record, so diagnostic
 *   evidence can never be mistaken for authority. Nothing in the decision path
 *   reads it.
 *
 * A childId that does not match the record's reserved one is refused the same
 * way, for the same reason: attributing a result to a task the worker never ran
 * would corrupt the reconciliation relation.
 *
 * @param input.service - the open work service owning the run.
 * @param input.ledger - where refused settlements are recorded as evidence.
 * @param input.settlement - what the worker submitted.
 * @returns whether the settlement was applied, and why not when it was refused.
 */
export async function applyWorkerSettlement(input: {
  readonly service: WorkService
  readonly ledger: RefusalLedger
  readonly settlement: WorkerSettlement
}): Promise<SettlementOutcome> {
  const { service, ledger, settlement } = input
  const record = service.getRun(settlement.runId)
  if (record === undefined) {
    const reason = `run "${settlement.runId}" does not exist`
    const refusalRef = await ledger.record({ ...settlement, reason })
    return { accepted: false, reason, refusalRef }
  }

  /** Record the refusal as evidence, without letting it become authority. */
  const refuse = async (reason: string): Promise<SettlementOutcome> => {
    const refusalRef = await ledger.record({ ...settlement, reason })
    return { accepted: false, reason, refusalRef }
  }

  // THE GUARD. A stale generation's settlement is not authority.
  if (settlement.epoch !== record.epoch) {
    return refuse(
      `settlement carries epoch ${settlement.epoch} but run "${settlement.runId}" is at epoch ${record.epoch}; `
      + 'a stale generation cannot write authoritative state',
    )
  }

  const task = record.tasks[settlement.taskId]
  if (task === undefined) {
    return refuse(`task "${settlement.taskId}" is not in run "${settlement.runId}"`)
  }

  // The identity check: the reserved id is the reconciliation relation, so a
  // settlement for a different child is refused rather than attributed.
  if (task.childId !== settlement.childId) {
    return refuse(
      `settlement names child "${settlement.childId}" but task "${settlement.taskId}" reserved `
      + `"${task.childId ?? ''}"; a result is not attributable across identities`,
    )
  }

  // The epoch and the identity agree, so this settlement IS current and the
  // ordinary state machine decides whether the transition is legal.
  await service.transition({
    runId: settlement.runId,
    taskId: settlement.taskId,
    to: settlement.to,
  })
  return { accepted: true }
}

/**
 * The diagnostic store for REFUSED settlements.
 *
 * WHY A SEPARATE DOMAIN, and not a field on the run record. The two facts here
 * have opposite authority, and putting them in one record invites exactly the
 * confusion the gate is about:
 *
 *   the run record is AUTHORITATIVE -- it decides what the system believes and
 *   what budget is held;
 *   a refusal is DIAGNOSTIC -- it says a stale worker tried, and must never
 *   influence a decision.
 *
 * A separate domain also keeps the write paths apart: recording a refusal can
 * never take the run record's write chain, so it cannot interleave with an
 * admission and cannot be mistaken for one. The domain name is distinct from the
 * run domain, so the storage facility opens them independently.
 */
export const REFUSAL_DOMAIN_NAME = 'dsh_daily_work_refusals'

/** One retained refusal. Append-only in practice; the key is unique per refusal. */
export const refusalRecordSchema = z.object({
  /** Unique key for this refusal. */
  key: z.string().min(1),
  runId: z.string().min(1),
  /** The epoch the worker presented. */
  epoch: z.number().int(),
  taskId: z.string().min(1),
  childId: z.string().min(1),
  to: z.string().min(1),
  /** Why it was refused, in the words the caller can check against the record. */
  reason: z.string().min(1),
  /** When it was refused. */
  recordedAt: z.string(),
})

export type RefusalRecord = z.infer<typeof refusalRecordSchema>

export const refusalDomainSpec = defineDomain({
  name: REFUSAL_DOMAIN_NAME,
  version: 1,
  tables: {
    refusals: domainTable<string, RefusalRecord>(refusalRecordSchema),
  },
})

/**
 * A ledger of refused settlements, over the real storage domain.
 *
 * The handle is owned by the caller and released by {@link close}, exactly like
 * the work service's own domain handle.
 */
export class RefusalLedger {
  private domain: Domain<typeof refusalDomainSpec> | undefined
  private readonly ctx: Context

  constructor(ctx: Context) {
    this.ctx = ctx
  }

  /** Open the ledger's domain. A second open is a caller bug and is refused. */
  async open(): Promise<void> {
    if (this.domain !== undefined) throw new Error('refusalLedger: domain is already open')
    const facility = this.ctx.get('storageDomain')
    if (facility === undefined) {
      throw new Error('refusalLedger: the storageDomain service is not mounted')
    }
    this.domain = await facility.open(refusalDomainSpec)
  }

  /** Close the ledger's domain. Idempotent. */
  async close(): Promise<void> {
    const domain = this.domain
    this.domain = undefined
    if (domain !== undefined) await domain.close()
  }

  /**
   * Durably record one refusal.
   *
   * The key is derived from the settlement's identity plus a timestamp, so two
   * refusals of the same claim are both kept: the second attempt is itself a
   * fact worth having.
   *
   * @returns the key the refusal was stored under.
   */
  async record(input: WorkerSettlement & { readonly reason: string }): Promise<string> {
    const domain = this.domain
    if (domain === undefined) throw new Error('refusalLedger: domain is not open')
    const recordedAt = new Date().toISOString()
    // Colons are not path-safe in the per-record layout; the domain name is
    // fixed but keys are ours, so they stay within the safe alphabet.
    const key = `${input.runId}_${input.taskId}_${String(input.epoch)}_${String(Date.now())}`
    await domain.table('refusals').put(key, {
      key,
      runId: input.runId,
      epoch: input.epoch,
      taskId: input.taskId,
      childId: input.childId,
      to: input.to,
      reason: input.reason,
      recordedAt,
    })
    return key
  }

  /** Every retained refusal, in no promised order. For inspection and tests. */
  entries(): RefusalRecord[] {
    const domain = this.domain
    if (domain === undefined) throw new Error('refusalLedger: domain is not open')
    return [...domain.table('refusals').entries()].map(([, value]) => value)
  }

  /** One retained refusal, or `undefined`. */
  get(key: string): RefusalRecord | undefined {
    const domain = this.domain
    if (domain === undefined) throw new Error('refusalLedger: domain is not open')
    return domain.table('refusals').get(key)
  }
}
