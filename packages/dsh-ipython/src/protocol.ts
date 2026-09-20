/**
 * Bounded framing for the host <-> broker control channel.
 *
 * WHY THIS EXISTS AT ALL. The broker runs `jupyter_client` and owns the kernel;
 * the host must be able to start cells, interrupt them, and read their output
 * without ever sharing a byte stream with the code under test. The kernel's own
 * `print` output travels on IOPub, which is a lossy publish stream with no
 * acknowledgement. If control messages were multiplexed onto the same channel,
 * a cell that floods stdout would delay or corrupt the host's own commands --
 * the architecture document calls this out explicitly ("不能与用户stdout共享
 * 未加保护的NDJSON协议").
 *
 * So control rides DSH's inherited subprocess control descriptor
 * (`SUBPROCESS_CONTROL_FD`, fd 7) as its own duplex byte channel, and this
 * module is the only place that knows the wire shape.
 *
 * WHY A LENGTH PREFIX AND NOT NDJSON. NDJSON needs a newline to be
 * distinguishable from payload, which means either escaping the payload or
 * accepting that a cell's code cannot contain the delimiter. A 4-byte
 * big-endian length prefix is unambiguous for arbitrary UTF-8 and lets the
 * reader reject an oversized frame BEFORE allocating it -- which is the property
 * that keeps a hostile or merely careless peer from OOMing the other side.
 *
 * The bound is enforced in BOTH directions and at both ends. A frame larger than
 * {@link MAX_FRAME_BYTES} is a protocol violation, not something to truncate:
 * silently trimming a control message would turn a corrupt request into a
 * plausible one.
 */

/** Bytes of big-endian length prefix in front of every frame. */
export const FRAME_HEADER_BYTES = 4

/**
 * Largest frame either side will send or accept.
 *
 * Cell source is the only field with real size, and 4 MiB is far more than any
 * cell a model should be writing. The number matters less than its existence:
 * without it, a reader that trusts the prefix would `read(n)` for whatever the
 * peer claimed.
 */
export const MAX_FRAME_BYTES = 4 * 1024 * 1024

/** A frame that could not be parsed. Never thrown across an await boundary. */
export class FrameError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'FrameError'
  }
}

/**
 * Encode one message as a length-prefixed frame.
 * @param value - any JSON-serializable value; a value that cannot be serialized throws.
 * @returns the complete frame bytes.
 */
export function encodeFrame(value: unknown): Buffer {
  const payload = Buffer.from(JSON.stringify(value), 'utf8')
  if (payload.byteLength > MAX_FRAME_BYTES) {
    throw new FrameError(
      `frame of ${payload.byteLength} bytes exceeds the ${MAX_FRAME_BYTES}-byte limit`,
    )
  }
  const frame = Buffer.allocUnsafe(FRAME_HEADER_BYTES + payload.byteLength)
  frame.writeUInt32BE(payload.byteLength, 0)
  payload.copy(frame, FRAME_HEADER_BYTES)
  return frame
}

/**
 * Incremental decoder for the framing above.
 *
 * A stream reader gets arbitrary chunk boundaries, so a frame routinely arrives
 * split across several chunks and several frames can arrive in one chunk. The
 * decoder owns that reassembly so no caller has to reason about it.
 *
 * `onFrame` is called synchronously for each complete frame. If it throws, the
 * decoder stops and reports through `onError`: continuing after a consumer
 * failure would deliver later frames to a handler that already rejected an
 * earlier one, which is worse than stopping.
 */
export class FrameDecoder {
  private buffer: Buffer = Buffer.alloc(0)
  private failure: FrameError | undefined
  private readonly onFrame: (value: unknown) => void
  private readonly onError: (error: FrameError) => void

  constructor(
    onFrame: (value: unknown) => void,
    onError: (error: FrameError) => void,
  ) {
    this.onFrame = onFrame
    this.onError = onError
  }

  /** True once the decoder has permanently stopped. */
  get failed(): boolean {
    return this.failure !== undefined
  }

  /** Feed one chunk of stream bytes. */
  push(chunk: Buffer): void {
    if (this.failure !== undefined) return
    this.buffer = this.buffer.byteLength === 0 ? chunk : Buffer.concat([this.buffer, chunk])
    try {
      this.drain()
    } catch (error) {
      const failure = error instanceof FrameError
        ? error
        : new FrameError(`frame consumer failed: ${String(error)}`)
      this.failure = failure
      this.buffer = Buffer.alloc(0)
      this.onError(failure)
    }
  }

