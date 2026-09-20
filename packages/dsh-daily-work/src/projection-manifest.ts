/**
 * The model-projection manifest (V3 §K6 / D2).
 *
 * WHY THIS IS A SEPARATE FILE AND A SEPARATE TYPE.
 *
 * D2 splits two things v1 conflated:
 *
 *   AcquisitionCoverage — did the world/provider/transport actually give us the
 *                         bytes? A failure of the WORLD.
 *   ProjectionManifest  — we have the canonical bytes, and this is how much of
 *                         them the model was shown. A CHOICE we made.
 *
 * `observations.ts` owns the acquisition vocabulary and its stage enum, and
 * writer R8 owns the taxonomy work there. This file therefore does NOT add a
 * stage, does NOT edit `OBSERVATION_GAP_STAGES`, and does NOT touch
 * `acquisition.gaps` at all. It records the projection as its own fact.
 *
 * WHY THE DISTINCTION IS LOAD-BEARING, not bookkeeping: recording a deliberate
 * projection as a loss makes an honest system look broken and a broken system
 * look honest. A 32 MiB artifact whose 400-byte summary reached the model is the
 * data plane WORKING; the same record filed as an acquisition gap would be
 * indistinguishable from a provider that truncated the download.
 *
 * THE FOUR FACTS A MANIFEST MUST CARRY (V3 §K6):
 *   - source refs;
 *   - selection code/version when material;
 *   - selected byte/item counts;
 *   - omitted counts when knowable;
 *   - emitted content digest;
 *   - recoverability refs.
 *
 * "WHEN KNOWABLE" IS NOT HEDGING. An omission count is only recorded when the
 * producer actually knows it. A projection that walked pages to exhaustion knows
 * `omittedBytes` exactly; a projection that stopped at a page budget knows it is
 * an under-count and says `unknown` rather than reporting the pages it happened
 * to see as the whole. Writing a number that was never measured is the failure
 * this field would otherwise introduce.
 */
import { createHash } from 'node:crypto'

/**
 * How a projection was selected.
 *
 * `exhaustive` means the projection saw the whole artifact. `bounded` means it
 * stopped at a budget, so its omission count is a floor. `sampled` means it
 * deliberately took a subset. The three are not interchangeable: only
 * `exhaustive` makes `omittedBytes` an exact measurement.
 */
export type ProjectionMode = 'exhaustive' | 'bounded' | 'sampled' | 'head'

/** The identity of the code that chose what to show. */
export interface ProjectionSelector {
  /** Stable name of the selection, e.g. `dsh.data.summary`. */
  readonly name: string
  /** Version of the SELECTION RULE, bumped when what it selects changes. */
  readonly version: string
  /**
   * Digest of the selection code when the code itself is available.
   *
   * Recorded because a name and a version are claims by the producer, while a
   * digest is a fact about the bytes. Optional because a caller assembling a
   * manifest from a Python cell may not have the host's source to hand, and
   * inventing a digest for code it cannot read would be worse than omitting it.
   */
  readonly digest?: string
}

/** One source the projection was derived from. */
export interface ProjectionSourceRef {
  /** The observation id the bytes were captured under. */
  readonly observationId: string
  /** The artifact ref (content-addressed). */
  readonly artifact: string
  /** The artifact's own digest, so the projection names exact bytes. */
  readonly sha256: string
  /** The artifact's full size, so a reader can see the ratio without the bytes. */
  readonly artifactBytes: number
}

/** The manifest. */
export interface ProjectionManifest {
  readonly schemaVersion: 1
  /**
   * The kind of record this is.
   *
   * Present so a consumer reading a heterogeneous log can tell a projection from
   * an acquisition record WITHOUT inspecting the fields, and so a projection can
   * never be mistaken for a descriptor.
   */
  readonly kind: 'projection-manifest'
  /** Where the shown bytes came from. */
  readonly sources: readonly ProjectionSourceRef[]
  readonly mode: ProjectionMode
  readonly selector: ProjectionSelector
  /** Bytes the projection actually selected. */
  readonly selectedBytes: number
  /** Items the projection selected, when the selection is item-shaped. */
  readonly selectedItems?: number
  /**
   * Bytes NOT selected, when the producer knows the number.
   *
   * `undefined` means UNKNOWABLE for this projection -- never zero. A zero here
   * would claim the projection was exhaustive, which is a different fact and is
   * stated by {@link mode}.
   */
  readonly omittedBytes?: number
  /** Items not selected, same rule as {@link omittedBytes}. */
  readonly omittedItems?: number
  /**
   * Whether `omittedBytes` is an exact count or a floor.
   *
   * A `bounded` projection that stopped early can only bound its omission from
   * below. Recording that distinction is what stops a floor from being read as
   * an exact number.
   */
  readonly omittedIsExact: boolean
  /** sha256 over the emitted bytes, so the projection itself is identifiable. */
  readonly emittedSha256: string
  /** Bytes of the emitted payload, i.e. what entered the next model request. */
  readonly emittedBytes: number
  /**
   * Refs that make the omitted bytes recoverable.
   *
   * This is the field that keeps a projection honest: a projection with no
   * recoverability ref would be a loss, and the presence of one is what makes it
   * a choice. A manifest with omitted bytes and NO recoverability ref is refused
   * at construction.
   */
  readonly recoverability: readonly string[]
  /** Host clock, ISO-8601. */
  readonly createdAt: string
  /**
   * The sentence every reader needs, carried as a field rather than a comment.
   *
   * A manifest proves what the model was SHOWN. It proves nothing about whether
   * the shown bytes are true, and nothing about whether a conclusion drawn from
   * them is correct.
   */
  readonly manifestProves: 'which bytes were selected for the model, and that the remainder is recoverable; not truth, and not the correctness of any conclusion'
}

