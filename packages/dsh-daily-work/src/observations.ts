/**
 * The observation vocabulary: one descriptor for every native acquisition.
 *
 * WHY A DESCRIPTOR AND NOT A `truncated` BOOLEAN
 *
 * The audit's finding (ARCHITECTURE §6) is that "truncated" collapses several
 * different losses into one bit, and they have different recovery rules:
 *
 *   provider acquisition  the provider only ever sent the first N bytes.
 *                         NOT recoverable locally -- a refetch is a NEW
 *                         observation with a new URL/time/ETag/hash.
 *   native acquisition    `read` clipped a long line; `grep` hit its raw stdout
 *                         cap. Recoverable only BEFORE the loss, i.e. by
 *                         capturing or by an explicit range/snapshot operation.
 *   transform             HTML->text, PDF extraction, lossy decoding. The
 *                         original payload and the derived object are DIFFERENT
 *                         artifacts and must be recorded as such.
 *   retention             disk full, quota, save failure, expiry.
 *
 * So `acquisition.gaps[]` records WHICH stage lost WHAT and HOW (if at all) it
 * can be recovered. `completeness` is scoped: `complete-within-request` is a
 * claim about the REQUESTED RANGE, never about the world.
 *
 * WHY THE LIST IS FOUR AND NOT SIX (DATA-09 / F7)
 *
 * v1 added two names to that list and both were mistakes of the same shape: the
 * field answers "did the world give us the bytes?", and neither name is a fact
 * about the world.
 *
 *   model projection      the model saw 10 lines of a complete artifact. This is
 *                         a fact about OUR selection, not an acquisition loss:
 *                         the artifact is complete. It is now a
 *                         {@link ProjectionManifest}, a separate type with no
 *                         `stage` field, so it cannot be filed as a gap at all.
 *                         Recording a deliberate projection as a loss makes an
 *                         honest system look broken and a broken system look
 *                         honest.
 *
 *   transport             RPC/Jupyter frame loss. Measured: an over-limit frame
 *                         is REFUSED (encoder refuses; decoder refuses on the
 *                         declared length before buffering), so no partial
 *                         success exists to attribute. A failed transport is a
 *                         failed OPERATION. It is reported as an error with a
 *                         structured code, not as a gap -- and V3 §M1 forbids
 *                         inventing a producer for a vocabulary member no
 *                         production path can emit.
 *
 * The closed set is therefore exactly the stages with a REAL production
 * producer, and the conflation is gone: acquisition loss and intentional
 * projection are no longer one concept.
 *
 * WHY HOST AUTHORITY IS A SEPARATE FIELD
 *
 * `authority` is host-authored and is not bearer authority (ARCHITECTURE §6).
 * The kernel runs model-authored Python; anything it sends back is a claim, not
 * a fact. `captured.sha256`, `captured.bytes`, `authority.*` and the gap list
 * are facts only the host can establish, because only the host streamed the
 * bytes and only the host knows the grant. A payload that asserts them is
 * REFUSED rather than merged -- merging would let model-authored Python promote
 * its own claim to host fact, which is the whole failure this field prevents.
 *
 * `authority.grantRevision` is deliberately a revision counter, not a token: a
 * descriptor is only usable while the host's grant table still reports that
 * revision for that owner scope. A stale descriptor is refused, not downgraded.
 */
import { z } from 'zod'

/**
 * The descriptor schema version.
 *
 * A change here is a change to what a stored descriptor MEANS, so it requires
 * an explicit conversion or a new namespace. Reading an older shape as if it
 * were current is the failure the version exists to prevent.
 *
 * WHY THIS IS 2 (DATA-09 / F7). The gap closed set shrank from six stages to
 * four: `model-projection` moved to {@link ProjectionManifest} and `transport`
 * stopped being a loss at all (a failed transport is a failed OPERATION; see
 * the note on the acquisition coverage vocabulary below). A version-1
 * descriptor is therefore NOT readable under this shape, and the reason is not
 * pedantry: `{stage: 'model-projection'}` in a stored v1 record asserts that a
 * deliberate projection was an ACQUISITION GAP -- a claim this module now
 * refuses to express. Reading that record as if it were current would silently
 * reinterpret "we chose to show the model 2 KiB of a complete 30 MiB artifact"
 * as "the world gave us less than we asked for", which is the exact conflation
 * DATA-09 exists to remove. A v1 record must be converted, not re-read.
 *
 * The refusal is explicit and NAMED (`observation-schema-version-unsupported`,
 * see {@link parseObservation}) rather than left to the `z.literal` below,
 * because a well-formed older descriptor is not a malformed one and reporting
 * it as "malformed" would misattribute the cause.
 */
export const OBSERVATION_SCHEMA_VERSION = 2

