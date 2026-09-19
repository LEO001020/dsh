/**
 * External effects: the adapter discipline a checkpoint cannot provide.
 *
 * WHAT A NATIVE CHECKPOINT DOES AND DOES NOT GIVE YOU
 *
 * A checkpoint can persist a dispatch INTENT. It is not an exactly-once external
 * effect. If the process dies after the remote committed and before the reply
 * landed, the world has changed and the record does not know it. Nothing in this
 * file changes that. What it changes is what the system is allowed to CLAIM in
 * that window, and which resends are reachable at all.
 *
 * The rule encoded here, quoted from `docs/SECURITY.md`:
 *
 *   "First version: no unadapted irreversible remote operation runs
 *    automatically. Necessary sends/deploys go through an explicitly authorized,
 *    task-specific adapter that has: a stable operationId plus a parameter digest;
 *    recorded intent; a remote idempotency key or a queryable result; lost reply
 *    -> unknown, never a retry with a changed tool callId. Without a real query
 *    or idempotency support the honest answer is unknown. We do not build a
 *    universal effect WAL and claim the world is solved."
 *
 * So this is NOT a WAL and NOT a transaction manager. There is no global log, no
 * two-phase commit, no cross-service coordination, and no exactly-once claim. It
 * is a per-operation record whose only powers are: make the difference between
 * confirmed / unknown / not_started / conflict durable, and make an unprovable
 * resend unreachable.
 *
 * The four refusals this file is built around:
 *
 *   1. The operation identity is never a transport call id. A retry that mints a
 *      new `toolCallId` for the same logical operation must land on the SAME
 *      record; if it did not, every retry would be a fresh effect, which is the
 *      exact failure this module exists to prevent (E07).
 *   2. The identity is not the payload digest either. If the payload were folded
 *      into the operationId, a changed target would look like a new operation and
 *      be sent again, silently. The payload digest is recorded SEPARATELY so a
 *      change is a conflict, not a new operation (E08).
 *   3. `unknown` is never converted into `not_started`. Absence of evidence is not
 *      evidence of absence, and a query that cannot answer is not an answer.
 *   4. A cancellation is never reported as an undo (E11), and a program is never
 *      replayed as a unit (E10).
 *
 * WHO ENFORCES WHAT
 *
 * This module decides what may be SENT and what may be CLAIMED. It is not an
 * enforcement boundary. Arbitrary shell text cannot be classified from its text
 * (E09), so the enforcement for shell is the sandbox/permission boundary and the
 * process identity, not `classifyShellCommand`. That function exists to refuse to
 * authorize, and to make its own blindness visible, never to grant.
 */
import { createHash } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { defineDomain, domainTable, type Domain } from '@deepseek-ai/dsh-storage-domain'
import { z } from 'zod'

/** The domain name. Doubles as the backend unit name, so it must match UNIT_NAME_RE. */
export const EFFECT_DOMAIN_NAME = 'dsh_daily_effects'

/**
 * The effect-ledger schema version.
 *
 * Same rule as the run record: a change requires an offline conversion or a new
 * namespace with an explicit cutover. Reading an older shape as if it were
 * current would silently reinterpret an authorization, which is worse here than
 * for a run record because this table holds acks for things that already happened.
 */
export const EFFECT_SCHEMA_VERSION = 1

/**
 * The limits of this design, stated where a reader of the code will find them.
 *
 * Every entry is a thing this module does NOT do. They are not TODOs; several of
 * them are permanent properties of any system that talks to a remote it does not
 * control.
 */
export const EFFECT_LIMITS: readonly string[] = Object.freeze([
  'single writer: the ledger serializes concurrent calls inside ONE process. Two processes opening the same domain over the same medium are outside the guarantee, exactly as they are for the run record.',
  'the remote is trusted to answer a query truthfully. A remote that reports not_started for an operation it actually committed defeats this design; the query is evidence, not proof.',
  'no exactly-once claim. The claim is narrower: one transport invocation per operationId per recorded state, and unknown rather than a second send when the state cannot be established.',
  'a crash between the `sent` write and the transport call leaves a record that says the effect may have happened. It is reconciled, never resent automatically.',
  'operationId collision resistance rests on sha256 over the identity tuple, not on a distributed id allocator.',
])

// ---------------------------------------------------------------------------
// Identity: the operationId is a property of the LOGICAL operation
// ---------------------------------------------------------------------------

/**
 * A parameter value this module can canonicalize.
 *
 * Deliberately a closed set. A value outside it (a Date, a bigint, a function, a
 * class instance) is refused rather than stringified: two different objects that
 * both stringify to `[object Object]` would digest identically, which would make
 * two different effects look like one.
 */
export type EffectParameterValue =
  | string
  | number
  | boolean
  | null
  | readonly EffectParameterValue[]
  | { readonly [key: string]: EffectParameterValue }

/** The parameters of one effect, as a plain JSON-shaped record. */
export type EffectParameters = Readonly<Record<string, EffectParameterValue>>

/**
 * Canonical JSON for digesting.
 *
 * Object keys are sorted recursively and no whitespace is emitted, so two callers
 * that build the same parameters in a different key order produce the SAME digest.
 * That is load-bearing for E07: a digest that depended on key order would make an
 * identical retry look like a different operation and send a second effect.
 *
 * @param value - the value to canonicalize.
 * @returns the canonical JSON text.
 * @throws when the value is not in the closed canonicalizable set, or is a
 * non-finite number that JSON would silently turn into `null`.
 */
