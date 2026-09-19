/**
 * M9 instrumentation: provider-normalized cost accounting and real performance
 * measurement.
 *
 * WHY COST LIVES IN A FILE NAMED FOR PERFORMANCE. The delivery plan's M9 is one
 * work item — "cache, cost, performance" — and its single rule is that a token
 * count is not a bill. The two halves cannot be separated without losing that
 * rule: the cost side needs the byte and latency side to explain WHY a cheaper
 * token count can be a more expensive bill (a smaller prompt with less cache
 * reuse pays the fresh-input price on more tokens). So this module holds both,
 * and its header states the coupling rather than leaving a reader to wonder why
 * pricing is here.
 *
 * WHAT THIS MODULE IS NOT. It is not a second ledger. Attempt rows come from
 * `UsageLedger` in `record.ts`, which already owns `root | child | retry |
 * compaction | summary | search`, its separate unknown counts and its
 * one-request-one-charge rule. This module ADDS the layer the plan asks for on
 * top of those rows: provider-normalized pricing with an explicit refusal to
 * apply one vendor's field semantics to another, and the measurement meters the
 * plan names. A parallel ledger here would be the duplication the audit forbids.
 *
 * THE THREE THINGS THIS FILE REFUSES TO DO
 * ========================================
 *
 *   1. It never substitutes zero for an unknown. An attempt whose usage never
 *      arrived prices to `known: false`, and `totalCost` reports the summed
 *      known charges as a LOWER BOUND on the bill rather than as the bill.
 *   2. It never prices an attempt under a provider the attempt did not name, and
 *      it never falls back to a default price table. `PriceBook.require` throws
 *      on an unregistered provider, because a fallback is how vendor A's
 *      cache-read formula silently becomes vendor B's.
 *   3. It never treats an absent price as a zero price. A provider whose wire
 *      protocol has no cache-write concept reports that line as INAPPLICABLE; a
 *      provider that bills cache storage but whose retention duration was not
 *      supplied reports the line as UNPRICED and the total as incomplete.
 *      "No such charge" and "a charge of nothing" are different facts and the
 *      module keeps them apart.
 *
 * @module perf-metrics
 */

import type { UsageAttempt, UsageBuckets, UsageLedger, UsageSource } from './record.ts'
// Value import: the total enumerates every source, so an empty category is
// visible as a zero line rather than as an absent entry. Reading the list from
// the ledger's own declaration is what keeps the two from drifting.
import { USAGE_SOURCES } from './record.ts'

// ---------------------------------------------------------------------------
// Provider-normalized pricing
// ---------------------------------------------------------------------------

/**
 * One provider's price table, in the currency unit per one million tokens.
 *
 * THE FIELD SET IS THE CONTRACT, not the numbers. Which optional cache fields a
 * provider has is decided by its wire protocol, and that is verifiable in this
 * checkout rather than assumed:
 *
 *   - `@deepseek-ai/dsh-llm-deepseek`'s chat-completions translator builds
 *     `TokenUsage` from `prompt_tokens`/`completion_tokens` and
 *     `prompt_cache_hit_tokens`, and NEVER emits `cacheWriteTokens`
 *     (`packages/llm/llm-deepseek/src/protocols/chat-completions/translate.ts:64-71`).
 *     So for that protocol `cacheWritePerMillion` must be ABSENT: a cache-write
 *     charge is not zero there, it does not exist.
 *   - the messages protocol translates BOTH `cache_read_input_tokens` and
 *     `cache_creation_input_tokens`
 *     (`packages/llm/llm-deepseek/src/protocols/messages/translate.ts:36`), and
 *     pi-ai's adapter passes both `usage.cacheRead` and `usage.cacheWrite`
 *     through (`packages/llm/llm-pi-ai/src/stream.ts:29-30`). Those routes have
 *     both fields.
 *
 * The UNIT PRICES are controlled inputs, not vendor facts. No price is asserted
 * here as current: a price that changed would make this file wrong in a way no
 * test could see. What the tests depend on is the ORDERING that makes the
 * counterexample in ECO-05 possible — a cache read costs less than fresh input —
 * and that ordering is stated at each table rather than buried.
 */
export interface ProviderPricing {
  /** Provider route key this table belongs to. Must equal the attempt's provider. */
  readonly provider: string
  /**
   * Frozen price version. Carried into every priced attempt so a total can be
   * read against the table that produced it; a total whose lines came from two
   * versions is not comparable to either.
   */
  readonly priceVersion: string
  readonly currency: string
  /** Currency per 1e6 FRESH (uncached) input tokens. */
  readonly freshInputPerMillion: number
  /** Currency per 1e6 cache-read tokens. */
  readonly cacheReadPerMillion: number
  /** Currency per 1e6 output tokens (reasoning included, as DSH reports it). */
  readonly outputPerMillion: number
  /**
   * Currency per 1e6 cache-WRITE tokens.
   *
   * ABSENT means the provider's protocol has no cache-write concept at all. It
   * does NOT mean the write is free. An attempt that reports cache-write tokens
   * under a table that omits this field is a CONTRADICTION and `priceAttempt`
   * throws rather than quietly dropping the tokens.
   */
  readonly cacheWritePerMillion?: number
  /**
   * Currency per 1e6 cached-prefix TOKEN-HOURS, for providers that bill the
   * retention of a cached prefix separately from writing it.
   *
   * ABSENT means this provider does not bill retention as its own line.
   * PRESENT means a duration is required to price it, and `priceAttempt` reports
   * the line UNPRICED when no duration was supplied — never zero.
   */
  readonly cacheStoragePerMillionTokenHours?: number
}

