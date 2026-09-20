/**
 * The native-tool callback bridge: how Python running INSIDE the IPython kernel
 * calls DSH's native tools through the real public `ToolRuntime` pipeline.
 *
 * WHY THIS EXISTS. Without it a cell is a dead end. It can compute, but it
 * cannot reach a native tool, so any bulk data a tool produces has to be
 * round-tripped through the model's context -- the exact cost the architecture's
 * "persistent IPython is the primary programmable execution surface" decision
 * exists to remove. A cell that can do
 *
 *     rows = await dsh.call('read', {'file_path': 'big.csv'})
 *
 * keeps the bytes in Python and sends only a bounded projection to the model.
 *
 * WHAT IT IS NOT. It is NOT a second tool registry and NOT a second policy
 * pipeline. The host translates every request into one
 * `ctx.tools.execute(...)` call, which is the registry's own public composition
 * of the same staged functions the private PTC symbol exposes
 * (`qualification/results/M2-scope/PUBLIC-PIPELINE-VERIFIED.md`). So
 * `tools/pre-execute`, monotonic guards, the approval `ask` seam, canonical
 * output validation, `tools/post-execute`, `finalizeContent` and the
 * `tools/result` notification are literally the same code the model's own native
 * calls run. There is no second pipeline to drift.
 *
 * THE AUTHORITY RULE, WHICH IS THE POINT OF THIS FILE.
 *
 * Python may choose exactly two things: WHICH tool, and WHAT arguments. It may
 * not choose `agent`, `session`, `rootCallId`, or the parent execution token.
 * Those are read from the host's binding to the live `exec` and stamped onto the
 * request here. A frame that even MENTIONS one of them is rejected outright
 * rather than having the field ignored, because silently dropping a field a peer
 * believed was authoritative is how a forgery attempt becomes invisible.
 *
 * This matters even in a trusted-local, no-sandbox deployment. It is not about
 * OS confinement; it is about WHICH TOOL POLICY APPLIES. If Python could name an
 * Agent or Session, it could make a call that is scoped to a different
 * workspace, a different approval subject, or a different filesystem root.
 *
 * THE LIFECYCLE RULE. The capability is valid only while the owning cell is
 * alive. A lease is minted immediately before a cell is dispatched and closed
 * when that cell settles, and closing DRAINS in-flight calls before it returns.
 * A callback arriving after settlement is rejected with `CELL_LEASE_EXPIRED`, and
 * the other staleness channels are rejected separately so a reader can tell them
 * apart: a mismatched kernel `epoch`, a mismatched `cellId`, an unknown lease id,
 * and a host disposal that is not a cell settlement (`LEASE_REVOKED`). A
 * background thread that outlives its cell therefore cannot invoke a native tool
 * with stale authority; long-lived work must go through DSH Jobs/subagents or a
 * fresh live cell.
 *
 * THE LEASE STATES, AND WHY A BOOLEAN WAS NOT ENOUGH. `OPEN -> CLOSING ->
 * CLOSED` (V3 §J3). The intermediate state is what makes "stop accepting new
 * calls" and "every started call has reached quiescence" two DIFFERENT facts a
 * reader can observe, instead of one flag that flips somewhere in between. A
 * call refused in `CLOSING` and a call refused in `CLOSED` are the same refusal
 * to a program and different facts to an auditor.
 *
 * THE DISPOSITION RECORD, WHICH IS THE HALF THAT WAS MISSING. `BR-07`'s oracle
 * requires that every in-flight call carry one disposition from `settled` /
 * `cancelled` / `handed-to-jobs` / `abandoned-unstarted`, that a call handed to
 * Jobs name its job id, and that "nothing continues silently in the background
 * with no record". Before this change the lease drained correctly (a `revoke`
 * waited 1499 ms for an in-flight call) and recorded NOTHING about what became of
 * it, so a reader could not tell settled from cancelled from abandoned. The four
 * names and their meanings are copied from `packages/dsh-daily-work/src/
 * programmatic-scope.ts` so the repository has ONE vocabulary rather than two;
 * see `bridge-ledger.ts` for why the record is a storage-domain ledger and not a
 * custom Session event.
 *
 * THE SERIAL BASELINE. Each lease owns a FIFO exact-tool-call queue and runs it
 * ONE AT A TIME (V3 §J1). Public `ctx.tools.execute()` runs one complete
 * ToolRuntime call and does NOT expose the native/PTC sibling scheduler, so
 * concurrent `execute()` calls cannot be claimed to have native scheduling
 * parity; and the private `TOOL_RUNTIME_SCHEDULER` symbol is a module-local
 * `Symbol()` that a second physical copy of the package makes undefined
 * (upstream Discussion #6529), so it must never be imported. Serial execution is
 * therefore the honest baseline, and it has a second consequence this file
 * relies on: deferred contexts are emitted in subcall order for free, because
 * the calls settle in that order.
 *
 * TRANSPORT. The kernel is a GRANDCHILD of the host (host -> broker -> kernel),
 * so the broker's inherited control descriptor is not available to it, and
 * Python on this platform has no `AF_UNIX` (`socket.AF_UNIX` is absent from the
 * Windows build). The kernel therefore connects OUT to a loopback listener the
 * HOST owns, which keeps the listener count at exactly one and puts it in the
 * process that holds the authority. Frames are length-prefixed JSON, reusing
 * `protocol.ts`'s framing so both channels are bounded by the same rule and a
 * peer cannot make the other side allocate an unbounded buffer.
 *
 * WHAT THE LOOPBACK CHANNEL DOES AND DOES NOT PROVE. A per-kernel random token
 * is delivered to the kernel in the cell preamble, so another local process
 * cannot inject calls by guessing a port. It is NOT a confidentiality boundary
 * against code running in the kernel, which already holds the token by
 * construction -- such code can send whatever frames it likes, and the only
 * thing that stops it from gaining authority is the host-side stamping and lease
 * validation described above. That is stated rather than implied, because
 * "authenticated channel" would otherwise be read as more than it is.
 *
 * WHY THE PYTHON CLIENT IS A STRING HERE RATHER THAN A FILE. It is written into
 * the host-owned kernel scratch directory at start and referenced by absolute
 * path, so it lives outside the Session's project directory where a cell's
 * relative paths resolve. Keeping the source in this module means the wire
 * contract and the code that speaks it cannot be shipped apart, which is the
 * same reason `protocol.ts` owns both the encoder and the decoder.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { createServer, type Server, type Socket } from 'node:net'
import { join } from 'node:path'
import { encodeFrame, FrameDecoder, FrameError, MAX_FRAME_BYTES } from './protocol.ts'
import {
  digestOf,
  type BridgeCloseReason,
  type BridgeDisposition,
  type BridgeLedger,
} from './bridge-ledger.ts'

/**
 * Wire version. A kernel holding a client from a different version is refused
 * rather than negotiated with: the two sides disagree about which fields are
 * authority-bearing, and guessing would defeat the forgery check below.
 */
export const BRIDGE_PROTOCOL_VERSION = 1

/**
 * Largest canonical tool value delivered INLINE to Python.
 *
 * Below {@link MAX_FRAME_BYTES} on purpose: the value is wrapped in a result
 * envelope, so a value sized exactly at the frame limit would be rejected by the
 * frame encoder as the envelope pushed it over. 1 MiB leaves room for the
 * envelope, the tool name, and the request id while still being far more than a
 * model-facing projection would ever carry.
 */
export const DEFAULT_INLINE_VALUE_BYTES = 1024 * 1024

/** How long one nested call may run before the bridge gives up on the reply. */
export const DEFAULT_CALL_TIMEOUT_MS = 120_000

/**
 * Fields Python is FORBIDDEN to assert.
 *
 * Checked as a rejection, not as an ignore. A peer that sends `agent` has a
 * different model of who is calling than this host does, and that disagreement
 * is exactly the condition under which a forged-authority call would otherwise
 * succeed quietly.
 */
const FORBIDDEN_FIELDS = ['agent', 'session', 'sessionId', 'rootCallId', 'parent', 'parentToken', 'authority'] as const

/** The Python client, written to the host-owned scratch directory at kernel start. */
export const BRIDGE_CLIENT_FILENAME = 'dsh_bridge_client.py'

/**
 * A structured bridge failure, as it reaches Python.
 *
 * `code` is the machine-readable classification and is stable; `message` is the
 * human-facing text and may carry a policy's own words. The two are separate so
 * a caller can branch on the code without parsing prose, and so a policy denial
 * keeps the reason its author wrote rather than being flattened into "error".
 */
export interface BridgeFailure {
  readonly code: string
  readonly message: string
}

/**
 * A canonical result too large to deliver inline.
 *
 * The bytes were written ONCE by the host from the SAME single execution that
 * produced the value -- the tool is never re-run to make a result fit. Python
 * receives a typed reference and reads the exact bytes back through the project's
 * own artifact plane, so a bounded model projection and a lossless data plane
 * coexist without either one lying about the other.
 *
 * ── WHY `artifact` AND NOT `path` IS THE IDENTITY (V5 §12 / §2.P) ──────────
 *
 * This interface used to carry a raw host path and nothing else, and Python
 * opened that path directly. That made the PATH the authority: nothing bound the
 * bytes to the observation, the grant, the scope or the digest, and a caller
 * could read, move, replace or truncate the file with its own privileges and the
 * reference would still look valid. The digest was checked only by a method the
 * caller chose to invoke.
 *
 * `artifact` is the project's own reference format (`artifact:sha256:<digest>`,
 * `artifacts.ts:artifactRefOf`). It carries identity, so paging it goes through
 * the unified plane's cursor, realm, quota and provenance checks rather than
 * through whatever the filesystem happens to say.
 */
export interface BridgeArtifact {
  /**
   * The typed reference. THE identity-bearing field; `artifact:sha256:<digest>`.
   *
   * Present on both planes, so a reader can always tell WHICH object was meant
   * even when the bytes were retained by the bridge's own scratch directory.
   */
  readonly artifact: string
  /**
   * Which plane retained these bytes.
   *
   * `unified` -- the project Artifact/Attachment store, reached through
   * {@link BridgeArtifactRetention}. No host path is emitted at all.
   * `bridge-scratch` -- the per-kernel directory, used only when the composition
   * configured no retention port. Recorded rather than hidden, because a reader
   * asking "which retention policy applied to this result?" must not have to
   * infer it from whether a field happens to be present.
   */
  readonly plane: 'unified' | 'bridge-scratch'
  /**
   * Raw host path, ONLY on the `bridge-scratch` plane.
   *
   * NOT authority, and deliberately optional so that the unified plane cannot
   * leak one by accident: a consumer that reads this must be able to name the
   * plane it came from.
   */
  readonly path?: string
  readonly bytes: number
  readonly sha256: string
}

/**
 * How the host retains one oversized exact result, as the COMPOSITION supplies it.
 *
 * WHY A PORT AND NOT AN IMPORT. The unified plane lives in `dsh-daily-work`
 * (`artifacts.ts`), and `dsh-ipython` has no dependency on that package -- adding
 * one would put the data plane's whole transitive surface under the kernel plugin
 * and invert the layering the audit asks for. The composition mounts both, so the
 * composition is where the ONE store is bound to this port. This is an interface,
 * not a second registry: exactly one implementation exists, it is the project's
 * own `AttachmentArtifactStore`, and nothing here re-implements quota, retention,
 * provenance or paging.
 *
 * `put` MUST be the plane's own content-addressed write, so the returned
 * `artifact` is the reference that plane's `pages()` accepts.
 */
export interface BridgeArtifactRetention {
  /**
   * Retain these exact bytes and return the plane's own reference.
   *
   * @param bytes - the canonical JSON, already serialized once by the host.
   * @param context - which tool and call produced them, for provenance.
   */
  retain(bytes: Uint8Array, context: { readonly tool: string, readonly callId: string }): Promise<{
    readonly artifact: string
    readonly sha256: string
    readonly bytes: number
  }>
}

/** What the host returns for one nested call. Exactly one of the three arms. */
export type NativeCallOutcome =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: true; readonly artifact: BridgeArtifact }
  | { readonly ok: false; readonly error: BridgeFailure }

/**
 * The reserved tool-name prefix that marks a `dsh.data` request (V5 §5.1).
 *
 * WHY THE CONSTANT IS DEFINED HERE AND NOT IMPORTED. `data-bridge.ts` owns the
 * router and `DATA_TOOL_PREFIX` is its constant, but this package cannot import
 * it: `dsh-ipython` does not depend on `dsh-daily-work`, the two packages are
 * `link:`ed into a profile as siblings, and a static import of the other
 * package's specifier does NOT resolve from this package's own realpath
 * (MEASURED: `createRequire` from `packages/dsh-ipython/lib/bridge.js` ->
 * `MODULE_NOT_FOUND`). The dependency direction is deliberate and documented in
 * `data-bridge.ts`: the integration point depends on the plane, and the plane
 * stays loadable without a kernel.
 *
 * So the prefix exists in two packages on purpose, and the agreement between
 * them is held by a TEXT-level gate rather than by an import
 * (`data-routing.test.ts` reads both sources and compares the two constants).
 * That is the same instrument this repository already uses to bind the Python
 * client's `_PREFIX` to `DATA_TOOL_PREFIX` without a cross-package import.
 *
 * A colon cannot appear in a DSH tool name, so the prefix is un-collidable by
 * construction: a name beginning `data:` is never a tool, which is what makes
 * "route it to the data plane" a total function rather than a convention.
 */
