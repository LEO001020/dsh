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
import { z } from 'zod'
import {
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
import {
  GrantTable,
  parseObservation,
  refuseForgedClaims,
  type JsonValue,
  type ObservationDescriptor,
} from './observations.ts'

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

  constructor(ctx: Context, config: DataServiceConfig = {}) {
    super(ctx, 'dailyData')
    this.config = config
    this.ownerScope = config.ownerScope ?? DEFAULT_OWNER_SCOPE
    this.executionWorld = config.executionWorld ?? DEFAULT_EXECUTION_WORLD
    this.pageBytes = config.pageBytes ?? DEFAULT_PAGE_BYTES
    // The artifact root is a host-chosen private directory. It is NOT a path the
    // kernel supplies: a kernel-chosen root would let model-authored Python place
    // objects wherever it liked, which is the FS-policy bypass the audit forbids.
    this.store = new LocalArtifactStore(
      config.artifactRoot ?? defaultArtifactRoot(ctx),
      { quotaBytes: config.quotaBytes ?? DEFAULT_ARTIFACT_QUOTA_BYTES },
    )
    this.journal = mountRefusalRecording(this.store)
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
}

/**
 * The default artifact root.
 *
 * INTENDED: derive the root from the storage domain's own configured root, so
 * artifacts live beside the records that reference them rather than in a second,
 * separately-configured tree.
 *
 * WHAT ACTUALLY HAPPENS, measured rather than assumed (R5): the `storageDomain`
 * service the profile mounts is a `DomainFacility`, and it has **no `root`
 * property at all** — the root belongs to the BACKEND
 * (`@deepseek-ai/dsh-storage-json` takes `root` as its own required config). The
 * `configured` branch below is therefore UNREACHABLE against the shipped service,
 * and a real boot resolves the relative fallback `data-artifacts`, which lands
 * against the process cwd. The M4 boot probe recorded exactly that
 * (`qualification/results/R5-data/profile-boot.json` → `"artifactRoot":"data-artifacts"`).
 *
 * The branch is kept rather than deleted because it is the correct behaviour for a
 * deployment that DOES expose a root (a future or third-party facility), and
 * deleting it would silently make a configured deployment fall back too. What is
 * NOT claimed is that it is in use today. The real fix — a storage-domain change or
 * a config-supplied root — is recorded as an open gap (G-R5-04) and deliberately
 * not attempted from this module, because guessing a path is the failure this
 * function's own comment warns about.
 *
 * The fallback is a RELATIVE path on purpose: it is never world-readable and never
 * an absolute path a kernel could name, but it IS tied to the process cwd, which is
 * a real limitation and is stated rather than implied.
 */
function defaultArtifactRoot(ctx: Context): string {
  const configured = (ctx.get('storageDomain') as { root?: string } | undefined)?.root
  if (typeof configured === 'string' && configured.length > 0) {
    return `${configured}/data-artifacts`
  }
  return 'data-artifacts'
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
