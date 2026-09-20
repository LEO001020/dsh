/**
 * KernelHost: the host-side handle on one IPython kernel.
 *
 * WHAT THIS OWNS, AND WHAT IT DOES NOT. It owns the broker process, the control
 * channel, request/response correlation, the epoch, and the classification of
 * output that belongs to no live cell. It does NOT own the kernel's protocol
 * details -- `jupyter_client` does, inside the broker -- and it does not own
 * kernel lifecycle policy for the model: the model gets a `code` parameter and
 * nothing else, so there is no path by which a cell can start, restart, or
 * shut down its own kernel.
 *
 * THE SUBPROCESS SEAM. The broker is spawned through DSH's own subprocess
 * service rather than `node:child_process`, so the process is owned by a fiber
 * and terminated with the managed range the provider tracks. The seam's
 * signature (`packages/subprocess/subprocess/src/index.ts:153`):
 *
 *   abstract spawn(spec: SubprocessSpawnSpec): SubprocessHandle
 *
 * and `SubprocessHandle` (`types.ts:169-199`) provides `stdout`, `control`,
 * `done`, `terminate()`, and `waitForExit()`. The `control` field is documented
 * as "Separate caller-owned byte channel when requested; native startup failure
 * may leave it absent", which is why every use below treats a missing control
 * channel as a hard start failure instead of falling back to stdout.
 *
 * WHY THREE CHANNELS. Requests ride the inherited control descriptor
 * (`SUBPROCESS_CONTROL_FD` = 7, `subprocess/src/control.ts:8`), replies and
 * events ride the broker's stdout, diagnostics ride its stderr. Keeping the
 * request direction physically separate from the reply direction means a large
 * reply can never block a pending request behind it in the same pipe buffer --
 * the classic duplex deadlock -- and it means the broker's protocol bytes are
 * never mixed with the kernel's own output, which travels on IOPub inside the
 * broker and reaches the host only as structured, bounded cell results.
 */
