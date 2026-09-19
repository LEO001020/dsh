/**
 * Kernel lifecycle, backpressure, permissions and recovery semantics.
 *
 * WHY THIS FILE EXISTS. A persistent IPython kernel is not a function call. It is
 * a long-lived process with a namespace, an OS resource footprint, a protocol
 * that can stop answering, and a set of obligations that outlive the Agent that
 * started it. Every rule below exists because a specific failure was MEASURED on
 * this machine (see `qualification/results/M5-lifecycle/PROBE-FACTS.md` and
 * `lifecycle-probe*.json`), not because it seemed prudent:
 *
 *   FACT 8  An interrupt of an `await`-suspended cell did NOT settle in 25.16 s.
 *           The interrupt was delivered in 0.001 s and the kernel stayed alive.
 *   FACT 9  A C-extension cell (`re.match(r'(a+)+$', ...)`) likewise did not
 *           settle. Two distinct non-settling classes exist.
 *   FACT 10 After the wedge the NEXT cell settled `aborted` with no output, and
 *           the one after that ran normally. So "unknown but probably fine" is
 *           not a defensible state: continuing silently corrupts a result.
 *   FACT 6  Under an output flood the interrupt was delivered in 0.002 s but the
 *           cell did not leave the running state for 7.33 s.
 *   FACT 16 A background thread left by cell A mutated what cell B saw. A cell id
 *           is an attribution key and NOT an isolation boundary.
 *   FACT 13 A parked kernel holding one 256 MiB array had RSS 357.71 MB.
 *
 * WHAT THIS FILE IS AND IS NOT. It is the SUPERVISION and ACCOUNTING layer: it
 * owns kernel identity, the per-kernel serial queue, admission, budgets, output
 * classification, epochs, quarantine and the recovery report. It is NOT the
 * kernel: the protocol lives behind {@link KernelTransport}, which the real
 * broker implements and which tests implement with a local fake. That seam is
 * deliberate -- the lifecycle rules are testable without a kernel, and the
 * kernel-facing facts they depend on are measured separately.
 *
 * TWO HONEST LIMITS, stated here because the code cannot show them:
 *
 *   1. A cell id is for attribution, cancellation and audit. It is NOT a
 *      malicious-code isolation boundary. Within one CPython process an old
 *      background thread can touch a new cell's memory, so no nonce is minted
 *      here and no isolation is claimed. What IS enforced is the Session/kernel
 *      boundary: a kernel is a separate process with its own OS identity, and
 *      cross-Session or host privilege is refused independently of cell identity.
 *
 *   2. A budget breach detected from the outside cannot undo work already done.
 *      CPU burned, bytes written and processes spawned are facts the moment they
 *      happen. The supervisor can stop the cell, refuse further calls and replace
 *      the process; it cannot roll any of it back. Some cases are therefore NOT
 *      recoverable, and the escalation ladder says so rather than implying that a
 *      restart is a fix.
 */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { inflateRawSync } from 'node:zlib'

// ---------------------------------------------------------------------------
// Kernel identity
// ---------------------------------------------------------------------------

/**
 * What identifies a kernel.
 *
 * Deliberately NOT the Agent object. A continuable child's activation can end and
 * release its AgentHandle while its Session continues; keying a kernel on the
 * Agent would then either lose the kernel or keep an object that no longer
 * authorizes anything. `sessionId + executionWorld + environmentDigest` names the
 * SLOT; `kernelEpoch` names the INCARNATION inside it.
 *
 * `environmentDigest` is part of the identity because a kernel started against a
 * different interpreter, package set or mount layout is not the same kernel even
 * for the same Session. `executionWorld` is part of it because the same Session
 * may legitimately have more than one (local vs. a first-party execution VM), and
 * a variable must never be assumed to exist in the other one.
 */
export interface KernelIdentity {
  readonly sessionId: string
  readonly executionWorld: string
  readonly environmentDigest: string
  /** 1-based. Increments on every restart, eviction or permission-domain change. */
  readonly kernelEpoch: number
}

/**
 * The slot key: identity WITHOUT the epoch.
 *
 * Restarting a kernel does not change which kernel this is; it changes which
 * incarnation of it is alive. Splitting the key this way is what lets an evicted
 * kernel's loss be reported against the same slot the next incarnation will use.
 */
export function kernelSlotKey(identity: KernelIdentity): string {
  return [identity.sessionId, identity.executionWorld, identity.environmentDigest].join('\u0000')
}

/** Whether two identities name the same slot, ignoring the epoch. */
export function sameKernelSlot(a: KernelIdentity, b: KernelIdentity): boolean {
  return kernelSlotKey(a) === kernelSlotKey(b)
}

/** Whether two identities name the same slot AND the same incarnation. */
export function sameKernelIncarnation(a: KernelIdentity, b: KernelIdentity): boolean {
  return sameKernelSlot(a, b) && a.kernelEpoch === b.kernelEpoch
}

// ---------------------------------------------------------------------------
// Output classification
// ---------------------------------------------------------------------------

/**
 * How one output frame is attributed.
 *
 * `late` and `unattributed` are separate classes because they carry different
 * evidence. FACT 1: output written by a background thread AFTER its cell settled
 * still carries the ORIGINATING cell's parent id, so it can be attributed to a
 * cell that is already closed -- that is `late`, and it is a known fact about a
 * known cell. A frame whose parent matches nothing we have ever issued is
 * `unattributed`: we do not know where it came from, and guessing would attach it
 * to whichever cell happens to be running.
 *
 * Neither class is ever merged into the next cell's output. That merge is the
 * failure the architecture document names: a background print appearing as if the
 * following cell produced it, which makes a result look like it came from code
 * that never ran.
 */
export type OutputClass = 'cell' | 'late' | 'unattributed' | 'foreign'

/** One frame as the transport observed it, before any attribution. */
export interface FrameFact {
  /** `parent_header.msg_id`, or `undefined` when the frame carries none. */
  readonly parentId: string | undefined
  readonly kind: 'stream' | 'mime' | 'error' | 'status' | 'other'
  /** Bytes of payload, counted even when the payload is dropped. */
  readonly bytes: number
  readonly text?: string
  readonly name?: string
  readonly mimeTypes?: readonly string[]
  readonly ename?: string
  readonly evalue?: string
  /** True when this is a shell-channel frame rather than IOPub. */
  readonly shell?: boolean
}

// ---------------------------------------------------------------------------
// Budgets
// ---------------------------------------------------------------------------

/**
 * Every bound, explicit and measurable.
 *
 * `maxPendingCells` is the queue bound: a full queue REFUSES rather than growing.
 * An unbounded queue does not create capacity, it converts a visible refusal into
 * an invisible latency and a memory leak.
 *
 * The resource budgets come in two kinds, and conflating them would be
 * dishonest:
 *
 *   - OBSERVABLE bounds (`outputBytes`, `mimeBytes`, `ipcFrames`, `wallMs`) the
 *     supervisor measures itself and enforces by truncation or by stopping the
 *     cell.
 *   - DECLARED bounds (`cpuMs`, `rssBytes`, `processes`, `ioBytes`) the supervisor
 *     is TOLD about by the transport or by the caller. It can refuse further work
 *     and escalate, but it cannot prevent the consumption that already happened.
 */
export interface KernelBudgets {
  /** Cells that may wait in one kernel's queue. A full queue refuses. */
  readonly maxPendingCells: number
  /** Total stdout+stderr bytes kept per cell; the rest is counted, spilled, dropped. */
  readonly outputBytes: number
  /** MIME payload bytes kept per cell, bounded separately from stdout (FACT 5). */
  readonly mimeBytes: number
  /** Protocol frames accepted for one cell before further frames are counted only. */
  readonly ipcFrames: number
  /** Native calls a single cell may make. Refused past the bound. */
  readonly nestedCalls: number
  /** Bytes of data a single cell may pull through the data plane. */
  readonly dataBytes: number
  /** Wall-clock bound on one cell. Breach stops the cell; it cannot undo it. */
  readonly wallMs: number
  /** Grace after an interrupt before the outcome becomes `unknown` (FACT 8). */
  readonly interruptGraceMs: number
  /** Declared CPU bound for one cell. Enforced by escalation, not by prevention. */
  readonly cpuMs: number
  /** Declared RSS bound for one live kernel (FACT 13: 256 MiB object -> 357 MB RSS). */
  readonly kernelRssBytes: number
  /** Host-wide RSS the PARKED kernels may hold together. */
  readonly parkedRssBytes: number
  /** Declared process count for one kernel, including the kernel itself. */
  readonly processes: number
  /** Declared IO bytes for one cell. */
  readonly ioBytes: number
  /** How many parked kernels may be evicted in one reclamation pass. */
  readonly maxEvictionsPerPass: number
}

/** The defaults. Conservative, and every one of them is reported in a result. */
export const DEFAULT_BUDGETS: KernelBudgets = Object.freeze({
  maxPendingCells: 8,
  outputBytes: 256 * 1024,
  mimeBytes: 64 * 1024,
  ipcFrames: 4096,
  nestedCalls: 512,
  dataBytes: 64 * 1024 * 1024,
  wallMs: 300_000,
  interruptGraceMs: 5_000,
  cpuMs: 120_000,
  kernelRssBytes: 1024 * 1024 * 1024,
  parkedRssBytes: 2048 * 1024 * 1024,
  processes: 32,
  ioBytes: 256 * 1024 * 1024,
  maxEvictionsPerPass: 4,
})

/** Which budget was breached, and what was observed when it was. */
export interface BudgetBreach {
  readonly budget: keyof KernelBudgets
  readonly limit: number
  readonly observed: number
  readonly cellId: string | undefined
  /** What the supervisor DID. Never a claim that the consumption was undone. */
  readonly action: 'truncated' | 'refused' | 'interrupted' | 'escalated' | 'evicted'
  /** What remains true despite the action. */
  readonly residue: string
}

// ---------------------------------------------------------------------------
// Transport seam
// ---------------------------------------------------------------------------

/** A cell the supervisor has admitted, as the transport sees it. */
export interface CellRequest {
  readonly cellId: string
  readonly source: string
  readonly signal: AbortSignal
}

/** How a cell ended, as reported by the transport. */
export interface CellSettlement {
  readonly outcome: 'settled' | 'transport-failed'
  /** `aborted` is what a kernel reports for a cell whose interrupt landed late. */
  readonly status?: 'ok' | 'error' | 'aborted'
  readonly ename?: string
  readonly evalue?: string
  readonly executionCount?: number | null
  /** Reply AND matching idle were both observed. Without both the cell is NOT settled. */
  readonly protocolComplete: boolean
  readonly detail?: string
}

/**
 * A cell the transport has accepted. `parentId` is the transport's own id for it
 * (the Jupyter `msg_id`), which is what every arriving frame is matched against.
 */
export interface CellHandle {
  readonly parentId: string
  readonly settlement: Promise<CellSettlement>
}

/** Facts about the kernel process. */
export interface KernelProcessFact {
  readonly pid: number | undefined
  /** True when the connection file carried curve keys (M11 TRANSPORT-FINDINGS). */
  readonly encrypted?: boolean
}

/**
 * What the supervisor needs from whatever is actually talking to a kernel.
 *
 * The interface is deliberately about FACTS, not policy. It reports that an
 * interrupt was dispatched, that a frame arrived with a parent id, that a reply
 * and an idle were both seen. It does NOT decide what an unsettled interrupt
 * means, whether to restart, or what to tell the model -- those are the
 * supervisor's decisions and they must be testable without a kernel.
 *
 * `execute` returning a `CellHandle` rather than a promise is load-bearing: the
 * supervisor must be able to stop waiting on a cell WITHOUT the transport
 * resolving. FACT 8 is exactly that situation -- a promise that never settles.
 * A supervisor that awaited it would hang a model turn forever.
 */