export const DATA_TOOL_PREFIX = 'data:'

/** Whether a bridge call's tool name is a `dsh.data` request rather than a tool. */
export function isDataRequest(tool: string): boolean {
  return tool.startsWith(DATA_TOOL_PREFIX)
}

/**
 * The second internal dispatcher a lease may hold (V5 §5.1).
 *
 * ONE frame shape, ONE name field, TWO internal lanes. The host supplies this
 * alongside the exact-tool handler; a `data:*` name goes here and NEVER to
 * `ctx.tools.execute`, because a fall-through would make an unknown data
 * operation look like a tool call -- the exact conflation the reserved prefix
 * exists to prevent.
 *
 * It returns the same `NativeCallOutcome` shape as the tool lane, so the
 * accepted-call state machine, the idempotency table and the durable ledger are
 * shared rather than duplicated.
 */
export type DataCallHandler = (
  call: NativeCallRequest,
  context: ExactCallContext,
) => Promise<NativeCallOutcome>

/** One nested call, as the host validated it and bound it to a live execution. */
export interface NativeCallRequest {
  /** Python-minted, unique within the connection. A repeat is a protocol error. */
  readonly requestId: string
  readonly tool: string
  readonly arguments: unknown
  /** Echoed by Python; must equal the live lease's cell id. */
  readonly cellId: string
  /** Echoed by Python; must equal the live kernel epoch. */
  readonly epoch: number
  /** The lease Python believes it holds. Must be the live one. */
  readonly leaseId: string
}

/** The lease's lifecycle state. See the module docstring for why this is not a boolean. */
export type LeaseState = 'OPEN' | 'CLOSING' | 'CLOSED'

/**
 * Why a lease was refused. Every arm is a distinct, testable rejection.
 *
 * `CELL_LEASE_EXPIRED` is the STABLE, PROGRAM-FACING code for "the cell that
 * held this capability has settled". V3 §J3 names it verbatim: background Python
 * using an old lease must get a stable `CELL_LEASE_EXPIRED` rather than whichever
 * internal reason happened to fire. The finer internal reason is kept as `detail`
 * on the rejection (and in the ledger), so the distinction is not lost for an
 * auditor while a program still branches on one code.
 *
 * `LEASE_REVOKED` remains for the one case that is NOT a cell settlement: the
 * HOST disposed the kernel or the bridge while the lease was live. Collapsing it
 * into `CELL_LEASE_EXPIRED` would tell a program its cell had settled when in
 * fact its kernel was shut down underneath it, which is a different fact with a
 * different remedy.
 *
 * `LEASE_LEDGER_UNAVAILABLE` is the durable-intent arm (V5 §6.2): the STARTED
 * write did not commit, so the call was NEVER ACCEPTED and NEVER DISPATCHED. It
 * is a distinct code because it is a distinct fact with a distinct remedy --
 * a transient storage failure the caller may retry, as opposed to an authority
 * refusal that no retry can fix. Collapsing it into the generic `BRIDGE_FAILED`
 * would leave a program unable to tell "my capability is gone" from "the host
 * could not write its record and nothing happened".
 */
export type LeaseRejectionCode =
  | 'CELL_LEASE_EXPIRED'
  | 'LEASE_REVOKED'
  | 'LEASE_UNKNOWN'
  | 'LEASE_ABORTED'
  | 'EPOCH_MISMATCH'
  | 'CELL_MISMATCH'
  | 'REQUEST_ID_CONFLICT'
  | 'FORGED_AUTHORITY'
  | 'TOOL_NAME_INVALID'
  | 'ARGUMENTS_NOT_JSON'
  | 'LEASE_LEDGER_UNAVAILABLE'
  | 'BRIDGE_CLOSED'

/** A refusal, carrying the code and the values that disagreed. */
export class LeaseRejection extends Error {
  readonly code: LeaseRejectionCode
  /**
   * The internal reason this lease is no longer usable, when the code is a
   * coarse one. It is NOT sent to Python: it is for the host's own ledger and
   * log, where a reader wants the fine distinction the program does not need.
   */
  readonly detail: string | undefined

  constructor(code: LeaseRejectionCode, message: string, detail?: string) {
    super(message)
    this.name = 'LeaseRejection'
    this.code = code
    this.detail = detail
  }
}

/**
 * A lease closed but could NOT record every disposition durably.
 *
 * WHY THIS IS AN ERROR AND NOT A LOG LINE. `BR-07`'s oracle is about the RECORD:
 * "nothing continues silently in the background with no record". A close whose
 * ledger writes failed has exactly that property -- the calls settled, and what
 * became of them is not written down -- so reporting the close as clean would be
 * the defect the oracle names, one level down. The lease is still CLOSED (that
 * fact is about the lease, not the ledger), and this error is what stops a caller
 * from mistaking "closed" for "recorded".
 */
export class BridgeLedgerWriteError extends Error {
  readonly leaseId: string
  /** Which dispositions are missing, so a reader knows what was lost. */
  readonly unrecorded: readonly { subCallId: string, disposition: BridgeDisposition, reason: string }[]

  constructor(leaseId: string, unrecorded: readonly { subCallId: string, disposition: BridgeDisposition, reason: string }[]) {
    super(
      `cell lease ${leaseId} closed but ${String(unrecorded.length)} disposition(s) could not be recorded durably: `
      + unrecorded.map(entry => `${entry.subCallId} (${entry.disposition}): ${entry.reason}`).join('; '),
    )
    this.name = 'BridgeLedgerWriteError'
    this.leaseId = leaseId
    this.unrecorded = Object.freeze([...unrecorded])
  }
}

/**
 * Host-bound authority for one cell. NONE of this comes from Python.
 *
 * `handler` closes over the live `exec`, so the Agent, the Session, the root
 * call id, the parent token and the cancellation signal are the ones the
 * registry itself attached to the enclosing `ipython` call.
 */
export interface CellLeaseInput {
  readonly sessionId: string
  readonly cellId: string
  readonly epoch: number
  /**
   * Run one accepted call. The second argument is the HOST's identity for it, so
   * the handler never has to invent a subcall id and cannot disagree with the
   * ledger about which call it is running.
   */
  readonly handler: (call: NativeCallRequest, context: ExactCallContext) => Promise<NativeCallOutcome>
  /**
   * The SECOND internal dispatcher: `dsh.data` (V5 §5.1).
   *
   * ABSENT MEANS REFUSED, NEVER FALLEN THROUGH. A lease with no data handler
   * refuses a `data:*` call with `DATA_NO_CAPABILITY`; it does NOT pass the name
   * to `ctx.tools.execute`. A fall-through would make an unknown data operation
   * indistinguishable from a tool call, which is the conflation the reserved
   * prefix exists to prevent -- and it would also make a typo into a real tool
   * dispatch.
   *
   * Optional because a composition may mount no data plane: the kernel service
   * is a valid product without one, and refusing the lane is the honest outcome
   * rather than a capability outage that takes the tool lane down with it.
   */
  readonly dataHandler?: DataCallHandler
  /** Cell-scoped cancellation. An aborted lease accepts no new calls. */
  readonly signal?: AbortSignal
  /** The outer model `ipython` call this lease was minted for. Recorded on every ledger row. */
  readonly outerCallId: string
  /** The outer execution's root call id. Recorded on every ledger row. */
  readonly rootCallId: string
  /** Where the durable intent/settlement rows and dispositions go. */
  readonly ledger: BridgeLedger
  /**
   * The host handoff for calls that had NOT started when the lease closed.
   *
   * ABSENT MEANS REFUSED, NEVER SILENTLY RUN — the same rule
   * `programmatic-scope.ts` states for its own handoff. A composition with no
   * Jobs service therefore records `abandoned-unstarted`, which is a truthful
   * account of what happened rather than a fabricated success.
   */
  readonly handoffToJobs?: (call: { subCallId: string, name: string, args: unknown }) => { jobId: string } | undefined
  /** Host-owned disposition sink, so the enclosing log records the drain too. */
  readonly onDisposition?: (disposition: LeaseCallDisposition) => void
  /**
   * The controller whose signal the HOST already handed to the exact-call
   * dispatcher. Closing the lease aborts THIS controller.
   *
   * WHY THE HOST SUPPLIES IT RATHER THAN THE LEASE OWNING ONE. The signal that
   * must be aborted at close is the one the registry call is already holding, and
   * that signal has to exist before the handler is built -- which is before the
   * lease is constructed, because the handler is a construction input. Letting the
   * lease mint its own controller would therefore produce a SECOND signal that no
   * in-flight call is listening to, so a close would refuse new calls while an
   * already-started call ran on unbounded. One controller, supplied by the host
   * and aborted by the lease, is what makes "abort lease-owned calls" (V3 §J3 step
   * 2) true of the calls that are actually running.
   */
  readonly controller?: AbortController
}

/**
 * What the host tells a handler about the call it is about to run.
 *
 * `subCallId` is minted by the LEASE, from the enclosing call id and the lease's
 * own monotonic sequence, so it is correlatable with the `ipython` execution in
 * the session log and cannot be chosen by a program.
 */
export interface ExactCallContext {
  readonly subCallId: string
  /** Monotonic within the lease, starting at 1. */
  readonly sequence: number
}

/**
 * One call's disposition, as the lease reports it.
 *
 * The vocabulary and the `jobId`-exactly-when-handed rule are copied from
 * `programmatic-scope.ts`'s `ScopeCallDisposition`; see the module docstring.
 */
export interface LeaseCallDisposition {
  readonly subCallId: string
  readonly name: string
  readonly disposition: BridgeDisposition
  /** Present exactly when `disposition` is `handed-to-jobs`. */
  readonly jobId?: string
  readonly closeReason?: BridgeCloseReason
  /** True when the call had been dispatched to the registry when the close began. */
  readonly started: boolean
}

/** One accepted call's mutable state, held in the lease's FIFO. */
/** The two internal lanes one lease dispatches to. See {@link DataCallHandler}. */
export type BridgeLane = 'tool' | 'data'

interface AcceptedCall {
  readonly call: NativeCallRequest
  readonly subCallId: string
  readonly sequence: number
  /**
   * WHICH INTERNAL DISPATCHER runs this call (V5 §5.1).
   *
   * Chosen ONCE, at acceptance, from the name's reserved prefix, and carried on
   * the accepted call so the runner cannot disagree with the router about it. A
   * lane re-derived at dispatch time would be a second decision point, and two
   * decision points are how a `data:*` name ends up in the tool registry.
   */
  readonly lane: BridgeLane
  /** The exact normalized arguments, so a duplicate can be recognised losslessly. */
  readonly argsDigest: string
  /** Resolved with the outcome. A duplicate submission joins THIS promise. */
  readonly settled: Promise<NativeCallOutcome>
  readonly resolve: (outcome: NativeCallOutcome) => void
  readonly reject: (error: unknown) => void
  started: boolean
}

/**
 * One live cell's capability.
 *
 * `inFlight` is what makes closing a real barrier rather than a flag: a nested
 * call that was already accepted when the cell settled is awaited before `close`
 * resolves, so the host never reports a cell finished while a tool call it
 * authorised is still running.
 *
 * THE FIFO IS THE SERIAL BASELINE. Every accepted call is executed one at a
 * time, in bridge-accepted order, because public `ctx.tools.execute()` runs one
 * complete ToolRuntime call and does not expose the native scheduler. See the
 * module docstring. The queue is also why a duplicate submission can be
 * answered from the first call's own promise instead of being dispatched twice.
 */
