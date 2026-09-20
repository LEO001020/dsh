/**
 * The cell-bound `dsh.data` request plane.
 *
 * WHAT THIS IS, AND THE ONE DESIGN DECISION THAT MATTERS MOST.
 *
 * `dsh.data` requests are BOUND to a live cell (they carry the caller's
 * Agent/Session for attribution and cancellation) but they are NOT generic
 * ToolRuntime dispatches. They go DIRECTLY through public DSH capability seams:
 * `ctx.fs`, `ctx.sessionQuery`, `ctx.web`, `ctx.attachments`, and this package's
 * own artifact store.
 *
 * WHY NOT `ctx.tools.execute`. The audit corrected this exact error, so it is
 * recorded here rather than left implicit. `ctx.tools.execute()` runs ONE
 * complete ToolRuntime call through pre-policy -> guards -> body -> post-policy
 * -> result observers, and Native AgentLoop/PTC coordinate their ORDERED
 * pre/post stages through a scheduler that is a module-local `Symbol()`
 * (`TOOL_RUNTIME_SCHEDULER`) and NOT a public downstream seam. Issuing several
 * `ctx.tools.execute()` calls concurrently therefore gets NO scheduling parity --
 * it just runs several independent pipelines whose ordered stages can interleave.
 * Bulk-data throughput must not be solved with generic tool-call concurrency:
 * the correct primitive is capability-level read concurrency against one
 * provider, which is what {@link DataReadLimiter} provides.
 *
 * WHAT IS SHARED WITH THE `dsh.call` SIDE, AND WHAT IS NOT.
 *
 *   shared:     the caller's identity comes from the HOST's binding to the live
 *               cell, never from the request. A Python program cannot name an
 *               Agent or a Session.
 *   different:  `dsh.call` (writer R5's side) reproduces EXACT ToolRuntime
 *               semantics and is SERIAL. `dsh.data.*` is a bounded-concurrency
 *               read plane that never enters the tool pipeline.
 *
 * AUTHORITY IS HOST-OWNED. {@link DataCaller} is constructed by the host from the
 * live cell lease. There is no code path in this file that reads an Agent,
 * Session, workspace or scope out of a request payload, and
 * {@link refuseForgedClaims} refuses a payload that tries to assert one.
 *
 * ACQUISITION IS NOT PROJECTION. Capturing 32 MiB and showing the model 400 bytes
 * is the plane WORKING. The projection is recorded as a
 * {@link ProjectionManifest} (its own fact) and never as an acquisition gap.
 */
import { createHash } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { FileSystem, FsTarget } from '@deepseek-ai/dsh-fs'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { WebFetchResult, WebSearchResult } from '@deepseek-ai/dsh-web'
import {
  DEFAULT_PAGE_BYTES,
  captureFile,
  projectForModel,
  readArtifactRange,
  walkPages,
  ArtifactStorePageProvider,
  type ArtifactPage,
  type ArtifactStore,
  type CaptureOutcome,
  type IoCounters,
} from './artifacts.ts'
import { DataReadLimiter, DEFAULT_DATA_READ_CONCURRENCY } from './data-concurrency.ts'
import { HistoryAccessError, authorizeHistoryRead, type HistoryCaller, type HistoryCorpusView } from './history-plane.ts'
import type { GrantTable, ObservationDescriptor } from './observations.ts'
import {
  buildProjectionManifest,
  type ProjectionManifest,
  type ProjectionMode,
  type ProjectionSourceRef,
} from './projection-manifest.ts'
import {
  provenanceFromFetch,
  searchProvenance,
  type ProvenanceGap,
  type ProvenanceRecord,
  type SearchProvenance,
} from './web-provenance.ts'

// ===========================================================================
// The caller, and the refusal vocabulary
// ===========================================================================

/**
 * Who a `dsh.data` request runs as.
 *
 * Every field is read from the LIVE cell by the host. `sessionId` is the
 * caller's own session; `cwd` is the caller's workspace, which is the
 * authorization key history reads use (matching DSH's own session-query tools).
 * `signal` is the cell's cancellation, so a revoked cell stops its reads.
 *
 * There is deliberately no `agent` field a request could set: the identity here
 * is the enclosing execution's, and a Python program cannot widen it.
 */
export interface DataCaller {
  readonly sessionId: SessionId
  /** The caller's workspace. `undefined` means "own session only", never "all". */
  readonly cwd?: string
  /** Cell-scoped cancellation. An aborted signal refuses new reads. */
  readonly signal?: AbortSignal
  /**
   * A label for the enclosing call, for attribution in records.
   *
   * Recorded on the descriptor's `executionWorld`-adjacent metadata rather than
   * used for any decision, so a forged value changes a log line and nothing else.
   */
  readonly callLabel?: string
}

/** Why a `dsh.data` request was refused. Codes are stable so a caller can branch. */
export type DataPlaneErrorCode =
  | 'DATA_NO_CAPABILITY'
  | 'DATA_INVALID_REQUEST'
  | 'DATA_CALLER_ABORTED'
  | 'DATA_BUDGET_EXCEEDED'
  | 'DATA_PROVIDER_UNAVAILABLE'
  | 'DATA_ARTIFACT_INVALID'

export class DataPlaneError extends Error {
  readonly code: DataPlaneErrorCode

  constructor(code: DataPlaneErrorCode, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'DataPlaneError'
    this.code = code
  }
}

// ===========================================================================
// K1: filesystem
// ===========================================================================

/**
 * The FS identity basis recorded for a capture.
 *
 * V3 §K1 requires "record FsTarget identity/version/stat basis". The three are
 * recorded SEPARATELY because they answer different questions:
 *
 *   `targetKey`  the backend's stable identity for the resolved target. Two
 *                different paths that resolve to one file share it; the same path
 *                across a symlink change does not.
 *   `version`    the freshness token at capture time. A later write changes it,
 *                so this is what makes "the file I captured is the file you see
 *                now" a checkable statement rather than an assumption.
 *   `stat`       type and size, so a reader can see whether the capture was
 *                whole-file or a named range without re-deriving it.
 *
 * `displayPath` is recorded too, but it is DISPLAY ONLY: it is what a UI shows,
 * and it is deliberately not the identity, because two backends can use the same
 * display path for different objects.
 */
export interface FsCaptureIdentity {
  readonly displayPath: string
  /** Opaque backend key. Never parsed, never used as a path. */
  readonly targetKey: string
  /** Opaque freshness token at capture time. */
  readonly version: string
  readonly stat: { readonly type: string; readonly size?: number }
}

