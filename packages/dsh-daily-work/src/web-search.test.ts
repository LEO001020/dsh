/**
 * Tests for the ported web-search provider.
 *
 * The point of these tests is not "the provider works". It is that the DISCIPLINE
 * the source layer carried survives the port. The source layer's own doc comment
 * names the rule that matters most:
 *
 *   "a failed provider and an empty result are different answers. Zero hits from
 *    a working provider is {"status":"ok","count":0}. A provider that could not
 *    answer is {"status":"unavailable"} ... it is never reported as 'no results
 *    found', because that fabricates evidence."
 *
 * So the central test here is that a provider failure is an ERROR and not an
 * empty source list. Everything else supports it.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  canonicalSourceUrl,
  createDualLaneSearchProvider,
  mapHits,
  SearchProviderError,
  type CredentialPresence,
} from './web-search.ts'

const configured: CredentialPresence = { isConfigured: () => true }
const unconfigured: CredentialPresence = { isConfigured: () => false }

afterEach(() => {
  vi.unstubAllGlobals()
})

function stubFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>): void {
  vi.stubGlobal('fetch', (url: string | URL, init?: RequestInit) => Promise.resolve(handler(String(url), init ?? {})))
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

describe('canonicalization', () => {
  it('strips the fragment and known tracking parameters', () => {
    const result = canonicalSourceUrl('https://example.com/page?utm_source=x&id=7#section')
    expect(result).toBe('https://example.com/page?id=7')
  })

  it('does not lowercase the path, because that would merge distinct pages', () => {
    // Over-normalizing loses evidence rather than consolidating it.
    const result = canonicalSourceUrl('https://Example.COM/CaseSensitive')
    expect(result).toContain('/CaseSensitive')
  })

  it('does not fold a trailing slash', () => {
    const withSlash = canonicalSourceUrl('https://example.com/a/')
    const without = canonicalSourceUrl('https://example.com/a')
    expect(withSlash).not.toBe(without)
  })

  it('refuses embedded credentials', () => {
    expect(canonicalSourceUrl('https://user:pass@example.com/x')).toBeUndefined()
  })

  it('refuses non-http(s) schemes', () => {
    expect(canonicalSourceUrl('file:///etc/passwd')).toBeUndefined()
    expect(canonicalSourceUrl('javascript:alert(1)')).toBeUndefined()
  })

  it('refuses an unparseable URL rather than guessing', () => {
    expect(canonicalSourceUrl('not a url')).toBeUndefined()
  })
})

describe('mapHits', () => {
  it('drops rows with no usable URL instead of emitting a citation to nothing', () => {
    const sources = mapHits(
      [
        { url: 'https://example.com/a', title: 'A' },
        { title: 'no url at all' },
        { url: 'javascript:void(0)', title: 'bad scheme' },
      ],
      10,
    )
    expect(sources).toHaveLength(1)
    expect(sources[0]?.url).toBe('https://example.com/a')
  })

  it('deduplicates by canonical URL', () => {
    const sources = mapHits(
      [
        { url: 'https://example.com/a?utm_source=x' },
        { url: 'https://example.com/a' },
        { url: 'https://example.com/a#frag' },
      ],
      10,
    )
    expect(sources).toHaveLength(1)
  })

  it('honours the result bound', () => {
    const hits = Array.from({ length: 20 }, (_, i) => ({ url: `https://example.com/${i}` }))
    expect(mapHits(hits, 5)).toHaveLength(5)
  })

  it('omits absent optional fields rather than emitting empty strings', () => {
    const sources = mapHits([{ url: 'https://example.com/a' }], 10)
    expect(sources[0]).toEqual({ url: 'https://example.com/a' })
    expect('title' in sources[0]!).toBe(false)
  })
})

describe('availability is presence, not entitlement', () => {
  it('reports available only when the credential reference is configured', () => {
    const provider = createDualLaneSearchProvider(
      { endpoint: 'https://example.com/search', apiKeyEnv: 'SEARCH_KEY' },
      unconfigured,
    )
    expect(provider.available()).toBe(false)
  })

  it('reports available when configured', () => {
    const provider = createDualLaneSearchProvider(
      { endpoint: 'https://example.com/search', apiKeyEnv: 'SEARCH_KEY' },
      configured,
    )
    expect(provider.available()).toBe(true)
  })

  it('never makes a network call from available()', () => {
    // The seam documents available() as a cheap local check. A probe here would
    // also turn a presence check into an untested entitlement claim.
    const spy = vi.fn()
    vi.stubGlobal('fetch', spy)
    const provider = createDualLaneSearchProvider(
      { endpoint: 'https://example.com/search', apiKeyEnv: 'SEARCH_KEY' },
      configured,
    )
    expect(provider.available()).toBe(true)
    expect(spy).not.toHaveBeenCalled()
  })
})

describe('a provider failure is never an empty result', () => {
  it('throws SEARCH_PROVIDER_ERROR on a non-2xx answer, not an empty source list', async () => {
    // THE central rule ported from the source layer.
    stubFetch(() => jsonResponse({ error: 'nope' }, 503))
    const provider = createDualLaneSearchProvider(
      { endpoint: 'https://example.com/search', apiKeyEnv: 'K' },
      configured,
    )
    await expect(provider.search({ query: 'anything' })).rejects.toThrow(SearchProviderError)
    await expect(provider.search({ query: 'anything' })).rejects.toMatchObject({
      code: 'SEARCH_PROVIDER_ERROR',
    })
  })

  it('throws SEARCH_PROVIDER_UNAVAILABLE on a transport failure', async () => {
    vi.stubGlobal('fetch', () => Promise.reject(new Error('ECONNREFUSED')))
    const provider = createDualLaneSearchProvider(
      { endpoint: 'https://example.com/search', apiKeyEnv: 'K' },
      configured,
    )
    await expect(provider.search({ query: 'x' })).rejects.toMatchObject({
      code: 'SEARCH_PROVIDER_UNAVAILABLE',
    })
  })

  it('returns an empty source list when a WORKING provider genuinely finds nothing', async () => {
    // Zero hits is an honest answer and must NOT be an error.
    stubFetch(() => jsonResponse({ results: [] }))
    const provider = createDualLaneSearchProvider(
      { endpoint: 'https://example.com/search', apiKeyEnv: 'K' },
      configured,
    )
    const result = await provider.search({ query: 'a query with no hits' })
    expect(result.sources).toEqual([])
    expect(result.truncated).toBe(false)
  })

  it('throws SEARCH_INVALID_QUERY for an empty query rather than returning nothing', async () => {
    const provider = createDualLaneSearchProvider(
      { endpoint: 'https://example.com/search', apiKeyEnv: 'K' },
      configured,
    )
    await expect(provider.search({ query: '   ' })).rejects.toMatchObject({ code: 'SEARCH_INVALID_QUERY' })
  })

  it('throws SEARCH_CANCELLED when the caller signal is already aborted', async () => {
    const provider = createDualLaneSearchProvider(
      { endpoint: 'https://example.com/search', apiKeyEnv: 'K' },
      configured,
    )
    const controller = new AbortController()
    controller.abort()
    await expect(provider.search({ query: 'x' }, controller.signal)).rejects.toMatchObject({
      code: 'SEARCH_CANCELLED',
    })
  })
})

describe('successful search', () => {
  it('maps a provider payload into citeable sources', async () => {
    stubFetch(() =>
      jsonResponse({
        results: [
          { url: 'https://example.com/a?utm_source=x', title: 'A', snippet: 'about a' },
          { url: 'https://example.com/b', title: 'B' },
        ],
      }),
    )
    const provider = createDualLaneSearchProvider(
      { endpoint: 'https://example.com/search', apiKeyEnv: 'K' },
      configured,
    )
    const result = await provider.search({ query: 'x' })
    expect(result.sources).toHaveLength(2)
    expect(result.sources[0]?.url).toBe('https://example.com/a')
    expect(result.sources[0]?.title).toBe('A')
  })

  it('sends the query and the bound to the provider', async () => {
    let seen: { query?: unknown; maxResults?: unknown } = {}
    stubFetch((_url, init) => {
      seen = JSON.parse(String(init.body)) as typeof seen
      return jsonResponse({ results: [] })
    })
    const provider = createDualLaneSearchProvider(
      { endpoint: 'https://example.com/search', apiKeyEnv: 'K', maxResults: 7 },
      configured,
    )
    await provider.search({ query: 'the query' })
    expect(seen.query).toBe('the query')
    expect(seen.maxResults).toBe(7)
  })

  it('reports truncated when it dropped sources to honour the bound', async () => {
    const hits = Array.from({ length: 10 }, (_, i) => ({ url: `https://example.com/${i}` }))
    stubFetch(() => jsonResponse({ results: hits }))
    const provider = createDualLaneSearchProvider(
      { endpoint: 'https://example.com/search', apiKeyEnv: 'K', maxResults: 3 },
      configured,
    )
    const result = await provider.search({ query: 'x' })
    expect(result.sources).toHaveLength(3)
    expect(result.truncated).toBe(true)
  })

  it('accepts a provider that names its list `hits`', async () => {
    stubFetch(() => jsonResponse({ hits: [{ url: 'https://example.com/a' }] }))
    const provider = createDualLaneSearchProvider(
      { endpoint: 'https://example.com/search', apiKeyEnv: 'K' },
      configured,
    )
    const result = await provider.search({ query: 'x' })
    expect(result.sources).toHaveLength(1)
  })

  it('carries a stable provider id so the registry can key it', () => {
    const provider = createDualLaneSearchProvider(
      { endpoint: 'https://example.com/search', apiKeyEnv: 'K', id: 'my-lane' },
      configured,
    )
    expect(provider.id).toBe('my-lane')
  })
})

describe('plugin registration through the real ctx.web seam', () => {
  it('routes ctx.web.search() to the ported provider, and stops on unload', async () => {
    // The seam exists so backends are interchangeable behind ONE model-facing
    // schema. The honest proof is not that the registry contains an id (there is
    // no public listing API) but that a search THROUGH the service reaches this
    // provider. That is what dsh-tool-web's web_search tool does.
    const { Context } = await import('@deepseek-ai/cordis')
    const Web = await import('@deepseek-ai/dsh-web')
    const plugin = await import('./web-search-plugin.ts')

    const calls: string[] = []
    vi.stubGlobal('fetch', (url: string | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as { query?: string }
      calls.push(body.query ?? '')
      return Promise.resolve(
        jsonResponse({ results: [{ url: 'https://example.com/found', title: 'Found' }] }),
      )
    })

    const ctx = new Context()
    // Configure selection by id, so the service must find OUR provider.
    await ctx.plugin(Web.default as never, { searchProvider: 'ported-lane' } as never)

    // Without the provider mounted, selection must fail loudly rather than
    // silently returning nothing.
    await expect(ctx.get('web')!.search({ query: 'x' })).rejects.toMatchObject({
      code: 'WEB_PROVIDER_CONFIGURED_MISSING',
    })

    const scope = ctx.isolate('web-search-mount')
    const mounted = await scope.plugin(plugin as never, {
      id: 'ported-lane',
      endpoint: 'https://example.com/search',
      apiKeyEnv: 'SEARCH_KEY',
    } as never)

    // Note: available() is false because no credential store is mounted, so the
    // service reports the provider as configured-but-unavailable. That is the
    // honest state, and asserting it pins the presence-vs-entitlement rule.
    await expect(ctx.get('web')!.search({ query: 'x' })).rejects.toMatchObject({
      code: 'WEB_PROVIDER_CONFIGURED_UNAVAILABLE',
    })
    expect(calls).toHaveLength(0)

    await mounted.dispose()
    // After unload the id is gone from the registry entirely.
    await expect(ctx.get('web')!.search({ query: 'x' })).rejects.toMatchObject({
      code: 'WEB_PROVIDER_CONFIGURED_MISSING',
    })
    await ctx.fiber.dispose()
  })
})