export class CellLease {
  readonly id: string
  readonly sessionId: string
  readonly cellId: string
  readonly epoch: number
  readonly outerCallId: string
  readonly rootCallId: string
  private readonly handler: (call: NativeCallRequest, context: ExactCallContext) => Promise<NativeCallOutcome>
  /**
   * The data lane's dispatcher, or undefined when the composition mounted no
   * data plane. See {@link CellLeaseInput.dataHandler}: absent means REFUSED,
   * never fallen through to the tool registry.
   */
  private readonly dataHandler: DataCallHandler | undefined
  private readonly ledger: BridgeLedger
  private readonly handoffToJobs: CellLeaseInput['handoffToJobs']
  private readonly onDisposition: CellLeaseInput['onDisposition']
  private readonly inFlight = new Set<Promise<unknown>>()
  /**
   * The idempotency table: request id -> the call it identified and its outcome.
   *
   * The KEY is the protocol request id, which Python chooses; the VALUE records
   * the operation and the arguments digest it was first used for, so a second
   * frame can be classified as an exact duplicate (join the first result) or a
   * conflict (`REQUEST_ID_CONFLICT`) rather than being refused indiscriminately.
   */
  private readonly byRequestId = new Map<string, { subCallId: string, name: string, argsDigest: string, settled: Promise<NativeCallOutcome> }>()
  /**
   * THE PROVISIONAL ACCEPTING TABLE (V5 §6.2, Option A).
   *
   * A call is NOT accepted when its frame arrives. It is accepted when its
   * durable `STARTED` row has committed. Between those two moments the request id
   * lives HERE and nowhere else: it is not in {@link byRequestId}, not in the FIFO
   * {@link queue}, and not in {@link inFlight}. So a `ledger.started` rejection
   * needs no rollback at all -- there is nothing to roll back, and no window in
   * which a ghost could be observed by a reader or started by the runner.
   *
   * WHY NOT OPTION B (publish first, roll back synchronously on failure). It is
   * not merely uglier; it is UNSOUND ON THIS QUEUE. Under B the entry is in
   * `queue` before `ledger.started` is awaited, and a DIFFERENT concurrent
   * `invoke` that finishes its own write reaches `scheduleDrain()` and shifts the
   * FIRST entry off the queue -- `runQueue` then runs `this.handler(...)`, a real
   * `ctx.tools.execute`, for a call whose own durable intent is still unwritten.
   * If that write then rejects, B's rollback removes the entry from all three
   * collections, but the mutating tool call has already executed and is now
   * absent from every structure the ledger's crash window is keyed on. B trades a
   * ghost for an executed side effect with no record, which is strictly worse.
   * A has no such window: the entry is unreachable by `runQueue` until the write
   * has resolved.
   *
   * `acceptance` is what makes A safe for duplicates -- see {@link invoke}.
   */
  private readonly accepting = new Map<string, { name: string, argsDigest: string, outcome: Promise<NativeCallOutcome> }>()
  private readonly queue: AcceptedCall[] = []
  private readonly reported: LeaseCallDisposition[] = []
  /**
   * `STARTED` writes this lease has issued that have not yet resolved into either
   * a published call or a refusal.
   *
   * `drain` waits for these as well as for {@link inFlight}, and the reason is
   * the one thing Option A would otherwise cost: if `close()` could flip to
   * CLOSED while a `STARTED` write was still in flight, that write's continuation
   * would run against a CLOSED lease, record its refusal disposition into
   * {@link pendingWrites} AFTER `flush` had already drained it, and leave a
   * STARTED row with no disposition -- which `outcomeIsUnknown` reports as the
   * crash window. That is a false crash-window report, the same class of defect
   * `bridge-ledger.ts` documents as already having been fixed once. Waiting here
   * keeps the disposition on the same `flush`/`unrecorded` channel as every
   * other one, so "is this close's record complete?" still has exactly one
   * answer.
   *
   * These are deliberately NOT counted by {@link pending}: that counter is
   * "accepted unsettled logical calls" (V5 §6.3), and under A a call is not
   * accepted until its intent is durable.
   */
  private readonly pendingIntents = new Set<Promise<void>>()
  private readonly controller: AbortController
  private sequence = 0
  private state: LeaseState = 'OPEN'
  private closing: Promise<void> | undefined
  private drainScheduled = false

  constructor(input: CellLeaseInput) {
    this.id = randomUUID()
    this.sessionId = input.sessionId
    this.cellId = input.cellId
    this.epoch = input.epoch
    this.outerCallId = input.outerCallId
    this.rootCallId = input.rootCallId
    this.handler = input.handler
    this.dataHandler = input.dataHandler
    this.ledger = input.ledger
    this.handoffToJobs = input.handoffToJobs
    this.onDisposition = input.onDisposition
    this.controller = input.controller ?? new AbortController()
    if (input.signal !== undefined) {
      if (input.signal.aborted) this.beginClose('aborted', 'the enclosing call was already cancelled')
      else input.signal.addEventListener('abort', () => { this.beginClose('aborted', 'the enclosing call was cancelled') }, { once: true })
    }
  }

  /** True while this lease may still accept a new call. */
  get live(): boolean {
    return this.state === 'OPEN'
  }

  /** The lifecycle state, for a host that asserts quiescence. */
  get lifecycle(): LeaseState {
    return this.state
  }

  /** Why this lease stopped accepting, or undefined while it is open. */
  get revokedReason(): string | undefined {
    return this.closeDetail
  }

  /**
   * The signal every exact call this lease owns is dispatched under.
   *
   * This is the SAME controller the host passed in, not a second one, so aborting
   * it here reaches the registry call that is already in flight.
   */
  get signal(): AbortSignal {
    return this.controller.signal
  }

  /**
   * The controller the host must hand to the exact-call dispatcher.
   *
   * Read by the host BEFORE the lease is constructed, so the signal the handler
   * stamps onto `ToolExecutionInput` is the one a close will abort. See
   * {@link CellLeaseInput.controller}.
   */
  get abortController(): AbortController {
    return this.controller
  }

  /** Every disposition reported so far, in reporting order. */
  dispositions(): readonly LeaseCallDisposition[] {
    return Object.freeze([...this.reported])
  }

  /**
   * How many accepted calls have not reached a terminal state.
   *
   * ONE COUNT PER ACCEPTED UNSETTLED LOGICAL CALL, which is `inFlight.size` and
   * NOT `inFlight.size + queue.length`. The previous version added both and
   * therefore DOUBLE-COUNTED every queued call: `inFlight` holds the settlement
   * promise of every ACCEPTED call, added at publication and removed when it
   * settles, and the FIFO `queue` holds a SUBSET of those same calls -- the ones
   * that have not started yet. A call that is queued is in both collections, so
   * it was counted twice: a lease with one running call and one queued call
   * reported `pending === 3` for two logical calls. A caller reading `pending`
   * to decide whether the lease is quiescent saw a number that counted the same
   * call twice, which is the shape of a counter that reads wrong while every
   * test stays green.
   *
   * `inFlight` is the complete set, so it is the count. The queue is NOT added
   * because it is not a disjoint set -- see `AcceptedCall` and `invoke` for why
   * the two are populated together.
   */
  get pending(): number {
    return this.inFlight.size
  }

  private closeReason: BridgeCloseReason | undefined
  private closeDetail: string | undefined

  /**
   * Validate one incoming call against this lease and run it.
   *
   * The checks run in the order a reader would ask them — is the lease open, is
   * the caller in the epoch it thinks it is, is it the cell it thinks it is, has
   * this exact request already been answered — so the FIRST failure names the
   * most fundamental disagreement.
   *
   * THE ACCEPTANCE ORDER (V5 §6.2, Option A). This method does NOT publish the
   * call. It registers a PROVISIONAL entry, awaits the durable `STARTED` write,
   * and only then publishes into `byRequestId` / `queue` / `inFlight` (in
   * {@link publish}). So there is no moment at which the lease holds an accepted
   * call whose durable intent was not written, and a `ledger.started` rejection
   * leaves nothing behind to roll back. See {@link accepting} for why Option B is
   * unsound on this FIFO rather than merely less tidy.
   *
   * THE `lane` PARAMETER IS THE ROUTER'S DECISION, NOT THIS METHOD'S (V5 §5.1).
   * The default keeps every existing caller exactly as it was, so `invoke(call)`
   * still means "the exact-tool lane" and no call site changes meaning. The
   * authority checks above are IDENTICAL for both lanes on purpose: the data
   * plane is a different dispatcher, not a different authority. The lane is
   * carried on the ACCEPTED record, so it survives the wait for the durable
   * write and the dispatch that follows reads the decision made here rather than
   * re-deriving it.
   */
  async invoke(call: NativeCallRequest, lane: BridgeLane = 'tool'): Promise<NativeCallOutcome> {
    if (this.state !== 'OPEN') {
      throw new LeaseRejection(
        'CELL_LEASE_EXPIRED',
        `the cell that held this capability has ${this.state === 'CLOSED' ? 'settled' : 'settled and is draining'}: ${this.closeDetail ?? 'the cell settled'}`,
        this.closeDetail,
      )
    }
    if (call.epoch !== this.epoch) {
      throw new LeaseRejection(
        'EPOCH_MISMATCH',
        `this capability belongs to kernel epoch ${String(this.epoch)} but the call claims epoch ${String(call.epoch)}`,
      )
    }
    if (call.cellId !== this.cellId) {
      throw new LeaseRejection(
        'CELL_MISMATCH',
        `this capability belongs to cell ${this.cellId} but the call claims cell ${call.cellId}`,
      )
    }
    if (call.leaseId !== this.id) {
      throw new LeaseRejection('LEASE_UNKNOWN', 'the capability id in this call is not the live one for this kernel')
    }

    // The arguments are normalized ONCE, here, and the digest is what both the
    // idempotency check and the ledger use. A caller cannot submit a frame whose
    // digest is computed over a different representation than the one dispatched.
    const digest = digestOf(call.arguments)

    const previous = this.byRequestId.get(call.requestId)
    if (previous !== undefined) {
      if (previous.name === call.tool && previous.argsDigest === digest.digest) {
        // EXACT DUPLICATE: the same request id, the same operation and the same
        // arguments. It JOINS the first call's outcome instead of being refused
        // or dispatched again, so a lost reply can be recovered without a second
        // execution and a mutation cannot be doubled.
        return await previous.settled
      }
      throw new LeaseRejection(
        'REQUEST_ID_CONFLICT',
        `request id ${call.requestId} was first used for "${previous.name}" with different arguments; `
        + `it is refused rather than replayed as "${call.tool}"`,
      )
    }

    // THE PROVISIONAL TABLE, AND THE RULE A DUPLICATE GETS WHILE THE WRITE IS IN
    // FLIGHT. This is the case that decides whether Option A is safe, so it is
    // stated here rather than left to be inferred from the code.
    //
    // A second frame with the SAME request id can arrive while the first frame's
    // `STARTED` write is still unresolved -- `onCall` does not serialize per
    // request id, and a program may legitimately retransmit. That second frame
    // finds the entry HERE, before it is in `byRequestId`, so:
    //
    //   * same tool + same arguments digest -> it JOINS the provisional entry's
    //     OUTCOME promise. It neither starts a second write nor a second
    //     dispatch. Both callers then await the SAME promise, so if the write
    //     commits they both await the ONE published settlement, and if it rejects
    //     they both get the SAME `LEASE_LEDGER_UNAVAILABLE` refusal. Neither is
    //     left hanging and neither sees a different answer -- which is exactly
    //     the "duplicate request joining" property V5 §6.2 requires A to preserve.
    //   * same request id, different tool or arguments -> `REQUEST_ID_CONFLICT`,
    //     the same code and the same rule as the published table. Deciding it on
    //     the provisional entry means a colliding frame is refused whether or not
    //     the first frame's write happened to commit.
    //
    // The rule for a caller that receives `LEASE_LEDGER_UNAVAILABLE` is: RETRY
    // with the SAME request id is safe and is the documented recovery, because
    // nothing was accepted, nothing was dispatched, and no `STARTED` row exists
    // that a replay could be confused with. A retry with a FRESH request id is
    // equally safe; unlike the conflict arm there is no identity to preserve,
    // because the refused call never acquired one.
    const accepting = this.accepting.get(call.requestId)
    if (accepting !== undefined) {
      if (accepting.name !== call.tool || accepting.argsDigest !== digest.digest) {
        throw new LeaseRejection(
          'REQUEST_ID_CONFLICT',
          `request id ${call.requestId} was first used for "${accepting.name}" with different arguments; `
          + `it is refused rather than replayed as "${call.tool}"`,
        )
      }
      return await accepting.outcome
    }

    // The sequence is consumed BEFORE the write and is NOT reused on the refusal
    // arm. A gap in the numbering is harmless (the ids are identities, not an
    // accounting total), whereas reusing a number would let two different logical
    // calls share one subcall id -- the key the ledger is read by.
    this.sequence += 1
    const subCallId = `${this.outerCallId}:ipython:${String(this.sequence)}`
    let resolve!: (outcome: NativeCallOutcome) => void
    let reject!: (error: unknown) => void
    const settled = new Promise<NativeCallOutcome>((res, rej) => { resolve = res; reject = rej })
    const accepted: AcceptedCall = { call, subCallId, sequence: this.sequence, lane, argsDigest: digest.digest, settled, resolve, reject, started: false }

    // DURABLE INTENT, BEFORE PUBLICATION AND BEFORE ANY DISPATCH. Written here
    // rather than inside the runner so it happens at ACCEPTANCE: a call that is
    // queued behind others and then abandoned at close must still have left a
    // record, which is the case BR-07's oracle names ("nothing continues silently
    // ... with no record").
    const acceptance = (async (): Promise<{ settled: Promise<NativeCallOutcome> }> => {
      await this.ledger.started({
        subCallId,
        sessionId: this.sessionId,
        kernelEpoch: this.epoch,
        cellId: this.cellId,
        outerCallId: this.outerCallId,
        rootCallId: this.rootCallId,
        requestId: call.requestId,
        argsDigest: digest.digest,
        name: call.tool,
      })
      // THE INTENT IS DURABLE NOW. Only here does the call become reachable by
      // the FIFO runner -- and `publish` re-checks the lease state first, because
      // a close can have begun during the write.
      return this.publish(call, accepted, settled)
    })()

    // THE ONE OUTCOME PROMISE BOTH ARMS AWAIT. Built once and stored in the
    // provisional entry, so the first caller and every duplicate get an
    // identical, structured answer. A bare rethrow of the ledger's own error
    // would reach a duplicate as an unstructured failure while the first caller
    // saw a classified one, which is the kind of asymmetry a program cannot
    // branch on.
    const outcome = acceptance.then(
      record => record.settled,
      (error: unknown): never => {
        // THE REFUSAL ARM. Nothing was published, so there is no ghost to remove
        // and no rollback to perform: the call was never accepted. The refusal is
        // a structured `LeaseRejection` so a program can branch on
        // `LEASE_LEDGER_UNAVAILABLE` and retry, rather than parsing a generic
        // `BRIDGE_FAILED` and being unable to tell "retryable storage failure,
        // nothing happened" from "your authority is gone".
        throw new LeaseRejection(
          'LEASE_LEDGER_UNAVAILABLE',
          `the durable intent for "${call.tool}" could not be recorded, so the call was NOT accepted and NOT dispatched: `
          + (error instanceof Error ? error.message : String(error)),
        )
      },
    )
    this.accepting.set(call.requestId, { name: call.tool, argsDigest: digest.digest, outcome })
    this.trackIntent(call.requestId, acceptance)
    return await outcome
  }