export interface KernelTransport {
  readonly kind: string
  /** The single frame sink. Registered once, before {@link start}. */
  onFrame(sink: (frame: FrameFact) => void): void
  start(): Promise<KernelProcessFact>
  execute(request: CellRequest): CellHandle
  /** Dispatch an interrupt. Resolves when it was SENT, not when the cell settles. */
  interrupt(): Promise<void>
  /** Replace the process. Must work while a cell is still pending (FACT 8). */
  restart(): Promise<KernelProcessFact>
  shutdown(): Promise<void>
  /** Resident bytes of the kernel process, or `undefined` when unmeasurable. */
  rssBytes(): Promise<number | undefined>
  /** Processes in the kernel's tree, including the kernel itself. */
  processCount(): Promise<number | undefined>
}

/** Where truncated output goes so the bound is explicit rather than lossy. */
export interface OutputSpill {
  /**
   * Persist a truncated tail and return an opaque reference.
   *
   * The reference is what makes truncation auditable: a bounded result with no
   * reference is indistinguishable from a short result, which is the failure mode
   * the architecture document forbids. Implementations must not cache in memory.
   */
  write(part: {
    readonly cellId: string
    readonly kind: string
    readonly text: string
    readonly bytes: number
  }): Promise<string>
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

/** How a cell ended, from the supervisor's point of view. */
export type CellOutcome =
  /** Reply and idle both seen; the status is the kernel's own answer. */
  | 'settled'
  /** The interrupt did not settle within the grace. Outcome is NOT established. */
  | 'unknown'
  /** The cell was never run: a budget or admission refusal. */
  | 'refused'
  /** The kernel process died or the transport failed mid-cell. */
  | 'transport-failed'

/** The bounded output of one cell, with truncation made explicit. */
export interface CellOutput {
  readonly cellId: string
  /** Bytes kept, i.e. what a model could actually be shown. */
  readonly keptBytes: number
  /** Bytes the kernel really produced. Always >= keptBytes. */
  readonly totalBytes: number
  readonly mimeBytes: number
  readonly frames: number
  readonly truncated: boolean
  /** Where the dropped tail went, when there was one. */
  readonly spillRef: string | undefined
  /** The kept prefix. Never longer than the budget. */
  readonly text: string
  readonly errors: readonly {
    readonly ename: string
    readonly evalue: string
  }[]
  /** Frame counts per attribution class. `late`/`unattributed` are never merged in. */
  readonly classes: Readonly<Record<OutputClass, number>>
}

/** The result of running one cell. */
export interface CellResult {
  readonly cellId: string
  readonly identity: KernelIdentity
  readonly outcome: CellOutcome
  readonly status: 'ok' | 'error' | 'aborted' | undefined
  readonly ename: string | undefined
  readonly output: CellOutput | undefined
  readonly breaches: readonly BudgetBreach[]
  readonly wallMs: number
  /**
   * True when the supervisor replaced the process to end this cell. When set, the
   * namespace is GONE and every variable the caller had is in `lost`.
   */
  readonly kernelRestarted: boolean
  /** The epoch AFTER this call. Differs from the request's epoch iff restarted. */
  readonly kernelEpoch: number
  /** Present when `outcome` is not `settled`, in words a reader can check. */
  readonly reason: string | undefined
  /** Why the outcome could not be established, when it could not. */
  readonly uncertainty: string | undefined
}

// ---------------------------------------------------------------------------
// Output accumulation
// ---------------------------------------------------------------------------

/**
 * The largest cut point `<= room` at which the bytes still form complete UTF-8
 * sequences.
 *
 * WHY THIS IS NOT `subarray(0, room).toString('utf8')`. Node replaces an
 * incomplete trailing sequence with U+FFFD, so a 5-byte cut of `日本語` (3 bytes
 * per character) yields `日\ufffd` -- a corrupted character in the kept prefix of
 * the output a model reads. MEASURED by this file's own test before the fix.
 *
 * The walk: step back over continuation bytes to find the lead byte of the
 * sequence the cut lands inside, then keep the sequence only if it fits entirely.
 */
function utf8SafeCut(buffer: Buffer, room: number): number {
  if (room >= buffer.length) return buffer.length
  let cursor = room
  let lead = cursor - 1
  while (lead >= 0 && ((buffer[lead] ?? 0) & 0xc0) === 0x80) lead -= 1
  if (lead < 0) return cursor
  const first = buffer[lead] ?? 0
  const length = first < 0x80 ? 1
    : (first & 0xe0) === 0xc0 ? 2
      : (first & 0xf0) === 0xe0 ? 3
        : (first & 0xf8) === 0xf0 ? 4
          : 1
  return lead + length <= cursor ? cursor : lead
}

/**
 * A breach the accumulator detected in its own budget, before the supervisor
 * attaches the kernel and cell context to it.
 */
export interface AccumulatorBreach {
  readonly budget: 'outputBytes' | 'mimeBytes' | 'ipcFrames'
  readonly limit: number
  readonly observed: number
  readonly residue: string
}

/**
 * A bounded accumulator for one cell's output.
 *
 * The rule it enforces is the one RES-02 turns on: past the budget the bytes are
 * COUNTED and DROPPED, never buffered. FACT 4 measured a 256 MiB flood leaving
 * both broker and kernel RSS flat precisely because the consumer stopped keeping
 * the bytes; an accumulator that kept them "just in case" would be the bug.
 *
 * It reports its own breaches rather than exposing counters for the supervisor to
 * compare. The budgets are the accumulator's own constructor argument, so a
 * caller re-deriving the comparison could disagree with the enforcement -- and a
 * reported breach that disagrees with the enforced bound is worse than no report.
 */
class OutputAccumulator {
  private readonly kept: string[] = []
  private keptBytes = 0
  private totalBytes = 0
  private mimeBytes = 0
  private frames = 0
  private truncated = false
  private readonly dropped: string[] = []
  private droppedBytes = 0
  private readonly errors: { ename: string; evalue: string }[] = []
  private readonly classes: Record<OutputClass, number> = { cell: 0, late: 0, unattributed: 0, foreign: 0 }
  private readonly budgets: KernelBudgets
  private readonly cellId: string

  constructor(cellId: string, budgets: KernelBudgets) {
    this.cellId = cellId
    this.budgets = budgets
  }

  /** Count one frame. Returns a breach when the frame budget is exceeded. */
  countFrame(): AccumulatorBreach | undefined {
    this.frames += 1
    if (this.frames <= this.budgets.ipcFrames) return undefined
    return {
      budget: 'ipcFrames',
      limit: this.budgets.ipcFrames,
      observed: this.frames,
      residue: 'later frames for this cell are counted but not kept',
    }
  }

  /** Attribute a frame to a class. Never merges late/unattributed into the cell. */
  classify(frameClass: OutputClass): void {
    this.classes[frameClass] += 1
  }

  /** Keep a stream frame's text up to the output budget; report any breach. */
  keepStream(text: string): AccumulatorBreach | undefined {
    const bytes = Buffer.byteLength(text, 'utf8')
    this.totalBytes += bytes
    const room = this.budgets.outputBytes - this.keptBytes
    if (room <= 0) {
      this.truncated = true
      this.drop(text, bytes)
      return this.outputBreach()
    }
    const buffer = Buffer.from(text, 'utf8')
    if (buffer.length <= room) {
      this.kept.push(text)
      this.keptBytes += buffer.length
      return undefined
    }
    // Cut on a character boundary, or not at all. A split UTF-8 sequence would put
    // a replacement character in the kept prefix, which is worse than a shorter
    // prefix: the kept bytes must be a prefix of what the kernel really wrote.
    const cut = utf8SafeCut(buffer, room)
    if (cut > 0) {
      const piece = buffer.subarray(0, cut).toString('utf8')
      this.kept.push(piece)
      this.keptBytes += Buffer.byteLength(piece, 'utf8')
    }
    this.truncated = true
    // Only the UNKEPT remainder goes to the spill. The kept prefix is already in
    // the result, and the cut point is recoverable as `keptBytes`, so spilling the
    // whole frame would duplicate data for no gain.
    const remainder = buffer.subarray(cut)
    this.drop(remainder.toString('utf8'), remainder.length)
    return this.outputBreach()
  }

  private outputBreach(): AccumulatorBreach {
    return {
      budget: 'outputBytes',
      limit: this.budgets.outputBytes,
      observed: this.totalBytes,
      residue: 'the kernel produced these bytes; truncation bounds what is kept, not what happened',
    }
  }

  /** Count a MIME payload against its own budget. MIME is never kept as text. */
  countMime(bytes: number): AccumulatorBreach | undefined {
    this.mimeBytes += bytes
    this.totalBytes += bytes
    if (this.mimeBytes <= this.budgets.mimeBytes) return undefined
    this.truncated = true
    return {
      budget: 'mimeBytes',
      limit: this.budgets.mimeBytes,
      observed: this.mimeBytes,
      residue: 'the MIME payload was produced in full by the kernel; only the kept copy is bounded',
    }
  }

  recordError(ename: string, evalue: string): void {
    this.errors.push({ ename, evalue })
  }

  private drop(text: string, bytes: number): void {
    this.dropped.push(text)
    this.droppedBytes += bytes
  }

  /** Whether anything was dropped, i.e. whether a spill ref is owed. */
  get hasSpill(): boolean {
    return this.droppedBytes > 0
  }

  /** The dropped tail. Only ever read to write the spill artifact. */
  droppedText(): string {
    return this.dropped.join('')
  }

  get droppedByteCount(): number {
    return this.droppedBytes
  }