  private drain(): void {
    for (;;) {
      if (this.buffer.byteLength < FRAME_HEADER_BYTES) return
      const length = this.buffer.readUInt32BE(0)
      // Checked against the declared length BEFORE waiting for the bytes, so an
      // implausible claim is rejected immediately instead of after buffering.
      if (length > MAX_FRAME_BYTES) {
        throw new FrameError(
          `declared frame length ${length} exceeds the ${MAX_FRAME_BYTES}-byte limit`,
        )
      }
      const end = FRAME_HEADER_BYTES + length
      if (this.buffer.byteLength < end) return
      const payload = this.buffer.subarray(FRAME_HEADER_BYTES, end)
      this.buffer = this.buffer.subarray(end)
      let parsed: unknown
      try {
        parsed = JSON.parse(payload.toString('utf8'))
      } catch (error) {
        throw new FrameError(`frame payload is not valid JSON: ${String(error)}`)
      }
      this.onFrame(parsed)
    }
  }
}

/** Operations the host may send. */
export type BrokerOpName =
  | 'start'
  | 'execute'
  | 'interrupt'
  | 'restart'
  | 'shutdown'
  | 'status'
  | 'kernel_info'

export interface BrokerRequest {
  /** Host-minted identity; every reply carries it back and nothing else may. */
  readonly id: string
  readonly op: BrokerOpName
  /** Cell source for `execute`. */
  readonly code?: string
  /** Host-side cell label used for late-output attribution. */
  readonly cellId?: string
  /**
   * Run this cell as a HIDDEN control request rather than as user code.
   *
   * The host uses this for its own per-cell capability bind: the bind must run
   * in the same namespace as the user's cell, and must NOT be the user's source.
   * `silent` is the Jupyter protocol's own mechanism for that (`kernelbase.py:793`,
   * `:810`), so no rewriting of user bytes is needed.
   *
   * Defaults to `false`, and the broker validates it as a real boolean rather
   * than coercing: a truthy string would silently turn a user cell into a hidden
   * one.
   */
  readonly silent?: boolean
  /**
   * Whether this request enters IPython's input history.
   *
   * Defaults to `not silent`, which is the kernel's own default
   * (`kernelbase.py:794`). Sent explicitly rather than left implicit so the
   * source-identity oracle can assert that the USER cell is the one recorded.
   */
  readonly storeHistory?: boolean
  /** Bounds for this cell only; the broker applies its own floor as well. */
  readonly outputCapBytes?: number
  readonly timeoutMs?: number
  readonly interruptGraceMs?: number
}

/** Outcome of one cell, as the broker established it. */
export type CellOutcome =
  /** execute_reply AND the matching idle were both observed. */
  | 'ok'
  | 'error'
  /** Cancelled before the request was handled; the kernel never ran it. */
  | 'aborted'
  /** The host asked to stop and the kernel reported KeyboardInterrupt. */
  | 'interrupted'
  /** The kernel process is gone. */
  | 'kernel_died'
  /** The cell did not settle and the kernel was reset. Nothing is claimed. */
  | 'unknown'

/** One captured output stream chunk, already bounded by the broker. */
export interface CapturedOutput {
  /** Retained text. The HEAD of the stream, not the tail: a truncated traceback
   * is useless, but a truncated preamble still shows what the cell was doing. */
  readonly text: string
  /** Total bytes the broker observed for this cell, including dropped ones. */
  readonly totalBytes: number
  /** True when any output was not delivered in full. */
  readonly truncated: boolean
  /** File holding what was spilled, when the cap was crossed and a write succeeded. */
  readonly spillPath?: string
  /** Frames libzmq refused because one exceeded the socket's maximum message size. */
  readonly droppedFrames: number
}

/** A rich display payload, reduced to text. Binary MIME types are not delivered. */
export interface DisplayOutput {
  readonly mime: string
  readonly text: string
  readonly truncated: boolean
}

/** Output that arrived after its cell had already settled. */
export interface LateOutput {
  /** The cell whose code wrote it -- identified by the ORIGINATING msg_id. */
  readonly cellId: string
  readonly text: string
  /**
   * Which stream the write arrived on.
   *
   * G-SEAM-78: the delivery record V5 section 10 requires names the stream, and
   * the broker is the only layer that ever saw the frame. Re-deriving it later
   * would be a guess, so it is carried from the frame. Optional because it is an
   * ADDITIVE field: a frame that omits it is not a protocol violation, it is a
   * write whose stream is not known, and `undefined` says exactly that.
   */
  readonly stream?: LateStreamName
}

