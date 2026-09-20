/**
 * The bounded per-Session runtime-notice queue for LATE kernel output.
 *
 * ===========================================================================
 * WHY THIS MODULE EXISTS (G-SEAM-78)
 * ===========================================================================
 *
 * IPY-13's CLASSIFICATION half was built and measured: `broker.py` injects an
 * attribution bootstrap, output written by a background thread is stamped with
 * its ORIGINATING cell (or with `DSH_BACKGROUND_ORIGIN` when no origin is
 * discoverable), and the router turns anything that is not the live cell's own
 * frame into a `late_output` event. That half is correct and is preserved
 * exactly as writer S5 left it.
 *
 * The DELIVERY half was not wired. `KernelService.drainUnattributed` had ZERO
 * production callers -- measured: the only reference in the whole repository was
 * a probe -- while the model-facing tool's own description promised that late
 * output "is reported separately as unattributed output". A promise the product
 * did not keep. This module is the queue that promise needs, and it is the ONLY
 * place late output is held.
 *
 * ===========================================================================
 * THE INVARIANT THIS FILE EXISTS TO KEEP
 * ===========================================================================
 *
 *   UNKNOWN ORIGIN IS NEVER ATTACHED TO A LATER CELL.
 *
 * Two things could break it, and both are structural here rather than checked:
 *
 *   1. a record with no discoverable origin could be attributed to whichever
 *      cell is running when it arrives. It is not: such a record is stamped
 *      `undecidable` and carries the sentinel cell id verbatim, so nothing can
 *      read it as "belonging to cell X".
 *   2. a record could be merged into the NEXT cell's stdout. It cannot be: this
 *      queue is drained by the `ipython` tool into a SEPARATE deferred context
 *      message, never into the text a cell result renders. There is no function
 *      in this module that returns cell output.
 *
 * ===========================================================================
 * WHY A QUEUE AND NOT A SECOND STORE
 * ===========================================================================
 *
 * V5 section 10 asks for "one bounded per-Session runtime-notice queue" and
 * explicitly forbids creating a new Session database. This is not a store: it is
 * an in-memory buffer that lives INSIDE the existing per-Session `Entry` in
 * `kernel-plugin.ts`, is created and destroyed with that Session's kernel, and
 * is keyed by the Session id that `Entry` already carries. There is no new
 * persistence, no new registry, and no new identity: a record's `sessionId` is
 * the Session the kernel belongs to, and nothing else can read the queue.
 *
 * WHAT IS DURABLE, AND ONLY WHAT SHOULD BE. A notice is a fact about output that
 * the model has not seen yet, so it must survive being held across cells -- but
 * not across a process. It deliberately does NOT survive a restart, because the
 * kernel namespace it describes does not either, and the record carries the
 * epoch so a reader can see exactly which generation produced it.
 *
 * ===========================================================================
 * VOCABULARY: MAPPED, NOT RE-INVENTED
 * ===========================================================================
 *
 * `kernel-lifecycle.ts` (dsh-daily-work) already carries a four-value
 * `OutputClass` -- `'cell' | 'late' | 'unattributed' | 'foreign'` -- which
 * classifies ONE FRAME at the transport. This module does not duplicate it and
 * does not import it (dsh-ipython must not depend on dsh-daily-work); it
 * classifies a RECORD at the delivery boundary, which is a different axis and a
 * different question:
 *
 *   OutputClass (per frame, at the transport)   ->  LateCausalClass (per record, at delivery)
 *   'late'         origin cell known            ->  'known-late'
 *   'unattributed' no discoverable origin       ->  'undecidable'
 *
 * The names differ on purpose, because collapsing them would let a reader think
 * a frame-level verdict had been made at a layer that never saw the frame.
 */
import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