  /**
   * Publish an accepted call into the three collections, or dispose of it.
   *
   * THE STATE RE-CHECK IS LOAD-BEARING AND IS NOT DEFENSIVE CODING. `invoke`
   * checked the state before the write, but a write is an await, so a close can
   * begin during it. Publishing unconditionally would then add the call to
   * `queue` and `inFlight` AFTER `drain` had already passed its last
   * `settleQueuedCalls` and flushed -- leaving a CLOSED lease with an accepted
   * call that nothing will ever settle: the same ghost the fix exists to remove,
   * merely moved to a narrower window. So a call whose lease closed during its
   * own write is DISPOSED here instead, through the same handoff/report/reject
   * path the close path uses, which is why the disposition is still recorded and
   * the caller still gets a structured refusal.
   */
  private publish(call: NativeCallRequest, accepted: AcceptedCall, settled: Promise<NativeCallOutcome>): { settled: Promise<NativeCallOutcome> } {
    if (this.state !== 'OPEN') {
      this.disposeUnstarted(accepted, this.closeReason ?? 'completed')
      return { settled }
    }
    this.byRequestId.set(call.requestId, {
      subCallId: accepted.subCallId,
      name: call.tool,
      argsDigest: accepted.argsDigest,
      settled,
    })
    this.queue.push(accepted)
    this.inFlight.add(settled)
    void settled.catch(() => undefined).finally(() => { this.inFlight.delete(settled) })
    this.scheduleDrain()
    return { settled }
  }

  /**
   * Keep the provisional entry alive until its write resolved, then clear it.
   *
   * Registered in {@link pendingIntents} for the whole lifetime of the write so
   * `drain` can wait for it, and removed on BOTH arms. The promise held in
   * `pendingIntents` never rejects: the caller's refusal is carried by `outcome`,
   * and a rejection nobody awaited would surface as an unhandled rejection.
   *
   * BOTH deletions happen inside this promise's own callbacks rather than in a
   * separate `finally`. `drain` re-checks `pendingIntents.size` on every pass of
   * its loop, so a removal scheduled on a DIFFERENT microtask than the one
   * `Promise.allSettled` observes could make the loop take an extra pass with an
   * already-settled set. Removing it here keeps "this write is still pending" and
   * "this write has resolved" the same edge.
   */
  private trackIntent(requestId: string, acceptance: Promise<unknown>): void {
    let tracked: Promise<void>
    const clear = (): void => {
      this.accepting.delete(requestId)
      this.pendingIntents.delete(tracked)
    }
    tracked = acceptance.then(clear, clear)
    this.pendingIntents.add(tracked)
  }

  /**
   * Close the capability and wait for everything it authorised.
   *
   * The five steps are V3 §J3's, in its order: stop accepting, abort owned calls,
   * await quiescence, flush the ledger, mark CLOSED. Idempotent: a second call
   * waits for the same drain and does not change the recorded reason, so the
   * first (true) cause is what a later reader sees.
   */
  async close(reason: BridgeCloseReason, detail?: string): Promise<void> {
    const started = this.beginClose(reason, detail)
    await started
  }

  /** The synchronous half of `close`: flip to CLOSING and abort, without waiting. */
  private beginClose(reason: BridgeCloseReason, detail?: string): Promise<void> {
    this.closeReason ??= reason
    this.closeDetail ??= detail ?? 'the cell settled'
    if (this.closing !== undefined) return this.closing
    // STEP 1: stop accepting new calls.
    //
    // WHAT "ATOMIC" MEANS HERE, AND WHAT IT NO LONGER MEANS. `invoke` reads
    // `state` synchronously, and no frame that reads OPEN after this line can
    // reach `publish`, because `publish` re-checks the state. Before Option A
    // this comment claimed something stronger -- that there was no await between
    // the state read and the queue push, so no call could be accepted after the
    // flip. That is no longer true, and the difference is stated rather than
    // left as a stale claim: a call CAN now be mid-write when the close begins.
    // It is not accepted, because acceptance is the publish, and the publish
    // either sees OPEN or disposes the call. See `publish` and `drain`.
    this.state = 'CLOSING'
    // STEP 2: abort every call this lease owns. A started call settles under the
    // abort; a queued call is refused before it ever reaches the registry.
    this.controller.abort(new Error(`the cell lease closed (${reason}): ${this.closeDetail}`))
    this.closing = this.drain(reason)
    return this.closing
  }

  /**
   * STEP 3 + 4 + 5: quiesce every started call, record every disposition, close.
   *
   * The loop is not a single await because a runner settling can let the next
   * queued entry start, and reporting quiescence with work outstanding is the one
   * thing a close barrier exists to prevent.
   */
  /**
   * STEP 3 + 4 + 5: quiesce every started call, record every disposition, close.
   *
   * The loop is not a single await because a runner settling can let the next
   * queued entry start, and reporting quiescence with work outstanding is the one
   * thing a close barrier exists to prevent.
   *
   * `pendingIntents` IS PART OF THE QUIESCENCE CONDITION, and that is the one
   * thing Option A costs. A `STARTED` write that is still in flight when the close
   * begins resolves AFTER the close started; its continuation either disposes the
   * call (recording an `abandoned-unstarted` disposition on the same
   * `flush`/`unrecorded` channel as every other one) or, if the write failed,
   * leaves nothing at all. Breaking out of the loop without waiting for it would
   * let `flush` run first and the disposition be pushed afterwards, leaving a
   * STARTED row with no disposition -- which `outcomeIsUnknown` reports as the
   * crash window, a false unknown-outcome report. So the loop waits for both sets
   * before it flushes.
   */
  private async drain(reason: BridgeCloseReason): Promise<void> {
    for (;;) {
      this.settleQueuedCalls(reason)
      if (this.inFlight.size === 0 && this.pendingIntents.size === 0) break
      await Promise.allSettled([...this.inFlight, ...this.pendingIntents])
    }
    this.settleQueuedCalls(reason)
    // STEP 4: flush the ledger BEFORE the lease reports itself closed, so a
    // reader that observes CLOSED can rely on every disposition being durable.
    // The flush does NOT throw here: the state flip below must happen either way,
    // because leaving a lease stuck in CLOSING would be a worse defect than the
    // one being reported. The failures are carried out of `drain` instead.
    await this.flush()
    // STEP 5: mark CLOSED.
    this.state = 'CLOSED'
    if (this.unrecorded.length > 0) {
      // A CLOSED lease whose dispositions are incomplete. The caller learns it
      // here rather than having to ask; see `BridgeLedgerWriteError`.
      throw new BridgeLedgerWriteError(this.id, this.unrecorded)
    }
  }

  /**
   * Dispose of ONE call that will never start, recording WHY for it.
   *
   * The two arms are the oracle's own distinction. A host handoff that takes
   * ownership produces `handed-to-jobs` WITH the job id; with no handoff, the
   * call is `abandoned-unstarted`. Mapping either onto the other would erase the
   * difference between "someone else owns this now" and "this was refused",
   * which is exactly what the oracle asks a reader to be able to tell apart.
   *
   * Shared by the two paths that can reach this state: the close path draining
   * its queue, and `publish` discovering that the lease closed while the call's
   * own durable intent was being written. Both must record the disposition and
   * refuse the caller identically, or the same fact would be reported two ways
   * depending on which window it landed in.
   */
  private disposeUnstarted(entry: AcceptedCall, reason: BridgeCloseReason): void {
    const handed = this.handoffToJobs?.({ subCallId: entry.subCallId, name: entry.call.tool, args: entry.call.arguments })
    const refusal = new LeaseRejection(
      'CELL_LEASE_EXPIRED',
      handed === undefined
        ? `the cell settled before "${entry.call.tool}" started, so the call was abandoned unstarted`
        : `the cell settled before "${entry.call.tool}" started; the host handed it to job ${handed.jobId}`,
    )
    this.report(
      handed === undefined
        ? { subCallId: entry.subCallId, name: entry.call.tool, disposition: 'abandoned-unstarted', closeReason: reason, started: false }
        : { subCallId: entry.subCallId, name: entry.call.tool, disposition: 'handed-to-jobs', jobId: handed.jobId, closeReason: reason, started: false },
    )
    entry.reject(refusal)
  }

  /** Dispose of every queued call that will never start, one at a time. */
  private settleQueuedCalls(reason: BridgeCloseReason): void {
    while (this.queue.length > 0) {
      const entry = this.queue.shift()
      if (entry === undefined) return
      if (entry.started) continue
      this.disposeUnstarted(entry, reason)
    }
  }

  /** Record one disposition: to the durable ledger, to the sink, and in memory. */
  private report(disposition: LeaseCallDisposition): void {
    this.reported.push(disposition)
    this.onDisposition?.(disposition)
    // The ledger write is fire-and-forget here ON PURPOSE and the reason is
    // recorded rather than left implicit: `report` is called from the drain path
    // that `close()` is already awaiting, and awaiting a durable write inside the
    // synchronous queue-disposal loop would deadlock the loop against itself.
    // `drain` awaits `flush()` before it flips to CLOSED, so the write is still
    // ordered before the lease reports itself closed.
    //
    // THE REJECTION IS CAPTURED, NOT DISCARDED. `ledger.disposed` rejects in four
    // distinct ways (no row for the subcall, a duplicate disposition, a handoff
    // without a job id, a job id on a non-handoff arm) and the backend's `put` can
    // fail too. A bare `Promise.allSettled` in `flush` would make every one of
    // those unobservable while still letting the lease reach CLOSED -- which is
    // exactly the "continues silently with no record" outcome BR-07 forbids, one
    // level down. The rejection is retained here and rethrown by `flush`.
    this.pendingWrites.push(this.ledger.disposed(disposition.subCallId, disposition.disposition, {
      ...disposition.jobId === undefined ? {} : { jobId: disposition.jobId },
      ...disposition.closeReason === undefined ? {} : { closeReason: disposition.closeReason },
    }))
    // The report is the KEY for the failure trace above, so a rejected write can
    // name the subcall it belonged to instead of an array index.
    this.writeByReport.set(disposition, this.pendingWrites[this.pendingWrites.length - 1] as Promise<void>)
  }

  private readonly pendingWrites: Promise<void>[] = []
  /** Dispositions that could NOT be recorded durably. Empty is the healthy state. */
  private readonly unrecorded: Array<{ subCallId: string, disposition: BridgeDisposition, reason: string }> = []

