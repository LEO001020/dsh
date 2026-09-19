/**
 * The observation vocabulary: one descriptor for every native acquisition.
 *
 * WHY A DESCRIPTOR AND NOT A `truncated` BOOLEAN
 *
 * The audit's finding (ARCHITECTURE §6) is that "truncated" collapses at least
 * six different losses into one bit, and the six have different recovery rules:
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
 *   transport             RPC/Jupyter frame loss. Becomes error/unknown, never
 *                         an empty string and never a clean EOF.
 *   model projection      the model saw 10 lines of a complete artifact.
 *                         A small projection is NOT evidence of a small source.
 *
 * So `acquisition.gaps[]` records WHICH stage lost WHAT and HOW (if at all) it
 * can be recovered. `completeness` is scoped: `complete-within-request` is a
 * claim about the REQUESTED RANGE, never about the world.
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
 */
export const OBSERVATION_SCHEMA_VERSION = 1

/** What kind of thing was observed. */
export type ObservationSourceKind = 'file' | 'web' | 'search' | 'history' | 'tool' | 'derived'

/**
 * The six loss layers, named so a gap can be attributed without ambiguity.
 * These are stages of the ACQUISITION pipeline, not severities.
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
  /** The transport lost messages or hit a frame limit. */
  'transport',
  /** The model saw less than the artifact holds. The artifact is still complete. */
  'model-projection',
] as const

export type ObservationGapStage = (typeof OBSERVATION_GAP_STAGES)[number]

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
 * that implies the rest arrived intact. `model-projection` likewise has no name,
 * because a smaller projection is not a loss of the artifact -- it is the
 * normal, intended outcome, and it is reported separately by
 * `projectForModel`'s `projection` block rather than as a coverage verdict.
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
 */
const GAP_STAGE_PRECEDENCE: readonly ObservationGapStage[] = [
  'provider-acquisition',
  'native-acquisition',
  'transform',
  'retention',
  'transport',
  'model-projection',
]

/**
 * The reported coverage verdict for a descriptor.
 *
 * The mapping is total and is the ONLY place it is written, so two consumers
 * cannot disagree about what a given `(completeness, gaps)` pair means.
 *
 * A `partial` observation whose gaps name only `transport` reports `unknown`
 * rather than a partial label: a lost frame is an absence that was never
 * established, and labelling it `partial-*` would assert that the bytes which
 * did arrive are the whole of what did.
 *
 * A `partial` observation with NO gaps also reports `unknown`: the record claims
 * a loss it cannot attribute, which is not enough to name a layer.
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
      // Neither layer has a name in this vocabulary; see the doc comment above.
      case 'transport':
      case 'model-projection':
        return 'unknown'
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
 * @throws ObservationError `observation-malformed` or `observation-authority-stale`.
 */
export function parseObservation(value: unknown, grants: GrantTable): ObservationDescriptor {
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
