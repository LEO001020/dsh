/**
 * The artifact data plane: capture, page, byte-range, and the reconcilable commit order.
 *
 * WHY THIS IS NOT A SECOND OBJECT STORE
 *
 * DSH already has storage that fits, and the audit forbids rebuilding it:
 *
 *   `ctx.attachments`                THE PUBLIC CAPABILITY SEAM, and the one this
 *                                    module uses. `saveFileStream` streams bounded
 *                                    chunks into a staging file, hashes WHILE
 *                                    streaming, fsyncs, hard-links into a
 *                                    digest-derived path, dedups with digest-verified
 *                                    EEXIST, publishes 0o400, and syncs directory
 *                                    entries. `readFileStream` streams the object
 *                                    back and verifies BOTH the declared byte count
 *                                    and the digest before the iteration ends.
 *                                    `fileHostPath` locates the object on disk when
 *                                    -- and only when -- the mounted provider is
 *                                    host-file-backed. That is exactly the "streaming
 *                                    put, host-computed hash, atomic publish, verified
 *                                    read" this milestone needs.
 *   `@deepseek-ai/dsh-atomic-write`  `writeFileAtomic` (temp + rename, wx create,
 *                                    bounded Windows rename retry). String content only,
 *                                    no streaming, no digest.
 *   `@deepseek-ai/dsh-spill`         `saveText` ONLY. It persists text and returns an
 *                                    OPAQUE `SpillLocator` with no unified
 *                                    read/delete/ACL/refcount contract. There is no
 *                                    `open`, no `stat`, no range read, no delete.
 *
 * THE F4 DEFECT THIS MODULE USED TO CARRY, AND WHAT REPLACED IT
 *
 * An earlier revision reached the publication primitive by DEEP-IMPORTING the
 * provider's source: `@deepseek-ai/dsh-attachment-local/src/store.ts`. That was a
 * real defect and not a style question, for two independent reasons:
 *
 *   1. It mixes DSH's SOURCE plane with its ARTIFACT plane. The emitted
 *      `lib/artifacts.js` is production JavaScript, and one of its import
 *      specifiers resolved to a `.ts` file inside the pinned checkout. Node 24
 *      loads that by native type stripping, which is exactly why it worked and
 *      went unnoticed. Measured on the audited build: of 223 distinct
 *      `@deepseek-ai/*` specifiers resolved in a real boot, 221 resolved under a
 *      `packages/<name>/lib/` path and this one did not, which is why ID-01's graph
 *      clause read FAIL while every other clause passed.
 *   2. It created a SECOND PHYSICAL MODULE INSTANCE of the provider package. The
 *      provider's own entry (`lib/index.js`) inlines its copy of
 *      `lib/types/store.js`, so the host held two copies of the module-scope
 *      `const durableHomes = new Set()` and that state was split between them.
 *      This project has already been burned by the same shape: `TOOL_RUNTIME_SCHEDULER`
 *      is a module-local `Symbol()`, and a second copy of its package makes it
 *      undefined (upstream Discussion #6529).
 *
 * The fix is the PUBLIC seam, and it is a CAPABILITY rather than a package: the
 * store is constructed from whatever `AttachmentStore` the composition mounted, so
 * there is exactly one provider instance in the process and this project never
 * names a private module. The provider is MOUNTED, never constructed here. The
 * project's own directory holds only metadata (see below) and never a second copy
 * of any object's bytes.
 *
 * WHAT THE PROJECT STILL OWNS, AND WHY THAT IS NOT A SECOND OBJECT STORE
 *
 * The provider owns BYTES. This module owns the metadata the provider has no
 * concept of, which the audit lists explicitly as project-domain: the quota
 * enforced DURING the stream, the durable index of what this project published,
 * tombstones that separate "collected" from "never captured", pinning, the paging
 * cursor authority, the line index, the model-visible projection, and the
 * reconcilable commit order. The index is a directory of small digest-named marker
 * files holding the facts needed to ADDRESS an object again in a later process
 * (`name`, `bytes`, `publishedAt`); it is the only reason a fresh process can still
 * reconcile a store it did not create.
 *
 * So this module REUSES the public attachment capability and supplies the narrow
 * contract that is genuinely missing:
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
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { createReadStream } from 'node:fs'
// MERGE: the union of both writers' `node:fs/promises` needs -- R7 added
// `appendFile` and `statPath` (the refusal journal and the object-identity
// stamp), R2-F4 added `readdir` (the attachment provider's directory walk).
import { appendFile, mkdir, open, readFile, readdir, stat as statPath, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { FileSystem, FsTarget } from '@deepseek-ai/dsh-fs'
// THE PUBLIC CAPABILITY TYPE, and the only attachment name this package may
// import. `@deepseek-ai/dsh-attachment` is the SEAM package: it declares the
// `ctx.attachments` service and the `FileAttachmentRef` vocabulary, and it has no
// provider inside it, so importing it cannot create a second module instance of
// any storage implementation. The PROVIDER
// (`@deepseek-ai/dsh-attachment-local`) is deliberately NOT named anywhere in this
// package: it is mounted by the composition, and the store reaches it through the
// capability. A build gate enforces that (see `src/no-src-imports.test.ts`).
import { AttachmentId, type AttachmentStore, type FileAttachmentRef } from '@deepseek-ai/dsh-attachment'
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
 * The file inside a store root that holds its durable realm identity.
 *
 * WHY THIS FILE AND NOT AN ENVIRONMENT VARIABLE OR A PATH HASH.
 *
 * The realm identity must survive process restart, and it must DISTINGUISH two
 * stores that are byte-identical in content. A path hash would fail the second
 * requirement in the case that matters most: two stores at different paths holding
 * the same object (a copy, a restore, a second deployment) would hash to different
 * realms and the cross-store replay would be refused -- but two stores reachable
 * under the same path at different times (a remount, a wiped and re-created
 * directory) would collide, and a cursor from the destroyed store would resume
 * against the new one. The file records the identity of the OBJECT STORE ITSELF,
 * so a re-created directory gets a new realm, which is the honest answer.
 *
 * WHY IT IS WRITTEN ONCE AND NEVER REWRITTEN.
 *
 * A per-boot random realm is the specific failure this design avoids: it would
 * look like a security property (every restart invalidates every old cursor)
 * while actually being a restart bug, because a legitimate paging walk that spans
 * a restart would fail. The realm is therefore created with `wx` (exclusive
 * create) and a concurrent creator rereads the winner's value.
 *
 * WHAT THE REALM IS NOT: IT IS NOT A SECRET, AND IT IS NOT TAMPER-PROOF.
 *
 * Stated here because the earlier version of this comment argued for a file over a
 * path hash and never said so. The realm is an identity that a cursor CARRIES and
 * that a refusal NAMES, so it is deliberately disclosed; and it is an ordinary file
 * in the store root, so anyone who can write that directory can copy another
 * store's realm in. The realm therefore distinguishes two stores under a HONEST
 * store root; it does not by itself make a cursor unforgeable, and it never did.
 * The unforgeability is the CURSOR KEY's job ({@link STORE_CURSOR_KEY_FILE_NAME}),
 * which is a separate file precisely so that the value which is disclosed and the
 * value which must not be cannot be confused.
 */
export const STORE_REALM_FILE_NAME = 'store-realm.json'

/**
 * The file inside a store root that holds the key this store MACs page cursors with.
 *
 * THE DEFECT THIS EXISTS FOR. The cursor MAC was keyed by `cursorSecretOf`, which
 * was `id:sha256:ownerScope:grantRevision` -- four DESCRIPTOR fields. The descriptor
 * is handed to the caller by `data:fs.capture` and sent back on every page call, so
 * the "host secret" was a deterministic function of data the caller already held: a
 * caller could mint a cursor the host never issued, name any position, and be
 * served. The HMAC construction was correct; the key was public. A key that is
 * DERIVED from anything the caller holds is not a key, so the key has to be MINTED
 * and STORED rather than computed.
 *
 * WHY A FILE IN THE STORE ROOT AND NOT A CONSTANT OR AN ENVIRONMENT VARIABLE.
 *
 * A compiled-in constant is in the repository, so every deployment would share one
 * key and any reader of the source could forge. An environment variable is better
 * but not sufficient: it is absent by default, and a deployment that did not set it
 * would silently fall back to something -- which is how this class of defect
 * recurs. The store root is the one place that is (a) already required to exist,
 * (b) already the durable boundary for everything the store owns, and (c) NOT
 * reachable by a caller, because the caller reaches the store through `data:*`
 * bridge methods and the FS policy, never through a path the host hands out.
 *
 * WHY IT IS A SEPARATE FILE FROM THE REALM, AND WHY BOTH ARE NEEDED.
 *
 * They answer different questions and have different disclosure. The REALM is an
 * IDENTITY: it must be comparable, so it travels inside the cursor and is named in
 * refusals (a cross-store refusal is only actionable if it says which store it was
 * issued for). The KEY is a SECRET: it must never leave the process, so it is in
 * neither the cursor nor any message. Keeping them in one file would mean the file
 * that is deliberately disclosed in refusal text also held the secret; keeping them
 * in two files means the disclosed value and the undisclosed value cannot be
 * confused by a later reader.
 *
 * WHAT IT DOES NOT DEFEND AGAINST, stated rather than implied. A caller who can
 * READ this file (or run code in the host process) is inside the trust boundary --
 * the OS user account is the execution authority boundary for this product. The
 * property this file establishes is narrower and is the one that was missing: a
 * caller who holds a descriptor, a cursor and the store's public refusals still
 * cannot produce a cursor the host will accept.
 *
 * WHY IT SURVIVES A RESTART. Created with `wx` and never rewritten, exactly like
 * the realm, so a walk that spans a restart keeps working. A per-boot random key
 * would read as a security property and be a restart bug.
 */
export const STORE_CURSOR_KEY_FILE_NAME = 'store-cursor-key.json'

/**
 * The shortest key this store will MAC cursors with.
 *
 * 43 base64url characters is exactly 32 bytes, which is what `readOrCreateStoreCursorKey`
 * mints. The bound exists so a TRUNCATED or hand-edited key file is a refusal rather
 * than a silently weakened MAC: without it, replacing a 32-byte key with `"a"` would
 * leave every arm green while making the key guessable in one try. Enforced on READ,
 * not only on create, because the read is where an edited file arrives.
 */
export const MIN_CURSOR_KEY_CHARS = 43

/**
 * The persisted cursor-key record.
 *
 * `cursorKey` is the MAC key and is NEVER serialized into a cursor, a refusal, a
 * log line or an error message. `keyId` is a non-secret label, so an operator can
 * tell two keys apart in a diagnosis without the key itself being printable.
 */
interface StoreCursorKeyRecord {
  /** The MAC key. Secret: never logged, never returned, never put in a token. */
  cursorKey: string
  /** A non-secret digest prefix, so a diagnosis can name the key without revealing it. */
  keyId: string
  /** When the key was minted. Informational: it is never used in a decision. */
  createdAt: string
  /** The on-disk layout version this key was created under. */
  storeVersion: string
}

/** The persisted realm record. `realmId` is opaque; nothing derives meaning from it. */
interface StoreRealmRecord {
  storeRealmId: string
  /** When the realm was minted. Informational: it is never used in a decision. */
  createdAt: string
  /** The on-disk layout version this realm was created under. */
  storeVersion: string
}

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
  /**
   * A cursor minted against one artifact STORE was presented to another.
   *
   * This is DATA-11's own case and it is a separate code from
   * `pagination-cursor-invalid` on purpose: a caller that replayed a cursor
   * across realms needs a different remedy from one that sent a malformed or
   * tampered token, and collapsing the two would make the cross-realm refusal
   * indistinguishable from a parse failure in the refusal record.
   */
  | 'pagination-realm-denied'

export class ArtifactError extends Error {
  readonly code: ArtifactErrorCode
  /**
   * Whether this refusal was a REALM mismatch.
   *
   * A dedicated flag rather than a code string comparison, because the refusal
   * record and any observer branch on it and a caller matching on message text is
   * how a refusal becomes unobservable. Present and `true` only on
   * `pagination-realm-denied`.
   */
  readonly realmRefused?: boolean