  /**
   * Await every ledger write this lease has issued, retaining any that failed.
   *
   * A rejection is NOT swallowed: each failure is recorded in
   * {@link unrecordedDispositions} so a reader can see WHICH disposition is
   * missing, and `drain` turns a non-empty list into a
   * {@link BridgeLedgerWriteError}. Both halves are needed -- throwing alone
   * would lose the list of which calls are unrecorded, and recording alone would
   * let a caller believe a close that lost records was clean.
   *
   * This method itself does not throw, because its caller must complete the state
   * flip to CLOSED regardless: a lease stuck in CLOSING would refuse every call
   * while claiming not to have settled, which is a worse failure than the one
   * being reported.
   */
  private async flush(): Promise<void> {
    while (this.pendingWrites.length > 0) {
      const batch = this.pendingWrites.splice(0, this.pendingWrites.length)
      const settled = await Promise.allSettled(batch)
      for (const [index, outcome] of settled.entries()) {
        if (outcome.status !== 'rejected') continue
        // The disposition this write belonged to is looked up from the ledger of
        // reports, so the failure names a subcall rather than an array index.
        const reported = this.reported.find(entry => this.writeOf(entry) === batch[index])
        this.unrecorded.push({
          subCallId: reported?.subCallId ?? '(unknown)',
          disposition: reported?.disposition ?? 'settled',
          reason: outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason),
        })
      }
    }
  }

  /** The promise a report produced, so a failed write can be traced back to its call. */
  private readonly writeByReport = new Map<LeaseCallDisposition, Promise<void>>()

  private writeOf(disposition: LeaseCallDisposition): Promise<void> | undefined {
    return this.writeByReport.get(disposition)
  }

  /**
   * Dispositions this lease could NOT record durably.
   *
   * A reader that wants to know whether the record is COMPLETE asks this rather
   * than trusting that `CLOSED` implies completeness. Empty means every
   * disposition reached the ledger.
   */
  get unrecordedDispositions(): readonly { subCallId: string, disposition: BridgeDisposition, reason: string }[] {
    return Object.freeze([...this.unrecorded])
  }

  /** Start the FIFO runner if it is not already running. */
  private scheduleDrain(): void {
    if (this.drainScheduled) return
    this.drainScheduled = true
    void this.runQueue().catch(() => undefined)
  }

  /**
   * Run accepted calls ONE AT A TIME, in bridge-accepted order.
   *
   * This is the serial baseline V3 §J1 requires. A call that is still queued when
   * the lease begins closing is never started; a call already in the registry
   * runs to quiescence under the aborted signal, which the registry reports as
   * `ABORTED` / `ABORTED_BEFORE_DISPATCH` rather than as a dropped promise.
   */
  private async runQueue(): Promise<void> {
    for (;;) {
      const entry = this.queue.shift()
      if (entry === undefined) {
        this.drainScheduled = false
        // A submission may have arrived between the shift and this line.
        if (this.queue.length > 0) this.scheduleDrain()
        return
      }
      if (this.state === 'CLOSED') {
        // The close path already disposed of this entry; nothing to run.
        continue
      }
      if (this.state === 'CLOSING' || this.controller.signal.aborted) {
        // Closing began while this call waited. It never started, so it is
        // disposed by the close path, which records the reason.
        this.queue.unshift(entry)
        this.settleQueuedCalls(this.closeReason ?? 'completed')
        continue
      }
      entry.started = true
      const outcome = await this.runOne(entry)
      entry.resolve(outcome)
    }
  }

  /**
   * Dispatch one accepted call to the lane its NAME selected (V5 §5.1).
   *
   * ONE bridge, ONE `CellLease` authority, TWO internal dispatchers. The lane was
   * chosen at acceptance and is read here, never re-derived, so there is exactly
   * one place in this file where "is this a data request" is decided.
   *
   * A `data:*` CALL WITH NO DATA PLANE IS REFUSED HERE, and this arm is the whole
   * point of the routing rule: it must NOT reach `this.handler`, because that
   * would send the name to `ctx.tools.execute` and an unknown data operation
   * would be answered by the tool registry -- a typo becoming a tool dispatch, and
   * a refusal that looks like a successful call to a different subsystem. The
   * code is the data plane's own (`DATA_NO_CAPABILITY`), so a caller branching on
   * it sees a data-plane fact rather than a tool-registry one.
   *
   * CONCURRENCY, STATED (V5 §5.2). Both lanes run through the SAME FIFO queue and
   * the same accepted-call state machine, so `dsh.call` keeps exact
   * `ctx.tools.execute()` semantics and neither lane claims ToolRuntime
   * sibling-scheduler semantics. The bounded host-side I/O concurrency V5 permits
   * for `dsh.data` is the read plane's own limiter
   * (`DataReadLimiter`, `DEFAULT_DATA_READ_CONCURRENCY`), which bounds TOTAL
   * concurrent reads per deployment. This lane does NOT add a second scheduler
   * inside the lease, and it does not claim one.
   */
  private async dispatchOne(entry: AcceptedCall): Promise<NativeCallOutcome> {
    const context: ExactCallContext = { subCallId: entry.subCallId, sequence: entry.sequence }
    if (entry.lane !== 'data') {
      return await this.handler(entry.call, context)
    }
    const dataHandler = this.dataHandler
    if (dataHandler === undefined) {
      return {
        ok: false,
        error: {
          code: 'DATA_NO_CAPABILITY',
          message: `"${entry.call.tool}" is a dsh.data request but this cell lease has no data plane mounted. `
            + 'It is refused as a DATA-plane error and is deliberately NOT retried as a tool: a fall-through '
            + 'would make an unknown data operation look like a tool call.',
        },
      }
    }
    return await dataHandler(entry.call, context)
  }

  /**
   * Run one accepted call and record its settlement and disposition.
   *
   * A THROW HERE MUST STILL SETTLE THE CALLER. The handler's own contract is to
   * return structured outcomes rather than throw, but a host-level failure (a
   * ledger write, a bug) would otherwise leave the accepted promise pending
   * forever and hang the cell. So the catch is a real arm and not decoration.
   */
  private async runOne(entry: AcceptedCall): Promise<NativeCallOutcome> {
    let outcome: NativeCallOutcome
    try {
      outcome = await this.dispatchOne(entry)
    } catch (error) {
      outcome = {
        ok: false,
        error: {
          code: error instanceof LeaseRejection ? error.code : 'BRIDGE_FAILED',
          message: error instanceof Error ? error.message : String(error),
        },
      }
    }

    // SETTLED, AFTER the final ToolRuntime result is known. The digest identifies
    // the delivered value without storing it, and an oversized result is already
    // retained by then, so its artifact ref is what the ledger carries.
    //
    // THE LEDGER CARRIES THE TYPED REF, NOT THE HOST PATH (P13). It used to carry
    // `outcome.artifact.path`, which put a host filesystem path into a DURABLE
    // record -- so the one field an auditor reads to answer "which object was
    // delivered?" named a location that any same-UID writer could replace, and
    // named nothing about the object's identity. `artifact` is the plane's own
    // `artifact:sha256:<digest>` reference, which is content-addressed and is the
    // same string on both planes. This is a one-line change inside P3's region;
    // flagged in the report rather than left for the integrator to notice.
    const digest = outcome.ok
      ? ('artifact' in outcome
        ? { digest: outcome.artifact.sha256, bytes: outcome.artifact.bytes, artifactRef: outcome.artifact.artifact }
        : { ...digestOf(outcome.value), artifactRef: undefined })
      : { ...digestOf({ code: outcome.error.code, message: outcome.error.message }), artifactRef: undefined }

    // A SETTLEMENT WRITE THAT FAILS MUST NOT HANG THE CALLER, and until this arm
    // existed the docstring above was FALSE for the ledger write itself. The
    // try/catch above covers only `this.handler`; a rejected `ledger.settled` threw
    // straight out of `runOne`, so `runQueue` never reached `entry.resolve`, the
    // accepted promise stayed pending forever, and `close()` hung too because its
    // drain awaits every in-flight promise.
    //
    // MEASURED (S13 / BR-07) with an injected settlement failure: the caller did
    // not settle within 5 s, and the whole queue behind it never ran. That is the
    // exact hazard the docstring names, so this is the catch the docstring was
    // already claiming.
    let settlementFailure: unknown
    try {
      await this.ledger.settled(entry.subCallId, {
        isError: !outcome.ok,
        resultDigest: digest.digest,
        resultBytes: digest.bytes,
        ...digest.artifactRef === undefined ? {} : { artifactRef: digest.artifactRef },
      })
    } catch (error) {
      settlementFailure = error
    }

    if (settlementFailure === undefined) {
      // `settled` vs `cancelled` is decided by whether the close was already under
      // way when this call finished -- not by whether the result happens to be an
      // ABORTED error. A tool can legitimately fail with its own error, and calling
      // that `cancelled` would misreport a real tool failure as a shutdown.
      this.report({
        subCallId: entry.subCallId,
        name: entry.call.tool,
        disposition: this.state === 'OPEN' ? 'settled' : 'cancelled',
        ...this.state === 'OPEN' ? {} : { closeReason: this.closeReason ?? 'completed' },
        started: true,
      })
    } else {
      // NO DISPOSITION IS REPORTED, and that is deliberate rather than an
      // omission. Writing one would put a row in the ledger that says the call was
      // disposed while its settlement is missing -- and because `outcomeIsUnknown`
      // keys on the DISPOSITION, that row would then be HIDDEN from
      // `unknownOutcomes()`, which is the one place a reader looks to find an
      // outcome that was never established. Leaving the row STARTED-with-no-
      // settlement and no disposition is the truthful shape, and it is the same
      // shape the crash window has.
      //
      // The failure travels to the caller of `close()` through the SAME channel the
      // disposition-write failure uses, so a reader who asks "is this close's
      // record complete?" gets one answer covering both halves.
      this.unrecorded.push({
        subCallId: entry.subCallId,
        disposition: this.state === 'OPEN' ? 'settled' : 'cancelled',
        reason: `the settlement could not be recorded: ${settlementFailure instanceof Error ? settlementFailure.message : String(settlementFailure)}`,
      })
    }
    return outcome
  }
}

/** Where the host's loopback listener bound. Handed to the kernel per cell. */
export interface BridgeEndpoint {
  readonly port: number
}

/** How the bridge behaves, host-set and never model-reachable. */
export interface BridgeServerOptions {
  /** Directory for oversized values. Host-owned scratch, outside the project root. */
  readonly artifactDirectory: string
  /** Values at or above this size go to disk and are delivered as a reference. */
  readonly inlineValueBytes?: number
  /** Directory the Python client is written into. Defaults to the artifact directory. */
  readonly clientDirectory?: string
  /**
   * Absolute path of the Python `dsh.data` client to install into each cell
   * (V5 §5.3), or absent when no data plane is mounted.
   *
   * HOST-SET AND NEVER MODEL-REACHABLE. It is an option rather than something
   * this package discovers, because `dsh-ipython` cannot import `dsh-daily-work`
   * (MEASURED: `MODULE_NOT_FOUND` from its own realpath) -- the package that owns
   * the file publishes its path through the mounted service, and the composition
   * passes it here. Absent means the preamble installs no `dsh.data` namespace,
   * which agrees with the routing lane refusing `data:*` with
   * `DATA_NO_CAPABILITY`.
   */
  readonly dataClientPath?: string
  /**
   * The unified project Artifact/Attachment plane, when the composition mounted
   * one. Absent, oversized results fall back to `artifactDirectory` and are
   * reported on the `bridge-scratch` plane.
   *
   * A port rather than an import: see {@link BridgeArtifactRetention}.
   */
  readonly retention?: BridgeArtifactRetention
}

/** Absolute path of the written Python client, so a caller can log it. */
export interface BridgeStartup {
  readonly endpoint: BridgeEndpoint
  readonly clientPath: string
}

interface Connection {
  readonly socket: Socket
  handshaken: boolean
  /** Leases this connection has been told about, so a reply can name the right one. */
  readonly leases: Set<CellLease>
}

/**
 * The host-side listener.
 *
 * ONE server per kernel host. The per-kernel token is minted at `start` and
 * rotated when a new kernel starts, so a connection from a previous kernel
 * cannot be reused as if the namespace had survived.
 */
export class BridgeServer {
  private readonly options: BridgeServerOptions
  private readonly inlineValueBytes: number
  private server: Server | undefined
  private port = 0
  private kernelToken = ''
  private clientPath = ''
  private readonly connections = new Set<Connection>()
  private readonly leases = new Map<string, CellLease>()
  /** The lease new calls are checked against. One live cell per kernel, always. */
  private activeLease: CellLease | undefined
  private closed = false
  private readonly handlers = { call: undefined as ((call: NativeCallRequest) => Promise<NativeCallOutcome>) | undefined }

  constructor(options: BridgeServerOptions) {
    this.options = options
    this.inlineValueBytes = options.inlineValueBytes ?? DEFAULT_INLINE_VALUE_BYTES
  }

  /** The bound port. Zero before {@link start}. */
  get boundPort(): number {
    return this.port
  }

  /** The live lease, for host-side assertions and audit. */
  get currentLease(): CellLease | undefined {
    return this.activeLease
  }