/** The stream a late write arrived on. `unknown` is a real value, not a placeholder. */
export type LateStreamName = 'stdout' | 'stderr' | 'unknown'

/**
 * The origin recorded for a write whose cell could NOT be established.
 *
 * IPY-13 requires that such a write be reported as undecidable rather than
 * attributed to a cell, and "undecidable" has to be a value a caller can test
 * for. This is that value: a write from a thread started in a cell carries that
 * cell's id; a write with no discoverable cell origin carries THIS, which
 * matches no cell's `msg_id` and is therefore never absorbed into a cell result.
 *
 * It is deliberately a named constant rather than `''` or a missing field: an
 * empty string is indistinguishable from a frame that lost its parent, and the
 * two are different facts.
 */
export const DSH_BACKGROUND_ORIGIN = 'dsh:background'

/** The broker's report for one executed cell. */
export interface CellResult {
  readonly outcome: CellOutcome
  readonly stdout: CapturedOutput
  readonly stderr: CapturedOutput
  readonly display: readonly DisplayOutput[]
  readonly error?: {
    readonly ename: string
    readonly evalue: string
    readonly traceback: readonly string[]
  }
  /** Kernel epoch this cell ran in. A reset changes it. */
  readonly epoch: number
  /** Shell frames whose parent was not this cell; they must never complete it. */
  readonly foreignFrames: number
  /** Set when this cell could not run against the previous epoch's state. */
  readonly generation?: {
    readonly previousEpoch: number
    readonly epoch: number
    readonly reason: string
    readonly volatileStateLost: true
  }
  /** Set when the outcome is `unknown`: what the host must assume, not what it hopes. */
  readonly unresolved?: string
}

export interface KernelStatus {
  readonly alive: boolean
  readonly epoch: number
  /** OS pid of the kernel process, for host-side liveness checks. */
  readonly pid?: number
  /** The transport actually achieved, read back from the connection file. */
  readonly transport: string
  readonly curveKeysPresent: boolean
  readonly plaintextWarningSeen: boolean
  /**
   * Frames the transport bound REFUSED, tallied at the broker.
   *
   * WHY IT IS DECLARED HERE AND NOT ONLY EMITTED BY `broker.py`. The broker began
   * publishing this field when the pump's swallowed loss was fixed, but nothing on
   * the host side named it, so the only way to read it was to cast the status
   * object to `Record<string, unknown>` -- measured: `'transportDroppedFrames' in
   * status` was true while `KernelStatus` had no such member. A count a reader has
   * to cast to find is a count most readers will never find, and the oracle's
   * clause 2 requires the loss to be reported "with a count" rather than merely
   * counted somewhere.
   *
   * WHAT IT COUNTS, EXACTLY. Refused frames that had NO cell in flight to carry
   * the loss: a frame refused while a cell is running is charged to that cell's
   * `CellResult.stdout.droppedFrames`, because there a cell result exists to carry
   * it. This field is the other half -- the loss that would otherwise survive only
   * as a log line. The two are complementary and must not be added as if they were
   * one population: a reader summing them would count each refusal twice.
   *
   * Optional because a broker that has not answered `status` yet reports nothing;
   * `0` is a real measurement ("no frame has been refused"), and absent is not.
   */
  readonly transportDroppedFrames?: number
  /**
   * The kernel's identity, under the names V5 §11.2 requires.
   *
   * WHY `ipythonVersion` IS GONE RATHER THAN KEPT BESIDE THESE. It was a field
   * whose NAME asserted one thing and whose VALUE was another: `broker.py`
   * populated it from `kernel_info_reply.language_info.version`, which is the
   * Python LANGUAGE version. Measured on this host, an IPython 9.16.1 install
   * reported `ipythonVersion: "3.14.3"`. Keeping it as a deprecated alias would
   * preserve a field that is wrong by construction, and the whole point of
   * naming the identity fields is that a reader must not have to know the
   * history to read them correctly. The Python version it used to carry is
   * `languageVersion`.
   *
   * Each is optional because the values come from a live `kernel_info_reply`: a
   * kernel that is not alive, or whose reply did not carry a field, reports
   * `undefined` rather than a fabricated version.
   */
  readonly kernelImplementation?: string
  /** The IPYTHON version (`kernel_info_reply.implementation_version`). */
  readonly kernelImplementationVersion?: string
  /** The language name, e.g. `python` (`language_info.name`). */
  readonly languageName?: string
  /** The PYTHON version (`language_info.version`). This is what `ipythonVersion` used to carry. */
  readonly languageVersion?: string
  /** The Jupyter messaging protocol version (`protocol_version`). */
  readonly protocolVersion?: string
  /** The directory the kernel was started in. Read back, not restated from the request. */
  readonly kernelCwd?: string
  /**
   * Whether `KernelManager.start_kernel` accepted `cwd=`.
   *
   * False means the kernel's working directory is NOT the one the host asked for,
   * so every relative path in a cell resolves elsewhere. That is a silent
   * correctness failure, which is why it is reported rather than assumed.
   */
  readonly kernelCwdEnforced?: boolean
  /**
   * Whether the kernel-side IPY-13 attribution bootstrap loaded.
   *
   * False means output written by a thread started in a cell is being stamped
   * with whichever cell runs next, i.e. the defect is live. It is read back from
   * a marker the bootstrap writes as its LAST action rather than assumed from
   * the argv the broker passed: an `exec_files` that silently failed leaves no
   * other symptom, and a silent return of the defect is exactly what this field
   * exists to make visible.
   */
  readonly attributionBootstrapLoaded?: boolean
  /**
   * Whether this Session's bridge ledger is DURABLE (storage-domain) rather than
   * in-memory.
   *
   * V5 §11.1 requires the status/doctor surface to show this as
   * `bridgeLedgerDurable: true` for a final-daily deployment. It is reported here
   * rather than on the broker's own status because the LEDGER IS NOT THE BROKER'S
   * TO KNOW ABOUT: the broker owns the kernel process, while the ledger is a
   * storage-domain record the host holds. `KernelService.status` therefore merges
   * its own answer into the broker's report.
   *
   * WHY IT IS WORTH A FIELD AT ALL, given that a kernel now REFUSES to publish
   * without a durable ledger when one was requested. A reader must be able to
   * tell a deployment that genuinely records dispositions from one that opted
   * into memory with `durableLedger: false`; `false` here is that deployment
   * saying so out loud, which is the difference between an honest development
   * host and the silent degradation this field exists to end.
   */
  readonly bridgeLedgerDurable?: boolean
}

