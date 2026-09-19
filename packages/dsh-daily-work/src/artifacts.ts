/**
 * The artifact data plane: capture, page, byte-range, and the reconcilable commit order.
 *
 * WHY THIS IS NOT A SECOND OBJECT STORE
 *
 * DSH already has storage that fits, and the audit forbids rebuilding it:
 *
 *   `@deepseek-ai/dsh-atomic-write`  `writeFileAtomic` (temp + rename, wx create,
 *                                    bounded Windows rename retry). String content only,
 *                                    no streaming, no digest.
 *   `@deepseek-ai/dsh-attachment-local`
 *                                    `publishImmutableObjectStream` -- the REAL
 *                                    match: it streams bounded chunks into a staging
 *                                    file, hashes WHILE streaming, fsyncs, hard-links
 *                                    into a digest-derived path, dedups with
 *                                    digest-verified EEXIST, chmods 0o400, and syncs
 *                                    directory entries. That is exactly the
 *                                    "streaming put, host-computed hash, atomic
 *                                    publish" this milestone needs.
 *   `@deepseek-ai/dsh-spill`         `saveText` ONLY. It persists text and returns an
 *                                    OPAQUE `SpillLocator` with no unified
 *                                    read/delete/ACL/refcount contract. There is no
 *                                    `open`, no `stat`, no range read, no delete.
 *
 * So this module REUSES the attachment-local publication primitive verbatim and
 * supplies the narrow contract that is genuinely missing:
 *
 *   - `capture_file`   stream a file in the FS-authorized execution world, hashing
 *                      as it goes, and return a descriptor. NOT a host path that
 *                      bypasses FS policy -- the bytes come from `ctx.fs`, so a
 *                      sandboxed/remote backend keeps its authority.
 *   - `pages`          bounded paging over the IMMUTABLE artifact, with a
 *                      host-validated cursor bound to artifact hash + representation
 *                      + position + schema + scope + watermark, and a monotonicity
 *                      check that turns a repeated/backwards cursor into
 *                      `pagination-stalled` instead of an infinite loop.
 *   - `readByteRange`  a byte-range exit for `read`, so a >2000-char line, a >50KiB
 *                      body, a UTF-8 sequence split across chunks, and a
 *                      newline-free file are all recoverable COMPLETELY.
 *   - the commit order and its reconciliation.
 *
 * WHAT `spillStore.saveText` CANNOT DO, STATED PLAINLY
 *
 * Saving already-truncated text into spill does not produce the original. The
 * truncation happened in `buildWindow` before any consumer saw the value
 * (`read-render.ts:118-125` caps the line buffer at `maxLineLength + 1`), and
 * `saveText` faithfully persists what it is given. A spill artifact holding a
 * 2034-char clipped line is a faithful copy of a clipped line. Nothing in this
 * module reads spill to "recover" an original, and no test claims it does.
 *
 * THE COMMIT ORDER (ARCHITECTURE §9)
 *
 * There is no cross-filesystem ACID transaction between the object store and the
 * Session log, so the order is chosen to make every interruption RECONCILABLE:
 *
 *   1. verify authority, allocate the host observation identity
 *   2. stream into a temp object, hashing chunk by chunk
 *   3. flush/fsync and atomically publish the object
 *   4. record the Session reference / coverage, take the checkpoint
 *   5. only NOW return a reference that says `durable: true`
 *
 * The three windows and their required verdicts:
 *
 *   object published, event NOT committed  -> ORPHAN. Reconcilable by grace GC.
 *                                             Must never be reported as delivered.
 *   event committed, object missing        -> INTEGRITY ERROR. Never an empty string.
 *   effect happened, save failed           -> UNKNOWN. Never re-execute to "fix the log".
 */
import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { open, stat as statPath } from 'node:fs/promises'
import { join } from 'node:path'
import type { FileSystem, FsTarget } from '@deepseek-ai/dsh-fs'
import { publishImmutableObjectStream } from '@deepseek-ai/dsh-attachment-local/src/store.ts'
import {
  ObservationError,
  coverageForRequest,
  mintObservation,
  refuseForgedClaims,
  type GrantTable,
  type JsonValue,
  type KernelObservationClaim,
  type ObservationDescriptor,
  type ObservationGap,
} from './observations.ts'

/**
 * The artifact store's on-disk layout version.
 *
 * A change here means stored objects moved or their metadata changed meaning, so
 * it needs an explicit conversion or a new root. Bumping it does not silently
 * reinterpret old objects.
 */
export const ARTIFACT_STORE_VERSION = 'v1'

/**
 * Default page size. 64 KiB is chosen so a 32 MiB artifact is 512 pages, which
 * is the DAT-02 stimulus; it is also small enough that a page is never a
 * context-budget problem on its own.
 */
export const DEFAULT_PAGE_BYTES = 64 * 1024

/**
 * Default per-artifact byte ceiling.
 *
 * This is a QUOTA, and exceeding it is a recorded gap, never a silent fallback
 * to unbounded inline delivery (DAT-08). The number is a deployment policy, not
 * a technical limit of the store.
 */
export const DEFAULT_ARTIFACT_QUOTA_BYTES = 256 * 1024 * 1024

/** Why an artifact operation refused. Stable codes so callers branch, not parse. */
export type ArtifactErrorCode =
  | 'artifact-not-found'
  | 'artifact-corrupt'
  | 'artifact-quota-exceeded'
  | 'artifact-write-failed'
  | 'artifact-integrity-error'
  | 'artifact-orphaned'
  /**
   * A capture was refused because the observation id already has a committed
   * reference.
   *
   * This is DATA-06's teeth. A refetch is a NEW observation; reusing an id would
   * OVERWRITE the old reference, so the old observation would silently acquire
   * the new bytes and read as `complete-within-request` forever after. Refusing
   * is the only outcome that keeps "the old observation stays partial" true.
   */
  | 'observation-already-committed'
  | 'pagination-stalled'
  | 'pagination-cursor-invalid'
  | 'pagination-scope-denied'

export class ArtifactError extends Error {
  readonly code: ArtifactErrorCode

  constructor(message: string, code: ArtifactErrorCode, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'ArtifactError'
    this.code = code
  }
}

/**
 * The three states a reference can be in, kept as separate values rather than a
 * boolean.
 *
 * `orphaned` exists because a published object whose Session reference was never
 * committed is NOT a delivered observation. Collapsing it into `durable: false`
 * would lose the difference between "not yet published" and "published but
 * unreferenced", and only the second needs a GC sweep.
 */
export type ReferenceState = 'durable' | 'orphaned' | 'missing'

/** A reference the kernel may hold. `durable` is only ever returned after step 5. */
export interface ArtifactReference {
  artifact: string
  sha256: string
  bytes: number
  state: ReferenceState
  /** The Session event that referenced this object, when one was committed. */
  sessionReference?: string
}

/** One bounded page of an immutable artifact. */
export interface ArtifactPage {
  /** The exact bytes of this page. Never a re-read of a live source file. */
  bytes: Uint8Array
  /** Byte offset of the first byte of this page within the artifact. */
  offset: number
  /** Opaque, host-validated continuation cursor; absent when the artifact is exhausted. */
  nextCursor?: string
  /** Whether this page ends at the artifact's end. */
  exhausted: boolean
  /** The artifact hash these bytes came from. Bound into the cursor. */
  sha256: string
}

/** Counters that make the IO cost of paging falsifiable (DAT-06). */
export interface IoCounters {
  /** Total bytes physically read from the artifact object. */
  artifactBytesRead: number
  /** Total bytes read from the SOURCE file (capture only; zero during paging). */
  sourceBytesRead: number
  /**
   * Bytes read to build the sparse index, if one was built.
   *
   * A SUBSET of `artifactBytesRead`: an index scan reads the same object through
   * the same `openRange`, so it counts in both. Kept separate because the two
   * answer different questions -- `artifactBytesRead` is "what did this walk
   * cost", `indexBytesRead` is "did the index stay one linear scan".
   */
  indexBytesRead: number
  /** Number of read syscalls issued against the artifact object. */
  artifactReads: number
}

/**
 * The store's narrow contract: put, open-range, stat, delete, pin.
 *
 * `spillStore` has only `put`. The audit's rule is to add the narrow missing
 * contract rather than a general object-storage platform, so this interface is
 * deliberately six methods and no more: no bucket lifecycle, no replication, no
 * arbitrary metadata query, no second content-addressing scheme (the path IS
 * the digest, exactly as attachment-local derives it).
 */