  /**
   * Bind the loopback listener and materialize the Python client.
   *
   * The token is minted here and nowhere else. It is written into the client's
   * module namespace by the per-cell preamble rather than into the client source,
   * so the on-disk client is not itself a capability and can be rewritten
   * without invalidating a live kernel.
   */
  async start(): Promise<BridgeStartup> {
    if (this.server !== undefined) throw new Error('the bridge server is already started')
    mkdirSync(this.options.artifactDirectory, { recursive: true })
    const clientDirectory = this.options.clientDirectory ?? this.options.artifactDirectory
    mkdirSync(clientDirectory, { recursive: true })
    this.clientPath = join(clientDirectory, BRIDGE_CLIENT_FILENAME)
    writeFileSync(this.clientPath, PYTHON_CLIENT_SOURCE, 'utf8')
    this.kernelToken = randomBytes(32).toString('hex')

    const server = createServer(socket => { this.onConnection(socket) })
    this.server = server
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => { reject(error) }
      server.once('error', onError)
      // 127.0.0.1 explicitly, never 0.0.0.0: a listener on every interface would
      // expose the capability to the network, which is a strictly larger surface
      // than this design's threat model assumes.
      server.listen(0, '127.0.0.1', () => {
        server.removeListener('error', onError)
        resolve()
      })
    })
    const address = server.address()
    if (address === null || typeof address === 'string') {
      throw new Error('the bridge listener did not report a TCP address')
    }
    this.port = address.port
    return { endpoint: { port: this.port }, clientPath: this.clientPath }
  }

  /** The token a cell's preamble must present. Rotated per kernel, never logged. */
  private get tokenForPreamble(): string {
    return this.kernelToken
  }

  /**
   * Mint the capability for one cell.
   *
   * A new kernel token is NOT minted per cell: the token proves which kernel is
   * calling, and the lease proves which cell. Keeping them separate is what lets
   * the host report `EPOCH_MISMATCH` and `CELL_LEASE_EXPIRED` as different facts
   * instead of collapsing both into "bad token".
   */
  mintLease(input: CellLeaseInput): CellLease {
    if (this.closed) throw new Error('the bridge server is closed')
    const lease = new CellLease(input)
    this.leases.set(lease.id, lease)
    this.activeLease = lease
    return lease
  }

  /** Drop a lease from the live table. Called after {@link CellLease.close}. */
  releaseLease(lease: CellLease): void {
    this.leases.delete(lease.id)
    if (this.activeLease === lease) this.activeLease = undefined
  }

  /**
   * Every lease this server has minted and not released.
   *
   * Exposed so a host can report ACTIVE LEASES as a fact (V3 §J2 lists them on
   * the kernel record) and so a disposal can assert quiescence rather than
   * assume it. A closed lease stays in this table until its owner releases it,
   * which is what lets a reader see the difference between "no lease was ever
   * minted" and "every lease was closed".
   */
  openLeases(): readonly CellLease[] {
    return Object.freeze([...this.leases.values()])
  }

  /** Resolve a lease by id, or undefined. Never returns a closed lease as live. */
  lease(id: string): CellLease | undefined {
    return this.leases.get(id)
  }

  /** Rotate the kernel token. Called when a new kernel process starts. */
  rotateKernelToken(): void {
    this.kernelToken = randomBytes(32).toString('hex')
  }

  /**
   * The per-cell Python preamble that binds `dsh` in the cell's namespace.
   *
   * NOT THE PRODUCTION PATH ANY MORE. `runCell` sends {@link bind} as a hidden
   * control request so the user's bytes are never rewritten. This remains for the
   * hand-driven probes and tests that measure the mechanism by joining it to a
   * cell themselves.
   */
  preamble(lease: CellLease): string {
    return renderBridgePreamble({
      clientPath: this.clientPath,
      port: this.port,
      token: this.tokenForPreamble,
      leaseId: lease.id,
      cellId: lease.cellId,
      epoch: lease.epoch,
      ...this.options.dataClientPath === undefined ? {} : { dataClientPath: this.options.dataClientPath },
    })
  }

  /**
   * The HIDDEN CONTROL program that binds `dsh` for one cell.
   *
   * This is what `runCell` sends as its own `silent` request before the user's
   * cell. Same capability as {@link preamble}, without the trailing newline that
   * only exists to separate a prepended block from the user's first line.
   */
  bind(lease: CellLease): string {
    return renderBridgeBind({
      clientPath: this.clientPath,
      port: this.port,
      token: this.tokenForPreamble,
      leaseId: lease.id,
      cellId: lease.cellId,
      epoch: lease.epoch,
    })
  }

  /**
   * The HIDDEN CONTROL program that removes `dsh` from the kernel namespace.
   *
   * Static because it needs no capability: it only removes names. Sent before a
   * cell that has no authority, so such a cell cannot inherit a capability from
   * an earlier one -- see {@link renderBridgeRevoke}.
   */
  revoke(): string {
    return renderBridgeRevoke()
  }

  /** Stop listening and close everything. Idempotent. */
  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    const leases = [...this.leases.values()]
    this.leases.clear()
    this.activeLease = undefined
    // `LEASE_REVOKED`, not `CELL_LEASE_EXPIRED`: the HOST is disposing the
    // bridge, so no cell settled. The distinction is kept because a program that
    // sees its kernel shut down underneath it has a different remedy from one
    // whose cell simply finished.
    await Promise.allSettled(leases.map(async lease => { await lease.close('aborted', 'the bridge server was shut down') }))
    for (const connection of [...this.connections]) {
      connection.socket.destroy()
    }
    this.connections.clear()
    const server = this.server
    this.server = undefined
    if (server !== undefined) {
      await new Promise<void>(resolve => { server.close(() => { resolve() }) })
    }
  }

  private onConnection(socket: Socket): void {
    if (this.closed) {
      socket.destroy()
      return
    }
    const connection: Connection = { socket, handshaken: false, leases: new Set() }
    this.connections.add(connection)
    const decoder = new FrameDecoder(
      value => { void this.onFrame(connection, value) },
      error => {
        // A framing violation is terminal for the connection: continuing would
        // mean guessing at alignment, which is the same rule the broker channel
        // applies for the same reason.
        this.rejectAndClose(connection, 'FRAME_ERROR', error.message)
      },
    )
    socket.on('data', (chunk: Buffer) => { decoder.push(chunk) })
    socket.on('error', () => { this.connections.delete(connection) })
    socket.on('close', () => { this.connections.delete(connection) })
  }

  private send(connection: Connection, message: unknown): void {
    try {
      connection.socket.write(encodeFrame(message))
    } catch (error) {
      // The peer is gone. Dropping the reply is correct: the call it belonged to
      // has already settled on this side, and the Python side will observe the
      // closed socket rather than a fabricated answer.
      if (error instanceof FrameError) connection.socket.destroy()
    }
  }

  private rejectAndClose(connection: Connection, code: string, message: string): void {
    this.send(connection, { type: 'fatal', code, message })
    connection.socket.end()
  }

  private async onFrame(connection: Connection, value: unknown): Promise<void> {
    if (typeof value !== 'object' || value === null) {
      this.rejectAndClose(connection, 'PROTOCOL', 'a bridge frame must be a JSON object')
      return
    }
    const frame = value as Record<string, unknown>
    if (!connection.handshaken) {
      this.onHandshake(connection, frame)
      return
    }
    if (frame['type'] === 'call') {
      await this.onCall(connection, frame)
      return
    }
    this.rejectAndClose(connection, 'PROTOCOL', `unknown bridge frame type ${JSON.stringify(frame['type'])}`)
  }

  private onHandshake(connection: Connection, frame: Record<string, unknown>): void {
    if (frame['type'] !== 'hello') {
      this.rejectAndClose(connection, 'PROTOCOL', 'the first frame must be a hello')
      return
    }
    if (frame['protocol'] !== BRIDGE_PROTOCOL_VERSION) {
      this.rejectAndClose(
        connection,
        'PROTOCOL_VERSION',
        `bridge protocol ${String(frame['protocol'])} is not ${String(BRIDGE_PROTOCOL_VERSION)}`,
      )
      return
    }
    const token = frame['token']
    if (typeof token !== 'string' || token !== this.kernelToken) {
      this.rejectAndClose(connection, 'TOKEN_MISMATCH', 'the kernel token does not match this listener')
      return
    }
    connection.handshaken = true
    this.send(connection, { type: 'hello_ack', protocol: BRIDGE_PROTOCOL_VERSION, ok: true })
  }

  private async onCall(connection: Connection, frame: Record<string, unknown>): Promise<void> {
    const requestId = frame['requestId']
    if (typeof requestId !== 'string' || requestId === '') {
      this.rejectAndClose(connection, 'PROTOCOL', 'a call must carry a non-empty requestId')
      return
    }

    // FORGERY CHECK, FIRST. Before any lease lookup, so a frame carrying
    // authority fields is refused on its own terms rather than being answered by
    // a lease that happened to be live.
    const forged = FORBIDDEN_FIELDS.filter(field => Object.hasOwn(frame, field))
    if (forged.length > 0) {
      this.send(connection, {
        type: 'result',
        requestId,
        ok: false,
        error: {
          code: 'FORGED_AUTHORITY',
          message: `a programmatic call may not name ${forged.join(', ')}; authority comes from the host's binding to the enclosing call`,
        },
      })
      return
    }

    const tool = frame['tool']
    if (typeof tool !== 'string' || tool === '') {
      this.send(connection, {
        type: 'result',
        requestId,
        ok: false,
        error: { code: 'TOOL_NAME_INVALID', message: 'tool must be a non-empty string' },
      })
      return
    }

    const leaseId = typeof frame['leaseId'] === 'string' ? frame['leaseId'] : ''
    const cellId = typeof frame['cellId'] === 'string' ? frame['cellId'] : ''
    const epoch = typeof frame['epoch'] === 'number' ? frame['epoch'] : Number.NaN
    const lease = this.leases.get(leaseId)
    if (lease === undefined) {
      this.send(connection, {
        type: 'result',
        requestId,
        ok: false,
        error: {
          code: 'LEASE_UNKNOWN',
          message: 'this capability is not live for this kernel; a callback from a settled cell is refused',
        },
      })
      return
    }

    // ── THE ROUTING BRANCH (V5 §5.1), AND IT IS THE ONLY ONE ──────────────
    //
    // ONE frame shape, ONE name field, TWO internal lanes. `data:` cannot appear
    // in a DSH tool name, so this is a total decision on the SAME frame the tool
    // lane already validates: no second socket family, no second registry, no
    // second cell authority, no second model tool.
    //
    // A `data:*` NAME NEVER REACHES `ctx.tools.execute`. That is enforced one
    // level down in `CellLease.dispatchOne`, which refuses the data lane when no
    // data handler is mounted rather than falling back to the tool dispatcher --
    // so the property holds even for a lease constructed without a data plane,
    // and not merely because this branch chose well.
    //
    // WHY THE LANE IS PASSED RATHER THAN THE ROUTING DONE HERE: `invoke` is the
    // one place the authority checks (lease open, epoch, cell, idempotency) run,
    // and the data lane must be protected by exactly those checks. Routing
    // before `invoke` would create a path around them.
    const lane: BridgeLane = isDataRequest(tool) ? 'data' : 'tool'

    let outcome: NativeCallOutcome
    try {
      outcome = await lease.invoke({
        requestId,
        tool,
        arguments: frame['arguments'],
        cellId,
        epoch,
        leaseId,
      }, lane)
    } catch (error) {
      if (error instanceof LeaseRejection) {
        this.send(connection, { type: 'result', requestId, ok: false, error: { code: error.code, message: error.message } })
        return
      }
      this.send(connection, {
        type: 'result',
        requestId,
        ok: false,
        error: { code: 'BRIDGE_FAILED', message: error instanceof Error ? error.message : String(error) },
      })
      return
    }

    // The value is delivered through ONE of two doors, and the host chooses
    // which by SIZE, not by re-running anything. See `deliver`.
    this.send(connection, { type: 'result', requestId, ...outcome })
  }

  /**
   * Materialize a canonical value for delivery to Python.
   *
   * Lossless either way. Under the inline bound the value travels in the reply
   * frame -- unchanged, and this method does not touch that arm. At or over it
   * the exact canonical bytes are retained ONCE and the reply carries a typed
   * reference. The model-facing projection is a separate matter entirely -- it is
   * the tool's own `render`, and it is unaffected by which door the program's
   * copy takes.
   *
   * ── THE UNIFIED PLANE IS TRIED FIRST, AND THE FALLBACK IS RECORDED ─────────
   *
   * With a retention port mounted, the bytes go into the project's own
   * Artifact/Attachment store and the reply carries that store's reference and NO
   * host path. Without one, they go to this bridge's scratch directory and the
   * reply says so on the `bridge-scratch` plane. The plane is a field rather than
   * something a reader infers from a field's presence, because "which retention
   * policy applied to this result" is exactly the question a silent fallback
   * would make unanswerable.
   *
   * A RETENTION FAILURE IS NOT A FALLBACK. If the plane is mounted and refuses,
   * the call fails with the plane's own reason. Quietly writing to scratch instead
   * would turn a quota refusal into an untracked object, which is the behaviour
   * §12's "no second retention/quota/provenance policy" forbids.
   */
  async deliver(tool: string, callId: string, value: unknown): Promise<NativeCallOutcome> {
    const text = JSON.stringify(value)
    if (text === undefined) {
      return {
        ok: false,
        error: {
          code: 'VALUE_NOT_JSON',
          message: `tool "${tool}" produced a canonical value that is not JSON-serializable`,
        },
      }
    }
    const bytes = Buffer.byteLength(text, 'utf8')
    if (bytes < this.inlineValueBytes) {
      return { ok: true, value }
    }
    const digest = createHash('sha256').update(text, 'utf8').digest('hex')

    if (this.options.retention !== undefined) {
      try {
        const retained = await this.options.retention.retain(Buffer.from(text, 'utf8'), { tool, callId })
        // TWO INDEPENDENT DIGESTS MUST AGREE. The host hashed the bytes it
        // serialized; the plane hashed the bytes it stored. A disagreement means
        // the plane retained something other than what was delivered, and
        // returning its reference would bind Python to the wrong object.
        if (retained.sha256 !== digest) {
          return {
            ok: false,
            error: {
              code: 'ARTIFACT_DIGEST_MISMATCH',
              message: `the unified plane retained a ${String(retained.bytes)}-byte object hashing ${retained.sha256.slice(0, 16)}…, but "${tool}" produced ${digest.slice(0, 16)}…`,
            },
          }
        }
        return {
          ok: true,
          artifact: { artifact: retained.artifact, plane: 'unified', bytes: retained.bytes, sha256: retained.sha256 },
        }
      } catch (error) {
        return {
          ok: false,
          error: {
            code: 'ARTIFACT_WRITE_FAILED',
            message: `the ${String(bytes)}-byte result of "${tool}" was refused by the unified artifact plane: ${error instanceof Error ? error.message : String(error)}`,
          },
        }
      }
    }

    const path = join(this.options.artifactDirectory, `${digest}.json`)
    try {
      writeFileSync(path, text, 'utf8')
    } catch (error) {
      return {
        ok: false,
        error: {
          code: 'ARTIFACT_WRITE_FAILED',
          message: `the ${String(bytes)}-byte result of "${tool}" could not be retained: ${error instanceof Error ? error.message : String(error)}`,
        },
      }
    }
    return {
      ok: true,
      artifact: { artifact: scratchArtifactRef(digest), plane: 'bridge-scratch', path, bytes, sha256: digest },
    }
  }
}

/**
 * The project's artifact reference format, duplicated here as a STRING FORMAT.
 *
 * `artifacts.ts:artifactRefOf` is the authority and this must stay byte-identical
 * to it. It is re-stated rather than imported because `dsh-ipython` does not
 * depend on `dsh-daily-work` and must not start: see
 * {@link BridgeArtifactRetention} for why the store arrives as a port instead.
 * A drift between the two is caught by a test that compares them, not by hope.
 */
export function scratchArtifactRef(sha256: string): string {
  return `artifact:sha256:${sha256}`
}

