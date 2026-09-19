/**
 * The public programmatic-call scope: ONE native pipeline for every
 * code-transport that calls tools from inside a program.
 *
 * WHY THIS FILE EXISTS. `packages/core/tools/src/ptc.ts` already contains this
 * scope, but it is welded to `run_code`: the driver lane, the ordered commit
 * cursor, the control/content ferrying and the abort drain all live inside
 * `createRunCodeTool`'s `execute`, reachable only by running a `run_code`
 * program. The architecture's target is that stock `run_code` and a future
 * `python_exec` share ONE implementation of
 * "policy -> guard -> approval -> native tool -> final value"
 * (ARCHITECTURE.zh-CN.md section 4, `ProgrammaticCallScope`).
 *
 * HOW IT IS SHARED WITHOUT A SECOND PIPELINE, AND WITHOUT AN UPSTREAM PATCH.
 * This scope does not re-implement policy, and it does not import the private
 * `TOOL_RUNTIME_SCHEDULER` symbol. It calls `ToolRuntime.execute`, which is the
 * registry's own public composition of the SAME staged functions `ptc.ts`
 * reaches through that symbol:
 *
 *     execute() = prepareScheduledExecution -> dispatchScheduledExecution
 *                 -> finalizeScheduledExecution -> finishScheduledExecution
 *
 * So `tools/pre-execute`, monotonic guards, the approval `ask` seam,
 * canonical-value validation against the declared output schema, post-execute
 * policy, `finalizeContent`, and `tools/result` notification are literally the
 * same code on all three routes (model-direct native call, `run_code`
 * sub-dispatch, scope call). There is no second pipeline to drift. What this
 * file adds is the part `ptc.ts` has and `execute` does not: the scheduling
 * discipline around those calls, the delivery choice, the control/content
 * split, and the close-time drain.
 *
 * THE ONE MEASURED SCHEDULING DIFFERENCE FROM `run_code`, stated rather than
 * hidden. `ptc.ts` splits each sub-dispatch AT the scheduler seam, so a slow
 * pre-execute on call N delays the START of call N+1: ordered policy stages run
 * in one lane and only the around-dispatch/body overlaps. A scope built on
 * `execute` cannot reproduce that, because each call is one indivisible
 * `execute()`. Here, two concurrently-started calls may have their pre-execute
 * stages overlap. This is a scheduling difference, not a policy bypass: every
 * call still runs the complete gate, a `ToolGuard` is synchronous and
 * order-insensitive by signature, an approval carries its own request id, and
 * `tools/pre-execute` listeners are documented as receiving each call, not as
 * being serialized against each other. It is asserted in the test file
 * (`BRG-01`), not asserted away here.
 *
 * WHAT THIS FILE DELIBERATELY DOES NOT DO.
 *  - It never caches a tool catalog. Names are re-resolved per call by the
 *    registry, so a revocation during an open scope takes effect on the next
 *    call (BRG-02). `names()` is a live read for discovery only, never a
 *    dispatch table.
 *  - It never mints a `ToolExecutionToken`. `parent` is host-bound: the caller
 *    passes the enclosing transport execution's own `exec.token`, which is the
 *    documented producer of that value ("Opaque token of the enclosing
 *    transport execution, when one exists. PTC mode sets this on SDK
 *    sub-dispatches"). Fabricating one would forge the nested-call marker that
 *    bypasses the `ptc` presentation collapse.
 *  - It never re-executes an effect to recover a value. An over-budget `value`
 *    delivery throws with the reference already retained from the SAME single
 *    execution.
 *  - It never returns a reference from `value` delivery. The declared
 *    canonical type is not silently swapped for a locator.
 *  - It never writes a reference from a PRE-policy value. The only writer is
 *    the commit path, which holds the final result (BRG-05).
 */

import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash } from 'node:crypto'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, UserMessage } from '@deepseek-ai/dsh-llm'
import { RUN_CODE_NAME, TOOL_ABORTED, TOOL_ABORTED_BEFORE_DISPATCH } from '@deepseek-ai/dsh-tools'
import type {
  ToolExecutionInput,
  ToolExecutionResult,
  ToolExecutionToken,
  ToolRuntime,
} from '@deepseek-ai/dsh-tools'
import { deepFreeze, isJsonValue, snapshotJsonValue, type JsonValue } from '@deepseek-ai/dsh-util-values'

/**
 * Which result the caller asked for.
 *
 * `value` returns the tool's declared canonical type T unchanged, or throws an
 * explicit budget error carrying a retained reference. `reference` returns a
 * locator for the POST-POLICY canonical result and is the only delivery that
 * may return a locator.
 */
export type Delivery = 'value' | 'reference'

/** Why a scope closed; recorded on every disposition it reports. */
export type ScopeCloseReason = 'completed' | 'aborted' | 'error'

/**
 * The extracted contract. Actor, Session, enclosing execution and policy are
 * bound by the host at construction and are never parameters of a call, so a
 * model-authored program cannot name a different actor or a wider policy.
 */