export interface BrokerError {
  readonly code: string
  readonly message: string
}

export type BrokerReply =
  | { readonly id: string; readonly type: 'reply'; readonly ok: true; readonly result: unknown }
  | { readonly id: string; readonly type: 'reply'; readonly ok: false; readonly error: BrokerError }

/**
 * Unsolicited broker messages. Late output is the reason this exists: it is
 * produced by a cell that has already completed, so it has no request to ride.
 */
export type BrokerEvent =
  | { readonly type: 'event'; readonly event: 'kernel_exited'; readonly epoch: number; readonly detail: string }
  | {
    readonly type: 'event'
    readonly event: 'late_output'
    readonly epoch: number
    readonly cellId: string
    readonly text: string
    /**
     * Which stream the write arrived on.
     *
     * G-SEAM-78: V5 section 10's delivery record names the stream, and this frame
     * is the only place the fact exists -- the broker saw the `stream` frame, and
     * no later layer can recover it. `unknown` is a real value: a frame that named
     * no stream, or named one this protocol does not carry.
     */
    readonly stream: LateStreamName
  }
  | { readonly type: 'event'; readonly event: 'diagnostic'; readonly epoch: number; readonly detail: string }
  | {
    readonly type: 'event'
    readonly event: 'transport_refused'
    /**
     * The kernel generation the refusal happened in.
     *
     * EVERY broker event carries one, and the host's decoder REQUIRES it: an
     * event without an integer epoch is treated as a malformed frame, so a
     * refusal that omitted it would be reported as a protocol violation instead
     * of as a bounded refusal.
     */
    readonly epoch: number
    /** The refusal's name. `FRAME_TOO_LARGE` is the bound in this module. */
    readonly code: string
    readonly detail: string
    /** The bound that was violated, so the reader is not left to guess it. */
    readonly limitBytes: number
    /** What the frame claimed, when the peer declared it. Absent otherwise. */
    readonly declaredBytes?: number
    /**
     * How many frames this refusal accounts for.
     *
     * Always present on a refusal the broker emits today, and always `1`: a
     * refusal IS one frame, because both the encoder and the decoder refuse a
     * frame as a unit. It is a FIELD rather than a sentence because the oracle's
     * clause is that the loss be reported "with a count", and a reader must not
     * have to parse the number back out of prose that may be reworded.
     *
     * Optional because it is decoded from a frame: a broker that predates the
     * field still produces a valid refusal, and refusing to decode it would turn
     * a bounded refusal into a protocol violation.
     */
    readonly refusedFrames?: number
  }