export function canonicalJson(value: EffectParameterValue): string {
  if (value === null) return 'null'
  switch (typeof value) {
    case 'string':
      return JSON.stringify(value)
    case 'boolean':
      return value ? 'true' : 'false'
    case 'number':
      if (!Number.isFinite(value)) {
        throw new Error(`effects: ${String(value)} cannot be canonicalized; JSON would turn it into null and change the digest`)
      }
      return JSON.stringify(value)
    case 'object': {
      if (Array.isArray(value)) return `[${value.map(item => canonicalJson(item)).join(',')}]`
      // A class instance (a Date, a Map, a domain object) has its own semantics and
      // would otherwise canonicalize to `{}` from its enumerable own keys. Two
      // different instances would then digest identically, which is exactly the
      // collision this refusal prevents.
      const prototype: unknown = Object.getPrototypeOf(value)
      if (prototype !== Object.prototype && prototype !== null) {
        throw new Error(
          `effects: a parameter of type ${(value as object).constructor?.name ?? 'unknown'} is not a plain object; `
          + 'refusing to digest a value whose canonical form would not describe it',
        )
      }
      const record = value as { readonly [key: string]: EffectParameterValue }
      const keys = Object.keys(record).sort()
      return `{${keys.map(key => `${JSON.stringify(key)}:${canonicalJson(record[key] as EffectParameterValue)}`).join(',')}}`
    }
    default:
      throw new Error(`effects: a parameter of type ${typeof value} cannot be canonicalized; refusing to digest an ambiguous value`)
  }
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/**
 * The digest of an effect's payload.
 *
 * This is the value compared to detect E08. It is NOT part of the operationId;
 * see {@link identify}.
 *
 * @param parameters - the effect parameters.
 * @returns a hex sha256 over the canonical JSON.
 */
export function parameterDigestOf(parameters: EffectParameters): string {
  return sha256(canonicalJson(parameters))
}

/** One requested effect, as the caller describes it. */
export interface EffectIntent {
  /** The adapter kind, e.g. 'smtp-send'. Must match the adapter's own `kind`. */
  readonly kind: string
  /**
   * The caller's stable name for this LOGICAL operation, e.g.
   * `invoice-2026-09-send`. A retry of the same operation reuses it. It must not
   * contain an attempt counter or a random id: doing so is how a caller
   * accidentally converts one operation into several effects.
   */
  readonly logicalKey: string
  /** The payload. Changing it under the same operationId is a conflict (E08). */
  readonly parameters: EffectParameters
  /**
   * The transport's per-attempt identifier, recorded for the audit trail only.
   *
   * It is NEVER part of the identity. A caller that retries with a new callId
   * must land on the same record; that is precisely the E07 case.
   */
  readonly toolCallId?: string
}

/** The stable identity of one logical operation, plus its payload digest. */
export interface EffectIdentity {
  /** Stable across retries of the same logical operation. */
  readonly operationId: string
  /** Covers the payload; a change here under the same operationId is a conflict. */
  readonly parameterDigest: string
}

/**
 * Derive the identity of an effect.
 *
 * The operationId is a digest of the IDENTITY TUPLE `(kind, logicalKey)` and
 * nothing else. Two consequences, both deliberate:
 *
 *   - A changed payload keeps the same operationId. That is what makes E08 a
 *     detectable conflict. Folding the payload into the id would instead produce
 *     a brand-new operation for a changed target, which would be sent, silently.
 *   - A changed `toolCallId` keeps the same operationId. Folding the callId in
 *     would make every retry a new effect, which is the failure E07 tests for.
 *
 * @param intent - the requested effect.
 * @returns the stable operationId and the payload digest.
 * @throws when the kind or the logical key is empty; an unnamed operation cannot
 * be reconciled, and inventing a name for it would be worse than refusing.
 */
export function identify(intent: EffectIntent): EffectIdentity {
  if (intent.kind.length === 0) throw new Error('effects: an intent with no kind cannot be identified')
  if (intent.logicalKey.length === 0) {
    throw new Error('effects: an intent with no logicalKey cannot be identified; a per-attempt id is not an identity')
  }
  const identityDigest = sha256(canonicalJson([intent.kind, intent.logicalKey]))
  return {
    operationId: `eff_${identityDigest.slice(0, 32)}`,
    parameterDigest: parameterDigestOf(intent.parameters),
  }
}

// ---------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------

/** What a remote can actually do. Both false means "not runnable automatically". */
export interface EffectCapabilities {
  /**
   * The remote accepts a caller-supplied idempotency key, so a repeated send with
   * the same key cannot produce a second effect.
   */
  readonly idempotencyKey: boolean
  /** The remote can answer "what is the state of operation X" after the fact. */
  readonly queryable: boolean
}

/**
 * What a `perform` call may report.
 *
 * Note what an adapter CANNOT report: `conflict`. A conflict is a statement about
 * our own ledger, and letting an adapter raise one would let a remote rewrite the
 * authorization record. Note also that `confirmed` requires a `resultRef`: a
 * confirmation with nothing to point at is a claim, not evidence.
 */
export type EffectPerformResult =
  | { readonly status: 'confirmed'; readonly resultRef: string; readonly remoteKey?: string; readonly detail?: string }
  | { readonly status: 'not_started'; readonly detail: string }
  | { readonly status: 'unknown'; readonly detail: string }

/** What a reconciliation query may report. `unsupported` is not `not_started`. */
export type EffectQueryResult =
  | { readonly status: 'confirmed'; readonly resultRef: string; readonly remoteKey?: string; readonly detail?: string }
  | { readonly status: 'not_started'; readonly detail: string }
  | { readonly status: 'unknown'; readonly detail: string }
  | { readonly status: 'unsupported'; readonly detail: string }

/**
 * One explicitly authorized, task-specific adapter.
 *
 * An adapter is written per operation family by someone who knows that remote's
 * idempotency and query semantics. There is deliberately no generic HTTP adapter
 * here: a generic one could only guess, and a guess about idempotency is the thing
 * that turns a lost reply into a duplicate payment.
 */
export interface EffectAdapter {
  /** Must equal the `kind` of every intent handed to it. */
  readonly kind: string
  readonly capabilities: EffectCapabilities
  /**
   * Invoke the remote once.
   *
   * A throw means "the reply is lost", not "nothing happened". The ledger records
   * `unknown` for a throw; it never retries.
   */
  perform(intent: EffectIntent, identity: EffectIdentity): Promise<EffectPerformResult>
  /**
   * Ask the remote what it knows about an operationId.
   *
   * `unsupported` is a first-class answer: an adapter without query support must
   * say so rather than return a guess shaped like a definite state.
   */
  query(operationId: string, identity: EffectIdentity): Promise<EffectQueryResult>
}

// ---------------------------------------------------------------------------
// The ledger record
// ---------------------------------------------------------------------------

/**
 * The stored states of one operation.
 *
 * `conflict` is deliberately absent: a refused attempt must not overwrite the ack
 * it was refused against. A conflict is reported to the caller and appended to
 * `refusedDigests` as an audit entry; the authorization fields never move.
 */
export const EFFECT_RECORD_STATUSES = [
  /** The intent is durable; the transport has provably NOT been invoked. */
  'intent_recorded',
  /** The transport has been (or may have been) invoked; no outcome recorded yet. */
  'sent',
  /** The remote confirmed the effect. */
  'confirmed',
  /** The remote cannot say, or the reply was lost. A resting state, not a retry trigger. */
  'unknown',
  /** The remote positively reported that the operation never started. */
  'not_started',
] as const
export type EffectRecordStatus = (typeof EFFECT_RECORD_STATUSES)[number]

/** The four answers this module is allowed to give. */
export type EffectOutcome = 'confirmed' | 'unknown' | 'not_started' | 'conflict'

/** Audit trail entries kept per record. Bounded: this table must not grow without limit. */
const MAX_AUDIT_ENTRIES = 8

export const effectRecordSchema = z.object({
  operationId: z.string().min(1),
  kind: z.string().min(1),
  logicalKey: z.string().min(1),
  /** Digest of the payload. The conflict check. */
  parameterDigest: z.string().min(1),
  /**
   * The canonical JSON that was digested, stored as the exact bytes hashed.
   *
   * Stored as text rather than as a nested object so `sha256(parameters)` is
   * always the recorded digest. A re-encoded object could round-trip through a
   * backend differently and quietly stop matching its own digest.
   */
  parameters: z.string(),
  status: z.enum(EFFECT_RECORD_STATUSES),
  /** Transport invocations recorded for this operation. 0 means provably never invoked. */
  attempts: z.number().int().min(0),
  /** The remote's own idempotency key or result locator, when it returned one. */
  remoteKey: z.string().optional(),
  /** A locator for the effect's result. Present only on `confirmed`. */
  resultRef: z.string().optional(),
  detail: z.string(),
  /** Transport call ids seen for this operation. Audit only; never part of the identity. */
  toolCallIds: z.array(z.string()),
  /** Payload digests refused as conflicts. Audit only; proves the refusal happened. */
  refusedDigests: z.array(z.string()),
  intentRecordedAt: z.string(),
  updatedAt: z.string(),
})
export type EffectRecord = z.infer<typeof effectRecordSchema>

export const effectDomainSpec = defineDomain({
  name: EFFECT_DOMAIN_NAME,
  version: EFFECT_SCHEMA_VERSION,
  tables: {
    operations: domainTable<string, EffectRecord>(effectRecordSchema),
  },
})

// ---------------------------------------------------------------------------
// The send decision, as a pure function so the whole table is auditable
// ---------------------------------------------------------------------------

/**
 * Whether a transport invocation is reachable from a given recorded state.
 *
 * This is the single rule that makes "no automatic replay" checkable instead of
 * aspirational, so it is a pure function with its own test over the whole table.
 *
 * Sending is licensed by exactly two states, and both are proofs about OUR OWN
 * action, established by write ordering rather than by trusting anyone:
 *
 *   - no record: nothing was ever sent for this operationId.
 *   - `intent_recorded`: the `sent` marker is written BEFORE the transport call,
 *     so a record still at `intent_recorded` proves the call was never made. This
 *     is the crash-recovery path, and it is why the marker exists at all.
 *
 * Everything else is reconciled, never resent. `not_started` is included in that:
 * even a positive remote statement that nothing happened does not license an
 * automatic resend here, because a resend is a new authorization decision. It is
 * taken by naming a new operation, not by this call quietly sending again.
 *
 * @param status - the recorded status, or `'absent'` when no record exists.
 * @returns whether a send is reachable, and why.
 */
export function sendDecision(status: EffectRecordStatus | 'absent'): { readonly send: boolean; readonly reason: string } {
  switch (status) {
    case 'absent':
      return { send: true, reason: 'no intent is recorded for this operationId; the intent is written before the transport is invoked' }
    case 'intent_recorded':
      return { send: true, reason: 'the sent marker is written before the transport call, so its absence proves the call was never made; this is crash recovery, not a replay' }
    case 'sent':
      return { send: false, reason: 'the transport was invoked and no outcome is recorded; unknown is a resting state and is not a licence to send again' }
    case 'unknown':
      return { send: false, reason: 'the outcome is unknown; a resend would be a guess about whether the first one landed' }
    case 'confirmed':
      return { send: false, reason: 'the effect is already confirmed; a resend would duplicate it' }
    case 'not_started':
      return { send: false, reason: 'the remote reports the operation never started, but resending is a new authorization decision and this call does not make it' }
  }
}

// ---------------------------------------------------------------------------
// The ledger
// ---------------------------------------------------------------------------

/** The result of one perform/reconcile call. */
export interface EffectAttempt {
  readonly operationId: string
  readonly parameterDigest: string
  readonly outcome: EffectOutcome
  /** True only when THIS call invoked the transport. False means it reconciled. */
  readonly performed: boolean
  readonly resultRef: string | undefined
  readonly remoteKey: string | undefined
  /** True when a remote query was issued and its answer is the basis of the outcome. */
  readonly queried: boolean
  /** On a conflict: the digest the ledger already holds. */
  readonly heldParameterDigest: string | undefined
  readonly reason: string
}

/**
 * The durable record of intents and outcomes.
 *
 * The write order is the whole mechanism, and it is three writes per effect:
 *
 *   1. `intent_recorded`  - the intent is durable BEFORE the transport is touched
 *   2. `sent`             - written BEFORE the call, so a crash cannot look like
 *                           "never sent"
 *   3. the outcome        - confirmed / not_started / unknown
 *
 * A crash after (1) is provably harmless. A crash after (2) is `unknown` forever
 * until a query resolves it. There is no fourth write that fixes that, and this
 * module does not pretend otherwise.
 */
export class EffectLedger {
  private readonly ctx: Context
  private domain: Domain<typeof effectDomainSpec> | undefined
  private disposed = false
  /**
   * Per-operation serialization.
   *
   * The storage domain gives atomicity per record but not compare-and-set, so
   * check-then-write on a missing key is not atomic by itself. Two concurrent
   * performs for one operationId would otherwise both observe "absent" and both
   * send. This chain closes that window inside one process; see EFFECT_LIMITS for
   * what it does not close.
   */
  private readonly chains = new Map<string, Promise<void>>()

  constructor(ctx: Context) {
    this.ctx = ctx
  }

  /**
   * Open the domain.
   *
   * Called explicitly by the owner inside its own effect, so the handle's lifetime
   * belongs to that effect rather than to this constructor. Opening twice is a
   * caller bug and the facility rejects it; surfacing that is better than hiding it.
   */
  async open(): Promise<void> {
    if (this.domain !== undefined) throw new Error('effects: ledger is already open')
    const facility = this.ctx.get('storageDomain')
    if (facility === undefined) {
      throw new Error('effects: the storageDomain service is not mounted; cannot persist effect records')
    }
    this.domain = await facility.open(effectDomainSpec)
  }

  /** Close the domain. Refuses new writes first, then releases the handle. */
  async close(): Promise<void> {
    this.disposed = true
    const domain = this.domain
    this.domain = undefined
    if (domain !== undefined) await domain.close()
  }

  private table() {
    const domain = this.domain
    if (domain === undefined) throw new Error('effects: ledger is not open')
    return domain.table('operations')
  }

  /** Read one operation. Returns the stored object; callers must treat it as immutable. */
  get(operationId: string): EffectRecord | undefined {
    this.assertOpen()
    return this.table().get(operationId)
  }

  /** Every operationId this ledger holds, sorted so a report is diffable. */
  listOperationIds(): string[] {
    this.assertOpen()
    return [...this.table().keys()].sort()
  }

  /**
   * Write the intent without invoking the transport.
   *
   * Exposed because recording intent is a separate, useful step: a dispatcher may
   * want the intent durable before it decides whether to send at all, and the
   * crash-before-send state is only reachable this way. `perform` writes it itself.
   *
   * @param intent - the requested effect.
   * @returns the stored record.
   */
  async recordIntent(intent: EffectIntent): Promise<EffectRecord> {
    this.assertOpen()
    const identity = identify(intent)
    return this.serialized(identity.operationId, async () => {
      const held = this.table().get(identity.operationId)
      if (held !== undefined) {
        if (held.parameterDigest !== identity.parameterDigest) {
          throw new Error(
            `effects: operation "${identity.operationId}" is already recorded with a different parameter digest; refusing to overwrite the intent`,
          )
        }
        return held
      }
      const record = freshRecord(intent, identity, this.now())
      await this.table().put(record.operationId, record)
      return record
    })
  }

  /**
   * Ensure an operation has been sent as far as is provable, and report what is known.
   *
   * Sends only where {@link sendDecision} licenses it. Every other state is
   * reconciled against the record and, where possible, the remote.
   *
   * @param adapter - the task-specific adapter for this operation family.
   * @param intent - the requested effect.
   * @returns the outcome, whether this call sent anything, and why.
   */
  async perform(adapter: EffectAdapter, intent: EffectIntent): Promise<EffectAttempt> {
    this.assertOpen()
    const identity = identify(intent)
    return this.serialized(identity.operationId, () => this.performLocked(adapter, intent, identity))
  }

  /**
   * Establish what is known about an operation WITHOUT sending anything.
   *
   * This is the only entry point a recovery path may use. It has no code path that
   * reaches the transport, which is what makes "reconcile, never replay" a
   * property of the module rather than a convention its callers must remember.
   *
   * @param adapter - the adapter for this operation family.
   * @param intent - the operation to reconcile.
   * @returns the outcome, always with `performed: false`.
   */
  async reconcile(adapter: EffectAdapter, intent: EffectIntent): Promise<EffectAttempt> {
    this.assertOpen()
    const identity = identify(intent)
    return this.serialized(identity.operationId, () => this.reconcileLocked(adapter, identity))
  }

  /**
   * Report what cancelling an in-flight effect can and cannot do.
   *
   * Cancelling is not undoing. This method never writes a terminal state, never
   * clears a record and never claims a reversal: it reconciles the operation and
   * says whether it may already have happened. If the remote confirms it
   * committed, that is the answer even though the user asked to cancel.
   *
   * @param adapter - the adapter for this operation family.
   * @param intent - the operation the user wants stopped.
   * @returns the reconciled outcome and an explicit statement that nothing was undone.
   */
  async cancel(adapter: EffectAdapter, intent: EffectIntent): Promise<CancellationReport> {
    this.assertOpen()
    const identity = identify(intent)
    return this.serialized(identity.operationId, async () => {
      const held = this.table().get(identity.operationId)
      if (held === undefined) {
        // Nothing was ever sent through this ledger. That is a fact about US, not
        // about the world, so the remote state stays unknown rather than becoming
        // a claim that the operation did not happen.
        return {
          operationId: identity.operationId,
          outcome: 'unknown' as const,
          mayHaveHappened: false,
          reverted: false as const,
          queried: false,
          reason:
            'this ledger holds no intent for this operationId, so it never sent it; it does not claim the operation is impossible elsewhere, and the remote state is unknown rather than not_started',
        }
      }
      if (held.parameterDigest !== identity.parameterDigest) {
        return {
          operationId: identity.operationId,
          outcome: 'conflict' as const,
          mayHaveHappened: true,
          reverted: false as const,
          queried: false,
          reason:
            'the recorded operation has different parameters; this call cannot cancel an action it does not describe, and the recorded one may already have happened',
        }
      }
      if (held.status === 'intent_recorded') {
        return {
          operationId: identity.operationId,
          outcome: 'not_started' as const,
          mayHaveHappened: false,
          reverted: false as const,
          queried: false,
          reason:
            'the intent is durable but the transport was never invoked, so there is nothing to stop; this is a proof about our own write ordering, not an undo',
        }
      }
      if (held.status === 'confirmed') {
        return {
          operationId: identity.operationId,
          outcome: 'confirmed' as const,
          mayHaveHappened: true,
          reverted: false as const,
          queried: false,
          reason: 'the effect is confirmed to have happened; cancelling does not undo it, and this ledger will not report that it did',
        }
      }
      if (held.status === 'not_started') {
        return {
          operationId: identity.operationId,
          outcome: 'not_started' as const,
          mayHaveHappened: false,
          reverted: false as const,
          queried: false,
          reason: 'the remote already reported the operation never started; that is a query result, not a cancellation effect',
        }
      }
      // sent | unknown: the dangerous window. Only the remote can say.
      const { result, queried } = await this.queryHeld(adapter, identity, held)
      switch (result.status) {
        case 'confirmed':
          await this.put({ ...held, status: 'confirmed', resultRef: result.resultRef, ...(result.remoteKey === undefined ? {} : { remoteKey: result.remoteKey }), detail: result.detail ?? '', updatedAt: this.now() })
          return {
            operationId: identity.operationId,
            outcome: 'confirmed' as const,
            mayHaveHappened: true,
            reverted: false as const,
            queried,
            reason: 'the remote confirms the effect committed; cancelling after the fact does not undo it',
          }
        case 'not_started':
          await this.put({ ...held, status: 'not_started', detail: result.detail, updatedAt: this.now() })
          return {
            operationId: identity.operationId,
            outcome: 'not_started' as const,
            mayHaveHappened: false,
            reverted: false as const,
            queried,
            reason: 'the remote positively reports the operation never started; this is a query result, not an undo',
          }
        default:
          return {
            operationId: identity.operationId,
            outcome: 'unknown' as const,
            mayHaveHappened: true,
            reverted: false as const,
            queried,
            reason:
              `the effect was sent and the remote cannot say whether it committed (${result.detail}); the honest answer is unknown, and cancellation does not undo it`,
          }
      }
    })
  }

  private async performLocked(adapter: EffectAdapter, intent: EffectIntent, identity: EffectIdentity): Promise<EffectAttempt> {
    const held = this.table().get(identity.operationId)
    if (held === undefined) return this.send(adapter, intent, identity, undefined)
    const conflict = await this.conflictOrUndefined(held, identity)
    if (conflict !== undefined) return conflict
    if (sendDecision(held.status).send) return this.send(adapter, intent, identity, held)
    return this.reconcileHeld(adapter, identity, held)
  }

  private async reconcileLocked(adapter: EffectAdapter, identity: EffectIdentity): Promise<EffectAttempt> {
    const held = this.table().get(identity.operationId)
    if (held === undefined) {
      return {
        operationId: identity.operationId,
        parameterDigest: identity.parameterDigest,
        outcome: 'unknown',
        performed: false,
        resultRef: undefined,
        remoteKey: undefined,
        queried: false,
        heldParameterDigest: undefined,
        reason:
          'no intent is recorded for this operationId; the ledger does not query operations it never recorded, and it does not claim the remote never saw it',
      }
    }
    const conflict = await this.conflictOrUndefined(held, identity)
    if (conflict !== undefined) return conflict
    return this.reconcileHeld(adapter, identity, held)
  }

  /**
   * The E08 gate.
   *
   * A payload change under a recorded operationId is refused, the refusal is
   * audited, and the authorization fields are left exactly as they were: the
   * original ack covers the original parameters and nothing else.
   */
  private async conflictOrUndefined(held: EffectRecord, identity: EffectIdentity): Promise<EffectAttempt | undefined> {
    if (held.parameterDigest === identity.parameterDigest) return undefined
    await this.put({ ...held, refusedDigests: boundedPush(held.refusedDigests, identity.parameterDigest), updatedAt: this.now() })
    return {
      operationId: identity.operationId,
      parameterDigest: identity.parameterDigest,
      outcome: 'conflict',
      performed: false,
      resultRef: undefined,
      remoteKey: undefined,
      queried: false,
      heldParameterDigest: held.parameterDigest,
      reason:
        `operation "${identity.operationId}" is already recorded with parameter digest ${held.parameterDigest.slice(0, 12)}; `
        + `the requested digest ${identity.parameterDigest.slice(0, 12)} is a different action. `
        + 'The recorded acknowledgement authorizes the recorded parameters only, so nothing was sent. '
        + 'A different action needs a different operationId, which is a new authorization decision.',
    }
  }

  /** Reconcile against the record, querying the remote only in the un-settled window. */
  private async reconcileHeld(adapter: EffectAdapter, identity: EffectIdentity, held: EffectRecord): Promise<EffectAttempt> {
    if (held.status === 'confirmed') {
      return attempt(held, identity, {
        performed: false,
        queried: false,
        outcome: 'confirmed',
        reason: 'the ledger already holds a confirmed outcome for this operationId; reconciled against the durable acknowledgement, not repeated',
      })
    }
    if (held.status === 'intent_recorded') {
      return attempt(held, identity, {
        performed: false,
        queried: false,
        outcome: 'not_started',
        reason: 'the intent is durable and the transport was never invoked; nothing was sent. A send is licensed but this call does not perform it',
      })
    }
    if (held.status === 'not_started') {
      return attempt(held, identity, {
        performed: false,
        queried: false,
        outcome: 'not_started',
        reason: 'the remote already reported that this operation never started; resending it is a new authorization decision, not a reconciliation step',
      })
    }
    // sent | unknown: the window where the world may already have changed.
    const { result, queried } = await this.queryHeld(adapter, identity, held)
    switch (result.status) {
      case 'confirmed': {
        const next: EffectRecord = {
          ...held,
          status: 'confirmed',
          resultRef: result.resultRef,
          ...(result.remoteKey === undefined ? {} : { remoteKey: result.remoteKey }),
          detail: result.detail ?? '',
          updatedAt: this.now(),
        }
        await this.put(next)
        return attempt(next, identity, {
          performed: false,
          queried,
          outcome: 'confirmed',
          reason: 'the remote query confirms the effect committed; recorded and NOT resent',
        })
      }
      case 'not_started': {
        const next: EffectRecord = { ...held, status: 'not_started', detail: result.detail, updatedAt: this.now() }
        await this.put(next)
        return attempt(next, identity, {
          performed: false,
          queried,
          outcome: 'not_started',
          reason: 'the remote query reports the operation never started; recorded, and no automatic resend is made',
        })
      }
      default:
        return attempt(held, identity, {
          performed: false,
          queried,
          outcome: 'unknown',
          reason: `the effect may have been sent and the outcome cannot be established (${result.detail}); the record is left as it is and nothing is resent`,
        })
    }
  }

  /** Issue a remote query, or explain why none could be issued. */
  private async queryHeld(
    adapter: EffectAdapter,
    identity: EffectIdentity,
    held: EffectRecord,
  ): Promise<{ readonly result: EffectQueryResult; readonly queried: boolean }> {
    if (!adapter.capabilities.queryable) {
      return {
        result: { status: 'unsupported', detail: `adapter "${adapter.kind}" declares no queryable result, so a lost reply can only be unknown` },
        queried: false,
      }
    }
    try {
      return { result: await adapter.query(held.operationId, identity), queried: true }
    } catch (error) {
      // A query that failed is not an answer. In particular it is not not_started.
      return {
        result: { status: 'unknown', detail: `the query itself failed (${messageOf(error)}); a failed query is not evidence about the effect` },
        queried: true,
      }
    }
  }

  /** Invoke the transport. Reached only through {@link sendDecision}. */
  private async send(adapter: EffectAdapter, intent: EffectIntent, identity: EffectIdentity, held: EffectRecord | undefined): Promise<EffectAttempt> {
    if (adapter.kind !== intent.kind) {
      throw new Error(`effects: adapter "${adapter.kind}" cannot perform a "${intent.kind}" operation`)
    }
    if (!adapter.capabilities.idempotencyKey && !adapter.capabilities.queryable) {
      // SECURITY.md requires an idempotency key OR a queryable result. An adapter
      // with neither cannot be reconciled after a lost reply, so the first version
      // does not run it automatically. Recorded as `unknown` so a later reconcile
      // sees it; NOT recorded as a clean failure, which a caller might retry.
      const base = held ?? freshRecord(intent, identity, this.now())
      const next: EffectRecord = {
        ...base,
        status: 'unknown',
        detail: 'the adapter has neither a remote idempotency key nor a queryable result; an unreconcilable effect is not run automatically',
        updatedAt: this.now(),
      }
      await this.put(next)
      return attempt(next, identity, { performed: false, queried: false, outcome: 'unknown', reason: next.detail })
    }

    const now = this.now()
    const base = held ?? freshRecord(intent, identity, now)
    if (held === undefined) {
      // Write 1: the intent is durable BEFORE the transport is touched.
      await this.put(base)
    }
    // Write 2: the sent marker, BEFORE the call. Without it, a crash after the
    // call would be indistinguishable from never having called.
    const marked: EffectRecord = {
      ...base,
      status: 'sent',
      attempts: base.attempts + 1,
      toolCallIds: boundedPush(base.toolCallIds, intent.toolCallId),
      updatedAt: now,
    }
    await this.put(marked)

    let result: EffectPerformResult
    try {
      result = await adapter.perform(intent, identity)
    } catch (error) {
      // A thrown call is not proof that the remote did nothing.
      result = {
        status: 'unknown',
        detail: `the transport call threw (${messageOf(error)}); a thrown call is not proof that the remote did nothing`,
      }
    }

    const next: EffectRecord = {
      ...marked,
      status: result.status,
      detail: result.detail ?? (result.status === 'confirmed' ? `confirmed with result ${result.resultRef}` : ''),
      ...(result.status === 'confirmed' ? { resultRef: result.resultRef } : {}),
      ...(result.status === 'confirmed' && result.remoteKey !== undefined ? { remoteKey: result.remoteKey } : {}),
      updatedAt: this.now(),
    }
    await this.put(next)
    return attempt(next, identity, { performed: true, queried: false, outcome: result.status, reason: next.detail })
  }

  private async put(record: EffectRecord): Promise<void> {
    await this.table().put(record.operationId, record)
  }

  private now(): string {
    return new Date().toISOString()
  }

  private assertOpen(): void {
    if (this.disposed) throw new Error('effects: ledger is disposed')
    if (this.domain === undefined) throw new Error('effects: ledger is not open')
  }

  /**
   * Run one job at a time per key, so check-then-write is atomic within this process.
   *
   * The chain is dropped once nothing is queued behind it, so a long-lived host
   * does not accumulate one promise per operation it has ever performed.
   */
  private async serialized<T>(key: string, job: () => Promise<T>): Promise<T> {
    const previous = this.chains.get(key) ?? Promise.resolve()
    let release = (): void => {}
    const current = new Promise<void>(resolve => {
      release = resolve
    })
    const chained = previous.then(() => current)
    this.chains.set(key, chained)
    await previous
    try {
      return await job()
    } finally {
      release()
      if (this.chains.get(key) === chained) this.chains.delete(key)
    }
  }
}

/** What cancelling can honestly report. `reverted` is a literal false, not a flag to be set. */
export interface CancellationReport {
  readonly operationId: string
  readonly outcome: EffectOutcome
  /** Whether the effect may already have taken effect on the remote. */
  readonly mayHaveHappened: boolean
  /**
   * Always false, in the type as well as at runtime.
   *
   * Cancelling an external effect does not undo it, and a system that reports a
   * reversal it did not perform is lying about the world. There is deliberately no
   * code path that can produce `true`.
   */
  readonly reverted: false
  /** Whether a remote query was issued and its answer is the basis of the outcome. */
  readonly queried: boolean
  readonly reason: string
}

function freshRecord(intent: EffectIntent, identity: EffectIdentity, now: string): EffectRecord {
  return {
    operationId: identity.operationId,
    kind: intent.kind,
    logicalKey: intent.logicalKey,
    parameterDigest: identity.parameterDigest,
    parameters: canonicalJson(intent.parameters),
    status: 'intent_recorded',
    attempts: 0,
    detail: 'intent recorded; the transport has not been invoked',
    toolCallIds: [],
    refusedDigests: [],
    intentRecordedAt: now,
    updatedAt: now,
  }
}

/**
 * Build the attempt result.
 *
 * The outcome is a REQUIRED argument rather than defaulting to the stored status,
 * because `intent_recorded` and `sent` are record states and not answers. Letting
 * them leak into the outcome type would let a caller receive "sent" where the
 * contract promises one of the four answers.
 */
function attempt(
  record: EffectRecord,
  identity: EffectIdentity,
  patch: { readonly performed: boolean; readonly queried: boolean; readonly outcome: EffectOutcome; readonly reason: string },
): EffectAttempt {
  return {
    operationId: record.operationId,
    parameterDigest: identity.parameterDigest,
    outcome: patch.outcome,
    performed: patch.performed,
    resultRef: record.resultRef,
    remoteKey: record.remoteKey,
    queried: patch.queried,
    heldParameterDigest: undefined,
    reason: patch.reason,
  }
}

function boundedPush(existing: readonly string[], value: string | undefined): string[] {
  if (value === undefined || existing.includes(value)) return [...existing]
  return [...existing, value].slice(-MAX_AUDIT_ENTRIES)
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

// ---------------------------------------------------------------------------
// Programs: a partial commit is not a licence to replay the program (E10)
// ---------------------------------------------------------------------------

/** One effect inside a PTC-style program. */
export interface EffectProgramStep {
  readonly stepId: string
  readonly intent: EffectIntent
  /**
   * Work that runs after this step's effect has been sent and its outcome recorded.
   *
   * A throw here is the E10 scenario: an earlier effect already committed and the
   * program then died. The runner stops; it does not restart from the top.
   */
  readonly after?: () => void | Promise<void>
}

/** What happened to one step. */
export interface ProgramStepReport {
  readonly stepId: string
  readonly operationId: string
  readonly outcome: EffectOutcome
  /** `performed` this call sent it; `reconciled` this call only read/queried; `not_reached` it never ran. */
  readonly disposition: 'performed' | 'reconciled' | 'not_reached'
  readonly reason: string
}

/** The result of one program run. */
export interface ProgramReport {
  readonly completed: boolean
  readonly threwAt: string | undefined
  readonly error: string | undefined
  readonly steps: readonly ProgramStepReport[]
  /**
   * Literal false. There is no code path that re-runs a program as a unit.
   *
   * Automatic replay of an entire PTC program is forbidden, because the program's
   * effects are not a transaction: some may have committed and some may not, and
   * re-running the program would duplicate the committed ones. The type makes the
   * prohibition visible instead of leaving it to a comment.
   */
  readonly replayedWholeProgram: false
}

/**
 * Why an unentered step is `unknown` and not `not_started`.
 *
 * The runner knows which steps IT entered, but the program body between steps is
 * code it does not control: it may have started concurrent work, or called the
 * remote directly. A control-flow fact about the runner is not evidence about the
 * remote, and the ledger records nothing for an operation whose intent was never
 * written, so there is nothing to reconcile against either. The honest answer is
 * therefore unknown, and it forces an explicit decision about the remainder
 * instead of silently offering a safe-looking resume.
 */
const NOT_REACHED_REASON =
  'the program stopped before this step and the ledger holds no intent for it; a control-flow fact about the runner is not evidence about the remote, so this is unknown rather than not_started'

/**
 * Run a program's effects in order, stopping at the first throw.
 *
 * @param ledger - the effect ledger.
 * @param adapter - the adapter for these operations.
 * @param steps - the program, in order.
 * @returns a per-step report. It never contains a plan to re-run the program.
 */
export async function runEffectProgram(
  ledger: EffectLedger,
  adapter: EffectAdapter,
  steps: readonly EffectProgramStep[],
): Promise<ProgramReport> {
  const reports: ProgramStepReport[] = []
  let threwAt: string | undefined
  let error: string | undefined

  for (const step of steps) {
    const operationId = identify(step.intent).operationId
    if (threwAt !== undefined) {
      reports.push({ stepId: step.stepId, operationId, outcome: 'unknown', disposition: 'not_reached', reason: NOT_REACHED_REASON })
      continue
    }
    const sent = await ledger.perform(adapter, step.intent)
    reports.push({
      stepId: step.stepId,
      operationId,
      outcome: sent.outcome,
      disposition: sent.performed ? 'performed' : 'reconciled',
      reason: sent.reason,
    })
    try {
      await step.after?.()
    } catch (thrown) {
      threwAt = step.stepId
      error = messageOf(thrown)
      // Reconcile THIS step individually: its effect was already sent, and the
      // throw says nothing about whether the remote committed it.
      const settled = await ledger.reconcile(adapter, step.intent)
      reports[reports.length - 1] = {
        stepId: step.stepId,
        operationId,
        outcome: settled.outcome,
        disposition: 'reconciled',
        reason: `the program threw here; this step's effect was reconciled individually (${settled.reason})`,
      }
    }
  }

  return { completed: threwAt === undefined, threwAt, error, steps: reports, replayedWholeProgram: false }
}

/**
 * Reconcile every step of a previous run, individually, without sending anything.
 *
 * This is what replaces "replay the program". Each step is looked up and, where
 * the record is un-settled, queried. A step the ledger has no record for stays
 * unknown: there is nothing to query and nothing to trust.
 *
 * @param ledger - the effect ledger.
 * @param adapter - the adapter for these operations.
 * @param steps - the same program, in the same order.
 * @returns a per-step report with no transport invocations.
 */
export async function resumeEffectProgram(
  ledger: EffectLedger,
  adapter: EffectAdapter,
  steps: readonly EffectProgramStep[],
): Promise<ProgramReport> {
  const reports: ProgramStepReport[] = []
  for (const step of steps) {
    const operationId = identify(step.intent).operationId
    if (ledger.get(operationId) === undefined) {
      reports.push({ stepId: step.stepId, operationId, outcome: 'unknown', disposition: 'not_reached', reason: NOT_REACHED_REASON })
      continue
    }
    const settled = await ledger.reconcile(adapter, step.intent)
    reports.push({
      stepId: step.stepId,
      operationId,
      outcome: settled.outcome,
      disposition: 'reconciled',
      reason: `reconciled individually: ${settled.reason}`,
    })
  }
  return { completed: false, threwAt: undefined, error: undefined, steps: reports, replayedWholeProgram: false }
}

// ---------------------------------------------------------------------------
// Opaque shell text (E09)
// ---------------------------------------------------------------------------

/** What a shell command's text can be said to be. `unknown` is the default, not a failure. */
export type ShellClassification = 'read_only' | 'mutating' | 'unknown'

/** The classifier's verdict, plus the token that decided it so a human can check the claim. */
export interface ShellVerdict {
  readonly classification: ShellClassification
  readonly reason: string
  /** The character or token that produced the verdict, when there is one. */
  readonly witness: string | undefined
}

/**
 * What this classifier cannot see. Every entry is a way the text can lie.
 *
 * This list is part of the module's interface on purpose. A reader who is about to
 * treat `read_only` as an authorization must first read what the verdict does not
 * cover; the function is a refusal device, not a permission device.
 */
export const CLASSIFIER_LIMITS: readonly string[] = Object.freeze([
  'aliases and shell functions: a name that looks read-only can be bound to anything, including in the same command line',
  'PATH shadowing: a binary named `ls` earlier on PATH is not ls. Only a bare, unqualified name is even considered',
  'interpreters: `python -c`, `node -e`, `bash -c`, `sh script`, `awk`, `perl` and friends can do anything; they are never classified',
  'variable and command substitution: `$cmd`, `$(...)` and backticks hide the real command from any text analysis',
  'redirections and pipelines: `>`, `>>`, `|`, `tee` turn a reading command into a writing one',
  'operators: `;`, `&&`, `||`, `&`, newlines and comments compose several commands, so classifying only the first token is wrong',
  'scripts on disk: `./deploy.sh` and `bash deploy.sh` are opaque; the file is not read',
  'remote execution: `ssh host cmd`, `kubectl exec`, `docker run` act on another machine entirely',
  'the flag space is not closed: a writing flag not in the table below is missed, which is why `unknown` and not `read_only` is the default',
])

/**
 * Characters that mean the text is a shell PROGRAM, not a command.
 *
 * Any occurrence makes the verdict `unknown` before any other rule runs. The list
 * is deliberately longer than "the ones I could think of a use for": `%` and `~`
 * and `#` are here because over-refusal is free and under-refusal is not.
 */
const SHELL_METACHARACTERS = ['>', '<', '|', '&', ';', '$', '`', '(', ')', '{', '}', '[', ']', '*', '?', '~', '!', '\\', '"', "'", '\n', '\r', '\t', '#', '%', '^'] as const

/**
 * Commands whose normal use only reads.
 *
 * A closed, hand-audited set. This list is the ONLY thing that can produce
 * `read_only`, and it is deliberately tiny: adding an entry is a security
 * decision, not a convenience.
 *
 * Two commands a reader may expect are ABSENT on purpose, and their absence is
 * the interesting part:
 *
 *   - `sort`: `sort in out` writes to `out` with no flag at all, so a positional
 *     operand is an output. It stays out of the allowlist and is covered by the
 *     writing-flag table instead, which can only ever say `mutating`.
 *   - `uniq`, `split`, `tee`, `dd`: same shape, plus `tee` and `dd` write by
 *     design.
 */
const READ_ONLY_COMMANDS: readonly string[] = Object.freeze([
  'ls', 'cat', 'pwd', 'whoami', 'id', 'head', 'tail', 'wc', 'stat', 'du', 'df', 'date',
  'uname', 'which', 'printenv', 'basename', 'dirname', 'realpath', 'readlink',
  'sha256sum', 'md5sum', 'diff', 'grep',
])

/**
 * Flags that turn an otherwise reading command into a writer.
 *
 * Each entry is a place a human found a write, not a proof that the rest are
 * clean; see {@link CLASSIFIER_LIMITS}. Matching is deliberately loose (a bundled
 * short flag such as `sort -ro out in` is caught), so the failure mode is refusing
 * a read, never allowing a write.
 *
 * This table covers commands that are NOT on the read-only allowlist, which is
 * intentional: its job is to name writers, and a writer named here can never be
 * upgraded to `read_only` by any other rule.
 */
const WRITING_FLAGS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  sort: ['-o', '--output'],
  date: ['-s', '--set'],
  file: ['-C', '--compile'],
  find: ['-delete', '-exec', '-execdir', '-ok', '-fprint', '-fls', '-fprintf'],
})