import type { SubprocessHandle, SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import { SUBPROCESS_CONTROL_ENV } from '@deepseek-ai/dsh-subprocess/control'
import { randomUUID } from 'node:crypto'
import {
  asBrokerMessage,
  encodeFrame,
  FrameDecoder,
  FrameError,
  MAX_FRAME_BYTES,
  type BrokerRequest,
  type CellResult,
  type KernelStatus,
  type LateOutput,
} from './protocol.ts'
import { jupyterRuntimeDir } from './runtime-root.ts'

/** One kernel's identity: session, execution world, environment, and generation. */
export interface KernelIdentity {
  readonly sessionId: string
  readonly executionWorld: string
  readonly environmentDigest: string
}

export interface KernelHostOptions {
  /** DSH's subprocess service. The broker is spawned through it, never through `node:child_process`. */
  readonly subprocess: SubprocessRuntime
  readonly identity: KernelIdentity
  /** Absolute path to `broker.py`. */
  readonly brokerScript: string
  /** Python interpreter that has jupyter_client + ipykernel. */
  readonly pythonExecutable: string
  /** Working directory for the broker and kernel. Kernel spill/log files land here. */
  readonly workingDirectory: string
  /**
   * The working directory the KERNEL PROCESS is given, i.e. what `os.getcwd()`
   * returns inside a cell. Defaults to {@link workingDirectory} when absent.
   *
   * WHY THIS IS SEPARATE FROM `workingDirectory`. They answer two different
   * questions and conflating them caused a real defect. `workingDirectory` is
   * where the broker runs and where spill and kernel-log files are written -- a
   * host-owned scratch directory. This field is the directory a cell's RELATIVE
   * PATHS resolve against, which must be the Session's project root, because a
   * kernel rooted in a scratch directory makes every relative path in
   * model-written Python silently wrong: `open("out.csv", "w")` succeeds and
   * writes somewhere the model will never look. That is a silent correctness bug,
   * not a crash, so it is separated explicitly rather than left to a default.
   */
  readonly kernelWorkingDirectory?: string
  /** Per-cell output cap in bytes. Passed to the broker, which enforces it at the source. */
  readonly outputCapBytes?: number
  /** Default per-cell wall clock budget. */
  readonly cellTimeoutMs?: number
  /** How long an interrupt may take to settle before the outcome is `unknown`. */
  readonly interruptGraceMs?: number
  /** Called for output that arrived after its cell completed. Never merged into a cell result. */
  readonly onLateOutput?: (output: LateOutput & { epoch: number }) => void
  /** Called when the kernel process exits without a request asking it to. */
  readonly onKernelExited?: (detail: string, epoch: number) => void
}

/** The default cap. 256 KiB is far more than a model should read, and far less than a runaway cell prints. */
export const DEFAULT_OUTPUT_CAP_BYTES = 256 * 1024

/** Default per-cell budget. A cell that needs longer should be split, not waited on. */
export const DEFAULT_CELL_TIMEOUT_MS = 120_000

/**
 * Default interrupt grace.
 *
 * Measured: a CPU loop settles ~1.8 s after interrupt, while an await-suspended
 * cell did NOT settle in 30 s across two interrupts. So this is a real boundary
 * between `interrupted` and `unknown`, not a retry budget -- a longer value would
 * only make the model wait longer for the same reset.
 */
export const DEFAULT_INTERRUPT_GRACE_MS = 5_000

/** A kernel operation failed at the transport or broker level, not inside the cell. */
export class KernelTransportError extends Error {
  /**
   * The broker's machine-readable code, when the failure came from a reply.
   *
   * WHY A FIELD AND NOT ONLY THE MESSAGE. `FRAME_TOO_LARGE` is a bounded,
   * expected refusal that a caller can act on; `BROKER_FAILURE` is not. A caller
   * that had to match on prose to tell them apart would break on any rewording,
   * so the code is carried structurally. `undefined` means the failure did not
   * originate in a broker reply (a local refusal, a timeout, a dead process).
   */
  readonly code?: string

  constructor(message: string, code?: string) {
    super(message)
    this.name = 'KernelTransportError'
    if (code !== undefined) this.code = code
  }
}

/**
 * The cell could not be given a definitive outcome.
 *
 * This is a resting state, not an error to retry blindly: the kernel has been
 * reset and the previous namespace is gone. It is thrown rather than returned so
 * a caller cannot mistake it for a result by ignoring a field -- but the
 * structured `result` rides the error, because the output that DID arrive before
 * the cell became unobservable is still evidence.
 */
export class KernelOutcomeUnknownError extends Error {
  readonly result: CellResult

  constructor(message: string, result: CellResult) {
    super(message)
    this.name = 'KernelOutcomeUnknownError'
    this.result = result
  }
}

/** No cell is running, or one already is. One active cell per kernel, always. */
export class KernelBusyError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'KernelBusyError'
  }
}

interface Pending {
  readonly resolve: (value: unknown) => void
  readonly reject: (error: Error) => void
  readonly timer: NodeJS.Timeout
}

export class KernelHost {
  private handle: SubprocessHandle | undefined
  private decoder: FrameDecoder | undefined
  private readonly pending = new Map<string, Pending>()
  private epoch = 0
  private cellActive = false
  private stopped = false
  private lastStatus: KernelStatus | undefined
  private startPromise: Promise<KernelStatus> | undefined
  private readonly late: Array<LateOutput & { epoch: number }> = []
  private exitedDetail: string | undefined
  private readonly controlErrors: string[] = []
  private readonly refusals: Array<{
    code: string
    detail: string
    limitBytes: number
    declaredBytes?: number
  }> = []
  private readonly options: KernelHostOptions

  constructor(options: KernelHostOptions) {
    this.options = options
  }

  /** Current generation. Changes on every reset, restart, or death. */
  get currentEpoch(): number {
    return this.epoch
  }

  /** True while a cell is running; a second `execute` is refused rather than queued. */
  get busy(): boolean {
    return this.cellActive
  }

  /** The transport the broker actually achieved, once started. */
  get transport(): string | undefined {
    return this.lastStatus?.transport
  }

  /** Output that arrived after its cell completed, in arrival order. */
  drainLateOutput(): Array<LateOutput & { epoch: number }> {
    return this.late.splice(0, this.late.length)
  }