export type BrokerMessage = BrokerReply | BrokerEvent

/** Narrow a decoded value to a broker message, or explain why it is not one. */
export function asBrokerMessage(value: unknown): BrokerMessage {
  if (typeof value !== 'object' || value === null) {
    throw new FrameError('broker message must be an object')
  }
  const record = value as Record<string, unknown>
  const type = record['type']
  if (type === 'reply') {
    const id = record['id']
    if (typeof id !== 'string' || id === '') throw new FrameError('reply is missing a non-empty id')
    if (record['ok'] === true) {
      return { id, type: 'reply', ok: true, result: record['result'] }
    }
    if (record['ok'] === false) {
      const raw = record['error']
      const error = typeof raw === 'object' && raw !== null ? raw as Record<string, unknown> : {}
      return {
        id,
        type: 'reply',
        ok: false,
        error: {
          code: typeof error['code'] === 'string' ? error['code'] : 'BROKER_ERROR',
          message: typeof error['message'] === 'string' ? error['message'] : 'broker reported a failure',
        },
      }
    }
    throw new FrameError('reply must carry a boolean ok')
  }
  if (type === 'event') {
    const event = record['event']
    if (typeof event !== 'string') throw new FrameError('event is missing its name')
    const epoch = record['epoch']
    if (typeof epoch !== 'number' || !Number.isInteger(epoch)) {
      throw new FrameError('event is missing an integer epoch')
    }
    if (event === 'late_output') {
      return {
        type: 'event',
        event,
        epoch,
        cellId: typeof record['cellId'] === 'string' ? record['cellId'] : '',
        text: typeof record['text'] === 'string' ? record['text'] : '',
        // ADDITIVE, and validated rather than passed through: an unrecognised
        // stream name becomes `unknown` instead of reaching the delivery record
        // as a string no reader can act on.
        stream: record['stream'] === 'stdout' || record['stream'] === 'stderr'
          ? record['stream']
          : 'unknown',
      }
    }
    if (event === 'kernel_exited' || event === 'diagnostic') {
      return {
        type: 'event',
        event,
        epoch,
        detail: typeof record['detail'] === 'string' ? record['detail'] : '',
      }
    }
    if (event === 'transport_refused') {
      // The refusal carries the bound as a NUMBER, so a reader never has to parse
      // it back out of `detail`. A frame that omits it is malformed rather than
      // defaulted: a refusal whose limit is unknown cannot be acted on.
      const limitBytes = record['limitBytes']
      if (typeof limitBytes !== 'number' || !Number.isFinite(limitBytes)) {
        throw new FrameError('transport_refused is missing a numeric limitBytes')
      }
      const declaredBytes = record['declaredBytes']
      // THE COUNT IS VALIDATED, NOT PASSED THROUGH. A non-numeric or negative
      // `refusedFrames` becomes absent rather than reaching a reader as a value no
      // arithmetic can use -- the same discipline `declaredBytes` gets. Unlike
      // `limitBytes` it is NOT required: a refusal whose count is missing is still
      // a bounded refusal, and rejecting it would report a protocol violation
      // where the peer reported a loss.
      const refusedFrames = record['refusedFrames']
      return {
        type: 'event',
        event,
        epoch,
        code: typeof record['code'] === 'string' ? record['code'] : 'FRAME_TOO_LARGE',
        detail: typeof record['detail'] === 'string' ? record['detail'] : '',
        limitBytes,
        ...typeof declaredBytes === 'number' && Number.isFinite(declaredBytes)
          ? { declaredBytes }
          : {},
        ...typeof refusedFrames === 'number' && Number.isFinite(refusedFrames) && refusedFrames >= 0
          ? { refusedFrames }
          : {},
      }
    }
    throw new FrameError(`unknown event name ${JSON.stringify(event)}`)
  }
  throw new FrameError(`unknown broker message type ${JSON.stringify(type)}`)
}