export interface ProgrammaticCallScope {
  /**
   * Run one native tool through the registry pipeline.
   * @param name - the tool name as registered; resolved live, per call.
   * @param args - losslessly JSON-serializable arguments.
   * @param delivery - `value` for the declared canonical type, `reference` for a post-policy locator.
   * @returns the canonical value (or its reference), or a rejection carrying the native failure text.
   */
  invoke<T extends JsonValue = JsonValue>(name: string, args: JsonValue, delivery: Delivery): Promise<T>
  /**
   * Close the scope and drain it. Resolves only after every call has settled
   * and every disposition has been reported; never returns while work is still
   * running in the background.
   * @param reason - the close classification recorded on each disposition.
   */
  close(reason: ScopeCloseReason): Promise<void>
}

/** A locator for one retained, host-authored, post-policy result. */
export interface ScopeReference {
  readonly kind: 'scope-reference'
  readonly schemaVersion: 1
  /** Content-addressed id (the sha256 of the stored bytes). */
  readonly id: string
  readonly sha256: string
  readonly bytes: number
  readonly mediaType: string
  readonly tool: string
  readonly callId: string
  /** Whether the retained result was a failure. A failure retains no value. */
  readonly isError: boolean
  readonly capturedAt: string
}

/** Whether an unknown value is a {@link ScopeReference} produced by this module. */
export function isScopeReference(value: unknown): value is ScopeReference {
  return typeof value === 'object' && value !== null
    && (value as { kind?: unknown }).kind === 'scope-reference'
}

/** Where retained bytes live. M4 owns the production store; this is the seam. */
export interface ScopeReferenceStore {
  /** Retain bytes and return their content-addressed identity. */
  put(input: { tool: string; callId: string; mediaType: string; bytes: Uint8Array }): Promise<{ id: string; sha256: string; bytes: number }>
  /** Read retained bytes back, or `undefined` when the id is unknown. */
  read(id: string): Promise<Uint8Array | undefined>
  /** List what is retained, for audit. */
  list(): Promise<readonly { id: string; sha256: string; bytes: number }[]>
}

/**
 * The in-process reference store. Content-addressed, immutable, and never
 * written from a pre-policy value: the only caller is the commit path, which
 * holds the FINAL result.
 */
export function createMemoryReferenceStore(): ScopeReferenceStore {
  const objects = new Map<string, Uint8Array>()
  return {
    put: ({ bytes }) => {
      const digest = createHash('sha256').update(bytes).digest('hex')
      // Content-addressed: an identical post-policy result reuses one object.
      if (!objects.has(digest)) objects.set(digest, Uint8Array.from(bytes))
      return Promise.resolve({ id: digest, sha256: digest, bytes: bytes.byteLength })
    },
    read: id => Promise.resolve(objects.get(id)),
    list: () => Promise.resolve([...objects.entries()].map(([id, bytes]) => ({
      id, sha256: id, bytes: bytes.byteLength,
    }))),
  }
}

/**
 * Host-bound control sinks. These are the OUTER transport execution's own
 * capabilities: the scope ferries what a nested call produced onto the
 * enclosing call's result. A program cannot supply or replace them.
 */
export interface ScopeControlSink {
  /** Attach a context to the enclosing execution's own result. */
  deferContext(context: UserMessage): void
  /** Mark the enclosing execution's successful result as terminal for the turn. */
  concludeTurn(): void
}

/**
 * One settled call's disposition. Every submitted call reports exactly one, so
 * "nothing was left running" is an accounting fact rather than a claim.
 */
export interface ScopeCallDisposition {
  readonly subCallId: string
  readonly name: string
  readonly delivery: Delivery
  /**
   * `settled` - the call finished before the close began.
   * `cancelled` - it was in flight when the scope closed and settled under the abort.
   * `handed-to-jobs` - it had not started and a host handoff took ownership of it.
   * `abandoned-unstarted` - it had not started and no handoff existed, so it was refused.
   */
  readonly disposition: 'settled' | 'cancelled' | 'handed-to-jobs' | 'abandoned-unstarted'
  /** Present exactly when `disposition` is `handed-to-jobs`. */
  readonly jobId?: string
  readonly closeReason?: ScopeCloseReason
  /** True when this call was made from inside a tool body, so it bypassed the pool. */
  readonly nested: boolean
}

/** One bounded control notice that reached the enclosing execution. */
export interface ScopeNoticeRecord {
  readonly tool: string
  readonly callId: string
  readonly chars: number
  readonly truncated: boolean
  /** True for the coalesced notice that accounts for everything past the direct bound. */
  readonly coalesced: boolean
}

/** One content payload that did NOT enter model context, retained as a reference. */
export interface ScopeContentRecord {
  readonly tool: string
  readonly callId: string
  readonly blockTypes: readonly string[]
  readonly bytes: number
  /** Whether the retained bytes carry the WHOLE payload. False means metadata only (see `RetainedPayloadEnvelope`). */
  readonly lossless: boolean
  readonly reference: ScopeReference
}