/** One charge line. `undefined` means UNPRICEABLE, which is not the same as 0. */
export interface ChargeLine {
  readonly freshInput: number
  readonly cachedInput: number
  readonly output: number
  /** `undefined` when the provider has no cache-write charge, or the line is unpriceable. */
  readonly cacheWrite: number | undefined
  /** `undefined` when the provider has no storage charge, or no duration was supplied. */
  readonly cacheStorage: number | undefined
}

/**
 * Why a line is absent from a total.
 *
 * The two reasons must never be merged: `inapplicable` is a fact about the
 * provider's protocol, `unpriced` is a fact about this run's inputs. Only the
 * second makes the total incomplete, and a report that collapsed them would
 * either claim incompleteness everywhere or hide it where it matters.
 */
export type LineStatus =
  /** The provider's protocol has no such charge. Not a zero charge — no charge. */
  | 'inapplicable'
  /** The provider does bill it, but an input needed to compute it is missing. */
  | 'unpriced'

export interface PricedAttempt {
  readonly attemptId: string
  readonly source: UsageSource
  readonly provider: string
  readonly model: string
  readonly priceVersion: string
  readonly currency: string
  /**
   * Whether this attempt's own usage was known. False means every charge below
   * is a placeholder zero and the attempt is a GAP in the total.
   */
  readonly known: boolean
  readonly charges: ChargeLine
  /** Sum of the priceable lines. For an unknown attempt this is 0 and means nothing. */
  readonly subtotal: number
  /** Charge-line names this provider does not bill at all. */
  readonly inapplicable: readonly ChargeLineName[]
  /** Charge-line names this provider bills but which could not be computed. */
  readonly unpriced: readonly ChargeLineName[]
  /**
   * The TOKEN buckets this attempt's charges were computed from, when its usage
   * was known. Carried so a total can report tokens and money side by side
   * without re-reading the ledger and without deriving one from the other.
   */
  readonly buckets?: UsageBuckets
  /** Free-form reasons, one per entry in `unpriced`. */
  readonly notes: readonly string[]
}

/**
 * The named charge lines.
 *
 * A closed union rather than free strings, because the whole point of the
 * inapplicable/unpriced split is that a reader can enumerate which lines a
 * provider has and which of those were computed. A typo in a string literal
 * would silently create a line nobody checks.
 */
export const CHARGE_LINES = ['freshInput', 'cachedInput', 'output', 'cacheWrite', 'cacheStorage'] as const
export type ChargeLineName = (typeof CHARGE_LINES)[number]

/**
 * Price an attempt whose usage is UNKNOWN.
 *
 * Split out from {@link priceAttempt} so the unknown case is a value this module
 * RETURNS rather than a branch it must remember to keep. The property ECO-02
 * names — a missing usage is unknown, not zero — is then enforced by the shape
 * of the code instead of by control flow: there is no path from here into the
 * priced computation, and no `usage` in scope that could be defaulted.
 *
 * Every charge line is 0 because NOTHING WAS PRICED, and `known: false` is the
 * only thing that distinguishes that from a measured-zero charge. A caller that
 * read `subtotal` without checking `known` would read 0; `totalCost` is the
 * caller that does not, and it reports the attempt as an unknown attempt rather
 * than adding this zero to the bill.
 *
 * @param input.attempt - the row whose usage never arrived.
 * @param input.pricing - the price table, for its version and currency.
 * @param input.provider - the provider route the attempt ran on.
 * @param input.model - the model id, carried for the reader.
 * @returns the unknown priced attempt. Never throws.
 */
function priceUnknownAttempt(input: {
  readonly attempt: UsageAttempt
  readonly pricing: ProviderPricing
  readonly provider: string
  readonly model: string
}): PricedAttempt {
  return {
    attemptId: input.attempt.attemptId,
    source: input.attempt.source,
    provider: input.provider,
    model: input.model,
    priceVersion: input.pricing.priceVersion,
    currency: input.pricing.currency,
    known: false,
    charges: { freshInput: 0, cachedInput: 0, output: 0, cacheWrite: undefined, cacheStorage: undefined },
    subtotal: 0,
    inapplicable: [],
    unpriced: [],
    notes: ['no usage was reported for this attempt; the ledger keeps it unknown and no charge is invented'],
  }
}

/**
 * The one place an attempt's tokens become money.
 *
 * @param input.attempt - the attempt row from `UsageLedger`. Its `usage` being
 *   absent means UNKNOWN and is carried through as `known: false`; there is no
 *   `?? 0` on that path.
 * @param input.pricing - the price table, which MUST name the same provider as
 *   `input.provider`. A mismatch throws.
 * @param input.provider - the provider route the attempt ran on.
 * @param input.model - the model id the attempt ran on, carried for the reader.
 * @param input.cacheStorageTokenHours - cached-prefix retention, in token-hours
 *   (`cachedPrefixTokens * hoursRetained`). Required when the table bills
 *   storage; its absence makes that line `unpriced`, not zero.
 * @returns the priced attempt, with inapplicable and unpriced lines named.
 * @throws when the provider disagrees with the price table, or when the attempt
 *   reports cache-write tokens under a table whose protocol has no such field.
 *   Both are the "one vendor's formula applied to another" failure the ECO-03
 *   oracle names, and neither can be detected by arithmetic after the fact.
 */