/** What one `dsh.data.fs.capture` produced. */
export interface FsCaptureResult {
  readonly observationId: string
  readonly descriptor: ObservationDescriptor
  readonly identity: FsCaptureIdentity
  readonly reference: CaptureOutcome['reference']
  readonly gaps: CaptureOutcome['gaps']
  readonly io: IoCounters
  /**
   * The four byte-counts, kept apart (the plane's central invariant).
   *
   * `acquiredBytes` is what the SOURCE read cost; `persistedBytes` is what the
   * store holds. They are equal for a complete capture and differ for a short
   * one, and the difference is the whole reason both are reported.
   */
  readonly accounting: {
    readonly acquiredBytes: number
    readonly persistedBytes: number
  }
}

/** The page handle a capture returns. One lease, many bounded pages. */
export interface PageHandle {
  readonly observationId: string
  readonly artifact: string
  readonly sha256: string
  readonly artifactBytes: number
  readonly pageBytes: number
  /** Walk to exhaustion (or a page budget), returning the accounting. */
  walk(options?: { readonly maxPages?: number; readonly onPage?: (page: ArtifactPage, index: number) => boolean | void }): Promise<{
    readonly pages: number
    readonly bytes: number
    readonly exhausted: boolean
    readonly io: IoCounters
  }>
  /** Read exactly one page at a cursor. */
  next(cursor?: string): Promise<ArtifactPage>
}

// ===========================================================================
// K2: history
// ===========================================================================

/** One programmatic history hit. */
export interface HistorySearchHit {
  readonly seq: number
  readonly surface: string
  /** Bounded excerpt around the match. */
  readonly excerpt: string
  readonly digest: string
}

/** One page of a programmatic history search, pinned to one observation. */
export interface HistorySearchPage {
  readonly hits: readonly HistorySearchHit[]
  /** Continuation, absent when the pinned cut is exhausted. */
  readonly cursor?: string
  readonly exhausted: boolean
  /**
   * The identity the cursor is bound to.
   *
   * V3 §K2 requires the cursor to bind the session, the observation watermark,
   * the persistence revision when present, the query/filter representation and
   * the position. All five are here, and {@link HistorySearchPage.cursor}
   * carries them so a cursor replayed against a different cut is REFUSED rather
   * than silently re-based.
   */
  readonly watermark: HistoryCutIdentity
  /** How many times this operation materialized the full log. Must be 1. */
  readonly fullLogMaterializations: number
}

/** The exact cut a history cursor is bound to. */
export interface HistoryCutIdentity {
  readonly sessionId: string
  /** Highest seq included in the pinned observation. */
  readonly maxSeq: number
  /** The pinned scan's generation, so a superseding scan invalidates old cursors. */
  readonly generation: number
  /** Durable persistence revision, when the observation exposed one. */
  readonly persistenceRevision?: string
  /** Canonical form of the query + filters, so a different query cannot reuse a cursor. */
  readonly queryRepresentation: string
}

// ===========================================================================
// K3: web
// ===========================================================================

/** What one `dsh.data.web.fetch` produced. */
export interface WebFetchOutcome {
  readonly record: ProvenanceRecord
  readonly gaps: readonly ProvenanceGap[]
  /** The provider id the seam actually selected, so mis-selection is visible. */
  readonly provider: string
  /**
   * What the body was, WITHOUT the body.
   *
   * The `WebFetchResult` is deliberately NOT returned. A fetched page is bulk
   * data, and returning the result object would put the whole body into the frame
   * this plane exists to keep empty -- measured before this field replaced it: a
   * 1000-character stub body appeared verbatim in the serialized outcome. The
   * acquisition record already carries the digest, the byte count and the coverage
   * claim, so a caller that wants the bytes captures them into the artifact store
   * rather than receiving them inline.
   */
  readonly body: {
    readonly kind: 'html' | 'text'
    readonly bytes: number
    readonly chars: number
    readonly sha256: string
  }
}

/** What one `dsh.data.web.search` produced. */
export interface WebSearchOutcome {
  /**
   * The provenance record, which ALREADY carries the sources.
   *
   * The raw `WebSearchResult` is deliberately not returned as well: it would be a
   * second, duplicate copy of the same list, and two representations of one result
   * set are how a consumer ends up citing one and recording the other. The sources
   * are bounded by `maxResults` at the seam, so this is a bounded value.
   */
  readonly provenance: SearchProvenance
  readonly provider: string
}

// ===========================================================================
// The plane
// ===========================================================================

/** Config for the plane. Every bound is host-owned. */
export interface DataPlaneConfig {
  /** Concurrent host-side reads. Conservative default; benchmark before raising. */
  readonly readConcurrency?: number
  /** Default page size for a walk. */
  readonly pageBytes?: number
  /** Page budget for a single walk when the caller names none. */
  readonly maxWalkPages?: number
  /** Maximum excerpt characters per history hit. */
  readonly maxExcerptChars?: number
  /** Maximum hits per history page. */
  readonly maxHistoryHits?: number
}

const DEFAULT_MAX_WALK_PAGES = 4096
const DEFAULT_MAX_EXCERPT_CHARS = 512
const DEFAULT_MAX_HISTORY_HITS = 200

/**
 * The narrow port the plane needs from the host service.
 *
 * WHY A STRUCTURAL PORT AND NOT AN IMPORT OF `DataPlaneService`.
 *
 * `data-service.ts` constructs the plane, so a value import back into it would be
 * a module cycle. A TYPE-ONLY import would compile, but it would also make the
 * plane depend on the whole service surface -- including everything the plane
 * must never touch. This port names exactly the six members the plane uses, so a
 * reader can see the plane's entire authority in one place, and a test can supply
 * a stand-in without mounting a storage domain.
 *
 * `DataPlaneService` satisfies it structurally; nothing needs to declare that.
 */
export interface DataPlaneBackend {
  /** The artifact store, for paging and range reads. */
  readonly store: ArtifactStore  /** The live grant table. Every descriptor is re-validated against it. */
  readonly grants: GrantTable
  /** The scope every capture and cursor is bound to. */
  readonly ownerScope: string
  /** Capture a file through the caller's FS backend, in the reconcilable order. */
  capture(input: {
    fs: FileSystem
    path: string
    mediaType?: string
    observationId?: string
    requestedRange?: { offset: number; length?: number }
    claim?: unknown
    signal?: AbortSignal
  }): Promise<CaptureOutcome>
  /** Read one bounded page of an immutable artifact. */
  page(input: {
    descriptor: unknown
    cursor?: string
    maxBytes?: number
    counters?: IoCounters
  }): Promise<ArtifactPage>
  /** Validate a stored descriptor against the LIVE grant. */
  parseObservation(value: unknown): ObservationDescriptor
}

/**
 * The bounded read plane for one host deployment.
 *
 * One instance per `DataPlaneService`, shared by every cell, because the
 * limiter's whole job is to bound the TOTAL concurrent reads a deployment issues
 * against one provider. A per-cell limiter would multiply by the number of live
 * cells, which is the unbounded fan-out it exists to prevent.
 */