  /**
   * Start the broker and the kernel.
   *
   * Concurrent callers share one start: two `start()` calls must not produce two
   * kernels under one identity, which would silently double the memory budget
   * and split the namespace.
   */
  async start(): Promise<KernelStatus> {
    if (this.startPromise !== undefined) return this.startPromise
    this.startPromise = this.startInternal()
    try {
      return await this.startPromise
    } catch (error) {
      this.startPromise = undefined
      throw error
    }
  }

  private async startInternal(): Promise<KernelStatus> {
    const handle = this.options.subprocess.spawn({
      argv: [this.options.pythonExecutable, this.options.brokerScript],
      cwd: this.options.workingDirectory,
      stdio: {
        // stdin is 'ignore': the broker has no business reading a terminal, and
        // leaving it open would let a cell's stdin request reach the host.
        stdin: 'ignore',
        // stdout carries the protocol; stderr carries diagnostics. Both are
        // 'pipe' because the host owns the decoding of each.
        stdout: 'pipe',
        stderr: 'pipe',
        // The request direction. Documented as possibly absent on native startup
        // failure, so its absence is a hard error -- falling back to stdout would
        // put requests and replies in one buffer and reintroduce the deadlock the
        // split exists to prevent.
        control: 'pipe',
      },
      graceMs: 10_000,
      env: {
        // The kernel writes its spill and log files here; the host reads the spill
        // path from the cell result. Nothing else of the host's environment is
        // forwarded by this package.
        DSH_IPYTHON_SPILL_DIR: this.options.workingDirectory,
        DSH_IPYTHON_KERNEL_DIR: this.options.workingDirectory,
        // The directory the KERNEL's relative paths resolve against. Distinct from
        // the broker's own cwd above: the broker runs in the host's scratch
        // directory, while a cell must see the Session's project root. Sent as its
        // own variable because the broker starts the kernel as a grandchild and
        // `KernelManager` does not inherit the broker's cwd for it.
        DSH_IPYTHON_KERNEL_CWD: this.options.kernelWorkingDirectory ?? this.options.workingDirectory,
        // WHERE THE JUPYTER CONNECTION FILE GOES (V5 §11.4, P12).
        //
        // `jupyter_client` writes the connection file through
        // `jupyter_core.paths.jupyter_runtime_dir()`, which is NOT derived from
        // the broker's cwd. MEASURED with this variable unset:
        // `%APPDATA%\jupyter\runtime` -- outside the package AND outside
        // `$DSH_HOME`, shared with every other Jupyter on the account. That file
        // carries the HMAC key authorising execution on the kernel's sockets, so
        // leaving it unmanaged means the scratch tree can look perfectly clean
        // while the capability-bearing file sits somewhere no part of this
        // deployment controls.
        //
        // Pinned to the scratch directory's own `jupyter/` subdirectory rather
        // than a shared runtime dir, so two kernels cannot produce one
        // unattributable connection file. The directory is created by
        // `KernelService.entryFor` before the host starts.
        JUPYTER_RUNTIME_DIR: jupyterRuntimeDir(this.options.workingDirectory),
        PYTHONUNBUFFERED: '1',
        PYTHONIOENCODING: 'utf-8',
      },
    })

    const control = handle.control
    if (control === undefined) {
      handle.terminate()
      throw new KernelTransportError(
        'the subprocess provider did not supply the inherited control channel; the broker cannot be driven',
      )
    }
    if (handle.stdout === undefined) {
      handle.terminate()
      throw new KernelTransportError('the subprocess provider did not supply the broker stdout channel')
    }
    this.handle = handle
    // The broker deletes this marker before it runs any of its own code, so a
    // child that still sees it is one this package did not start.
    void SUBPROCESS_CONTROL_ENV

    this.decoder = new FrameDecoder(
      value => { this.onMessage(value) },
      error => { this.failAll(error) },
    )
    handle.stdout.on('data', (chunk: Buffer) => { this.decoder?.push(chunk) })
    if (handle.stderr !== undefined) {
      handle.stderr.on('data', (chunk: Buffer) => {
        // Diagnostics are kept out of the protocol path entirely. A broker that
        // wrote them to stdout would corrupt framing, so they are read only to
        // keep the pipe drained and to have something to report on a crash.
        this.diagnostics += chunk.toString()
        if (this.diagnostics.length > 64 * 1024) {
          this.diagnostics = this.diagnostics.slice(-64 * 1024)
        }
      })
    }
    void handle.done.then(
      outcome => { this.onProcessExit(outcome.exitCode, outcome.signal) },
      error => { this.failAll(new KernelTransportError(`broker process failed: ${String(error)}`)) },
    )

    // THE CONTROL CHANNEL NEEDS AN 'error' LISTENER, AND THIS IS NOT DEFENSIVE.
    // Node's `EventEmitter` THROWS on an unhandled 'error' event. Writing to a
    // control pipe whose peer has exited raises `Error: write EOF` on the socket,
    // and with no listener that exception is uncaught -- it takes down the whole
    // host process, which in this product is the model's own process. Measured:
    // an over-limit frame makes the broker exit 2, and the next write then raised
    // exactly that uncaught error. Recording it here converts a process-killing
    // event into a fact the caller is told.
    control.on('error', (error: Error) => {
      this.controlErrors.push(String(error))
      this.failAll(new KernelTransportError(`broker control channel failed: ${String(error)}`))
    })

    const status = await this.request<KernelStatus>('start')
    this.epoch = status.epoch
    this.lastStatus = status
    return status
  }