/** What kind of thing was observed. */
export type ObservationSourceKind = 'file' | 'web' | 'search' | 'history' | 'tool' | 'derived'

/**
 * The FOUR acquisition stages, named so a gap can be attributed without
 * ambiguity.
 *
 * WHY FOUR AND NOT SIX (DATA-09 / F7). The v1 closed set carried two more
 * names, and neither belonged here, because the field means one thing: *did the
 * world, the provider or the pipeline actually give us the bytes we asked for?*
 *
 *   `model-projection`  A deliberate projection is NOT an acquisition loss. It
 *                       is a fact about OUR output: the artifact is complete,
 *                       and we chose to show the model less of it. Recording
 *                       that choice as a loss makes an honest system look
 *                       broken (it reports gaps where none exist) and a broken
 *                       system look honest (a real loss sits in a list where
 *                       deliberate choices are normal). It is now a
 *                       {@link ProjectionManifest}, a different type that
 *                       cannot be mistaken for a gap.
 *
 *   `transport`         A transport failure is a failed OPERATION, not a
 *                       partial successful observation. Measured: an oversized
 *                       frame is refused by the encoder and refused by the
 *                       decoder on the DECLARED length, before any successful
 *                       value exists. There is no partial success to attribute,
 *                       so a `transport` gap would have to be produced by
 *                       deliberately degrading a hard refusal into a silent
 *                       drop. That is the one thing worse than a missing
 *                       producer: a fabricated one. This array therefore does
 *                       NOT contain it.
 *
 * The consequence is deliberate and is the point of the split: the set is
 * exactly the stages that have a REAL production producer, and a stage with no
 * producer is not a vocabulary member. The v1 oracle's demand that all six
 * appear as gaps is a demand for two fabricated producers; V3 §M1 forbids
 * inventing vocabulary a production path cannot emit.
 *
 * WHERE THE TWO REMOVED NAMES WENT, so nothing is silently lost:
 *   - `model-projection` -> {@link ProjectionManifest} (recorded, not a gap).
 *   - `transport`        -> an ERROR PATH with a structured code
 *                           (`FRAME_TOO_LARGE`) and a refusal count, not a
 *                           gap. See `docs/GAPS.md` and D2 for the metric,
 *                           which is owned outside this module.
 */
export const OBSERVATION_GAP_STAGES = [
  /** The provider itself never sent the bytes (top-k, HTTP body cap, cut download). */
  'provider-acquisition',
  /** A native tool clipped or capped before any consumer saw the value (`read`, `grep`). */
  'native-acquisition',
  /** A derivation dropped information (HTML->text, PDF extraction, lossy decode). */
  'transform',
  /** Storage refused or expired the object (disk full, quota, save failure, GC). */
  'retention',
] as const

export type ObservationGapStage = (typeof OBSERVATION_GAP_STAGES)[number]

/**
 * The acquisition coverage vocabulary: the same four stages, named as coverage.
 *
 * This is the type D2 calls `AcquisitionCoverage`. It is deliberately the SAME
 * four names as {@link OBSERVATION_GAP_STAGES}, and the relationship is asserted
 * rather than assumed: a coverage name with no gap stage would be a second
 * vocabulary that can drift, and drift here means a consumer maps a loss to a
 * layer the gap list can never contain.
 *
 * `transport` is NOT a member, for the reason recorded on the gap stages: there
 * is no partial-success transport in this product, and D2 admits the name only
 * "if a partial-success transport actually exists". It does not. Adding it now
 * would be exactly the fabricated producer V3 §M1 forbids.
 */
export const ACQUISITION_COVERAGE_STAGES = OBSERVATION_GAP_STAGES

export type AcquisitionCoverageStage = ObservationGapStage

/**
 * How a gap can be closed, if at all.
 *
 * `refetch` is deliberately NOT a recovery of the same observation: a refetch
 * produces a NEW observation with a new locator, time and hash. Concatenating
 * a pre-refetch page with a post-refetch page would fabricate a document that
 * never existed at any instant, so the pager binds a cursor to one artifact
 * hash and refuses to cross.
 */
export const OBSERVATION_GAP_RECOVERIES = ['page', 'refetch', 'none', 'unknown'] as const

export type ObservationGapRecovery = (typeof OBSERVATION_GAP_RECOVERIES)[number]

/**
 * Completeness is relative to an EXPLICIT REQUEST RANGE.
 *
 * `complete-within-request` never means "this is everything about the world";
 * it means "every byte of the range this request named is present". `partial`
 * means bytes inside the requested range are known to be absent. `unknown`
 * means absence could not be established -- which is NOT the same as complete,
 * and is never rendered as success.
 */
export const OBSERVATION_COMPLETENESS = ['complete-within-request', 'partial', 'unknown'] as const

export type ObservationCompleteness = (typeof OBSERVATION_COMPLETENESS)[number]