/** The optional host handoff for calls that had not started when the scope closed. */
export type ScopeJobHandoff = (call: { subCallId: string; name: string; args: JsonValue }) => { jobId: string } | undefined

/** Construction options. Everything authority-bearing is host-supplied. */
export interface ProgrammaticCallScopeOptions {
  /** The owning registry; the one pipeline every route shares. */
  readonly registry: ToolRuntime
  /**
   * The exact Agent the scope acts as, or undefined for an ownerless call. A
   * scope can never widen this: it is not a call parameter.
   */
  readonly agent?: Agent
  /**
   * The enclosing transport execution's own token. Required: it is what marks
   * each call a transport sub-dispatch, so the `ptc` presentation collapse
   * admits it exactly as it admits a `run_code` SDK call. The host reads it
   * from the enclosing `ToolRunContext`.
   */
  readonly parent: ToolExecutionToken
  /** The enclosing execution's root call id, propagated for correlation. */
  readonly rootCallId?: string
  /** The enclosing execution's cancellation; the scope follows it. */
  readonly signal: AbortSignal
  /** Prefix for generated sub-call ids, so they correlate with the transport call. */
  readonly callIdPrefix: string
  /** Where control notices and turn conclusions go. */
  readonly control: ScopeControlSink
  /** Top-level overlap cap; nested calls are admitted within their parent's slot. Default 10. */
  readonly maxParallel?: number
  /**
   * How a non-text content payload (for example a large image) is treated.
   * `reference` (default) keeps it out of model context and retains it as an
   * auditable reference. `defer-images` reproduces stock `run_code`'s existing
   * behaviour verbatim (an image-bearing successful nested result is deferred
   * as one user message) and exists so the two transports can be compared on
   * one registry.
   */
  readonly contentProjection?: 'reference' | 'defer-images'
  /** Byte budget for one `value` delivery, measured on the canonical JSON. Default 64 KiB. */
  readonly valueBudgetBytes?: number
  /** Per-notice character bound for control contexts. Default 4096. */
  readonly maxNoticeChars?: number
  /** Notices ferried directly before the rest are coalesced into one bounded notice. Default 64. */
  readonly maxNotices?: number
  /** Retained-byte store. Defaults to a fresh in-process store. */
  readonly references?: ScopeReferenceStore
  /** Host handoff for calls still queued at close. Absent means they are refused, never silently run. */
  readonly handoffToJobs?: ScopeJobHandoff
  /** Host-owned disposition sink, so the enclosing log records the drain. */
  readonly onDisposition?: (disposition: ScopeCallDisposition) => void
}

/** The handle a host holds: the contract plus the audit surface. */
export interface ProgrammaticCallScopeHandle extends ProgrammaticCallScope {
  /** Live read of the names this scope can currently dispatch. Never a cached catalog. */
  names(): readonly string[]
  /** Read retained bytes back through the same store `reference` delivery wrote to. */
  read(reference: ScopeReference): Promise<string | undefined>
  /** Every disposition reported so far, in reporting order. */
  dispositions(): readonly ScopeCallDisposition[]
  /** Control notices that reached the enclosing execution, in commit order. */
  notices(): readonly ScopeNoticeRecord[]
  /** Content payloads kept out of model context, in commit order. */
  content(): readonly ScopeContentRecord[]
  /** The store this scope writes references to. */
  readonly references: ScopeReferenceStore
}

/** Thrown when a `value` delivery exceeds its budget. Carries the retained reference, never a re-execution. */
export class ScopeDeliveryBudgetError extends Error {
  /** The reference to the already-retained result; the effect is not repeated to recover it. */
  readonly reference: ScopeReference
  constructor(tool: string, bytes: number, budget: number, reference: ScopeReference) {
    super(
      `programmatic scope: "${tool}" returned ${String(bytes)} bytes of canonical JSON, over the `
      + `${String(budget)}-byte value-delivery budget; the result was retained once and is available `
      + `by reference ${reference.id}. The tool was NOT re-executed.`,
    )
    this.name = 'ScopeDeliveryBudgetError'
    this.reference = reference
  }
}

/**
 * The scopes whose tool bodies are on the current async chain.
 *
 * A Set rather than a single scope so that a body dispatched by scope A which
 * calls scope B still counts as nested for B: the question is "is this call
 * made from inside a tool body", not "from inside MY tool body". Absent from
 * the chain means top-level, which is the only case the pool admits through its
 * queue.
 *
 * READ AT `invoke()` TIME, NOT IN THE DRIVER LANE. The driver is a single
 * long-lived task that may have been started by a DIFFERENT caller's context;
 * asking it "is this nested?" would answer about whichever submission happened
 * to start the lane. The caller's own context is the only place the question
 * has a correct answer, so `invoke` reads it synchronously and records it on
 * the call.
 */