/**
 * The causal class of one late-output record. V5 section 10's `known-late | undecidable`.
 *
 * `known-late` is a FACT about a KNOWN cell: the write carries the originating
 * cell's own id, so it can be attributed to a cell that has already closed.
 * `undecidable` is the absence of that fact -- a write with no discoverable cell
 * origin, which includes both a raw `_thread.start_new_thread` (stamped with the
 * sentinel) and a frame that carried no parent header at all. It is reported as
 * undecidable rather than guessed, because guessing is what attaches output to
 * code that never produced it.
 */
export type LateCausalClass = 'known-late' | 'undecidable'

/** The stream a late write arrived on, or `unknown` when the frame named none. */
export type LateStream = 'stdout' | 'stderr' | 'unknown'

/**
 * ONE late-output record, as V5 section 10 requires it.
 *
 * Every field is here because a reader needs it to decide what the text MEANS,
 * not to make the record look complete:
 *
 *   - `sessionId`  which Session's kernel produced it. Session-scoping is the
 *                  whole reason a notice cannot cross a conversation.
 *   - `kernelEpoch` the generation the write happened IN. An epoch that differs
 *                  from the Session's current one means a restart happened
 *                  between the write and its delivery.
 *   - `cellId`     the ORIGIN cell id when known, else the sentinel
 *                  (`DSH_BACKGROUND_ORIGIN`) or `''` for a frame with no parent.
 *                  Never rewritten to a live cell's id.
 *   - `causalClass` `known-late` or `undecidable`, derived from `cellId` by
 *                  {@link classifyOrigin} and never by a caller's guess.
 *   - `stream`     `stdout` / `stderr` / `unknown`.
 *   - `text`       the bounded text, present only when the record was KEPT.
 *   - `artifactRef` the spill file holding the text when it was NOT kept, so the
 *                  loss is recoverable rather than merely declared.
 *   - `observedAt` when the HOST observed the write, in epoch milliseconds. The
 *                  host's clock, explicitly, not the kernel's: the two are
 *                  different clocks and conflating them is how a duration
 *                  measurement becomes fiction.
 */
export interface LateNotice {
  readonly sessionId: string
  readonly kernelEpoch: number
  readonly cellId: string
  readonly causalClass: LateCausalClass
  readonly stream: LateStream
  /** Present when this record was kept in memory. Mutually exclusive with `artifactRef`. */
  readonly text?: string
  /** Present when this record's text went to the spill file instead of memory. */
  readonly artifactRef?: string
  readonly observedAt: number
  /** True when `text` is a PREFIX of what the kernel wrote. Never silently false. */
  readonly truncated?: boolean
  /** Bytes the kernel wrote for this record, counted even when the bytes were not kept. */
  readonly bytes: number
}

/** Default records held per Session. Past this the overflow spills, then counts and drops. */
export const DEFAULT_LATE_NOTICE_BOUND = 32
/** Default bytes of ONE record's text kept in memory before that record is truncated. */
export const DEFAULT_LATE_NOTICE_TEXT_BYTES = 4096
/** Default bytes of ALL kept records' text. A second bound, because 32 huge records is a flood too. */
export const DEFAULT_LATE_NOTICE_TOTAL_BYTES = 65536
/**
 * Default bytes the spill file may reach.
 *
 * THE THIRD BOUND, AND THE ONE THAT MAKES "BOUNDED" TRUE. Without it, a long
 * enough flood moves the unboundedness from memory to disk and calls it a fix.
 * Past this the bytes are COUNTED and DROPPED -- the same rule RES-02 enforces
 * for cell output ("past the budget the bytes are counted and dropped, never
 * buffered") -- and the drop count is reported in the notice text, so nothing
 * disappears silently.
 */
export const DEFAULT_LATE_NOTICE_SPILL_BYTES = 262144

/** The queue's bounds. Host policy; no model-facing path can widen one. */
export interface LateNoticeBounds {
  readonly records: number
  readonly textBytes: number
  readonly totalBytes: number
  readonly spillBytes: number
}