  finish(spillRef: string | undefined): CellOutput {
    return {
      cellId: this.cellId,
      keptBytes: this.keptBytes,
      totalBytes: this.totalBytes,
      mimeBytes: this.mimeBytes,
      /**
       * Frames OBSERVED for this cell, including those whose payload was dropped
       * past the frame bound. Reporting only the kept count would make a flood look
       * like a quiet cell; `keptBytes` is what says how much was retained.
       */
      frames: this.frames,
      truncated: this.truncated,
      spillRef,
      text: this.kept.join(''),
      errors: [...this.errors],
      classes: { ...this.classes },
    }
  }
}

// ---------------------------------------------------------------------------
// Quarantine
// ---------------------------------------------------------------------------

/** A cell whose terminal state could not be established. It keeps its slot. */
export interface QuarantinedCell {
  readonly cellId: string
  readonly identity: KernelIdentity
  readonly reason: string
  readonly since: string
  /** What the cell might have done. Never `none`: that is what `unknown` denies. */
  readonly possibleEffects: readonly string[]
  /** The only thing that clears it. A reconnect is NOT one (REC-08). */
  readonly requires: 'explicit-reconciliation'
}

/** How a quarantined cell was finally resolved. */
export interface QuarantineResolution {
  readonly cellId: string
  readonly resolvedAs: 'confirmed-no-effect' | 'confirmed-effect' | 'abandoned-with-effect'
  readonly evidence: string
  readonly resolvedAt: string
}

// ---------------------------------------------------------------------------
// Recovery
// ---------------------------------------------------------------------------

/** The formats M5 will restore. Everything else is refused, not attempted. */
export type CheckpointFormat = 'json' | 'npy' | 'npz' | 'parquet' | 'arrow'

/**
 * Formats that are REFUSED, with the reason.
 *
 * `pickle`/`dill`/`cloudpickle` are refused because loading them executes
 * attacker-chosen code, and a checkpoint written by a previous epoch is not
 * trusted input. `object` dtype is refused for the same reason one level down:
 * an object array's elements are pickled inside the `.npy`, so a "non-object
 * array" check that only looks at the file name proves nothing.
 */
export const REFUSED_FORMATS: Readonly<Record<string, string>> = Object.freeze({
  pickle: 'pickle executes arbitrary code on load; a cross-epoch checkpoint is untrusted input',
  pkl: 'pickle executes arbitrary code on load; a cross-epoch checkpoint is untrusted input',
  dill: 'dill executes arbitrary code on load and additionally captures code objects',
  cloudpickle: 'cloudpickle executes arbitrary code on load and captures closures',
  joblib: 'joblib wraps pickle and executes arbitrary code on load',
  torch: 'torch.save uses pickle by default; the format does not prove otherwise',
  h5: 'HDF5 can carry pickled attributes and arbitrary object references',
  hdf5: 'HDF5 can carry pickled attributes and arbitrary object references',
})

/** One binding in a checkpoint. */
export interface CheckpointEntry {
  /** The variable name the value is restored as. */
  readonly name: string
  /**
   * The format the manifest CLAIMS.
   *
   * Deliberately `string` and not {@link CheckpointFormat}. A descriptor is read
   * from a manifest, which is untrusted input: typing it as the accepted union
   * would move the refusal out of the runtime and into the compiler, and a
   * manifest parsed from JSON has no compiler. `validateCheckpoint` narrows it,
   * and a name outside the union is refused rather than coerced.
   */
  readonly format: string
  /** Absolute path to the file. Read and validated, never trusted from the name. */
  readonly path: string
  /** Size the writer claims. The actual size is measured and must match. */
  readonly bytes: number
}

/** A checkpoint, with the as-of that makes it interpretable. */
export interface CheckpointDescriptor {
  readonly checkpointId: string
  /** When the checkpoint's contents were true. NOT when it was written. */
  readonly asOf: string
  /** The environment it was taken in. A mismatch is reported, never hidden. */
  readonly environmentDigest: string
  /** The epoch it was taken in. Restoring into a later epoch is the normal case. */
  readonly kernelEpoch: number
  readonly entries: readonly CheckpointEntry[]
}

/** Why one entry was not restored. */
export interface SkippedEntry {
  readonly name: string
  readonly reason: string
}

/** What a restore actually produced. Every field is a separate fact. */
export interface KernelRecoveryReport {
  /** The epoch the kernel is at AFTER the restore. Always a new one. */
  readonly kernelEpoch: number
  /** The checkpoint's as-of. `undefined` when there was no checkpoint at all. */
  readonly checkpointAsOf: string | undefined
  /** Bindings that were validated and loaded. */
  readonly restored: readonly string[]
  /** Bindings that are GONE. A kernel restart puts every prior variable here. */
  readonly lost: readonly string[]
  /** Entries present but refused, with the reason. */
  readonly skipped: readonly SkippedEntry[]
  /** True when the checkpoint's environment digest differs from the current one. */
  readonly environmentChanged: boolean
  /**
   * Cells whose effects were never confirmed. Never empty-and-implied-clean:
   * when this is non-empty the report says the world may be ahead of the record.
   */
  readonly unresolvedEffects: readonly QuarantinedCell[]
  /**
   * Stated in every report because the report is read by a model.
   *
   * A kernel restart is NEVER full session recovery. The Session log, the
   * artifacts and the business admission record are separate objects with their
   * own recovery; this report covers ONLY the volatile kernel.
   */
  readonly scope: string
}

/**
 * The sentence every recovery report carries.
 *
 * It is a constant rather than a comment because it must appear in the data a
 * model reads, not only in the source a human reads. A restart that is described
 * as "recovered" is the single most misleading thing this subsystem could say.
 */
export const RECOVERY_SCOPE_STATEMENT =
  'This report covers the VOLATILE KERNEL only. A kernel restart is not full session recovery: '
  + 'the Session log, artifacts and admission record are separate objects and are recovered separately. '
  + 'No past cell was replayed.'

/** Bounds applied while validating a checkpoint file. */
export interface CheckpointLimits {
  /** Largest single file accepted. */
  readonly maxFileBytes: number
  /** Largest total uncompressed content accepted from one archive. */
  readonly maxUncompressedBytes: number
  /** Largest number of members accepted from one archive. */
  readonly maxArchiveMembers: number
  /** Largest JSON document accepted, in bytes. */
  readonly maxJsonBytes: number
}

export const DEFAULT_CHECKPOINT_LIMITS: CheckpointLimits = Object.freeze({
  maxFileBytes: 512 * 1024 * 1024,
  maxUncompressedBytes: 1024 * 1024 * 1024,
  maxArchiveMembers: 256,
  maxJsonBytes: 64 * 1024 * 1024,
})

/** A validated entry, ready to be loaded inside the kernel. */
export interface RestorableEntry {
  readonly name: string
  readonly format: CheckpointFormat
  readonly path: string
  readonly bytes: number
  readonly sha256: string
  /** For arrays: the element count and dtype read out of the real header. */
  readonly shape?: readonly number[]
  readonly descr?: string
}

/** The outcome of validating a checkpoint without loading it. */
export interface CheckpointValidation {
  readonly accepted: readonly RestorableEntry[]
  readonly skipped: readonly SkippedEntry[]
  readonly totalBytes: number
}

/** Pickle protocol 2..5 start with these two bytes. The strongest cheap signal. */
function looksLikeBinaryPickle(bytes: Buffer): boolean {
  return bytes.length >= 2 && bytes[0] === 0x80 && bytes[1] !== undefined && bytes[1] >= 0x02 && bytes[1] <= 0x05
}

/** The `.npy` magic. */
const NPY_MAGIC = Buffer.from([0x93, 0x4e, 0x55, 0x4d, 0x50, 0x59])

/** Parse a `.npy` header out of already-inflated bytes. */
function parseNpyHeader(bytes: Buffer): { descr: string; shape: readonly number[]; headerBytes: number } {
  if (bytes.length < 10 || !bytes.subarray(0, 6).equals(NPY_MAGIC)) {
    throw new Error('not a .npy file: the 6-byte magic is absent')
  }
  const major = bytes[6]
  let headerLength: number
  let headerStart: number
  if (major === 1) {
    headerLength = bytes.readUInt16LE(8)
    headerStart = 10
  } else if (major === 2 || major === 3) {
    headerLength = bytes.readUInt32LE(8)
    headerStart = 12
  } else {
    throw new Error(`unsupported .npy version ${String(major)}`)
  }
  if (headerStart + headerLength > bytes.length) {
    throw new Error('.npy header length exceeds the file; the file is truncated or lying')
  }
  const header = bytes.subarray(headerStart, headerStart + headerLength).toString('latin1')
  const descrMatch = /'descr'\s*:\s*'([^']*)'/.exec(header)
  if (descrMatch === null || descrMatch[1] === undefined) {
    throw new Error('.npy header has no descr field; refusing an array whose dtype is unknown')
  }
  const descr = descrMatch[1]
  const shapeMatch = /'shape'\s*:\s*\(([^)]*)\)/.exec(header)
  const shape: number[] = []
  if (shapeMatch !== null && shapeMatch[1] !== undefined) {
    for (const part of shapeMatch[1].split(',')) {
      const trimmed = part.trim()
      if (trimmed === '') continue
      const value = Number(trimmed)
      if (!Number.isInteger(value) || value < 0) throw new Error(`.npy shape contains a non-integer: ${trimmed}`)
      shape.push(value)
    }
  }
  return { descr, shape, headerBytes: headerStart + headerLength }
}

/** Elements in a shape, guarding against an overflow that would fake a small array. */
function shapeElementCount(shape: readonly number[]): number {
  let count = 1
  for (const dimension of shape) {
    count *= dimension
    if (!Number.isSafeInteger(count)) throw new Error('array shape overflows a safe integer')
  }
  return count
}

/** Bytes per element, read from the numpy dtype string. */
function descrItemsize(descr: string): number {
  const match = /(\d+)$/.exec(descr)
  if (match === null || match[1] === undefined) return 1
  return Number(match[1])
}

/**
 * Whether a dtype is refused.
 *
 * `O` is the object dtype: its elements are pickled inside the array, so a file
 * whose descr is object-bearing is a pickle by another name. Checked on the REAL
 * header bytes rather than on the file name, because the name is attacker-chosen
 * and the header is what numpy will read.
 */
function refusedDescr(descr: string): string | undefined {
  if (descr.includes('O')) {
    return `dtype "${descr}" is object-bearing; its elements are pickled inside the array, `
      + 'so restoring it would deserialize untrusted objects'
  }
  return undefined
}

/** A central-directory entry from a zip archive. */
interface ZipMember {
  readonly name: string
  readonly compressedSize: number
  readonly uncompressedSize: number
  readonly localHeaderOffset: number
}

/**
 * Read a zip archive's central directory without extracting anything.
 *
 * WHY NOT THE LOCAL HEADERS: numpy writes `.npz` through `zipfile`, which streams
 * and therefore leaves the sizes in the local header as zero and puts them in a
 * data descriptor after the data. The central directory always carries the real
 * sizes, so it is the only place a decompression-bomb bound can be read from.
 */