  private diagnostics = ''

  /** Broker diagnostics, for a crash report. Never model-facing content. */
  get diagnosticsText(): string {
    return this.diagnostics
  }

  private onProcessExit(exitCode: number | null, signal: NodeJS.Signals | null): void {
    if (this.stopped) return
    const detail = `broker exited with code ${exitCode} signal ${signal}`
    this.exitedDetail = detail
    // The kernel generation is now unobservable. The epoch does NOT advance
    // here: it advances when a caller is next told about it, so the number a
    // caller sees is always one it was explicitly told about.
    this.failAll(new KernelTransportError(detail))
    this.options.onKernelExited?.(detail, this.epoch)
  }

  private failAll(error: Error): void {
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.pending.clear()
  }

  private onMessage(value: unknown): void {
    let message
    try {
      message = asBrokerMessage(value)
    } catch (error) {
      // A malformed frame is a protocol violation. The decoder stops, which is
      // the only safe response: continuing would mean guessing at alignment.
      this.failAll(error instanceof FrameError ? error : new KernelTransportError(String(error)))
      return
    }
    if (message.type === 'event') {
      this.epoch = Math.max(this.epoch, message.epoch)
      if (message.event === 'late_output') {
        const entry = { cellId: message.cellId, text: message.text, epoch: message.epoch }
        this.late.push(entry)
        this.options.onLateOutput?.(entry)
      } else if (message.event === 'kernel_exited') {
        this.options.onKernelExited?.(message.detail, message.epoch)
      } else if (message.event === 'transport_refused') {
        // A BOUNDED REFUSAL, RECORDED AND NOT TREATED AS A CRASH. The broker emits
        // this before abandoning the control stream, because a frame whose
        // declared length exceeds the bound leaves no trustworthy next boundary.
        // It is stored rather than rejected into the pending entries: the refusal
        // belongs to the STREAM, not to one request, and attributing it to
        // whichever request happened to be in flight would misreport a transport
        // fact as a cell failure.
        this.refusals.push({
          code: message.code,
          detail: message.detail,
          limitBytes: message.limitBytes,
          ...message.declaredBytes === undefined ? {} : { declaredBytes: message.declaredBytes },
        })
      }
      return
    }
    const pending = this.pending.get(message.id)
    if (pending === undefined) {
      // A reply to a request this host never sent, or a duplicate. Dropping it
      // is required: accepting it would let one cell's outcome settle another.
      return
    }
    this.pending.delete(message.id)
    clearTimeout(pending.timer)
    if (message.ok) pending.resolve(message.result)
    else {
      // The broker's code is carried structurally, not only inside the message.
      // `FRAME_TOO_LARGE` is a bounded refusal a caller can act on; a caller that
      // had to match prose to find it would break on any rewording.
      pending.reject(new KernelTransportError(
        `${message.error.code}: ${message.error.message}`,
        message.error.code,
      ))
    }
  }