/**
 * Commands whose short flags are conventionally written WITHOUT a dash, so the
 * dashed-flag matcher above cannot see them.
 *
 * `tar` is the canonical case: `tar xf archive.tgz` extracts and writes files, and
 * there is no `-` anywhere in the text. This is exactly the kind of hole the
 * {@link CLASSIFIER_LIMITS} list warns about, so it is named here rather than left
 * to a regex that happened to work.
 */
const BUNDLED_WRITER_FLAGS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  tar: ['x', 'c', 'r', 'u', 'A'],
})

/**
 * Commands whose normal use changes something.
 *
 * A denylist may be wrong in the safe direction only: every entry here really does
 * change state, so a `mutating` verdict is never a false accusation that lets
 * something through. Commands that read in some modes and write in others (`tar`,
 * `sed`, `gzip`) are deliberately absent: they fall to `unknown`, which is the
 * honest verdict for them.
 */
const WRITER_COMMANDS: readonly string[] = Object.freeze([
  'rm', 'rmdir', 'mv', 'cp', 'dd', 'tee', 'truncate', 'shred', 'chmod', 'chown', 'chgrp',
  'mkdir', 'touch', 'ln', 'install', 'kill', 'pkill', 'killall', 'reboot', 'shutdown',
  'systemctl', 'service', 'mount', 'umount', 'sudo', 'su', 'apt', 'apt-get', 'yum', 'dnf',
  'brew', 'pip', 'pip3', 'npm', 'pnpm', 'yarn', 'cargo', 'make', 'docker', 'kubectl',
  'curl', 'wget', 'ssh', 'scp', 'sftp', 'rsync',
])