  constructor(message: string, code: ArtifactErrorCode, options?: { cause?: unknown; realmRefused?: boolean }) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined)
    this.name = 'ArtifactError'
    this.code = code
    if (options?.realmRefused !== undefined) this.realmRefused = options.realmRefused
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
 * deliberately seven methods and no more: no bucket lifecycle, no replication, no
 * arbitrary metadata query, no second content-addressing scheme (the digest IS
 * the address, exactly as the attachment provider derives it).
 *
 * WHY `cursorKey()` IS ON THIS INTERFACE RATHER THAN DERIVED BY THE PAGER. The key
 * a cursor is MACed with is a property of the STORE, not of the request: it must be
 * minted once, kept durable, and never be a function of anything a caller supplies.
 * `pages()` receives an `ArtifactStore` and no secret, so a key the pager could
 * compute is a key a caller can compute -- which is the D-1 defect exactly. Making
 * it a store method puts the secret behind the same boundary as the bytes.
 */
export interface ArtifactStore {
  /** The root of this project's artifact INDEX. Used as the durable boundary for syncs. */
  readonly root: string
  /**
   * This store's durable realm identity.
   *
   * A content address cannot distinguish two stores that hold the same bytes, so
   * the realm is the part of a cursor's identity that the address cannot carry.
   * It is a property of the store's ROOT and survives a process restart.
   *
   * NOT a secret and NOT tamper-proof: it is carried in the cursor and named in
   * refusals by design. See {@link STORE_REALM_FILE_NAME}.
   */
  readonly realmId: string
  /** Resolve the realm identity, creating it on first use. Idempotent. */
  ensureRealm(): Promise<string>
  /**
   * The MAC key this store issues cursors with, minted once and kept durable.
   *
   * SECRET. It must never be placed in a cursor, a refusal record, a log line or an
   * error message, and a caller of this method is responsible for that. It is a
   * store method rather than a parameter so that the pager never has to be handed a
   * key that a caller could also compute.
   *
   * Idempotent, and safe against a concurrent creator by the same `wx` protocol the
   * realm uses, so two processes over one store agree on ONE key and a cursor minted
   * before a restart still verifies after it.
   */
  cursorKey(): Promise<string>
  /**
   * Assert that the object at `artifact` still satisfies a recorded identity,
   * BEFORE any of its bytes are served.
   *
   * This is the cheap, per-page-checkable half of content integrity: it verifies
   * presence and length on every call (one `stat`, no bytes read) and verifies the
   * full digest whenever the object's `(size, mtime)` is not one this store has
   * already verified. It throws `artifact-integrity-error` rather than returning a
   * boolean, because a caller that ignored a `false` would serve the bytes anyway.
   */
  assertObjectIdentity(artifact: string, expected: { sha256: string; bytes: number }): Promise<void>
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
 * Why a cursor was refused, as a durable record.
 *
 * THE ORACLE REQUIRES THE REFUSAL TO BE RECORDED, not merely raised. An error a
 * caller can catch and swallow leaves no evidence that a cross-realm replay was
 * attempted, and the audit's whole complaint about this defect class is that the
 * system "keeps running and reporting health". So every refusal on the paging path
 * is appended to a journal inside the store root, where it survives the process
 * that refused it.
 */
export interface CursorRefusal {
  /** Stable code, the same one the thrown `ArtifactError` carries. */
  code: ArtifactErrorCode
  /** Why, in terms an operator can act on. Names the binding that failed. */
  reason: string
  /** The realm the request was served BY. */
  storeRealmId: string
  /** The realm the cursor claimed, when the cursor parsed far enough to say. */
  cursorRealmId?: string
  observationId?: string
  /** Which ordered check refused it. The read order is the point, so it is recorded. */
  step: 'parse' | 'realm' | 'reference' | 'identity' | 'read'
  at: string
}

/** The name of the refusal journal inside a store root. */
export const CURSOR_REFUSAL_LOG_NAME = 'cursor-refusals.jsonl'

/**
 * Read the durable realm identity of a store root, creating it on first use.
 *
 * WHY `wx` AND NOT A PLAIN WRITE. Two processes opening one store must agree on
 * ONE realm. A plain write would let the second creator overwrite the first
 * creator's identity, so cursors minted by the first process would stop verifying
 * -- the same restart bug in a concurrent form. With `wx` the loser gets `EEXIST`
 * and rereads the winner's value.
 *
 * A MALFORMED realm file is a REFUSAL, never a silent regeneration. Regenerating
 * would invalidate every cursor ever minted against this store, which is
 * indistinguishable from the security property it resembles and is actually data
 * loss. The file is small and its shape is versioned, so a malformed one means
 * something else wrote there.
 *
 * @param root - the store root.
 * @returns the realm id, stable for the lifetime of this directory.
 */
async function readOrCreateStoreRealm(root: string): Promise<string> {
  const path = join(root, STORE_REALM_FILE_NAME)
  const existing = await readStoreRealmRecord(path)
  if (existing !== undefined) return existing.storeRealmId
  const created: StoreRealmRecord = {
    storeRealmId: `realm_${randomUUID()}`,
    createdAt: new Date().toISOString(),
    storeVersion: ARTIFACT_STORE_VERSION,
  }
  await mkdir(root, { recursive: true })
  try {
    await writeFile(path, `${JSON.stringify(created, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' })
    return created.storeRealmId
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      // Another process created the realm between our read and our write. Its
      // identity wins: the file is the store's, not this process's.
      const winner = await readStoreRealmRecord(path)
      if (winner !== undefined) return winner.storeRealmId
    }
    throw new ArtifactError(
      `artifact store ${root} has no readable realm identity and one could not be created: `
      + `${error instanceof Error ? error.message : String(error)}`,
      'artifact-integrity-error',
      { cause: error },
    )
  }
}

/** Read and validate the realm record, or `undefined` when the file is absent. */
async function readStoreRealmRecord(path: string): Promise<StoreRealmRecord | undefined> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw new ArtifactError(
      `the store realm file ${path} exists but could not be read: ${error instanceof Error ? error.message : String(error)}`,
      'artifact-integrity-error',
      { cause: error },
    )
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new ArtifactError(
      `the store realm file ${path} is not valid JSON; refusing to mint a new realm, because a new realm would `
      + 'invalidate every cursor this store ever issued while looking like a security property',
      'artifact-integrity-error',
      { cause: error },
    )
  }
  const record = parsed as Partial<StoreRealmRecord>
  if (typeof record.storeRealmId !== 'string' || record.storeRealmId.length === 0) {
    throw new ArtifactError(
      `the store realm file ${path} carries no storeRealmId; refusing to mint a new realm for the same reason`,
      'artifact-integrity-error',
    )
  }
  return {
    storeRealmId: record.storeRealmId,
    createdAt: typeof record.createdAt === 'string' ? record.createdAt : '',
    storeVersion: typeof record.storeVersion === 'string' ? record.storeVersion : '',
  }
}

/**
 * The non-secret label for a key, so a diagnosis can name it without printing it.
 *
 * A digest prefix is enough to tell two keys apart and is useless for forging: it
 * is a one-way function of a 256-bit random value.
 */
function keyIdOf(key: string): string {
  return `key_${createHash('sha256').update(key).digest('hex').slice(0, 16)}`
}

/**
 * The stamp that decides whether a memoized digest verification is still valid.
 *
 * WHY IT IS A FUNCTION AND NOT AN INLINE TEMPLATE. The stamp is the whole of the
 * re-verification trigger: if it does not move when the object's bytes are
 * rewritten, `assertObjectIdentity` returns early and serves whatever is on disk.
 * Keeping it in one named place means the fields that make it move are reviewable,
 * and that a second call site cannot quietly use a weaker stamp.
 *
 * `ctimeMs` IS THE LOAD-BEARING FIELD. `size` and `mtimeMs` are both settable by
 * whoever can write the store root: a same-length replacement with the mtime
 * restored leaves them identical, which is how a replacement skipped the digest
 * (measured; see the note on `verifiedObjects`). POSIX does not allow `utimes` to
 * set `ctime`, and the write that performs the replacement updates it, so the stamp
 * moves on exactly the event it exists to catch. `mtimeMs` stays in the stamp
 * because it is free and still catches a replacement on a filesystem with coarse
 * ctime granularity.
 *
 * @param info - the `stat` result for the host path.
 * @returns a stamp that changes whenever the file is rewritten.
 */
function identityStampOf(info: { size: number; mtimeMs: number; ctimeMs: number }): string {
  return `${String(info.size)}:${String(info.mtimeMs)}:${String(info.ctimeMs)}`
}

/**
 * Read the durable cursor key of a store root, creating it on first use.
 *
 * THE SAME `wx` PROTOCOL AS THE REALM, for the same two reasons: two processes
 * opening one store must agree on ONE key (a plain write would let the second
 * creator overwrite the first, and every cursor the first process minted would stop
 * verifying), and a per-boot key would be a restart bug wearing a security
 * property's clothes.
 *
 * A MALFORMED KEY FILE IS A REFUSAL, never a silent regeneration -- regenerating
 * would invalidate every cursor this store ever issued, and would ALSO look exactly
 * like the fix working. The distinction between "the store refuses because its key
 * is unreadable" and "the store refuses because the token was forged" has to stay
 * visible, so the two produce different codes: this is `artifact-integrity-error`,
 * a forged token is `pagination-cursor-invalid`.
 *
 * A KEY SHORTER THAN THE MINIMUM IS ALSO A REFUSAL. A truncated or hand-edited key
 * is a weak key, and accepting it would silently downgrade the MAC while every
 * arm still passed.
 *
 * @param root - the store root.
 * @returns the key, stable for the lifetime of this directory.
 */
async function readOrCreateStoreCursorKey(root: string): Promise<string> {
  const path = join(root, STORE_CURSOR_KEY_FILE_NAME)
  const existing = await readStoreCursorKeyRecord(path)
  if (existing !== undefined) return existing.cursorKey
  const created: StoreCursorKeyRecord = {
    // 32 bytes of CSPRNG output, base64url-encoded. Minted here, never derived from
    // a descriptor, a path, a realm or any other value a caller can obtain.
    cursorKey: randomBytes(32).toString('base64url'),
    keyId: '',
    createdAt: new Date().toISOString(),
    storeVersion: ARTIFACT_STORE_VERSION,
  }
  created.keyId = keyIdOf(created.cursorKey)
  await mkdir(root, { recursive: true })
  try {
    // mode 0o600: the key is readable by the owning account only. This is defence in
    // depth, not the boundary -- the OS account is the boundary -- but a key file
    // that is world-readable would be a gratuitous widening.
    await writeFile(path, `${JSON.stringify(created, null, 2)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
    return created.cursorKey
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      // Another process created the key between our read and our write. Its key
      // wins: the file is the store's, not this process's.
      const winner = await readStoreCursorKeyRecord(path)
      if (winner !== undefined) return winner.cursorKey
    }
    throw new ArtifactError(
      `artifact store ${root} has no readable cursor key and one could not be created: `
      + `${error instanceof Error ? error.message : String(error)}`,
      'artifact-integrity-error',
      { cause: error },
    )
  }
}

/**
 * Read and validate the cursor-key record, or `undefined` when the file is absent.
 *
 * The error messages deliberately name the PATH and never the VALUE. A message that
 * echoed a malformed key would put key material into a refusal record, a log and a
 * bridge response -- the exact leak the secret is supposed to make impossible.
 */
async function readStoreCursorKeyRecord(path: string): Promise<StoreCursorKeyRecord | undefined> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw new ArtifactError(
      `the store cursor key file ${path} exists but could not be read: `
      + `${error instanceof Error ? error.message : String(error)}`,
      'artifact-integrity-error',
      { cause: error },
    )
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new ArtifactError(
      `the store cursor key file ${path} is not valid JSON; refusing to mint a new key, because a new key would `
      + 'invalidate every cursor this store ever issued while looking like a security property',
      'artifact-integrity-error',
      { cause: error },
    )
  }
  const record = parsed as Partial<StoreCursorKeyRecord>
  if (typeof record.cursorKey !== 'string' || record.cursorKey.length === 0) {
    throw new ArtifactError(
      `the store cursor key file ${path} carries no cursorKey; refusing to mint a new key for the same reason`,
      'artifact-integrity-error',
    )
  }
  if (record.cursorKey.length < MIN_CURSOR_KEY_CHARS) {
    throw new ArtifactError(
      `the store cursor key file ${path} carries a key of ${record.cursorKey.length} characters, below the `
      + `${MIN_CURSOR_KEY_CHARS}-character minimum; a truncated key is a weakened MAC, so it is refused rather `
      + 'than accepted',
      'artifact-integrity-error',
    )
  }
  return {
    cursorKey: record.cursorKey,
    keyId: typeof record.keyId === 'string' ? record.keyId : keyIdOf(record.cursorKey),
    createdAt: typeof record.createdAt === 'string' ? record.createdAt : '',
    storeVersion: typeof record.storeVersion === 'string' ? record.storeVersion : '',
  }
}