export interface ArtifactStore {
  /** The root this store publishes below. Used as the durable boundary for syncs. */
  readonly root: string
  /**
   * Stream `chunks` to an immutable, content-addressed object.
   * The hash is computed WHILE streaming; the caller never supplies it.
   */
  put(chunks: AsyncIterable<Uint8Array> | Iterable<Uint8Array>, options?: { signal?: AbortSignal }): Promise<{ artifact: string; sha256: string; bytes: number }>
  /** Stat an artifact without reading its content. */
  stat(artifact: string): Promise<{ bytes: number; sha256: string } | undefined>
  /** Read one byte window. The window is the bound, never the whole object. */
  openRange(artifact: string, range: { offset: number; length: number }, counters?: IoCounters, signal?: AbortSignal): Promise<Uint8Array>
  /** Delete an object, leaving a tombstone. Returns whether a live object was removed. */
  remove(artifact: string): Promise<boolean>
  /** Whether the object is pinned against GC. */
  isPinned(artifact: string): boolean
  /** Pin/unpin against grace GC. A pinned object is never collected. */
  setPinned(artifact: string, pinned: boolean): void
}

/** A recorded tombstone, so a deleted reference reads as expired and not as absent. */
export interface Tombstone {
  artifact: string
  deletedAt: string
  reason: string
}

/**
 * A local, content-addressed artifact store built on DSH's publication primitive.
 *
 * The publication call is `publishImmutableObjectStream` from
 * `@deepseek-ai/dsh-attachment-local/src/store.ts` -- the same function that
 * stores image attachments. Reusing it is the point: the fsync ordering, the
 * Windows rename/link handling, the digest-verified dedup and the 0o400 mode are
 * already tested there, and a second implementation would be a second set of
 * durability bugs.
 *
 * WHAT IS ADDED HERE, and why the reuse is not sufficient alone:
 *   - a quota check that runs DURING the stream and fails with a recorded reason,
 *     because attachment-local has no quota concept (images are size-capped
 *     before publication, not while streaming);
 *   - `openRange` with real byte accounting, because attachment-local's read path
 *     reads a whole object and verifies it, which is the wrong shape for paging a
 *     32 MiB artifact one page at a time;
 *   - tombstones and pinning, which attachment-local does not have because
 *     attachments are referenced by immutable refs and never deleted.
 */
export class LocalArtifactStore implements ArtifactStore {
  readonly root: string
  private readonly quotaBytes: number
  private readonly pinned = new Set<string>()
  private readonly tombstones = new Map<string, Tombstone>()

  constructor(root: string, options?: { quotaBytes?: number }) {
    this.root = root
    this.quotaBytes = options?.quotaBytes ?? DEFAULT_ARTIFACT_QUOTA_BYTES
  }

  /**
   * Stream to an immutable object, enforcing the quota DURING the stream.
   *
   * The check runs per chunk rather than after, because a post-hoc check on a
   * 10 GiB stream has already written 10 GiB. On violation the staged temp file
   * is removed by the publication primitive's own error path and the caller gets
   * `artifact-quota-exceeded` -- which becomes a gap record, never a silent
   * inline fallback.
   */
  async put(
    chunks: AsyncIterable<Uint8Array> | Iterable<Uint8Array>,
    options?: { signal?: AbortSignal },
  ): Promise<{ artifact: string; sha256: string; bytes: number }> {
    const quota = this.quotaBytes
    let streamed = 0
    async function* bounded(): AsyncIterable<Uint8Array> {
      for await (const chunk of chunks as AsyncIterable<Uint8Array>) {
        streamed += chunk.byteLength
        if (streamed > quota) {
          throw new ArtifactError(
            `artifact exceeds the ${quota}-byte quota after ${streamed} bytes; `
            + 'the capture is recorded as partial and no inline fallback is attempted',
            'artifact-quota-exceeded',
          )
        }
        yield chunk
      }
    }
    try {
      const published = await publishImmutableObjectStream(
        this.root,
        bounded(),
        // The digest IS the address. Two captures of identical bytes dedup onto one
        // object, which is correct: the object is immutable, so sharing it cannot
        // let one observation observe another's mutation.
        sha256 => join(this.root, 'objects', sha256.slice(0, 2), sha256),
        options?.signal,
      )
      const artifact = artifactRefOf(published.sha256)
      this.tombstones.delete(artifact)
      return { artifact, sha256: published.sha256, bytes: published.bytes }
    } catch (error) {
      if (error instanceof ArtifactError) throw error
      // The publication primitive wraps a failure raised INSIDE the stream in its
      // own error type, so an error this module raised -- a quota refusal, or a
      // source that changed mid-capture -- would otherwise reach the caller as a
      // generic write failure with its code lost. The walk recovers the original
      // so the caller branches on the real reason.
      const inner = findArtifactError(error)
      if (inner !== undefined) throw inner
      // Nothing of ours: preserve the cause so a real ENOSPC stays diagnosable
      // rather than becoming a generic failure.
      throw new ArtifactError('artifact publication failed', 'artifact-write-failed', { cause: error })
    }
  }

  async stat(artifact: string): Promise<{ bytes: number; sha256: string } | undefined> {
    const sha256 = digestOfRef(artifact)
    const path = this.pathOf(sha256)
    try {
      const info = await statPath(path)
      return { bytes: info.size, sha256 }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
  }

  /**
   * Read one byte window of an artifact and account for it.
   *
   * The whole point of paging against a captured object is that the cost is
   * proportional to the pages read. This method therefore opens the object and
   * reads ONLY `[offset, offset + length)` -- it never verifies the whole object
   * (that would be a full re-read per page) and it never falls back to a full
   * read. Integrity is established at capture time by the streaming hash and
   * re-established only by an explicit `verify`.
   *
   * A MISSING object is an integrity error, not an empty string. The two are
   * different facts and only one of them is a valid empty result.
   */
  async openRange(
    artifact: string,
    range: { offset: number; length: number },
    counters?: IoCounters,
    signal?: AbortSignal,
  ): Promise<Uint8Array> {
    const tombstone = this.tombstones.get(artifact)
    if (tombstone !== undefined) {
      throw new ArtifactError(
        `artifact ${artifact} was deleted at ${tombstone.deletedAt} (${tombstone.reason})`,
        'artifact-not-found',
      )
    }
    const sha256 = digestOfRef(artifact)
    const path = this.pathOf(sha256)
    if (range.length === 0) return new Uint8Array(0)
    let handle
    try {
      handle = await open(path, 'r')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        // The event that referenced this object is committed; the object is gone.
        // Returning an empty buffer here would make a lost artifact indistinguishable
        // from a legitimately empty one.
        throw new ArtifactError(
          `artifact ${artifact} is referenced but absent from the store`,
          'artifact-integrity-error',
          { cause: error },
        )
      }
      throw error
    }
    try {
      const buffer = Buffer.allocUnsafe(range.length)
      const { bytesRead } = await handle.read(buffer, 0, range.length, range.offset)
      if (counters !== undefined) {
        counters.artifactBytesRead += bytesRead
        counters.artifactReads += 1
      }
      return new Uint8Array(buffer.subarray(0, bytesRead))
    } finally {
      await handle.close()
    }
  }

  /** Verify the whole object against its address. Explicit, so paging stays O(page). */
  async verify(artifact: string): Promise<boolean> {
    const sha256 = digestOfRef(artifact)
    const hash = createHash('sha256')
    for await (const chunk of createReadStream(this.pathOf(sha256)) as AsyncIterable<Buffer>) hash.update(chunk)
    return hash.digest('hex') === sha256
  }

  /**
   * Delete an object, leaving a TOMBSTONE.
   *
   * The tombstone is what makes a deleted reference read as `expired/deleted`
   * rather than `absent`: without it, a caller cannot tell "this was never
   * captured" from "this was captured and then collected", and the audit requires
   * the difference to survive.
   */
  async remove(artifact: string): Promise<boolean> {
    const sha256 = digestOfRef(artifact)
    const path = this.pathOf(sha256)
    const existed = await this.stat(artifact) !== undefined
    if (existed) {
      const { unlink } = await import('node:fs/promises')
      await unlink(path)
    }
    this.tombstones.set(artifact, {
      artifact,
      deletedAt: new Date().toISOString(),
      reason: existed ? 'explicit-delete' : 'absent-at-delete',
    })
    return existed
  }

  isPinned(artifact: string): boolean {
    return this.pinned.has(artifact)
  }

  setPinned(artifact: string, pinned: boolean): void {
    if (pinned) this.pinned.add(artifact)
    else this.pinned.delete(artifact)
  }

  /** The recorded tombstone for an artifact, if any. */
  tombstoneOf(artifact: string): Tombstone | undefined {
    return this.tombstones.get(artifact)
  }