/** `git` subcommands that only read. Anything else, including `-C` and `--git-dir`, is unknown. */
const READ_ONLY_GIT_SUBCOMMANDS: readonly string[] = Object.freeze([
  'log', 'status', 'diff', 'show', 'rev-parse', 'ls-files', 'blame', 'describe', 'shortlog', 'cat-file', 'symbolic-ref',
])

function isPlainToken(token: string): boolean {
  for (const character of token) {
    const code = character.codePointAt(0) ?? 0
    const alphanumeric = (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122)
    if (alphanumeric || '-_./=,:@+'.includes(character)) continue
    return false
  }
  return true
}

function matchesWritingFlag(token: string, flag: string): boolean {
  if (token === flag) return true
  if (token.startsWith(`${flag}=`)) return true
  // A bundled short flag: `-ro` is `-r -o`, and the second one takes a filename.
  return flag.length === 2 && token.startsWith('-') && !token.startsWith('--') && token.includes(flag[1] as string)
}

/**
 * Classify a shell command's text.
 *
 * The default is `unknown`. Only a closed allowlist of plain, unqualified,
 * metacharacter-free invocations produces `read_only`. This function exists to
 * REFUSE: its output may not be used as an authorization to run anything
 * unattended, and `mayRunAutomatically` is the only sanctioned reading of it.
 *
 * @param command - the raw command text.
 * @returns the verdict, the reason, and the witness that decided it.
 */