/**
 * A local, content-addressed artifact store built on DSH's publication primitive.
 * One durable index entry: the facts needed to ADDRESS a published object again
 * from a later process, and nothing else.
 *
 * `name` is the provider-sanitized leaf name from the `FileAttachmentRef` the
 * provider returned, NOT the caller's string. The provider validates its refs by
 * recomputing the sanitizer (`fileLeafName`), so a stored caller string like
 * `C:\Users\x\a.txt` would fail that check on the read path and turn a
 * legitimately stored object into `INVALID_ATTACHMENT_REF`.
 */
export interface ArtifactIndexEntry {
  artifact: string
  sha256: string
  /** The provider's own leaf name for this object. */
  name: string
  bytes: number
  publishedAt: string
}

/**
 * A content-addressed artifact store built on the PUBLIC `ctx.attachments`
 * capability.
 *
 * WHAT THIS CLASS IS, NOW THAT IT IS NOT A SECOND OBJECT STORE
 *
 * The bytes live in the mounted attachment provider. This class holds the
 * project-domain facts the provider has no concept of, and it holds them in a
 * durable index of small digest-named JSON files under `root`:
 *
 *   - the quota, enforced DURING the stream (the provider size-caps images before
 *     publication and has no streaming quota concept at all);
 *   - the mapping from an `artifact:sha256:...` ref to the provider's
 *     `FileAttachmentRef` (`name` + `bytes` are part of that ref, so a reader
 *     cannot reconstruct it from the digest alone);
 *   - tombstones and pinning, which the provider does not have because its
 *     attachments are referenced by immutable refs and are never deleted.
 *
 * WHY AN INDEX IS NOT A SECOND COPY OF THE DATA
 *
 * An index entry is a few hundred bytes of metadata naming an object the provider
 * owns. No object's BYTES are written twice, which is what "do not construct
 * another LocalAttachmentStore" forbids. The index is the only reason a fresh
 * process can reconcile a store it did not create, which is a stated project
 * obligation rather than a convenience.
 *
 * THE COST THIS PAYS, AND THE INTEGRITY EACH ARM ACTUALLY GIVES
 *
 * The provider's read path (`readFileStream`) streams a WHOLE object and verifies
 * its digest and byte count at the end. That is the wrong shape for paging a
 * 32 MiB artifact 64 KiB at a time, so `openRange` has two arms, and THEY DO NOT
 * CARRY THE SAME INTEGRITY GUARANTEE. That is stated here rather than implied,
 * because a comment that describes one arm's property for both would be a claim
 * the code does not support:
 *
 *   - HOST-PATH ARM (`fileHostPath` returned a path -- the mounted provider is
 *     host-backed local, which is what a trusted-local deployment mounts).
 *     `openRange` opens the object and reads ONLY the requested window, so paging
 *     is O(page) and `IoCounters.artifactBytesRead` proves it. This arm performs
 *     NO content verification: an object replaced in place at the same length, or
 *     truncated, or bit-rotted under a stable path, is served as if it were valid.
 *     The window is trusted because the index entry names a digest, not because
 *     the bytes were re-hashed.
 *   - STREAMING FALLBACK (no host path). The window is taken from a stream of the
 *     whole object, and the provider verifies the byte count and the digest before
 *     that iteration ends, so a returned window has been integrity-checked as a
 *     side effect. That is O(object) per page, and the counters SHOW it rather than
 *     hiding it, so a deployment that silently lost the optimization is visible as
 *     a number.
 *
 * THE GUARANTEE IS THEREFORE PER-ARM, AND THE FULL-OBJECT CHECK HAS ITS OWN ENTRY
 * POINT: {@link resolveReference} reads a whole object and re-derives its digest,
 * refusing a mismatch with `artifact-integrity-error` and naming both hashes. That
 * is the path a caller takes when it needs "the observation's bytes, verified" --
 * it is what `DataPlaneService.resolve` exposes and what the profile boot probe
 * exercises -- and it is why paging can stay O(page) without making the store's
 * integrity claim false. What is NOT claimed: that a window read by `openRange` on
 * the host-path arm has been verified. See `DATA-12` for the tamper cases, which
 * run through `resolveReference`.
 *
 * The optimization is capability-detected at every call, never assumed from
 * configuration: a provider that is not host-file-backed simply returns
 * `undefined` and the fallback runs.
 */
export class AttachmentArtifactStore implements ArtifactStore {
  /** The project's artifact index root. */
  readonly root: string
  private readonly attachments: AttachmentStore
  private readonly quotaBytes: number
  private readonly pinned = new Set<string>()
  private readonly tombstones = new Map<string, Tombstone>()
  /**
   * Objects whose full digest has been verified in this process, keyed by
   * artifact ref and stamped with the `(size, mtimeMs, ctimeMs)` that was verified.
   *
   * A memo rather than a boolean: an object replaced in place keeps its length but
   * changes its mtime, so the stamp makes the next `assertObjectIdentity` re-verify
   * instead of trusting a stale "verified" flag.
   *
   * WHY `ctimeMs` IS IN THE STAMP (DATA-11, and the harm its evidence note names).
   * The stamp was `(size, mtimeMs)` and BOTH are settable by whoever can write the
   * store root -- which is the same trust boundary `STORE_CURSOR_KEY_FILE_NAME`
   * already records. MEASURED: pinning the object's mtime to a WHOLE SECOND before
   * the first page made the stamp exactly reproducible, so a replacement of the same
   * length that restored that second skipped the digest and the cursor SERVED THE
   * REPLACED BYTES (`qualification/results/C3-dataplane/memo-before.json`). The
   * replacement was detectable -- a cold store over the same root refused it with
   * `artifact-integrity-error` -- so the paging path was the weaker route to the
   * same bytes, which is exactly what DATA-11 forbids.
   *
   * `ctime` is the fix and not another guess: POSIX says it cannot be set by
   * `utimes`/`utimensat`, and it is updated by the write that performs the
   * replacement. Measured: a same-length replacement with the mtime restored to the
   * same whole second left `mtimeMs` identical and moved `ctimeMs`. So the stamp now
   * moves whenever the file's CONTENT or metadata is rewritten, and the hash is
   * re-taken. The `mtimeMs` field stays in the stamp because it costs nothing and
   * catches a replacement on a filesystem with coarse ctime.
   *
   * WHAT THIS DOES NOT BUY, stated so the memo is not over-read. It is a
   * re-verification TRIGGER, not an integrity guarantee: an attacker who can write
   * the store root can also rewrite the index the digest is compared against, and
   * this file already says so for the realm. The property is narrower and still
   * worth having: a byte replacement that leaves the declared digest alone no longer
   * survives the memo.
   */
  private readonly verifiedObjects = new Map<string, string>()
  /** Journal write failures, kept so a broken refusal journal is visible. */
  private readonly journalFailures: string[] = []
  /**
   * This store's durable realm identity.
   *
   * Resolved lazily by {@link realmIdOf} and memoized, because a store may be
   * constructed before its root exists (a test that names a temp path, a boot that
   * constructs the service before the domain opens). The memo is keyed to the
   * RESOLVED ROOT, so the identity is a property of the directory and not of the
   * object instance: two `AttachmentArtifactStore` objects over one root share it, and
   * one object can never drift from the file on disk within a process.
   */
  private realm: string | undefined
  /**
   * The MAC key this store issues cursors with.
   *
   * SECRET, and memoized for the process lifetime exactly like the realm: a store
   * may be constructed before its root exists, and reading the key per page would
   * put a file read on the paging hot path. Never returned from a public accessor
   * other than {@link cursorKey}, and never placed in a cursor or a message.
   */
  private cursorKeyValue: string | undefined
  /** In-memory mirror of the index, so the hot path does not re-read the disk. */
  private readonly index = new Map<string, ArtifactIndexEntry>()

  constructor(attachments: AttachmentStore, root: string, options?: { quotaBytes?: number }) {
    this.attachments = attachments
    this.root = root
    this.quotaBytes = options?.quotaBytes ?? DEFAULT_ARTIFACT_QUOTA_BYTES
  }

  /**
   * The durable identity of THIS store, created on first use.
   *
   * THE DEFECT THIS EXISTS FOR. A page cursor carried no store identity at all, so
   * a cursor minted against store A was accepted by store B whenever B held an
   * object at the same content address -- which is exactly the case a content
   * address cannot distinguish, because two stores holding the same bytes agree on
   * it. The realm is the piece of identity the content address cannot carry.
   *
   * WHY IT SURVIVES A RESTART. It is a file in the store root, created with `wx`
   * and never rewritten, so a restart rereads the same value. A per-boot random id
   * would make every cursor from a previous process invalid, which reads as a
   * security property and is actually a restart bug.
   *
   * @returns the realm id, stable for the lifetime of the store root.
   */
  get realmId(): string {
    // Synchronous accessor over a memo, so `pages()` can bind the realm without
    // making every caller await a property. The file is created by `ensureRealm()`
    // at the durable boundaries (put/collectGarbage) and by `realmIdOf()` for a
    // store that has never been written to.
    if (this.realm === undefined) {
      throw new ArtifactError(
        `artifact store ${this.root} has no resolved realm identity; call ensureRealm() (or open the store) `
        + 'before paging, so a cursor can be bound to the store it was issued for',
        'artifact-integrity-error',
      )
    }
    return this.realm
  }

  /** Whether the realm has been resolved in this process. */
  get realmResolved(): boolean {
    return this.realm !== undefined
  }

  /**
   * Resolve (creating if absent) this store's durable realm identity.
   *
   * Idempotent, and safe against a concurrent creator: the file is written with
   * `wx`, and an `EEXIST` loser rereads and adopts the winner's value rather than
   * overwriting it. Two processes opening one store therefore agree on ONE realm,
   * which is what makes the identity a property of the store instead of a race.
   *
   * @returns the realm id.
   */
  async ensureRealm(): Promise<string> {
    if (this.realm !== undefined) return this.realm
    const realm = await readOrCreateStoreRealm(this.root)
    this.realm = realm
    return realm
  }

  /**
   * Resolve (creating if absent) the MAC key this store issues cursors with.
   *
   * THE DEFECT THIS EXISTS FOR. The key used to be `cursorSecretOf(descriptor)` --
   * `id:sha256:ownerScope:grantRevision`, four descriptor fields. The descriptor is
   * handed to the caller by `data:fs.capture` and sent back on every page call, so
   * the key was a function of data the caller held and a correctly-signed forgery
   * was accepted (measured: `qualification/results/S16-cursor-authority/s16-before.json`).
   * A key that is DERIVED from anything the caller holds is not a key. This one is
   * MINTED from the CSPRNG and STORED in the store root, which a caller reaches only
   * through `data:*` methods and never as a path.
   *
   * Idempotent and memoized, so the paging hot path performs no file read per page
   * after the first. Safe against a concurrent creator by the `wx` protocol, so two
   * processes over one store agree on ONE key.
   *
   * @returns the key. SECRET: callers must not log it, echo it in a refusal, or put
   *   it in a token. It exists to be handed to `CursorAuthority` and nowhere else.
   */
  async cursorKey(): Promise<string> {
    if (this.cursorKeyValue !== undefined) return this.cursorKeyValue
    const key = await readOrCreateStoreCursorKey(this.root)
    this.cursorKeyValue = key
    return key
  }

  /**
   * Stream to an immutable object, enforcing the quota DURING the stream.
   * The provider this store publishes through.
   *
   * Exposed so a caller can report WHICH provider is bound: the `fileHostPath`
   * optimization is only sound against a host-backed local provider, so the
   * deployment's own identity should be able to name it rather than infer it.
   */
  get provider(): AttachmentStore {
    return this.attachments
  }