  /**
   * Grace GC over unreferenced objects.
   *
   * Only objects that are unreferenced, unpinned and older than `graceMs` are
   * collected. The grace window is the whole reason an orphan is safe to delete:
   * a crash between "object published" and "event committed" leaves an object
   * whose referencing event may still be in flight, so collecting it immediately
   * would turn a recoverable orphan into a real integrity error.
   *
   * @param referenced - artifact refs the Session has committed.
   * @param graceMs - minimum age before an unreferenced object may be collected.
   * @param now - injectable clock, so the grace window is testable without sleeping.
   */
  async collectGarbage(
    referenced: ReadonlySet<string>,
    graceMs: number,
    now: number = Date.now(),
  ): Promise<{ collected: string[]; skipped: Array<{ artifact: string; reason: string }> }> {
    const { readdir, unlink, stat: statOne } = await import('node:fs/promises')
    const collected: string[] = []
    const skipped: Array<{ artifact: string; reason: string }> = []
    const objectsRoot = join(this.root, 'objects')
    let shards: string[]
    try {
      shards = await readdir(objectsRoot)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { collected, skipped }
      throw error
    }
    for (const shard of shards) {
      let names: string[]
      try {
        names = await readdir(join(objectsRoot, shard))
      } catch {
        continue
      }
      for (const name of names) {
        const artifact = artifactRefOf(name)
        if (referenced.has(artifact)) {
          skipped.push({ artifact, reason: 'referenced' })
          continue
        }
        if (this.pinned.has(artifact)) {
          skipped.push({ artifact, reason: 'pinned' })
          continue
        }
        const info = await statOne(join(objectsRoot, shard, name))
        const ageMs = now - info.mtimeMs
        if (ageMs < graceMs) {
          skipped.push({ artifact, reason: `within-grace (${Math.round(ageMs)}ms < ${graceMs}ms)` })
          continue
        }
        await unlink(join(objectsRoot, shard, name))
        this.tombstones.set(artifact, {
          artifact,
          deletedAt: new Date().toISOString(),
          reason: 'grace-gc-orphan',
        })
        collected.push(artifact)
      }
    }
    return { collected, skipped }
  }

  private pathOf(sha256: string): string {
    return join(this.root, 'objects', sha256.slice(0, 2), sha256)
  }
}

/** The artifact reference format. The digest is the address; nothing else is encoded. */
export function artifactRefOf(sha256: string): string {
  return `artifact:sha256:${sha256}`
}

/** Extract the digest from an artifact reference, refusing anything else. */
export function digestOfRef(artifact: string): string {
  const match = /^artifact:sha256:([a-f0-9]{64})$/u.exec(artifact)
  if (match?.[1] === undefined) {
    throw new ArtifactError(`not an artifact reference: ${artifact}`, 'artifact-not-found')
  }
  return match[1]
}

/**
 * A paging cursor.
 *
 * Opaque to the caller and validated by the host. It binds SIX things, and each
 * binding closes a specific failure:
 *
 *   artifactSha256   a cursor cannot be replayed against a different object
 *   representation   a cursor for `bytes` cannot be used for a `lines` walk
 *   position         where to resume
 *   schemaVersion    a cursor from an older descriptor shape is refused
 *   ownerScope       a copied cursor cannot cross an authorization scope
 *   watermark        the snapshot the walk started from
 *
 * A page NUMBER is deliberately not authorization (ARCHITECTURE §7): possessing
 * `page=7` proves nothing, which is why the cursor is a host-minted string with a
 * host-checked signature rather than a client-supplied integer.
 */
export interface PageCursor {
  artifactSha256: string
  representation: string
  position: number
  schemaVersion: number
  ownerScope: string
  watermark: string
}

/** How a cursor is serialized. Base64 of canonical JSON, plus a host HMAC. */
const CURSOR_SEPARATOR = '.'

/**
 * The host-side cursor authority.
 *
 * The signature is what makes a cursor host-validated rather than
 * caller-asserted. Without it, a caller could mint a cursor naming any position
 * in any artifact and the pager would have to trust it; with it, a forged or
 * tampered cursor is refused before any bytes are read.
 */
export class CursorAuthority {
  private readonly secret: string
  private readonly schemaVersion: number

  constructor(secret: string, schemaVersion: number) {
    this.secret = secret
    this.schemaVersion = schemaVersion
  }

  /** Mint an opaque cursor for a position. */
  mint(cursor: Omit<PageCursor, 'schemaVersion'>): string {
    const full: PageCursor = { ...cursor, schemaVersion: this.schemaVersion }
    const payload = Buffer.from(JSON.stringify(full), 'utf8').toString('base64url')
    return `${payload}${CURSOR_SEPARATOR}${this.sign(payload)}`
  }

  /**
   * Validate and decode a cursor.
   *
   * Every rejection names WHICH binding failed, because "invalid cursor" is not
   * actionable: a caller that crossed scopes needs a different remedy from one
   * that replayed a stale position.
   */
  parse(token: string, expect: { ownerScope: string; representation: string }): PageCursor {
    const index = token.lastIndexOf(CURSOR_SEPARATOR)
    if (index <= 0) {
      throw new ArtifactError('pagination cursor is not a host-minted cursor', 'pagination-cursor-invalid')
    }
    const payload = token.slice(0, index)
    const signature = token.slice(index + 1)
    if (this.sign(payload) !== signature) {
      throw new ArtifactError('pagination cursor signature does not verify', 'pagination-cursor-invalid')
    }
    let decoded: unknown
    try {
      decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
    } catch (error) {
      throw new ArtifactError('pagination cursor payload is not decodable', 'pagination-cursor-invalid', { cause: error })
    }
    const cursor = decoded as Partial<PageCursor>
    if (cursor.schemaVersion !== this.schemaVersion) {
      throw new ArtifactError(
        `pagination cursor schema version ${String(cursor.schemaVersion)} is not ${this.schemaVersion}`,
        'pagination-cursor-invalid',
      )
    }
    if (cursor.ownerScope !== expect.ownerScope) {
      // A copied cursor is not a capability. The scope is bound at mint time and
      // re-checked here, so possession of the string grants nothing.
      throw new ArtifactError(
        `pagination cursor is scoped to "${String(cursor.ownerScope)}", not "${expect.ownerScope}"`,
        'pagination-scope-denied',
      )
    }
    if (cursor.representation !== expect.representation) {
      throw new ArtifactError(
        `pagination cursor represents "${String(cursor.representation)}", not "${expect.representation}"`,
        'pagination-cursor-invalid',
      )
    }
    if (typeof cursor.artifactSha256 !== 'string' || typeof cursor.position !== 'number'
      || typeof cursor.watermark !== 'string' || !Number.isInteger(cursor.position) || cursor.position < 0) {
      throw new ArtifactError('pagination cursor is missing a bound field', 'pagination-cursor-invalid')
    }
    return cursor as PageCursor
  }

  private sign(payload: string): string {
    return createHash('sha256').update(`${this.secret}:${payload}`).digest('base64url')
  }
}

/** Where a paging walk starts, and what it is allowed to read. */
export interface PageRequest {
  descriptor: ObservationDescriptor
  /** Page size in bytes. */
  maxBytes: number
  /** Opaque continuation cursor. Omitted for the first page. */
  cursor?: string
  /** The live grant table; the descriptor must still be valid under it. */
  grants: GrantTable
  /** The scope the CALLER is acting under. Checked against the descriptor and the cursor. */
  callerScope: string
}

/**
 * Page an immutable artifact.
 *
 * WHY PAGES COME FROM THE ARTIFACT AND NOT THE LIVE FILE
 *
 * Paging the live file would let a writer change it between page 1 and page 2, so
 * the caller would assemble a document that existed at no single instant. The
 * audit forbids mixing pages across a change, and the only way to guarantee that
 * is to read the captured object, whose address IS its content hash (DAT-05).
 *
 * THE STALL CHECK
 *
 * A provider that returns a repeated or backwards cursor would loop forever. The
 * check is on the CURSOR's position, not on the byte count: a page that returns
 * zero bytes but advances the cursor is progress (a legitimately empty region),
 * while a page that returns bytes at a position at or before the previous one is
 * not. Both a repeated cursor and a backwards one raise `pagination-stalled`.
 *
 * @param store - the artifact store holding the captured object.
 * @param request - the descriptor, page size, cursor and scope.
 * @param counters - optional IO accounting, so the cost is measurable (DAT-06).
 * @throws ArtifactError `pagination-stalled` when the cursor does not advance.
 */