/**
 * The NINE-NAME coverage vocabulary a reader reports, derived from the
 * three-valued `completeness` plus the gap list.
 *
 * WHY TWO VOCABULARIES. `completeness` is the STORED field: three values, because
 * a stored descriptor must not encode a judgement that a later reader might
 * disagree about, and because `partial` plus a named stage is strictly more
 * information than any single partial label. This vocabulary is the REPORTED
 * name: it exists so a UI, a log line or a human gets one word that says WHICH
 * layer lost the bytes, without re-deriving it from `gaps` inconsistently in
 * every consumer.
 *
 * `full-for-requested-scope` is deliberately not `full`: it is a claim about the
 * REQUEST's range, never about the world. A provider that silently sent a
 * truncated body and said nothing would still be reported full-for-scope,
 * because no client can detect that from the bytes -- which is exactly why the
 * name says "requested scope" rather than "complete".
 *
 * The four partial names correspond one-to-one with the recoverable loss layers.
 * `transport` has no name here ON PURPOSE: a lost frame means absence could not
 * be established at all, so the honest report is `unknown`, not a partial label
 * that implies the rest arrived intact. It is not a gap stage either (see
 * {@link OBSERVATION_GAP_STAGES}): this product REFUSES an over-limit frame
 * rather than dropping it, so no partial success exists to name.
 *
 * `model-projection` is absent for the opposite reason, and the asymmetry is the
 * whole of DATA-09. A projection is not an absence at all: the artifact is
 * COMPLETE and we chose to show the model less of it. It is reported by
 * {@link ProjectionManifest} -- a separate type carrying the source ref, the
 * selected and omitted counts, a recoverable ref and the reason -- precisely so
 * that "we showed the model 2 KiB of a complete 30 MiB artifact" can never be
 * read as "the world gave us 2 KiB".
 */
export const OBSERVATION_COVERAGE_VOCABULARY = [
  'full-for-requested-scope',
  'partial-provider',
  'partial-native-acquisition',
  'partial-transform',
  'partial-storage',
  'unknown',
] as const

export type ObservationCoverageVerdict = (typeof OBSERVATION_COVERAGE_VOCABULARY)[number]

/**
 * Which gap stage dominates a report, in PIPELINE order.
 *
 * Order is earliest-loss-first: bytes the provider never sent cannot be
 * recovered by anything downstream, so a `provider-acquisition` gap outranks a
 * `retention` gap even when both are present. Reporting the latest loss would
 * name a symptom and hide the cause.
 *
 * The two names v1 carried here (`transport`, `model-projection`) are gone with
 * the stages themselves. Nothing downstream loses information: a `transport`
 * failure is an error the caller already holds, and a projection is a
 * {@link ProjectionManifest} on the projection, not a gap to rank.
 */
const GAP_STAGE_PRECEDENCE: readonly ObservationGapStage[] = [
  'provider-acquisition',
  'native-acquisition',
  'transform',
  'retention',
]

/**
 * The reported coverage verdict for a descriptor.
 *
 * The mapping is total and is the ONLY place it is written, so two consumers
 * cannot disagree about what a given `(completeness, gaps)` pair means.
 *
 * A `partial` observation with NO gaps also reports `unknown`: the record claims
 * a loss it cannot attribute, which is not enough to name a layer.
 *
 * The switch is EXHAUSTIVE over the four acquisition stages and has no default,
 * which is the point: adding a stage to the closed set without deciding its
 * verdict becomes a compile error rather than a silent `unknown`. v1 could not
 * have this property -- its two dead names were cases that existed only to
 * return `unknown` for stages no producer could emit, which is a switch written
 * to satisfy a union instead of to answer a question.
 *
 * @param descriptor - the observation to report on.
 * @returns the one-word coverage verdict.
 */
export function coverageVerdictOf(descriptor: ObservationDescriptor): ObservationCoverageVerdict {
  const { completeness, gaps } = descriptor.acquisition
  if (completeness === 'complete-within-request') return 'full-for-requested-scope'
  if (completeness === 'unknown') return 'unknown'
  const stages = new Set(gaps.map(gap => gap.stage))
  for (const stage of GAP_STAGE_PRECEDENCE) {
    if (!stages.has(stage)) continue
    switch (stage) {
      case 'provider-acquisition': return 'partial-provider'
      case 'native-acquisition': return 'partial-native-acquisition'
      case 'transform': return 'partial-transform'
      case 'retention': return 'partial-storage'
    }
  }
  // `partial` with no attributable gap. Naming a layer here would be a guess.
  return 'unknown'
}

/** A JSON value. `coverage` is deliberately JSON: its shape is source-specific. */
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue }

/**
 * Byte ceiling on a single recorded gap reason.
 *
 * WHY THE SCHEMA BOUNDS THIS AND NOT ONLY THE PROJECTION. `projectForModel`
 * truncates gap reasons to `previewBytes` on the way out, which bounds what a
 * MODEL sees -- but the stored descriptor is written to the reference log and
 * read back by every consumer, so an unbounded reason is an unbounded record on
 * disk. Bounding it here means the projection's truncation is a second line of
 * defence rather than the only one.
 *
 * 4 KiB is far above any real diagnostic ("the provider capped the body at
 * 200000 characters") and far below the 64 KiB page the store pages in.
 */
export const MAX_GAP_REASON_CHARS = 4096

/**
 * Byte ceiling on a locator / provider / clock / world string.
 *
 * A locator is a path or URL, so 8 KiB covers a deeply nested path with a long
 * query string while still refusing a payload designed to make every descriptor
 * unbounded. This is a SCHEMA bound, so a descriptor that violates it is
 * `observation-malformed` -- refused at the boundary rather than stored and
 * discovered later by a consumer that had already paid for the read.
 */
export const MAX_LOCATOR_CHARS = 8192

/** One recorded loss, attributed to the stage that caused it. */
export const observationGapSchema = z.object({  stage: z.enum(OBSERVATION_GAP_STAGES),
  /** What was lost, in terms a reader can act on. Never a bare "truncated". */
  reason: z.string().min(1).max(MAX_GAP_REASON_CHARS),
  recovery: z.enum(OBSERVATION_GAP_RECOVERIES),
})
export type ObservationGap = z.infer<typeof observationGapSchema>

/**
 * A DELIBERATE projection of a complete artifact, recorded as a fact about our
 * output rather than as a loss.
 *
 * WHAT THIS TYPE EXISTS TO PREVENT (DATA-09 / F7). v1 had one enum carrying two
 * different epistemic claims: "the provider never sent these bytes" (a fact
 * about the WORLD, and a loss) and "we hold all 30 MiB and showed the model
 * 2 KiB" (a fact about OUR OWN selection, and not a loss at all). Because both
 * lived in `acquisition.gaps[]`, an honest system that projected by design
 * reported gaps where none existed, and a system with a real provider loss
 * reported something a reader had learned to read as routine.
 *
 * So a projection is a SEPARATE TYPE with no `stage` and no `recovery`:
 *
 *   - There is no `stage` field, so a projection cannot be passed where a gap is
 *     expected. The confusion is a type error, not a discipline problem.
 *   - There is no `recovery`: nothing was lost, so nothing needs recovering. The
 *     omitted bytes are still in the artifact, which is what `recoverableRef`
 *     points at.
 *
 * WHY `recoverableRef` IS REQUIRED AND NOT OPTIONAL. A projection that names what
 * it withheld but not where the withheld bytes ARE would be a dead end: the
 * model would know it was shown less and have no way to ask for more. The ref is
 * the artifact the projection was computed from, so `page`-style recovery is a
 * real operation rather than a promise. It is required even when nothing was
 * omitted, because "the whole artifact was shown" is itself a claim that needs
 * an address to be checkable against.
 *
 * WHY THE OMITTED COUNTS ARE `undefined`-ABLE. D2 says "omittedBytes/items when
 * knowable", and the qualifier is load-bearing. A projection computed from a
 * stream that never counted its total genuinely does not know how many bytes it
 * omitted, and a fabricated 0 would report a COMPLETE projection -- the single
 * most misleading value available. `undefined` means "not established", which is
 * the honest third state; `0` means "established: nothing was omitted".
 */
export const projectionManifestSchema = z.object({
  /**
   * The artifact this projection was computed FROM.
   *
   * Required, and bounded like every other address in this schema: an unbounded
   * ref would make the manifest -- which is what the model is shown -- an
   * unbounded payload, the same failure `MAX_LOCATOR_CHARS` prevents elsewhere.
   */
  sourceRef: z.string().min(1).max(MAX_LOCATOR_CHARS),
  /**
   * The ref a consumer may re-read to see what was omitted.
   *
   * Usually equal to `sourceRef`; kept separate because a projection may be
   * computed from a DERIVED artifact (a transform output) and the recoverable
   * object is then the parent. Naming the projection's input as the recovery
   * target would send a reader to bytes that are already reduced.
   */
  recoverableRef: z.string().min(1).max(MAX_LOCATOR_CHARS),
  /** Bytes of the source the projection carried. Established by construction. */
  selectedBytes: z.number().int().min(0),
  /** Items (lines, pages, records) the projection carried, when counted. */
  selectedItems: z.number().int().min(0).optional(),
  /**
   * Bytes NOT carried. `undefined` when the total was never established -- never
   * a fabricated 0, which would read as "nothing was omitted".
   */
  omittedBytes: z.number().int().min(0).optional(),
  /** Items NOT carried. `undefined` for the same reason as `omittedBytes`. */
  omittedItems: z.number().int().min(0).optional(),
  /**
   * Why this projection was made, in terms a reader can act on.
   *
   * Required and non-empty: a projection with no stated reason is
   * indistinguishable from a loss that was quietly reclassified. This field is
   * what keeps the two apart in the record itself rather than in a reviewer's
   * memory. Bounded like a gap reason, because it is written to the same log.
   */
  projectionReason: z.string().min(1).max(MAX_GAP_REASON_CHARS),
})
export type ProjectionManifest = z.infer<typeof projectionManifestSchema>