export class DataPlane {
  readonly #ctx: Context
  readonly #service: DataPlaneBackend
  readonly #limiter: DataReadLimiter
  readonly #pageBytes: number
  readonly #maxWalkPages: number
  readonly #maxExcerptChars: number
  readonly #maxHistoryHits: number
  /** Open scans, keyed by scan identity, each pinning ONE observation. */
  readonly #scans = new Map<string, PinnedScan>()

  constructor(ctx: Context, service: DataPlaneBackend, config: DataPlaneConfig = {}) {
    this.#ctx = ctx
    this.#service = service
    this.#limiter = new DataReadLimiter(config.readConcurrency ?? DEFAULT_DATA_READ_CONCURRENCY)
    this.#pageBytes = config.pageBytes ?? DEFAULT_PAGE_BYTES
    this.#maxWalkPages = config.maxWalkPages ?? DEFAULT_MAX_WALK_PAGES
    this.#maxExcerptChars = config.maxExcerptChars ?? DEFAULT_MAX_EXCERPT_CHARS
    this.#maxHistoryHits = config.maxHistoryHits ?? DEFAULT_MAX_HISTORY_HITS
  }

  /** The limiter's state, so the configured bound is observable rather than asserted. */
  concurrencyReport(): ReturnType<DataReadLimiter['report']> {
    return this.#limiter.report()
  }

  // -------------------------------------------------------------------------
  // Capability resolution
  // -------------------------------------------------------------------------