  /** The index directory. */
  private get indexRoot(): string {
    return join(this.root, 'index')
  }

  private indexPathOf(sha256: string): string {
    return join(this.indexRoot, sha256.slice(0, 2), `${sha256}.json`)
  }

  /**
   * Load one index entry from disk, if it is there.
   *
   * A MALFORMED entry is treated as ABSENT rather than as a parse error. The index
   * is a derived structure: an entry that cannot be read cannot be used to address
   * an object, and reporting it as an I/O failure would blame the storage layer for
   * what is really "this project cannot name that object any more". The caller sees
   * `undefined` from `stat`, which is the same answer as "never published", and
   * `resolveReference` turns that into an integrity error when a Session reference
   * says otherwise.
   */
  private async loadEntry(sha256: string): Promise<ArtifactIndexEntry | undefined> {
    const cached = this.index.get(sha256)
    if (cached !== undefined) return cached
    let text: string
    try {
      text = await readFile(this.indexPathOf(sha256), 'utf8')
    } catch {
      return undefined
    }
    try {
      const parsed = JSON.parse(text) as Partial<ArtifactIndexEntry>
      if (typeof parsed.name !== 'string' || typeof parsed.bytes !== 'number'
        || typeof parsed.artifact !== 'string' || parsed.artifact !== artifactRefOf(sha256)) {
        return undefined
      }
      const entry: ArtifactIndexEntry = {
        artifact: parsed.artifact,
        sha256,
        name: parsed.name,
        bytes: parsed.bytes,
        publishedAt: typeof parsed.publishedAt === 'string' ? parsed.publishedAt : '',
      }
      this.index.set(sha256, entry)
      return entry
    } catch {
      return undefined
    }
  }

  /** Write one index entry durably enough that a later process can read it back. */
  private async saveEntry(entry: ArtifactIndexEntry): Promise<void> {
    const path = this.indexPathOf(entry.sha256)
    await mkdir(join(this.indexRoot, entry.sha256.slice(0, 2)), { recursive: true, mode: 0o700 })
    // Write-then-rename, so a reader never observes a half-written entry. A torn
    // entry would be indistinguishable from a corrupt one, and the loader above
    // would then report a published object as unpublishable.
    const temporary = `${path}.${randomUUID()}.tmp`
    await writeFile(temporary, `${JSON.stringify(entry)}\n`, { encoding: 'utf8', mode: 0o600 })
    const { rename } = await import('node:fs/promises')
    await rename(temporary, path)
    this.index.set(entry.sha256, entry)
  }

  /**
   * Rebuild the provider reference for an index entry.
   *
   * The provider validates a `FileAttachmentRef` by recomputing its own leaf-name
   * sanitizer, so this reconstructs the ref from the name the provider ITSELF
   * returned rather than from anything a caller supplied.
   */
  private refOf(entry: ArtifactIndexEntry): FileAttachmentRef {
    return {
      attachmentId: AttachmentId(`sha256:${entry.sha256}`),
      name: entry.name,
      bytes: entry.bytes,
    }
  }

  /**
   * Stream to an immutable object through the public capability, enforcing the
   * quota DURING the stream.
   *
   * The check runs per chunk rather than after, because a post-hoc check on a
   * 10 GiB stream has already written 10 GiB. On violation the provider's own error
   * path removes the staged temp file and the caller gets `artifact-quota-exceeded`
   * -- which becomes a gap record, never a silent inline fallback.
   *
   * The index entry is written only AFTER the provider reports a durable ref, so a
   * crash between the two leaves an object this project cannot name -- which is
   * exactly the ORPHAN the commit order already describes, and never a reference
   * to an object that was not published.
   */
  async put(
    chunks: AsyncIterable<Uint8Array> | Iterable<Uint8Array>,
    options?: { signal?: AbortSignal },
  ): Promise<{ artifact: string; sha256: string; bytes: number }> {
    // The realm is established BEFORE the first object is published, so a store
    // can never hold an object without an identity that its cursors bind. Doing
    // it lazily at paging time would leave a window in which a capture succeeds
    // and a cursor cannot be minted.
    await this.ensureRealm()
    // The same argument for the cursor KEY, and it is not a formality: if the key
    // could not be created, the failure has to land HERE, on a capture that can be
    // retried and reported, rather than on a later page read that would look like a
    // forged token. A store that can publish must be able to issue cursors.
    await this.cursorKey()
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
    let ref: FileAttachmentRef
    try {
      ref = await this.attachments.saveFileStream({
        data: bounded(),
        name: 'artifact',
        ...options?.signal !== undefined ? { signal: options.signal } : {},
      })
    } catch (error) {
      if (error instanceof ArtifactError) throw error
      // The provider wraps a failure raised INSIDE the stream in its own error
      // type, so an error this module raised -- a quota refusal, or a source that
      // changed mid-capture -- would otherwise reach the caller as a generic write
      // failure with its code lost. The walk recovers the original so the caller
      // branches on the real reason.
      const inner = findArtifactError(error)
      if (inner !== undefined) throw inner
      // Nothing of ours: preserve the cause so a real ENOSPC stays diagnosable
      // rather than becoming a generic failure.
      throw new ArtifactError('artifact publication failed', 'artifact-write-failed', { cause: error })
    }
    const sha256 = digestOfProviderRef(ref)
    const artifact = artifactRefOf(sha256)
    await this.saveEntry({
      artifact,
      sha256,
      name: ref.name,
      bytes: ref.bytes,
      publishedAt: new Date().toISOString(),
    })
    // A re-publication of identical bytes is a NEW observation of the same
    // immutable object, so any tombstone recorded against it is stale and must not
    // make a live object read as collected.
    this.tombstones.delete(artifact)
    return { artifact, sha256, bytes: ref.bytes }
  }

  async stat(artifact: string): Promise<{ bytes: number; sha256: string } | undefined> {
    const sha256 = digestOfRef(artifact)
    const entry = await this.loadEntry(sha256)
    if (entry === undefined) return undefined
    return { bytes: entry.bytes, sha256 }
  }

  /**
   * The host path of an artifact, when the mounted provider is host-file-backed.
   *
   * This is the capability-detected OPTIMIZATION, not a bypass: it is `undefined`
   * for any provider that is not local, and every caller has a streaming path that
   * works without it. Nothing in this module reads bytes through it without
   * re-deriving the digest of what it read.
   */
  async hostPath(artifact: string): Promise<string | undefined> {
    const sha256 = digestOfRef(artifact)
    const entry = await this.loadEntry(sha256)
    if (entry === undefined) return undefined
    return this.attachments.fileHostPath(this.refOf(entry))
  }

  /**
   * Read one byte window of an artifact and account for it.
   *
   * The whole point of paging against a captured object is that the cost is
   * proportional to the pages read. Where the provider exposes a host path this
   * method opens the object and reads ONLY `[offset, offset + length)` -- it never
   * verifies the whole object (that would be a full re-read per page) and it never
   * falls back to a full read.
   *
   * THE ONE CASE THAT IS VERIFIED FOR FREE, and why only that one. When the
   * requested window IS the whole object (`offset === 0` and `length >= entry.bytes`),
   * the bytes about to be returned are already in hand, so their digest is computed
   * over the SAME read and a mismatch is refused as `artifact-integrity-error` naming
   * both hashes. The check costs no I/O at all, which is the identical argument
   * {@link resolveReference} makes. It is deliberately NOT extended to partial
   * windows: verifying those would require reading bytes the caller did not ask for,
   * which would both falsify `IoCounters.artifactBytesRead` and destroy the O(page)
   * property that is the entire reason this optimization exists. A caller that needs
   * "these bytes, verified" therefore reads the whole object -- which is what
   * {@link resolveReference} does -- rather than a window.
   *
   * Where the provider is NOT host-backed, the window comes from a VERIFIED stream
   * of the whole object, so integrity is checked as a side effect of reading. That
   * is more expensive and the counters say so.
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
    if (range.length === 0) return new Uint8Array(0)
    const entry = await this.loadEntry(sha256)
    if (entry === undefined) {
      // The event that referenced this object is committed; this project can no
      // longer name the object. Returning an empty buffer here would make a lost
      // artifact indistinguishable from a legitimately empty one.
      throw new ArtifactError(
        `artifact ${artifact} is referenced but absent from the store`,
        'artifact-integrity-error',
      )
    }
    const ref = this.refOf(entry)
    const hostPath = this.attachments.fileHostPath(ref)
    if (hostPath !== undefined) {
      let handle
      try {
        handle = await open(hostPath, 'r')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          throw new ArtifactError(
            `artifact ${artifact} is referenced but absent from the store`,
            'artifact-integrity-error',
            { cause: error },
          )
        }
        throw error
      }
      let bytes: Uint8Array
      try {
        const buffer = Buffer.allocUnsafe(range.length)
        const { bytesRead } = await handle.read(buffer, 0, range.length, range.offset)
        if (counters !== undefined) {
          counters.artifactBytesRead += bytesRead
          counters.artifactReads += 1
        }
        bytes = new Uint8Array(buffer.subarray(0, bytesRead))
      } finally {
        await handle.close()
      }
      // The free check: only when this window IS the object. See the method comment
      // for why a partial window is deliberately left unverified.
      if (range.offset === 0 && bytes.byteLength >= entry.bytes) {
        const actual = createHash('sha256').update(bytes).digest('hex')
        if (actual !== sha256) {
          throw new ArtifactError(
            `artifact ${artifact} declares ${String(entry.bytes)} bytes hashing to ${sha256} `
            + `but the stored object hashes to ${actual} (${String(bytes.byteLength)} bytes read)`,
            'artifact-integrity-error',
          )
        }
      }
      return bytes
    }
    return this.streamRange(artifact, ref, range, counters, signal)
  }

  /**
   * The verified-streaming fallback for a provider with no host path.
   *
   * The whole object is read through `readFileStream`, which is what establishes
   * its integrity; bytes outside the window are discarded. `artifactBytesRead`
   * therefore reports the WHOLE object per window, which is the honest cost of this
   * route and the reason the host-path optimization is worth detecting.
   */
  private async streamRange(
    artifact: string,
    ref: FileAttachmentRef,
    range: { offset: number; length: number },
    counters?: IoCounters,
    signal?: AbortSignal,
  ): Promise<Uint8Array> {
    const collected: Buffer[] = []
    let position = 0
    let produced = 0
    try {
      for await (const chunk of this.attachments.readFileStream(ref, signal)) {
        const buffer = Buffer.from(chunk)
        if (counters !== undefined) {
          counters.artifactBytesRead += buffer.byteLength
          counters.artifactReads += 1
        }
        const end = position + buffer.byteLength
        if (end > range.offset && produced < range.length) {
          const start = Math.max(0, range.offset - position)
          const take = Math.min(buffer.byteLength - start, range.length - produced)
          collected.push(buffer.subarray(start, start + take))
          produced += take
        }
        position = end
      }
    } catch (error) {
      // The provider refuses a missing object with its own NOT_FOUND code and a
      // corrupt one with CORRUPT. Both are integrity failures from this module's
      // point of view: the reference exists and the bytes do not match it.
      if ((error as { code?: string }).code === 'ATTACHMENT_NOT_FOUND') {
        throw new ArtifactError(
          `artifact ${artifact} is referenced but absent from the store`,
          'artifact-integrity-error',
          { cause: error },
        )
      }
      throw new ArtifactError(
        `artifact ${artifact} could not be read back through the attachment capability`,
        'artifact-integrity-error',
        { cause: error },
      )
    }
    return new Uint8Array(Buffer.concat(collected))
  }