export const DEFAULT_LATE_NOTICE_BOUNDS: LateNoticeBounds = {
  records: DEFAULT_LATE_NOTICE_BOUND,
  textBytes: DEFAULT_LATE_NOTICE_TEXT_BYTES,
  totalBytes: DEFAULT_LATE_NOTICE_TOTAL_BYTES,
  spillBytes: DEFAULT_LATE_NOTICE_SPILL_BYTES,
}

/**
 * The causal class of one late write, from its origin id alone.
 *
 * THE ONE PLACE THE DECISION IS MADE, so it cannot be made twice and disagree.
 * A non-empty id that is not the sentinel is a cell id the router actually
 * issued; everything else -- the sentinel, or an empty id from a frame that
 * carried no parent header -- is `undecidable`. There is no third arm and no
 * caller-supplied override: an override is exactly the guess this classification
 * exists to refuse.
 */
export function classifyOrigin(cellId: string, backgroundOrigin: string): LateCausalClass {
  return cellId !== '' && cellId !== backgroundOrigin ? 'known-late' : 'undecidable'
}

/** Counts a reader can use to tell "nothing happened" from "everything was dropped". */
export interface LateNoticeAccount {
  /** Records currently held and not yet drained. */
  readonly held: number
  /** Bytes of held text. */
  readonly heldBytes: number
  /** Records whose text went to the spill file. */
  readonly spilled: number
  /** Records whose text could not be kept even by the spill, and were counted only. */
  readonly dropped: number
  /** Bytes written to the spill file so far. */
  readonly spillBytes: number
  /** The spill file's path, once one exists. */
  readonly spillPath?: string
}

/** One record as the queue is handed it: everything but the two derived fields. */
export interface LateNoticeInput {
  readonly kernelEpoch: number
  readonly cellId: string
  readonly stream: LateStream
  readonly text: string
}

/**
 * The bounded queue. ONE per Session, owned by the Session's kernel `Entry`.
 *
 * Not thread-safe and not intended to be: it is written from the kernel host's
 * message handler and read from the `ipython` tool body, both on the Node event
 * loop, and there is no await between a push and the index update.
 */
export class LateNoticeQueue {
  private readonly records: LateNotice[] = []
  private heldBytes = 0
  private spilled = 0
  private dropped = 0
  private spillBytes = 0
  private spillPath: string | undefined
  private readonly sessionId: string
  private readonly backgroundOrigin: string
  private readonly bounds: LateNoticeBounds
  private readonly spillDirectory: string

  constructor(options: {
    readonly sessionId: string
    /** The sentinel `protocol.ts` defines, passed in rather than re-declared. */
    readonly backgroundOrigin: string
    /** Where the spill file goes: the kernel epoch's own artifact directory. */
    readonly spillDirectory: string
    readonly bounds?: LateNoticeBounds
  }) {
    this.sessionId = options.sessionId
    this.backgroundOrigin = options.backgroundOrigin
    this.spillDirectory = options.spillDirectory
    this.bounds = options.bounds ?? DEFAULT_LATE_NOTICE_BOUNDS
  }

  /** Hold one record, spilling or dropping it when a bound is crossed. */
  push(input: LateNoticeInput): void {
    const bytes = Buffer.byteLength(input.text, 'utf8')
    const causalClass = classifyOrigin(input.cellId, this.backgroundOrigin)
    const base = {
      sessionId: this.sessionId,
      kernelEpoch: input.kernelEpoch,
      cellId: input.cellId,
      causalClass,
      stream: input.stream,
      observedAt: Date.now(),
      bytes,
    } as const

    // BOUND 1 and BOUND 2: record count, and total held text. A record that
    // cannot be held goes to the spill with its text; it is not simply lost.
    const roomForRecord = this.records.length < this.bounds.records
    const roomForBytes = this.heldBytes + bytes <= this.bounds.totalBytes
    if (!roomForRecord || !roomForBytes) {
      this.spill(base, input.text)
      return
    }

    // BOUND 3: one record's own text. A very long single record is truncated
    // here rather than being allowed to consume the whole total budget; the
    // remainder is spilled so the cut point is recoverable.
    if (bytes > this.bounds.textBytes) {
      const cut = utf8SafeCut(Buffer.from(input.text, 'utf8'), this.bounds.textBytes)
      const kept = cut > 0 ? input.text.slice(0, cut) : ''
      const keptBytes = Buffer.byteLength(kept, 'utf8')
      this.records.push({ ...base, text: kept, truncated: true, bytes })
      this.heldBytes += keptBytes
      this.spill(base, input.text.slice(cut), true)
      return
    }

    this.records.push({ ...base, text: input.text })
    this.heldBytes += bytes
  }