  /**
   * Resolve `ctx.fs`.
   *
   * `ctx.get` rather than property access: a service the fiber did not declare in
   * its `inject` THROWS on property access (`vendor/cordis/src/reflect.ts`), and
   * this plane deliberately does not hard-inject `fs` because a deployment may
   * mount the data plane before the FS backend. A missing capability is a named
   * refusal, never an empty result.
   */
  #fs(): FileSystem {
    const service = this.#ctx.get('fs')
    if (service === undefined) {
      throw new DataPlaneError(
        'DATA_NO_CAPABILITY',
        'dsh.data.fs: no ctx.fs service is mounted. This is a DEPLOYMENT fact (the fs plugin is not loaded), '
        + 'not an absence of files.',
      )
    }
    return service
  }

  #web(): NonNullable<ReturnType<Context['get']>> {
    const service = this.#ctx.get('web')
    if (service === undefined) {
      throw new DataPlaneError(
        'DATA_NO_CAPABILITY',
        'dsh.data.web: no ctx.web service is mounted. This is a DEPLOYMENT fact (the web plugin is not loaded), '
        + 'not an empty web.',
      )
    }
    return service
  }

  #attachments(): NonNullable<ReturnType<Context['get']>> {
    const service = this.#ctx.get('attachments')
    if (service === undefined) {
      throw new DataPlaneError(
        'DATA_NO_CAPABILITY',
        'dsh.data.artifacts: no ctx.attachments service is mounted. This is a DEPLOYMENT fact, '
        + 'not an absence of stored files.',
      )
    }
    return service
  }

  /** Refuse before doing work when the cell has been revoked. */
  #assertLive(caller: DataCaller): void {
    if (caller.signal?.aborted === true) {
      throw new DataPlaneError(
        'DATA_CALLER_ABORTED',
        'the enclosing cell was cancelled, so this read is refused rather than run with no owner',
      )
    }
  }

  // -------------------------------------------------------------------------
  // K1: fs.capture
  // -------------------------------------------------------------------------

  /**
   * Capture a file through `ctx.fs` into the artifact store.
   *
   * The read goes THROUGH the FS service, so the backend's own authority applies
   * and no host path bypass exists. The model-facing `read` tool is deliberately
   * NOT the primitive: its windowing is bounded on purpose, so a capture built on
   * it would silently produce a shorter object that still claimed completeness.
   *
   * `requestedRange` narrows the SCOPE. It does not make the capture a page: the
   * object published is exactly the requested bytes, and the coverage claim is
   * scoped to that request so a partial read cannot be read as a whole file.
   */
  async fsCapture(caller: DataCaller, input: {
    readonly path: string
    readonly mediaType?: string
    readonly observationId?: string
    readonly requestedRange?: { readonly offset: number; readonly length?: number }
    /** A kernel payload. A forged host fact is REFUSED, not merged. */
    readonly claim?: unknown
  }): Promise<FsCaptureResult> {
    this.#assertLive(caller)
    const fs = this.#fs()

    // Read the identity basis BEFORE the capture, so the recorded version is the
    // one the capture started from. Reading it after would record the version the
    // capture PRODUCED, which is a different fact and would make a concurrent
    // writer invisible.
    const target: FsTarget = await fs.resolve(input.path, {
      ...caller.cwd === undefined ? {} : { cwd: caller.cwd },
      ...caller.signal === undefined ? {} : { signal: caller.signal },
    })
    const info = await fs.stat(target, caller.signal)
    if (info === undefined) {
      throw new DataPlaneError(
        'DATA_ARTIFACT_INVALID',
        `dsh.data.fs.capture: no such target "${input.path}"`,
      )
    }
    if (info.type !== 'file') {
      throw new DataPlaneError(
        'DATA_ARTIFACT_INVALID',
        `dsh.data.fs.capture: "${input.path}" is a ${info.type}, not a regular file`,
      )
    }

    const outcome = await this.#limiter.run(async () => await this.#service.capture({
      fs,
      path: input.path,
      ...input.mediaType === undefined ? {} : { mediaType: input.mediaType },
      ...input.observationId === undefined ? {} : { observationId: input.observationId },
      ...input.requestedRange === undefined ? {} : { requestedRange: input.requestedRange },
      ...input.claim === undefined ? {} : { claim: input.claim },
      // A RANGE REQUEST BOUNDS THE READ, not just the coverage annotation.
      //
      // MEASURED, and it corrects an over-claim this file made first: without this
      // override, `requestedRange` only recorded what the caller ASKED for while
      // the store still published the WHOLE file. A request for `{offset:1024,
      // length:512}` of a 4096-byte file produced a 4096-byte artifact -- so the
      // published object was not the requested scope, and a caller reading it back
      // would receive bytes outside the range it named.
      //
      // The override reads exactly the requested window through the same
      // `readByteRange` primitive the default uses, so the object published IS the
      // requested bytes and the coverage claim is true of it.
      ...input.requestedRange === undefined ? {} : {
        readChunks: async function* ranged(
          backend: FileSystem,
          rangedTarget: FsTarget,
          signal?: AbortSignal,
        ): AsyncIterable<Uint8Array> {
          const range = input.requestedRange as { offset: number; length?: number }
          const start = range.offset
          // An open-ended range runs to the file's end. `stat` was already read
          // above, so the end is known rather than discovered by reading past it.
          const end = range.length === undefined
            ? (info.size ?? Number.MAX_SAFE_INTEGER)
            : start + range.length
          let offset = start
          while (offset < end) {
            const length = Math.min(DEFAULT_PAGE_BYTES, end - offset)
            const window = await backend.readByteRange(rangedTarget, { offset, length }, signal)
            if (window.byteLength === 0) break
            offset += window.byteLength
            yield window
          }
        },
      },
      ...caller.signal === undefined ? {} : { signal: caller.signal },
    }))

    return {
      observationId: outcome.descriptor.id,
      descriptor: outcome.descriptor,
      identity: {
        displayPath: target.displayPath,
        targetKey: String(target.targetKey),
        version: String(info.version),
        stat: { type: info.type, ...info.size === undefined ? {} : { size: info.size } },
      },
      reference: outcome.reference,
      gaps: outcome.gaps,
      io: outcome.io,
      accounting: {
        acquiredBytes: outcome.io.sourceBytesRead,
        persistedBytes: outcome.descriptor.captured.bytes,
      },
    }
  }

  /**
   * Open a bounded paging handle over a captured observation.
   *
   * The handle reads the IMMUTABLE ARTIFACT, never the live source, so a writer
   * changing the file between page 1 and page 2 cannot mix two revisions into one
   * stream. Every page is a `readByteRange`-shaped window of a fixed object whose
   * address IS its content hash.
   */
  openPages(caller: DataCaller, input: {
    readonly descriptor: unknown
    readonly pageBytes?: number
  }): PageHandle {
    this.#assertLive(caller)
    const descriptor = this.#service.parseObservation(input.descriptor)
    const pageBytes = input.pageBytes ?? this.#pageBytes
    if (!Number.isInteger(pageBytes) || pageBytes < 1) {
      throw new DataPlaneError(
        'DATA_INVALID_REQUEST',
        `dsh.data.fs.pages: max_bytes must be a positive integer, got ${String(pageBytes)}`,
      )
    }
    const service = this.#service
    const limiter = this.#limiter
    const maxWalkPages = this.#maxWalkPages
    return {
      observationId: descriptor.id,
      artifact: descriptor.captured.artifact,
      sha256: descriptor.captured.sha256,
      artifactBytes: descriptor.captured.bytes,
      pageBytes,
      async walk(options = {}) {
        const io: IoCounters = { artifactBytesRead: 0, sourceBytesRead: 0, indexBytesRead: 0, artifactReads: 0 }
        const budget = options.maxPages ?? maxWalkPages
        // EACH PAGE IS ONE ADMITTED READ. Admitting the whole walk as one slot
        // would let one caller's 512-page traversal hold a slot for its entire
        // duration, which is the starvation the limiter exists to prevent.
        let pageIndex = 0
        const result = await limiter.run(async () => await walkPages(
          new ArtifactStorePageProvider(service.store),
          { descriptor, maxBytes: pageBytes, grants: service.grants, callerScope: service.ownerScope },
          {
            maxPages: budget,
            counters: io,
            onPage: (page, index) => {
              pageIndex = index
              return options.onPage?.(page, index)
            },
          },
        ))
        void pageIndex
        return { pages: result.pages, bytes: result.bytes, exhausted: result.exhausted, io }
      },
      async next(cursor) {
        return await limiter.run(async () => await service.page({
          descriptor,
          ...cursor === undefined ? {} : { cursor },
          maxBytes: pageBytes,
        }))
      },
    }
  }

  /** Read one byte range of a captured artifact, through the limiter. */
  async readRange(caller: DataCaller, input: {
    readonly descriptor: unknown
    readonly offset: number
    readonly length: number
  }): Promise<Uint8Array> {
    this.#assertLive(caller)
    const descriptor = this.#service.parseObservation(input.descriptor)
    if (!Number.isInteger(input.offset) || input.offset < 0
      || !Number.isInteger(input.length) || input.length < 0) {
      throw new DataPlaneError(
        'DATA_INVALID_REQUEST',
        'dsh.data.fs.read_range: offset and length must be non-negative integers',
      )
    }
    return await this.#limiter.run(async () =>
      await readArtifactRange(this.#service.store, descriptor, { offset: input.offset, length: input.length }))
  }

  // -------------------------------------------------------------------------
  // K4: attachments (durable verbatim bytes)
  // -------------------------------------------------------------------------

  /**
   * Store a captured artifact's exact bytes in DSH's public attachment store.
   *
   * WHY BOTH STORES. The project artifact store is the project's own domain and
   * carries the reference log, the cursor authority and the quota. DSH's
   * attachment store is the durable verbatim medium a Session event can reference.
   * A capture intended to be cited by a Session message needs the second one, and
   * this method is the ONLY path that writes there -- so the bytes are the same
   * bytes, streamed from the immutable artifact rather than re-read from the live
   * source.
   */
  async saveAttachment(caller: DataCaller, input: {
    readonly descriptor: unknown
    readonly name?: string
  }): Promise<{ readonly attachmentId: string; readonly name: string; readonly bytes: number; readonly sha256: string }> {
    this.#assertLive(caller)
    const descriptor = this.#service.parseObservation(input.descriptor)
    const attachments = this.#attachments()
    const store = this.#service.store
    const pageBytes = this.#pageBytes
    const limiter = this.#limiter

    // Stream the ARTIFACT in bounded windows. The attachment seam requires that
    // the provider not retain the complete sequence in memory, so the source
    // iterable is a generator over byte ranges rather than one big buffer.
    async function* chunks(): AsyncIterable<Uint8Array> {
      const total = descriptor.captured.bytes
      for (let offset = 0; offset < total; offset += pageBytes) {
        const length = Math.min(pageBytes, total - offset)
        yield await limiter.run(async () =>
          await readArtifactRange(store, descriptor, { offset, length }))
      }
    }

    const ref = await limiter.run(async () => await attachments.saveFileStream({
      data: chunks(),
      ...input.name === undefined ? {} : { name: input.name },
      ...caller.signal === undefined ? {} : { signal: caller.signal },
    }))
    // The attachment store is content-addressed, so comparing its id against the
    // artifact's own digest is a real integrity check across two independent stores
    // rather than a restatement of one.
    //
    // THE ID IS `sha256:<digest>`, NOT A BARE DIGEST. Verified at the pin:
    // `attachment-local/src/file-store.ts:97,125` build it as
    // `` AttachmentId(`sha256:${sha256}`) ``. Comparing the raw id against a bare
    // digest would fail for EVERY successful save, and a check that refuses correct
    // data is worse than no check -- so the expected form is constructed here.
    const returned = String(ref.attachmentId)
    const expected = `sha256:${descriptor.captured.sha256}`
    if (returned !== expected) {
      throw new DataPlaneError(
        'DATA_ARTIFACT_INVALID',
        `dsh.data.artifacts.save: the attachment store returned "${returned}" for bytes the observation `
        + `declares as ${descriptor.captured.sha256}; the two stores disagree about the content`,
      )
    }
    return {
      attachmentId: returned,
      name: ref.name,
      bytes: ref.bytes,
      sha256: descriptor.captured.sha256,
    }
  }

  /**
   * Read a verbatim stored attachment back, verifying its digest.
   *
   * A missing or corrupt object FAILS LOUD. `readFileStream` rejects the
   * iteration on an integrity failure, and this method adds the digest check
   * against the recorded reference so a caller cannot receive a short object as
   * if it were the stored one.
   */
  async readAttachment(caller: DataCaller, input: {
    readonly attachmentId: string
    readonly name: string
    readonly bytes: number
  }): Promise<{ readonly bytes: Uint8Array; readonly sha256: string }> {
    this.#assertLive(caller)
    const attachments = this.#attachments()
    const ref = {
      attachmentId: input.attachmentId as never,
      name: input.name,
      bytes: input.bytes,
    }
    const hash = createHash('sha256')
    const collected: Uint8Array[] = []
    let total = 0
    for await (const chunk of attachments.readFileStream(ref, caller.signal)) {
      hash.update(chunk)
      collected.push(chunk)
      total += chunk.byteLength
    }
    const actual = hash.digest('hex')
    // The reference id is `sha256:<digest>`; the digest computed over the bytes is
    // bare. Both are normalized to the bare digest for the comparison, so the check
    // is about CONTENT rather than about the id's spelling.
    const expectedDigest = input.attachmentId.replace(/^sha256:/u, '')
    if (actual !== expectedDigest || total !== input.bytes) {
      throw new DataPlaneError(
        'DATA_ARTIFACT_INVALID',
        `dsh.data.artifacts.open: the stored file is ${String(total)} bytes hashing to ${actual}, but the `
        + `reference names ${String(input.bytes)} bytes hashing to ${expectedDigest}; refusing to serve it`,
      )
    }
    const bytes = new Uint8Array(total)
    let offset = 0
    for (const chunk of collected) {
      bytes.set(chunk, offset)
      offset += chunk.byteLength
    }
    return { bytes, sha256: actual }
  }

  // -------------------------------------------------------------------------
  // K2: history
  // -------------------------------------------------------------------------

  /**
   * Search the caller's authorized history against ONE pinned observation.
   *
   * WHY PINNED. `ctx.sessionQuery.readEvent` goes through `SessionCorpus.load`,
   * which for a persisted session opens the storage handle and reads the COMPLETE
   * log on every call. A search that re-read the log per page would therefore be
   * O(pages x log), which is exactly the quadratic shape V3 §K7 requires be
   * measured against. So the FIRST call takes one observation lease and every
   * subsequent page filters the SAME immutable cut in memory.
   *
   * The cut is immutable, so events appended after `open` are outside this scan --
   * the only way to see them is a second scan. That is the honest behaviour: a
   * paging operation over a growing log that silently included new events would
   * produce a result set no single instant ever contained.
   */
  async historySearch(caller: DataCaller, input: {
    readonly sessionId?: string
    readonly query: string
    readonly cursor?: string
    readonly maxHits?: number
    readonly surfaces?: readonly string[]
  }): Promise<HistorySearchPage> {
    this.#assertLive(caller)
    const target = (input.sessionId ?? String(caller.sessionId)) as SessionId
    const query = input.query
    if (typeof query !== 'string' || query.length === 0) {
      throw new DataPlaneError(
        'DATA_INVALID_REQUEST',
        'dsh.data.history.search: the query is empty. An empty query is a caller error, not an empty result set.',
      )
    }
    const maxHits = input.maxHits ?? this.#maxHistoryHits
    if (!Number.isInteger(maxHits) || maxHits < 1) {
      throw new DataPlaneError(
        'DATA_INVALID_REQUEST',
        `dsh.data.history.search: max_hits must be a positive integer, got ${String(maxHits)}`,
      )
    }

    const historyCaller: HistoryCaller = {
      sessionId: caller.sessionId,
      ...caller.cwd === undefined ? {} : { cwd: caller.cwd },
    }
    const queryRepresentation = canonicalHistoryQuery(query, input.surfaces)

    if (input.cursor === undefined) {
      // A NEW scan: pin one observation, then supersede any earlier scan of the
      // same session so two live pins cannot double the retained memory.
      const pinned = await this.#pinHistory(target, historyCaller)
      return await this.#historyPage(pinned, historyCaller, {
        query, queryRepresentation, surfaces: input.surfaces, maxHits, from: 0,
      })
    }

    const cursor = parseHistoryCursor(input.cursor)
    if (cursor.queryRepresentation !== queryRepresentation) {
      // A cursor is bound to the query it was minted for. Reusing one with a
      // different query would page a result set that never existed.
      throw new HistoryAccessError(
        'HISTORY_WATERMARK_SUPERSEDED',
        `this cursor was minted for a different query representation (${cursor.queryRepresentation}); `
        + 'a cursor is not reusable across queries',
      )
    }
    const pinned = this.#scans.get(scanKey(cursor.sessionId, cursor.generation))
    if (pinned === undefined) {
      throw new HistoryAccessError(
        'HISTORY_WATERMARK_SUPERSEDED',
        `cursor generation ${String(cursor.generation)} for session "${cursor.sessionId}" is not an open scan`,
      )
    }
    if (String(pinned.watermark.sessionId) !== cursor.sessionId
      || pinned.watermark.maxSeq !== cursor.maxSeq
      || pinned.watermark.persistenceRevision !== cursor.persistenceRevision) {
      throw new HistoryAccessError(
        'HISTORY_WATERMARK_SUPERSEDED',
        `the pinned cut moved: the cursor names session "${cursor.sessionId}" at seq ${String(cursor.maxSeq)} `
        + `revision ${cursor.persistenceRevision ?? '(none)'}, but the open scan holds seq ${String(pinned.watermark.maxSeq)} `
        + `revision ${pinned.watermark.persistenceRevision ?? '(none)'}`,
      )
    }
    return await this.#historyPage(pinned, historyCaller, {
      query, queryRepresentation, surfaces: input.surfaces, maxHits, from: cursor.position,
    })
  }

  /** Release one pinned history scan early. Idempotent. */
  closeHistoryScan(cursor: string): void {
    const parsed = parseHistoryCursor(cursor)
    const key = scanKey(parsed.sessionId, parsed.generation)
    const entry = this.#scans.get(key)
    if (entry === undefined) return
    this.#scans.delete(key)
    entry.observation[Symbol.dispose]()
  }

  /** Release every pinned scan. Called by the owning service on teardown. */
  dispose(): void {
    for (const entry of [...this.#scans.values()]) {
      entry.observation[Symbol.dispose]()
    }
    this.#scans.clear()
  }

  /** Pin one exact observation and record its cut identity. */
  async #pinHistory(sessionId: SessionId, caller: HistoryCaller): Promise<PinnedScan> {
    const query = this.#sessionQuery()
    const header = await this.#corpus().headerOf(sessionId)
    const decision = authorizeHistoryRead(caller, header, sessionId)
    if (!decision.allowed) {
      throw new HistoryAccessError(
        'HISTORY_SESSION_UNAUTHORIZED',
        `refusing to read session "${sessionId}": ${decision.reason}`,
      )
    }
    // ONE observation lease for the whole paging operation.
    const observation = await query.observeSession(sessionId, { projectionMode: 'none' })
    const generation = ++generationCounter
    // Supersede any earlier scan of the same session, closing its lease first.
    for (const [key, entry] of [...this.#scans]) {
      if (String(entry.watermark.sessionId) === String(sessionId)) {
        this.#scans.delete(key)
        entry.observation[Symbol.dispose]()
      }
    }
    const watermark: HistoryCutIdentity = {
      sessionId: String(sessionId),
      maxSeq: observation.events.length - 1,
      generation,
      // The durable revision is recorded ONLY when the observation exposed one.
      // A live observation has no persistence revision, and inventing one would
      // claim a durable identity the cut does not have.
      ...observation.revision === undefined ? {} : { persistenceRevision: String(observation.revision) },
      queryRepresentation: '',
    }
    const pinned: PinnedScan = {
      watermark,
      observation,
      // The events are read ONCE, here. Every page filters this array.
      events: observation.events,
      fullLogMaterializations: 1,
    }
    this.#scans.set(scanKey(watermark.sessionId, generation), pinned)
    return pinned
  }

  async #historyPage(
    pinned: PinnedScan,
    caller: HistoryCaller,
    options: {
      readonly query: string
      readonly queryRepresentation: string
      readonly surfaces?: readonly string[]
      readonly maxHits: number
      readonly from: number
    },
  ): Promise<HistorySearchPage> {
    // Authorization is re-checked on EVERY page, not only at open: a permission
    // change between pages must stop the traversal, and a cursor is a value a
    // caller holds.
    const header = await this.#corpus().headerOf(pinned.watermark.sessionId as SessionId)
    const decision = authorizeHistoryRead(caller, header, pinned.watermark.sessionId as SessionId)
    if (!decision.allowed) {
      throw new HistoryAccessError(
        'HISTORY_SESSION_UNAUTHORIZED',
        `refusing to page session "${pinned.watermark.sessionId}": ${decision.reason}`,
      )
    }

    const needle = options.query.toLowerCase()
    const surfaces = options.surfaces === undefined ? undefined : new Set(options.surfaces)
    const hits: HistorySearchHit[] = []
    let position = options.from
    for (; position < pinned.events.length; position += 1) {
      const event = pinned.events[position]
      if (event === undefined) break
      if (surfaces !== undefined && !surfaces.has(String(event.surface ?? ''))) continue
      const serialized = JSON.stringify(event)
      const haystack = serialized.toLowerCase()
      const at = haystack.indexOf(needle)
      if (at < 0) continue
      hits.push({
        seq: event.seq as unknown as number,
        surface: String(event.surface ?? 'unknown'),
        excerpt: boundedExcerpt(serialized, at, needle.length, this.#maxExcerptChars),
        digest: createHash('sha256').update(serialized).digest('hex'),
      })
      if (hits.length >= options.maxHits) {
        position += 1
        break
      }
    }
    const exhausted = position >= pinned.events.length
    const watermark: HistoryCutIdentity = {
      ...pinned.watermark,
      queryRepresentation: options.queryRepresentation,
    }
    return {
      hits,
      ...exhausted ? {} : { cursor: mintHistoryCursor(watermark, position) },
      exhausted,
      watermark,
      fullLogMaterializations: pinned.fullLogMaterializations,
    }
  }

  #sessionQuery(): NonNullable<ReturnType<Context['get']>> {
    const service = this.#ctx.get('sessionQuery')
    if (service === undefined) {
      throw new DataPlaneError(
        'DATA_NO_CAPABILITY',
        'dsh.data.history: no ctx.sessionQuery service is mounted. This is a DEPLOYMENT fact '
        + '(the session-query plugin is not loaded), not an absence of history.',
      )
    }
    return service
  }

  #corpus(): HistoryCorpusView {
    const query = this.#sessionQuery()
    return {
      async headerOf(sessionId) {
        const records = await query.filterSessions([{ kind: 'id', values: [sessionId] }])
        const record = records.find((candidate: { header: { id: unknown } }) => candidate.header.id === sessionId)
        if (record === undefined) return undefined
        const header = record.header as { id: SessionId; cwd?: string; parentSession?: SessionId }
        return {
          id: header.id,
          ...header.cwd === undefined ? {} : { cwd: header.cwd },
          ...header.parentSession === undefined ? {} : { parentSession: header.parentSession },
        }
      },
    }
  }

  // -------------------------------------------------------------------------
  // K3: web
  // -------------------------------------------------------------------------

  /**
   * Fetch one URL through `ctx.web.fetch` and record the acquisition.
   *
   * The provider is resolved by DSH's own seam, and the provider id the seam
   * ACTUALLY selected is recorded on the result. That matters here more than it
   * looks: `G-SEAM-52` records that a provider row can be mounted while the
   * selection string names a different one, so "which provider answered" is a
   * fact worth capturing rather than inferring from configuration.
   *
   * PROVIDER TRUNCATION IS HONEST. `result.truncated` becomes `partial` with a
   * `provider-acquisition` gap and a `refetch` recovery. This method NEVER
   * rewrites an old partial observation into a full one: a refetch produces a
   * NEW record with its own time and hash, and the earlier record is untouched.
   */
  async webFetch(caller: DataCaller, input: {
    readonly url: string
    readonly maxBodyChars?: number
    readonly etag?: string
    readonly lastModified?: string
  }): Promise<WebFetchOutcome> {
    this.#assertLive(caller)
    if (typeof input.url !== 'string' || input.url.length === 0) {
      throw new DataPlaneError('DATA_INVALID_REQUEST', 'dsh.data.web.fetch: the url is empty')
    }
    const web = this.#web()
    const result = await this.#limiter.run(async () =>
      await web.fetch({ url: input.url }, caller.signal))
    const acquiredAt = new Date().toISOString()
    // The captured bytes are the body as the provider decoded it. Their digest is
    // computed here so the record names exact bytes rather than a location.
    const bodyBytes = Buffer.byteLength(result.body.content, 'utf8')
    const sha256 = createHash('sha256').update(result.body.content, 'utf8').digest('hex')
    const provider = this.#selectedProviderId('fetch')
    const outcome = provenanceFromFetch(result, {
      requestedUrl: input.url,
      provider,
      acquiredAt,
      artifact: `web:${sha256}`,
      sha256,
      ...input.maxBodyChars === undefined ? {} : { maxBodyChars: input.maxBodyChars },
      ...input.etag === undefined ? {} : { etag: input.etag },
      ...input.lastModified === undefined ? {} : { lastModified: input.lastModified },
    })
    return {
      // THE OBSERVATION ID IS MINTED HERE, not taken from the provenance record.
      //
      // MEASURED, and it is a real defect in the derivation this replaces: the
      // record's own id is `fetch:<provider>:<sha256(url + acquiredAt).slice(0,16)>`
      // (`web-provenance.ts:1047`), and `acquiredAt` is an ISO string at
      // MILLISECOND resolution. Two refetches of one URL inside the same
      // millisecond therefore produced the SAME observation id -- measured: a
      // truncated fetch and its complete refetch both reported
      // `fetch:r6-stub-fetch:b3d064c960937f6d`, so the second observation claimed
      // the first one's identity. That is precisely the "old observation silently
      // acquires the new bytes" failure DATA-06 forbids, arriving through the id
      // rather than through a reference row.
      //
      // The id is minted from the CONTENT DIGEST plus a host-monotone sequence, so
      // it is unique by construction and never depends on clock resolution. The
      // derivation in `web-provenance.ts` is left alone and recorded as an adjacent
      // finding (G-R6-02) rather than edited from this slice.
      record: { ...outcome.record, observationId: this.#mintWebObservationId(sha256) },
      gaps: outcome.gaps,
      provider,
      // The body is SUMMARIZED, never returned: a fetched page is bulk data, and
      // returning it would put the whole page into the frame this plane exists to
      // keep empty. The digest and the byte count are what a caller needs to decide
      // whether to capture it.
      body: {
        kind: result.body.kind,
        bytes: bodyBytes,
        chars: result.body.content.length,
        sha256,
      },
    }
  }

  /**
   * A unique observation id for one web acquisition.
   *
   * Content digest first, so two fetches of identical bytes are recognisably the
   * same content while remaining DISTINCT observations; a host-monotone sequence
   * second, so no two observations can share an id regardless of clock
   * resolution.
   */
  #mintWebObservationId(contentDigest: string): string {
    this.#webSequence += 1
    return `web-obs-${contentDigest.slice(0, 16)}-${String(this.#webSequence)}`
  }

  #webSequence = 0

  /**
   * Search through `ctx.web.search` and record the result as a RANKING.
   *
   * A top-k list is NOT an exhaustive set, and the record says so. A provider that
   * could not answer THROWS (`WEB_PROVIDER_UNAVAILABLE` or a provider error); it
   * is never converted into an empty source list, because collapsing a failure
   * into "no results" fabricates evidence.
   *
   * NOTE ON API BUDGET. This method is the real seam. `G-SEAM-52` is OPEN: the
   * ported provider is mounted but the selection string names a different
   * backend, so calling this in the shipped daily profile places a REAL request
   * against that backend. It is exercised in tests through a registered stub
   * provider, never against a live endpoint.
   */
  async webSearch(caller: DataCaller, input: {
    readonly query: string
    readonly maxResults?: number
  }): Promise<WebSearchOutcome> {
    this.#assertLive(caller)
    if (typeof input.query !== 'string' || input.query.trim().length === 0) {
      throw new DataPlaneError(
        'DATA_INVALID_REQUEST',
        'dsh.data.web.search: the query is empty. An empty query is a caller error, not an empty result set.',
      )
    }
    const web = this.#web()
    const result = await this.#limiter.run(async () =>
      await web.search({
        query: input.query,
        ...input.maxResults === undefined ? {} : { maxResults: input.maxResults },
      }, caller.signal))
    const provider = this.#selectedProviderId('search')
    const provenance = searchProvenance(result, {
      query: input.query,
      provider,
      acquiredAt: new Date().toISOString(),
      ...input.maxResults === undefined ? {} : { maxResults: input.maxResults },
    })
    return { provenance, provider }
  }

  /**
   * Which provider the seam actually selects.
   *
   * DSH's `WebRuntime` keeps its registries private and exposes no accessor, so
   * the selected id is read from the deployment's own configuration field
   * (`searchProvider` / `fetchProvider`, which the runtime itself reads from the
   * same place, including the `$DSH_WEB_*_PROVIDER` env override). This is
   * REPORTING ONLY: no decision in this file branches on it.
   *
   * The honest limitation is recorded rather than hidden: when the config names
   * no id, DSH auto-selects among usable providers and this returns
   * `'(auto)'` -- which is a statement that the deployment did not pin one, not
   * a claim about which one ran.
   */
  #selectedProviderId(kind: 'search' | 'fetch'): string {
    const configured = kind === 'search'
      ? (this.#ctx.get('web') as { searchProviderId?: string } | undefined)?.searchProviderId
        ?? process.env.DSH_WEB_SEARCH_PROVIDER
      : (this.#ctx.get('web') as { fetchProviderId?: string } | undefined)?.fetchProviderId
        ?? process.env.DSH_WEB_FETCH_PROVIDER
    return typeof configured === 'string' && configured.length > 0 ? configured : '(auto)'
  }

  // -------------------------------------------------------------------------
  // K6: model projection
  // -------------------------------------------------------------------------

  /**
   * The store's OWN byte count for a captured artifact.
   *
   * WHY THIS EXISTS RATHER THAN REUSING THE DESCRIPTOR'S NUMBER. The descriptor's
   * `captured.bytes` is what the host WROTE when it minted the observation; this is
   * what the store can still produce. They are normally equal, and the whole point
   * of the four-count invariant is that "normally equal" must be a MEASUREMENT
   * rather than an assumption. A store that lost the object returns `undefined`
   * here, which is a different fact from a zero-byte artifact.
   */
  async artifactStat(caller: DataCaller, descriptor: unknown): Promise<{ bytes: number; sha256: string } | undefined> {
    this.#assertLive(caller)
    const parsed = this.#service.parseObservation(descriptor)
    return await this.#service.store.stat(parsed.captured.artifact)
  }

  /**
   * The bounded model-visible projection of a walk.
   *
   * The ONLY thing a model sees about a walk. Deliberately bounded by construction
   * (fixed fields, a bounded preview, counts), so a 32 MiB consumption produces a
   * few hundred bytes of context rather than 32 MiB. That is the plane working.
   *
   * `completeness` here is the ACQUISITION verdict, and it is reported next to the
   * consumption counts rather than derived from them: a small projection is not
   * evidence of a small source, and a complete projection is not evidence of a
   * complete world.
   */
  projectForModel(caller: DataCaller, input: {
    readonly descriptor: unknown
    readonly pagesConsumed: number
    readonly bytesConsumed: number
    readonly exhausted: boolean
    readonly consumerNote?: string
    readonly previewBytes?: number
  }): ReturnType<typeof projectForModel> {
    this.#assertLive(caller)
    const descriptor = this.#service.parseObservation(input.descriptor)
    return projectForModel({
      descriptor,
      pagesConsumed: input.pagesConsumed,
      bytesConsumed: input.bytesConsumed,
      exhausted: input.exhausted,
      ...input.consumerNote === undefined ? {} : { consumerNote: input.consumerNote },
    }, input.previewBytes)
  }

  /**
   * Build the projection manifest for a walk that the model was shown.
   *
   * This is a SEPARATE record from the acquisition descriptor, on purpose (D2).
   * A 32 MiB artifact whose 400-byte summary reached the model is the plane
   * working; filing that as an acquisition gap would make an honest system look
   * broken. The manifest is the only place an omission is recorded, and it
   * refuses to exist without a recoverability ref.
   *
   * @param caller - the live cell, for the abort check.
   * @param input - the walk's measured numbers and the emitted payload.
   * @returns the manifest.
   */
  projectionManifest(caller: DataCaller, input: {
    readonly descriptors: readonly unknown[]
    readonly mode: ProjectionMode
    readonly selectorName: string
    readonly selectorVersion: string
    readonly selectorDigest?: string
    readonly selectedBytes: number
    readonly selectedItems?: number
    readonly omittedBytes?: number
    readonly omittedItems?: number
    readonly emitted: string | Uint8Array
  }): ProjectionManifest {
    this.#assertLive(caller)
    const sources: ProjectionSourceRef[] = input.descriptors.map(raw => {
      const descriptor = this.#service.parseObservation(raw)
      return {
        observationId: descriptor.id,
        artifact: descriptor.captured.artifact,
        sha256: descriptor.captured.sha256,
        artifactBytes: descriptor.captured.bytes,
      }
    })
    return buildProjectionManifest({
      sources,
      mode: input.mode,
      selector: {
        name: input.selectorName,
        version: input.selectorVersion,
        ...input.selectorDigest === undefined ? {} : { digest: input.selectorDigest },
      },
      selectedBytes: input.selectedBytes,
      ...input.selectedItems === undefined ? {} : { selectedItems: input.selectedItems },
      ...input.omittedBytes === undefined ? {} : { omittedBytes: input.omittedBytes },
      ...input.omittedItems === undefined ? {} : { omittedItems: input.omittedItems },
      // The recoverability refs are DERIVED from the sources rather than accepted
      // from the caller: a projection's omission is recoverable exactly when the
      // artifacts it came from are addressable, so accepting a caller-supplied
      // list would let a manifest claim recoverability it does not have.
      recoverability: sources.map(source => source.artifact),
      emitted: input.emitted,
    })
  }
}

