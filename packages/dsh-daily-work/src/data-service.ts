/**
 * The data-plane host service: the production consumer of `artifacts.ts`.
 *
 * WHY THIS FILE EXISTS
 *
 * `artifacts.ts` and `observations.ts` are the data plane, and a test that mounts
 * them directly proves the MODULE works -- it does NOT prove the PRODUCT uses it.
 * This project has already retracted that class of over-claim three times
 * (`setLaunchPort` with no production caller, `takeContinuation` with no
 * production caller, and a `dsh-ipython` bundle that declared no `dsh.bundle`).
 * `docs/GAPS.md` G-FIX-04 records the lesson: a gate whose oracle is weaker than
 * its scenario passes while the product is broken.
 *
 * So the data plane is exposed as a HOST SERVICE on `ctx.dailyData`, registered
 * by a plugin row the profile actually loads (`cordis.patch.yml`), and the
 * profile-resolver probe in `qualification/runners/verify-data-plane.mjs` asserts
 * the service is reachable from a REAL composed profile. A direct
 * `ctx.plugin()` mount is deliberately NOT accepted as evidence.
 *
 * WHO CALLS IT
 *
 * The intended model-facing caller is a `python_exec`/`ipython` cell invoking the
 * native `data.capture_file` / `data.pages` tools. That worker lives in
 * `packages/dsh-ipython` and is owned by the M3 agent, which is why this file
 * exposes a SERVICE rather than registering tools itself: the service is the
 * stable seam M3 binds to, and it is complete without M3.
 *
 * WHY THE REFERENCE LOG IS A STORAGE DOMAIN AND NOT A SESSION EVENT
 *
 * `Session.append` accepts only types in DSH's closed `SessionEventMap`
 * (`packages/core/session/src/types.ts`), and `KNOWN_SESSION_EVENT_TYPES`
 * (`known-event-types.ts`) is what the persistence read path checks. An
 * out-of-repo plugin cannot add a REQUIRED event type; it could only write an
 * `ignorable: true` event, which a reader may skip -- and a reference a reader may
 * skip cannot carry the "event committed" half of the crash-consistency order.
 *
 * The audit's own wording is "record the reference in the DSH Session"; the
 * durable medium available to an extension is the same storage domain the run
 * record already uses, and the reference is keyed by observation id so the
 * reconcile path can enumerate it. That is recorded here rather than left as an
 * implicit substitution.
 */