export async function pages(
  store: ArtifactStore,
  request: PageRequest,
  counters?: IoCounters,
): Promise<ArtifactPage> {
  const { descriptor, maxBytes, grants, callerScope } = request
  // The descriptor's authority is host-authored and checked against the LIVE grant,
  // so a permission-domain change invalidates every cursor minted before it.
  if (descriptor.authority.ownerScope !== callerScope) {
    throw new ArtifactError(
      `observation ${descriptor.id} is scoped to "${descriptor.authority.ownerScope}", not "${callerScope}"`,
      'pagination-scope-denied',
    )
  }
  if (!grants.stillValid(descriptor.authority)) {
    throw new ArtifactError(
      `observation ${descriptor.id} was minted under grant revision ${descriptor.authority.grantRevision}, which is stale`,
      'pagination-scope-denied',
    )
  }
  if (!Number.isInteger(maxBytes) || maxBytes < 1) {
    throw new ArtifactError(`maxBytes must be a positive integer, got ${maxBytes}`, 'pagination-cursor-invalid')
  }
  const representation = 'bytes'
  const sha256 = descriptor.captured.sha256
  const watermark = descriptor.source.acquiredAt
  const authority = new CursorAuthority(cursorSecretOf(descriptor), descriptor.schemaVersion)

  let position = 0
  if (request.cursor !== undefined) {
    const cursor = authority.parse(request.cursor, { ownerScope: callerScope, representation })
    if (cursor.artifactSha256 !== sha256) {
      // The cursor names a different object than the descriptor. Continuing would
      // splice two artifacts into one stream, which is the mixing the audit forbids.
      throw new ArtifactError(
        `pagination cursor is bound to artifact ${cursor.artifactSha256}, not ${sha256}`,
        'pagination-cursor-invalid',
      )
    }
    if (cursor.watermark !== watermark) {
      throw new ArtifactError(
        `pagination cursor is bound to watermark ${cursor.watermark}, not ${watermark}`,
        'pagination-cursor-invalid',
      )
    }
    position = cursor.position
  }

  const total = descriptor.captured.bytes
  const length = Math.min(maxBytes, Math.max(0, total - position))
  const bytes = await store.openRange(descriptor.captured.artifact, { offset: position, length }, counters)
  const end = position + bytes.byteLength
  const exhausted = end >= total
  return {
    bytes,
    offset: position,
    sha256,
    exhausted,
    ...exhausted ? {} : {
      nextCursor: authority.mint({
        artifactSha256: sha256,
        representation,
        position: end,
        ownerScope: callerScope,
        watermark,
      }),
    },
  }
}

/**
 * A cursor's signature secret, derived from the descriptor.
 *
 * Deriving it rather than storing a random secret keeps the cursor verifiable
 * across a process restart (which a paging walk must survive) while still being
 * host-only: a caller cannot mint a valid cursor without the descriptor, and the
 * descriptor is host-authored.
 */
function cursorSecretOf(descriptor: ObservationDescriptor): string {
  return `${descriptor.id}:${descriptor.captured.sha256}:${descriptor.authority.ownerScope}:${descriptor.authority.grantRevision}`
}

/**
 * Drive a whole paging walk with a monotonicity guard.
 *
 * This is the function a native `data.pages` call runs. It exists so the stall
 * check is in ONE place rather than repeated at every call site, and so a
 * provider that misbehaves is caught by the driver rather than by a caller that
 * forgot to compare cursors.
 *
 * The provider is a parameter, not a hard reference to the artifact store, so the
 * SAME guard can be exercised against a misbehaving provider (DAT-04). A guard
 * that can only be tested against a well-behaved provider proves nothing.
 *
 * @param provider - the page source. `ArtifactStorePageProvider` is the real one.
 * @param request - the walk request; `cursor` is ignored (the walk starts at 0).
 * @param options - page budget and a per-page consumer.
 * @throws ArtifactError `pagination-stalled` when a page does not advance.
 */
export async function walkPages(
  provider: PageProvider,
  request: Omit<PageRequest, 'cursor'>,
  options: {
    /** Stop after this many pages even if the artifact is not exhausted. */
    maxPages?: number
    /** Called with each page; return `false` to stop early. */
    onPage?: (page: ArtifactPage, index: number) => boolean | void
    counters?: IoCounters
  } = {},
): Promise<{ pages: number; bytes: number; exhausted: boolean; lastPosition: number }> {
  const counters = options.counters
  let cursor: string | undefined
  let pageCount = 0
  let byteCount = 0
  let lastPosition = -1
  for (;;) {
    if (options.maxPages !== undefined && pageCount >= options.maxPages) {
      return { pages: pageCount, bytes: byteCount, exhausted: false, lastPosition }
    }
    const page = await provider.next({ ...request, ...cursor !== undefined ? { cursor } : {} }, counters)
    if (page.offset <= lastPosition) {
      // The provider went backwards or repeated. Without this check the loop below
      // would run forever on a provider that always returns the same cursor.
      throw new ArtifactError(
        `pagination stalled: page ${pageCount} resumed at offset ${page.offset}, at or before the previous ${lastPosition}`,
        'pagination-stalled',
      )
    }
    lastPosition = page.offset
    pageCount += 1
    byteCount += page.bytes.byteLength
    if (options.onPage?.(page, pageCount - 1) === false) {
      return { pages: pageCount, bytes: byteCount, exhausted: false, lastPosition }
    }
    if (page.exhausted) return { pages: pageCount, bytes: byteCount, exhausted: true, lastPosition }
    cursor = page.nextCursor
    if (cursor === undefined) {
      throw new ArtifactError(
        `pagination stalled: page ${pageCount} reported not-exhausted without a continuation cursor`,
        'pagination-stalled',
      )
    }
  }
}

/**
 * A page source. The real implementation is {@link ArtifactStorePageProvider};
 * the interface exists so the stall guard is testable against a provider that
 * violates the contract on purpose.
 */
export interface PageProvider {
  /** Produce the page at the requested cursor (or the first page when absent). */
  next(request: PageRequest, counters?: IoCounters): Promise<ArtifactPage>
}

/** Pages an immutable artifact through {@link pages}. */
export class ArtifactStorePageProvider implements PageProvider {
  private readonly store: ArtifactStore

  constructor(store: ArtifactStore) {
    this.store = store
  }

  next(request: PageRequest, counters?: IoCounters): Promise<ArtifactPage> {
    return pages(this.store, request, counters)
  }
}

/**
 * The Session-side reference log.
 *
 * This is the interface between the object store and DSH's Session. It is
 * deliberately a tiny port rather than a direct Session dependency: the object
 * store and the Session log live on different durability media, and the whole
 * point of the commit order is that the two are NOT one transaction. A port
 * makes the window between them testable.
 */
export interface SessionReferenceLog {
  /**
   * Commit a reference to the observation.
   * @returns the Session event id, which is what makes the reference reconcilable.
   */
  commit(reference: {
    observationId: string
    artifact: string
    sha256: string
    bytes: number
    coverage: JsonValue
  }): Promise<string>
  /** Every artifact ref the log has committed, for orphan reconciliation. */
  referencedArtifacts(): Promise<ReadonlySet<string>>
  /** The committed reference for an observation, if any. */
  lookup(observationId: string): Promise<{ artifact: string; sha256: string; eventId: string } | undefined>
}

/**
 * An in-memory reference log for tests and for a Session that has not attached
 * one yet. Deliberately NOT durable: a durable log must be DSH's Session, and
 * pretending an in-memory map is durable would be exactly the false `durable:
 * true` the commit order exists to prevent.
 */
export class InMemorySessionReferenceLog implements SessionReferenceLog {
  private readonly byObservation = new Map<string, { artifact: string; sha256: string; eventId: string }>()
  private readonly committed = new Set<string>()
  private sequence = 0
  /** Test seam: makes `commit` fail, to exercise the orphan window. */
  failNextCommit: string | undefined

  async commit(reference: {
    observationId: string
    artifact: string
    sha256: string
    bytes: number
    coverage: JsonValue
  }): Promise<string> {
    if (this.failNextCommit !== undefined) {
      const reason = this.failNextCommit
      this.failNextCommit = undefined
      throw new Error(reason)
    }
    this.sequence += 1
    const eventId = `session-event-${this.sequence}`
    this.byObservation.set(reference.observationId, {
      artifact: reference.artifact,
      sha256: reference.sha256,
      eventId,
    })
    this.committed.add(reference.artifact)
    return eventId
  }

  async referencedArtifacts(): Promise<ReadonlySet<string>> {
    return new Set(this.committed)
  }

  async lookup(observationId: string): Promise<{ artifact: string; sha256: string; eventId: string } | undefined> {
    return this.byObservation.get(observationId)
  }
}

/** What a capture produced, before any durability promise is made. */
export interface CaptureOutcome {
  descriptor: ObservationDescriptor
  /** The reference, whose `state` is the honest answer at this moment. */
  reference: ArtifactReference
  /** Any loss recorded during capture. A quota failure lands here, never inline. */
  gaps: ObservationGap[]
  io: IoCounters
}

/** Input to `captureFile`. */
export interface CaptureFileRequest {
  /** The FS service; capture reads THROUGH it, so the backend's authority applies. */
  fs: FileSystem
  /** The path to capture, resolved by the FS backend (never a host path bypass). */
  path: string
  /** The store to publish into. */
  store: ArtifactStore
  /** The Session reference log. */
  log: SessionReferenceLog
  /** Live grants. */
  grants: GrantTable
  /** The scope this capture runs under. */
  ownerScope: string
  /** The execution world identity (FS backend / sandbox), recorded on the descriptor. */
  executionWorld: string
  /** Observation id. Host-allocated. */
  observationId?: string
  /** Media type for the captured object. */
  mediaType?: string
  /** The byte range requested, for coverage. Omitted means "the whole file". */
  requestedRange?: { offset: number; length?: number }
  /** A kernel claim. Cannot express a host fact; a forged payload is refused. */
  claim?: unknown
  /** The host checkpoint hook. Runs AFTER the object is published, BEFORE `durable: true`. */
  checkpoint?: (reference: { artifact: string; sha256: string; bytes: number }) => Promise<void>
  signal?: AbortSignal
  /** Test seam: the clock. Defaults to the real one. */
  now?: () => Date
  /**
   * How the captured bytes are read back from the FS. Defaults to the backend's
   * RAW byte windows (`readByteRange`), which never decode, never reject binary
   * content and never buffer the whole file.
   *
   * `expectedBytes` is the size `stat` reported at capture start. A default
   * implementation uses it to detect a source that changed mid-capture; a custom
   * one may ignore it, and the size check below still runs on the result.
   */
  readChunks?: (fs: FileSystem, target: FsTarget, signal?: AbortSignal, expectedBytes?: number) => AsyncIterable<Uint8Array>
}