/** One pinned history scan: ONE observation lease, read once. */
interface PinnedScan {
  readonly watermark: HistoryCutIdentity
  readonly observation: { events: readonly SessionEventLike[]; [Symbol.dispose](): void }
  readonly events: readonly SessionEventLike[]
  readonly fullLogMaterializations: number
}

/** The subset of a Session event this plane reads. Structural, so no upstream import is needed. */
interface SessionEventLike {
  readonly seq?: number
  readonly surface?: string
  readonly [key: string]: unknown
}

/** A monotone counter for scan generations. Process-local, which is what a cursor lifetime is. */
let generationCounter = 0

function scanKey(sessionId: string, generation: number): string {
  return `${sessionId}\u0000${String(generation)}`
}

/**
 * The canonical form of a history query, so a cursor is bound to the query it
 * was minted for. Filters are SORTED so two callers naming the same surface set
 * in different orders get the same representation.
 */
export function canonicalHistoryQuery(query: string, surfaces?: readonly string[]): string {
  const sorted = surfaces === undefined ? [] : [...surfaces].sort()
  return JSON.stringify({ q: query, s: sorted })
}

/** A history cursor: base64url JSON, carrying the five bindings K2 requires. */
export function mintHistoryCursor(cut: HistoryCutIdentity, position: number): string {
  const payload = {
    v: 1,
    sessionId: cut.sessionId,
    maxSeq: cut.maxSeq,
    generation: cut.generation,
    persistenceRevision: cut.persistenceRevision ?? null,
    queryRepresentation: cut.queryRepresentation,
    position,
  }
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
}