export function priceAttempt(input: {
  readonly attempt: UsageAttempt
  readonly pricing: ProviderPricing
  readonly provider: string
  readonly model: string
  readonly cacheStorageTokenHours?: number
}): PricedAttempt {
  const { attempt, pricing } = input
  if (input.provider !== pricing.provider) {
    throw new Error(
      `priceAttempt: attempt "${attempt.attemptId}" ran on provider "${input.provider}" but the price table `
      + `belongs to "${pricing.provider}"; applying it would price one vendor's tokens with another's formula`,
    )
  }

  // ONE binding, read once, and narrowed by this guard alone. Everything below
  // this point operates on a `UsageBuckets`, never on `UsageAttempt['usage']`,
  // so `strictNullChecks` makes "an unknown usage reached the priced path" a
  // compile error rather than a runtime surprise. This is the structural
  // replacement for the `usage!` a future edit might otherwise reach for.
  const usage: UsageBuckets | undefined = attempt.usage
  if (usage === undefined) {
    return priceUnknownAttempt({
      attempt,
      pricing,
      provider: input.provider,
      model: input.model,
    })
  }

  return priceKnownAttempt({
    attempt,
    pricing,
    provider: input.provider,
    model: input.model,
    usage,
    ...input.cacheStorageTokenHours === undefined
      ? {}
      : { cacheStorageTokenHours: input.cacheStorageTokenHours },
  })
}

/**
 * Price an attempt whose usage IS known.
 *
 * `usage` is a required, non-optional parameter. That is the point of the split:
 * a caller cannot reach this function without a `UsageBuckets` in hand, so the
 * "missing usage is unknown, not zero" rule cannot be broken from here by a
 * later edit that forgets a check.
 */
function priceKnownAttempt(input: {
  readonly attempt: UsageAttempt
  readonly pricing: ProviderPricing
  readonly provider: string
  readonly model: string
  readonly usage: UsageBuckets
  readonly cacheStorageTokenHours?: number
}): PricedAttempt {
  const { attempt, pricing, usage } = input
  const inapplicable: ChargeLineName[] = []
  const unpriced: ChargeLineName[] = []
  const notes: string[] = []
  const perMillion = (rate: number, tokens: number): number => (rate / 1_000_000) * tokens

  let cacheWrite: number | undefined
  if (pricing.cacheWritePerMillion === undefined) {
    if (usage.cacheWriteTokens > 0) {
      throw new Error(
        `priceAttempt: attempt "${attempt.attemptId}" reports ${usage.cacheWriteTokens} cache-write tokens but `
        + `provider "${pricing.provider}" declares no cache-write charge; a cache-write field from another `
        + "provider's protocol is being applied here",
      )
    }
    // Absent field AND no tokens: the protocol has no such charge. Named, not
    // silently zeroed, because "not billed" and "billed at zero" differ.
    cacheWrite = undefined
    inapplicable.push('cacheWrite')
  } else {
    cacheWrite = perMillion(pricing.cacheWritePerMillion, usage.cacheWriteTokens)
  }

  let cacheStorage: number | undefined
  if (pricing.cacheStoragePerMillionTokenHours === undefined) {
    cacheStorage = undefined
    inapplicable.push('cacheStorage')
  } else if (input.cacheStorageTokenHours === undefined) {
    cacheStorage = undefined
    unpriced.push('cacheStorage')
    notes.push(
      `provider "${pricing.provider}" bills cache storage but no retention duration was supplied; the line is `
      + 'unpriced rather than zero, so the total below is incomplete',
    )
  } else {
    cacheStorage = perMillion(pricing.cacheStoragePerMillionTokenHours, input.cacheStorageTokenHours)
  }

  const charges: ChargeLine = {
    freshInput: perMillion(pricing.freshInputPerMillion, usage.uncachedInputTokens),
    cachedInput: perMillion(pricing.cacheReadPerMillion, usage.cacheReadTokens),
    output: perMillion(pricing.outputPerMillion, usage.outputTokens),
    cacheWrite,
    cacheStorage,
  }
  const subtotal = charges.freshInput
    + charges.cachedInput
    + charges.output
    + (charges.cacheWrite ?? 0)
    + (charges.cacheStorage ?? 0)

  return {
    attemptId: attempt.attemptId,
    source: attempt.source,
    provider: input.provider,
    model: input.model,
    priceVersion: pricing.priceVersion,
    currency: pricing.currency,
    known: true,
    charges,
    subtotal,
    inapplicable,
    unpriced,
    buckets: usage,
    notes,
  }
}

/**
 * A registry of price tables, keyed by provider, with no default.
 *
 * The absence of a default is the whole point. A fallback table would make an
 * unregistered provider priceable with someone else's numbers, which is the
 * silent mixing the plan forbids; here that case throws with the provider named.
 */
export class PriceBook {
  private readonly tables = new Map<string, ProviderPricing>()

