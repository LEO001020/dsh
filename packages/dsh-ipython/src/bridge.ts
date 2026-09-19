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
 * alive. A lease is minted immediately before a cell is dispatched and revoked
 * when that cell settles, and `revoke` DRAINS in-flight calls before it returns.
 * A callback arriving after settlement is rejected with `LEASE_REVOKED`, and the
 * three other staleness channels are rejected separately so a reader can tell
 * them apart: a mismatched kernel `epoch`, a mismatched `cellId`, and an unknown
 * lease id. A background thread that outlives its cell therefore cannot invoke a
 * native tool with stale authority; long-lived work must go through DSH
 * Jobs/subagents or a fresh live cell.
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
 * The bytes are written to disk ONCE, by the host, from the SAME single
 * execution that produced the value -- the tool is never re-run to make a result
 * fit. Python receives a locator and reads the exact bytes back, so a bounded
 * model projection and a lossless data plane coexist without either one lying
 * about the other.
 */
export interface BridgeArtifact {
  readonly path: string
  readonly bytes: number
  readonly sha256: string
}

/** What the host returns for one nested call. Exactly one of the three arms. */
export type NativeCallOutcome =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: true; readonly artifact: BridgeArtifact }
  | { readonly ok: false; readonly error: BridgeFailure }

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
  readonly handler: (call: NativeCallRequest) => Promise<NativeCallOutcome>
  /** Cell-scoped cancellation. An aborted lease accepts no new calls. */
  readonly signal?: AbortSignal
}

/** Why a lease was refused. Every arm is a distinct, testable rejection. */
export type LeaseRejectionCode =
  | 'LEASE_UNKNOWN'
  | 'LEASE_REVOKED'
  | 'LEASE_ABORTED'
  | 'EPOCH_MISMATCH'
  | 'CELL_MISMATCH'
  | 'DUPLICATE_REQUEST_ID'
  | 'FORGED_AUTHORITY'
  | 'TOOL_NAME_INVALID'
  | 'ARGUMENTS_NOT_JSON'

/** A refusal, carrying the code and the values that disagreed. */
export class LeaseRejection extends Error {
  readonly code: LeaseRejectionCode

  constructor(code: LeaseRejectionCode, message: string) {
    super(message)
    this.name = 'LeaseRejection'
    this.code = code
  }
}

/**
 * One live cell's capability.
 *
 * `inFlight` is what makes revocation a real barrier rather than a flag: a
 * nested call that was already accepted when the cell settled is awaited before
 * `revoke` resolves, so the host never reports a cell finished while a tool call
 * it authorised is still running.
 */
export class CellLease {
  readonly id: string
  readonly sessionId: string
  readonly cellId: string
  readonly epoch: number
  private readonly handler: (call: NativeCallRequest) => Promise<NativeCallOutcome>
  private readonly inFlight = new Set<Promise<unknown>>()
  private readonly seenRequestIds = new Set<string>()
  private revoked: string | undefined

  constructor(input: CellLeaseInput) {
    this.id = randomUUID()
    this.sessionId = input.sessionId
    this.cellId = input.cellId
    this.epoch = input.epoch
    this.handler = input.handler
    if (input.signal !== undefined) {
      if (input.signal.aborted) this.revoked = 'the enclosing call was already cancelled'
      else input.signal.addEventListener('abort', () => { this.revoked ??= 'the enclosing call was cancelled' }, { once: true })
    }
  }

  /** True while this lease may still authorise a call. */
  get live(): boolean {
    return this.revoked === undefined
  }

  /** Why this lease is no longer live, or undefined while it is. */
  get revokedReason(): string | undefined {
    return this.revoked
  }