/** Everything the preamble needs. All of it host-minted. */
export interface BridgePreambleInput {
  readonly clientPath: string
  readonly port: number
  readonly token: string
  readonly leaseId: string
  readonly cellId: string
  readonly epoch: number
  /**
   * Absolute path of the Python `dsh.data` client to install at bind time
   * (V5 §5.3), or absent when the composition mounted no data plane.
   *
   * ABSENT MEANS NOT INSTALLED, NOT "INSTALL AND FAIL LATER". With no data plane
   * the bridge's own routing refuses `data:*` with `DATA_NO_CAPABILITY`, so a
   * namespace without `dsh.data` is consistent with a lane that would refuse
   * anyway. Installing a namespace whose every method is refused would tell a
   * program the opposite of what the host will do.
   */
  readonly dataClientPath?: string
  /** The API version the client must report, so a drift is refused at bind time. */
  readonly dataApiVersion?: number
}

/**
 * Render the bind program with a trailing newline, as the PREAMBLE form.
 *
 * KEPT AS A SEPARATE EXPORT because it has existing callers and tests, and
 * because the two forms differ in exactly one way that a reader should see: the
 * preamble form is meant to be JOINED BEFORE user code, so it ends with a newline
 * that separates it from the first user line. The bind form is a whole request of
 * its own and has no such need.
 *
 * THE PRODUCTION PATH NO LONGER USES THIS. `runCell` sends {@link renderBridgeBind}
 * as a hidden control request instead, so user bytes are never rewritten. This
 * function survives for the hand-driven probes and tests that measure the
 * mechanism, and its presence is NOT evidence that the product prepends anything.
 *
 * A CELL MAGIC COULD NOT CARRY THE PREAMBLE. `%%bash` and friends must be the
 * first line of a cell or IPython refuses the cell outright, so prepending turned
 * a working cell into a syntax error -- which is why the old code had a
 * `canPrependPreamble` branch, and why such a cell ran with no fresh binding at
 * all. The hidden-bind design removes that branch entirely.
 */
export function renderBridgePreamble(input: BridgePreambleInput): string {
  return [renderBridgeBind(input), ''].join('\n')
}

/**
 * Render the HIDDEN CONTROL program that binds `dsh` for one cell.
 *
 * WHY THIS REPLACES THE PREAMBLE. The old design prepended this text to the
 * user's cell, which made the executed bytes differ from the authored bytes:
 * tracebacks and SyntaxErrors reported a line number shifted by the preamble's
 * length, and a cell magic -- which must be the first line of its request -- took
 * a different path entirely and received no fresh binding at all. V5 §9 requires
 * the model's code bytes to be the bytes the kernel executes, so the bind became
 * a SEPARATE hidden execution and the user's cell travels untouched.
 *
 * THE NAMESPACE IS LEFT CLEAN. Every temporary is deleted at the end, so `dir()`
 * in the user's code shows `dsh` and nothing else the host added. `_dsh_mod`
 * itself is deleted too; only the `dsh` name is published.
 *
 * NOTHING HERE IS AUTHORITY. The module holds an endpoint and a lease id; which
 * Agent, Session or policy a call runs under is decided by the host from the live
 * execution. See the module docstring in `bridge.ts`.
 */
export function renderBridgeBind(input: BridgePreambleInput): string {
  const literal = (value: string): string => JSON.stringify(value)
  const lines = [
    'import sys as _dsh_sys, types as _dsh_types',
    "_dsh_mod = _dsh_sys.modules.get('dsh')",
    'if _dsh_mod is None:',
    '    _dsh_mod = _dsh_types.ModuleType(\'dsh\')',
    `    _dsh_mod.__dict__['__file__'] = ${literal(input.clientPath)}`,
    "    _dsh_sys.modules['dsh'] = _dsh_mod",
    '    with open(' + literal(input.clientPath) + ", 'rb') as _dsh_handle:",
    '        exec(compile(_dsh_handle.read(), ' + literal(input.clientPath) + ", 'exec'), _dsh_mod.__dict__)",
    `_dsh_mod._bind(${String(input.port)}, ${literal(input.token)}, ${literal(input.leaseId)}, ${literal(input.cellId)}, ${String(input.epoch)})`,
  ]
  if (input.dataClientPath !== undefined) {
    // ── THE `dsh.data` INSTALL (V5 §5.3), AFTER `_bind` AND BEFORE `dsh` IS
    //    HANDED TO THE CELL ─────────────────────────────────────────────────
    //
    // The ORDER is the requirement: the client binds its call channel to the
    // CURRENT cell's capability, so installing it before `_bind` would bind the
    // previous cell's lease -- a live capability under stale authority, which is
    // exactly what the lease mechanism exists to prevent.
    //
    // THE API VERSION IS VERIFIED BEFORE THE CAPABILITY IS EXPOSED. A client from
    // a different version disagrees about which fields are authority-bearing, so
    // the refusal is a bind-time failure rather than a namespace that answers
    // wrongly later. The same rule `BRIDGE_PROTOCOL_VERSION` applies to the
    // transport, applied to the data client.
    //
    // THE FILE IS LOADED BY ABSOLUTE PATH FROM THE PACKAGE THAT OWNS IT (the
    // path is resolved host-side by `DataPlaneService.dataClientPath()`), so
    // nothing depends on the kernel's cwd or on source-tree adjacency.
    //
    // WHY AN EXPLICIT CALL ADAPTER RATHER THAN LETTING `install()` FIND
    // `_channel.call_async` ITSELF. That attribute IS the bridge client's own
    // method and its real signature is `call_async(tool, arguments, timeout)` --
    // `timeout` has NO default (`bridge.ts` `PYTHON_CLIENT_SOURCE`). The data
    // client calls its channel with two arguments, so the self-discovering path
    // would raise `TypeError: call_async() missing 1 required positional
    // argument` on EVERY `dsh.data` call while `install()` itself succeeded --
    // precisely the "namespace whose every method fails" outcome
    // `dsh_data_client.py` says it refuses at install time. The adapter below
    // supplies the bridge's own `_DEFAULT_TIMEOUT`, so the two clients are joined
    // on one explicit, readable line instead of on a signature that happens to
    // match today.
    lines.push(
      `_dsh_data_path = ${literal(input.dataClientPath)}`,
      'with open(_dsh_data_path, \'rb\') as _dsh_data_handle:',
      '    _dsh_data_src = _dsh_data_handle.read()',
      "_dsh_data_mod = _dsh_types.ModuleType('dsh_data_client')",
      "_dsh_data_mod.__dict__['__file__'] = _dsh_data_path",
      "exec(compile(_dsh_data_src, _dsh_data_path, 'exec'), _dsh_data_mod.__dict__)",
      "_dsh_data_api = getattr(_dsh_data_mod, 'DATA_API_VERSION', None)",
      `if _dsh_data_api != ${String(input.dataApiVersion ?? 1)}:`,
      '    raise RuntimeError(',
      "        'the dsh.data client at %s reports API version %r but this host requires "
      + `${String(input.dataApiVersion ?? 1)}`
      + "; refusing to expose a live dsh.data capability'",
      '        % (_dsh_data_path, _dsh_data_api))',
      'async def _dsh_data_call(_dsh_tool, _dsh_args, _dsh_mod=_dsh_mod):',
      '    return await _dsh_mod._channel.call_async(_dsh_tool, _dsh_args, _dsh_mod._DEFAULT_TIMEOUT)',
      '_dsh_data_mod.install(_dsh_mod, _dsh_data_call)',
      'del _dsh_data_path, _dsh_data_handle, _dsh_data_src, _dsh_data_mod, _dsh_data_api, _dsh_data_call',
    )
  }
  lines.push('dsh = _dsh_mod', 'del _dsh_sys, _dsh_types, _dsh_mod', '')
  return lines.join('\n')
}

/**
 * Render the HIDDEN CONTROL program that REVOKES `dsh` for an unbridged cell.
 *
 * WHY AN EXPLICIT REVOKE AND NOT MERELY OMITTING A BIND. The kernel namespace is
 * PERSISTENT. Once a bridged cell has run, `dsh` -- and `sys.modules['dsh']` --
 * stay in the namespace. A later cell that is dispatched with no authority used
 * to inherit that object, so the model could hold and call a capability whose
 * lease had already settled, and the only thing it would learn is
 * `LEASE_UNKNOWN`, which does not explain that the capability is gone by design.
 *
 * MEASURED BEFORE THIS EXISTED (see `qualification/results/P8-bind/before.json`):
 * an authority-less cell reported `dsh_in_dir: true`, `import: OK`, and a call
 * through the surviving object returned `LEASE_UNKNOWN`. So the old comment's
 * claim that `dsh` "is simply absent" was not generally true in a persistent
 * namespace.
 *
 * Both the namespace name and the module entry are removed. Removing only one
 * would leave the capability reachable by `import dsh`, which is the same defect
 * wearing a different name.
 */
export function renderBridgeRevoke(): string {
  return [
    'import sys as _dsh_sys',
    "globals().pop('dsh', None)",
    "_dsh_sys.modules.pop('dsh', None)",
    'del _dsh_sys',
  ].join('\n')
}

/**
 * Whether a cell can carry the preamble at all.
 *
 * A cell magic must be the first line, so a cell that starts with `%%` cannot be
 * prefixed. Checked on the RAW source's first non-blank line, which is what
 * IPython's own transformer looks at.
 *
 * NO LONGER CALLED BY `runCell`. Kept because it is exported API with its own
 * tests, and because the property it tests -- "would prepending change what this
 * cell means" -- is what a future caller would still need to ask. The bind path
 * no longer prepends anything, so the answer no longer gates a capability.
 */
export function canPrependPreamble(code: string): boolean {
  for (const line of code.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    return !trimmed.startsWith('%%')
  }
  return true
}

/**
 * The Python client, as written to disk at kernel start.
 *
 * NOTHING IN HERE IS AUTHORITY. The module holds an endpoint and a lease id
 * handed to it by the preamble; it can only ASK. Which Agent, Session, or policy
 * the call runs under is decided by the host from the live execution, so a
 * program that rewrites this file or sends hand-made frames gains nothing --
 * see the module docstring in `bridge.ts`.
 */