  /** Register or replace one provider's table. Replacing is explicit and visible. */
  register(pricing: ProviderPricing): void {
    this.tables.set(pricing.provider, pricing)
  }

  /**
   * The table for a provider.
   * @throws when no table is registered. There is deliberately no fallback.
   */
  require(provider: string): ProviderPricing {
    const found = this.tables.get(provider)
    if (found === undefined) {
      throw new Error(
        `PriceBook: no price table for provider "${provider}" (registered: `
        + `${[...this.tables.keys()].sort().join(', ') || 'none'}); pricing it with another provider's table `
        + 'would mix vendor formulas',
      )
    }
    return found
  }

  /** Registered provider keys, sorted, so a report can name what it could price. */
  providers(): readonly string[] {
    return [...this.tables.keys()].sort()
  }
}

/** One attempt's provider context, needed because `UsageAttempt` carries no route. */
export interface AttemptRoute {
  readonly attemptId: string
  readonly provider: string
  readonly model: string
  /** Cached-prefix retention in token-hours, when the provider bills storage. */
  readonly cacheStorageTokenHours?: number
}

/** A per-source line in the total, so an omission is visible rather than summed away. */
export interface SourceCostLine {
  readonly source: UsageSource
  readonly attempts: number
  readonly unknownAttempts: number
  readonly cost: number
}

/**
 * The whole bill, with its own completeness stated.
 *
 * `knownTotal` is a LOWER BOUND whenever `complete` is false. That is the
 * property ECO-02 and ECO-03 both need: a total that silently omitted an
 * unknown attempt would read as a smaller, complete bill, which is exactly how
 * a missing usage report becomes a budget that passes.
 */
export interface CostTotal {
  readonly currency: string
  readonly priceVersions: readonly string[]
  readonly attempts: number
  readonly knownAttempts: number
  readonly unknownAttempts: number
  readonly bySource: readonly SourceCostLine[]
  /** The plan's five-term formula, each term its own number. */
  readonly byLine: {
    readonly freshInput: number
    readonly cachedInput: number
    readonly output: number
    readonly cacheWrite: number
    readonly cacheStorage: number
  }
  /**
   * The TOKEN counts behind those charges, kept separately and deliberately.
   *
   * This is not a convenience. `byLine` holds MONEY, and a report that read a
   * token delta out of `byLine` would be subtracting dollars and calling the
   * result tokens -- a bug this module had and its own ECO-05 case caught. The
   * two series are different quantities and only their coincidence in shape
   * makes them confusable, so they live under different names.
   */
  readonly byTokens: {
    readonly freshInput: number
    readonly cachedInput: number
    readonly output: number
    /** Fresh plus cached: the prompt-side total a "tokens went down" claim reads. */
    readonly promptTotal: number
  }
  readonly knownTotal: number
  /** True only when every attempt was priced under a complete table. */
  readonly complete: boolean
  readonly unpricedLines: readonly string[]
  readonly inapplicableLines: readonly string[]
  /** Attempts whose provider had no registered table. Empty, or the total is refused. */
  readonly unpricedProviders: readonly string[]
}

/**
 * Total a ledger's attempts under per-provider tables.
 *
 * @param ledger - the real `UsageLedger`. Its rows are the attempt identities;
 *   this function does not re-derive them and does not touch its counters.
 * @param book - the price tables. An attempt whose provider is missing makes the
 *   whole total REFUSED rather than partially priced: a total that quietly
 *   omitted one provider's rows would understate the bill by that provider's
 *   entire contribution.
 * @param routes - provider/model (and optional storage duration) per attempt id.
 * @returns the total, with every line and every gap named.
 * @throws when a row has no route, or a route names an unregistered provider.
 */