  /**
   * Validate one incoming call against this lease and run it.
   *
   * The checks run in the order a reader would ask them -- is the lease live, is
   * the caller in the epoch it thinks it is, is it the cell it thinks it is, has
   * this exact request already been answered -- so the FIRST failure names the
   * most fundamental disagreement.
   */
  async invoke(call: NativeCallRequest): Promise<NativeCallOutcome> {
    if (this.revoked !== undefined) {
      throw new LeaseRejection('LEASE_REVOKED', `the cell that held this capability has settled: ${this.revoked}`)
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
    if (this.seenRequestIds.has(call.requestId)) {
      // DEFINED BEHAVIOUR, not an accident. A repeated request id is refused
      // rather than served twice or silently deduplicated: the caller cannot
      // distinguish "already ran" from "ran again" from the reply alone, so
      // serving it twice could double a mutation, and deduplicating would make
      // a lost reply look like a success. Refusing is the only answer that
      // never misrepresents what happened.
      throw new LeaseRejection(
        'DUPLICATE_REQUEST_ID',
        `request id ${call.requestId} was already answered on this capability; it is refused rather than replayed`,
      )
    }
    this.seenRequestIds.add(call.requestId)

    const flight = this.handler(call)
    this.inFlight.add(flight)
    try {
      return await flight
    } finally {
      this.inFlight.delete(flight)
    }
  }

  /**
   * Revoke the capability and wait for everything it authorised.
   *
   * Idempotent: a second call waits for the same drain and does not change the
   * recorded reason, so the first (true) cause is what a later reader sees.
   */
  async revoke(reason: string): Promise<void> {
    this.revoked ??= reason
    // Loop rather than await-once: a handler may itself be settling another
    // accepted call, and reporting quiescence with work outstanding is the one
    // thing a revocation barrier exists to prevent.
    while (this.inFlight.size > 0) {
      await Promise.allSettled([...this.inFlight])
    }
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
   * the host report `EPOCH_MISMATCH` and `LEASE_REVOKED` as different facts
   * instead of collapsing both into "bad token".
   */
  mintLease(input: CellLeaseInput): CellLease {
    if (this.closed) throw new Error('the bridge server is closed')
    const lease = new CellLease(input)
    this.leases.set(lease.id, lease)
    this.activeLease = lease
    return lease
  }

  /** Drop a lease from the live table. Called after {@link CellLease.revoke}. */
  releaseLease(lease: CellLease): void {
    this.leases.delete(lease.id)
    if (this.activeLease === lease) this.activeLease = undefined
  }

  /** Resolve a lease by id, or undefined. Never returns a revoked lease as live. */
  lease(id: string): CellLease | undefined {
    return this.leases.get(id)
  }

  /** Rotate the kernel token. Called when a new kernel process starts. */
  rotateKernelToken(): void {
    this.kernelToken = randomBytes(32).toString('hex')
  }

  /** The per-cell Python preamble that binds `dsh` in the cell's namespace. */
  preamble(lease: CellLease): string {
    return renderBridgePreamble({
      clientPath: this.clientPath,
      port: this.port,
      token: this.tokenForPreamble,
      leaseId: lease.id,
      cellId: lease.cellId,
      epoch: lease.epoch,
    })
  }

  /** Stop listening and revoke everything. Idempotent. */
  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    const leases = [...this.leases.values()]
    this.leases.clear()
    this.activeLease = undefined
    await Promise.allSettled(leases.map(async lease => { await lease.revoke('the bridge server was shut down') }))
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

    let outcome: NativeCallOutcome
    try {
      outcome = await lease.invoke({
        requestId,
        tool,
        arguments: frame['arguments'],
        cellId,
        epoch,
        leaseId,
      })
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
   * frame; at or over it the exact canonical bytes are written once and the
   * reply carries a locator. The model-facing projection is a separate matter
   * entirely -- it is the tool's own `render`, and it is unaffected by which door
   * the program's copy takes.
   */
  deliver(tool: string, callId: string, value: unknown): NativeCallOutcome {
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
    void callId
    return { ok: true, artifact: { path, bytes, sha256: digest } }
  }
}

/** Everything the preamble needs. All of it host-minted. */
export interface BridgePreambleInput {
  readonly clientPath: string
  readonly port: number
  readonly token: string
  readonly leaseId: string
  readonly cellId: string
  readonly epoch: number
}

/**
 * Render the preamble prepended to one cell.
 *
 * WHY A PREAMBLE AND NOT A HOST-SIDE HOOK. The kernel is a grandchild process
 * the broker starts; the host has no channel into its namespace that does not go
 * through a cell. A preamble is the one mechanism that is guaranteed to run
 * before the model's code, in the model's namespace, without a second protocol.
 *
 * THE NAMESPACE IS LEFT CLEAN. Every temporary the preamble needs is deleted at
 * its end, so `dir()` in the model's code shows `dsh` and nothing else that the
 * host added. A cell that raises still leaves a clean namespace, because the
 * preamble's own statements have already completed.
 *
 * A CELL MAGIC IS NOT PREPENDED TO. `%%bash` and friends must be the first line
 * of a cell or IPython refuses the cell outright, so prepending would turn a
 * working cell into a syntax error. Such a cell runs unbridged and `dsh` is
 * simply absent; the caller can tell from the absence rather than from a
 * silently stale capability.
 */
export function renderBridgePreamble(input: BridgePreambleInput): string {
  const literal = (value: string): string => JSON.stringify(value)
  return [
    'import sys as _dsh_sys, types as _dsh_types',
    "_dsh_mod = _dsh_sys.modules.get('dsh')",
    'if _dsh_mod is None:',
    '    _dsh_mod = _dsh_types.ModuleType(\'dsh\')',
    `    _dsh_mod.__dict__['__file__'] = ${literal(input.clientPath)}`,
    "    _dsh_sys.modules['dsh'] = _dsh_mod",
    '    with open(' + literal(input.clientPath) + ", 'rb') as _dsh_handle:",
    '        exec(compile(_dsh_handle.read(), ' + literal(input.clientPath) + ", 'exec'), _dsh_mod.__dict__)",
    `_dsh_mod._bind(${String(input.port)}, ${literal(input.token)}, ${literal(input.leaseId)}, ${literal(input.cellId)}, ${String(input.epoch)})`,
    'dsh = _dsh_mod',
    'del _dsh_sys, _dsh_types, _dsh_mod',
    '',
  ].join('\n')
}

/**
 * Whether a cell can carry the preamble at all.
 *
 * A cell magic must be the first line, so a cell that starts with `%%` cannot be
 * prefixed. Checked on the RAW source's first non-blank line, which is what
 * IPython's own transformer looks at.
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
    """A canonical result too large to travel inline.

    The bytes were written ONCE by the host from the single execution that
    produced them, so reading this back is not a re-run and cannot differ from
    what the tool returned. \`load()\` returns exactly those bytes.
    """

    def __init__(self, path, size, sha256):
        self.path = path
        self.bytes = size
        self.sha256 = sha256

    def load(self):
        with open(self.path, "rb") as handle:
            return handle.read()

    def text(self, encoding="utf-8"):
        return self.load().decode(encoding)

    def json(self):
        return _json.loads(self.text())

    def verify(self):
        """Whether the bytes on disk still hash to what the host reported."""
        return _hashlib.sha256(self.load()).hexdigest() == self.sha256

    def __repr__(self):
        return "Artifact(bytes=%d, sha256=%s...)" % (self.bytes, self.sha256[:12])


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

    def _send(self, tool, arguments):
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
            sock.sendall(_HEADER.pack(len(payload)) + payload)
        return request_id

    def call_sync(self, tool, arguments, timeout):
        request_id = self._send(tool, arguments)
        waiter = _SyncWaiter()
        with self._lock:
            self._waiters[request_id] = waiter
        if not waiter.event.wait(timeout):
            with self._lock:
                self._waiters.pop(request_id, None)
            raise BridgeError("TIMEOUT", "%s did not answer within %ss" % (tool, timeout))
        return waiter.result()

    async def call_async(self, tool, arguments, timeout):
        loop = _asyncio.get_running_loop()
        request_id = self._send(tool, arguments)
        waiter = _AsyncWaiter(loop)
        with self._lock:
            self._waiters[request_id] = waiter
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
            artifact = message["artifact"]
            return Artifact(artifact.get("path"), artifact.get("bytes"), artifact.get("sha256"))
        return message.get("value")


class _AsyncWaiter:
    def __init__(self, loop):
        self.future = loop.create_future()
        self._loop = loop

    def succeed(self, message):
        if self.future.done():
            return
        if "artifact" in message:
            artifact = message["artifact"]
            value = Artifact(artifact.get("path"), artifact.get("bytes"), artifact.get("sha256"))
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