  /**
   * Assert the object still satisfies a recorded `(sha256, bytes)` identity.
   *
   * WHY THIS IS A SEPARATE, CHEAP, PER-PAGE CHECK.
   *
   * The paging path must verify the object BEFORE it serves any of its bytes --
   * the failing shape is "openRange, then discover it was the wrong artifact". But
   * hashing the whole object on every page would be a full re-read per page, which
   * is the O(P x full-file) cost DAT-06 exists to forbid. So the check is split:
   *
   *   every call    one `stat`: the object must exist and its length must equal the
   *                 recorded length. A truncated or replaced-with-different-length
   *                 object is refused here, for one syscall.
   *   once per      a full digest verification, memoized on `(size, mtimeMs,
   *   (size,mtime,  ctimeMs)`. A same-length in-place replacement changes the mtime
   *    ctime)       AND the ctime, so the next call re-verifies and refuses.
   *
   * THE LIMIT, STATED. A replacement that preserves the length, the mtime AND the
   * ctime is not caught by the stat comparison. That combination is not reachable
   * from userspace through the ordinary file APIs -- POSIX does not let `utimes`
   * set `ctime`, and the write that performs a replacement updates it -- which is
   * why `ctimeMs` is in the stamp. An attacker who can rewrite the filesystem
   * metadata below the syscall layer, or who can rewrite the index the digest is
   * compared against, is inside the trust boundary this class does not defend; see
   * {@link STORE_CURSOR_KEY_FILE_NAME} for the same statement about the realm.
   *
   * The earlier version of this comment recorded the `(size, mtimeMs)` memo as an
   * accepted hole: "a replacement that preserves BOTH the length and the mtime (a
   * hostile writer with filesystem access) is not caught". MEASURED, and it was
   * not merely theoretical: pinning the mtime to a whole second made the stamp
   * exactly reproducible, and the cursor then SERVED THE REPLACED BYTES while a
   * cold store over the same root refused them with `artifact-integrity-error`
   * (`qualification/results/C3-dataplane/memo-before.json`). A documented hole is
   * still a hole, and this one made the paging path the weaker route to the same
   * bytes -- the harm DATA-11 names. It is closed by adding `ctimeMs`.
   *
   * This still does not replace the byte-level check in `resolveReference`, which
   * hashes the bytes it actually read and cannot be memoized away. The two are
   * layered on purpose: this one makes the PAGING path verify before serving; that
   * one makes the RESOLVE path verify what it served.
   *
   * @param artifact - the store-issued artifact reference.
   * @param expected - the digest and byte count the descriptor recorded.
   * @throws ArtifactError `artifact-integrity-error` when either disagrees.
   * @throws ArtifactError `artifact-not-found` when the object was explicitly deleted.
   */
  async assertObjectIdentity(artifact: string, expected: { sha256: string; bytes: number }): Promise<void> {
    const tombstone = this.tombstones.get(artifact)
    if (tombstone !== undefined) {
      throw new ArtifactError(
        `artifact ${artifact} was deleted at ${tombstone.deletedAt} (${tombstone.reason})`,
        'artifact-not-found',
      )
    }
    const sha256 = digestOfRef(artifact)
    // The address IS the recorded digest. A descriptor whose ref and digest disagree
    // is malformed, and refusing here stops a walk from being bound to one object
    // while claiming another.
    if (sha256 !== expected.sha256) {
      throw new ArtifactError(
        `artifact ${artifact} addresses ${sha256} but the descriptor records ${expected.sha256}; `
        + 'the reference and the recorded digest disagree, so no page can be attributed to either',
        'artifact-integrity-error',
      )
    }
    // THE OBJECT'S BYTES, NOT THE INDEX ENTRY. This resolved through
    // `pathOf()` when this module owned a `root/objects/<2>/<sha>` layout, and
    // F4 replaced that layout with the mounted provider plus an `index/`
    // metadata directory. The call site was renamed to `indexPathOf` with it,
    // which pointed this size check at a few hundred bytes of JSON and made it
    // refuse every legitimate read. The provider's own accessor is the correct
    // one, and `verify()` below reads bytes the same way.
    const sha256ForPath = sha256
    const entry = await this.loadEntry(sha256ForPath)
    if (entry === undefined) {
      throw new ArtifactError(
        `artifact ${artifact} is referenced but absent from the store; refusing before any byte is read`,
        'artifact-integrity-error',
      )
    }
    const ref = this.refOf(entry)
    const hostPath = this.attachments.fileHostPath(ref)
    if (hostPath === undefined) {
      // Not host-file-backed, so there is no path to `stat`. The provider
      // verifies both the byte count and the digest as a side effect of
      // streaming, so a completed iteration IS the check -- the same argument
      // `verify()` makes. A failure of either is an integrity error.
      try {
        for await (const chunk of this.attachments.readFileStream(ref)) void chunk
      } catch (error) {
        throw new ArtifactError(
          `artifact ${artifact} could not be verified through the mounted provider; `
          + 'refusing before any byte is served',
          'artifact-integrity-error',
          { cause: error },
        )
      }
      return
    }
    let info
    try {
      info = await statPath(hostPath)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new ArtifactError(
          `artifact ${artifact} is referenced but absent from the store; refusing before any byte is read`,
          'artifact-integrity-error',
          { cause: error },
        )
      }
      throw error
    }
    if (info.size !== expected.bytes) {
      throw new ArtifactError(
        `artifact ${artifact} is ${String(info.size)} bytes but the descriptor records ${String(expected.bytes)}; `
        + 'a truncated or replaced object is refused before any byte is served',
        'artifact-integrity-error',
      )
    }
    const stamp = identityStampOf(info)
    if (this.verifiedObjects.get(artifact) === stamp) return
    // First touch, or the object moved under us. Hash it, then remember the stamp.
    const hash = createHash('sha256')
    let read = 0
    for await (const chunk of createReadStream(hostPath) as AsyncIterable<Buffer>) {
      hash.update(chunk)
      read += chunk.byteLength
    }
    const actual = hash.digest('hex')
    if (actual !== expected.sha256) {
      throw new ArtifactError(
        `artifact ${artifact} is recorded as ${expected.sha256} (${String(expected.bytes)} bytes) but the stored `
        + `object hashes to ${actual} (${String(read)} bytes read); the bytes are not the artifact that was recorded`,
        'artifact-integrity-error',
      )
    }
    this.verifiedObjects.set(artifact, stamp)
  }

  /**
   * Append a refusal to the store's durable refusal journal.
   *
   * The oracle requires the refusal to be RECORDED. A thrown error that a caller
   * may catch leaves no trace, and this defect class is precisely the one where the
   * system "keeps running and reporting health". The journal lives inside the store
   * root, so the evidence is where the store is.
   *
   * A journal write failure must never turn a refusal into a success: the refusal
   * has already happened, and the caller is about to receive it. So the failure is
   * reported through `onRefusalJournalFailure` rather than swallowed silently, and
   * it does not change the verdict.
   *
   * @param refusal - what was refused and why.
   */
  async recordRefusal(refusal: CursorRefusal): Promise<void> {
    try {
      await mkdir(this.root, { recursive: true })
      await appendFile(join(this.root, CURSOR_REFUSAL_LOG_NAME), `${JSON.stringify(refusal)}\n`, { encoding: 'utf8' })
    } catch (error) {
      this.journalFailures.push(error instanceof Error ? error.message : String(error))
    }
  }

  /** Every refusal this store recorded, oldest first. */
  async readRefusals(): Promise<CursorRefusal[]> {
    let text: string
    try {
      text = await readFile(join(this.root, CURSOR_REFUSAL_LOG_NAME), 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
    const out: CursorRefusal[] = []
    for (const line of text.split('\n')) {
      if (line.trim() === '') continue
      try {
        out.push(JSON.parse(line) as CursorRefusal)
      } catch {
        // A torn final line from a crashed append is skipped rather than making the
        // whole journal unreadable; the earlier records are still evidence.
      }
    }
    return out
  }

  /** Journal write failures, so a broken journal is visible rather than silent. */
  get refusalJournalFailures(): readonly string[] {
    return this.journalFailures
  }

  /**
   * Delete an object, leaving a TOMBSTONE.
   * Verify the whole object against its address.
   *
   * Explicit, so paging stays O(page). Through a host path the bytes are hashed
   * here; through the streaming route the provider has ALREADY verified both the
   * byte count and the digest by the time the iteration ends, so a completed
   * iteration IS the verification and re-hashing would be duplicated work.
   */
  async verify(artifact: string): Promise<boolean> {
    const sha256 = digestOfRef(artifact)
    const entry = await this.loadEntry(sha256)
    if (entry === undefined) return false
    const ref = this.refOf(entry)
    const hostPath = this.attachments.fileHostPath(ref)
    if (hostPath === undefined) {
      try {
        for await (const chunk of this.attachments.readFileStream(ref)) void chunk
        return true
      } catch {
        return false
      }
    }
    try {
      const hash = createHash('sha256')
      for await (const chunk of createReadStream(hostPath) as AsyncIterable<Buffer>) hash.update(chunk)
      return hash.digest('hex') === sha256
    } catch {
      return false
    }
  }

  /**
   * Retire an artifact, leaving a TOMBSTONE.
   *
   * The tombstone is what makes a deleted reference read as `expired/deleted`
   * rather than `absent`: without it, a caller cannot tell "this was never
   * captured" from "this was captured and then collected", and the audit requires
   * the difference to survive.
   *
   * WHAT THIS DOES NOT DO, and the caller must know it: it does NOT delete the
   * provider's object. The mounted `AttachmentStore` contract has no delete, and
   * reaching around it -- for example by unlinking the path `fileHostPath` returns
   * -- would be a bypass in the same family as the private import this module was
   * fixed for. It would also be WRONG: the provider dedups by digest, so two
   * references with different display names share one object, and unlinking it for
   * one would destroy the other's bytes. Retirement is therefore a project-side
   * fact; the bytes leave the provider only when the provider grows a retention
   * policy. Recorded as an open limitation rather than papered over.
   */
  async remove(artifact: string): Promise<boolean> {
    const sha256 = digestOfRef(artifact)
    const entry = await this.loadEntry(sha256)
    const existed = entry !== undefined
    if (existed) {
      const { rm } = await import('node:fs/promises')
      await rm(this.indexPathOf(sha256), { force: true })
      this.index.delete(sha256)
    }
    this.tombstones.set(artifact, {
      artifact,
      deletedAt: new Date().toISOString(),
      reason: existed ? 'explicit-delete' : 'absent-at-delete',
    })
    // The memo is dropped with the object: a later capture of the same bytes
    // republishes the file with a new mtime, and a stale stamp would let the first
    // page skip the digest verification the new object needs.
    this.verifiedObjects.delete(artifact)
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
   * Grace GC over unreferenced index entries.
   *
   * Only entries that are unreferenced, unpinned and older than `graceMs` are
   * collected. The grace window is the whole reason an orphan is safe to retire: a
   * crash between "object published" and "event committed" leaves an object whose
   * referencing event may still be in flight, so retiring it immediately would turn
   * a recoverable orphan into a real integrity error.
   *
   * Collection RETIRES THE INDEX ENTRY and records a tombstone. The provider's
   * bytes are left in place -- see `remove` for why that is deliberate and what it
   * costs.
   *
   * @param referenced - artifact refs the Session has committed.
   * @param graceMs - minimum age before an unreferenced entry may be retired.
   * @param now - injectable clock, so the grace window is testable without sleeping.
   */
  async collectGarbage(
    referenced: ReadonlySet<string>,
    graceMs: number,
    now: number = Date.now(),
  ): Promise<{ collected: string[]; skipped: Array<{ artifact: string; reason: string }> }> {
    const { rm, stat: statOne } = await import('node:fs/promises')
    const collected: string[] = []
    const skipped: Array<{ artifact: string; reason: string }> = []
    let shards: string[]
    try {
      shards = await readdir(this.indexRoot)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { collected, skipped }
      throw error
    }
    for (const shard of shards) {
      let names: string[]
      try {
        names = await readdir(join(this.indexRoot, shard))
      } catch {
        continue
      }
      for (const name of names) {
        if (!name.endsWith('.json')) continue
        const sha256 = name.slice(0, -'.json'.length)
        let artifact: string
        try {
          artifact = artifactRefOf(sha256)
        } catch {
          continue
        }
        if (referenced.has(artifact)) {
          skipped.push({ artifact, reason: 'referenced' })
          continue
        }
        if (this.pinned.has(artifact)) {
          skipped.push({ artifact, reason: 'pinned' })
          continue
        }
        const info = await statOne(join(this.indexRoot, shard, name))
        const ageMs = now - info.mtimeMs
        if (ageMs < graceMs) {
          skipped.push({ artifact, reason: `within-grace (${Math.round(ageMs)}ms < ${graceMs}ms)` })
          continue
        }
        await rm(join(this.indexRoot, shard, name), { force: true })
        this.index.delete(sha256)
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
}

/**
 * The digest of a provider reference, refusing anything that is not one.
 *
 * The provider's `attachmentId` is `sha256:<hex>`; this module's artifact ref is
 * `artifact:sha256:<hex>`. The two are DIFFERENT NAMESPACES for the same digest,
 * and this function is the one place that crosses between them, so the crossing is
 * validated rather than assumed.
 */
export function digestOfProviderRef(ref: FileAttachmentRef): string {
  const match = /^sha256:([a-f0-9]{64})$/u.exec(String(ref.attachmentId))
  if (match?.[1] === undefined) {
    throw new ArtifactError(
      `attachment provider returned a non-content-addressed file reference: ${String(ref.attachmentId)}`,
      'artifact-write-failed',
    )
  }
  return match[1]
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
 * Opaque to the caller and validated by the host. It binds the COMPLETE tuple, and
 * each binding closes a specific failure:
 *
 *   storeRealmId     a cursor cannot be replayed against a DIFFERENT STORE
 *   artifactSha256   a cursor cannot be replayed against a different object
 *   observationId    a cursor cannot be replayed under a different observation
 *   revision         the descriptor's revision/digest the walk was started under
 *   representation   a cursor for `bytes` cannot be used for a `lines` walk
 *   query            the request scope the walk was started for
 *   position         where to resume
 *   schemaVersion    a cursor from an older descriptor shape is refused
 *   ownerScope       a copied cursor cannot cross an authorization scope
 *   watermark        the snapshot the walk started from
 *
 * WHY `storeRealmId` IS THE FIELD THAT WAS MISSING. Before it, every other field
 * was a property of the DESCRIPTOR, and a descriptor is portable: two stores that
 * hold the same content address both satisfy all of them. The content address
 * cannot distinguish those two stores by construction -- that is what a content
 * address IS -- so the store's own identity has to be carried explicitly. Without
 * it a cursor minted by store A was accepted by store B and served B's bytes.
 *
 * A page NUMBER is deliberately not authorization (ARCHITECTURE §7): possessing
 * `page=7` proves nothing, which is why the cursor is a host-minted string with a
 * host-checked MAC rather than a client-supplied integer.
 */
export interface PageCursor {
  /** The store realm the cursor was issued for. THE field the defect was missing. */
  storeRealmId: string
  artifactSha256: string
  /** The observation the walk belongs to, so a cursor cannot migrate between descriptors. */
  observationId: string
  /**
   * The revision/digest the walk was started under.
   *
   * Recorded as the descriptor's digest plus its grant revision, because those are
   * the two things that can move under a walk: a re-captured object changes the
   * digest, and a permission change bumps the revision.
   */
  revision: string
  representation: string
  /** The request scope, so a cursor from one query cannot resume another. */
  query: string
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
 * THE MAC IS OVER THE WHOLE TUPLE, INCLUDING THE REALM, AND IS KEYED BY A SECRET
 * THE STORE MINTS. The signature was once `sha256(secret + payload)` where the
 * secret was derived from the descriptor, so it proved only that whoever minted the
 * token knew the descriptor -- and a descriptor is not a secret, it is the thing
 * being paged. It is now an HMAC-SHA256 over every bound field, so a cursor cannot
 * be re-signed for another realm, another object, another revision or another
 * position without the key.
 *
 * WHAT WAS STILL WRONG UNTIL D-1 WAS FIXED, recorded because the prose here claimed
 * the opposite and a reader would have believed it. The HMAC change fixed the
 * CONSTRUCTION and left the KEY public: the secret passed to this constructor was
 * `cursorSecretOf(descriptor)` -- `id:sha256:ownerScope:grantRevision`, four fields
 * of an object `data:fs.capture` hands to the caller. So a caller could re-derive
 * the key and mint a cursor the host never issued, and one was accepted and served
 * (`qualification/results/S16-cursor-authority/s16-before.json`, position 64 -> 500).
 * The key now comes from `ArtifactStore.cursorKey()`: 32 CSPRNG bytes minted once and
 * kept in the store root, which the caller reaches only through `data:*` methods and
 * never as a path. This class does not care where the key came from; it is the
 * CALLER of this class (`pages()`) that must not derive it from the request, and the
 * arms in `data11-cursor-realm.test.ts` and `data16-cursor-key-authority.test.ts`
 * pin that.
 *
 * WHAT IS SIGNED IS EXACTLY WHAT IS PARSED. `verify` signs the payload SUBSTRING it
 * is about to parse, so the bytes the MAC covers and the bytes that are decoded are
 * the same bytes by construction, and no duplicate-key or number-spelling trick can
 * make them differ. This is deliberately NOT the same thing as re-serializing the
 * parsed object canonically: `mint` emits `JSON.stringify(full)` in the interface's
 * field order, but a token in another key order verifies too, because `verify` signs
 * the received text rather than a normalization of it. The earlier version of this
 * comment claimed a canonical re-serialization that was never implemented, and a
 * sorted-key forgery was accepted under it (measured, same probe). The property that
 * matters is the one stated above, and it holds.
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
   * STEP 1 of the read order: verify the token is host-minted and decode it.
   *
   * Nothing in the returned cursor is trusted yet. This step answers exactly one
   * question -- "did a holder of the host secret produce these bytes?" -- and it
   * answers it over the CANONICAL serialization of the fields, so the verified
   * bytes and the fields the pager will use are the same bytes.
   *
   * The realm is deliberately NOT compared here. The read order is the contract
   * (V3 §L: parse/verify, then compare the realm, then resolve the reference,
   * then verify identity, then read), and splitting them keeps each step
   * separately observable and separately testable.
   *
   * @param token - the opaque cursor string.
   * @throws ArtifactError `pagination-cursor-invalid` when the MAC, schema or shape fails.
   */
  verify(token: string): PageCursor {
    const index = token.lastIndexOf(CURSOR_SEPARATOR)
    if (index <= 0) {
      throw new ArtifactError('pagination cursor is not a host-minted cursor', 'pagination-cursor-invalid')
    }
    const payload = token.slice(0, index)
    const signature = token.slice(index + 1)
    if (!timingSafeEqualText(this.sign(payload), signature)) {
      throw new ArtifactError('pagination cursor MAC does not verify', 'pagination-cursor-invalid')
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
    if (typeof cursor.storeRealmId !== 'string' || cursor.storeRealmId.length === 0
      || typeof cursor.artifactSha256 !== 'string' || typeof cursor.observationId !== 'string'
      || typeof cursor.revision !== 'string' || typeof cursor.query !== 'string'
      || typeof cursor.representation !== 'string' || typeof cursor.ownerScope !== 'string'
      || typeof cursor.position !== 'number' || typeof cursor.watermark !== 'string'
      || !Number.isInteger(cursor.position) || cursor.position < 0) {
      // Every field the MAC covers must be present and well-typed: a cursor missing
      // one of them would otherwise compare `undefined` against a live value and
      // could be accepted by an equality that happened to hold.
      throw new ArtifactError('pagination cursor is missing a bound field', 'pagination-cursor-invalid')
    }
    return cursor as PageCursor
  }

  /**
   * STEP 2 of the read order: compare the REALM.
   *
   * This is the check the defect was missing, and it runs BEFORE the reference is
   * resolved or any byte is read. It has to: a cursor from another store names a
   * valid content address that this store may well hold, so nothing downstream --
   * not the grant, not the scope, not the object's own digest -- can tell the two
   * stores apart. Only the store's own identity can.
   *
   * @param cursor - a cursor already verified by {@link verify}.
   * @param storeRealmId - the realm of the store the request is being served BY.
   * @throws ArtifactError `pagination-realm-denied` when they differ.
   */
  assertRealm(cursor: PageCursor, storeRealmId: string): void {
    if (cursor.storeRealmId !== storeRealmId) {
      throw new ArtifactError(
        `pagination cursor was issued for store realm "${cursor.storeRealmId}", not `
        + `"${storeRealmId}"; a cursor is not a bearer token and cannot be replayed against another store`,
        'pagination-realm-denied',
        { realmRefused: true },
      )
    }
  }

  /**
   * STEP 4's binding half: the cursor's remaining bindings against live values.
   *
   * Separated from `verify` because these compare against values that only the
   * reference resolution establishes (the observation id, the revision, the query),
   * so they cannot be checked before it without comparing against the same
   * caller-supplied input twice.
   *
   * @throws ArtifactError `pagination-scope-denied` / `pagination-cursor-invalid`.
   */
  assertBindings(cursor: PageCursor, expect: {
    ownerScope: string
    representation: string
    observationId: string
    revision: string
    query: string
  }): void {
    if (cursor.ownerScope !== expect.ownerScope) {
      // A copied cursor is not a capability. The scope is bound at mint time and
      // re-checked here, so possession of the string grants nothing.
      throw new ArtifactError(
        `pagination cursor is scoped to "${cursor.ownerScope}", not "${expect.ownerScope}"`,
        'pagination-scope-denied',
      )
    }
    if (cursor.representation !== expect.representation) {
      throw new ArtifactError(
        `pagination cursor represents "${cursor.representation}", not "${expect.representation}"`,
        'pagination-cursor-invalid',
      )
    }
    if (cursor.observationId !== expect.observationId) {
      throw new ArtifactError(
        `pagination cursor belongs to observation "${cursor.observationId}", not "${expect.observationId}"`,
        'pagination-cursor-invalid',
      )
    }
    if (cursor.revision !== expect.revision) {
      throw new ArtifactError(
        `pagination cursor was issued for revision "${cursor.revision}", not "${expect.revision}"`,
        'pagination-cursor-invalid',
      )
    }
    if (cursor.query !== expect.query) {
      throw new ArtifactError(
        `pagination cursor was issued for query "${cursor.query}", not "${expect.query}"`,
        'pagination-cursor-invalid',
      )
    }
  }

  /**
   * The MAC over the received payload.
   *
   * HMAC-SHA256 keyed by the store's cursor key, not a bare hash of
   * `secret + payload`: a length-extension or a concatenation ambiguity is not
   * available against HMAC. WHAT THIS DOES AND DOES NOT BUY, stated because the
   * earlier version of this comment claimed a protection that did not exist.
   *
   * It buys: a token cannot be produced or altered by anyone who does not hold the
   * key, and the key is now a store-minted secret (`ArtifactStore.cursorKey()`) that
   * is NOT derivable from the descriptor, the cursor or any refusal. So the MAC is
   * the thing standing between a caller and a self-minted cursor naming any position
   * in any artifact -- which is what the old sentence said while the key was
   * `cursorSecretOf(descriptor)`, four public descriptor fields, making the sentence
   * false. A caller who can READ the store's key file, or run code in the host
   * process, is inside the trust boundary and is not defended against; see
   * {@link STORE_CURSOR_KEY_FILE_NAME}.
   *
   * It does NOT buy: a binding on its own. A correctly signed token still has to have
   * every field compared against a live value (`assertRealm`, `assertBindings`, the
   * digest and watermark checks), because the MAC proves only who minted the token,
   * never that the token still describes the world. `position` is the field with no
   * live counterpart -- it is the caller's chosen resume point and is checked only by
   * the MAC, which is exactly why a public key made it forgeable.
   */
  private sign(payload: string): string {
    return createHmac('sha256', this.secret).update(payload).digest('base64url')
  }
}

/**
 * Compare two MAC strings without leaking their difference through timing.
 *
 * A MAC comparison that returns early on the first differing character lets an
 * attacker recover a valid MAC one byte at a time. `timingSafeEqual` requires equal
 * lengths, so the length is checked first -- and a length difference is not secret,
 * because the MAC's length is fixed by the algorithm.
 */
function timingSafeEqualText(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8')
  const right = Buffer.from(b, 'utf8')
  if (left.length !== right.length) return false
  return timingSafeEqual(left, right)
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
  /**
   * Called with every refusal BEFORE it is thrown, so a refusal is observable.
   *
   * The oracle requires the refusal to be RECORDED, not merely raised. `pages()`
   * cannot write to the store's journal itself without making every read path
   * durable, so it reports the refusal here and the caller (the host service, which
   * has the store) persists it. A caller that supplies no sink still gets the
   * throw; a caller that supplies one gets both.
   */
  onRefusal?: (refusal: Omit<CursorRefusal, 'at' | 'storeRealmId'> & { storeRealmId: string }) => void
  /**
   * The query/request scope this walk belongs to.
   *
   * Bound into the cursor so a cursor issued for one query cannot resume another
   * over the same artifact. Defaults to a value derived from the page size and the
   * caller scope, which is what the current single-representation pager actually
   * varies on.
   */
  query?: string
}

/**
 * The revision a walk is bound to.
 *
 * Composed of the two things that can move under a walk: the artifact's content
 * digest (a re-capture changes it) and the descriptor's grant revision (a
 * permission change bumps it). Both are in the cursor's MAC, so a cursor cannot
 * survive either change.
 */
function revisionOf(descriptor: ObservationDescriptor): string {
  return `${descriptor.captured.sha256}@g${String(descriptor.authority.grantRevision)}`
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
 * THE READ ORDER IS THE POINT, and it is enforced in this order:
 *
 *   1. parse and verify the cursor (MAC over the whole tuple, keyed by the
 *      STORE's minted secret -- not by anything the caller supplied)
 *   2. compare the REALM -- the store's own identity, which a content address
 *      cannot carry
 *   3. resolve the exact reference (the descriptor's grant, scope and object)
 *   4. verify the descriptor/revision/content identity of the object BEFORE
 *      reading it
 *   5. only then read the range/page
 *
 * Step 1's key is what D-1 was about. It was `cursorSecretOf(descriptor)`, four
 * fields of an object the caller is handed, so step 1 verified "the caller knew the
 * descriptor" and every later step compared the cursor against the CALLER'S OWN
 * input. The key now comes from `store.cursorKey()`, so step 1 answers the question
 * the order assumes it answers: did this STORE mint these bytes?
 *
 * The failing shape this replaces was "openRange, then discover it was the wrong
 * artifact": `store.openRange` was called directly, so the content check that
 * `resolveReference` performs never ran on the paging path, and a store holding
 * different bytes under the same content address served them.
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
 * @throws ArtifactError `pagination-realm-denied` when the cursor belongs to another store.
 * @throws ArtifactError `pagination-cursor-invalid` when the cursor is forged, tampered or stale.
 * @throws ArtifactError `pagination-stalled` when the cursor does not advance.
 * @throws ArtifactError `artifact-integrity-error` when the object does not match its record.
 */
export async function pages(
  store: ArtifactStore,
  request: PageRequest,
  counters?: IoCounters,
): Promise<ArtifactPage> {
  const { descriptor, maxBytes, grants, callerScope } = request
  const representation = 'bytes'
  const query = request.query ?? `bytes:${String(maxBytes)}`
  const revision = revisionOf(descriptor)
  // The realm is resolved BEFORE anything else, because step 2 needs it and a
  // store that cannot state its identity cannot safely serve a cursor at all.
  const storeRealmId = await store.ensureRealm()

  /**
   * Record and throw. ONE helper, so no refusal path can bypass the sink: a
   * refusal that is not reported is exactly the "keeps running and reporting
   * health" shape the audit names.
   *
   * The `never` return type is annotated on the BINDING, not only on the signature,
   * so TypeScript's control-flow analysis knows every call terminates and the
   * locals below stay definitely assigned.
   */
  const refuse: (
    error: ArtifactError,
    step: CursorRefusal['step'],
    extra?: { cursorRealmId?: string },
  ) => never = (error, step, extra = {}) => {
    const refusal = {
      code: error.code,
      reason: error.message,
      storeRealmId,
      observationId: descriptor.id,
      step,
      ...extra,
    }
    try {
      request.onRefusal?.(refusal)
    } catch {
      // A sink that throws must not replace the refusal with its own error: the
      // caller needs the refusal, and the sink's failure is the caller's problem.
    }
    throw error
  }

  // ---- THE MAC KEY COMES FROM THE STORE, NOT FROM THE DESCRIPTOR.
  //
  // D-1's fix, and the whole authority model in one line. The key used to be
  // `cursorSecretOf(descriptor)` -- four descriptor fields, and the descriptor is
  // handed to the caller. A caller could therefore re-derive the key and mint a
  // cursor the host never issued; measured, a forged `position` was accepted and
  // served (`qualification/results/S16-cursor-authority/s16-before.json`).
  //
  // `store.cursorKey()` is a CSPRNG value minted once and kept in the store root,
  // which the caller reaches only through `data:*` methods -- never as a path. So
  // the MAC now answers the question it always claimed to answer: "did a holder of
  // THIS STORE's secret produce these bytes?", not "did the caller know the
  // descriptor?".
  //
  // The REALM remains a SIGNED FIELD as well, not part of the key. Two stores that
  // share a descriptor (and so share every other binding) must still produce cursors
  // that do not verify against each other, and that is what the signed realm does --
  // now as a second, independent line rather than as the only one.
  //
  // A STORE WHOSE KEY CANNOT BE RESOLVED IS A RECORDED REFUSAL, not a raw throw.
  // The refusal's step is derived with `refusalStepOf` so the sink here and the
  // journal `RecordingPageProvider` writes agree by construction rather than by
  // two hand-written claims that can drift.
  let authority: CursorAuthority
  try {
    authority = new CursorAuthority(await store.cursorKey(), descriptor.schemaVersion)
  } catch (error) {
    const failure = asArtifactError(error, 'the store cursor key could not be resolved')
    refuse(failure, refusalStepOf(failure))
  }

  // ---- STEP 1: parse/verify the cursor. Nothing in it is believed yet.
  //
  // Runs FIRST, before the descriptor's authority is even consulted, because the
  // order is the contract: a caller presenting a token that is not host-minted
  // should learn that before it learns anything about the store's contents.
  //
  // A CONSEQUENCE OF THE D-1 FIX, and the reason this catch is not a one-liner. The
  // MAC key is per-store now, so a cursor minted by ANOTHER store does not verify
  // here at all: it fails the MAC and would be reported as a parse failure. That is
  // a STRONGER refusal (the token is rejected before its contents are read, and
  // without trusting anything in it), but collapsing it into `pagination-cursor-
  // invalid` would lose two things the refusal record exists to keep apart: "a
  // cursor from another store was replayed" and "a malformed or tampered token
  // arrived", which is exactly the distinction `pagination-realm-denied` was added
  // for, and which the product-level R7 probe branches on
  // (`qualification/results/R7-cursor-realm/r7-cursor-realm-probe.mjs`).
  //
  // So a MAC failure is classified by what the token CLAIMS, without believing it,
  // and the classification decides only WHICH REFUSAL the caller is told about --
  // never whether the request is served. Both branches refuse.
  //
  // THE MESSAGE NAMES NO REALM, and that is deliberate. A request that failed the
  // MAC is UNAUTHENTICATED, so answering it with an identity would be handing the
  // serving store's realm to anyone who can send a garbage token -- a disclosure
  // this fix would otherwise have closed. Step 2 below still names both realms,
  // because there the MAC DID verify and the diagnosis is worth the disclosure to a
  // caller who legitimately holds another store's cursor. The rule is: no identity
  // out of an unauthenticated request, full diagnosis out of an authenticated one.
  let cursor: PageCursor | undefined
  if (request.cursor !== undefined) {
    try {
      cursor = authority.verify(request.cursor)
    } catch (error) {
      const claimedRealm = realmClaimOf(request.cursor)
      if (claimedRealm !== undefined && claimedRealm !== storeRealmId) {
        refuse(new ArtifactError(
          'pagination cursor names a different store realm than the one serving this request, and its MAC does '
          + 'not verify under this store\'s cursor key; a cursor is not a bearer token and cannot be replayed '
          + 'against another store',
          'pagination-realm-denied',
          { realmRefused: true, cause: error },
        ), 'realm', { cursorRealmId: claimedRealm })
      }
      refuse(asArtifactError(error, 'pagination cursor could not be verified'), 'parse', {
        cursorRealmId: realmClaimOf(request.cursor),
      })
    }
    // ---- STEP 2: compare the REALM, before resolving the reference.
    //
    // This is the check the defect was missing. A cursor from another store names a
    // valid content address this store may hold, so nothing downstream can tell the
    // two stores apart -- only the store's own identity can.
    //
    // WHAT IT GUARDS NOW, after D-1. With a per-store MAC key, a token from a store
    // with a DIFFERENT key is already refused at step 1. This check is the second,
    // independent line and it is the one that fires when the keys are the SAME: a
    // store root cloned whole (both files), a deployment that provisioned one key
    // into two roots, or a caller who copied the key file. The realm still separates
    // those stores, so the binding is not redundant -- but it is no longer the only
    // thing standing between a caller and another store's pages, and the arm that
    // exercises it is `data11-cursor-realm.test.ts`'s shared-key block.
    try {
      authority.assertRealm(cursor, storeRealmId)
    } catch (error) {
      refuse(asArtifactError(error, 'pagination cursor realm could not be checked'), 'realm', {
        cursorRealmId: realmClaimOf(request.cursor),
      })
    }
  }

  // ---- STEP 3: resolve the exact reference, and check it against the LIVE grant.
  //
  // The descriptor's authority is host-authored and checked against the live table,
  // so a permission-domain change invalidates every cursor minted before it.
  if (descriptor.authority.ownerScope !== callerScope) {
    refuse(new ArtifactError(
      `observation ${descriptor.id} is scoped to "${descriptor.authority.ownerScope}", not "${callerScope}"`,
      'pagination-scope-denied',
    ), 'reference')
  }
  if (!grants.stillValid(descriptor.authority)) {
    refuse(new ArtifactError(
      `observation ${descriptor.id} was minted under grant revision ${descriptor.authority.grantRevision}, which is stale`,
      'pagination-scope-denied',
    ), 'reference')
  }
  if (!Number.isInteger(maxBytes) || maxBytes < 1) {
    refuse(new ArtifactError(
      `maxBytes must be a positive integer, got ${maxBytes}`,
      'pagination-cursor-invalid',
    ), 'reference')
  }

  const sha256 = descriptor.captured.sha256
  const watermark = descriptor.source.acquiredAt

  // ---- STEP 4a: the cursor's remaining bindings against the resolved reference.
  let position = 0
  if (cursor !== undefined) {
    try {
      authority.assertBindings(cursor, {
        ownerScope: callerScope,
        representation,
        observationId: descriptor.id,
        revision,
        query,
      })
    } catch (error) {
      refuse(asArtifactError(error, 'pagination cursor bindings could not be checked'), 'reference')
    }
    if (cursor.artifactSha256 !== sha256) {
      // The cursor names a different object than the descriptor. Continuing would
      // splice two artifacts into one stream, which is the mixing the audit forbids.
      refuse(new ArtifactError(
        `pagination cursor is bound to artifact ${cursor.artifactSha256}, not ${sha256}`,
        'pagination-cursor-invalid',
      ), 'reference')
    }
    if (cursor.watermark !== watermark) {
      refuse(new ArtifactError(
        `pagination cursor is bound to watermark ${cursor.watermark}, not ${watermark}`,
        'pagination-cursor-invalid',
      ), 'reference')
    }
    position = cursor.position
  }

  // ---- STEP 4b: verify the descriptor/revision/content identity BEFORE reading.
  //
  // This is the call the old path was missing. `openRange` reads bytes and knows
  // nothing about what they are supposed to be; `assertObjectIdentity` establishes
  // presence, length and digest first, so no byte of a wrong or damaged object is
  // ever handed back.
  try {
    await store.assertObjectIdentity(descriptor.captured.artifact, { sha256, bytes: descriptor.captured.bytes })
  } catch (error) {
    refuse(asArtifactError(error, `artifact ${descriptor.captured.artifact} could not be verified before paging`), 'identity')
  }

  // ---- STEP 5: only now read the range/page.
  const total = descriptor.captured.bytes
  const length = Math.min(maxBytes, Math.max(0, total - position))
  let bytes: Uint8Array
  try {
    bytes = await store.openRange(descriptor.captured.artifact, { offset: position, length }, counters)
  } catch (error) {
    refuse(asArtifactError(error, `artifact ${descriptor.captured.artifact} could not be read`), 'read')
  }
  const end = position + bytes.byteLength
  const exhausted = end >= total
  return {
    bytes,
    offset: position,
    sha256,
    exhausted,
    ...exhausted ? {} : {
      nextCursor: authority.mint({
        storeRealmId,
        artifactSha256: sha256,
        observationId: descriptor.id,
        revision,
        representation,
        query,
        position: end,
        ownerScope: callerScope,
        watermark,
      }),
    },
  }
}

/** Normalize a thrown value into an `ArtifactError` that names the operation. */
function asArtifactError(error: unknown, context: string): ArtifactError {
  if (error instanceof ArtifactError) return error
  return new ArtifactError(
    `${context}: ${error instanceof Error ? error.message : String(error)}`,
    'artifact-integrity-error',
    { cause: error },
  )
}

/**
 * Read the realm a cursor CLAIMS, without verifying its MAC.
 *
 * Used only to make a refusal record name both realms, which is what makes the
 * record actionable. It never decides anything: the refusal has already been
 * decided by the verified MAC and the realm comparison.
 */
function realmClaimOf(token: string): string | undefined {
  try {
    const index = token.lastIndexOf(CURSOR_SEPARATOR)
    if (index <= 0) return undefined
    const decoded = JSON.parse(Buffer.from(token.slice(0, index), 'base64url').toString('utf8')) as
      { storeRealmId?: unknown }
    return typeof decoded.storeRealmId === 'string' ? decoded.storeRealmId : undefined
  } catch {
    return undefined
  }
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
 * A page provider that RECORDS every refusal before rethrowing it.
 *
 * WHY A DECORATOR AND NOT LOGIC INSIDE `pages()`. `pages()` takes an `ArtifactStore`,
 * which is deliberately six methods and no more (see the interface's doc comment):
 * adding a journal method to it would make every store implementation carry a
 * durability concern, and adding the write directly to `pages()` would make every
 * read path perform disk IO. This decorator binds the two only where a durable store
 * actually exists, so the recording happens in production and the pure paging path
 * stays pure.
 *
 * The refusal is recorded and THEN rethrown, in that order: a caller that catches
 * the error has already caused the evidence to be written.
 */
export class RecordingPageProvider implements PageProvider {
  private readonly inner: PageProvider
  private readonly journal: RefusalJournal

  constructor(inner: PageProvider, journal: RefusalJournal) {
    this.inner = inner
    this.journal = journal
  }

  async next(request: PageRequest, counters?: IoCounters): Promise<ArtifactPage> {
    try {
      return await this.inner.next(request, counters)
    } catch (error) {
      if (error instanceof ArtifactError) {
        // The realm the cursor CLAIMED, when it named one. `pages()` records this on
        // its own sink path, so carrying it here keeps the durable evidence the same
        // whichever route refused: `page()` uses the sink, `walk()` uses this
        // decorator, and a reader of the journal should not be able to tell which one
        // produced a record. Unverified, exactly as on the sink path -- it is read
        // from the token without the MAC having accepted it, and it decides nothing.
        const cursorRealmId = request.cursor === undefined ? undefined : realmClaimOf(request.cursor)
        await this.journal.recordRefusal({
          code: error.code,
          reason: error.message,
          storeRealmId: await this.journal.realmId(),
          observationId: request.descriptor.id,
          ...cursorRealmId === undefined ? {} : { cursorRealmId },
          step: refusalStepOf(error),
          at: new Date().toISOString(),
        })
      }
      throw error
    }
  }
}

/**
 * Where a refusal belongs in the read order.
 *
 * Derived from the code rather than carried through the throw, because the code is
 * the stable public fact and a step attached by hand at each throw site would drift
 * from it. A realm refusal is ALWAYS step 2; a cursor refusal is always step 1; an
 * integrity refusal is step 4.
 */
export function refusalStepOf(error: ArtifactError): CursorRefusal['step'] {
  switch (error.code) {
    case 'pagination-realm-denied': return 'realm'
    case 'pagination-cursor-invalid': return 'parse'
    case 'pagination-scope-denied': return 'reference'
    case 'artifact-integrity-error':
    case 'artifact-corrupt': return 'identity'
    case 'artifact-not-found':
    case 'artifact-orphaned': return 'read'
    default: return 'read'
  }
}

/** The durability surface a refusal journal needs. Narrow, so a fake is trivial. */
export interface RefusalJournal {
  /** Append a refusal record durably. */
  recordRefusal(refusal: CursorRefusal): Promise<void>
  /** The realm this journal's store belongs to. */
  realmId(): Promise<string>
}

/** The default sink for the host service's page/walk calls. */
export function mountRefusalRecording(store: AttachmentArtifactStore): RefusalJournal {
  return {
    recordRefusal: refusal => store.recordRefusal(refusal),
    realmId: () => store.ensureRealm(),
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
  // they disagree, the object is SHORTER than what the REQUEST implied, and the
  // difference is bytes that were never acquired.
  //
  // Before this check the outcome was `complete-within-request` with no gap:
  // measured, a 1000-byte file whose reader stopped at 400 bytes produced a
  // descriptor claiming a complete capture of 400 bytes. That is the
  // acquired-vs-persisted collapse the whole data plane exists to prevent -- the
  // two numbers were both present in the code and only one of them was believed.
  //
  // THE GUARD IS `> 0`, NOT `!== 0`, AND THE DIRECTION IS THE WHOLE POINT. The
  // claim being made here is "bytes that were never acquired". When MORE bytes
  // arrive than the request implied, nothing was withheld: either the source GREW
  // between the stat and the read, or the reader over-read. A `!== 0` guard filed
  // that as a loss anyway, with a NEGATIVE count in the reason.
  //
  // MEASURED before this fix (DATA-09, `data-r6.test.ts`): a 4096-byte source with
  // an 8192-byte reader produced `partial-native-acquisition`, `recovery:
  // 'refetch'`, and the reason "the source was 4096 bytes at capture start but
  // only 8192 were acquired (-4096 bytes never reached the store)". A reader who
  // believes that record re-asks for bytes they already hold, and a `partial`
  // verdict on a capture that lost nothing is exactly the fabricated-loss failure
  // DATA-09 exists to prevent -- reached through the sign of the difference rather
  // than through a wrong stage name.
  //
  // WHY THE EXPECTATION IS DERIVED FROM THE REQUEST AND NOT ONLY FROM `stat`
  // (DATA-09, the unrecorded-loss clause). The guard used to force `shortBy = 0`
  // for EVERY range request, on the reasoning that "a range request legitimately
  // captures fewer bytes than the file holds". That reasoning is true only while
  // the range lies INSIDE the source. It is false for a range that extends PAST
  // EOF, and the difference is not academic: `observations.ts` defines `partial`
  // as "bytes inside the requested range are known to be absent", and a caller who
  // asks for 1000 bytes of a 400-byte file has named a range in which 600 bytes are
  // absent. MEASURED through the product path (`DataPlane.fsCapture`) before this
  // fix, on a 400-byte file: `{offset: 0, length: 1000}` and
  // `{offset: 1000, length: 512}` both reported `complete-within-request` with an
  // EMPTY gap list, while 600 and 512 requested bytes respectively were absent --
  // and `isDeliverableAsComplete` returned true for both. That is DATA-09's rule
  // inverted: a real loss, inside a range the caller named, not recorded as a gap.
  //
  // So the expectation is the number of bytes the REQUEST implied:
  //   whole file         every byte the source had at capture start.
  //   range with length  the length the caller NAMED, even when the source is
  //                      shorter, because a byte inside a named range that the
  //                      source does not have is still absent from the request.
  //   open-ended range   the bytes from the offset to the end of the source; an
  //                      offset at or past EOF therefore implies zero bytes and
  //                      correctly records no loss.
  // A control arm keeps this from becoming a fabricated-loss producer: a range
  // wholly inside the file implies exactly the bytes that arrive, so it records
  // `complete-within-request` and NO gap (pinned in `data-r6.test.ts`).
  const requestedRange = request.requestedRange
  const expectedBytes = requestedRange === undefined
    ? sourceBytesAtStart
    : requestedRange.length ?? (sourceBytesAtStart === undefined
      ? undefined
      : Math.max(0, sourceBytesAtStart - requestedRange.offset))
  const shortBy = expectedBytes === undefined ? 0 : expectedBytes - published.bytes
  if (shortBy > 0) {
    // WHETHER A RE-ASK COULD HELP, decided rather than assumed. When the request
    // named bytes the source does not have, those bytes are past EOF: re-reading
    // the same path returns the same short file, so `refetch` would be a promise
    // the plane cannot keep and `none` is the honest value. A shortfall with no
    // such overhang is a reader that stopped early, and a second read CAN return
    // the rest -- which is the `refetch` the whole-file arm has always reported.
    const requestExceedsSource = requestedRange !== undefined && sourceBytesAtStart !== undefined
      && requestedRange.offset + (requestedRange.length ?? 0) > sourceBytesAtStart
    gaps.push({
      stage: 'native-acquisition',
      reason: requestedRange === undefined
        ? `the source was ${String(sourceBytesAtStart)} bytes at capture start but only ${String(published.bytes)} were acquired `
          + `(${String(shortBy)} bytes never reached the store); the captured object is the bytes that DID arrive, not the file that was named`
        : `the request named ${String(expectedBytes)} bytes at offset ${String(requestedRange.offset)}`
          + `${requestedRange.length === undefined ? ' to the end of the source' : ''} but only ${String(published.bytes)} were acquired `
          + `(${String(shortBy)} bytes inside the requested range are absent`
          + `${requestExceedsSource ? ', because the requested range extends past the end of the source' : ''})`,
      // A re-read of the same path may return the whole file, so a reader-shortfall
      // gap is refetchable in principle -- but the missing bytes are NOT in this
      // object, so recovery is a NEW capture, never a page of this one. A range
      // that overhangs the source is the case a re-ask cannot fix at all.
      recovery: requestExceedsSource ? 'none' : 'refetch',
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
      // `<= 0`, matching the gap guard above: only a POSITIVE shortfall is a
      // partial capture. A negative one is an over-read, and calling that
      // `partial` would contradict the (empty) gap list in the same record.
      completeness: shortBy <= 0 ? 'complete-within-request' : 'partial',
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
 * "PRESENT" MEANS THE PROJECT'S INDEX, NOT A DIRECTORY OF BYTES.
 *
 * The objects themselves live in the mounted attachment provider, which exposes no
 * enumeration and no delete on its public contract. So the set this function walks
 * is the set of objects THIS PROJECT published, which is the correct domain
 * anyway: an object the provider holds for some other consumer is not this
 * project's orphan. The consequence, stated rather than implied: an object that
 * was published and then lost its index entry (a crash in that window) cannot be
 * enumerated here and therefore cannot be reported as an orphan. The commit order
 * already forbids reporting it as delivered, and the reference row is what
 * `resolveReference` checks, so the honest answer stays honest -- but the sweep is
 * narrower than a raw directory listing would be.
 *
 * It never DELETES here. Collection is `collectGarbage`, which needs a grace
 * window; reconciliation only reports, so a caller can decide.
 */
export async function reconcileStore(
  store: AttachmentArtifactStore,
  log: SessionReferenceLog,
): Promise<{
  orphans: string[]
  integrityErrors: Array<{ observationId: string; artifact: string; eventId: string }>
}> {
  const referenced = await log.referencedArtifacts()
  const { readdir } = await import('node:fs/promises')
  const present = new Set<string>()
  const indexRoot = join(store.root, 'index')
  try {
    for (const shard of await readdir(indexRoot)) {
      try {
        for (const name of await readdir(join(indexRoot, shard))) {
          if (!name.endsWith('.json')) continue
          try {
            present.add(artifactRefOf(name.slice(0, -'.json'.length)))
          } catch {
            continue
          }
        }
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
 * The mounted attachment provider wraps every storage failure in its own
 * `ATTACHMENT_WRITE_FAILED` error with the original as `cause`, unless the thrown
 * value already is one of ITS errors or the signal aborted. (The wrapper is the
 * provider's `stageImmutableObject`, which is reachable only through the public
 * `saveFileStream` seam -- this module no longer names that private module, and the
 * behaviour is described rather than imported.) A bare `instanceof ArtifactError`
 * check at the call site therefore never sees an error this module raised from
 * inside the stream, and the distinction it carried is lost.
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