export function totalCost(
  ledger: UsageLedger,
  book: PriceBook,
  routes: readonly AttemptRoute[],
): CostTotal {
  const byId = new Map(routes.map(route => [route.attemptId, route]))
  const rows = ledger.rows()
  const missing: string[] = []
  const unpricedProviders = new Set<string>()
  const priced: PricedAttempt[] = []

  for (const row of rows) {
    const route = byId.get(row.attemptId)
    if (route === undefined) {
      missing.push(row.attemptId)
      continue
    }
    let pricing: ProviderPricing
    try {
      pricing = book.require(route.provider)
    } catch {
      unpricedProviders.add(route.provider)
      continue
    }
    priced.push(priceAttempt({
      attempt: row,
      pricing,
      provider: route.provider,
      model: route.model,
      ...route.cacheStorageTokenHours === undefined
        ? {}
        : { cacheStorageTokenHours: route.cacheStorageTokenHours },
    }))
  }

  if (missing.length > 0) {
    throw new Error(
      `totalCost: ${missing.length} attempt(s) have no provider route (${missing.slice(0, 4).join(', ')}`
      + `${missing.length > 4 ? ', ...' : ''}); an attempt whose provider is unknown cannot be priced, and `
      + 'leaving it out would understate the bill',
    )
  }
  if (unpricedProviders.size > 0) {
    throw new Error(
      `totalCost: no price table for provider(s) ${[...unpricedProviders].sort().join(', ')}; refusing to `
      + 'report a total that omits them',
    )
  }

  const byLine = { freshInput: 0, cachedInput: 0, output: 0, cacheWrite: 0, cacheStorage: 0 }
  const byTokens = { freshInput: 0, cachedInput: 0, output: 0, promptTotal: 0 }
  const unpricedLines = new Set<string>()
  const inapplicableLines = new Set<string>()
  let knownAttempts = 0
  let unknownAttempts = 0
  let knownTotal = 0
  const versions = new Set<string>()

  const bySource = new Map<UsageSource, { attempts: number; unknown: number; cost: number }>()

  for (const entry of priced) {
    versions.add(entry.priceVersion)
    const line = bySource.get(entry.source) ?? { attempts: 0, unknown: 0, cost: 0 }
    line.attempts += 1
    if (!entry.known) {
      unknownAttempts += 1
      line.unknown += 1
      bySource.set(entry.source, line)
      continue
    }
    knownAttempts += 1
    byLine.freshInput += entry.charges.freshInput
    byLine.cachedInput += entry.charges.cachedInput
    byLine.output += entry.charges.output
    byLine.cacheWrite += entry.charges.cacheWrite ?? 0
    byLine.cacheStorage += entry.charges.cacheStorage ?? 0
    knownTotal += entry.subtotal
    line.cost += entry.subtotal
    // The token series, accumulated from the same rows so the two cannot drift.
    const buckets = entry.buckets
    if (buckets !== undefined) {
      byTokens.freshInput += buckets.uncachedInputTokens
      byTokens.cachedInput += buckets.cacheReadTokens + buckets.cacheWriteTokens
      byTokens.output += buckets.outputTokens
      byTokens.promptTotal += buckets.uncachedInputTokens + buckets.cacheReadTokens + buckets.cacheWriteTokens
    }
    for (const name of entry.unpriced) unpricedLines.add(name)
    for (const name of entry.inapplicable) inapplicableLines.add(name)
    bySource.set(entry.source, line)
  }

  const currencies = new Set(priced.map(entry => entry.currency))

  return {
    currency: currencies.size === 1 ? [...currencies][0] ?? 'UNKNOWN' : 'MIXED',
    priceVersions: [...versions].sort(),
    attempts: priced.length,
    knownAttempts,
    unknownAttempts,
    bySource: USAGE_SOURCES.map((source) => {
      const value = bySource.get(source) ?? { attempts: 0, unknown: 0, cost: 0 }
      return {
        source,
        attempts: value.attempts,
        unknownAttempts: value.unknown,
        cost: value.cost,
      }
    }),
    byLine,
    byTokens,
    knownTotal,
    complete: unknownAttempts === 0 && unpricedLines.size === 0 && currencies.size <= 1,
    unpricedLines: [...unpricedLines].sort(),
    inapplicableLines: [...inapplicableLines].sort(),
    unpricedProviders: [],
  }
}

/** The token count a bill is often mistaken for, kept disjoint exactly as DSH reports it. */
export function billedTokens(buckets: UsageBuckets): {
  readonly freshInput: number
  readonly cachedInput: number
  readonly output: number
  readonly totalPrompt: number
} {
  return {
    freshInput: buckets.uncachedInputTokens,
    cachedInput: buckets.cacheReadTokens + buckets.cacheWriteTokens,
    output: buckets.outputTokens,
    // The number a report would show if it stopped at "tokens went down".
    totalPrompt: buckets.uncachedInputTokens + buckets.cacheReadTokens + buckets.cacheWriteTokens,
  }
}

/** A before/after cost comparison that cannot report a token drop without its bill. */
export interface CostDeltaReport {
  readonly tokensBefore: number
  readonly tokensAfter: number
  readonly tokenDelta: number
  readonly costBefore: number
  readonly costAfter: number
  readonly costDelta: number
  /** True only when the bill itself fell. A token drop alone does not set this. */
  readonly cheaper: boolean
  /** A sentence a report can print verbatim, naming both numbers. */
  readonly statement: string
}

/**
 * Compare two priced states and state the conclusion in terms of the BILL.
 *
 * ECO-05 exists because a system can truthfully report "tokens down 40%" while
 * the invoice rose: a prefix that stops being cache-readable moves the same
 * tokens from the cached-input line to the fresh-input line, and fresh input is
 * the more expensive one. A report that shows only the token delta is therefore
 * not merely incomplete, it points the wrong way. This function makes the
 * direction explicit and refuses to call anything cheaper on token evidence.
 *
 * @param before - the earlier total.
 * @param after - the later total.
 * @throws when either side is incomplete, because a lower bound cannot support a
 *   claim in either direction.
 */