const activeBodies = new AsyncLocalStorage<ReadonlySet<object>>()

/** One accepted call's mutable scheduling state. */
interface PendingCall {
  readonly subCallId: string
  readonly name: string
  readonly delivery: Delivery
  readonly nested: boolean
  readonly input: ToolExecutionInput
  readonly args: JsonValue
  /**
   * Resolves when the registry pipeline for this call has settled, success or
   * failure. Created in `invoke` rather than in `start` so the close drain can
   * account for a call from the moment it is accepted — a nested call is
   * admitted immediately and would otherwise be invisible to quiescence for one
   * promise tick.
   */
  readonly body: Promise<void>
  readonly markBodyDone: () => void
  mode?: 'parallel' | 'exclusive'
  flight: Promise<void>
  settled: boolean
  parked?: ToolExecutionResult
  classify(): 'parallel' | 'exclusive'
  start(): Promise<void>
  commit(): Promise<void>
  abandon(): void
}

/** One retained payload write, deferred out of the synchronous ferry path into `commit()`. */
interface PendingPayload {
  readonly tool: string
  readonly callId: string
  readonly mediaType: string
  /**
   * The exact bytes retained. Never a summary of them: the reference must
   * recover this payload.
   */
  readonly bytes: Uint8Array
  readonly blockTypes: readonly string[]
  /** False when the payload was NOT losslessly JSON and the envelope is metadata only. */
  readonly lossless: boolean
}

/**
 * The runtime's own lossless-JSON gate, as a type predicate.
 *
 * WHY THIS EXISTS. `isJsonValue` is declared `(value: unknown) => boolean`, so
 * TypeScript cannot carry its answer into the type system and a caller who has
 * just ASKED would still have to assert. This wrapper performs the SAME runtime
 * check — it delegates, it does not reimplement or weaken it — and adds only the
 * narrowing declaration the library's signature omits.
 *
 * This is not the `as any` bypass the project forbids: that pattern fabricates
 * an API or erases a check. Here the check runs, its result is the predicate's
 * result, and the declared narrowing states exactly what `isJsonValue` already
 * guarantees ("whether the value survives a JSON round trip without loss").
 * @param value - candidate value.
 * @returns whether the value is losslessly JSON, narrowed.
 */
function isLosslessJsonValue(value: unknown): value is JsonValue {
  return isJsonValue(value)
}

/**
 * The declared JSON envelope a retained content payload is stored as.
 *
 * WHY THIS IS A PROJECTION AND NOT A CAST. `ContentBlockMap` is documented as
 * "merge-extensible content blocks keyed by type", and its member interfaces
 * carry no index signature — so a block array is not even STATICALLY assignable
 * to `JsonValue`, regardless of what it holds at runtime. The question that
 * raises is a real one: is this payload exactly recoverable, or only partly?
 *
 * `isLosslessJsonValue` asks the runtime's own gate, so the answer is observed
 * rather than assumed. When it is true, the payload IS its JSON text and
 * `lossless` is true. When it is false — a plugin-added block carrying a
 * handle, a typed array, a class instance — the retained object is this
 * envelope with `blocks: null`, which claims the block TYPES and the byte count
 * and nothing more. A reference that silently could not recover its object
 * would be worse than no reference.
 *
 * For every block the harness itself produces (`text`, `reasoning`, `image`,
 * `file`, `tool-call`, `tool-result`) the gate is true: attachment refs are
 * branded strings and numbers, and a brand is a compile-time-only type. The
 * false branch exists for the extensible case, not the shipped one.
 */
interface RetainedPayloadEnvelope {
  readonly schemaVersion: 1
  readonly blockTypes: readonly string[]
  /** The losslessly-snapshotted blocks, or null when the payload could not be represented. */
  readonly blocks: JsonValue | null
  /** Whether `blocks` carries the whole payload. */
  readonly lossless: boolean
}

/** Default canonical-JSON byte budget for a direct `value` delivery. */
const DEFAULT_VALUE_BUDGET_BYTES = 64 * 1024
/** Default per-notice character bound. */
const DEFAULT_MAX_NOTICE_CHARS = 4096
/** Default number of notices ferried directly before coalescing. */
const DEFAULT_MAX_NOTICES = 64
/** Default top-level overlap cap, matching the registry's own `maxParallelSubCalls` default. */
const DEFAULT_MAX_PARALLEL = 10

/** UTF-8 byte length of a JSON value's canonical serialization. */
function jsonBytes(value: JsonValue): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8')
}

/** Retain one result's bytes and build its reference. */
async function retainResult(
  store: ScopeReferenceStore,
  tool: string,
  callId: string,
  isError: boolean,
  payload: JsonValue,
): Promise<ScopeReference> {
  return await retainBytes(
    store, tool, callId, 'application/json',
    new TextEncoder().encode(JSON.stringify(payload)),
    isError,
  )
}