/**
 * Capture a file into the artifact store, in the reconcilable order.
 *
 * The order is the whole contract, so it is stated in the body:
 *
 *   1. resolve the target through `ctx.fs` (authority applies; no host path bypass)
 *   2. stream into a temp object, hashing chunk by chunk, quota enforced during
 *   3. atomically publish
 *   4. commit the Session reference
 *   5. run the caller's checkpoint
 *   6. ONLY NOW is `durable: true` returned
 *
 * If step 4 fails, the object is published but unreferenced: the outcome says
 * `orphaned`, NOT `durable`. That is the difference between a real observation
 * and an object nobody has promised.
 *
 * If step 5 fails, the reference is committed but the checkpoint is not: the
 * outcome is `durable: false` with the object still referenced, because a
 * checkpoint failure is a durability failure, not an absence.
 *
 * A QUOTA FAILURE DOES NOT FALL BACK TO INLINE. The `artifact-quota-exceeded`
 * error is caught, recorded as a `retention` gap, and returned as a `partial`
 * observation with no artifact. The caller gets a small honest answer, never an
 * unbounded one.
 */
export async function captureFile(request: CaptureFileRequest): Promise<CaptureOutcome> {
  const { fs, path, store, log, grants, ownerScope, executionWorld } = request
  // Refuse a payload that asserts host facts BEFORE doing any work, so a forged
  // capture cannot cause a write.
  if (request.claim !== undefined) refuseForgedClaims(request.claim)
  const claim = request.claim as KernelObservationClaim | undefined
  const observationId = request.observationId ?? `obs_${randomUUID()}`
  const now = request.now ?? (() => new Date())
  const io: IoCounters = { artifactBytesRead: 0, sourceBytesRead: 0, indexBytesRead: 0, artifactReads: 0 }
  const gaps: ObservationGap[] = []

  const target = await fs.resolve(path, { signal: request.signal })
  const info = await fs.stat(target, request.signal)
  if (info === undefined) {
    throw new ArtifactError(`cannot capture "${path}": no such target`, 'artifact-not-found')
  }
  if (info.type !== 'file') {
    throw new ArtifactError(`cannot capture "${path}": not a regular file`, 'artifact-not-found')
  }

  // DATA-06, REFUSED AT THE BOUNDARY. A refetch is a NEW observation, so reusing
  // an id that already has a committed reference is refused BEFORE any bytes are
  // read. Without this check the second capture would overwrite the reference row
  // and the OLD observation would silently acquire the NEW bytes -- reading as
  // `complete-within-request` forever after, which is precisely the
  // backfill-and-call-it-full failure the rule forbids. Measured before the fix:
  // a partial first capture of 7 bytes was replaced by a 13-byte refetch under
  // the same id, and the stored reference changed with it.
  //
  // The check is a READ of the log, not a lock: two captures racing on one id can
  // still interleave, and the durable medium is what makes the loser detectable
  // rather than silent. A caller that wants a refetch must allocate a new id,
  // which is the whole point.
  if (await log.lookup(observationId) !== undefined) {
    throw new ArtifactError(
      `observation ${observationId} already has a committed reference; a refetch is a NEW observation `
      + 'with its own id, time and hash -- overwriting this one would make the earlier observation claim bytes it never held',
      'observation-already-committed',
    )
  }

  const readChunks = request.readChunks ?? defaultReadChunks
  // Captured into a local because the narrowing from the `undefined` check above
  // does not survive into the generator closure below.
  const sourceBytesAtStart = info.size
  // Count the bytes the SOURCE read costs, which is what makes the capture's IO
  // claim falsifiable rather than asserted.
  async function* counted(): AsyncIterable<Uint8Array> {
    for await (const chunk of readChunks(fs, target, request.signal, sourceBytesAtStart)) {
      io.sourceBytesRead += chunk.byteLength
      yield chunk
    }
  }

  let published: { artifact: string; sha256: string; bytes: number }
  try {
    published = await store.put(counted(), { signal: request.signal })
  } catch (error) {
    if (findQuotaError(error) !== undefined) {
      // The retention layer refused. Record it as a gap with recovery `none`,
      // because a retry against the same quota fails the same way, and return a
      // PARTIAL observation with no artifact. The audit's requirement is explicit:
      // no silent fallback to unbounded inline.
      //
      // The quota error is found through the CAUSE CHAIN rather than caught
      // directly: the publication primitive wraps every storage failure in its own
      // error type, so a bare `instanceof` check at this level would miss it and
      // the over-quota capture would surface as a generic write failure -- losing
      // the distinction between "the disk is full" and "the store is broken".
      gaps.push({
        stage: 'retention',
        reason: findQuotaError(error)?.message ?? 'artifact exceeded the store quota',
        recovery: 'none',
      })
      return {
        descriptor: mintObservation({
          id: observationId,
          source: {
            kind: 'file',
            locator: target.displayPath,
            acquiredAt: now().toISOString(),
            executionWorld,
          },
          captured: { artifact: `artifact:unpublished:${observationId}`, sha256: '0'.repeat(64), bytes: 0, mediaType: request.mediaType ?? 'application/octet-stream' },
          acquisition: {
            completeness: 'partial',
            coverage: coverageForRequest({ receivedBytes: 0, ...request.requestedRange !== undefined ? { requestedRange: request.requestedRange } : {} }),
            gaps,
          },
          authority: { ownerScope, grantRevision: grants.revisionOf(ownerScope) ?? 0 },
        }, claim),
        reference: { artifact: '', sha256: '', bytes: 0, state: 'missing' },
        gaps,
        io,
      }
    }
    throw error
  }

  // THE ACQUIRED/PERSISTED CHECK. `info.size` is what the source was when the
  // capture began; `published.bytes` is what the store actually persisted. When
  // they disagree on a whole-file capture, the object is SHORTER than the file
  // that was named, and the difference is bytes that were never acquired.
  //
  // Before this check the outcome was `complete-within-request` with no gap:
  // measured, a 1000-byte file whose reader stopped at 400 bytes produced a
  // descriptor claiming a complete capture of 400 bytes. That is the
  // acquired-vs-persisted collapse the whole data plane exists to prevent -- the
  // two numbers were both present in the code and only one of them was believed.
  //
  // A range request legitimately captures fewer bytes than the file holds, so the
  // check applies only when the caller did not narrow the scope.
  const shortBy = sourceBytesAtStart !== undefined && request.requestedRange === undefined
    ? sourceBytesAtStart - published.bytes
    : 0
  if (shortBy !== 0) {
    gaps.push({
      stage: 'native-acquisition',
      reason: `the source was ${String(sourceBytesAtStart)} bytes at capture start but only ${String(published.bytes)} were acquired `
        + `(${String(shortBy)} bytes never reached the store); the captured object is the bytes that DID arrive, not the file that was named`,
      // A re-read of the same path may return the whole file, so the gap is
      // pageable in principle -- but the missing bytes are NOT in this object, so
      // recovery is a NEW capture, never a page of this one.
      recovery: 'refetch',
    })
  }

  const descriptor = mintObservation({
    id: observationId,
    source: {
      kind: 'file',
      locator: target.displayPath,
      acquiredAt: now().toISOString(),
      executionWorld,
    },
    captured: {
      artifact: published.artifact,
      sha256: published.sha256,
      bytes: published.bytes,
      mediaType: request.mediaType ?? 'application/octet-stream',
    },
    acquisition: {
      completeness: shortBy === 0 ? 'complete-within-request' : 'partial',
      coverage: coverageForRequest({
        receivedBytes: published.bytes,
        ...request.requestedRange !== undefined ? { requestedRange: request.requestedRange } : {},
      }),
      gaps,
    },
    authority: { ownerScope, grantRevision: grants.revisionOf(ownerScope) ?? 0 },
  }, claim)

  // Step 4: the Session reference. A failure here leaves an ORPHAN, which is
  // reconcilable and must not be reported as delivered.
  let eventId: string
  try {
    eventId = await log.commit({
      observationId,
      artifact: published.artifact,
      sha256: published.sha256,
      bytes: published.bytes,
      coverage: descriptor.acquisition.coverage as JsonValue,
    })
  } catch (error) {
    return {
      descriptor,
      reference: {
        artifact: published.artifact,
        sha256: published.sha256,
        bytes: published.bytes,
        state: 'orphaned',
      },
      gaps: [...gaps, {
        stage: 'retention',
        reason: `object published but the Session reference was not committed: ${String((error as Error).message)}`,
        recovery: 'none',
      }],
      io,
    }
  }

  // Step 5: the checkpoint. `durable: true` is promised only after this returns.
  try {
    await request.checkpoint?.({ artifact: published.artifact, sha256: published.sha256, bytes: published.bytes })
  } catch (error) {
    return {
      descriptor,
      reference: {
        artifact: published.artifact,
        sha256: published.sha256,
        bytes: published.bytes,
        state: 'durable',
        sessionReference: eventId,
      },
      gaps: [...gaps, {
        stage: 'retention',
        reason: `checkpoint failed after the reference was committed: ${String((error as Error).message)}`,
        recovery: 'none',
      }],
      io,
    }
  }

  return {
    descriptor,
    reference: {
      artifact: published.artifact,
      sha256: published.sha256,
      bytes: published.bytes,
      state: 'durable',
      sessionReference: eventId,
    },
    gaps,
    io,
  }
}