/** Where the observation came from. */
export const observationSourceSchema = z.object({
  kind: z.enum(['file', 'web', 'search', 'history', 'tool', 'derived']),
  /** The provider-specific address (path, URL, query, session ref). */
  locator: z.string().min(1).max(MAX_LOCATOR_CHARS).optional(),
  /** Which provider produced it, when the locator alone does not say. */
  provider: z.string().min(1).max(MAX_LOCATOR_CHARS).optional(),
  /** Host clock, ISO-8601. Host-authored: a kernel clock is not evidence. */
  acquiredAt: z.string().min(1).max(MAX_LOCATOR_CHARS),
  /** The execution world the bytes were read in (FS/SSH/sandbox identity). */
  executionWorld: z.string().min(1).max(MAX_LOCATOR_CHARS),
})
export type ObservationSource = z.infer<typeof observationSourceSchema>

/** The immutable object holding the acquired bytes. */
export const observationCapturedSchema = z.object({
  /**
   * Store-issued artifact reference. Not a filesystem path the kernel may open.
   *
   * Bounded because it is an ADDRESS, and an address longer than a filesystem
   * path cannot name an object this store issued. The bound is what stops a
   * descriptor from carrying an unbounded string into every projection.
   */
  artifact: z.string().min(1).max(MAX_LOCATOR_CHARS),
  /** Content hash, computed by the host WHILE streaming. */
  sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  bytes: z.number().int().min(0),
  mediaType: z.string().min(1).max(MAX_LOCATOR_CHARS),
})
export type ObservationCaptured = z.infer<typeof observationCapturedSchema>

/** What the request asked for, and what of it is present. */
export const observationAcquisitionSchema = z.object({
  completeness: z.enum(OBSERVATION_COMPLETENESS),
  /** Ranges / top-k scope / snapshot watermark. A claim about the REQUEST, not the world. */
  coverage: z.unknown(),
  gaps: z.array(observationGapSchema),
})
export type ObservationAcquisition = z.infer<typeof observationAcquisitionSchema>

/** Derivation provenance: which artifact this one was computed from. */
export const observationTransformSchema = z.object({
  /** Parent artifact reference. The original and the derivative stay separate objects. */
  parent: z.string().min(1).max(MAX_LOCATOR_CHARS),
  name: z.string().min(1).max(MAX_LOCATOR_CHARS),
  version: z.string().min(1).max(MAX_LOCATOR_CHARS),
})
export type ObservationTransform = z.infer<typeof observationTransformSchema>

/** Host-established authority. Not a capability the holder may present as proof. */
export const observationAuthoritySchema = z.object({
  /** The owner scope this observation is readable within. */
  ownerScope: z.string().min(1).max(MAX_LOCATOR_CHARS),
  /** Host grant revision at mint time; the descriptor dies when the host moves on. */
  grantRevision: z.number().int().min(0),
})
export type ObservationAuthority = z.infer<typeof observationAuthoritySchema>

/** The unified descriptor every native acquisition produces. */
export const observationDescriptorSchema = z.object({
  /**
   * Host-allocated observation id, bounded like every other address field.
   *
   * This is the field that made the projection's bound UNFALSIFIABLE before it
   * was bounded: `projectForModel` truncates gap reasons and notes but copies
   * `descriptor.id` through verbatim, so an id of 200,000 characters produced a
   * 200,316-byte "bounded" projection. Measured, then fixed here at the schema
   * so every consumer inherits the bound rather than each having to remember it.
   */
  id: z.string().min(1).max(MAX_LOCATOR_CHARS),
  schemaVersion: z.literal(OBSERVATION_SCHEMA_VERSION),
  source: observationSourceSchema,
  captured: observationCapturedSchema,
  acquisition: observationAcquisitionSchema,
  transform: observationTransformSchema.optional(),
  authority: observationAuthoritySchema,
})
export type ObservationDescriptor = z.infer<typeof observationDescriptorSchema>