export function reportCostDelta(before: CostTotal, after: CostTotal): CostDeltaReport {
  if (!before.complete || !after.complete) {
    throw new Error(
      `reportCostDelta: refusing to compare an incomplete total (before.complete=${String(before.complete)}, `
      + `after.complete=${String(after.complete)}); a lower bound cannot establish that anything got cheaper`,
    )
  }
  const tokensBefore = before.byTokens.promptTotal
  const tokensAfter = after.byTokens.promptTotal
  const tokenDelta = tokensAfter - tokensBefore
  const costDelta = after.knownTotal - before.knownTotal
  const cheaper = costDelta < 0
  const direction = cheaper ? 'cheaper' : costDelta > 0 ? 'MORE expensive' : 'the same price'
  const tokenWord = tokenDelta < 0 ? 'fell' : tokenDelta > 0 ? 'rose' : 'held'
  return {
    tokensBefore,
    tokensAfter,
    tokenDelta,
    costBefore: before.knownTotal,
    costAfter: after.knownTotal,
    costDelta,
    cheaper,
    statement:
      `prompt tokens ${tokenWord} by ${Math.abs(tokenDelta)} (${tokensBefore} -> ${tokensAfter}) while the `
      + `priced bill moved by ${costDelta.toFixed(6)} ${after.currency} `
      + `(${before.knownTotal.toFixed(6)} -> ${after.knownTotal.toFixed(6)}): ${direction}`,
  }
}

// ---------------------------------------------------------------------------
// Latency measurement
// ---------------------------------------------------------------------------

/** A described sample: the percentiles plus the n they were computed from. */
export interface LatencySummary {
  readonly n: number
  readonly min: number
  readonly p50: number
  readonly p95: number
  readonly max: number
  readonly mean: number
  /**
   * True when n is too small for p95 to mean anything beyond the maximum. At
   * n=5 the nearest-rank p95 IS the maximum, and reporting it as "p95" without
   * this flag is how a rig with five samples claims a tail it never observed.
   */
  readonly p95IsMax: boolean
}

/**
 * The nearest-rank percentile.
 *
 * Nearest-rank on the sorted sample rather than an interpolating estimator,
 * because with the small n these measurements run at, an interpolated p95 would
 * invent a value between two observations and read as a tail that was never
 * seen. The returned value is always an actually-observed sample.
 *
 * @param sorted - ascending samples. Not re-sorted: the caller owns the order so
 *   a mis-sorted series cannot silently produce a plausible percentile.
 * @param percentileValue - 0..100.
 * @throws when the series is empty or the percentile is outside 0..100.
 */
export function percentileOf(sorted: readonly number[], percentileValue: number): number {
  if (sorted.length === 0) throw new Error('percentileOf: empty series has no percentile')
  if (!(percentileValue >= 0 && percentileValue <= 100)) {
    throw new Error(`percentileOf: percentile ${percentileValue} is outside 0..100`)
  }
  const rank = Math.ceil((percentileValue / 100) * sorted.length)
  const index = Math.min(sorted.length - 1, Math.max(0, rank - 1))
  const value = sorted[index]
  if (value === undefined) throw new Error('percentileOf: index out of range')
  return value
}

/** An append-only series of millisecond samples, summarized on demand. */
export class LatencySeries {
  readonly #samples: number[] = []

  /** Record one sample. Negative values are rejected: a negative duration is a clock bug. */
  record(milliseconds: number): void {
    if (!Number.isFinite(milliseconds) || milliseconds < 0) {
      throw new Error(`LatencySeries.record: ${milliseconds} is not a non-negative finite duration`)
    }
    this.#samples.push(milliseconds)
  }