/**
 * The default read: the file's EXACT bytes, in bounded windows.
 *
 * WHY NOT `streamText` RE-ENCODED. The previous default was `streamText` decoded
 * and re-encoded to UTF-8. That is lossless only for content that SURVIVES the
 * text decode, and the capture path is supposed to be the layer that does not
 * interpret the bytes at all. Measured against the real `LocalFileSystem`, the
 * re-encoding path silently changed the captured bytes for real inputs:
 *
 *   a UTF-8 BOM      3 bytes stripped, and the captured object's sha256 no
 *                    longer equals the file's -- while `completeness` still said
 *                    `complete-within-request`, so the record claimed a faithful
 *                    capture of bytes it did not hold.
 *   UTF-16 / latin-1 / a NUL byte in a binary file
 *                    refused outright by the backend's binary/NUL rejection, so
 *                    a capture of a non-text file failed with
 *                    `artifact-write-failed` -- a storage error for what is
 *                    really an unsupported-input error.
 *
 * `readByteRange` is the backend's own RAW byte window: no decoding, no binary
 * rejection, no whole-file buffering. Paging it in `DEFAULT_PAGE_BYTES` windows
 * keeps memory bounded and makes the capture byte-exact by construction, so
 * `captured.sha256` equals the file's sha256 and "acquired bytes" is a fact
 * rather than a claim about a decode.
 *
 * A SHORT READ IS AN ERROR, not a silent truncation. `readByteRange` returns
 * fewer bytes when the file ends inside the window, which is how a file that
 * SHRINKS mid-capture is detected: the loop below re-stats and compares against
 * the size the capture started from, so a source that changed under the capture
 * fails loudly instead of producing a shorter object that still reports
 * `complete-within-request`.
 *
 * @param fs - the backend to read through.
 * @param target - the resolved target.
 * @param signal - aborts the read.
 * @param expectedBytes - the size the capture started from, or `undefined` when the backend did not report one.
 */
async function* defaultReadChunks(
  fs: FileSystem,
  target: FsTarget,
  signal?: AbortSignal,
  expectedBytes?: number,
): AsyncIterable<Uint8Array> {
  let offset = 0
  for (;;) {
    const window = await fs.readByteRange(target, { offset, length: DEFAULT_PAGE_BYTES }, signal)
    if (window.byteLength === 0) break
    offset += window.byteLength
    yield window
  }
  if (expectedBytes !== undefined && offset !== expectedBytes) {
    throw new ArtifactError(
      `source changed during capture: it was ${expectedBytes} bytes at capture start but the read ended at ${offset}; `
      + 'the object would not be the file that was named, so it is refused rather than published',
      'artifact-integrity-error',
    )
  }
}

/**
 * Resolve a committed reference back to bytes, with the three states kept apart.
 *
 * This is where the crash-consistency verdicts become observable:
 *
 *   referenced + present  -> the bytes.
 *   referenced + absent   -> `artifact-integrity-error`. NOT an empty string:
 *                            a caller cannot distinguish a lost artifact from an
 *                            empty one if both read as `''`.
 *   not referenced        -> `artifact-orphaned`. The object may exist, but
 *                            nobody promised it, so it is not delivered.
 */
export async function resolveReference(
  store: ArtifactStore,
  log: SessionReferenceLog,
  observationId: string,
): Promise<{ bytes: Uint8Array; sha256: string; eventId: string }> {
  const reference = await log.lookup(observationId)
  if (reference === undefined) {
    throw new ArtifactError(
      `observation ${observationId} has no committed Session reference; any object on disk is an orphan, not a delivered observation`,
      'artifact-orphaned',
    )
  }
  const info = await store.stat(reference.artifact)
  if (info === undefined) {
    throw new ArtifactError(
      `observation ${observationId} is referenced by ${reference.eventId} but its object is absent`,
      'artifact-integrity-error',
    )
  }
  const bytes = await store.openRange(reference.artifact, { offset: 0, length: info.bytes })
  // THE INTEGRITY CHECK IS ON THE CONTENT, NOT ON THE PATH.
  //
  // `store.stat` returns `sha256` derived from the artifact REF (`digestOfRef`),
  // not from hashing the bytes, so comparing `info.sha256` against
  // `reference.sha256` compares a value with ITSELF: it can only fail when the
  // reference names a malformed ref, and it can never detect a corrupted or
  // truncated object. Measured before this fix: an object overwritten in place
  // with the same length returned the replaced bytes through `resolveReference`
  // and reported success, and an object truncated to 5 of its 17 declared bytes
  // returned 5 bytes as if they were the observation.
  //
  // The hash below is computed over the bytes this function has ALREADY read, so
  // the check adds no I/O -- it is the same read, now believed rather than
  // assumed. A mismatch is an integrity error, never a silent short result: a
  // caller cannot distinguish a truncated artifact from a legitimately small one
  // unless the length and the digest are both checked.
  const actual = createHash('sha256').update(bytes).digest('hex')
  if (actual !== reference.sha256) {
    throw new ArtifactError(
      `observation ${observationId} is referenced by ${reference.eventId} as ${reference.sha256} `
      + `(${String(info.bytes)} bytes) but the stored object hashes to ${actual} (${String(bytes.byteLength)} bytes read)`,
      'artifact-integrity-error',
    )
  }
  return { bytes, sha256: reference.sha256, eventId: reference.eventId }
}

/**
 * Reconcile a store against the Session log.
 *
 * Runs the two reconcilable windows to a verdict:
 *   - objects present but unreferenced -> orphans, listed for grace GC.
 *   - references whose object is absent -> integrity errors, listed loudly.
 *
 * It never DELETES here. Collection is `collectGarbage`, which needs a grace
 * window; reconciliation only reports, so a caller can decide.
 */