/** Why an observation operation refused. Codes are stable so callers can branch. */
export type ObservationErrorCode =
  | 'observation-authority-forged'
  | 'observation-authority-stale'
  | 'observation-scope-denied'
  | 'observation-malformed'
  | 'observation-not-deliverable'
  /**
   * A stored descriptor carries a schema version this build does not read.
   *
   * Deliberately distinct from `observation-malformed`, and the distinction is
   * the reason the code exists: a version-1 descriptor is WELL FORMED, it just
   * means something different (its `model-projection` gap asserted a projection
   * was an acquisition loss). Reporting it as "malformed" would tell a caller
   * their data is corrupt when the truth is that the shape moved and the record
   * needs converting. A caller can retry a conversion; it cannot repair data
   * that was never broken.
   */
  | 'observation-schema-version-unsupported'

export class ObservationError extends Error {
  readonly code: ObservationErrorCode

  constructor(message: string, code: ObservationErrorCode, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'ObservationError'
    this.code = code
  }
}

/**
 * The dotted paths only the HOST may author.
 *
 * A kernel payload asserting any of these is refused. The list is dotted-path
 * shaped so the refusal message can name the exact field, which matters: a
 * caller that sent `captured.sha256` needs to know THAT is what was rejected,
 * not that "the descriptor was invalid".
 */
export const HOST_AUTHORED_PATHS: readonly string[] = Object.freeze([
  'id',
  'schemaVersion',
  'source.acquiredAt',
  'source.executionWorld',
  'captured',
  'captured.artifact',
  'captured.sha256',
  'captured.bytes',
  'captured.mediaType',
  'acquisition.completeness',
  'acquisition.coverage',
  'acquisition.gaps',
  'authority',
  'authority.ownerScope',
  'authority.grantRevision',
])

/**
 * What a kernel IS allowed to contribute to an observation.
 *
 * This type is the in-process defense: it has no field for a host-authored
 * fact, so a caller cannot pass one by mistake. {@link refuseForgedClaims} is
 * the wire defense for the case where an arbitrary JSON object arrives from
 * Python and no TypeScript type ever guarded it. Both are needed -- the type
 * cannot see a `JSON.parse` result, and the runtime check cannot see intent.
 */
export interface KernelObservationClaim {
  /** A locator the kernel suggests (e.g. the path it wants captured). */
  locator?: string
  /** A media type the kernel suggests. The host may override from the bytes. */
  mediaType?: string
  /** A transform the kernel declares it applied. Recorded as a CLAIM, not a proof. */
  transform?: { name: string; version: string }
}

/**
 * Refuse a payload that asserts host-authored facts.
 *
 * This is a REFUSAL, not a merge. Merging a kernel-asserted `sha256` over a
 * host-computed one would make the descriptor's strongest field the one an
 * untrusted producer controls; ignoring it silently would let a Python payload
 * believe it had set an authority fact. So the caller is told, by path.
 *
 * @param payload - an arbitrary value received from the kernel.
 * @throws ObservationError `observation-authority-forged` naming every offending path.
 */
export function refuseForgedClaims(payload: unknown): void {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return
  const record = payload as Record<string, unknown>
  const forged: string[] = []
  for (const path of HOST_AUTHORED_PATHS) {
    const [head, tail] = path.split('.', 2) as [string, string | undefined]
    if (!Object.hasOwn(record, head)) continue
    if (tail === undefined) {
      forged.push(path)
      continue
    }
    const nested = record[head]
    if (typeof nested === 'object' && nested !== null && Object.hasOwn(nested as Record<string, unknown>, tail)) {
      forged.push(path)
    }
  }
  if (forged.length > 0) {
    throw new ObservationError(
      `kernel payload asserts host-authored observation facts: ${forged.join(', ')}`,
      'observation-authority-forged',
    )
  }
}

/** A host grant table entry: who may read, and at which revision. */
export interface GrantEntry {
  /** The scope name (project, session, workspace). */
  ownerScope: string
  /** Monotonic revision. A permission-domain change bumps it and kills old descriptors. */
  grantRevision: number
}

/**
 * The host's authority source.
 *
 * Deliberately a mutable counter, not a signed token: the audit's rule is that
 * authority is host-authored and a kernel-held copy is not proof. Keeping the
 * live revision here means a descriptor minted under revision 1 stops being
 * usable the moment the host bumps the scope to 2 -- which is what must happen
 * when the read permission domain changes (ARCHITECTURE §10/§12: a permission
 * change must not carry old variables into a new read domain).
 */
export class GrantTable {
  private readonly revisions = new Map<string, number>()

  /** Establish or bump a scope's revision. Returns the new revision. */
  bump(ownerScope: string): number {
    const next = (this.revisions.get(ownerScope) ?? 0) + 1
    this.revisions.set(ownerScope, next)
    return next
  }

  /** The current revision for a scope, or `undefined` when the scope is unknown. */
  revisionOf(ownerScope: string): number | undefined {
    return this.revisions.get(ownerScope)
  }

  /** Whether a descriptor's authority still matches the live grant. */
  stillValid(authority: ObservationAuthority): boolean {
    return this.revisions.get(authority.ownerScope) === authority.grantRevision
  }
}