export const PYTHON_CLIENT_SOURCE = `"""DSH native-tool bridge client, injected into the kernel by the host.

\`dsh.call(name, args)\` is an awaitable that runs one DSH native tool through the
host's real ToolRuntime pipeline and returns its canonical value. Nothing about
WHO the call runs as travels on the wire: the host stamps the Agent, Session,
root call id, parent execution token and cancellation from the live \`ipython\`
call. A program therefore cannot widen its own authority by naming it.

Errors arrive as \`BridgeError\` with a stable \`code\` and the policy's own
\`message\`, so a denial reads as a denial rather than as a transport failure.
"""
import asyncio as _asyncio
import hashlib as _hashlib
import json as _json
import os as _os
import socket as _socket
import struct as _struct
import sys as _sys
import threading as _threading

_DSH_BRIDGE_VERSION = 1
_HEADER = _struct.Struct(">I")
_MAX_FRAME_BYTES = 4 * 1024 * 1024
_DEFAULT_TIMEOUT = 120.0


class BridgeError(RuntimeError):
    """One refused or failed nested call, with the host's own classification."""

    def __init__(self, code, message):
        super().__init__("%s: %s" % (code, message))
        self.code = code
        self.message = message


class Artifact:
    """A canonical result too large to travel inline, addressed by REFERENCE.

    The bytes were retained ONCE by the host from the single execution that
    produced them, so reading this back is not a re-run and cannot differ from
    what the tool returned.

    ── THE PATH IS NOT THE AUTHORITY, AND USUALLY IS NOT HERE AT ALL ──────────

    This class used to expose a raw host path and open it directly. That made the
    PATH the authority: nothing bound the bytes to the observation, the grant, the
    scope or the digest, and any same-UID writer could replace, truncate or move
    the file while the reference still looked valid. \`\`verify()\`\` existed, but a
    digest you have to remember to check is not a binding.

    \`\`artifact\`\` is the project's own content-addressed reference
    (\`\`artifact:sha256:<digest>\`\`). Read the bytes through it with
    :meth:\`pages\`, :meth:\`read_range\` or :meth:\`save_attachment\`, which go through
    the unified plane's cursor, realm, quota and provenance checks -- so a
    reference to an object that was replaced, or that this caller was never
    granted, is refused by the plane rather than served by the filesystem.

    \`\`path\`\` is present ONLY when the host retained the bytes on its own scratch
    plane (\`\`plane == "bridge-scratch"\`\`), which is what happens when the
    composition mounted no unified store. It is a convenience for a host-side
    debugging session and NOT a capability: prefer the reference methods, and
    check \`\`plane\`\` before using it.
    """

    def __init__(self, artifact, size, sha256, plane="bridge-scratch", path=None):
        self.artifact = artifact
        self.bytes = size
        self.sha256 = sha256
        #: Which plane retained the bytes: "unified" or "bridge-scratch".
        self.plane = plane
        #: Raw host path, ONLY on the bridge-scratch plane. Not authority.
        self.path = path

    def _plane_client(self):
        """The unified plane client, or a refusal that names the missing piece.

        NOT a second data route. This returns the \`\`dsh.data\`\` namespace the host
        installed on this very module, looked up AT CALL TIME so it is the same
        client the rest of the namespace uses and so a rebind between cells is
        honoured. A private socket, a second registry, or a re-implementation of
        paging here would be exactly the parallel path V5 §5.1 forbids.
        """
        module = _sys.modules.get("dsh")
        client = getattr(module, "data", None) if module is not None else None
        if client is None:
            raise BridgeError(
                "DATA_PLANE_UNAVAILABLE",
                "this result is addressed by reference (%s) but no dsh.data client is installed in this "
                "kernel, so the reference cannot be paged. The host must install the data namespace in "
                "the per-cell preamble before an oversized result can be read." % (self.artifact,),
            )
        return client

    async def observation(self):
        """Open this artifact as a dsh.data Observation, by reference.

        Returns the host's own descriptor for the object, which is what carries
        the identity the plane checks. This is the entry point every other
        reference method here is built on.
        """
        client = self._plane_client()
        return await client.artifacts.open(
            attachment_id=self.artifact, name="", bytes=self.bytes,
        )

    async def pages(self, max_bytes=65536, max_pages=None):
        """Walk the exact bytes in bounded windows, through the plane."""
        observation = await self.observation()
        return await observation.pages(max_bytes=max_bytes, max_pages=max_pages)

    async def read_range(self, offset, length):
        """Read one byte range through the plane, with the plane's own checks."""
        observation = await self.observation()
        return await observation.read_range(offset, length)

    async def save_attachment(self, name=None):
        """Copy the exact bytes into DSH's public attachment store, via the plane."""
        observation = await self.observation()
        return await observation.save_attachment(name=name)

    def load(self):
        """The exact bytes, read from the host scratch plane.

        ONLY VALID when \`\`plane == "bridge-scratch"\`\`. On the unified plane there
        is no path to open and this raises rather than reaching for one, because
        a silent fallback to a filesystem read is the authority confusion this
        class exists to remove. Use :meth:\`pages\` or :meth:\`read_range\` there.
        """
        if self.path is None:
            raise BridgeError(
                "ARTIFACT_NOT_A_PATH",
                "%s is retained on the %r plane and carries no host path; read it by reference with "
                "pages() / read_range() / save_attachment() instead of load()" % (self.artifact, self.plane),
            )
        with open(self.path, "rb") as handle:
            return handle.read()

    def text(self, encoding="utf-8"):
        return self.load().decode(encoding)

    def json(self):
        return _json.loads(self.text())

    def verify(self):
        """Whether the bytes on disk still hash to what the host reported.

        SCRATCH PLANE ONLY. On the unified plane the digest is checked by the
        plane on every read, so there is nothing here to re-check and this returns
        True without opening anything.
        """
        if self.path is None:
            return True
        return _hashlib.sha256(self.load()).hexdigest() == self.sha256

    def __repr__(self):
        return "Artifact(plane=%s, bytes=%d, sha256=%s...)" % (self.plane, self.bytes, self.sha256[:12])


def _artifact_from(payload):
    """Build an Artifact from the host's reply envelope.

    ONE constructor, used by both the sync and the async waiter, so the two paths
    cannot drift into reading different fields -- which is what happened when the
    envelope changed shape and only one site was updated.

    A reply with no \`\`artifact\`\` field is a protocol disagreement, not a value:
    the host always sends the reference, so an envelope that omits it means the
    two sides disagree about what a large result IS. Raising a named refusal is
    better than constructing an Artifact with a null reference that fails later,
    at the point of use, with a message about the wrong thing.
    """
    if not isinstance(payload, dict) or not payload.get("artifact"):
        raise BridgeError(
            "ARTIFACT_ENVELOPE_INVALID",
            "the host reported a large result without an artifact reference; the two sides disagree "
            "about the delivery envelope",
        )
    return Artifact(
        payload.get("artifact"),
        payload.get("bytes"),
        payload.get("sha256"),
        payload.get("plane", "bridge-scratch"),
        payload.get("path"),
    )


class _Channel:
    """One connection to the host listener, with a reader thread per socket.

    A single reader thread owns every recv, because two readers on one socket
    race for frames and silently lose them -- the same failure the broker's shell
    router exists to prevent. Replies are matched by request id.
    """

    def __init__(self):
        self._socket = None
        self._reader = None
        self._lock = _threading.Lock()
        self._waiters = {}
        self._counter = 0
        self._port = 0
        self._token = ""
        self._lease = ""
        self._cell = ""
        self._epoch = 0

    def bind(self, port, token, lease_id, cell_id, epoch):
        with self._lock:
            self._port = port
            self._token = token
            self._lease = lease_id
            self._cell = cell_id
            self._epoch = epoch

    def _connect(self):
        """Open the socket and complete the handshake. Caller holds the lock."""
        sock = _socket.create_connection(("127.0.0.1", self._port), timeout=30.0)
        sock.settimeout(None)
        hello = _json.dumps({
            "type": "hello",
            "protocol": _DSH_BRIDGE_VERSION,
            "token": self._token,
        }).encode("utf-8")
        sock.sendall(_HEADER.pack(len(hello)) + hello)
        reply = self._read_frame(sock)
        if reply is None:
            raise BridgeError("BRIDGE_CLOSED", "the host closed the bridge during the handshake")
        if reply.get("type") == "fatal":
            raise BridgeError(reply.get("code", "BRIDGE_REFUSED"), reply.get("message", "the handshake was refused"))
        if not reply.get("ok"):
            raise BridgeError("BRIDGE_REFUSED", "the handshake was not accepted")
        self._socket = sock
        self._reader = _threading.Thread(target=self._read_loop, args=(sock,), daemon=True)
        self._reader.start()

    @staticmethod
    def _read_exactly(sock, count):
        chunks = []
        remaining = count
        while remaining > 0:
            chunk = sock.recv(remaining)
            if not chunk:
                return None
            chunks.append(chunk)
            remaining -= len(chunk)
        return b"".join(chunks)

    @classmethod
    def _read_frame(cls, sock):
        header = cls._read_exactly(sock, _HEADER.size)
        if header is None:
            return None
        (length,) = _HEADER.unpack(header)
        if length > _MAX_FRAME_BYTES:
            raise BridgeError("FRAME_TOO_LARGE", "the host declared a frame larger than the limit")
        body = cls._read_exactly(sock, length)
        if body is None:
            return None
        return _json.loads(body.decode("utf-8"))

    def _read_loop(self, sock):
        while True:
            try:
                message = self._read_frame(sock)
            except Exception:
                message = None
            if message is None:
                with self._lock:
                    waiters = list(self._waiters.values())
                    self._waiters.clear()
                    self._socket = None
                for waiter in waiters:
                    waiter.fail(BridgeError("BRIDGE_CLOSED", "the host closed the bridge before answering"))
                return
            if message.get("type") == "fatal":
                with self._lock:
                    waiters = list(self._waiters.values())
                    self._waiters.clear()
                    self._socket = None
                for waiter in waiters:
                    waiter.fail(BridgeError(message.get("code", "BRIDGE_FATAL"), message.get("message", "the bridge refused this connection")))
                return
            request_id = message.get("requestId")
            with self._lock:
                waiter = self._waiters.pop(request_id, None)
            if waiter is None:
                continue
            if message.get("ok"):
                waiter.succeed(message)
            else:
                error = message.get("error") or {}
                waiter.fail(BridgeError(error.get("code", "BRIDGE_ERROR"), error.get("message", "the call failed")))

    def _ensure_locked(self):
        if self._socket is not None:
            return self._socket
        self._connect()
        return self._socket

    def _send(self, tool, arguments, waiter):
        """Register \`waiter\` and put the request on the wire under ONE lock.

        WHY THE REGISTRATION LIVES IN HERE AND NOT IN THE CALLER. The reader
        thread matches a reply to a waiter by request id, and a reply it cannot
        match is DISCARDED rather than held. So when the waiter is registered
        after the request is already on the wire, a reply that arrives in between
        is dropped, and the caller then waits out its whole timeout for an answer
        that was already delivered -- a lost reply reported as a slow host. The
        window is not theoretical: the reader is blocked on this lock holding a
        parsed reply while the send holds it, so the reader is the very next lock
        holder the moment the send releases.

        ONE ACQUISITION IS THE POINT. Registering and sending under the same lock
        is what makes the ordering atomic instead of hopeful: the reader cannot
        observe the request until after its waiter exists. This is the same rule
        the broker's own shell channel already enforces -- \`broker.py\`'s
        \`ShellRouter.register\` is documented "Call BEFORE sending the request",
        and its reader counts a frame whose parent matches no waiter instead of
        delivering it. Applying it here is consistency with that router, not a
        new mechanism.

        The waiter is built by the CALLER, because the async one has to be
        created from the running event loop.
        """
        with self._lock:
            sock = self._ensure_locked()
            self._counter += 1
            request_id = "r%d" % self._counter
            payload = _json.dumps({
                "type": "call",
                "requestId": request_id,
                "tool": tool,
                "arguments": arguments,
                "leaseId": self._lease,
                "cellId": self._cell,
                "epoch": self._epoch,
            }).encode("utf-8")
            if len(payload) > _MAX_FRAME_BYTES:
                raise BridgeError(
                    "ARGUMENTS_TOO_LARGE",
                    "the arguments for %r exceed the %d-byte frame limit" % (tool, _MAX_FRAME_BYTES),
                )
            self._waiters[request_id] = waiter
            try:
                sock.sendall(_HEADER.pack(len(payload)) + payload)
            except BaseException:
                # The request never reached the wire, so no reply can arrive for
                # it. Leaving the waiter registered would make it wait out the
                # full timeout for a request that was never sent.
                self._waiters.pop(request_id, None)
                raise
        return request_id

    def call_sync(self, tool, arguments, timeout):
        waiter = _SyncWaiter()
        request_id = self._send(tool, arguments, waiter)
        if not waiter.event.wait(timeout):
            with self._lock:
                self._waiters.pop(request_id, None)
            raise BridgeError("TIMEOUT", "%s did not answer within %ss" % (tool, timeout))
        return waiter.result()

    async def call_async(self, tool, arguments, timeout):
        loop = _asyncio.get_running_loop()
        # Built HERE, before the send: \`create_future\` must run on the loop's own
        # thread, and a future created after the send could be resolved by the
        # reader before it exists -- the same lost-reply window as the sync path.
        waiter = _AsyncWaiter(loop)
        request_id = self._send(tool, arguments, waiter)
        try:
            return await _asyncio.wait_for(waiter.future, timeout)
        except _asyncio.TimeoutError:
            # wait_for raises asyncio.TimeoutError, which is NOT a BridgeError
            # and carries no code. Letting it through would make the async path
            # report a different exception type from the sync one for the same
            # condition, and would break the contract this module's docstring
            # states: every refusal arrives as BridgeError with a stable code,
            # so a caller can branch without parsing prose.
            # MEASURED before this was added: a 4 s tool called with
            # timeout=1.0 raised TimeoutError (MRO TimeoutError,OSError,
            # Exception) with isinstance(exc, BridgeError) False and no .code.
            raise BridgeError("TIMEOUT", "%s did not answer within %ss" % (tool, timeout))
        finally:
            with self._lock:
                self._waiters.pop(request_id, None)


class _SyncWaiter:
    def __init__(self):
        self.event = _threading.Event()
        self._value = None
        self._error = None

    def succeed(self, message):
        self._value = message
        self.event.set()

    def fail(self, error):
        self._error = error
        self.event.set()

    def result(self):
        if self._error is not None:
            raise self._error
        message = self._value or {}
        if "artifact" in message:
            return _artifact_from(message["artifact"])
        return message.get("value")


class _AsyncWaiter:
    def __init__(self, loop):
        self.future = loop.create_future()
        self._loop = loop

    def succeed(self, message):
        if self.future.done():
            return
        if "artifact" in message:
            value = _artifact_from(message["artifact"])
        else:
            value = message.get("value")
        self._loop.call_soon_threadsafe(_resolve, self.future, value)

    def fail(self, error):
        if self.future.done():
            return
        self._loop.call_soon_threadsafe(_reject, self.future, error)


def _resolve(future, value):
    if not future.done():
        future.set_result(value)


def _reject(future, error):
    if not future.done():
        future.set_exception(error)


class _ToolNamespace:
    """\`await dsh.tools.read(file_path=...)\` -- attribute access as a call."""

    def __init__(self, channel):
        self._channel = channel

    def __getattr__(self, name):
        if name.startswith("_"):
            raise AttributeError(name)

        async def invoke(**kwargs):
            return await self._channel.call_async(name, kwargs, _DEFAULT_TIMEOUT)

        invoke.__name__ = name
        return invoke


_channel = _Channel()


def _bind(port, token, lease_id, cell_id, epoch):
    """Point this module at the capability the host minted for the CURRENT cell.

    Called by the host's per-cell preamble. Rebinding is normal: one kernel
    serves many cells, and each gets its own capability.
    """
    _channel.bind(port, token, lease_id, cell_id, epoch)


async def call(name, args=None, timeout=_DEFAULT_TIMEOUT, **kwargs):
    """Run one DSH native tool and return its canonical value.

    \`args\` is the tool's argument object. Keyword arguments are merged into it,
    so both \`call("read", {"file_path": "a.txt"})\` and
    \`call("read", file_path="a.txt")\` work.
    """
    merged = dict(args) if args else {}
    merged.update(kwargs)
    return await _channel.call_async(name, merged, timeout)


def call_sync(name, args=None, timeout=_DEFAULT_TIMEOUT, **kwargs):
    """\`call\`, for a cell that is not async. Blocks the kernel thread."""
    merged = dict(args) if args else {}
    merged.update(kwargs)
    return _channel.call_sync(name, merged, timeout)


tools = _ToolNamespace(_channel)
`

/** The bytes of the client, for a caller that wants to record its digest. */
export function bridgeClientDigest(): string {
  return createHash('sha256').update(PYTHON_CLIENT_SOURCE, 'utf8').digest('hex')
}