  /** The raw samples, in observation order. */
  samples(): readonly number[] {
    return [...this.#samples]
  }

  /** The described series. */
  summary(): LatencySummary {
    const sorted = [...this.#samples].sort((left, right) => left - right)
    if (sorted.length === 0) {
      return { n: 0, min: 0, p50: 0, p95: 0, max: 0, mean: 0, p95IsMax: false }
    }
    const first = sorted[0] ?? 0
    const last = sorted[sorted.length - 1] ?? 0
    const total = sorted.reduce((sum, value) => sum + value, 0)
    return {
      n: sorted.length,
      min: first,
      p50: percentileOf(sorted, 50),
      p95: percentileOf(sorted, 95),
      max: last,
      mean: total / sorted.length,
      p95IsMax: percentileOf(sorted, 95) === last,
    }
  }
}

/**
 * Named open/close spans, one series per key.
 *
 * Used for model blocked time and scheduler refill latency: both are "something
 * was requested at T0 and settled at T1", and both need the same honest
 * treatment of an unmatched close (a step that never assembled) and an
 * unmatched open (a settle with no request). Neither is silently dropped.
 */
export class SpanMeter {
  readonly #open = new Map<string, number>()
  readonly #series = new Map<string, LatencySeries>()
  #unmatchedCloses = 0
  #unmatchedOpens = 0

  /** Begin a span. Re-beginning an open key counts as an unmatched open. */
  open(key: string, atMs: number): void {
    if (this.#open.has(key)) this.#unmatchedOpens += 1
    this.#open.set(key, atMs)
  }

  /** End a span, recording its duration. A close with no open is counted, not invented. */
  close(key: string, atMs: number): void {
    const started = this.#open.get(key)
    if (started === undefined) {
      this.#unmatchedCloses += 1
      return
    }
    this.#open.delete(key)
    const series = this.#series.get(key) ?? new LatencySeries()
    series.record(Math.max(0, atMs - started))
    this.#series.set(key, series)
  }

  /** Every key's series. */
  series(): ReadonlyMap<string, LatencySeries> {
    return new Map(this.#series)
  }

  /** Spans still open, and the counts of spans that did not pair. */
  gaps(): { readonly openKeys: readonly string[]; readonly unmatchedOpens: number; readonly unmatchedCloses: number } {
    return {
      openKeys: [...this.#open.keys()].sort(),
      unmatchedOpens: this.#unmatchedOpens,
      unmatchedCloses: this.#unmatchedCloses,
    }
  }
}

// ---------------------------------------------------------------------------
// Bytes: captured vs projected
// ---------------------------------------------------------------------------

/**
 * One observation's byte facts.
 *
 * `capturedBytes` is what the cell produced and what the durable log holds;
 * `projectedBytes` is what reached the model. They are different quantities and
 * the audit's §6 rule is that a single `truncated` boolean cannot stand in for
 * the per-layer record. `truncated` here is therefore carried alongside the
 * numbers, not instead of them.
 */
export interface ByteObservation {
  readonly label: string
  readonly capturedBytes: number
  readonly projectedBytes: number
  readonly truncated: boolean
  /** How many out-of-context references the projection substituted, if any. */
  readonly refs: number
}

/** The byte ledger's total, with the reduction stated rather than implied. */
export interface ByteTotal {
  readonly observations: number
  readonly capturedBytes: number
  readonly projectedBytes: number
  readonly savedBytes: number
  /** `projected / captured`, or 1 when nothing was captured. */
  readonly projectedRatio: number
  /** How many observations were truncated, so a reduction is attributable. */
  readonly truncatedObservations: number
}

/** Accumulates captured-vs-projected bytes so a context claim is arithmetic, not prose. */
export class ByteLedger {
  readonly #observations: ByteObservation[] = []

  record(observation: ByteObservation): void {
    for (const [name, value] of [['capturedBytes', observation.capturedBytes], ['projectedBytes', observation.projectedBytes], ['refs', observation.refs]] as const) {
      if (!Number.isInteger(value) || value < 0) {
        throw new Error(`ByteLedger.record(${observation.label}): ${name} ${value} is not a non-negative integer`)
      }
    }
    this.#observations.push(observation)
  }

  observations(): readonly ByteObservation[] {
    return [...this.#observations]
  }

  total(): ByteTotal {
    let captured = 0
    let projected = 0
    let truncated = 0
    for (const observation of this.#observations) {
      captured += observation.capturedBytes
      projected += observation.projectedBytes
      if (observation.truncated) truncated += 1
    }
    return {
      observations: this.#observations.length,
      capturedBytes: captured,
      projectedBytes: projected,
      savedBytes: captured - projected,
      projectedRatio: captured === 0 ? 1 : projected / captured,
      truncatedObservations: truncated,
    }
  }
}

// ---------------------------------------------------------------------------
// Resources
// ---------------------------------------------------------------------------

/** A resource sample for one process. All figures are observations, none derived. */
export interface ResourceSample {
  readonly atMs: number
  readonly label: string
  readonly rssBytes: number
  /** Cumulative CPU milliseconds, or undefined when the platform could not report it. */
  readonly cpuMs?: number
  readonly pid?: number
}

/** Summarizes a process's resource series, including its growth. */
export function resourceSummary(samples: readonly ResourceSample[]): {
  readonly n: number
  readonly rssFirstBytes: number
  readonly rssLastBytes: number
  readonly rssPeakBytes: number
  readonly rssGrowthBytes: number
  readonly cpuMsDelta: number | undefined
  readonly cpuReported: boolean
} {
  if (samples.length === 0) {
    return {
      n: 0,
      rssFirstBytes: 0,
      rssLastBytes: 0,
      rssPeakBytes: 0,
      rssGrowthBytes: 0,
      cpuMsDelta: undefined,
      cpuReported: false,
    }
  }
  const first = samples[0]
  const last = samples[samples.length - 1]
  const withCpu = samples.filter(sample => sample.cpuMs !== undefined)
  const firstCpu = withCpu[0]?.cpuMs
  const lastCpu = withCpu[withCpu.length - 1]?.cpuMs
  return {
    n: samples.length,
    rssFirstBytes: first?.rssBytes ?? 0,
    rssLastBytes: last?.rssBytes ?? 0,
    rssPeakBytes: Math.max(...samples.map(sample => sample.rssBytes)),
    rssGrowthBytes: (last?.rssBytes ?? 0) - (first?.rssBytes ?? 0),
    cpuMsDelta: firstCpu === undefined || lastCpu === undefined ? undefined : lastCpu - firstCpu,
    cpuReported: withCpu.length === samples.length,
  }
}

// ---------------------------------------------------------------------------
// Shadow projection
// ---------------------------------------------------------------------------

/** One shadow observation: what the live projection produced versus the shadow's. */
export interface ShadowObservation {
  readonly sequence: number
  readonly label: string
  readonly liveDigest: string
  readonly shadowDigest: string
  readonly liveBytes: number
  readonly shadowBytes: number
  readonly differs: boolean
}

/**
 * A shadow context projection that can observe and cannot act.
 *
 * THE CONSTRAINT THIS TYPE ENCODES, AND WHY IT IS A TYPE RATHER THAN A PROMISE.
 * The plan's rule is that a new context strategy is tried in shadow first, with
 * no second LLM request and no re-run of a tool or effect, and that the byte and
 * hash differences are explained before any canary switch. A shadow implemented
 * as "a projection that happens not to call the model" is one refactor away from
 * calling it. So the shadow is constructed from a PURE function of already-read
 * bytes and holds no Context, no LlmRuntime and no ToolRuntime: it has no
 * reachable path to a request or an effect, and the counters below can only stay
 * at zero. The counters are asserted anyway, because "structurally cannot" is a
 * claim about this file and the counters are evidence about a run.
 */
export class ShadowProjection {
  /** Requests this shadow caused. Zero by construction; asserted by ECO-06. */
  llmRequests = 0
  /** Tool executions this shadow caused. Zero by construction. */
  toolExecutions = 0
  /** Effects this shadow caused. Zero by construction. */
  effectsPerformed = 0
  readonly #observations: ShadowObservation[] = []
  readonly #project: (live: string) => string
  readonly #digest: (bytes: string) => string

  /**
   * @param project - the candidate projection, a pure function of the live bytes.
   * @param digest - a digest function, also pure. Both are injected so this class
   *   never needs to import an LLM or tool service to exist.
   */
  constructor(project: (live: string) => string, digest: (bytes: string) => string) {
    this.#project = project
    this.#digest = digest
  }

  /**
   * Observe one already-materialized projection. Reads nothing else.
   * @param label - what was observed, for the report.
   * @param live - the bytes the live path produced.
   * @returns the comparison, appended to the record.
   */
  observe(label: string, live: string): ShadowObservation {
    const shadow = this.#project(live)
    const liveDigest = this.#digest(live)
    const shadowDigest = this.#digest(shadow)
    const observation: ShadowObservation = {
      sequence: this.#observations.length + 1,
      label,
      liveDigest,
      shadowDigest,
      liveBytes: Buffer.byteLength(live, 'utf8'),
      shadowBytes: Buffer.byteLength(shadow, 'utf8'),
      differs: liveDigest !== shadowDigest,
    }
    this.#observations.push(observation)
    return observation
  }

  observations(): readonly ShadowObservation[] {
    return [...this.#observations]
  }

  /**
   * The side-effect counters, in the shape a gate asserts.
   *
   * `total` is what must be zero. It is reported rather than asserted here so
   * the caller decides, and so a non-zero value is visible in the artifact
   * instead of only in a stack trace.
   */
  sideEffects(): { readonly llmRequests: number; readonly toolExecutions: number; readonly effectsPerformed: number; readonly total: number } {
    return {
      llmRequests: this.llmRequests,
      toolExecutions: this.toolExecutions,
      effectsPerformed: this.effectsPerformed,
      total: this.llmRequests + this.toolExecutions + this.effectsPerformed,
    }
  }
}

// ---------------------------------------------------------------------------
// Statistics for the paired comparison
// ---------------------------------------------------------------------------

/**
 * A Wilson score interval for a binomial proportion.
 *
 * Wilson rather than the normal approximation because the sample sizes here are
 * small and the observed proportion is frequently 0 or 1, which is exactly where
 * the normal interval produces bounds outside [0,1] and a zero-width interval
 * that reads as certainty. Wilson stays inside the interval and, importantly,
 * does NOT collapse to a point at p=0 with n=6 — the lower bound is 0 and the
 * upper bound is meaningfully above it, which is the honest statement about six
 * runs that all failed.
 *
 * @param successes - observed successes.
 * @param n - trials. Must be positive.
 * @param z - the standard normal quantile. 1.96 for 95%.
 * @returns the interval, or a degenerate one when n is 0, which the caller must
 *   treat as "no estimate" rather than as certainty.
 */
export function wilsonInterval(successes: number, n: number, z = 1.96): {
  readonly successes: number
  readonly n: number
  readonly proportion: number
  readonly lower: number
  readonly upper: number
  readonly z: number
  /** True when n is 0: the interval is a placeholder, not an estimate. */
  readonly degenerate: boolean
} {
  if (n < 0 || successes < 0 || successes > n) {
    throw new Error(`wilsonInterval: ${successes} successes of ${n} trials is not a proportion`)
  }
  if (n === 0) {
    return { successes, n, proportion: 0, lower: 0, upper: 1, z, degenerate: true }
  }
  const p = successes / n
  const denominator = 1 + (z * z) / n
  const centre = p + (z * z) / (2 * n)
  const spread = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))
  return {
    successes,
    n,
    proportion: p,
    lower: Math.max(0, (centre - spread) / denominator),
    upper: Math.min(1, (centre + spread) / denominator),
    z,
    degenerate: false,
  }
}

/** A described numeric series, for reporting variance without declaring a winner. */
export function describeSeries(values: readonly number[]): {
  readonly n: number
  readonly min: number
  readonly max: number
  readonly mean: number
  /** Sample variance (n-1 denominator), or undefined when n < 2. */
  readonly variance: number | undefined
  readonly stdev: number | undefined
} {
  const n = values.length
  if (n === 0) return { n: 0, min: 0, max: 0, mean: 0, variance: undefined, stdev: undefined }
  const sum = values.reduce((total, value) => total + value, 0)
  const mean = sum / n
  const min = Math.min(...values)
  const max = Math.max(...values)
  if (n < 2) return { n, min, max, mean, variance: undefined, stdev: undefined }
  const variance = values.reduce((total, value) => total + (value - mean) ** 2, 0) / (n - 1)
  return { n, min, max, mean, variance, stdev: Math.sqrt(variance) }
}