/** Host-established facts needed to mint a descriptor. Every field is host-authored. */
export interface HostObservationFacts {
  id: string
  source: {
    kind: ObservationSourceKind
    locator?: string
    provider?: string
    acquiredAt: string
    executionWorld: string
  }
  captured: ObservationCaptured
  acquisition: ObservationAcquisition
  authority: ObservationAuthority
}

/**
 * Mint a descriptor from host facts plus an optional kernel claim.
 *
 * The kernel's contribution is limited to a suggested locator/media type and a
 * DECLARED transform. A declared transform is recorded under `transform` with
 * the kernel's own name/version, which the audit requires be distinguishable
 * from a host-observed transform: it proves what the kernel SAYS it did, and
 * nothing about whether the derivation is correct.
 *
 * @param facts - host-established facts; the caller has already streamed the bytes.
 * @param claim - the optional kernel contribution; cannot express a host fact.
 * @returns the validated descriptor.
 */
export function mintObservation(facts: HostObservationFacts, claim?: KernelObservationClaim): ObservationDescriptor {
  const descriptor: ObservationDescriptor = {
    id: facts.id,
    schemaVersion: OBSERVATION_SCHEMA_VERSION,
    source: {
      kind: facts.source.kind,
      ...(facts.source.locator ?? claim?.locator) !== undefined
        ? { locator: facts.source.locator ?? claim?.locator }
        : {},
      ...facts.source.provider !== undefined ? { provider: facts.source.provider } : {},
      acquiredAt: facts.source.acquiredAt,
      executionWorld: facts.source.executionWorld,
    },
    captured: facts.captured,
    acquisition: facts.acquisition,
    ...claim?.transform !== undefined
      ? { transform: { parent: facts.captured.artifact, name: claim.transform.name, version: claim.transform.version } }
      : {},
    authority: facts.authority,
  }
  return observationDescriptorSchema.parse(descriptor)
}

/**
 * Validate a stored descriptor, refusing a stale grant.
 *
 * Staleness is checked here rather than at the call site because every read
 * path must check it and a call site that forgets would serve bytes across a
 * permission-domain change.
 *
 * @param value - the stored value, already parsed from JSON.
 * @param grants - the live grant table.
 * @throws ObservationError `observation-schema-version-unsupported` for an older
 *   shape, `observation-malformed` for a value that is not a descriptor at all,
 *   or `observation-authority-stale` when the live grant has moved on.
 */
export function parseObservation(value: unknown, grants: GrantTable): ObservationDescriptor {
  // THE VERSION IS CHECKED BEFORE THE SHAPE, and the order is the point.
  //
  // `observationDescriptorSchema` pins `schemaVersion` with a `z.literal`, so a
  // v1 descriptor fails it -- and would be reported as "malformed". That is the
  // wrong diagnosis for the right refusal: the record is not corrupt, its
  // MEANING moved (v1's `model-projection` gap asserted a deliberate projection
  // was an acquisition loss). A caller told "malformed" would go looking for a
  // corrupt write that never happened. Reading the version first lets the
  // refusal name the real cause and stay actionable: convert the record.
  //
  // A record with NO readable version is left to the schema, which reports it as
  // malformed -- correctly, because there is nothing to convert.
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    const declared = (value as Record<string, unknown>).schemaVersion
    if (typeof declared === 'number' && declared !== OBSERVATION_SCHEMA_VERSION) {
      throw new ObservationError(
        `stored observation descriptor declares schema version ${String(declared)}, but this build reads `
        + `${String(OBSERVATION_SCHEMA_VERSION)}. This is a CONVERSION, not a corruption: a version-1 `
        + 'descriptor recorded a deliberate model projection as an acquisition gap, which DATA-09 no longer '
        + 'expresses. Re-read it under the version it was written with, or convert it; do not reinterpret it.',
        'observation-schema-version-unsupported',
      )
    }
  }
  const parsed = observationDescriptorSchema.safeParse(value)
  if (!parsed.success) {
    throw new ObservationError('stored observation descriptor is malformed', 'observation-malformed', { cause: parsed.error })
  }
  if (!grants.stillValid(parsed.data.authority)) {
    throw new ObservationError(
      `observation ${parsed.data.id} was minted under ${parsed.data.authority.ownerScope}@${parsed.data.authority.grantRevision}, `
      + 'which is no longer the live grant',
      'observation-authority-stale',
    )
  }
  return parsed.data
}

/**
 * Whether a descriptor may be delivered as a complete value.
 *
 * `partial` and `unknown` are both non-deliverable as "the value": the audit
 * forbids reporting an unknown as success and forbids returning an empty string
 * for a missing object. A caller with a partial observation must either page
 * the captured artifact (recovery `page`) or refetch as a NEW observation.
 */