export function classifyShellCommand(command: string): ShellVerdict {
  const trimmed = command.trim()
  if (trimmed.length === 0) {
    return { classification: 'unknown', reason: 'empty command text; there is nothing to classify and nothing to authorize', witness: undefined }
  }
  for (const character of trimmed) {
    if ((SHELL_METACHARACTERS as readonly string[]).includes(character)) {
      return {
        classification: 'unknown',
        reason: `the text contains "${character}", so it is a shell program rather than a command; text analysis cannot see what it expands to`,
        witness: character,
      }
    }
  }
  const tokens = trimmed.split(/\s+/)
  const executable = tokens[0] as string
  if (!isPlainToken(executable)) {
    return { classification: 'unknown', reason: `the executable token "${executable}" contains characters outside the plain-token grammar`, witness: executable }
  }
  if (executable.includes('/')) {
    return {
      classification: 'unknown',
      reason: `"${executable}" is path-qualified; a file at that path can be anything, so the name proves nothing`,
      witness: executable,
    }
  }
  if (WRITER_COMMANDS.includes(executable)) {
    return { classification: 'mutating', reason: `"${executable}" changes state in its normal use`, witness: executable }
  }
  const writingFlags = WRITING_FLAGS[executable]
  if (writingFlags !== undefined) {
    for (const token of tokens.slice(1)) {
      for (const flag of writingFlags) {
        if (matchesWritingFlag(token, flag)) {
          return {
            classification: 'mutating',
            reason: `"${executable} ${flag}" writes; the flag list is not closed, which is why the default below is unknown`,
            witness: token,
          }
        }
      }
    }
  }
  if (executable === 'git') {
    const subcommand = tokens[1]
    if (subcommand === undefined || !READ_ONLY_GIT_SUBCOMMANDS.includes(subcommand)) {
      return {
        classification: 'unknown',
        reason: `git subcommand "${subcommand ?? ''}" is not on the read-only list; git writes in most of its modes`,
        witness: subcommand,
      }
    }
    return { classification: 'read_only', reason: `git ${subcommand} is on the closed read-only list and the arguments contain no shell metacharacters`, witness: `git ${subcommand}` }
  }
  const bundled = BUNDLED_WRITER_FLAGS[executable]
  if (bundled !== undefined) {
    for (const token of tokens.slice(1)) {
      for (const flag of bundled) {
        // `tar xf a.tgz` is the shape this catches: a writing mode with no dash.
        if (!token.startsWith('-') && token.includes(flag)) {
          return {
            classification: 'mutating',
            reason: `"${executable} ${token}" selects a writing mode; the mode letters are matched without a dash because that is how they are conventionally written`,
            witness: token,
          }
        }
      }
    }
  }
  if (!READ_ONLY_COMMANDS.includes(executable)) {
    return {
      classification: 'unknown',
      reason: `"${executable}" is not on the read-only allowlist and not on the writer list; the classifier does not guess`,
      witness: executable,
    }
  }
  return { classification: 'read_only', reason: `"${executable}" is on the closed read-only list and the arguments contain no shell metacharacters`, witness: executable }
}

/**
 * The only sanctioned reading of a verdict.
 *
 * `unknown` and `mutating` both refuse. Note what a refusal means here: it does
 * not mean the command is forbidden, it means this module will not be the thing
 * that authorized it. The enforcement boundary for shell is the sandbox and the
 * process identity, not this function.
 *
 * @param verdict - a verdict from {@link classifyShellCommand}.
 * @returns whether the command may run without a human or an adapter in the loop.
 */
export function mayRunAutomatically(verdict: ShellVerdict): boolean {
  return verdict.classification === 'read_only'
}