/** Decode a history cursor, refusing a malformed one by name. */
export function parseHistoryCursor(token: string): {
  sessionId: string
  maxSeq: number
  generation: number
  persistenceRevision: string | null
  queryRepresentation: string
  position: number
} {
  let decoded: unknown
  try {
    decoded = JSON.parse(Buffer.from(token, 'base64url').toString('utf8'))
  } catch (error) {
    throw new HistoryAccessError('HISTORY_INVALID_REQUEST', 'the history cursor is not decodable', { cause: error })
  }
  if (typeof decoded !== 'object' || decoded === null) {
    throw new HistoryAccessError('HISTORY_INVALID_REQUEST', 'the history cursor is not an object')
  }
  const record = decoded as Record<string, unknown>
  const { sessionId, maxSeq, generation, queryRepresentation, position } = record
  if (typeof sessionId !== 'string' || !Number.isInteger(maxSeq) || !Number.isInteger(generation)
    || typeof queryRepresentation !== 'string' || !Number.isInteger(position) || (position as number) < 0) {
    throw new HistoryAccessError(
      'HISTORY_INVALID_REQUEST',
      'the history cursor is missing a bound field; a cursor without its cut identity cannot be honoured',
    )
  }
  const revision = record['persistenceRevision']
  return {
    sessionId,
    maxSeq: maxSeq as number,
    generation: generation as number,
    persistenceRevision: typeof revision === 'string' ? revision : null,
    queryRepresentation,
    position: position as number,
  }
}

/**
 * A bounded excerpt around a match.
 *
 * Bounded because an excerpt is payload: a match inside a 100 KiB event would
 * otherwise put 100 KiB into a page that claims to be bounded. The cut is on
 * CODE POINTS, so a surrogate pair is never split into a lone surrogate that
 * JSON-serializes to an invalid escape.
 */
export function boundedExcerpt(haystack: string, at: number, needleLength: number, maxChars: number): string {
  const half = Math.max(0, Math.floor((maxChars - needleLength) / 2))
  const start = Math.max(0, at - half)
  const end = Math.min(haystack.length, at + needleLength + half)
  const slice = haystack.slice(start, end)
  const points = [...slice]
  const bounded = points.length > maxChars ? points.slice(0, maxChars).join('') : slice
  const prefix = start > 0 ? '…' : ''
  const suffix = end < haystack.length ? '…' : ''
  return `${prefix}${bounded}${suffix}`
}