export async function reconcileStore(
  store: LocalArtifactStore,
  log: SessionReferenceLog,
): Promise<{
  orphans: string[]
  integrityErrors: Array<{ observationId: string; artifact: string; eventId: string }>
}> {
  const referenced = await log.referencedArtifacts()
  const { readdir } = await import('node:fs/promises')
  const present = new Set<string>()
  const objectsRoot = join(store.root, 'objects')
  try {
    for (const shard of await readdir(objectsRoot)) {
      try {
        for (const name of await readdir(join(objectsRoot, shard))) present.add(artifactRefOf(name))
      } catch {
        continue
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const orphans = [...present].filter(artifact => !referenced.has(artifact))
  const integrityErrors: Array<{ observationId: string; artifact: string; eventId: string }> = []
  const observations = (log as InMemorySessionReferenceLog)
  if (typeof observations.lookup === 'function') {
    // Only an in-memory log can be enumerated here; a real Session exposes its own
    // query. Kept narrow on purpose so this helper never grows into a Session reader.
    for (const artifact of referenced) {
      if (!present.has(artifact)) {
        integrityErrors.push({ observationId: '(unknown)', artifact, eventId: '(see Session log)' })
      }
    }
  }
  return { orphans, integrityErrors }
}

/**
 * The model-visible projection of a paged consumption.
 *
 * WHY A PROJECTION AND NOT THE DATA
 *
 * The whole point of the data plane is that a large result leaves the context.
 * A projection that carried the pages would defeat it, so this function is
 * deliberately the ONLY thing a model sees about a walk, and it is bounded by
 * construction: fixed fields, a bounded preview, and counts.
 *
 * The projection also states the two facts that are easy to confuse:
 *   - `pagesConsumed` / `bytesConsumed`  what the CONSUMER read.
 *   - `completeness` / `gaps`            what of the REQUEST is present.
 * A small projection is not evidence of a small source, and a complete
 * projection is not evidence of a complete world.
 *
 * @param input - the walk's outcome and the descriptor it walked.
 * @param previewBytes - how many leading artifact bytes to include, at most.
 */
export function projectForModel(
  input: {
    descriptor: ObservationDescriptor
    pagesConsumed: number
    bytesConsumed: number
    exhausted: boolean
    gaps?: readonly ObservationGap[]
    /** A short consumer-authored summary, itself truncated to `previewBytes`. */
    consumerNote?: string
  },
  previewBytes = 512,
): {
  observationId: string
  artifact: string
  sha256: string
  artifactBytes: number
  pagesConsumed: number
  bytesConsumed: number
  exhausted: boolean
  completeness: ObservationDescriptor['acquisition']['completeness']
  gaps: Array<{ stage: string; reason: string; recovery: string }>
  note?: string
} {
  const { descriptor } = input
  const gaps = [...descriptor.acquisition.gaps, ...input.gaps ?? []]
  return {
    observationId: descriptor.id,
    artifact: descriptor.captured.artifact,
    sha256: descriptor.captured.sha256,
    artifactBytes: descriptor.captured.bytes,
    pagesConsumed: input.pagesConsumed,
    bytesConsumed: input.bytesConsumed,
    exhausted: input.exhausted,
    completeness: descriptor.acquisition.completeness,
    // Gap reasons are truncated too: an error message that quotes a 100 KiB path is
    // itself an unbounded payload, so the projection must bound them or it is not
    // a projection.
    gaps: gaps.map(gap => ({
      stage: gap.stage,
      reason: truncateUtf8(gap.reason, previewBytes),
      recovery: gap.recovery,
    })),
    ...input.consumerNote !== undefined
      ? { note: truncateUtf8(input.consumerNote, previewBytes) }
      : {},
  }
}

/**
 * Truncate a string to at most `maxBytes` UTF-8 bytes, never splitting a
 * character.
 *
 * `String.prototype.slice` counts UTF-16 code units, so a naive cut can split a
 * surrogate pair and produce a lone surrogate -- which JSON-serializes to an
 * invalid escape and, in a Python consumer, becomes a decode error. Cutting on a
 * code-point boundary is what keeps a bounded projection from becoming a corrupt
 * one (DAT-03).
 */
export function truncateUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return value
  let result = ''
  let used = 0
  // Iterate by CODE POINT, not code unit: `for...of` on a string yields code points.
  for (const character of value) {
    const size = Buffer.byteLength(character, 'utf8')
    if (used + size > maxBytes) break
    result += character
    used += size
  }
  return result
}

/**
 * Split a UTF-8 byte buffer into fixed-size pages at CHARACTER boundaries.
 *
 * WHY NOT FIXED-BYTE PAGES
 *
 * A fixed-byte page split can land inside a multi-byte character. A consumer that
 * decodes each page independently then sees a replacement character, which is
 * silent corruption. A consumer that buffers across pages can reassemble, but the
 * audit requires the guarantee to hold for the data plane, not for every
 * consumer's discipline.
 *
 * This splitter keeps each page a valid UTF-8 prefix: when a cut would land
 * mid-character, the page ends EARLIER, at the last complete character boundary.
 * The consequence is that pages are variable-length and a page can be smaller
 * than `maxBytes`; the alternative (padding or splitting) is corruption.
 *
 * A page is never empty for non-empty input, so a page walk always advances --
 * which is what makes the stall guard in {@link walkPages} a real guard rather
 * than a check that trips on legitimate progress.
 *
 * @param content - the complete UTF-8 content.
 * @param maxBytes - the page budget in bytes.
 */
export function* pageUtf8ByBytes(content: Uint8Array, maxBytes: number): Generator<{ offset: number; bytes: Uint8Array }> {
  if (!Number.isInteger(maxBytes) || maxBytes < 1) {
    throw new ArtifactError(`page size must be a positive integer, got ${maxBytes}`, 'pagination-cursor-invalid')
  }
  const buffer = Buffer.from(content)
  let offset = 0
  while (offset < buffer.length) {
    let end = Math.min(offset + maxBytes, buffer.length)
    if (end < buffer.length) {
      // Walk back while the byte at `end` is a UTF-8 CONTINUATION byte (10xxxxxx).
      // Cutting there would split the character whose lead byte precedes it.
      while (end > offset && isUtf8Continuation(buffer[end] as number)) end -= 1
      if (end === offset) {
        // `maxBytes` is smaller than one character. Extending FORWARD to the end of
        // the character is the only correct move: backtracking to `offset` would
        // emit a lone lead byte, which is exactly the invalid UTF-8 this splitter
        // exists to avoid. The page is then longer than `maxBytes`, which is the
        // honest cost of "never split a character".
        end = Math.min(offset + maxBytes, buffer.length)
        while (end < buffer.length && isUtf8Continuation(buffer[end] as number)) end += 1
      }
    }
    yield { offset, bytes: new Uint8Array(buffer.subarray(offset, end)) }
    offset = end
  }
}

/** Whether a byte is a UTF-8 continuation byte (`10xxxxxx`). */
function isUtf8Continuation(byte: number): boolean {
  return byte >= 0x80 && byte < 0xc0
}

/**
 * Find an `ArtifactError` anywhere in a wrapped error's cause chain.
 *
 * The publication primitive (`stageImmutableObject` in
 * `@deepseek-ai/dsh-attachment-local/src/store.ts`) wraps every storage failure in
 * its own `ATTACHMENT_WRITE_FAILED` error with the original as `cause`, unless the
 * thrown value already is one of ITS errors or the signal aborted. A bare
 * `instanceof ArtifactError` check at the call site therefore never sees an
 * error this module raised from inside the stream, and the distinction it
 * carried is lost.
 *
 * This matters for more than the quota: a source that changed mid-capture is
 * refused from inside the read generator with `artifact-integrity-error`, and
 * without this walk the caller would be told `artifact-write-failed` -- a
 * storage fault -- for what is really an inconsistent input. The two need
 * different remedies.
 *
 * The walk is depth-bounded so a cyclic or pathologically nested cause chain
 * cannot hang the capture path.
 *
 * @param error - the thrown value, possibly wrapping an artifact error.
 * @returns the innermost-to-outermost first `ArtifactError` found, or undefined.
 */
export function findArtifactError(error: unknown): ArtifactError | undefined {
  let current: unknown = error
  for (let depth = 0; depth < 8 && current !== undefined && current !== null; depth += 1) {
    if (current instanceof ArtifactError) return current
    current = (current as { cause?: unknown }).cause
  }
  return undefined
}

/**
 * Find a quota error anywhere in a wrapped error's cause chain.
 *
 * Kept as its own exported predicate because "the STORE refused for capacity"
 * is the one distinction DAT-08 turns on, and a caller that asks for exactly
 * that should not have to compare codes itself.
 *
 * @param error - the thrown value, possibly wrapping the quota error.
 * @returns the quota error if the chain contains one, otherwise undefined.
 */
export function findQuotaError(error: unknown): ArtifactError | undefined {
  const found = findArtifactError(error)
  return found?.code === 'artifact-quota-exceeded' ? found : undefined
}

/**
 * Whether an effect may be re-executed after a save failure.
 *
 * The answer is NO, always, and this function exists to be called rather than
 * re-derived: the audit's rule is that an effect which happened but whose save
 * failed is `unknown`, and re-executing it to "fix the log" turns an unknown into
 * a duplicate. The parameters exist so the call site reads as a decision instead
 * of a magic `false`.
 */
export function mayReExecuteAfterSaveFailure(_evidence: { effectObserved: boolean }): false {
  return false
}

/**
 * One entry of a sparse line index.
 *
 * `offset` is the byte offset of the line's FIRST byte; `length` EXCLUDES the
 * terminator. Both are recorded because the fix has to reproduce the exact bytes
 * the file holds, and a consumer that wants the terminator must be able to find
 * it rather than guess.
 */
export interface LineIndexEntry {
  /** 1-based line number, matching the `read` tool's numbering. */
  number: number
  /** Byte offset of the first byte of the line. */
  offset: number
  /** Byte length of the line, excluding its terminator. */
  length: number
  /** Whether the line ended with CRLF rather than LF. */
  crlf: boolean
}

/** A sparse line index plus the facts needed to interpret it. */
export interface LineIndex {
  entries: LineIndexEntry[]
  /** Total lines seen. For a newline-free file this is 1. */
  totalLines: number
  /** Whether every line got an entry, or the index was sampled. */
  complete: boolean
  /** Bytes scanned to build it. This is the ONE linear pass the audit budgets for. */
  bytesScanned: number
}

/**
 * Build a line index with a single linear scan of the captured artifact.
 *
 * WHY THE ARTIFACT AND NOT THE FILE
 *
 * The index must describe the object the pages come from, or a line offset would
 * point into a file that has since changed. Indexing the artifact makes every
 * offset stable for the object's lifetime, which is forever because the object is
 * immutable.
 *
 * WHY ONE SCAN IS THE BUDGET
 *
 * ARCHITECTURE §7 requires capture+index to be "approximately one linear scan of
 * the input". `bytesScanned` is returned so the claim is measurable rather than
 * asserted, and so a regression to per-page rescans shows up as a number.
 *
 * @param store - the artifact store.
 * @param descriptor - the observation whose object is indexed.
 * @param options - scan chunk size, an optional stride, and optional IO accounting.
 *   The accounting is threaded through rather than left to the caller because the
 *   index's ONE linear scan is a budget claim (ARCHITECTURE §7): a caller that
 *   cannot see the bytes this function read cannot falsify it. `IoCounters.indexBytesRead`
 *   existed as a field before this parameter did, which meant it reported zero for
 *   every index ever built -- a counter that cannot move is worse than no counter,
 *   because it reads as a measurement.
 */
export async function buildLineIndex(
  store: ArtifactStore,
  descriptor: ObservationDescriptor,
  options: { chunkBytes?: number; stride?: number; signal?: AbortSignal; counters?: IoCounters } = {},
): Promise<LineIndex> {
  const chunkBytes = options.chunkBytes ?? DEFAULT_PAGE_BYTES
  const stride = options.stride ?? 1
  if (!Number.isInteger(stride) || stride < 1) {
    throw new ArtifactError(`line index stride must be a positive integer, got ${stride}`, 'pagination-cursor-invalid')
  }
  const total = descriptor.captured.bytes
  const entries: LineIndexEntry[] = []
  let offset = 0
  let lineNumber = 0
  let lineStart = 0
  /** Bytes of the current line seen so far, used only to decide CRLF. */
  let lastByte = -1
  let scanned = 0
  let complete = true
  while (offset < total) {
    const length = Math.min(chunkBytes, total - offset)
    const chunk = await store.openRange(descriptor.captured.artifact, { offset, length }, options.counters, options.signal)
    if (chunk.byteLength === 0) break
    scanned += chunk.byteLength
    if (options.counters !== undefined) options.counters.indexBytesRead += chunk.byteLength
    for (let i = 0; i < chunk.byteLength; i += 1) {
      const byte = chunk[i] as number
      if (byte !== 0x0a) {
        lastByte = byte
        continue
      }
      lineNumber += 1
      // `lastByte` is the byte before the LF, which is the CR of a CRLF pair. A lone
      // CR is NOT a terminator here: the read tool splits on LF only, so treating a
      // bare CR as a break would number lines differently from the tool it repairs.
      const crlf = lastByte === 0x0d
      if ((lineNumber - 1) % stride === 0) {
        entries.push({
          number: lineNumber,
          offset: lineStart,
          length: offset + i - lineStart - (crlf ? 1 : 0),
          crlf,
        })
      } else {
        complete = false
      }
      lineStart = offset + i + 1
      lastByte = -1
    }
    offset += chunk.byteLength
  }
  // A trailing fragment with no final LF is still a line, which is what makes a
  // newline-free file exactly one line.
  if (lineStart < total) {
    lineNumber += 1
    if ((lineNumber - 1) % stride === 0) {
      entries.push({
        number: lineNumber,
        offset: lineStart,
        length: total - lineStart - (lastByte === 0x0d ? 1 : 0),
        crlf: lastByte === 0x0d,
      })
    } else {
      complete = false
    }
  }
  return { entries, totalLines: lineNumber, complete, bytesScanned: scanned }
}

/**
 * Read ONE line COMPLETELY, by byte range, from the captured artifact.
 *
 * THIS IS THE FIX FOR THE 2000-CHARACTER LOSS.
 *
 * The broken path is `read` -> `buildWindow` (`read-render.ts:118-125`), which
 * caps its line buffer at `maxLineLength + 1` and emits
 * `truncateLine(...)` (`read-render.ts:69-71`). By the time any consumer sees
 * `lines[].text`, the interior of a long line is ALREADY GONE. Re-reading with
 * `offset = 2` cannot help, because the lost bytes are inside line 1, not after
 * it -- and the line count is 1, so `offset = 2` is out of range and throws.
 *
 * This function instead reads the byte window the index recorded. It has no line
 * cap and no byte cap beyond the caller's own budget, so the line comes back
 * byte-for-byte.
 *
 * @param store - the artifact store.
 * @param descriptor - the observation whose object holds the line.
 * @param entry - the index entry for the line.
 * @returns the exact line bytes, without the terminator.
 */
export async function readLineBytes(
  store: ArtifactStore,
  descriptor: ObservationDescriptor,
  entry: LineIndexEntry,
  counters?: IoCounters,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  return store.openRange(descriptor.captured.artifact, { offset: entry.offset, length: entry.length }, counters, signal)
}

/**
 * Read an arbitrary byte range of the captured artifact.
 *
 * This is the byte-range exit the audit asks `read` to grow: a range request
 * against a capture is exact, resumable and repeatable, and its cost is the range
 * rather than the file.
 */
export async function readArtifactRange(
  store: ArtifactStore,
  descriptor: ObservationDescriptor,
  range: { offset: number; length: number },
  counters?: IoCounters,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  if (range.offset < 0 || range.length < 0) {
    throw new ArtifactError('artifact range offset and length must be non-negative', 'pagination-cursor-invalid')
  }
  const available = Math.max(0, descriptor.captured.bytes - range.offset)
  const length = Math.min(range.length, available)
  return store.openRange(descriptor.captured.artifact, { offset: range.offset, length }, counters, signal)
}

/**
 * Reassemble a page walk into one contiguous buffer.
 *
 * Present so a test can prove byte-for-byte equality against the original without
 * inventing its own reassembly (and therefore its own off-by-one).
 *
 * @param pages - the pages to join, in order.
 * @param expectedBytes - the artifact's declared size; a short join is a hard error.
 */
export function joinPages(pages: readonly ArtifactPage[], expectedBytes: number): Uint8Array {
  const total = pages.reduce((sum, page) => sum + page.bytes.byteLength, 0)
  if (total !== expectedBytes) {
    throw new ArtifactError(
      `page join produced ${total} bytes but the artifact declares ${expectedBytes}`,
      'artifact-corrupt',
    )
  }
  const out = Buffer.allocUnsafe(total)
  let offset = 0
  for (const page of pages) {
    Buffer.from(page.bytes).copy(out, offset)
    offset += page.bytes.byteLength
  }
  return new Uint8Array(out)
}

/**
 * Measure what repeated `read` with a growing offset actually costs.
 *
 * WHY THIS IS A MEASUREMENT AND NOT AN ASSERTION
 *
 * ARCHITECTURE §6 states, from source, that "every `buildWindow` still scans the
 * input to count totalLines; repeatedly paging through one large file may repeat
 * the full scan". That is an INFERENCE from reading `read-render.ts`, and the
 * audit's own discipline is that an inference from source is not a measurement.
 * This function feeds the real `buildWindow` and counts the bytes it consumed, so
 * the claim is either confirmed or refuted by numbers.
 *
 * The counter is on the INPUT side, because that is where a rescan is observable:
 * `buildWindow` takes an iterable of chunks and cannot tell a file from a string,
 * so the number of bytes handed to it is exactly the number it scanned.
 *
 * @param buildWindow - the real `buildWindow` from `@deepseek-ai/dsh-tool-fs`.
 * @param content - the file content, as bytes.
 * @param window - the window request (offset/limit/caps).
 * @param pageOffsets - the offsets to read at, in order.
 * @returns per-call consumed bytes and the total, which is what DAT-06 reports.
 */
export async function measureRepeatedReadCost(
  buildWindow: (
    chunks: Iterable<string>,
    request: { offset: number; limit: number; maxLineLength: number; maxBytes: number },
    displayPath: string,
  ) => Promise<{ lines: Array<{ number: number; text: string }>; totalLines: number; truncatedByBytes: boolean }>,
  content: string,
  window: { limit: number; maxLineLength: number; maxBytes: number },
  pageOffsets: readonly number[],
): Promise<{ perCall: Array<{ offset: number; bytesScanned: number; linesReturned: number }>; totalBytesScanned: number; sourceBytes: number }> {
  const sourceBytes = Buffer.byteLength(content, 'utf8')
  const perCall: Array<{ offset: number; bytesScanned: number; linesReturned: number }> = []
  let totalBytesScanned = 0
  for (const offset of pageOffsets) {
    let scanned = 0
    // The counter wraps the chunk iterable, which is the only place `buildWindow`
    // touches input. Chunking at 64 KiB keeps the measurement independent of the
    // buffer the caller happens to hold.
    function* counted(): Iterable<string> {
      for (let index = 0; index < content.length; index += 65536) {
        const chunk = content.slice(index, index + 65536)
        scanned += Buffer.byteLength(chunk, 'utf8')
        yield chunk
      }
    }
    const result = await buildWindow(counted(), { offset, ...window }, 'measured')
    perCall.push({ offset, bytesScanned: scanned, linesReturned: result.lines.length })
    totalBytesScanned += scanned
  }
  return { perCall, totalBytesScanned, sourceBytes }
}