  private async request<T>(op: BrokerRequest['op'], fields: Partial<BrokerRequest> = {}, timeoutMs = 180_000): Promise<T> {
    const handle = this.handle
    const control = handle?.control
    if (handle === undefined || control === undefined) {
      throw new KernelTransportError('the broker is not running')
    }

    // THE BROKER IS ALREADY GONE. `onProcessExit` rejects the entries that exist
    // WHEN IT FIRES, so a request issued afterwards would register a fresh entry
    // that nothing can ever reject; its only escape is its own timer. Measured:
    // the exit is registered 212 ms after the over-limit frame, and a cell sent
    // after that took 62 015 ms to fail with `broker did not answer execute
    // within 62000 ms` -- the full `execute` budget, spent learning something the
    // host already knew. In this product the host is the model's own process, so
    // that is a wedged turn. Refusing immediately costs nothing and loses nothing:
    // the fact is already established and already carries its own detail.
    if (this.exitedDetail !== undefined) {
      throw new KernelTransportError(`the broker is not running: ${this.exitedDetail}`)
    }

    // ENCODE BEFORE REGISTERING, and this ordering is the fix for a real leak.
    // `encodeFrame` refuses a payload over `MAX_FRAME_BYTES`. When it was
    // evaluated inside the `control.write(...)` call below, the refusal threw out
    // of `request` with the pending entry already registered and its timer still
    // armed -- measured: the refusal escaped as `FrameError` correctly, and then
    // `shutdown`'s `failAll` rejected the orphaned entry into nothing, producing
    // an unhandled rejection. Encoding first means a refused frame never has an
    // entry to leak.
    const id = randomUUID()
    const frame = encodeFrame({ id, op, ...fields } as BrokerRequest)

    const promise = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new KernelTransportError(`broker did not answer ${op} within ${timeoutMs} ms`))
      }, timeoutMs)
      // Node's default timer must not hold the process open: a pending kernel
      // call is not a reason for the host to refuse to exit.
      timer.unref?.()
      this.pending.set(id, { resolve, reject, timer })
    })
    try {
      control.write(frame)
    } catch (error) {
      // A SYNCHRONOUS WRITE FAILURE MUST NOT LEAK ITS ENTRY EITHER. The async
      // case is covered by the channel's 'error' listener; this is the throwing
      // case, and leaving the entry behind would arm a timer for a request that
      // was never sent.
      const entry = this.pending.get(id)
      if (entry !== undefined) {
        clearTimeout(entry.timer)
        this.pending.delete(id)
      }
      throw error instanceof KernelTransportError
        ? error
        : new KernelTransportError(`the broker control channel rejected a ${op} request: ${String(error)}`)
    }
    return await promise as T
  }

  /**
   * Run one cell.
   *
   * The kernel identity is checked BEFORE the cell is sent: an identity mismatch
   * (different session, execution world, or environment) means this kernel's
   * namespace was not built under the authority the caller now holds, so the
   * cell must not run against it.
   *
   * The request timeout is deliberately longer than the broker's own cell
   * budget. The broker is the layer that decides a cell has overrun -- it can
   * still read IOPub while the cell runs -- so the host must wait for that
   * decision rather than racing it and reporting a transport failure for a cell
   * the broker was about to classify.
   */
  async execute(code: string, options: { identity?: KernelIdentity, signal?: AbortSignal } = {}): Promise<CellResult> {
    if (this.stopped) throw new KernelTransportError('the kernel host is shut down')
    if (options.identity !== undefined) this.assertIdentity(options.identity)
    if (this.cellActive) {
      throw new KernelBusyError('a cell is already running; one active cell per kernel')
    }
    await this.start()
    if (options.signal?.aborted) {
      throw new KernelTransportError('the cell was cancelled before it was sent')
    }

    this.cellActive = true
    try {
      const cellTimeout = this.options.cellTimeoutMs ?? DEFAULT_CELL_TIMEOUT_MS
      const grace = this.options.interruptGraceMs ?? DEFAULT_INTERRUPT_GRACE_MS
      const result = await this.request<CellResult>(
        'execute',
        {
          code,
          ...this.options.outputCapBytes === undefined ? {} : { outputCapBytes: this.options.outputCapBytes },
          timeoutMs: cellTimeout,
          interruptGraceMs: grace,
        },
        // The broker resets a wedged kernel before replying, and a reset starts a
        // whole new kernel; that has to fit inside this budget or the host would
        // abandon a broker that is doing exactly the right thing.
        cellTimeout + grace + 60_000,
      )
      this.epoch = Math.max(this.epoch, result.epoch)
      if (result.outcome === 'unknown') {
        throw new KernelOutcomeUnknownError(
          result.unresolved ?? 'the cell outcome could not be established; the kernel was reset',
          result,
        )
      }
      return result
    } finally {
      this.cellActive = false
    }
  }

  private assertIdentity(identity: KernelIdentity): void {
    const expected = this.options.identity
    if (identity.sessionId !== expected.sessionId) {
      throw new KernelTransportError(
        `kernel identity mismatch: session ${identity.sessionId} cannot use a kernel bound to ${expected.sessionId}`,
      )
    }
    if (identity.executionWorld !== expected.executionWorld) {
      throw new KernelTransportError('kernel identity mismatch: execution world changed; the kernel must be restarted')
    }
    if (identity.environmentDigest !== expected.environmentDigest) {
      throw new KernelTransportError(
        'kernel identity mismatch: the environment changed; volatile state was built against a different one',
      )
    }
  }

  /**
   * Interrupt the running cell.
   *
   * Returns the kernel's own answer about whether it is alive. It does NOT
   * return a cell outcome: the outcome belongs to the `execute` call that is
   * still waiting, and it may legitimately become `unknown`.
   */
  async interrupt(): Promise<{ interrupted: boolean, alive: boolean, epoch: number }> {
    if (this.stopped) throw new KernelTransportError('the kernel host is shut down')
    const result = await this.request<{ interrupted: boolean, alive: boolean, epoch: number }>('interrupt')
    return result
  }

  /** Restart the kernel. Always advances the epoch; the namespace is gone. */
  async restart(): Promise<KernelStatus> {
    if (this.stopped) throw new KernelTransportError('the kernel host is shut down')
    const status = await this.request<KernelStatus>('restart')
    this.epoch = status.epoch
    this.lastStatus = status
    return status
  }

  /** Current status, re-read from the broker rather than cached. */
  async status(): Promise<KernelStatus> {
    const status = await this.request<KernelStatus>('status')
    this.lastStatus = status
    return status
  }

  /**
   * Shut down the kernel and the broker.
   *
   * Idempotent. The epoch is advanced so that any later attempt to use this host
   * reports a generation the caller was never told about, rather than appearing
   * to resume.
   */
  async shutdown(): Promise<void> {
    if (this.stopped) return
    this.stopped = true
    const handle = this.handle
    try {
      if (handle !== undefined) {
        await this.request('shutdown', {}, 20_000).catch(() => undefined)
      }
    } finally {
      this.epoch += 1
      this.handle = undefined
      this.decoder = undefined
      if (handle !== undefined) {
        handle.terminate()
        // Wait for the MANAGED RANGE, not just the direct child: a kernel the
        // broker started is a descendant, and reporting quiescence while it
        // still runs would leave an orphan python.exe behind.
        await handle.waitForExit().catch(() => false)
        await handle.done.catch(() => undefined)
      }
      this.failAll(new KernelTransportError('the kernel host was shut down'))
    }
  }

  /** The broker's stderr, for a crash report. */
  get brokerDiagnostics(): string {
    return this.diagnostics
  }

  /**
   * Control-channel errors observed so far, newest last.
   *
   * A control channel whose peer has exited raises `write EOF` on every write.
   * Those are recorded rather than thrown as uncaught exceptions, so a reader can
   * tell "the channel failed" from "the broker never answered".
   */
  get controlChannelErrors(): readonly string[] {
    return this.controlErrors
  }

  /**
   * Transport refusals the broker reported, newest last.
   *
   * The one this module can produce today is `FRAME_TOO_LARGE`: a frame that
   * violated {@link MAX_FRAME_BYTES}. It is a bounded refusal with a name, which
   * is what the v2 oracle decision (D2) requires in place of a bare count.
   */
  get transportRefusals(): readonly {
    code: string
    detail: string
    limitBytes: number
    declaredBytes?: number
  }[] {
    return this.refusals
  }

  /** The exit detail, when the broker died on its own. */
  get unexpectedExit(): string | undefined {
    return this.exitedDetail
  }
}

/** Bound re-export so callers do not import protocol.ts directly for the limit. */
export { MAX_FRAME_BYTES }
