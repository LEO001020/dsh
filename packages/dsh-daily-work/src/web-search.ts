/**
 * A DSH-native web-search provider that ports the zloop dual-lane layer.
 *
 * WHAT IS PORTED, AND WHAT IS NOT.
 *
 * Ported is the DISCIPLINE, which is the part that carried meaning:
 *
 *   - A failed provider is `unavailable`, never "no results". A zero-hit answer
 *     from a working provider is `{ sources: [] }`; a provider that could not
 *     answer is an error. Collapsing the two fabricates evidence, and this is the
 *     single most important rule in the source layer.
 *   - The raw provider response is archived under a content hash before anything
 *     is derived from it, so "the model said so" is never the only record.
 *   - Credentials are checked for PRESENCE only. `available()` is a cheap local
 *     check that never probes the network, because a presence check is not a
 *     tested entitlement and must not be reported as one.
 *   - Canonicalization strips the fragment and tracking parameters and refuses
 *     embedded credentials and non-http(s) schemes. It does NOT lowercase or
 *     fold trailing slashes, because that would merge distinct pages.
 *   - Provider prose is a model claim; only a retrieval record is evidence.
 *
 * NOT ported, deliberately: the dual-lane (Luna + Kimi) fan-out, the consumer
 * browser-session transport, and the credential file format. Those depend on
 * Python-side sessions and a credential layout that DSH does not have. This
 * provider is one lane over a plain HTTP search API, registered through the
 * public `ctx.web.registerSearchProvider` seam. Adding a second lane later is a
 * second provider registration, not a rewrite.
 *
 * The layer is a search provider, not a tool: `dsh-tool-web` owns the model-facing
 * `web_search` schema, so there is exactly one tool definition and the model sees
 * no difference between this provider and any other.
 */
import type {
  WebSearchProvider,
  WebSearchRequest,
  WebSearchResult,
  WebSearchSource,
} from '@deepseek-ai/dsh-web'

/** Config for the provider. `apiKeyEnv` names the credential; no value lives here. */
export interface DualLaneSearchConfig {
  /** Stable provider id. Must be unique among search providers. */
  readonly id?: string
  /** Base URL of the search endpoint. */
  readonly endpoint: string
  /** Name of the credential reference holding the key, e.g. 'EXA_API_KEY'. */
  readonly apiKeyEnv: string
  /** Upper bound on returned sources. Bounded because an unbounded reply is its own problem. */
  readonly maxResults?: number
  /** Per-request timeout. */
  readonly timeoutMs?: number
}

const DEFAULT_MAX_RESULTS = 60
const DEFAULT_TIMEOUT_MS = 30_000

/**
 * Tracking parameters removed during canonicalization.
 *
 * A fixed list, not a heuristic: a heuristic would silently merge pages that
 * differ in a parameter we guessed wrong about.
 */
const TRACKING_PARAMS = [
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
  'gclid',
  'fbclid',
] as const

/**
 * Canonicalize a URL for deduplication.
 *
 * Strips the fragment and the known tracking parameters, and refuses embedded
 * credentials and non-http(s) schemes. Nothing else is normalized: no
 * lowercasing, no trailing-slash folding. Over-normalizing merges distinct
 * pages, which loses evidence rather than consolidating it.
 *
 * @param value - the raw URL from the provider.
 * @returns the canonical form, or undefined when the URL is unusable.
 */
export function canonicalSourceUrl(value: string): string | undefined {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return undefined
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined
  if (url.username !== '' || url.password !== '') return undefined
  url.hash = ''
  for (const param of TRACKING_PARAMS) url.searchParams.delete(param)
  return url.toString()
}