/**
 * Retain exact bytes and build the reference that recovers them.
 * @param store - the retention store.
 * @param tool - the tool whose result these bytes are.
 * @param callId - the sub-call identity, for audit correlation.
 * @param mediaType - the declared media type of the bytes.
 * @param bytes - the exact bytes.
 * @param isError - whether the retained result was a failure.
 * @returns the frozen reference.
 */
async function retainBytes(
  store: ScopeReferenceStore,
  tool: string,
  callId: string,
  mediaType: string,
  bytes: Uint8Array,
  isError = false,
): Promise<ScopeReference> {
  const stored = await store.put({ tool, callId, mediaType, bytes })
  return deepFreeze({
    kind: 'scope-reference',
    schemaVersion: 1,
    id: stored.id,
    sha256: stored.sha256,
    bytes: stored.bytes,
    mediaType,
    tool,
    callId,
    isError,
    capturedAt: new Date().toISOString(),
  })
}

/**
 * Build one scope over the public registry surface.
 * @param options - host-bound authority, limits, and sinks.
 * @returns the scope handle.
 */
export function createProgrammaticCallScope(options: ProgrammaticCallScopeOptions): ProgrammaticCallScopeHandle {
  const {
    registry, agent, parent, signal, callIdPrefix, control,
    rootCallId, handoffToJobs, onDisposition,
  } = options
  const maxParallel = options.maxParallel ?? DEFAULT_MAX_PARALLEL
  if (!Number.isInteger(maxParallel) || maxParallel < 1) {
    throw new Error('programmatic scope: maxParallel must be a positive integer')
  }
  const valueBudgetBytes = options.valueBudgetBytes ?? DEFAULT_VALUE_BUDGET_BYTES
  const maxNoticeChars = options.maxNoticeChars ?? DEFAULT_MAX_NOTICE_CHARS
  const maxNotices = options.maxNotices ?? DEFAULT_MAX_NOTICES
  const contentProjection = options.contentProjection ?? 'reference'
  const references = options.references ?? createMemoryReferenceStore()

  // The run-scoped abort: follows the enclosing signal in, and fires when the
  // scope closes for ANY reason, so an in-flight call is aborted (its executor
  // kills on this signal) instead of orphaned, and queued calls are refused.
  const runController = new AbortController()
  const onOuterAbort = (): void => { runController.abort(signal.reason) }
  if (signal.aborted) runController.abort(signal.reason)
  else signal.addEventListener('abort', onOuterAbort, { once: true })

  let dispatches = 0
  let closed = false
  let closeReason: ScopeCloseReason | undefined
  const pendingQueue: PendingCall[] = []
  /**
   * Every accepted call. The close drain awaits each one's `body`, so a call
   * that was accepted but has not reached the lane yet is still accounted for:
   * quiescence is a statement about calls that were ACCEPTED, not only about
   * calls the lane happened to start.
   */
  const accepted = new Set<PendingCall>()
  /** Pool-occupying calls only; a nested call runs inside its parent's slot and is not counted here. */
  let poolCount = 0
  const commitQueue: PendingCall[] = []
  const reported: ScopeCallDisposition[] = []
  const noticeRecords: ScopeNoticeRecord[] = []
  const contentRecords: ScopeContentRecord[] = []
  /** Notices beyond the direct bound, coalesced into ONE bounded notice at close. */
  const suppressedNotices: string[] = []
  /** Payload writes deferred out of the synchronous ferry path into `commit()`. */
  const pendingPayloads: PendingPayload[] = []
  let exclusiveActive = false
  let driving = false
  let driverRun: Promise<void> = Promise.resolve()
  let wake: (() => void) | undefined

  const wakeup = (): void => {
    const release = wake
    wake = undefined
    release?.()
  }

  const report = (disposition: ScopeCallDisposition): void => {
    reported.push(disposition)
    onDisposition?.(disposition)
  }

  /** Bound one context message to `maxNoticeChars`, preserving every non-text block. */
  const boundNotice = (message: UserMessage): { message: UserMessage; chars: number; truncated: boolean } => {
    const text = message.content.map(block => block.type === 'text' ? block.text : '').join('')
    if (text.length <= maxNoticeChars) return { message, chars: text.length, truncated: false }
    // Truncate the TEXT and drop nothing else: a security notice keeps its
    // provenance and its non-text payload, and the elision is visible in the
    // text itself rather than silent.
    let remaining = maxNoticeChars
    let truncated = false
    const content: ContentBlock[] = []
    for (const block of message.content) {
      if (block.type !== 'text') {
        content.push(block)
        continue
      }
      if (remaining <= 0) {
        truncated = true
        continue
      }
      if (block.text.length <= remaining) {
        content.push(block)
        remaining -= block.text.length
        continue
      }
      truncated = true
      content.push({ type: 'text', text: `${block.text.slice(0, Math.max(0, remaining - 1))}…` })
      remaining = 0
    }
    // Rebuilt through the canonical constructor so the bounded notice is a real
    // message with its original source attribution, not a hand-made object.
    return {
      message: createUserMessage({ content, source: message.source }),
      chars: text.length,
      truncated,
    }
  }

  /** Ferry one settled call's control and content slots, in commit order. */
  const ferry = (call: PendingCall, result: ToolExecutionResult): void => {
    // CONTROL SLOT. `additionalContexts` and `concludesTurn` are the signals a
    // security policy or a terminal tool produces; they keep their semantics
    // and are bounded in SIZE, never dropped.
    for (const context of result.additionalContexts ?? []) {
      const bounded = boundNotice(context)
      if (noticeRecords.length < maxNotices) {
        control.deferContext(bounded.message)
        noticeRecords.push({
          tool: call.name, callId: call.subCallId,
          chars: bounded.chars, truncated: bounded.truncated, coalesced: false,
        })
        continue
      }
      // Past the direct bound the notice is still accounted for: its bounded
      // head is coalesced into one notice at close, so nothing disappears
      // without a record.
      suppressedNotices.push(`${call.name}: ${bounded.message.content
        .map(block => block.type === 'text' ? block.text : `[${block.type}]`).join('').slice(0, 200)}`)
    }
    // Only a SUCCESSFUL result can carry the terminal marker (ToolExecutionFailure
    // types it never), so a policy-converted failure cannot stop the turn
    // through a recovering program.
    if (result.concludesTurn === true) control.concludeTurn()

    if (result.isError) return

    // CONTENT SLOT. A non-text payload is bulk data, not a control notice. It
    // must not ride into model context automatically.
    const payload = result.content.filter(block => block.type !== 'text')
    if (payload.length === 0) return
    if (contentProjection === 'defer-images') {
      // Stock `run_code` semantics, preserved verbatim for comparison: an
      // image-bearing successful nested result is deferred as one user message
      // carrying the whole content array.
      if (result.content.some(block => block.type === 'image')) {
        control.deferContext(createUserMessage({
          content: result.content,
          source: { kind: 'plugin', plugin: 'programmatic-scope' },
        }))
      }
      return
    }
    // PROJECT, do not assert. The runtime's own lossless-JSON gate is asked, so
    // "can this payload be recovered byte-for-byte?" is ANSWERED rather than
    // assumed. See `RetainedPayloadEnvelope` for why a false answer is recorded
    // rather than cast away.
    const blockTypes = payload.map(block => block.type)
    const lossless = isLosslessJsonValue(payload)
    const envelope: RetainedPayloadEnvelope = {
      schemaVersion: 1,
      blockTypes,
      // `snapshotJsonValue` detaches the same value the gate just admitted, so
      // the retained copy shares nothing with the tool's live result.
      blocks: lossless ? (snapshotJsonValue(payload) ?? null) : null,
      lossless,
    }
    pendingPayloads.push({
      tool: call.name,
      callId: call.subCallId,
      mediaType: 'application/json',
      bytes: new TextEncoder().encode(JSON.stringify(envelope)),
      blockTypes,
      lossless,
    })
  }

  const flushPayloads = async (): Promise<void> => {
    while (pendingPayloads.length > 0) {
      const entry = pendingPayloads.shift()
      /* v8 ignore next -- the loop condition and the shift are the same check. */
      if (entry === undefined) return
      const reference = await retainBytes(references, entry.tool, entry.callId, entry.mediaType, entry.bytes)
      contentRecords.push({
        tool: entry.tool,
        callId: entry.callId,
        blockTypes: entry.blockTypes,
        bytes: reference.bytes,
        lossless: entry.lossless,
        reference,
      })
    }
  }

  /**
   * The single ordered lane. Each pass commits the head-of-line settled call
   * (ordered control ferrying), then starts the next queued call if its slot is
   * free, and otherwise sleeps until a body settles or a new submission
   * arrives. Reaching the empty-queues/empty-pool state is quiescence.
   *
   * A nested call is never IN this queue: it was admitted at `invoke` time, so
   * the lane only ever sees it in `commitQueue`. That is what removes the
   * circular wait of BRG-06 — a call made from inside a tool body cannot be
   * waiting for the slot its own caller holds.
   */
  const drive = (): Promise<void> => {
    if (driving) return driverRun
    driving = true
    driverRun = (async () => {
      try {
        for (;;) {
          // Create the wakeup promise before inspecting state so a settle or
          // submission arriving between the checks and the await cannot be lost.
          const wait = new Promise<void>((resolve) => { wake = resolve })
          const commitHead = commitQueue[0]
          if (commitHead !== undefined && commitHead.settled) {
            commitQueue.shift()
            await commitHead.commit()
            // The barrier covers commit: later starts wait for the exclusive
            // call's full pipeline, as under the native loop.
            if (commitHead.mode === 'exclusive') exclusiveActive = false
            continue
          }
          const head = pendingQueue[0]
          if (head !== undefined) {
            if (closed || runController.signal.aborted) {
              pendingQueue.shift()
              head.abandon()
              continue
            }
            // Reclassify at start time (fail-closed on registry changes while queued).
            const mode = head.classify()
            const capacity = !exclusiveActive
              && (mode === 'exclusive' ? poolCount === 0 : poolCount < maxParallel)
            if (capacity) {
              if (mode === 'exclusive') exclusiveActive = true
              head.mode = mode
              pendingQueue.shift()
              // Joined before start() so the commit cursor sees submission order,
              // and counted before start() so a body that settles in the same
              // microtask cannot decrement an un-incremented pool.
              commitQueue.push(head)
              poolCount++
              await head.start()
              continue
            }
          }
          if (pendingQueue.length === 0 && commitQueue.length === 0 && poolCount === 0) return
          await wait
        }
      } finally {
        driving = false
        wake = undefined
      }
    })()
    return driverRun
  }

  /**
   * Account for one accepted call: it leaves the set only when its pipeline has
   * settled AND its commit (control ferrying, payload retention, disposition)
   * has run, so the drain cannot report quiescence with a commit outstanding.
   */
  const track = (call: PendingCall): void => {
    void call.body.then(() => {
      if (call.mode !== undefined) poolCount--
      wakeup()
    })
  }

  /** Wait until every accepted call has settled and committed. */
  const drain = async (): Promise<void> => {
    // The lane may need to run again after a body settles (to commit it), and a
    // nested call commits outside the lane entirely; so loop until BOTH the
    // lane is quiescent and no accepted call is outstanding.
    for (;;) {
      await drive()
      const outstanding = [...accepted]
      if (outstanding.length === 0) return
      await Promise.allSettled(outstanding.map(call => call.body))
      await drive()
      if (accepted.size === 0) return
    }
  }

  const scope: ProgrammaticCallScopeHandle = {
    references,
    names: () => registry.schemas(agent)
      .map(schema => schema.name)
      .filter(name => name !== RUN_CODE_NAME),
    read: async (reference) => {
      const bytes = await references.read(reference.id)
      return bytes === undefined ? undefined : new TextDecoder().decode(bytes)
    },
    dispositions: () => Object.freeze([...reported]),
    notices: () => Object.freeze([...noticeRecords]),
    content: () => Object.freeze([...contentRecords]),

    invoke: <T extends JsonValue = JsonValue>(name: string, args: JsonValue, delivery: Delivery): Promise<T> => {
      if (closed) {
        return Promise.reject(new Error(
          `programmatic scope is closed (${String(closeReason)}); "${name}" not dispatched`,
        ))
      }
      // Arguments are detached ONCE here; the registry detaches again for its
      // own execution, so a tool mutating its args cannot desync the two.
      // `snapshotJsonValue` is generic over its input, so the result is already
      // `JsonValue | undefined` and needs no assertion: `undefined` IS the
      // runtime's own "not losslessly JSON" answer.
      let detached: JsonValue | undefined
      try {
        detached = snapshotJsonValue(args)
      } catch (error: unknown) {
        return Promise.reject(new Error(
          `programmatic scope: tool arguments must be lossless JSON: ${error instanceof Error ? error.message : String(error)}`,
        ))
      }
      if (detached === undefined) {
        return Promise.reject(new Error('programmatic scope: tool arguments must be lossless JSON'))
      }
      // Read in the CALLER's context, which is the only place the answer is
      // about this call (see `activeBodies`).
      const nested = activeBodies.getStore()?.has(scope) === true
      const subCallId = ToolCallId(`${callIdPrefix}:scope:${String(++dispatches)}`)
      const input: ToolExecutionInput = {
        callId: subCallId,
        ...rootCallId === undefined ? {} : { rootCallId: ToolCallId(rootCallId) },
        name,
        arguments: detached,
        ...agent === undefined ? {} : { agent },
        parent,
        signal: runController.signal,
      }

      return new Promise<T>((resolve, reject) => {
        let parked: ToolExecutionResult | undefined
        // Settled by the pipeline result (or by abandonment), never rejected:
        // the drain awaits it, and a rejection would surface as an unhandled
        // rejection for a call whose own promise already carries the failure.
        let markBodyDone!: () => void
        const body = new Promise<void>((done) => { markBodyDone = done })
        const call: PendingCall = {
          subCallId,
          name,
          delivery,
          nested,
          input,
          args: detached,
          body,
          markBodyDone,
          flight: Promise.resolve(),
          settled: false,
          // Re-read per driver pass against the same live registry view.
          classify: () => registry.executionMode(input).kind,
          async start(): Promise<void> {
            // The marker is pushed for the WHOLE pipeline, so a tool body that
            // calls back into this scope (or another scope) is recognised as
            // nested and never queues behind its own parent.
            const enclosing = activeBodies.getStore() ?? new Set<object>()
            const next = new Set(enclosing)
            next.add(scope)
            this.flight = activeBodies.run(next, () => registry.execute(input)).then(
              (result) => {
                parked = result
                this.settled = true
                this.parked = result
                markBodyDone()
                // The program gets its value NOW: control ferrying and payload
                // retention stay in the ordered lane and must never delay it.
                if (result.isError) {
                  reject(new Error(result.error.message))
                  return
                }
                if (delivery === 'value') {
                  const bytes = jsonBytes(result.value)
                  if (bytes > valueBudgetBytes) {
                    // Over budget: refuse explicitly and hand back the retained
                    // result. The effect is NOT repeated to make it fit.
                    void retainResult(references, name, subCallId, false, result.value)
                      .then(reference => reject(new ScopeDeliveryBudgetError(name, bytes, valueBudgetBytes, reference)), reject)
                    return
                  }
                  resolve(result.value as T)
                  return
                }
                void retainResult(references, name, subCallId, false, result.value)
                  .then(reference => resolve(reference as unknown as T), reject)
              },
              (error: unknown) => {
                this.settled = true
                markBodyDone()
                reject(error)
              },
            )
          },
          async commit(): Promise<void> {
            accepted.delete(this)
            if (parked === undefined) {
              // Abandoned before starting: `abandon` already reported it.
              return
            }
            ferry(this, parked)
            await flushPayloads()
            // The disposition describes THIS CALL's outcome, not the scope's
            // lifecycle phase. Reading the scope's `closed` flag here would
            // misreport a call that completed successfully while a drain was
            // running as cancelled, because `close()` sets that flag before the
            // lane has finished committing what already ran.
            //
            // The registry's own cancellation codes are the authority: a result
            // the abort replaced carries ABORTED or ABORTED_BEFORE_DISPATCH, and
            // anything else settled — including a tool's own failure, which is a
            // settled outcome with an error, not a cancellation.
            const aborted = parked.isError
              && (parked.error.info?.code === TOOL_ABORTED
                || parked.error.info?.code === TOOL_ABORTED_BEFORE_DISPATCH)
            report(aborted
              ? {
                subCallId, name, delivery, nested, disposition: 'cancelled',
                ...closeReason === undefined ? {} : { closeReason },
              }
              : { subCallId, name, delivery, nested, disposition: 'settled' })
          },
          abandon(): void {
            accepted.delete(this)
            // The pipeline will never run for this call, so nothing else will
            // settle its body; the drain awaits that body and would otherwise
            // wait forever on a call that was deliberately refused.
            markBodyDone()
            const handed = handoffToJobs?.({ subCallId, name, args: detached })
            if (handed !== undefined) {
              // A call that never started has produced no effect, so handing it
              // to the job registry is ownership transfer, not re-execution.
              report({ subCallId, name, delivery, nested, disposition: 'handed-to-jobs', jobId: handed.jobId })
              reject(new Error(
                `programmatic scope closed (${String(closeReason)}); "${name}" was handed to job ${handed.jobId} before starting`,
              ))
              return
            }
            report({
              subCallId, name, delivery, nested, disposition: 'abandoned-unstarted',
              ...closeReason === undefined ? {} : { closeReason },
            })
            reject(new Error(
              `programmatic scope closed (${String(closeReason)}); "${name}" was abandoned before starting`,
            ))
          },
        }
        accepted.add(call)
        if (nested) {
          // IMMEDIATE ADMISSION. The enclosing call already holds a pool slot,
          // and waiting for a second slot from the same pool is the circular
          // wait BRG-06 forbids. The call still commits through the ordered
          // lane, so control ferrying stays in submission order.
          commitQueue.push(call)
          track(call)
          void call.start()
          wakeup()
          void drive()
          return
        }
        pendingQueue.push(call)
        track(call)
        wakeup()
        void drive()
      })
    },

    close: async (reason: ScopeCloseReason): Promise<void> => {
      if (closed) {
        // Idempotent: the second close waits for the same drain and adds no
        // second disposition for any call.
        await drain()
        return
      }
      closed = true
      closeReason = reason
      runController.abort(`programmatic scope closed (${reason})`)
      wakeup()
      // The driver abandons queued-unstarted calls, awaits the live pool, and
      // drains the ordered commit lane, including a commit already in progress.
      await drain()
      await flushPayloads()
      if (suppressedNotices.length > 0) {
        // One bounded notice accounts for everything coalesced, so a security
        // notice is never silently absent from the enclosing execution.
        const summary = `${String(suppressedNotices.length)} further control notice(s) were coalesced past the `
          + `${String(maxNotices)}-notice bound; first lines: ${suppressedNotices.join(' | ')}`
        const bounded = boundNotice(createUserMessage({
          content: [{ type: 'text', text: summary }],
          source: { kind: 'plugin', plugin: 'programmatic-scope' },
        }))
        control.deferContext(bounded.message)
        noticeRecords.push({
          tool: '*', callId: '*', chars: bounded.chars, truncated: bounded.truncated, coalesced: true,
        })
        suppressedNotices.length = 0
      }
      signal.removeEventListener('abort', onOuterAbort)
    },
  }

  return scope
}