/** Input to {@link buildProjectionManifest}. */
export interface ProjectionManifestInput {
  readonly sources: readonly ProjectionSourceRef[]
  readonly mode: ProjectionMode
  readonly selector: ProjectionSelector
  readonly selectedBytes: number
  readonly selectedItems?: number
  /** Omit when unknowable. NEVER pass 0 to mean "unknown". */
  readonly omittedBytes?: number
  readonly omittedItems?: number
  /** Required when `omittedBytes` is set: how the omitted bytes can be re-read. */
  readonly recoverability?: readonly string[]
  /** The exact emitted payload. Its digest and byte length are computed here. */
  readonly emitted: string | Uint8Array
  readonly now?: () => Date
}

/**
 * Build a projection manifest, refusing the two shapes that would make it lie.
 *
 * REFUSAL 1: omitted bytes with no recoverability ref. That combination is a
 * LOSS, not a projection, and filing it as a projection is exactly the
 * conflation D2 exists to prevent.
 *
 * REFUSAL 2: a negative or non-integer count. A negative omission would make
 * `selected + omitted` nonsense, and a fractional byte count is not a count.
 *
 * @param input - the measured projection facts.
 * @returns the manifest.
 * @throws when the projection is not honestly describable.
 */
export function buildProjectionManifest(input: ProjectionManifestInput): ProjectionManifest {
  const emittedBytes = typeof input.emitted === 'string'
    ? Buffer.byteLength(input.emitted, 'utf8')
    : input.emitted.byteLength
  const emittedSha256 = createHash('sha256').update(input.emitted).digest('hex')

  const counts: Array<[string, number | undefined]> = [
    ['selectedBytes', input.selectedBytes],
    ['selectedItems', input.selectedItems],
    ['omittedBytes', input.omittedBytes],
    ['omittedItems', input.omittedItems],
  ]
  for (const [name, value] of counts) {
    if (value === undefined) continue
    if (!Number.isInteger(value) || value < 0) {
      throw new Error(
        `projection manifest: ${name} must be a non-negative integer when present, got ${String(value)}; `
        + 'omit the field when the count is unknowable rather than writing a number that was not measured',
      )
    }
  }

  const omitted = input.omittedBytes !== undefined || input.omittedItems !== undefined
  const recoverability = input.recoverability ?? []
  if (omitted && recoverability.length === 0) {
    throw new Error(
      'projection manifest: a projection that omitted bytes must name how they are recoverable. '
      + 'A projection with omitted bytes and no recoverability ref is a LOSS, not a projection -- '
      + 'file it as an acquisition gap instead of describing it as a choice.',
    )
  }

  return {
    schemaVersion: 1,
    kind: 'projection-manifest',
    sources: input.sources,
    mode: input.mode,
    selector: input.selector,
    selectedBytes: input.selectedBytes,
    ...input.selectedItems !== undefined ? { selectedItems: input.selectedItems } : {},
    ...input.omittedBytes !== undefined ? { omittedBytes: input.omittedBytes } : {},
    ...input.omittedItems !== undefined ? { omittedItems: input.omittedItems } : {},
    // `exhaustive` is the only mode whose omission is a measurement; every other
    // mode bounds it from below, so the flag is derived rather than asked for --
    // a caller cannot claim exactness its mode does not support.
    omittedIsExact: input.mode === 'exhaustive',
    emittedSha256,
    emittedBytes,
    recoverability,
    createdAt: (input.now ?? (() => new Date()))().toISOString(),
    manifestProves: 'which bytes were selected for the model, and that the remainder is recoverable; not truth, and not the correctness of any conclusion',
  }
}

/**
 * Whether a manifest's omission count is a measurement or a floor.
 *
 * Exposed as a function rather than left to each reader because the two answers
 * lead to different actions: an exact count says "nothing else exists", a floor
 * says "call again with a bigger budget".
 *
 * @param manifest - the manifest to classify.
 * @returns `exact` when the omission is fully determined, `floor` otherwise.
 */
export function omissionKind(manifest: ProjectionManifest): 'exact' | 'floor' | 'none' {
  if (manifest.omittedBytes === undefined && manifest.omittedItems === undefined) return 'none'
  return manifest.omittedIsExact ? 'exact' : 'floor'
}