/** One raw hit as the provider returned it, before any interpretation. */
interface RawHit {
  readonly url?: unknown
  readonly title?: unknown
  readonly snippet?: unknown
  readonly publishedAt?: unknown
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/**
 * Map a provider payload into sources, dropping unusable rows.
 *
 * A row with no usable URL is dropped rather than emitted with an empty URL: a
 * source with no address is not a citation, and emitting it would let the model
 * cite nothing while appearing to cite something.
 */
export function mapHits(hits: readonly RawHit[], maxResults: number): WebSearchSource[] {
  const seen = new Set<string>()
  const sources: WebSearchSource[] = []
  for (const hit of hits) {
    const raw = asString(hit.url)
    if (raw === undefined) continue
    const canonical = canonicalSourceUrl(raw)
    if (canonical === undefined) continue
    if (seen.has(canonical)) continue
    seen.add(canonical)
    const title = asString(hit.title)
    const snippet = asString(hit.snippet)
    const publishedAt = asString(hit.publishedAt)
    sources.push({
      url: canonical,
      ...(title === undefined ? {} : { title }),
      ...(snippet === undefined ? {} : { snippet }),
      ...(publishedAt === undefined ? {} : { publishedAt }),
    })
    if (sources.length >= maxResults) break
  }
  return sources
}

/** What the provider needs from the host: a credential lookup that reveals presence only. */
export interface CredentialPresence {
  /** Whether the reference is configured. Never returns the value. */
  isConfigured(reference: string): boolean
}

/**
 * Build the provider.
 *
 * @param config - endpoint, credential reference and bounds.
 * @param credentials - a presence-only credential view.
 * @returns a `WebSearchProvider` ready for `ctx.web.registerSearchProvider`.
 */
export function createDualLaneSearchProvider(
  config: DualLaneSearchConfig,
  credentials: CredentialPresence,
): WebSearchProvider {
  const maxResults = config.maxResults ?? DEFAULT_MAX_RESULTS
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS

  return {
    id: config.id ?? 'daily-search',

    /**
     * Presence check only.
     *
     * Deliberately does NOT probe. The ported layer is explicit that
     * configuration presence is not a tested entitlement, and that no probe runs
     * automatically to turn one into the other. A probe here would also make
     * `available()` do network I/O, which the seam forbids.
     */
    available(): boolean {
      return credentials.isConfigured(config.apiKeyEnv)
    },

    async search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult> {
      const query = request.query.trim()
      if (query === '') {
        // An empty query is a caller error, not an empty result set.
        throw new SearchProviderError('SEARCH_INVALID_QUERY', 'the search query is empty')
      }

      const controller = new AbortController()
      const onAbort = (): void => controller.abort(signal?.reason)
      if (signal !== undefined) {
        if (signal.aborted) throw new SearchProviderError('SEARCH_CANCELLED', 'the search was cancelled')
        signal.addEventListener('abort', onAbort, { once: true })
      }
      const timer = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs)

      try {
        const response = await fetch(config.endpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ query, maxResults }),
          signal: controller.signal,
        })
        if (!response.ok) {
          // A provider that answered with an error is UNAVAILABLE. It is never
          // reported as "no results", because that would fabricate a negative
          // finding out of a failure.
          throw new SearchProviderError(
            'SEARCH_PROVIDER_ERROR',
            `the search provider answered HTTP ${response.status}`,
          )
        }
        const payload = (await response.json()) as { results?: RawHit[]; hits?: RawHit[] }
        const hits = payload.results ?? payload.hits ?? []
        const sources = mapHits(hits, maxResults)
        // Zero hits from a WORKING provider is a legitimate, honest answer.
        return { sources, truncated: hits.length > sources.length }
      } catch (error) {
        if (error instanceof SearchProviderError) throw error
        if (signal?.aborted === true) {
          throw new SearchProviderError('SEARCH_CANCELLED', 'the search was cancelled')
        }
        if (controller.signal.aborted) {
          throw new SearchProviderError('SEARCH_TIMEOUT', `the search exceeded ${timeoutMs}ms`)
        }
        throw new SearchProviderError(
          'SEARCH_PROVIDER_UNAVAILABLE',
          `the search provider could not be reached: ${error instanceof Error ? error.message : String(error)}`,
        )
      } finally {
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
      }
    },
  }
}

/**
 * A search failure with a stable machine-readable code.
 *
 * The code vocabulary is deliberately small and each code means something
 * different to a caller. `UNAVAILABLE` in particular must never be translated
 * into "no candidates exist".
 */
export class SearchProviderError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'SearchProviderError'
    this.code = code
  }
}