function readZipCentralDirectory(bytes: Buffer): ZipMember[] {
  // End of central directory: scan backwards. The comment can be up to 64 KiB.
  const minimumEocd = 22
  let eocd = -1
  const lowest = Math.max(0, bytes.length - (minimumEocd + 0xffff))
  for (let i = bytes.length - minimumEocd; i >= lowest; i -= 1) {
    if (bytes.readUInt32LE(i) === 0x06054b50) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new Error('not a zip archive: no end-of-central-directory record')
  const entryCount = bytes.readUInt16LE(eocd + 10)
  const cdOffset = bytes.readUInt32LE(eocd + 16)
  if (cdOffset >= bytes.length) throw new Error('zip central directory offset is past the end of the file')
  const members: ZipMember[] = []
  let cursor = cdOffset
  for (let index = 0; index < entryCount; index += 1) {
    if (cursor + 46 > bytes.length) throw new Error('zip central directory is truncated')
    if (bytes.readUInt32LE(cursor) !== 0x02014b50) {
      throw new Error('zip central directory entry has a bad signature')
    }
    const compressedSize = bytes.readUInt32LE(cursor + 20)
    const uncompressedSize = bytes.readUInt32LE(cursor + 24)
    const nameLength = bytes.readUInt16LE(cursor + 28)
    const extraLength = bytes.readUInt16LE(cursor + 30)
    const commentLength = bytes.readUInt16LE(cursor + 32)
    const localHeaderOffset = bytes.readUInt32LE(cursor + 42)
    const name = bytes.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8')
    members.push({ name, compressedSize, uncompressedSize, localHeaderOffset })
    cursor += 46 + nameLength + extraLength + commentLength
  }
  return members
}

/** Inflate one zip member with a hard output bound. */
function inflateZipMember(archive: Buffer, member: ZipMember, limit: number): Buffer {
  const offset = member.localHeaderOffset
  if (offset + 30 > archive.length) throw new Error(`zip member "${member.name}" has a bad local header offset`)
  if (archive.readUInt32LE(offset) !== 0x04034b50) {
    throw new Error(`zip member "${member.name}" has a bad local header signature`)
  }
  const nameLength = archive.readUInt16LE(offset + 26)
  const extraLength = archive.readUInt16LE(offset + 28)
  const dataStart = offset + 30 + nameLength + extraLength
  const dataEnd = dataStart + member.compressedSize
  if (dataEnd > archive.length) throw new Error(`zip member "${member.name}" runs past the end of the archive`)
  const compressed = archive.subarray(dataStart, dataEnd)
  const method = archive.readUInt16LE(offset + 8)
  if (method === 0) return Buffer.from(compressed)
  if (method !== 8) throw new Error(`zip member "${member.name}" uses compression method ${String(method)}`)
  // `maxOutputLength` makes the bound a property of zlib, not of our arithmetic:
  // a bomb throws instead of allocating, which is the only bound that holds when
  // the declared uncompressed size is itself a lie.
  return inflateRawSync(compressed, { maxOutputLength: limit })
}

/**
 * Validate a checkpoint's files WITHOUT loading them into a kernel.
 *
 * This is the gate REC-07 turns on. It refuses pickle-family formats by name and
 * by magic bytes (a `.json` file that is really a pickle is refused on its
 * content, not on its extension), refuses object-dtype arrays by reading the real
 * `.npy` header, and bounds every archive by its declared uncompressed size AND
 * by zlib's own output limit.
 *
 * WHAT IT DOES NOT DO: it does not parse Parquet or Arrow. Those formats are
 * accepted on their magic bytes and their size, which establishes "this is a
 * Parquet/Arrow file and it is within bounds" and NOTHING about its contents. M5
 * did not test a real Parquet reader, so it does not claim to have validated one.
 *
 * @param checkpoint - the descriptor naming the files.
 * @param limits - the size bounds. Defaults are conservative.
 * @returns the entries that passed, and the reason each other entry did not.
 */
export function validateCheckpoint(
  checkpoint: CheckpointDescriptor,
  limits: CheckpointLimits = DEFAULT_CHECKPOINT_LIMITS,
): CheckpointValidation {
  const accepted: RestorableEntry[] = []
  const skipped: SkippedEntry[] = []
  let totalBytes = 0

  for (const entry of checkpoint.entries) {
    const refusedByName = REFUSED_FORMATS[entry.format.toLowerCase()]
    if (refusedByName !== undefined) {
      skipped.push({ name: entry.name, reason: refusedByName })
      continue
    }
    let bytes: Buffer
    try {
      bytes = readFileSync(entry.path)
    } catch (error) {
      skipped.push({ name: entry.name, reason: `unreadable: ${error instanceof Error ? error.message : String(error)}` })
      continue
    }
    if (bytes.length !== entry.bytes) {
      skipped.push({
        name: entry.name,
        reason: `declared ${String(entry.bytes)} bytes but the file is ${String(bytes.length)}; a checkpoint that `
          + 'disagrees with itself is not restored',
      })
      continue
    }
    if (bytes.length > limits.maxFileBytes) {
      skipped.push({ name: entry.name, reason: `file is ${String(bytes.length)} bytes, past the limit` })
      continue
    }
    if (looksLikeBinaryPickle(bytes)) {
      skipped.push({
        name: entry.name,
        reason: `the bytes are a binary pickle (protocol ${String(bytes[1] ?? 0)}) despite being declared `
          + `"${entry.format}"; refusing on content, not on the extension`,
      })
      continue
    }
    const sha256 = createHash('sha256').update(bytes).digest('hex')

    try {
      if (entry.format === 'json') {
        if (bytes.length > limits.maxJsonBytes) {
          skipped.push({ name: entry.name, reason: `JSON document is ${String(bytes.length)} bytes, past the limit` })
          continue
        }
        // A JSON document must START as JSON. This catches a mislabelled binary
        // payload that is not a pickle either.
        const first = bytes.toString('utf8', 0, Math.min(1, bytes.length)).trim()
        if (!'{[".-0123456789tfn'.includes(first)) {
          skipped.push({ name: entry.name, reason: `declared json but starts with ${JSON.stringify(first)}` })
          continue
        }
        JSON.parse(bytes.toString('utf8'))
        accepted.push({ name: entry.name, format: 'json', path: entry.path, bytes: bytes.length, sha256 })
        totalBytes += bytes.length
        continue
      }
      if (entry.format === 'npy') {
        const header = parseNpyHeader(bytes)
        const refused = refusedDescr(header.descr)
        if (refused !== undefined) {
          skipped.push({ name: entry.name, reason: refused })
          continue
        }
        const elements = shapeElementCount(header.shape)
        const expected = header.headerBytes + elements * descrItemsize(header.descr)
        if (expected > bytes.length) {
          skipped.push({
            name: entry.name,
            reason: `the header declares ${String(elements)} elements needing ${String(expected)} bytes but the `
              + `file is ${String(bytes.length)}; refusing a truncated array`,
          })
          continue
        }
        accepted.push({
          name: entry.name, format: 'npy', path: entry.path, bytes: bytes.length, sha256,
          shape: header.shape, descr: header.descr,
        })
        totalBytes += bytes.length
        continue
      }
      if (entry.format === 'npz') {
        const members = readZipCentralDirectory(bytes)
        if (members.length > limits.maxArchiveMembers) {
          skipped.push({
            name: entry.name,
            reason: `archive has ${String(members.length)} members, past the limit of ${String(limits.maxArchiveMembers)}`,
          })
          continue
        }
        let declared = 0
        for (const member of members) declared += member.uncompressedSize
        if (declared > limits.maxUncompressedBytes) {
          skipped.push({
            name: entry.name,
            reason: `archive declares ${String(declared)} uncompressed bytes, past the limit; this is the `
              + 'decompression-bomb bound',
          })
          continue
        }
        let bomb = false
        let objectBearing: string | undefined
        let compressedSoFar = 0
        for (const member of members) {
          compressedSoFar += member.uncompressedSize
          if (compressedSoFar > limits.maxUncompressedBytes) {
            bomb = true
            break
          }
          let inflated: Buffer
          try {
            inflated = inflateZipMember(bytes, member, limits.maxUncompressedBytes - (compressedSoFar - member.uncompressedSize))
          } catch (error) {
            // A zlib output-limit failure lands here: the declared size was a lie.
            bomb = true
            objectBearing = `${member.name}: ${error instanceof Error ? error.message : String(error)}`
            break
          }
          if (inflated.length !== member.uncompressedSize) {
            bomb = true
            objectBearing = `${member.name} inflated to ${String(inflated.length)} bytes, not the declared `
              + `${String(member.uncompressedSize)}`
            break
          }
          try {
            const header = parseNpyHeader(inflated)
            const refused = refusedDescr(header.descr)
            if (refused !== undefined) {
              objectBearing = `${member.name}: ${refused}`
              break
            }
          } catch (error) {
            objectBearing = `${member.name}: ${error instanceof Error ? error.message : String(error)}`
            break
          }
        }
        if (bomb) {
          skipped.push({ name: entry.name, reason: `archive bound exceeded or inconsistent: ${objectBearing ?? 'unknown'}` })
          continue
        }
        if (objectBearing !== undefined) {
          skipped.push({ name: entry.name, reason: `archive member refused: ${objectBearing}` })
          continue
        }
        accepted.push({ name: entry.name, format: 'npz', path: entry.path, bytes: bytes.length, sha256 })
        totalBytes += bytes.length
        continue
      }
      if (entry.format === 'parquet') {
        // Magic at BOTH ends, per the Parquet specification. A prefix-only check
        // would accept a truncated file.
        if (bytes.subarray(0, 4).toString('latin1') !== 'PAR1' || bytes.subarray(-4).toString('latin1') !== 'PAR1') {
          skipped.push({ name: entry.name, reason: 'not a Parquet file: PAR1 magic is not at both ends' })
          continue
        }
        // HONEST LIMIT: the magic and the size are all M5 verifies. No Parquet
        // reader was run, so no claim is made about the file's contents.
        accepted.push({ name: entry.name, format: 'parquet', path: entry.path, bytes: bytes.length, sha256 })
        totalBytes += bytes.length
        continue
      }
      if (entry.format === 'arrow') {
        if (bytes.subarray(0, 6).toString('latin1') !== 'ARROW1' || bytes.subarray(-6).toString('latin1') !== 'ARROW1') {
          skipped.push({ name: entry.name, reason: 'not an Arrow file: ARROW1 magic is not at both ends' })
          continue
        }
        // HONEST LIMIT: same as Parquet. Magic and size only.
        accepted.push({ name: entry.name, format: 'arrow', path: entry.path, bytes: bytes.length, sha256 })
        totalBytes += bytes.length
        continue
      }
      skipped.push({ name: entry.name, reason: `format "${String(entry.format)}" is not one M5 restores` })
    } catch (error) {
      skipped.push({ name: entry.name, reason: `validation failed: ${error instanceof Error ? error.message : String(error)}` })
    }
  }

  return { accepted, skipped, totalBytes }
}

// ---------------------------------------------------------------------------
// Supervisor
// ---------------------------------------------------------------------------

/** A kernel the supervisor knows about. */
interface KernelEntry {
  identity: KernelIdentity
  transport: KernelTransport
  process: KernelProcessFact
  state: 'starting' | 'idle' | 'busy' | 'parked' | 'wedged' | 'closed'
  /** Cells waiting for the kernel. Bounded by `maxPendingCells`. */
  pending: {
    cellId: string
    source: string
    resolve: (result: CellResult) => void
    reject: (error: unknown) => void
  }[]
  /**
   * Callbacks to run when the active cell leaves `active`.
   *
   * WHY THIS IS A LIST AND NOT A POLL. `reset` and a permission-domain change must
   * wait for the running cell to finish before replacing the process. Polling for
   * that on a timer makes the wait depend on the clock advancing, which is exactly
   * the dependency that hangs when the clock is injected (a test's own timeout was
   * the first symptom). Resolving a promise when the cell actually settles is both
   * correct and immediate.
   */
  idleWaiters: (() => void)[]
  /** The cell currently running, if any. */
  active: {
    cellId: string
    parentId: string
    accumulator: OutputAccumulator
    startedAt: number
    /** Set when an interrupt has been dispatched and the grace is running. */
    graceDeadline: number | undefined
    /**
     * Why the grace is running, as text for the uncertainty report.
     *
     * MUTABLE, and read by the grace timer when it FIRES rather than when it was
     * armed. The interrupt dispatch is awaited after the grace is armed, so the
     * reason can become more precise while the grace is already running: an
     * interrupt that could not be dispatched at all is a strictly worse fact than
     * a slow one, and it must reach the report instead of being lost because the
     * arm happened first.
     */
    graceReason: string | undefined
    /** Set when the outcome was declared unknown and the kernel is being replaced. */
    abandoned: boolean
    /** Resolves the caller's promise. Called exactly once. */
    settle: (outcome: CellOutcome, settlement: CellSettlement | undefined, reason: string | undefined, uncertainty: string | undefined) => void
    /** Records a breach against both this cell's result and the global log. */
    collect: (breach: Omit<BudgetBreach, 'cellId'>) => void
    /** Nested-call and data-byte counters, which are not observable from the wire. */
    nestedCalls: number
    dataBytes: number
  } | undefined
  /** Parent ids of cells that have already settled, so late frames can be attributed. */
  settledParents: Map<string, string>
  /** Frames that arrived after their cell settled, per class. Never merged in. */
  orphaned: { frameClass: OutputClass; cellId: string | undefined; bytes: number; at: string }[]
  /** Kernel RSS as last measured, for the parked-memory budget. */
  rssBytes: number | undefined
  parkedAt: number | undefined
  /** Bumped by every restart. */
  restarts: number
  /** Bindings known to be live in this incarnation, for the loss report. */
  knownBindings: Set<string>
}

/** The supervisor's view of one kernel. */
export interface KernelStatus {
  readonly identity: KernelIdentity
  readonly state: KernelEntry['state']
  readonly pid: number | undefined
  readonly pendingCells: number
  readonly activeCellId: string | undefined
  readonly rssBytes: number | undefined
  readonly restarts: number
  /** Frames attributed to an already-settled cell. */
  readonly lateFrames: number
  /** Frames attributed to no cell we ever issued. */
  readonly unattributedFrames: number
  /**
   * The semantics of a cell id, stated in the data a model can read.
   *
   * Present so that no consumer can mistake a cell id for a security boundary.
   * Within one CPython process an old background thread can touch a new cell's
   * memory (FACT 16); isolation comes from the kernel being a separate process
   * with its own Session and OS identity, never from the cell id.
   */
  readonly cellIdSemantics: 'attribution-cancel-audit-only'
  readonly isolationBoundary: 'session-and-kernel-process'
}

/** Options for {@link KernelSupervisor}. */
export interface KernelSupervisorOptions {
  readonly budgets?: Partial<KernelBudgets>
  readonly spill?: OutputSpill
  /** Injected for tests. Defaults to `Date.now`. */
  readonly now?: () => number
  /** Injected for tests. Defaults to a real timer. */
  readonly setTimer?: (fn: () => void, ms: number) => unknown
  readonly clearTimer?: (handle: unknown) => void
}

/**
 * The kernel supervisor.
 *
 * One instance owns every kernel this host has started. It is the only place that
 * decides to restart a kernel, increment an epoch, evict a parked kernel or
 * declare a cell unknown -- and every one of those decisions is reported in a
 * result rather than performed silently.
 */
export class KernelSupervisor {
  private readonly kernels = new Map<string, KernelEntry>()
  private readonly budgets: KernelBudgets
  private readonly spill: OutputSpill | undefined
  private readonly now: () => number
  private readonly setTimer: (fn: () => void, ms: number) => unknown
  private readonly clearTimer: (handle: unknown) => void
  private readonly quarantined = new Map<string, QuarantinedCell>()
  private readonly resolutions: QuarantineResolution[] = []
  private readonly breaches: BudgetBreach[] = []
  private readonly evictions: { identity: KernelIdentity; rssBytes: number; lost: string[]; at: string }[] = []
  private readonly reconnects: {
    at: string
    ambiguousCells: readonly string[]
    reexecuted: readonly string[]
    note: string
  }[] = []
  /** Frames attributed to no live cell, kept bounded so the ledger cannot grow without limit. */
  private readonly orphanLedger: { frameClass: OutputClass; cellId: string | undefined; bytes: number; at: string }[] = []
  private readonly maxOrphanLedgerEntries = 256

  constructor(options: KernelSupervisorOptions = {}) {
    this.budgets = { ...DEFAULT_BUDGETS, ...options.budgets }
    this.spill = options.spill
    this.now = options.now ?? (() => Date.now())
    this.setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
    this.clearTimer = options.clearTimer ?? ((handle) => { clearTimeout(handle as ReturnType<typeof setTimeout>) })
  }

  /** The effective budgets. Reported so a caller can see what it is held to. */
  effectiveBudgets(): KernelBudgets {
    return this.budgets
  }

  /**
   * Register a kernel. The transport is started here and is owned by this entry.
   *
   * `identity` must carry the epoch the caller believes it is at. A restart
   * increments the supervisor's own epoch counter; a caller that supplies an epoch
   * the supervisor has already moved past is refused, because two writers
   * disagreeing about an epoch is how a stale callback writes authoritative state.
   */
  async register(identity: KernelIdentity, transport: KernelTransport): Promise<KernelStatus> {
    const key = kernelSlotKey(identity)
    const existing = this.kernels.get(key)
    if (existing !== undefined) {
      throw new Error(
        `kernel slot for session "${identity.sessionId}" in world "${identity.executionWorld}" is already `
        + `registered at epoch ${String(existing.identity.kernelEpoch)}`,
      )
    }
    const entry: KernelEntry = {
      identity,
      transport,
      process: { pid: undefined },
      state: 'starting',
      pending: [],
      active: undefined,
      idleWaiters: [],
      settledParents: new Map(),
      orphaned: [],
      rssBytes: undefined,
      parkedAt: undefined,
      restarts: 0,
      knownBindings: new Set(),
    }
    this.kernels.set(key, entry)
    entry.transport.onFrame(frame => { this.onFrame(key, frame) })
    entry.process = await entry.transport.start()
    entry.state = 'idle'
    return this.status(key)
  }

  /** Every registered kernel. */
  listStatuses(): KernelStatus[] {
    return [...this.kernels.keys()].map(key => this.status(key))
  }

  status(key: string): KernelStatus {
    const entry = this.require(key)
    return {
      identity: entry.identity,
      state: entry.state,
      pid: entry.process.pid,
      pendingCells: entry.pending.length,
      activeCellId: entry.active?.cellId,
      rssBytes: entry.rssBytes,
      restarts: entry.restarts,
      lateFrames: entry.orphaned.filter(o => o.frameClass === 'late').length,
      unattributedFrames: entry.orphaned.filter(o => o.frameClass === 'unattributed').length,
      cellIdSemantics: 'attribution-cancel-audit-only',
      isolationBoundary: 'session-and-kernel-process',
    }
  }

  /** Breaches observed so far, in order. Diagnostic; never an authority. */
  breachLog(): readonly BudgetBreach[] {
    return this.breaches
  }

  /** Evictions performed, with what was lost. */
  evictionLog(): readonly { identity: KernelIdentity; rssBytes: number; lost: string[]; at: string }[] {
    return this.evictions
  }

  private require(key: string): KernelEntry {
    const entry = this.kernels.get(key)
    if (entry === undefined) throw new Error(`no kernel registered for slot "${key}"`)
    return entry
  }

  /**
   * A cell that was never run, with the reason.
   *
   * `outcome: 'refused'` and a null output, deliberately: a refusal must not carry
   * an empty `CellOutput`, because an empty output and a cell that produced
   * nothing are the same shape and a reader would conflate them. The reason is the
   * whole content.
   */
  private refusal(entry: KernelEntry, cellId: string, reason: string): CellResult {
    return {
      cellId,
      identity: entry.identity,
      outcome: 'refused',
      status: undefined,
      ename: undefined,
      output: undefined,
      breaches: [],
      wallMs: 0,
      kernelRestarted: false,
      kernelEpoch: entry.identity.kernelEpoch,
      reason,
      uncertainty: undefined,
    }
  }

  // -------------------------------------------------------------------------
  // Frame attribution
  // -------------------------------------------------------------------------

  /**
   * Attribute one frame.
   *
   * The order matters and is the whole point of this method:
   *   1. the active cell's parent  -> `cell`
   *   2. a parent that already settled -> `late` (FACT 1 makes this reachable)
   *   3. a shell frame with a mismatched parent -> `foreign`
   *   4. anything else -> `unattributed`
   *
   * A late or unattributed frame is NEVER added to the running cell's output. The
   * architecture document calls this out because the alternative -- letting a
   * background print land in the next cell's stdout -- makes a result look like it
   * came from code that never produced it.
   */
  private onFrame(key: string, frame: FrameFact): void {
    const entry = this.kernels.get(key)
    if (entry === undefined) return
    const active = entry.active
    let frameClass: OutputClass
    let attributedCell: string | undefined

    if (active !== undefined && frame.parentId !== undefined && frame.parentId === active.parentId) {
      frameClass = 'cell'
      attributedCell = active.cellId
    } else if (frame.parentId !== undefined && entry.settledParents.has(frame.parentId)) {
      frameClass = 'late'
      attributedCell = entry.settledParents.get(frame.parentId)
    } else if (frame.shell === true && frame.parentId !== undefined) {
      // A shell reply for a request we are not waiting on. Measured to exist on
      // EVERY kernel start: `wait_for_ready` sends `kernel_info_request` and its
      // reply can still be queued when the first cell is issued (M11).
      frameClass = 'foreign'
    } else {
      frameClass = 'unattributed'
    }

    this.recordOrphan(entry, { frameClass, cellId: attributedCell, bytes: frame.bytes, at: new Date(this.now()).toISOString() })

    if (active === undefined) return

    active.accumulator.classify(frameClass)
    if (frameClass !== 'cell') {
      // Counted in the classes histogram, dropped from the cell's payload.
      return
    }
    // The frame budget is checked FIRST and gates the payload: past it the frame
    // is counted and its payload dropped, which is what keeps a chatty cell from
    // turning the frame count into unbounded work.
    const frameBreach = active.accumulator.countFrame()
    if (frameBreach !== undefined) {
      active.collect({ ...frameBreach, action: 'truncated' })
      return
    }
    if (frame.kind === 'stream' && frame.text !== undefined) {
      const breach = active.accumulator.keepStream(frame.text)
      if (breach !== undefined) active.collect({ ...breach, action: 'truncated' })
      return
    }
    if (frame.kind === 'mime') {
      const breach = active.accumulator.countMime(frame.bytes)
      if (breach !== undefined) active.collect({ ...breach, action: 'truncated' })
      return
    }
    if (frame.kind === 'error') {
      active.accumulator.recordError(frame.ename ?? 'Unknown', frame.evalue ?? '')
    }
  }

  private recordOrphan(entry: KernelEntry, item: KernelEntry['orphaned'][number]): void {
    if (item.frameClass === 'cell') return
    if (entry.orphaned.length >= this.maxOrphanLedgerEntries) entry.orphaned.shift()
    entry.orphaned.push(item)
    if (this.orphanLedger.length >= this.maxOrphanLedgerEntries) this.orphanLedger.shift()
    this.orphanLedger.push(item)
  }

  /** Frames attributed to an already-settled cell, across every kernel. */
  lateFrames(): readonly { frameClass: OutputClass; cellId: string | undefined; bytes: number; at: string }[] {
    return this.orphanLedger.filter(o => o.frameClass === 'late')
  }

  /** Frames attributed to no cell this host ever issued. */
  unattributedFrames(): readonly { frameClass: OutputClass; cellId: string | undefined; bytes: number; at: string }[] {
    return this.orphanLedger.filter(o => o.frameClass === 'unattributed' || o.frameClass === 'foreign')
  }

  /**
   * Record a breach that is NOT attributable to the running cell.
   *
   * Cell-attributable breaches go through the cell's own `collect`, which files
   * them against the cell's result as well as the global log. This entry point is
   * for the ones that have no cell: a parked-kernel memory breach, an eviction.
   */
  private recordBreach(entry: KernelEntry, breach: BudgetBreach): void {
    this.breaches.push(breach)
  }

  // -------------------------------------------------------------------------
  // Running cells
  // -------------------------------------------------------------------------

  /**
   * Run one cell. Serial per kernel, concurrent across kernels.
   *
   * The queue is BOUNDED. When it is full the call is refused immediately with a
   * `refused` result rather than waiting, because a queue that grows converts a
   * visible refusal into unbounded latency and memory.
   *
   * The returned promise always resolves; it never hangs on a kernel that stopped
   * answering. FACT 8 is the reason: the transport's settlement promise can stay
   * pending forever, so the supervisor races it against the wall-clock bound and,
   * on expiry, declares the cell `unknown` and replaces the process.
   */
  async runCell(
    key: string,
    request: { readonly cellId: string; readonly source: string; readonly knownBindings?: readonly string[] },
  ): Promise<CellResult> {
    const entry = this.require(key)
    if (entry.state === 'closed') {
      return this.refusal(entry, request.cellId, 'the kernel is closed')
    }
    if (entry.state === 'parked') {
      // A parked kernel has had its active capability revoked. Running a cell
      // here would be the "park cancels host capability" rule inverted.
      return this.refusal(entry, request.cellId, 'the kernel is parked; its capability is revoked until a legal activation rebinds it')
    }
    if (entry.state === 'wedged') {
      return this.refusal(
        entry,
        request.cellId,
        'the kernel is wedged: a previous cell did not settle and the process must be replaced before more work runs',
      )
    }
    if (entry.active !== undefined || entry.pending.length > 0) {
      if (entry.pending.length >= this.budgets.maxPendingCells) {
        this.recordBreach(entry, {
          budget: 'maxPendingCells',
          limit: this.budgets.maxPendingCells,
          observed: entry.pending.length + 1,
          cellId: request.cellId,
          action: 'refused',
          residue: 'the cell was never run; nothing to undo',
        })
        return this.refusal(
          entry,
          request.cellId,
          `this kernel's queue holds ${String(entry.pending.length)} cells, which is its bound; the cell was refused `
          + 'rather than queued, because queueing does not create capacity',
        )
      }
    }

    return await new Promise<CellResult>((resolve, reject) => {
      entry.pending.push({ cellId: request.cellId, source: request.source, resolve, reject })
      if (entry.active === undefined) void this.drain(key)
    })
  }

  /** Start the next queued cell if the kernel is free. */
  private async drain(key: string): Promise<void> {
    const entry = this.kernels.get(key)
    if (entry === undefined || entry.active !== undefined) return
    if (entry.state !== 'idle') return
    const next = entry.pending.shift()
    if (next === undefined) return
    await this.startCell(key, entry, next.cellId, next.source, next.resolve)
  }

  private async startCell(
    key: string,
    entry: KernelEntry,
    cellId: string,
    source: string,
    resolve: (result: CellResult) => void,
  ): Promise<void> {
    const startedAt = this.now()
    const epochAtStart = entry.identity.kernelEpoch
    const accumulator = new OutputAccumulator(cellId, this.budgets)
    const controller = new AbortController()
    let settled = false
    /**
     * Breaches are COLLECTED here, not read from `entry.active` at the end.
     *
     * `settle` clears `entry.active` before `finishCell` runs, so a result built
     * from `entry.active.breaches` would always be empty -- a bug this file's own
     * test caught, and the kind that silently reports a truncated flood as clean.
     */
    const breaches: BudgetBreach[] = []
    const collect = (breach: Omit<BudgetBreach, 'cellId'>): void => {
      const full: BudgetBreach = { ...breach, cellId }
      breaches.push(full)
      this.breaches.push(full)
    }

    /** Settle the caller exactly once, whatever route got here. */
    const settle = (
      outcome: CellOutcome,
      settlement: CellSettlement | undefined,
      reason: string | undefined,
      uncertainty: string | undefined,
    ): void => {
      if (settled) return
      settled = true
      if (entry.active !== undefined && entry.active.cellId === cellId) {
        // Remember the parent so a frame arriving later is classifiable as `late`
        // rather than `unattributed` (FACT 1).
        entry.settledParents.set(entry.active.parentId, cellId)
        entry.active = undefined
      }
      if (entry.state !== 'wedged' && entry.state !== 'closed') entry.state = 'idle'
      // Wake anything waiting for the kernel to become free. A `reset` or a
      // permission-domain change is waiting on exactly this, and it must be told
      // the cell really left rather than polling for it.
      const waiters = entry.idleWaiters.splice(0)
      for (const waiter of waiters) waiter()
      void this.finishCell(key, entry, cellId, outcome, settlement, reason, uncertainty, accumulator, startedAt, resolve, breaches, epochAtStart)
    }

    entry.state = 'busy'
    let handle: CellHandle
    try {
      handle = entry.transport.execute({ cellId, source, signal: controller.signal })
    } catch (error) {
      entry.state = 'idle'
      resolve({
        cellId,
        identity: entry.identity,
        outcome: 'transport-failed',
        status: undefined,
        ename: undefined,
        output: undefined,
        breaches: [],
        wallMs: this.now() - startedAt,
        kernelRestarted: false,
        kernelEpoch: entry.identity.kernelEpoch,
        reason: `the transport refused the cell: ${error instanceof Error ? error.message : String(error)}`,
        uncertainty: undefined,
      })
      void this.drain(key)
      return
    }

    entry.active = {
      cellId,
      parentId: handle.parentId,
      accumulator,
      startedAt,
      graceDeadline: undefined,
      graceReason: undefined,
      abandoned: false,
      settle,
      collect,
      nestedCalls: 0,
      dataBytes: 0,
    }

    // The wall-clock bound. It is the ONLY thing that guarantees this promise
    // resolves: the transport's own promise may never settle.
    const wallTimer = this.setTimer(() => {
      const active = entry.active
      if (active === undefined || active.cellId !== cellId || active.abandoned) return
      collect({
        budget: 'wallMs',
        limit: this.budgets.wallMs,
        observed: this.now() - startedAt,
        action: 'interrupted',
        residue: 'the cell ran for this long; the wall time is spent regardless of what happens next',
      })
      void this.cancelInternal(key, cellId, 'the cell exceeded its wall-clock bound')
    }, this.budgets.wallMs)

    handle.settlement.then(
      settlement => {
        this.clearTimer(wallTimer)
        if (settlement.outcome === 'settled' && settlement.protocolComplete) {
          settle(
            'settled',
            settlement,
            undefined,
            undefined,
          )
          return
        }
        if (settlement.outcome === 'transport-failed') {
          settle('transport-failed', settlement, settlement.detail ?? 'the transport failed', undefined)
          return
        }
        // The transport resolved but the protocol did not complete: reply without
        // idle, or idle without reply. That is NOT a settled cell.
        settle(
          'unknown',
          settlement,
          'the transport resolved without both an execute_reply and a matching idle',
          'the protocol did not complete, so the cell\'s terminal state is not established',
        )
      },
      error => {
        this.clearTimer(wallTimer)
        settle(
          'transport-failed',
          undefined,
          `the transport rejected: ${error instanceof Error ? error.message : String(error)}`,
          undefined,
        )
      },
    )
  }

  private async finishCell(
    key: string,
    entry: KernelEntry,
    cellId: string,
    outcome: CellOutcome,
    settlement: CellSettlement | undefined,
    reason: string | undefined,
    uncertainty: string | undefined,
    accumulator: OutputAccumulator,
    startedAt: number,
    resolve: (result: CellResult) => void,
    breaches: BudgetBreach[],
    epochAtStart: number,
  ): Promise<void> {
    let spillRef: string | undefined
    if (accumulator.hasSpill && this.spill !== undefined) {
      // Truncation is explicit: the dropped tail gets a reference so a reader can
      // tell a bounded result from a short one.
      spillRef = await this.spill.write({
        cellId,
        kind: 'stdout-truncated',
        text: accumulator.droppedText(),
        bytes: accumulator.droppedByteCount,
      })
    } else if (accumulator.hasSpill) {
      spillRef = `unspilled:${String(accumulator.droppedByteCount)}-bytes-dropped-with-no-spill-configured`
    }

    if (outcome === 'unknown') {
      // QUARANTINE. The cell's terminal state is not established, so it holds its
      // slot until an explicit reconciliation resolves it. A reconnect is not one.
      this.quarantined.set(cellId, {
        cellId,
        identity: entry.identity,
        reason: reason ?? 'the cell did not settle',
        since: new Date(this.now()).toISOString(),
        possibleEffects: [
          'the cell may have completed its work with the result lost',
          'the cell may have been interrupted part-way, leaving partial writes',
          'the namespace may have been mutated by code that ran before the interrupt landed',
        ],
        requires: 'explicit-reconciliation',
      })
    }

    // `kernelRestarted` is derived from the epoch, not asserted. The escalation
    // path advances the epoch BEFORE settling the cell, so a hardcoded `false`
    // here would report a restarted kernel as if its namespace survived.
    const kernelRestarted = entry.identity.kernelEpoch !== epochAtStart
    const result: CellResult = {
      cellId,
      identity: entry.identity,
      outcome,
      status: settlement?.status,
      ename: settlement?.ename,
      output: accumulator.finish(spillRef),
      breaches,
      wallMs: this.now() - startedAt,
      kernelRestarted,
      kernelEpoch: entry.identity.kernelEpoch,
      reason,
      uncertainty,
    }
    resolve(result)
    void this.drain(key)
  }

  // -------------------------------------------------------------------------
  // Cancel, and the bounded grace
  // -------------------------------------------------------------------------

  /**
   * Cancel the running cell on this kernel.
   *
   * Returns as soon as the interrupt has been DISPATCHED. The cell's own result is
   * delivered through {@link runCell}'s promise, which will settle either with the
   * kernel's answer or, if the grace expires, as `unknown` after a restart.
   *
   * It deliberately does not await a reply: FACT 8 is a kernel that never sends
   * one, and a cancel that awaited it would hang the caller.
   */
  async cancel(key: string, cellId: string): Promise<{ dispatched: boolean; reason: string }> {
    return await this.cancelInternal(key, cellId, 'the caller cancelled the cell')
  }

  private async cancelInternal(key: string, cellId: string, reason: string): Promise<{ dispatched: boolean; reason: string }> {
    const entry = this.require(key)
    const active = entry.active
    if (active === undefined || active.cellId !== cellId) {
      return { dispatched: false, reason: `cell "${cellId}" is not the running cell on this kernel` }
    }
    if (active.graceDeadline !== undefined) {
      return { dispatched: false, reason: `an interrupt for cell "${cellId}" is already in flight` }
    }
    // THE GRACE IS ARMED BEFORE THE DISPATCH IS AWAITED. This ordering is the bound.
    //
    // `interrupt()` is transport code, so it can reject AND it can never resolve --
    // a wedged socket write, a broker that stopped reading, a process that died
    // mid-handshake. When the grace was armed only AFTER `await interrupt()`
    // returned, a transport that never answered left `runCell`'s promise pending
    // with NO timer outstanding at all, so the wall bound that exists precisely to
    // guarantee the promise resolves could not reach it either. That is the exact
    // failure this module refuses to have, and it was measured rather than
    // inferred: a transport whose `interrupt()` returns a never-settling promise
    // left the cell unresolved after 60 s of injected time, with an empty timer
    // ledger. Arm-then-await makes the promise's resolution depend on the
    // supervisor's own clock alone.
    //
    // It also makes the bound TOTAL rather than per-step: the deadline is measured
    // from the decision to stop the cell, so a slow dispatch cannot silently extend
    // the grace it is supposed to be bounded by.
    active.graceDeadline = this.now() + this.budgets.interruptGraceMs
    active.graceReason = reason
    this.armGrace(key, cellId)
    try {
      await entry.transport.interrupt()
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      // The interrupt could not even be dispatched. That is strictly worse than a
      // slow one, so the grace KEEPS RUNNING and the report says which of the two
      // happened. The reason is read when the grace fires, not when it is armed, so
      // this update reaches the uncertainty text.
      const current = this.kernels.get(key)?.active
      if (current !== undefined && current.cellId === cellId) {
        current.graceReason = `the interrupt could not be dispatched: ${detail}`
      }
      return { dispatched: false, reason: `interrupt dispatch failed: ${detail}` }
    }
    return { dispatched: true, reason: `interrupt dispatched; the outcome becomes unknown after ${String(this.budgets.interruptGraceMs)} ms without a settle` }
  }

  /**
   * THE BOUNDED GRACE.
   *
   * If the cell has not settled when this fires, the supervisor stops waiting and
   * declares the outcome `unknown`, then replaces the process. It does NOT wait
   * for the reply, because there may never be one (FACT 8: 25.16 s and two
   * interrupts produced nothing while the process stayed alive).
   *
   * Two facts make the restart mandatory rather than cautious:
   *
   *   FACT 10: after a non-settling interrupt the NEXT cell settled `aborted` with
   *   no output. So continuing on the same kernel does not merely risk a stale
   *   variable, it silently aborts the following cell's work.
   *
   *   FACT 9: a non-interruptible C extension is in the same class. Nothing in
   *   userspace can stop it, so replacing the process is the only lever -- and it
   *   cannot undo what the extension already did.
   */
  private armGrace(key: string, cellId: string): void {
    const entry = this.kernels.get(key)
    if (entry === undefined) return
    const deadline = entry.active?.graceDeadline
    if (deadline === undefined) return
    const wait = Math.max(0, deadline - this.now())
    this.setTimer(() => {
      const current = this.kernels.get(key)
      if (current === undefined) return
      const active = current.active
      if (active === undefined || active.cellId !== cellId || active.abandoned) return
      active.abandoned = true
      // The reason is read HERE, when the grace fires, rather than captured when it
      // was armed. The dispatch is awaited after arming, so an interrupt that
      // FAILED to dispatch can refine this text while the grace is already running;
      // capturing the arm-time value would report "the caller cancelled the cell"
      // for a transport that never accepted the interrupt.
      void this.escalateToProcessIsolation(key, current, cellId, active.graceReason ?? 'the cell was stopped')
    }, wait)
  }

  /**
   * Replace the kernel process because a cell could not be stopped in place.
   *
   * This is the escalation RES-04 asks for, and it is described as what it is: the
   * process is replaced, the namespace is destroyed, and any effect the cell
   * already had stands. It is NOT a recovery of the cell.
   */
  private async escalateToProcessIsolation(key: string, entry: KernelEntry, cellId: string, reason: string): Promise<void> {
    const previous = entry.identity.kernelEpoch
    entry.state = 'wedged'
    const active = entry.active
    this.recordBreach(entry, {
      budget: 'wallMs',
      limit: this.budgets.interruptGraceMs,
      observed: this.now() - (active?.startedAt ?? this.now()),
      cellId,
      action: 'escalated',
      residue: 'process isolation ends the cell; it does not undo effects the cell already produced, '
        + 'and a non-interruptible extension may still be running inside the dying process',
    })

    const lost = [...entry.knownBindings]
    let restartError: string | undefined
    try {
      entry.process = await entry.transport.restart()
    } catch (error) {
      restartError = error instanceof Error ? error.message : String(error)
    }

    // A NEW EPOCH ONLY WHEN THERE IS A NEW INCARNATION.
    //
    // This guard was MEASURED, by this file's own test `refuses further cells on a
    // kernel that could not be restarted`, after the epoch advanced
    // unconditionally. The consequence was an over-claim in the dangerous
    // direction: `kernelRestarted` is documented as "the supervisor replaced the
    // process ... the namespace is GONE and every variable the caller had is in
    // `lost`", and it is derived from the epoch. Advancing on a THROWN restart made
    // the result assert both of those things when neither had happened -- no
    // process was replaced, so no incarnation was created, and the bindings are
    // STRANDED in a wedged process rather than destroyed. It also left
    // `status().identity.kernelEpoch` naming an incarnation that never existed, so
    // the next successful replacement would skip a number and a stale callback
    // from the still-live old process would be checked against the wrong epoch.
    //
    // The state that IS established is `wedged`: the kernel is unusable and will
    // not be given more work. That is reported below. Keeping `knownBindings`
    // intact is the honest counterpart -- a later real restart (a `reset`, or a
    // successful re-registration) reports them as lost at the moment they are
    // actually destroyed, instead of this path silently dropping the record of
    // variables that are still resident somewhere.
    if (restartError === undefined) {
      entry.identity = { ...entry.identity, kernelEpoch: previous + 1 }
      entry.restarts += 1
      entry.knownBindings = new Set()
      entry.settledParents.clear()
    }

    const uncertainty = restartError === undefined
      ? `the cell did not settle within ${String(this.budgets.interruptGraceMs)} ms of the interrupt (${reason}); `
        + 'the process was replaced, so the outcome is unknown and every prior variable is lost'
      : `the cell did not settle and the process could not be replaced (${restartError}); the kernel is unusable `
        + 'and the outcome remains unknown'

    active?.settle(
      'unknown',
      undefined,
      `the cell did not settle within the bounded grace after ${reason}`,
      uncertainty,
    )

    entry.state = restartError === undefined ? 'idle' : 'wedged'
    this.lostOnRestart.push({
      identity: entry.identity,
      previousEpoch: previous,
      lost,
      at: new Date(this.now()).toISOString(),
      reason: uncertainty,
    })
    void this.drain(key)
  }

  private readonly lostOnRestart: {
    identity: KernelIdentity
    previousEpoch: number
    lost: string[]
    at: string
    reason: string
  }[] = []

  /** What each restart destroyed. Reported so a loss is never silent. */
  restartLosses(): readonly { identity: KernelIdentity; previousEpoch: number; lost: string[]; at: string; reason: string }[] {
    return this.lostOnRestart
  }

  // -------------------------------------------------------------------------
  // Budgets that are not observable from the wire
  // -------------------------------------------------------------------------

  /**
   * Record one nested native call from inside a cell.
   *
   * Returns whether the call is permitted. A refusal here prevents the NEXT call;
   * it cannot recall one already made, which is why the residue is stated in the
   * breach rather than implied away.
   */
  recordNestedCall(key: string, cellId: string): { allowed: boolean; reason?: string } {
    const entry = this.require(key)
    const active = entry.active
    if (active === undefined || active.cellId !== cellId) {
      return { allowed: false, reason: `cell "${cellId}" is not the running cell on this kernel` }
    }
    active.nestedCalls += 1
    if (active.nestedCalls > this.budgets.nestedCalls) {
      // Filed against the CELL as well as the global log, so the refusal reaches
      // the result the caller is holding rather than only a side ledger.
      active.collect({
        budget: 'nestedCalls',
        limit: this.budgets.nestedCalls,
        observed: active.nestedCalls,
        action: 'refused',
        residue: 'the calls already made happened; this refusal stops the next one only',
      })
      return { allowed: false, reason: `cell "${cellId}" has made ${String(active.nestedCalls)} native calls, past its bound` }
    }
    return { allowed: true }
  }

  /** Record data-plane bytes pulled by a cell. Refuses past the bound. */
  recordDataBytes(key: string, cellId: string, bytes: number): { allowed: boolean; reason?: string } {
    const entry = this.require(key)
    const active = entry.active
    if (active === undefined || active.cellId !== cellId) {
      return { allowed: false, reason: `cell "${cellId}" is not the running cell on this kernel` }
    }
    active.dataBytes += bytes
    if (active.dataBytes > this.budgets.dataBytes) {
      active.collect({
        budget: 'dataBytes',
        limit: this.budgets.dataBytes,
        observed: active.dataBytes,
        action: 'refused',
        residue: 'the bytes already read were read; this refusal stops the next read only',
      })
      return { allowed: false, reason: `cell "${cellId}" has read ${String(active.dataBytes)} data bytes, past its bound` }
    }
    return { allowed: true }
  }

  /** Record the kernel's observed resource footprint and check it against budgets. */
  async observeResources(key: string): Promise<{ rssBytes: number | undefined; processes: number | undefined; breaches: readonly BudgetBreach[] }> {
    const entry = this.require(key)
    const found: BudgetBreach[] = []
    const rssBytes = await entry.transport.rssBytes()
    entry.rssBytes = rssBytes
    if (rssBytes !== undefined && rssBytes > this.budgets.kernelRssBytes) {
      const breach: BudgetBreach = {
        budget: 'kernelRssBytes',
        limit: this.budgets.kernelRssBytes,
        observed: rssBytes,
        cellId: entry.active?.cellId,
        action: 'escalated',
        residue: 'the memory is already resident; only eviction releases it, and eviction destroys the namespace',
      }
      this.breaches.push(breach)
      found.push(breach)
    }
    const processes = await entry.transport.processCount()
    if (processes !== undefined && processes > this.budgets.processes) {
      const breach: BudgetBreach = {
        budget: 'processes',
        limit: this.budgets.processes,
        observed: processes,
        cellId: entry.active?.cellId,
        action: 'escalated',
        residue: 'the processes are already running; a restart kills the kernel tree but a detached child may survive',
      }
      this.breaches.push(breach)
      found.push(breach)
    }
    return { rssBytes, processes, breaches: found }
  }

  // -------------------------------------------------------------------------
  // Parking, eviction and the parked-memory budget
  // -------------------------------------------------------------------------

  /**
   * Park a kernel whose Agent activation ended.
   *
   * THIS IS NOT TEARDOWN. A continuable child's activation can end and release its
   * AgentHandle while its Session continues, so the kernel must survive with its
   * namespace intact and be re-bindable by the next legal activation. What parking
   * DOES remove is the host capability: a parked kernel cannot run cells until it
   * is rebound, which is why `runCell` refuses one.
   *
   * The kernel's RSS keeps counting against the host budget while parked. "The
   * child ended" is not a reason to stop accounting for memory it still holds
   * (FACT 13: one parked kernel with a 256 MiB array was 357.71 MB resident).
   */
  async park(key: string): Promise<KernelStatus> {
    const entry = this.require(key)
    if (entry.state === 'busy') {
      throw new Error(
        `kernel for session "${entry.identity.sessionId}" is running cell "${entry.active?.cellId ?? ''}"; `
        + 'parking a busy kernel would revoke a capability a live cell is using',
      )
    }
    entry.state = 'parked'
    entry.parkedAt = this.now()
    await this.observeResources(key)
    return this.status(key)
  }

  /**
   * Rebind a parked kernel to a new activation.
   *
   * The identity is unchanged -- same slot, same epoch -- because the kernel was
   * never destroyed. The returned status carries the epoch so the caller can
   * report which incarnation it just bound to.
   */
  async rebind(key: string): Promise<KernelStatus> {
    const entry = this.require(key)
    if (entry.state !== 'parked') {
      throw new Error(`kernel for session "${entry.identity.sessionId}" is ${entry.state}, not parked`)
    }
    entry.state = 'idle'
    entry.parkedAt = undefined
    return this.status(key)
  }

  /** Total RSS held by parked kernels. This is the number the budget constrains. */
  parkedRssBytes(): number {
    let total = 0
    for (const entry of this.kernels.values()) {
      if (entry.state === 'parked') total += entry.rssBytes ?? 0
    }
    return total
  }

  /** How much of the parked budget is used, and by how many kernels. */
  parkedBudget(): { readonly usedBytes: number; readonly limitBytes: number; readonly kernels: number } {
    let kernels = 0
    for (const entry of this.kernels.values()) {
      if (entry.state === 'parked') kernels += 1
    }
    return { usedBytes: this.parkedRssBytes(), limitBytes: this.budgets.parkedRssBytes, kernels }
  }

  /**
   * Evict parked kernels until the parked-memory budget is satisfied.
   *
   * Eviction DESTROYS the namespace, so it always produces a loss record and a
   * breach entry naming the kernel and the memory it was holding. The oldest
   * parked kernel is evicted first, because it is the one whose state has been
   * idle longest and is therefore the least likely to be wanted.
   *
   * This is a real choice, not a leak: FACT 13 showed RSS returns to 89 MB once
   * the held object is dropped, so eviction genuinely releases the memory.
   */
  async reclaimParkedMemory(): Promise<{
    readonly evicted: readonly KernelIdentity[]
    readonly parkedRssBytes: number
    readonly limitBytes: number
    readonly satisfied: boolean
  }> {
    const evicted: KernelIdentity[] = []
    const parked = [...this.kernels.entries()]
      .filter(([, entry]) => entry.state === 'parked')
      .sort((a, b) => (a[1].parkedAt ?? 0) - (b[1].parkedAt ?? 0))
    for (const [key, entry] of parked) {
      if (this.parkedRssBytes() <= this.budgets.parkedRssBytes) break
      if (evicted.length >= this.budgets.maxEvictionsPerPass) break
      const rssBytes = entry.rssBytes ?? 0
      const lost = [...entry.knownBindings]
      const previousEpoch = entry.identity.kernelEpoch
      await entry.transport.shutdown()
      entry.identity = { ...entry.identity, kernelEpoch: previousEpoch + 1 }
      entry.knownBindings = new Set()
      entry.state = 'closed'
      evicted.push(entry.identity)
      this.evictions.push({ identity: entry.identity, rssBytes, lost, at: new Date(this.now()).toISOString() })
      this.lostOnRestart.push({
        identity: entry.identity,
        previousEpoch,
        lost,
        at: new Date(this.now()).toISOString(),
        reason: 'evicted to satisfy the parked-kernel memory budget',
      })
      this.breaches.push({
        budget: 'parkedRssBytes',
        limit: this.budgets.parkedRssBytes,
        observed: rssBytes,
        cellId: undefined,
        action: 'evicted',
        residue: `kernel for session "${entry.identity.sessionId}" was destroyed; its ${String(lost.length)} known `
          + 'binding(s) are lost and its epoch advanced',
      })
      this.kernels.delete(key)
    }
    return {
      evicted,
      parkedRssBytes: this.parkedRssBytes(),
      limitBytes: this.budgets.parkedRssBytes,
      satisfied: this.parkedRssBytes() <= this.budgets.parkedRssBytes,
    }
  }

  /** Note a binding as live so a later loss is reportable rather than anonymous. */
  noteBinding(key: string, name: string): void {
    this.require(key).knownBindings.add(name)
  }

  // -------------------------------------------------------------------------
  // Permission change, session swap, reset
  // -------------------------------------------------------------------------

  /**
   * Change the read-permission domain of a Session.
   *
   * THE KERNEL IS ALWAYS RESTARTED. This is not a policy choice: the namespace
   * holds values that were read under the OLD domain, and there is no mechanism
   * that can enumerate them, decide which are secret, and un-read them. A variable
   * holding a file's contents is indistinguishable from one holding a constant.
   * So the kernel is replaced, the epoch advances, and the loss is reported.
   *
   * Order is load-bearing and is the one the architecture document requires:
   * close admission -> cancel and clean up -> new epoch.
   */
  async changeReadPermissionDomain(
    key: string,
    next: { readonly executionWorld: string; readonly environmentDigest: string },
    reason: string,
  ): Promise<{
    readonly previousEpoch: number
    readonly kernelEpoch: number
    readonly lost: readonly string[]
    readonly restarted: boolean
    readonly reason: string
  }> {
    const entry = this.require(key)
    // 1. Close admission: no new cell may be admitted from here on.
    entry.state = 'wedged'
    // 2. Cancel and clean up: stop whatever is running and wait for its slot.
    if (entry.active !== undefined) {
      await this.cancelInternal(key, entry.active.cellId, `read-permission domain change: ${reason}`)
      await this.waitForIdle(key, this.budgets.interruptGraceMs + 1_000)
    }
    const previousEpoch = entry.identity.kernelEpoch
    const lost = [...entry.knownBindings]
    let restarted = true
    let restartError: string | undefined
    try {
      await entry.transport.shutdown()
      entry.process = await entry.transport.start()
    } catch (error) {
      restarted = false
      restartError = error instanceof Error ? error.message : String(error)
    }
    // 3. NEW EPOCH. The old incarnation's variables must not carry into the new
    //    read domain, so the epoch advances and the namespace is gone.
    entry.identity = {
      ...entry.identity,
      executionWorld: next.executionWorld,
      environmentDigest: next.environmentDigest,
      kernelEpoch: previousEpoch + 1,
    }
    entry.knownBindings = new Set()
    entry.settledParents.clear()
    entry.state = restartError === undefined ? 'idle' : 'wedged'
    this.lostOnRestart.push({
      identity: entry.identity,
      previousEpoch,
      lost,
      at: new Date(this.now()).toISOString(),
      reason: `read-permission domain changed (${reason}); every variable read under the old domain is discarded `
        + 'rather than migrated, because the old values cannot be classified',
    })
    return {
      previousEpoch,
      kernelEpoch: entry.identity.kernelEpoch,
      lost,
      restarted,
      reason: restartError === undefined
        ? `kernel replaced and epoch advanced from ${String(previousEpoch)} to ${String(entry.identity.kernelEpoch)}`
        : `the kernel could not be replaced (${restartError}); it is not usable in the new domain`,
    }
  }

  /**
   * Reset a kernel: close admission, cancel and clean up, then a NEW epoch.
   *
   * Same order as a permission change, and the same reason for the epoch: a reset
   * that reused the epoch would let a stale callback from the old incarnation
   * write against the new one.
   */
  async reset(key: string, reason: string): Promise<{ previousEpoch: number; kernelEpoch: number; lost: readonly string[] }> {
    const entry = this.require(key)
    entry.state = 'wedged'
    if (entry.active !== undefined) {
      await this.cancelInternal(key, entry.active.cellId, `reset: ${reason}`)
      await this.waitForIdle(key, this.budgets.interruptGraceMs + 1_000)
    }
    const previousEpoch = entry.identity.kernelEpoch
    const lost = [...entry.knownBindings]
    await entry.transport.restart()
    entry.identity = { ...entry.identity, kernelEpoch: previousEpoch + 1 }
    entry.knownBindings = new Set()
    entry.settledParents.clear()
    entry.state = 'idle'
    this.lostOnRestart.push({
      identity: entry.identity,
      previousEpoch,
      lost,
      at: new Date(this.now()).toISOString(),
      reason: `explicit reset: ${reason}`,
    })
    return { previousEpoch, kernelEpoch: entry.identity.kernelEpoch, lost }
  }

  private async waitForIdle(key: string, timeoutMs: number): Promise<{ becameIdle: boolean; seconds: number }> {
    const startedAt = this.now()
    const entry = this.kernels.get(key)
    if (entry === undefined || entry.active === undefined) return { becameIdle: true, seconds: 0 }
    let timer: unknown
    let onIdle: () => void = () => {}
    const expired = new Promise<void>(resolve => { timer = this.setTimer(resolve, timeoutMs) })
    const idle = new Promise<void>(resolve => {
      onIdle = resolve
      entry.idleWaiters.push(resolve)
    })
    // Whichever happens first. The timeout exists so a cell that never settles
    // cannot block a reset forever; when it wins, the caller is told the wait
    // expired rather than being told the kernel is idle.
    await Promise.race([idle, expired])
    this.clearTimer(timer)
    entry.idleWaiters = entry.idleWaiters.filter(waiter => waiter !== onIdle)
    return { becameIdle: this.kernels.get(key)?.active === undefined, seconds: this.now() - startedAt }
  }

  // -------------------------------------------------------------------------
  // Quarantine and reconnection
  // -------------------------------------------------------------------------

  /** Cells whose outcome is not established. Each one holds its slot. */
  quarantinedCells(): readonly QuarantinedCell[] {
    return [...this.quarantined.values()]
  }

  /** Resolutions applied so far. */
  quarantineResolutions(): readonly QuarantineResolution[] {
    return this.resolutions
  }

  /**
   * Resolve a quarantined cell. This is the ONLY way a quarantine is cleared.
   *
   * It requires evidence, because the alternative -- clearing on a timer or on a
   * reconnect -- would let the system decide the world is fine because it stopped
   * looking.
   */
  resolveQuarantine(cellId: string, resolution: Omit<QuarantineResolution, 'cellId' | 'resolvedAt'>): QuarantineResolution {
    const existing = this.quarantined.get(cellId)
    if (existing === undefined) throw new Error(`cell "${cellId}" is not quarantined`)
    if (resolution.evidence.trim() === '') {
      throw new Error(`cell "${cellId}" cannot be resolved without evidence; an unsupported resolution is a guess`)
    }
    this.quarantined.delete(cellId)
    const applied: QuarantineResolution = { ...resolution, cellId, resolvedAt: new Date(this.now()).toISOString() }
    this.resolutions.push(applied)
    return applied
  }

  /**
   * A transport reconnected. Report what is ambiguous; re-execute NOTHING.
   *
   * REC-08 is the gate: an ambiguous call must not be replayed because a
   * connection came back. The world may have moved while the record did not, and
   * re-running a cell that already wrote a file or called an API duplicates an
   * effect that nothing can undo. So this returns the list of cells that need
   * reconciliation and an empty re-executed list, and the empty list is the
   * assertion -- not an omission.
   */
  onTransportReconnect(): {
    readonly ambiguousCells: readonly string[]
    readonly reexecuted: readonly string[]
    readonly note: string
  } {
    const ambiguous = [...this.quarantined.keys()]
    const record = {
      at: new Date(this.now()).toISOString(),
      ambiguousCells: ambiguous,
      reexecuted: [] as readonly string[],
      note: 'a reconnect is evidence that a connection exists, not that an ambiguous effect did not happen',
    }
    this.reconnects.push(record)
    return { ambiguousCells: ambiguous, reexecuted: [], note: record.note }
  }

  /** Reconnection events, for audit. */
  reconnectionLog(): readonly { at: string; ambiguousCells: readonly string[]; reexecuted: readonly string[]; note: string }[] {
    return this.reconnects
  }

  // -------------------------------------------------------------------------
  // Recovery
  // -------------------------------------------------------------------------

  /**
   * Build the recovery report for a kernel restart.
   *
   * WHAT THIS IS NOT: full session recovery. A restart replaces a volatile
   * process. The Session log, the artifacts and the business admission record are
   * separate objects with their own recovery, and no past cell is replayed. The
   * `scope` field says so in the data, and {@link RECOVERY_SCOPE_STATEMENT} is the
   * exact sentence.
   *
   * The report's six facts are kept separate because collapsing them is how a
   * partial restore gets reported as a success: the epoch says which incarnation
   * this is, the as-of says how stale the restored data is, `restored` and `lost`
   * are disjoint, `environmentChanged` says whether the data was even taken in a
   * comparable environment, and `unresolvedEffects` says the world may be ahead of
   * the record.
   */
  recoveryReport(
    key: string,
    input: {
      readonly checkpoint?: CheckpointDescriptor
      readonly validation?: CheckpointValidation
      readonly restored?: readonly string[]
      readonly lost?: readonly string[]
    },
  ): KernelRecoveryReport {
    const entry = this.require(key)
    const skipped: SkippedEntry[] = input.validation === undefined ? [] : [...input.validation.skipped]
    const environmentChanged = input.checkpoint !== undefined
      && input.checkpoint.environmentDigest !== entry.identity.environmentDigest
    if (environmentChanged) {
      // An environment mismatch is reported, and the data is still offered: a
      // numpy version difference is not the same as a different interpreter, and
      // M5 has no basis for deciding which differences are fatal. What it refuses
      // to do is hide the difference.
      skipped.push({
        name: '*',
        reason: `the checkpoint was taken in environment "${input.checkpoint?.environmentDigest ?? ''}" but this `
          + `kernel is in "${entry.identity.environmentDigest}"; values may differ in ways the format cannot express`,
      })
    }
    return {
      kernelEpoch: entry.identity.kernelEpoch,
      checkpointAsOf: input.checkpoint?.asOf,
      restored: [...(input.restored ?? [])],
      lost: [...(input.lost ?? [])],
      skipped,
      environmentChanged,
      unresolvedEffects: this.quarantinedCells(),
      scope: RECOVERY_SCOPE_STATEMENT,
    }
  }

  // -------------------------------------------------------------------------
  // Shutdown
  // -------------------------------------------------------------------------

  /** Shut down one kernel and forget its slot. */
  async close(key: string): Promise<void> {
    const entry = this.kernels.get(key)
    if (entry === undefined) return
    entry.state = 'closed'
    await entry.transport.shutdown()
    this.kernels.delete(key)
  }

  /** Shut down every kernel. Never throws for one kernel's failure alone. */
  async closeAll(): Promise<{ closed: number; errors: readonly string[] }> {
    const errors: string[] = []
    let closed = 0
    for (const key of [...this.kernels.keys()]) {
      try {
        await this.close(key)
        closed += 1
      } catch (error) {
        errors.push(`${key}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    return { closed, errors }
  }
}