export function isDeliverableAsComplete(descriptor: ObservationDescriptor): boolean {
  return descriptor.acquisition.completeness === 'complete-within-request'
}

/**
 * A descriptor plus a coverage claim about the REQUEST, never the world.
 *
 * `requestedRange` is what the caller asked for; `receivedBytes` is what the
 * host actually captured. The two together are what make `partial` falsifiable
 * instead of a judgement call.
 */
export function coverageForRequest(input: {
  requestedRange?: { offset: number; length?: number }
  receivedBytes: number
  snapshotWatermark?: string
}): JsonValue {
  const coverage: { [key: string]: JsonValue } = {
    receivedBytes: input.receivedBytes,
    claimScope: 'request',
  }
  if (input.requestedRange !== undefined) {
    coverage.requestedRange = {
      offset: input.requestedRange.offset,
      ...input.requestedRange.length !== undefined ? { length: input.requestedRange.length } : {},
    }
  }
  if (input.snapshotWatermark !== undefined) coverage.snapshotWatermark = input.snapshotWatermark
  return coverage
}

/**
 * Record a DELIBERATE projection as a manifest.
 *
 * This is the function that replaces "append a `model-projection` gap". It is
 * the only supported way to record that a model was shown less than the artifact
 * holds, and it produces a {@link ProjectionManifest} rather than an
 * {@link ObservationGap} -- so the two facts cannot be conflated by a caller
 * passing the wrong argument to the wrong function.
 *
 * THE OMITTED COUNTS ARE COMPUTED, NOT ACCEPTED, whenever both operands are
 * known. A caller cannot pass `omittedBytes` directly, because a caller that
 * computed it wrong (or that reported 0 for a projection it knew was partial)
 * would write a false completeness claim into the record. Passing
 * `sourceBytes` and letting this function subtract makes the arithmetic the
 * module's, so "selected + omitted = source" holds by construction rather than
 * by the caller's care.
 *
 * WHY `sourceBytes` IS OPTIONAL AND `selectedBytes` IS NOT. A projection always
 * knows what it carried -- that is the payload it is holding. It does not always
 * know the total: a projection over a stream that was never measured cannot
 * report how much it omitted. When the total is unknown the omitted fields stay
 * `undefined`, which is the honest third state; a fabricated `0` would assert a
 * complete projection, the most misleading value available.
 *
 * @param input - the projection's measured facts.
 * @returns the validated manifest.
 * @throws ObservationError `observation-malformed` when the facts are not a manifest.
 */
export function recordProjection(input: {
  /** The artifact projected from. Required: a projection with no source is unverifiable. */
  sourceRef: string
  /** Where the omitted bytes live. Defaults to `sourceRef`; see the schema note. */
  recoverableRef?: string
  /** Bytes of the source the projection carried. Known by construction. */
  selectedBytes: number
  /** Items carried, when counted. */
  selectedItems?: number
  /** Total source bytes, when established. Omitted counts are derived from it. */
  sourceBytes?: number
  /** Total source items, when counted. */
  sourceItems?: number
  /** Why the projection was made. Required and non-empty. */
  projectionReason: string
}): ProjectionManifest {
  const omittedBytes = input.sourceBytes === undefined
    ? undefined
    : Math.max(0, input.sourceBytes - input.selectedBytes)
  const omittedItems = input.sourceItems === undefined || input.selectedItems === undefined
    ? undefined
    : Math.max(0, input.sourceItems - input.selectedItems)
  return projectionManifestSchema.parse({
    sourceRef: input.sourceRef,
    recoverableRef: input.recoverableRef ?? input.sourceRef,
    selectedBytes: input.selectedBytes,
    ...input.selectedItems === undefined ? {} : { selectedItems: input.selectedItems },
    ...omittedBytes === undefined ? {} : { omittedBytes },
    ...omittedItems === undefined ? {} : { omittedItems },
    projectionReason: input.projectionReason,
  })
}

/**
 * Whether a manifest describes a projection that withheld anything.
 *
 * THREE STATES, not two, and the third is why this returns a string rather than
 * a boolean. `false` would collapse "nothing was omitted" and "we never
 * established how much was omitted" into one answer, which is the same
 * fabrication `recordProjection` refuses when it leaves the counts undefined.
 *
 * @param manifest - the projection manifest.
 * @returns `complete` when nothing was withheld, `partial` when bytes or items
 *   were, and `unknown` when the totals were never established.
 */
export function projectionWithheld(manifest: ProjectionManifest): 'complete' | 'partial' | 'unknown' {
  if (manifest.omittedBytes === undefined && manifest.omittedItems === undefined) return 'unknown'
  if ((manifest.omittedBytes ?? 0) > 0 || (manifest.omittedItems ?? 0) > 0) return 'partial'
  return 'complete'
}