  /**
   * Take every held record and leave the queue empty.
   *
   * DRAIN IS THE DELIVERY: the caller that drains is the caller that hands the
   * records to the model-visible boundary, so a second caller cannot read the
   * same notice twice. The spill account is NOT reset -- it is a record of what
   * happened, and a reader that drained the visible notices still needs to know
   * how many were not visible.
   */
  drain(): LateNotice[] {
    const drained = this.records.splice(0, this.records.length)
    this.heldBytes = 0
    return drained
  }

  /** The counts, without draining. */
  account(): LateNoticeAccount {
    return {
      held: this.records.length,
      heldBytes: this.heldBytes,
      spilled: this.spilled,
      dropped: this.dropped,
      spillBytes: this.spillBytes,
      ...this.spillPath === undefined ? {} : { spillPath: this.spillPath },
    }
  }

  /**
   * Write one record's text to the spill file, or count it when the spill is
   * itself full.
   *
   * `counted` distinguishes the two calls: a record spilled because it did not
   * fit in MEMORY has been counted as a spill already, while a record whose
   * remainder is spilled after a truncation has not.
   */
  private spill(base: Omit<LateNotice, 'text' | 'artifactRef'>, text: string, alreadyCounted = false): void {
    if (text === '') {
      if (!alreadyCounted) this.dropped += 1
      return
    }
    const line = `${JSON.stringify({ ...base, text })}\n`
    const lineBytes = Buffer.byteLength(line, 'utf8')
    if (this.spillBytes + lineBytes > this.bounds.spillBytes) {
      // COUNTED AND DROPPED, never buffered. The count is what the notice text
      // reports, so a reader learns that bytes were lost rather than reading a
      // prefix as the whole.
      this.dropped += 1
      return
    }
    try {
      if (this.spillPath === undefined) {
        mkdirSync(this.spillDirectory, { recursive: true })
        this.spillPath = join(this.spillDirectory, 'late-notice-spill.ndjson')
      }
      appendFileSync(this.spillPath, line, 'utf8')
      this.spillBytes += lineBytes
      if (!alreadyCounted) this.spilled += 1
    } catch {
      // A spill that cannot be written is a LOSS, and it is counted as one. It
      // is not promoted to an error the cell sees: a notice is about output the
      // model already failed to receive, and turning that into a cell failure
      // would report a delivery problem as an execution problem.
      this.dropped += 1
    }
  }
}

/**
 * The largest prefix of `buffer` that ends on a UTF-8 character boundary.
 *
 * A cut through a multi-byte sequence would put a replacement character into the
 * kept prefix, and the kept bytes must be a PREFIX of what the kernel wrote --
 * a claim a replacement character falsifies. Same rule, same reason as
 * `OutputAccumulator.keepStream` in `kernel-lifecycle.ts`.
 */
function utf8SafeCut(buffer: Buffer, limit: number): number {
  if (buffer.length <= limit) return buffer.length
  let cut = limit
  while (cut > 0 && (buffer[cut] ?? 0) >= 0x80 && (buffer[cut] ?? 0) < 0xc0) cut -= 1
  return cut
}