import type { Context } from '@deepseek-ai/cordis'
import { Service } from '@deepseek-ai/cordis'
import { defineDomain, domainTable, type Domain, type DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { isAbsolute } from 'node:path'
import { z } from 'zod'
import {
  ArtifactError,
  ArtifactStorePageProvider,
  DEFAULT_ARTIFACT_QUOTA_BYTES,
  DEFAULT_PAGE_BYTES,
  LocalArtifactStore,
  RecordingPageProvider,
  buildLineIndex,
  captureFile,
  joinPages,
  mountRefusalRecording,
  pages,
  projectForModel,
  readArtifactRange,
  readLineBytes,
  reconcileStore,
  resolveReference,
  walkPages,
  type ArtifactPage,
  type ArtifactReference,
  type CaptureOutcome,
  type CursorRefusal,
  type IoCounters,
  type RefusalJournal,
  type SessionReferenceLog,
} from './artifacts.ts'
import { DataReadLimiter, DEFAULT_DATA_READ_CONCURRENCY } from './data-concurrency.ts'
import {
  GrantTable,
  parseObservation,
  refuseForgedClaims,
  type JsonValue,
  type ObservationDescriptor,
} from './observations.ts'
import type { DataPlane } from './data-plane.ts'
import { DataPlane as DataPlaneImpl } from './data-plane.ts'

/** The domain name. Doubles as the backend unit name, so it must match UNIT_NAME_RE. */
export const DATA_DOMAIN_NAME = 'dsh_daily_data'

/**
 * The reference-log schema version.
 *
 * A change here requires an offline conversion or a new namespace. Reading an
 * older shape as if it were current is what the version exists to prevent.
 */
export const DATA_SCHEMA_VERSION = 1

/**
 * One committed observation reference.
 *
 * This is the "event committed" half of the commit order. It stores the artifact
 * ref and the digest the descriptor claimed, so a later read can detect an object
 * that was replaced or truncated rather than silently serving different bytes.
 */
export const dataReferenceSchema = z.object({
  observationId: z.string().min(1),
  artifact: z.string().min(1),
  sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  bytes: z.number().int().min(0),
  /** The coverage claim, as recorded at commit time. */
  coverage: z.unknown(),
  /** Host clock, ISO-8601, when the reference was committed. */
  committedAt: z.string().min(1),
})
export type DataReference = z.infer<typeof dataReferenceSchema>

export const dataDomainSpec = defineDomain({
  name: DATA_DOMAIN_NAME,
  version: DATA_SCHEMA_VERSION,
  global: {
    schema: z.object({ initialized: z.boolean() }),
    initial: { initialized: false },
  },
  tables: {
    references: domainTable<string, DataReference>(dataReferenceSchema),
  },
})

/** Configuration for the data-plane service. */
export interface DataServiceConfig {
  /**
   * Root for the artifact store. Defaults to a `data-artifacts` directory under
   * the storage domain's own root when omitted, so a deployment that configures
   * nothing still gets a real, private, non-world-readable location.
   */
  artifactRoot?: string
  /** Per-artifact byte ceiling. Exceeding it is a recorded gap, never an inline fallback. */
  quotaBytes?: number
  /** Default page size in bytes. */
  pageBytes?: number
  /** Owner scope every capture is minted under. */
  ownerScope?: string
  /** The execution world recorded on descriptors. */
  executionWorld?: string
  /**
   * Concurrent host-side reads the `dsh.data` plane may issue against one
   * provider. HOST-OWNED: it is a construction input and is not reachable from a
   * request, so a model cannot widen its own fan-out.
   *
   * Conservative by default (see `DEFAULT_DATA_READ_CONCURRENCY`) and deliberately
   * below every shipped parallelism default in this repository. Benchmark before
   * raising it.
   */
  readConcurrency?: number
}

/** The default owner scope when config names none. */
export const DEFAULT_OWNER_SCOPE = 'project:default'

/** The default execution world when config names none. */
export const DEFAULT_EXECUTION_WORLD = 'local'

/**
 * The host-side data plane.
 *
 * A `Service`, so it is reachable as `ctx.dailyData` and its presence is a fact a
 * probe can test. The grants table is a live in-process object: a permission
 * change bumps the revision and every descriptor minted before it stops being
 * usable, which is the behaviour ARCHITECTURE §10/§12 requires.
 */
export class DataPlaneService extends Service {
  readonly store: LocalArtifactStore
  readonly grants = new GrantTable()
  readonly ownerScope: string
  readonly executionWorld: string
  readonly pageBytes: number
  private readonly config: DataServiceConfig
  /**
   * The store's refusal journal.
   *
   * A field rather than a fresh object per call, so the store's own failure list is
   * the one place a broken journal is reported.
   */
  private readonly journal: RefusalJournal
  private domain: Domain<typeof dataDomainSpec> | undefined
  private log: StorageReferenceLog | undefined
  private dataPlane: DataPlane | undefined

  constructor(ctx: Context, config: DataServiceConfig = {}) {
    super(ctx, 'dailyData')
    this.config = config
    this.ownerScope = config.ownerScope ?? DEFAULT_OWNER_SCOPE
    this.executionWorld = config.executionWorld ?? DEFAULT_EXECUTION_WORLD
    this.pageBytes = config.pageBytes ?? DEFAULT_PAGE_BYTES
    // The artifact root is a host-chosen private directory. It is NOT a path the
    // kernel supplies: a kernel-chosen root would let model-authored Python place
    // objects wherever it liked, which is the FS-policy bypass the audit forbids.
    //
    // A FALLBACK IS RECORDED, NOT SILENT. When neither an explicit `artifactRoot`
    // nor the host's `dshHomePath` helper is available, the root is the relative
    // `data-artifacts` and its location depends on the launch directory. That is a
    // real limitation, so it is written to the host log at construction rather
    // than left for an operator to discover as a stray directory.
    this.store = new LocalArtifactStore(
      defaultArtifactRoot(ctx, config.artifactRoot, relative => {
        this._artifactRootFallback = relative
        ctx.logger?.warn(
          `dsh-daily-data: no artifactRoot configured and no dshHomePath helper is mounted, so the artifact `
          + `store resolves the RELATIVE path "${relative}" against the process cwd (${process.cwd()}). `
          + 'Two hosts launched from different directories will write to different stores while sharing one '
          + 'run record. Configure artifactRoot explicitly, or boot through app-boot so dshHomePath is provided.',
        )
      }),
      { quotaBytes: config.quotaBytes ?? DEFAULT_ARTIFACT_QUOTA_BYTES },
    )
    this.journal = mountRefusalRecording(this.store)
  }

  private _artifactRootFallback: string | undefined

  /**
   * The relative root the store fell back to, when it did.
   *
   * Exposed so a probe can ASSERT whether the cwd-dependent path was taken rather
   * than inferring it from a log line. `undefined` means a real, cwd-independent
   * root was resolved.
   */
  get artifactRootFallback(): string | undefined {
    return this._artifactRootFallback
  }

  /** Open the reference domain. Idempotent per instance. */
  async open(facility: DomainFacility): Promise<void> {
    if (this.domain !== undefined) return
    const domain = await facility.open(dataDomainSpec)
    this.domain = domain
    this.log = new StorageReferenceLog(domain)
    // Establish the caller's grant. Every descriptor and cursor is bound to this
    // revision, so bumping it later invalidates them all.
    this.grants.bump(this.ownerScope)
  }

  /** Close the domain handle. */
  async close(): Promise<void> {
    // The plane holds pinned history observation leases, so it is released BEFORE
    // the domain: an undisposed lease keeps a prepared Session pinned in the
    // observation reader's cache for the process lifetime.
    this.disposePlane()
    const domain = this.domain
    this.domain = undefined
    this.log = undefined
    if (domain !== undefined) await domain.close()
  }

  /**
   * The live grant revision for the configured owner scope.
   *
   * Exposed so a caller can report it: a descriptor's `grantRevision` is only
   * meaningful against a known live value.
   */
  get grantRevision(): number {
    return this.grants.revisionOf(this.ownerScope) ?? 0
  }

  /** Bump the grant revision, invalidating every descriptor and cursor minted before it. */
  revokeAndRebump(): number {
    return this.grants.bump(this.ownerScope)
  }

  /** The reference log, refusing use before `open`. */
  private requireLog(): StorageReferenceLog {
    if (this.log === undefined) {
      throw new Error('dailyData: the data plane is not open; a reference cannot be committed before its domain is')
    }
    return this.log
  }

  /**
   * Capture a file through `ctx.fs`, in the reconcilable commit order.
   *
   * `fs` is passed in rather than looked up here because the CALLER owns the
   * execution world: a capture must read through the same FS backend the calling
   * session is authorized against, and resolving a different backend inside this
   * service would be a silent authority substitution.
   */
  async capture(input: {
    fs: Parameters<typeof captureFile>[0]['fs']
    path: string
    mediaType?: string
    observationId?: string
    requestedRange?: { offset: number; length?: number }
    /**
     * Override how the source bytes are read back.
     *
     * Forwarded so a caller can BOUND the read to a requested window rather than
     * only annotating the coverage claim. Without this, a `requestedRange` recorded
     * what was asked for while the store still published the whole file -- measured:
     * a `{offset:1024, length:512}` request over a 4096-byte file produced a
     * 4096-byte artifact.
     */
    readChunks?: Parameters<typeof captureFile>[0]['readChunks']
    /** A kernel payload. A forged host fact is REFUSED, not merged. */
    claim?: unknown
    signal?: AbortSignal
  }): Promise<CaptureOutcome> {
    const log = this.requireLog()
    return captureFile({
      fs: input.fs,
      path: input.path,
      store: this.store,
      log,
      grants: this.grants,
      ownerScope: this.ownerScope,
      executionWorld: this.executionWorld,
      ...input.observationId !== undefined ? { observationId: input.observationId } : {},
      ...input.mediaType !== undefined ? { mediaType: input.mediaType } : {},
      ...input.requestedRange !== undefined ? { requestedRange: input.requestedRange } : {},
      ...input.readChunks !== undefined ? { readChunks: input.readChunks } : {},
      ...input.claim !== undefined ? { claim: input.claim } : {},
      ...input.signal !== undefined ? { signal: input.signal } : {},
      // The checkpoint is the caller's durable boundary. It runs AFTER the
      // reference is committed and BEFORE `durable: true` is promised.
      checkpoint: async reference => { await this.checkpoint(reference) },
    })
  }

  /**
   * The durability checkpoint.
   *
   * The reference row is already committed by the time this runs, so the
   * checkpoint's job is to establish that the reference itself is on durable
   * medium rather than only in the in-process table. The storage domain's `put`
   * resolves after its backend's write chain, so re-reading the row is a real
   * check rather than a no-op.
   */
  private async checkpoint(reference: { artifact: string; sha256: string }): Promise<void> {
    const log = this.requireLog()
    const confirmed = await log.confirmCommitted(reference.artifact)
    if (!confirmed) {
      throw new Error(`data plane checkpoint: reference for ${reference.artifact} did not read back`)
    }
  }

  /**
   * Read one bounded page of an IMMUTABLE artifact.
   *
   * The descriptor is re-validated against the LIVE grant on every call, so a
   * permission-domain change stops an in-flight walk rather than letting it
   * finish under an authority that no longer exists.
   */
  async page(input: {
    descriptor: unknown
    cursor?: string
    maxBytes?: number
    counters?: IoCounters
  }): Promise<ArtifactPage> {
    const descriptor = parseObservation(input.descriptor, this.grants)
    return pages(this.store, {
      descriptor,
      maxBytes: input.maxBytes ?? this.pageBytes,
      ...input.cursor !== undefined ? { cursor: input.cursor } : {},
      grants: this.grants,
      callerScope: this.ownerScope,
      // THE REFUSAL IS RECORDED, which is half of DATA-11's oracle. The sink writes
      // to the store's own journal before the error propagates, so a cross-realm
      // replay leaves durable evidence even when the caller catches the throw. A
      // refusal that only exists as a caught exception is the "keeps running and
      // reporting health" shape the audit names.
      onRefusal: refusal => { this.recordRefusal(refusal) },
    }, input.counters)
  }

  /** Walk pages to exhaustion (or a page budget) with the stall guard in force. */
  async walk(input: {
    descriptor: unknown
    maxBytes?: number
    maxPages?: number
    counters?: IoCounters
  }): Promise<{ pages: number; bytes: number; exhausted: boolean; lastPosition: number }> {
    const descriptor = parseObservation(input.descriptor, this.grants)
    // The recording provider wraps the real one, so EVERY page of the walk records
    // its refusal rather than only the first call. `walkPages` drives the provider
    // directly, so a sink on the request would be lost after the first page.
    return walkPages(new RecordingPageProvider(new ArtifactStorePageProvider(this.store), this.journal), {
      descriptor,
      maxBytes: input.maxBytes ?? this.pageBytes,
      grants: this.grants,
      callerScope: this.ownerScope,
    }, {
      ...input.maxPages !== undefined ? { maxPages: input.maxPages } : {},
      ...input.counters !== undefined ? { counters: input.counters } : {},
    })
  }

  /**
   * Record a cursor refusal durably, and surface a journal failure.
   *
   * Deliberately NOT awaited by `page()`: the refusal is already decided and the
   * caller is about to receive it, so making the refusal wait on a disk write would
   * let a slow journal delay (or, if awaited in the wrong place, replace) the
   * refusal. The write is started and its failure is collected for a later reader.
   */
  private recordRefusal(refusal: Omit<CursorRefusal, 'at'> & { at?: string }): void {
    void this.journal.recordRefusal({ at: new Date().toISOString(), ...refusal }).catch(() => {
      // `LocalArtifactStore.recordRefusal` already captures the failure in its own
      // list; this catch exists so a rejected promise is never unhandled.
    })
  }

  /** Every cursor refusal this deployment recorded, oldest first. */
  async refusals(): Promise<CursorRefusal[]> {
    return this.store.readRefusals()
  }

  /** This store's durable realm identity, created on first use. */
  async storeRealmId(): Promise<string> {
    return this.store.ensureRealm()
  }

  /** Build a sparse line index over the captured object. */
  async lineIndex(descriptor: unknown, options: { stride?: number } = {}): Promise<Awaited<ReturnType<typeof buildLineIndex>>> {
    const parsed = parseObservation(descriptor, this.grants)
    return buildLineIndex(this.store, parsed, options)
  }

  /** Read one line COMPLETELY by byte range. This is the >2000-char repair path. */
  async readLine(descriptor: unknown, entry: Parameters<typeof readLineBytes>[2], counters?: IoCounters): Promise<Uint8Array> {
    const parsed = parseObservation(descriptor, this.grants)
    return readLineBytes(this.store, parsed, entry, counters)
  }

  /** Read an arbitrary byte range of the captured object. */
  async readRange(
    descriptor: unknown,
    range: { offset: number; length: number },
    counters?: IoCounters,
  ): Promise<Uint8Array> {
    const parsed = parseObservation(descriptor, this.grants)
    return readArtifactRange(this.store, parsed, range, counters)
  }

  /** Reassemble a page list, refusing a short join. */
  join(pagesRead: readonly ArtifactPage[], expectedBytes: number): Uint8Array {
    return joinPages(pagesRead, expectedBytes)
  }

  /** The bounded model-visible projection. */
  project(input: Parameters<typeof projectForModel>[0]): ReturnType<typeof projectForModel> {
    return projectForModel(input)
  }

  /** Resolve a committed reference, distinguishing orphan from integrity error. */
  async resolve(observationId: string): Promise<{ bytes: Uint8Array; sha256: string; eventId: string }> {
    return resolveReference(this.store, this.requireLog(), observationId)
  }

  /** The committed reference for an observation, if any. */
  async referenceOf(observationId: string): Promise<DataReference | undefined> {
    return this.requireLog().lookupRecord(observationId)
  }

  /** Reconcile the store against the committed references. */
  async reconcile(): Promise<{ orphans: string[]; integrityErrors: Array<{ observationId: string; artifact: string; eventId: string }> }> {
    return reconcileStore(this.store, this.requireLog())
  }

  /** Refuse a kernel payload that asserts a host-authored fact. */
  refuseForgedClaims(payload: unknown): void {
    refuseForgedClaims(payload)
  }

  /** The descriptor for a committed observation, re-validated against the live grant. */
  parseObservation(value: unknown): ObservationDescriptor {
    return parseObservation(value, this.grants)
  }

  /**
   * The cell-bound `dsh.data` request plane.
   *
   * WHY A SHARED INSTANCE AND NOT ONE PER CELL.
   *
   * The plane's limiter bounds the TOTAL concurrent reads this deployment issues
   * against one provider. A per-cell limiter would multiply the bound by the
   * number of live cells, which is precisely the unbounded fan-out the limiter
   * exists to prevent.
   *
   * The module cycle is broken by a TYPE-ONLY import in `data-plane.ts`
   * (`import type { DataPlaneService }`), which `verbatimModuleSyntax` erases, so
   * there is no runtime edge back into this module. The plane therefore receives
   * the service as a constructor parameter rather than reaching for it.
   *
   * @returns the plane, constructed once and reused.
   */
  plane(): DataPlane {
    this.dataPlane ??= new DataPlaneImpl(this.ctx, this, {
      readConcurrency: this.config.readConcurrency ?? DEFAULT_DATA_READ_CONCURRENCY,
      pageBytes: this.config.pageBytes ?? this.pageBytes,
    })
    return this.dataPlane
  }

  /** Release every pinned history scan the plane is holding. Idempotent. */
  disposePlane(): void {
    this.dataPlane?.dispose()
    this.dataPlane = undefined
  }
}

/**
 * The default artifact root.
 *
 * WHY THIS FUNCTION WAS REWRITTEN (G-SEAM-63 / R2-F11F10's finding, re-verified here).
 *
 * The previous version did:
 *
 *     const configured = (ctx.get('storageDomain') as { root?: string } | undefined)?.root
 *     if (typeof configured === 'string' && configured.length > 0) return `${configured}/data-artifacts`
 *     return 'data-artifacts'
 *
 * **That guard could never be true.** The mounted `storageDomain` is a
 * `DomainFacility`, whose `Domain` handle is declared at
 * `packages/storage/storage-domain/src/domain.ts:97-119` as exactly `name`,
 * `global`, `table(name)` and `close()`. There is no `root` member, and no source
 * file in `storage-domain/src` mentions one. So the lookup always returned
 * `undefined` and the store ALWAYS resolved the relative `data-artifacts` against
 * the process cwd.
 *
 * WHY "READ THE BACKEND'S REAL ROOT" IS NOT THE FIX.
 *
 * That was the intended repair and it is NOT AVAILABLE through a public seam.
 * Verified at the pin: `StorageBackend` (`storage/src/backend.ts:17-27`) declares
 * only `kv?` and `close()`; `BackendRegistry.get(name)` returns that interface;
 * and `JsonStorageBackend`'s root is `constructor(private readonly root: string)`
 * (`storage-json/src/index.ts:46`) -- a TypeScript `private`, not reachable at
 * runtime by anything outside the class. Reaching it would require either an
 * upstream change or a cast that reads a private field, and a cast that reads a
 * field the type says does not exist is exactly the defect this function is being
 * fixed for. So the honest options were a loud refusal or an explicit host path.
 *
 * WHAT THIS FUNCTION DOES INSTEAD, in order:
 *
 *   1. An explicitly configured `artifactRoot` wins. A deployment that names a
 *      location gets that location, and it must be ABSOLUTE -- a relative
 *      configured root would reproduce the cwd accident with an extra step.
 *   2. Otherwise derive from `dshHomePath`, the HOST-provided path helper that
 *      `app-boot` publishes with `ctx.provide('dshHomePath', dshHomePath)`
 *      (`packages/boot/app-boot/src/index.ts:940`). This is the same seam the
 *      SHIPPED bundle uses for `storages` and `sessions`
 *      (`packages/bundle/base/cordis.patch.yml`, `root: !!js dshHomePath(...)`),
 *      so the artifact store lands beside the records that reference it rather
 *      than in a second, separately-configured tree. It resolves against
 *      `$DSH_HOME` (or the OS default `~/.dsh`), NOT the cwd, so two hosts
 *      launched from different directories share one store and a `cd` between
 *      boots cannot relocate it.
 *   3. If neither is available -- no configured root and no host helper, which
 *      happens in an in-process unit test that mounts this service directly --
 *      the fallback is the relative `data-artifacts`, and it is LOUD: the service
 *      records it as a warning naming the cwd dependence at construction time
 *      rather than leaving the location an accident. A test that wants a fixed
 *      location passes `artifactRoot`, which every test in this repository does.
 *
 * WHAT IS STILL NOT CLAIMED. The `dshHomePath` seam is resolved by NAME through
 * `ctx.get`, so a deployment that boots without `app-boot` does not have it. That
 * is why step 3 exists and why it warns rather than throwing: a service that
 * refused to construct would turn a missing path helper into a boot failure for
 * every deployment, which is a larger blast radius than the defect.
 *
 * @param ctx - the host context.
 * @param configured - an explicit `artifactRoot`, when the deployment named one.
 * @param onFallback - called with the resolved relative root when neither source
 *   was available, so the caller can record the cwd dependence where it is
 *   observable.
 * @returns the artifact store root.
 * @throws when a configured root is present but not absolute.
 */
export function defaultArtifactRoot(
  ctx: Context,
  configured?: string,
  onFallback?: (relative: string) => void,
): string {
  if (configured !== undefined) {
    if (!isAbsolute(configured)) {
      throw new Error(
        `data plane: artifactRoot "${configured}" is not absolute. A relative artifact root resolves against `
        + 'the process cwd, so the store would move when the host is launched from a different directory -- '
        + 'which is the defect this check exists to prevent.',
      )
    }
    return configured
  }
  // The host-provided helper. Read by NAME because it is a `provide`d value, not
  // a service with a static `inject` key, so property access has no typed form.
  const homePath = ctx.get('dshHomePath') as ((...segments: string[]) => string) | undefined
  if (typeof homePath === 'function') {
    return homePath('data-artifacts')
  }
  const relative = 'data-artifacts'
  onFallback?.(relative)
  return relative
}

/**
 * A `SessionReferenceLog` backed by the storage domain.
 *
 * The domain is the durable medium an extension can actually reach. `commit`
 * resolves only after the backend's write chain accepted the row, which is what
 * makes the ordering claim real: `captureFile` treats a resolved `commit` as the
 * "event committed" boundary, and a rejected one as the orphan window.
 */
export class StorageReferenceLog implements SessionReferenceLog {
  private readonly domain: Domain<typeof dataDomainSpec>
  /** artifact ref -> observation id, so reconciliation can go object-first. */
  private readonly byArtifact = new Map<string, string>()

  constructor(domain: Domain<typeof dataDomainSpec>) {
    this.domain = domain
    for (const [, record] of domain.table('references').entries()) {
      this.byArtifact.set(record.artifact, record.observationId)
    }
  }

  async commit(reference: {
    observationId: string
    artifact: string
    sha256: string
    bytes: number
    coverage: JsonValue
  }): Promise<string> {
    const record: DataReference = {
      observationId: reference.observationId,
      artifact: reference.artifact,
      sha256: reference.sha256,
      bytes: reference.bytes,
      coverage: reference.coverage,
      committedAt: new Date().toISOString(),
    }
    await this.domain.table('references').put(reference.observationId, record)
    this.byArtifact.set(reference.artifact, reference.observationId)
    // The reference id IS the observation id: the durable row is the event, and
    // inventing a second identifier would give the reconcile path two keys to
    // disagree about.
    return reference.observationId
  }

  async referencedArtifacts(): Promise<ReadonlySet<string>> {
    return new Set([...this.domain.table('references').entries()].map(([, record]) => record.artifact))
  }

  async lookup(observationId: string): Promise<{ artifact: string; sha256: string; eventId: string } | undefined> {
    const record = this.domain.table('references').get(observationId)
    if (record === undefined) return undefined
    return { artifact: record.artifact, sha256: record.sha256, eventId: record.observationId }
  }

  /** The full record, for a caller that needs the coverage claim too. */
  async lookupRecord(observationId: string): Promise<DataReference | undefined> {
    return this.domain.table('references').get(observationId)
  }

  /** Whether a committed reference for `artifact` reads back from the domain. */
  async confirmCommitted(artifact: string): Promise<boolean> {
    const observationId = this.byArtifact.get(artifact)
    if (observationId === undefined) return false
    return this.domain.table('references').get(observationId)?.artifact === artifact
  }
}

/** A reference the service returns, with the honest state at the moment it is produced. */
export type { ArtifactReference }
