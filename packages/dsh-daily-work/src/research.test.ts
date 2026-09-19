/**
 * M9.8: the three research-evidence gates — R03, R04, R08.
 *
 * These gates are all the same failure wearing three costumes: a state that was
 * never observed gets reported as a state that was. This file builds the three
 * small types the plan asks for and asserts the distinctions against REAL DSH
 * objects, so the distinction is a measured property and not a comment.
 *
 * WHAT IS REAL HERE, AND WHAT IS CONTROLLED:
 *
 *   R04 uses the real `Session` from `@deepseek-ai/dsh-session`: a real surface
 *   fold, a real `surfaceOp: {op:'replace'}` transition, and the real
 *   `deriveMessages()`. The replacement this file appends is byte-for-byte the
 *   surfaceOp that `compactSurfaceRegion` appends
 *   (`packages/compaction/compaction-basic/src/region.ts:507-510`). The *   surrounding `compaction/start|summary|end` records are deliberately NOT
 *   appended: those are log-only events with no surfaceOp (the `compaction/summary`
 *   doc says so verbatim at
 *   `packages/compaction/compaction/src/types.ts:26`, and `surfaceOpOf` throws
 *   for any non-surface-eligible event carrying one —
 *   `packages/core/session/src/surface.ts:283-288`), so omitting them cannot
 *   change the surface this gate is about.
 *
 *   R03 runs through the real `ctx.web` seam (`WebRuntime.fetch`). The
 *   transport behind it is a fixture provider registered through the public
 *   `ctx.web.registerFetchProvider` seam — the same provider boundary
 *   discipline `concurrency.test.ts` uses for the model adapter. The
 *   `WebFetchResult` values and `WebError` codes are the real ones, so the
 *   record is built from real DSH vocabulary rather than from invented shapes.
 *
 *   R08 uses the real `SessionStore` (`ctx.sessions`) and the real refusal code
 *   `SESSION_QUERY_TOOL_UNAUTHORIZED`
 *   (`packages/session-query/tool-session-query/src/service-boundary.ts:92-97`).
 *
 * NO REAL USER DATA IS READ. Every id, URL, body and marker below is fabricated,
 * and every filesystem-touching path is absent: nothing in this file opens a
 * path under DSH_HOME or anywhere else.
 */
import { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { MessageId } from '@deepseek-ai/dsh-llm'
import { Session, SessionId, SessionStore } from '@deepseek-ai/dsh-session'
import type { SessionSeq } from '@deepseek-ai/dsh-session'
import { WebError } from '@deepseek-ai/dsh-web'
import WebRuntime from '@deepseek-ai/dsh-web'
// `WebFetchResult` and `WebSearchSource` are owned by `dsh-web` and re-exported
// from its index (`packages/web/web/src/index.ts:24-32`). They are NOT
// `dsh-llm` types; importing them from there compiles only because vitest does
// not typecheck, which is exactly the kind of false pass this file exists to
// refuse.
import type { WebFetchResult, WebSearchSource } from '@deepseek-ai/dsh-web'
import { describe, expect, it } from 'vitest'

// ===========================================================================
// R03 — an incomplete read states its RANGE and its LIMITS, and never fills in
//       the missing content.
// ===========================================================================

/**
 * The evidence vocabulary, closed and ordered. INV-R2 names these six and adds
 * "there is no automatic `understood`".
 *
 * The list is a `const` tuple rather than a union alone so a test can assert
 * the complete vocabulary. A seventh member added anywhere would have to be
 * added here, which is the point: `understood` cannot appear by accident.
 */
const EVIDENCE_STATES = [
  'discovered',
  'bytes_captured',
  'parsed',
  'range_presented_to_model',
  'cited_in_output',
  'manual_or_automatic_support_checked',
] as const

type EvidenceState = (typeof EVIDENCE_STATES)[number]

/** Where the held text came from. A snippet and a fetched document are not the same thing. */
type ContentOrigin = 'document_bytes' | 'search_snippet'

/**
 * The outcome of trying to obtain bytes.
 *
 * `failed` and `responded` are separate arms on purpose. A fetch that could not
 * complete is an UNKNOWN, and the record must be able to say so without saying
 * anything about the source's contents. A 404 is `responded` — the fetch
 * succeeded and the server answered — but `usable: false`, so its body can
 * never be parsed as the source.
 */
type FetchOutcome =
  | { readonly kind: 'not_fetched' }
  | { readonly kind: 'failed'; readonly code: string; readonly detail: string }
  | {
    readonly kind: 'responded'
    readonly finalUrl: string
    readonly statusCode: number
    readonly bytes: number
    readonly truncated: boolean
    readonly usable: boolean
  }

/** A half-open character range of a document, in the document's own offsets. */
interface TextRange {
  readonly start: number
  readonly end: number
}

/** What a parse actually covered. `complete` is relative to the DOCUMENT, not to the captured prefix. */
interface ParseRange {
  readonly range: TextRange
  readonly complete: boolean
  /** Why the parse stopped short, when it did. Absent exactly when `complete` is true. */
  readonly limit?: string
}

interface Citation {
  readonly url: string
  /** The exact text quoted. A citation with no quoted span is a claim, not a citation. */
  readonly quoted: string
}

interface SupportCheck {
  readonly mode: 'manual' | 'automatic'
  readonly verdict: string
}

/**
 * One source's evidence state.
 *
 * The `states` set answers one question per member — "is this true yet?" — and
 * never advances on its own. The structured fields beside it carry the RANGE
 * and the LIMITS that a bare state name cannot: `parse.range` is the span that
 * was actually read, and `fetch.truncated` is the reason a larger span was not
 * available. Losing either of those is exactly how a partial read becomes a
 * fabricated full one.
 */
interface EvidenceRecord {
  readonly sourceId: string
  readonly origin: ContentOrigin
  readonly states: ReadonlySet<EvidenceState>
  readonly fetch: FetchOutcome
  readonly parse: ParseRange | undefined
  readonly presented: TextRange | undefined
  readonly citation: Citation | undefined
  readonly support: SupportCheck | undefined
}

/** Stable failure classes for this vocabulary. Every one is a refusal, never an empty result. */
type EvidenceErrorCode =
  | 'EVIDENCE_FETCH_FAILED'
  | 'EVIDENCE_RESPONSE_NOT_USABLE'
  | 'EVIDENCE_SNIPPET_IS_NOT_TEXT'
  | 'EVIDENCE_TRUNCATED_CANNOT_BE_COMPLETE'
  | 'EVIDENCE_NOT_PARSED'
  | 'EVIDENCE_NOT_PRESENTED'
  | 'EVIDENCE_INCOMPLETE_READ'

class EvidenceError extends Error {
  readonly code: EvidenceErrorCode

  constructor(code: EvidenceErrorCode, message: string) {
    super(message)
    this.name = 'EvidenceError'
    this.code = code
  }
}

function withStates(
  record: EvidenceRecord,
  add: readonly EvidenceState[],
  patch: Partial<Omit<EvidenceRecord, 'states'>>,
): EvidenceRecord {
  const states = new Set(record.states)
  for (const state of add) states.add(state)
  return Object.freeze({ ...record, ...patch, states })
}

/** Begin tracking one source. Discovery alone is the whole claim at this point. */
function discover(sourceId: string, origin: ContentOrigin): EvidenceRecord {
  return Object.freeze({
    sourceId,
    origin,
    states: new Set<EvidenceState>(['discovered']),
    fetch: { kind: 'not_fetched' } as FetchOutcome,
    parse: undefined,
    presented: undefined,
    citation: undefined,
    support: undefined,
  })
}

/**
 * Record a real `WebFetchResult` from the `ctx.web` seam.
 *
 * The mapping is deliberately mechanical, because the honest part is what is
 * NOT set: `parsed` is absent even when the body decoded cleanly. Holding
 * decoded bytes is `bytes_captured`, and the plan's own words for that state
 * are "标bytes_captured而非primary_read/understood".
 *
 * `truncated` is copied through rather than dropped, because it is the LIMIT
 * that later forbids a `complete` parse.
 */
function recordFetch(sourceId: string, result: WebFetchResult): EvidenceRecord {
  const record = discover(sourceId, 'document_bytes')
  return withStates(record, ['bytes_captured'], {
    fetch: {
      kind: 'responded',
      finalUrl: result.url,
      statusCode: result.statusCode,
      bytes: result.body.content.length,
      truncated: result.truncated,
      // A non-2xx body is the SERVER's error document, not the source. Marking
      // it unusable here is what stops a 404 page from being parsed as the
      // thing that was asked for.
      usable: result.statusCode >= 200 && result.statusCode < 300,
    },
  })
}

/**
 * Record a fetch that did not complete.
 *
 * `code` is the real `WebError.code` vocabulary (`WEB_FETCH_TIMEOUT`,
 * `WEB_FETCH_TOO_LARGE`, `WEB_REDIRECT_BLOCKED`, `WEB_BLOCKED_URL`,
 * `WEB_UNSUPPORTED_CONTENT_TYPE`, `WEB_PROVIDER_UNAVAILABLE`, …) so a caller
 * routes on the class of failure instead of parsing prose.
 *
 * `capturedBytes` is present only when bytes really arrived before the failure.
 * Without it the record holds no content claim at all — which is the honest
 * state, and is why this function never produces a "no content" conclusion.
 */
function recordFetchFailure(
  sourceId: string,
  code: string,
  detail: string,
  capturedBytes?: number,
): EvidenceRecord {
  const record = discover(sourceId, 'document_bytes')
  const withBytes = capturedBytes === undefined
    ? record
    : withStates(record, ['bytes_captured'], {})
  return withStates(withBytes, [], { fetch: { kind: 'failed', code, detail } })
}

/**
 * Hold a search result's snippet.
 *
 * A snippet is provider-authored text ABOUT a document. It is not the document
 * and it has no document offsets, so `origin` is `search_snippet` and the
 * record carries no parse. The origin tag is the mechanism that makes promotion
 * to `parsed` impossible rather than merely discouraged.
 */
function recordSnippet(sourceId: string, source: WebSearchSource): EvidenceRecord {
  return discover(sourceId, 'search_snippet')
}

/**
 * Record what a parse actually covered.
 *
 * Three refusals, each one a state the plan says must not be invented:
 *   - a snippet has no document to parse;
 *   - a failed fetch has no bytes to parse;
 *   - a non-2xx response is the server's error document, not the source;
 *   - a truncated capture cannot yield a COMPLETE parse, because the tail of
 *     the document was never seen.
 *
 * A partial parse records its `range` and its `limit` and does NOT add the
 * `parsed` state. So `states.has('parsed')` means "fully parsed", and
 * `parse.range` answers the different question "which part was read". Both are
 * available; neither can stand in for the other.
 */
function recordParse(
  record: EvidenceRecord,
  range: TextRange,
  options: { readonly complete: boolean; readonly limit?: string },
): EvidenceRecord {
  if (record.origin !== 'document_bytes') {
    throw new EvidenceError(
      'EVIDENCE_SNIPPET_IS_NOT_TEXT',
      `"${record.sourceId}" holds only a search snippet; a snippet is provider text about a document, not the document`,
    )
  }
  if (record.fetch.kind === 'failed') {
    throw new EvidenceError(
      'EVIDENCE_FETCH_FAILED',
      `cannot parse "${record.sourceId}": the fetch failed with ${record.fetch.code}; there are no bytes to parse`,
    )
  }
  if (record.fetch.kind !== 'responded') {
    throw new EvidenceError(
      'EVIDENCE_FETCH_FAILED',
      `cannot parse "${record.sourceId}": nothing has been fetched yet`,
    )
  }
  if (!record.fetch.usable) {
    throw new EvidenceError(
      'EVIDENCE_RESPONSE_NOT_USABLE',
      `cannot parse "${record.sourceId}": the fetch returned HTTP ${record.fetch.statusCode}, whose body is the server's error document, not the source`,
    )
  }
  if (options.complete && record.fetch.truncated) {
    throw new EvidenceError(
      'EVIDENCE_TRUNCATED_CANNOT_BE_COMPLETE',
      `cannot mark "${record.sourceId}" fully parsed: the capture was truncated, so the document tail was never read`,
    )
  }
  if (range.end > record.fetch.bytes) {
    throw new EvidenceError(
      'EVIDENCE_NOT_PARSED',
      `parse range [${range.start}, ${range.end}) exceeds the ${record.fetch.bytes} captured characters of "${record.sourceId}"`,
    )
  }
  const parse: ParseRange = options.complete
    ? { range, complete: true }
    : { range, complete: false, ...options.limit === undefined ? {} : { limit: options.limit } }
  return withStates(record, options.complete ? ['parsed'] : [], { parse })
}

/** Record that a range was actually placed in front of the model. */
function recordPresentation(record: EvidenceRecord, range: TextRange): EvidenceRecord {
  if (record.parse === undefined) {
    throw new EvidenceError(
      'EVIDENCE_NOT_PARSED',
      `cannot present a range of "${record.sourceId}" that was never parsed`,
    )
  }
  return withStates(record, ['range_presented_to_model'], { presented: range })
}

/** Record that a quoted span of the presented range reached the output. */
function recordCitation(record: EvidenceRecord, citation: Citation): EvidenceRecord {
  if (record.presented === undefined) {
    throw new EvidenceError(
      'EVIDENCE_NOT_PRESENTED',
      `cannot cite "${record.sourceId}": no range of it was ever presented to the model`,
    )
  }
  return withStates(record, ['cited_in_output'], { citation })
}

/**
 * Cite a search snippet.
 *
 * Allowed, and deliberately separate: citing a search result is a normal thing
 * to do, and it is NOT evidence that the document was read. This path adds
 * `cited_in_output` and can never add `parsed`.
 */
function recordSnippetCitation(record: EvidenceRecord, citation: Citation): EvidenceRecord {
  if (record.origin !== 'search_snippet') {
    throw new EvidenceError(
      'EVIDENCE_SNIPPET_IS_NOT_TEXT',
      `"${record.sourceId}" is not a snippet record`,
    )
  }
  return withStates(record, ['cited_in_output'], { citation })
}

/** Record a support check. The ONLY route to this state is an explicit call. */
function recordSupportCheck(record: EvidenceRecord, check: SupportCheck): EvidenceRecord {
  return withStates(record, ['manual_or_automatic_support_checked'], { support: check })
}

/**
 * State, in words, what is and is not known.
 *
 * This exists so the failed-versus-absent distinction is a readable artifact
 * rather than a property of a set. A 404 and a timeout must not produce the
 * same sentence, and neither may produce a sentence about the source's
 * contents.
 */
function describeEvidence(record: EvidenceRecord): string {
  const states = [...EVIDENCE_STATES].filter(state => record.states.has(state))
  const known = `states: ${states.join(', ')}`
  switch (record.fetch.kind) {
    case 'not_fetched':
      return `"${record.sourceId}": ${known}. Nothing has been fetched; the content state is UNKNOWN.`
    case 'failed':
      return `"${record.sourceId}": ${known}. The FETCH failed (${record.fetch.code}: ${record.fetch.detail}). `
        + 'This is a retrieval failure, not a finding about the source; the content state is UNKNOWN.'
    case 'responded': {
      const head = `"${record.sourceId}": ${known}. The fetch returned HTTP ${record.fetch.statusCode}`
      const truncation = record.fetch.truncated ? ', and the captured body was TRUNCATED' : ''
      const parsed = record.parse === undefined
        ? '; no parse has been recorded'
        : record.parse.complete
          ? `; parsed range [${record.parse.range.start}, ${record.parse.range.end}) in full`
          : `; parsed only range [${record.parse.range.start}, ${record.parse.range.end}) of the document`
            + ` (limit: ${record.parse.limit ?? 'unstated'})`
      const unusable = record.fetch.usable
        ? ''
        : '; the response body is not the requested source and must not be read as it'
      return `${head}${truncation}${parsed}${unusable}.`
    }
    /* v8 ignore next -- FetchOutcome is a closed union */
    default:
      return `"${record.sourceId}": ${known}.`
  }
}

/**
 * Claim that the source does not contain something.
 *
 * Refused unless a COMPLETE parse exists. This is the whole R03 rule in one
 * function: "the source does not contain X" is a finding, and a finding
 * requires a full read. A 404, a timeout, a truncated capture and a snippet
 * have all failed to read the source, so all four must report the read as
 * incomplete rather than answer the question. Note the failure mode: it THROWS.
 * It does not return an empty string, because an empty string is
 * indistinguishable from a real negative answer.
 */
function contentAbsenceClaim(record: EvidenceRecord, what: string): string {
  if (record.parse === undefined || record.parse.complete !== true) {
    throw new EvidenceError(
      'EVIDENCE_INCOMPLETE_READ',
      `refusing to claim "${record.sourceId}" does not contain "${what}": no complete read exists `
      + `(${describeEvidence(record)})`,
    )
  }
  return `"${record.sourceId}" was read in full and does not contain "${what}"`
}

/** Build a real `WebFetchResult` with the exact shape `HttpFetchProvider.readBody` produces. */
function fetchResult(overrides: Partial<WebFetchResult> & { readonly content: string }): WebFetchResult {
  const { content, ...rest } = overrides
  return {
    url: 'https://fixture.invalid/source',
    statusCode: 200,
    body: { kind: 'text', content },
    truncated: false,
    ...rest,
  }
}

describe('R03: an incomplete read states its range and its limits', () => {
  describe('saving bytes is not the same as having read the content', () => {
    it('records bytes_captured without parsed', () => {
      const record = recordFetch('src-a', fetchResult({ content: 'a whole document' }))
      expect(record.states.has('bytes_captured')).toBe(true)
      expect(record.states.has('parsed')).toBe(false)
      expect(record.parse).toBeUndefined()
    })

    it('still reports bytes_captured when the body decoded cleanly and was never parsed', () => {
      // The tempting shortcut is "the body is a string, so we read it". The body
      // being a string is a fact about the transport, not about the read.
      const record = recordFetch('src-b', fetchResult({ content: 'x'.repeat(50_000) }))
      expect([...record.states].sort()).toEqual(['bytes_captured', 'discovered'])
    })

    it('does not let a parse be recorded without bytes that arrived', () => {
      const record = recordFetchFailure('src-c', 'WEB_FETCH_TIMEOUT', 'the fetch exceeded 30000ms')
      expect(() => recordParse(record, { start: 0, end: 10 }, { complete: true }))
        .toThrow(/there are no bytes to parse/)
    })
  })

  describe('a parse that covered part of a document records the range and is not fully parsed', () => {
    it('records the range and withholds the parsed state', () => {
      const record = recordParse(
        recordFetch('src-d', fetchResult({ content: 'x'.repeat(1000) })),
        { start: 0, end: 400 },
        { complete: false, limit: 'tables were not extracted by the text extractor' },
      )
      expect(record.parse?.range).toEqual({ start: 0, end: 400 })
      expect(record.parse?.complete).toBe(false)
      expect(record.parse?.limit).toBe('tables were not extracted by the text extractor')
      expect(record.states.has('parsed')).toBe(false)
    })

    it('records the parsed state only for a complete read of the whole capture', () => {
      const record = recordParse(
        recordFetch('src-e', fetchResult({ content: 'x'.repeat(1000) })),
        { start: 0, end: 1000 },
        { complete: true },
      )
      expect(record.states.has('parsed')).toBe(true)
      expect(record.parse?.complete).toBe(true)
    })

    it('refuses to call a truncated capture completely parsed', () => {
      // The document is longer than what arrived, so "the rest of the document"
      // was never read. Marking this complete is the exact defect R03 names.
      const record = recordFetch('src-f', fetchResult({ content: 'x'.repeat(500), truncated: true }))
      expect(record.fetch).toMatchObject({ kind: 'responded', truncated: true })
      expect(() => recordParse(record, { start: 0, end: 500 }, { complete: true }))
        .toThrow(/the capture was truncated, so the document tail was never read/)
    })

    it('refuses a parse range wider than the captured bytes', () => {
      const record = recordFetch('src-g', fetchResult({ content: 'short' }))
      expect(() => recordParse(record, { start: 0, end: 99 }, { complete: false }))
        .toThrow(/exceeds the 5 captured characters/)
    })
  })

  describe('a failed fetch is a failure of the fetch, not a finding about the source', () => {
    it('records a real 404 as an unusable response rather than a parsed page', async () => {
      // Through the REAL seam: ctx.web.fetch() resolves the provider, calls it,
      // and hands back the real WebFetchResult. Only the transport is a fixture.
      const ctx = new Context()
      try {
        await ctx.plugin(WebRuntime, { fetchProvider: 'fixture-fetch' } as never)
        ctx.web.registerFetchProvider({
          id: 'fixture-fetch',
          available: () => true,
          fetch: async () => fetchResult({ content: '<html>404 Not Found</html>', statusCode: 404 }),
        })

        const result = await ctx.web.fetch({ url: 'https://fixture.invalid/missing' })
        expect(result.statusCode).toBe(404)

        const record = recordFetch('src-h', result)
        expect(record.fetch).toMatchObject({ kind: 'responded', statusCode: 404, usable: false })
        expect(record.states.has('parsed')).toBe(false)
        expect(() => recordParse(record, { start: 0, end: 4 }, { complete: true }))
          .toThrow(/HTTP 404, whose body is the server's error document, not the source/)
      } finally {
        await ctx.fiber.dispose()
      }
    })

    it('records a real WebError as a fetch failure carrying the provider code', async () => {
      const ctx = new Context()
      try {
        await ctx.plugin(WebRuntime, { fetchProvider: 'failing-fetch' } as never)
        ctx.web.registerFetchProvider({
          id: 'failing-fetch',
          available: () => true,
          fetch: async () => {
            throw new WebError('response exceeds the maximum of 5000000 bytes', 'WEB_FETCH_TOO_LARGE')
          },
        })

        let code = 'UNRECORDED'
        try {
          await ctx.web.fetch({ url: 'https://fixture.invalid/huge' })
        } catch (error: unknown) {
          expect(error).toBeInstanceOf(WebError)
          code = (error as WebError).code
        }
        expect(code).toBe('WEB_FETCH_TOO_LARGE')

        const record = recordFetchFailure('src-i', code, 'the response exceeded the byte cap')
        expect(record.fetch).toMatchObject({ kind: 'failed', code: 'WEB_FETCH_TOO_LARGE' })
        expect(record.states.has('bytes_captured')).toBe(false)
        expect(record.states.has('parsed')).toBe(false)
      } finally {
        await ctx.fiber.dispose()
      }
    })

    it('records a redirect that was refused as a fetch failure, not as the target being empty', () => {
      // A cross-origin redirect is refused by policy
      // (`packages/web/web-fetch-http/src/provider.ts:94-99`, code
      // `WEB_REDIRECT_BLOCKED`), and an over-budget hop chain is refused too
      // (`:76-79`). In both cases the requested document was never read. The
      // record must say the FETCH failed; it must not let the refusal be read
      // as "the page has no content".
      const blocked = recordFetchFailure(
        'src-redirect',
        'WEB_REDIRECT_BLOCKED',
        'cross-origin redirect to https://other.invalid/x is not followed automatically',
      )
      expect(blocked.fetch.kind).toBe('failed')
      expect(describeEvidence(blocked)).toContain('The FETCH failed')
      expect(describeEvidence(blocked)).toContain('not a finding about the source')
      expect(describeEvidence(blocked)).not.toMatch(/does not contain|no content/i)
      expect(() => contentAbsenceClaim(blocked, 'the price list')).toThrow(/no complete read exists/)
    })

    it('records a final URL that differs from the requested one, so the range is attributable', async () => {
      // `WebFetchResult.url` is documented as "the final URL after allowed
      // redirects (the request URL is in the request)"
      // (`packages/web/web/src/types.ts:75`). Keeping it is what lets a
      // citation name the page that was actually read rather than the one that
      // was asked for.
      const ctx = new Context()
      try {
        await ctx.plugin(WebRuntime, { fetchProvider: 'redirecting-fetch' } as never)
        ctx.web.registerFetchProvider({
          id: 'redirecting-fetch',
          available: () => true,
          fetch: async () => fetchResult({
            url: 'https://fixture.invalid/moved/here',
            content: 'the moved document body',
          }),
        })
        const result = await ctx.web.fetch({ url: 'https://fixture.invalid/old' })
        const record = recordFetch('src-moved', result)
        expect(record.fetch).toMatchObject({ finalUrl: 'https://fixture.invalid/moved/here' })
        expect(describeEvidence(record)).toContain('HTTP 200')
      } finally {
        await ctx.fiber.dispose()
      }
    })

    it('records an unconfigured provider as a fetch failure, never as an empty source', async () => {
      // The seam's own failure taxonomy. "no usable web provider is registered"
      // is a failure to retrieve, and reporting it as "the source has no
      // content" would fabricate a negative finding out of an outage.
      const ctx = new Context()
      try {
        await ctx.plugin(WebRuntime, { fetchProvider: 'never-registered' } as never)
        await expect(ctx.web.fetch({ url: 'https://fixture.invalid/x' }))
          .rejects.toMatchObject({ code: 'WEB_PROVIDER_CONFIGURED_MISSING' })
        const record = recordFetchFailure(
          'src-j',
          'WEB_PROVIDER_CONFIGURED_MISSING',
          'configured web provider "never-registered" is not registered',
        )
        expect(record.fetch.kind).toBe('failed')
        expect(record.states.has('parsed')).toBe(false)
      } finally {
        await ctx.fiber.dispose()
      }
    })

    it('refuses to turn a failed fetch into a negative finding', () => {
      const record = recordFetchFailure('src-k', 'WEB_REDIRECT_BLOCKED', 'cross-origin redirect')
      expect(() => contentAbsenceClaim(record, 'the licensing terms'))
        .toThrow(/refusing to claim "src-k" does not contain/)
      expect(() => contentAbsenceClaim(record, 'the licensing terms'))
        .toThrow(/EVIDENCE_INCOMPLETE_READ|no complete read exists/)
    })

    it('refuses a negative finding from a truncated capture too', () => {
      const record = recordParse(
        recordFetch('src-l', fetchResult({ content: 'x'.repeat(100), truncated: true })),
        { start: 0, end: 100 },
        { complete: false, limit: 'capture truncated at the byte cap' },
      )
      expect(() => contentAbsenceClaim(record, 'appendix C')).toThrow(/no complete read exists/)
    })

    it('allows a negative finding only after a complete read, and says so', () => {
      const body = 'a short complete document'
      const record = recordParse(
        recordFetch('src-m', fetchResult({ content: body })),
        { start: 0, end: body.length },
        { complete: true },
      )
      expect(contentAbsenceClaim(record, 'appendix C'))
        .toBe('"src-m" was read in full and does not contain "appendix C"')
    })

    it('records a truncated capture and a partial failure as different states', () => {
      // Two ways to hold less than the whole document, and they are NOT the
      // same: a successful-but-capped response is `responded` with bytes on
      // hand, while a body read that died mid-stream is `failed` that happened
      // to keep some bytes. Collapsing them would lose the reason the read is
      // short, which is the thing the record exists to carry.
      const capped = recordFetch('src-trunc', fetchResult({ content: 'x'.repeat(64), truncated: true }))
      expect(capped.fetch).toMatchObject({ kind: 'responded', truncated: true, usable: true })
      expect(capped.states.has('bytes_captured')).toBe(true)

      const diedMidStream = recordFetchFailure(
        'src-midstream',
        'WEB_FETCH_TIMEOUT',
        'the body read exceeded 30000ms after partial delivery',
        64,
      )
      expect(diedMidStream.fetch.kind).toBe('failed')
      expect(diedMidStream.states.has('bytes_captured')).toBe(true)
      expect(diedMidStream.states.has('parsed')).toBe(false)
      // And neither may be promoted to a complete parse, or turned into a
      // negative finding.
      expect(() => recordParse(capped, { start: 0, end: 64 }, { complete: true }))
        .toThrow(/the capture was truncated/)
      expect(() => contentAbsenceClaim(diedMidStream, 'section 4')).toThrow(/no complete read exists/)
    })

    it('describes a fetch failure without ever describing the source contents', () => {
      const text = describeEvidence(recordFetchFailure('src-n', 'WEB_FETCH_TIMEOUT', 'exceeded 30000ms'))
      expect(text).toContain('WEB_FETCH_TIMEOUT')
      expect(text).toContain('retrieval failure, not a finding about the source')
      expect(text).toContain('UNKNOWN')
    })

    it('describes a 404 by its status, not by absence', () => {
      const text = describeEvidence(recordFetch('src-o', fetchResult({ content: 'nope', statusCode: 404 })))
      expect(text).toContain('HTTP 404')
      expect(text).toContain('not the requested source')
      expect(text).not.toMatch(/does not contain|no content|empty/i)
    })
  })

  describe('a search snippet is not full text', () => {
    const snippet: WebSearchSource = {
      url: 'https://fixture.invalid/paper',
      title: 'A paper',
      snippet: 'The authors report a 12% improvement in the abstract.',
    }

    it('records a snippet as discovered only, with no bytes and no parse', () => {
      const record = recordSnippet('src-p', snippet)
      expect([...record.states]).toEqual(['discovered'])
      expect(record.origin).toBe('search_snippet')
      expect(record.parse).toBeUndefined()
    })

    it('cannot be promoted to parsed, by any range', () => {
      const record = recordSnippet('src-q', snippet)
      expect(() => recordParse(record, { start: 0, end: 10 }, { complete: true }))
        .toThrow(/a snippet is provider text about a document, not the document/)
      expect(record.states.has('parsed')).toBe(false)
    })

    it('may be cited without ever becoming evidence that the document was read', () => {
      const record = recordSnippetCitation(recordSnippet('src-r', snippet), {
        url: snippet.url,
        quoted: snippet.snippet ?? '',
      })
      expect(record.states.has('cited_in_output')).toBe(true)
      expect(record.states.has('parsed')).toBe(false)
      expect(record.parse).toBeUndefined()
    })

    it('cannot be presented as a read range', () => {
      const record = recordSnippet('src-s', snippet)
      expect(() => recordPresentation(record, { start: 0, end: 10 }))
        .toThrow(/that was never parsed/)
    })
  })

  describe('there is no automatic understood state', () => {
    it('names exactly the six plan states and nothing else', () => {
      expect([...EVIDENCE_STATES]).toEqual([
        'discovered',
        'bytes_captured',
        'parsed',
        'range_presented_to_model',
        'cited_in_output',
        'manual_or_automatic_support_checked',
      ])
    })

    it('contains no state whose name asserts comprehension', () => {
      for (const state of EVIDENCE_STATES) {
        expect(state).not.toMatch(/understand|comprehend|known|learned|absorbed/i)
      }
    })

    it('carries no understood field on any record, at any stage', () => {
      const stages = [
        recordFetch('src-t', fetchResult({ content: 'body' })),
        recordParse(recordFetch('src-u', fetchResult({ content: 'body' })), { start: 0, end: 4 }, { complete: true }),
        recordSupportCheck(recordFetch('src-v', fetchResult({ content: 'body' })), {
          mode: 'automatic',
          verdict: 'a retrieval record exists',
        }),
      ]
      for (const record of stages) {
        expect(Object.keys(record)).not.toContain('understood')
        expect(JSON.stringify({ ...record, states: [...record.states] }))
          .not.toMatch(/understand/i)
      }
    })

    it('reaches the support-check state only through an explicit call', () => {
      // A parse, a presentation and a citation must not imply that anyone
      // checked support. Reading is not verifying.
      let record = recordParse(
        recordFetch('src-w', fetchResult({ content: 'a body' })),
        { start: 0, end: 6 },
        { complete: true },
      )
      expect(record.states.has('manual_or_automatic_support_checked')).toBe(false)
      record = recordPresentation(record, { start: 0, end: 6 })
      expect(record.states.has('manual_or_automatic_support_checked')).toBe(false)
      record = recordCitation(record, { url: 'https://fixture.invalid/source', quoted: 'a body' })
      expect(record.states.has('manual_or_automatic_support_checked')).toBe(false)
      record = recordSupportCheck(record, { mode: 'manual', verdict: 'checked by hand' })
      expect(record.states.has('manual_or_automatic_support_checked')).toBe(true)
    })

    it('refuses a citation that no presented range supports', () => {
      const record = recordParse(
        recordFetch('src-x', fetchResult({ content: 'a body' })),
        { start: 0, end: 6 },
        { complete: true },
      )
      expect(() => recordCitation(record, { url: 'https://fixture.invalid/source', quoted: 'a body' }))
        .toThrow(/no range of it was ever presented/)
    })
  })
  describe('a PDF that was never decoded is not a document that was read', () => {
    it('records the fetch seam refusing application/pdf as a fetch failure', async () => {
      // REAL source fact, and the reason R03 cannot be satisfied by hoping the
      // fetch layer parses PDFs. `web_fetch` accepts only the two body kinds in
      // `WebFetchBody` (`packages/web/web/src/types.ts:93-95`), and
      // `classifyContentType` returns undefined for anything outside
      // text/html, text/*, application/json and application/xml
      // (`packages/web/web-fetch-http/src/policy.ts:78-84`). So a PDF URL
      // throws WEB_UNSUPPORTED_CONTENT_TYPE before any body is read
      // (`packages/web/web-fetch-http/src/provider.ts:149-153`).
      //
      // The consequence for the evidence record is the important part: a PDF
      // retrieved through this seam never reaches even `bytes_captured`. It is
      // a FETCH failure, so the record must report an unknown content state and
      // must not report the source as lacking the tables it was fetched for.
      const ctx = new Context()
      try {
        await ctx.plugin(WebRuntime, { fetchProvider: 'pdf-refusing-fetch' } as never)
        ctx.web.registerFetchProvider({
          id: 'pdf-refusing-fetch',
          available: () => true,
          fetch: async () => {
            throw new WebError('unsupported content type "application/pdf"', 'WEB_UNSUPPORTED_CONTENT_TYPE')
          },
        })

        let code = 'UNRECORDED'
        try {
          await ctx.web.fetch({ url: 'https://fixture.invalid/paper.pdf' })
        } catch (error: unknown) {
          code = error instanceof WebError ? error.code : 'WRONG_TYPE'
        }
        expect(code).toBe('WEB_UNSUPPORTED_CONTENT_TYPE')

        const record = recordFetchFailure('src-pdf', code, 'application/pdf is not a decodable body kind')
        expect(record.states.has('bytes_captured')).toBe(false)
        expect(record.states.has('parsed')).toBe(false)
        expect(() => contentAbsenceClaim(record, 'Table 3')).toThrow(/no complete read exists/)
        expect(describeEvidence(record)).toContain('UNKNOWN')
      } finally {
        await ctx.fiber.dispose()
      }
    })

    it('records a partial PDF text extraction by its range and its missing tables', () => {
      // The stimulus the plan names: "PDF text missing tables". A text-layer
      // extraction reads the prose and silently omits table content, so the
      // read is PARTIAL even though the capture was complete and untruncated.
      // `limit` is what carries that fact forward; without it the record would
      // look identical to a full read of a document that has no tables.
      const pdfText = 'Introduction. Methods. Results. (table content omitted by the extractor)'
      const record = recordParse(
        recordFetch('src-pdf2', fetchResult({ content: pdfText })),
        { start: 0, end: pdfText.length },
        { complete: false, limit: 'text-layer extraction only; table content is not in the text layer' },
      )

      expect(record.fetch).toMatchObject({ kind: 'responded', truncated: false })
      expect(record.parse?.complete).toBe(false)
      expect(record.parse?.limit).toMatch(/table content is not in the text layer/)
      expect(record.states.has('parsed')).toBe(false)
      expect(describeEvidence(record)).toContain('parsed only range')
      expect(describeEvidence(record)).toContain('table content is not in the text layer')
    })

    it('refuses to fill in a missing table from what the prose implies', () => {
      // "不补写缺失内容" — do not write in the missing content. The refusal is
      // structural here: a claim about the table is a claim about content the
      // record never read, so the only route is a complete parse, which this
      // record does not have.
      const prose = 'The results are summarised in Table 3.'
      const record = recordParse(
        recordFetch('src-pdf3', fetchResult({ content: prose })),
        { start: 0, end: prose.length },
        { complete: false, limit: 'table body is not in the PDF text layer' },
      )
      expect(() => contentAbsenceClaim(record, 'the confidence interval in Table 3'))
        .toThrow(/no complete read exists/)
    })
  })

  describe('a search snippet substituted for full text stays a snippet', () => {
    it('keeps a real provider source at discovered-only through the real ctx.web seam', async () => {
      // Through the REAL seam with the ported provider
      // (`src/web-search.ts`), because "the snippet came from a working search"
      // is exactly the argument someone would use to promote it to a read.
      const { createDualLaneSearchProvider } = await import('./web-search.ts')
      const ctx = new Context()
      const realFetch = globalThis.fetch
      try {
        await ctx.plugin(WebRuntime, { searchProvider: 'fixture-search' } as never)
        ctx.web.registerSearchProvider(createDualLaneSearchProvider(
          { id: 'fixture-search', endpoint: 'https://fixture.invalid/search', apiKeyEnv: 'CANARY_KEY' },
          { isConfigured: () => true },
        ))
        globalThis.fetch = (async () => new Response(JSON.stringify({
          results: [{
            url: 'https://fixture.invalid/paper',
            title: 'A paper',
            snippet: 'We report a 12% improvement.',
          }],
        }), { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch

        const result = await ctx.web.search({ query: 'improvement', maxResults: 5 })
        expect(result.sources).toHaveLength(1)
        const source = result.sources[0] as WebSearchSource
        expect(source.snippet).toBe('We report a 12% improvement.')

        const record = recordSnippet('src-search', source)
        expect(record.states.has('parsed')).toBe(false)
        expect(record.fetch.kind).toBe('not_fetched')
        expect(() => recordParse(record, { start: 0, end: 28 }, { complete: true }))
          .toThrow(/not the document/)
      } finally {
        globalThis.fetch = realFetch
        await ctx.fiber.dispose()
      }
    })

    it('reports a search FAILURE as an error, never as a snippet-free empty result', async () => {
      // The rule this project treats as central, applied to R03: a failed
      // search must not produce "no results", because that would read as "the
      // source set is empty" and the model would then have nothing to promote —
      // or, worse, would record an absence. The ported provider throws.
      const { createDualLaneSearchProvider } = await import('./web-search.ts')
      const ctx = new Context()
      const realFetch = globalThis.fetch
      try {
        await ctx.plugin(WebRuntime, { searchProvider: 'failing-search' } as never)
        ctx.web.registerSearchProvider(createDualLaneSearchProvider(
          { id: 'failing-search', endpoint: 'https://fixture.invalid/search', apiKeyEnv: 'CANARY_KEY' },
          { isConfigured: () => true },
        ))
        globalThis.fetch = (async () => new Response('upstream down', { status: 503 })) as typeof fetch

        await expect(ctx.web.search({ query: 'anything', maxResults: 5 }))
          .rejects.toMatchObject({ code: 'SEARCH_PROVIDER_ERROR' })

        // And the honest record of that failure is a fetch failure, not a
        // discovered source with no content.
        const record = recordFetchFailure(
          'src-search-failed',
          'SEARCH_PROVIDER_ERROR',
          'the search provider answered HTTP 503',
        )
        expect(record.fetch.kind).toBe('failed')
        expect(record.states.has('discovered')).toBe(true)
        expect(record.states.has('bytes_captured')).toBe(false)
      } finally {
        globalThis.fetch = realFetch
        await ctx.fiber.dispose()
      }
    })
  })
})

/**
 * What one request actually carried.
 *
 * Built from EXPLICIT INCLUSION: the caller names the ids that went into the
 * request. There is no `maxSeq` field and no `seq <= bound` rule anywhere in
 * this type, because after a surface replacement the visible seqs are neither
 * contiguous nor ascending — see the tests below for the concrete
 * counterexample.
 */
interface RequestManifest {
  readonly sessionId: string
  /** Event seqs that were in the request, in model-visible order. */
  readonly includedSeqs: readonly SessionSeq[]
  /** Message ids that were in the request, in the same order. */
  readonly includedMessageIds: readonly MessageId[]
  /** Why this manifest is trustworthy: it was read off the surface, not inferred. */
  readonly basis: 'explicit-inclusion'
}

/**
 * Read the manifest off the live surface.
 *
 * `Session.deriveMessages()` walks `surfaceOp` markers, and the real doc
 * comment says exactly why that is the only correct source
 * (`packages/core/session/src/index.ts:825-829`):
 *
 *   "The surface is the single source of derived history: every
 *    message-producing append records its `surfaceOp`, so a raw event with no
 *    marker (a chunk, a turn boundary) is correctly absent, and a compaction
 *    `replace` deletes the shadowed nodes from the derivation."
 */
function buildRequestManifest(session: Session): RequestManifest {
  const nodes = [...session.surface.nodes]
  const messages = session.deriveMessages()
  return Object.freeze({
    sessionId: session.id,
    includedSeqs: nodes,
    includedMessageIds: messages.map(message => message.id),
    basis: 'explicit-inclusion',
  })
}

/**
 * The INVALID shortcut, written out so its wrong answer is measurable.
 *
 * "Visible = seq <= maxSeq" assumes the visible set is a prefix of the log.
 * Compaction breaks that assumption by design: the replacement lands at a NEW,
 * higher seq while occupying an OLD surface position, so the shadowed seqs are
 * below the maximum and still absent.
 */
function inferVisibleByMaxSeq(session: Session, maxSeq: number): readonly SessionSeq[] {
  const inferred: SessionSeq[] = []
  for (let seq = 0; seq <= maxSeq; seq++) inferred.push(seq as SessionSeq)
  return inferred
}

/** The model-visible text, for asserting that a compacted-away observation is really gone. */
function visibleText(session: Session): string {
  return session.deriveMessages()
    .flatMap(message => message.content)
    .map(block => (block.type === 'text' ? block.text : ''))
    .join('\n')
}

/**
 * Build a real session whose surface has had one observation compacted away.
 *
 * The replacement is exactly what `compactSurfaceRegion` appends
 * (`packages/compaction/compaction-basic/src/region.ts:507-510`):
 *
 *   session.append('user/message', checkpointMessage, {
 *     surfaceOp: { op: 'replace', startSeq: start, endSeq: end },
 *     sourceEventSeqs: [startEvent.seq, summaryEvent.seq, ...shadowedSeqs],
 *   })
 *
 * The `compaction/*` records around it are log-only events with no surfaceOp,
 * so leaving them out changes nothing this gate measures.
 */
function sessionWithCompactedObservation(): {
  readonly session: Session
  readonly observationSeq: SessionSeq
  readonly summarySeq: SessionSeq
} {
  const session = Session.create(SessionId('r04-session'))
  const observation = session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: 'OBSERVATION: the fixture report claims a 12% gain.' }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  const later = session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: 'OBSERVATION: an unrelated second note.' }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })

  // Before compaction the observation is genuinely visible; asserted so the
  // "after" state is a real change rather than a session that never held it.
  expect(session.surface.nodes).toEqual([observation.seq, later.seq])

  const summary = session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: 'SUMMARY: two earlier observations were compacted.' }],
    source: { kind: 'plugin', plugin: 'compaction' },
  }), {
    surfaceOp: { op: 'replace', startSeq: observation.seq, endSeq: observation.seq },
    sourceEventSeqs: [observation.seq],
  })

  return { session, observationSeq: observation.seq, summarySeq: summary.seq }
}

describe('R04: a request manifest is not inferred from the maximum session seq', () => {
  describe('a manifest built from explicit inclusion', () => {
    it('excludes an observation that was compacted away', () => {
      const { session, observationSeq, summarySeq } = sessionWithCompactedObservation()
      const manifest = buildRequestManifest(session)
      expect(manifest.includedSeqs).not.toContain(observationSeq)
      expect(manifest.includedSeqs).toContain(summarySeq)
      expect(manifest.basis).toBe('explicit-inclusion')
    })

    it('matches the real derived surface rather than a seq bound', () => {
      const { session } = sessionWithCompactedObservation()
      const manifest = buildRequestManifest(session)
      expect(manifest.includedSeqs).toEqual([...session.surface.nodes])
      expect(manifest.includedMessageIds).toHaveLength(session.deriveMessages().length)
    })

    it('records visible seqs that are not ascending, which no seq bound can express', () => {
      // The replacement lands at a HIGHER seq than the node it shadowed, so the
      // visible seqs run [summary, later] = [2, 1]. Any rule of the form
      // "everything at or below some seq" produces a contiguous prefix and
      // therefore cannot describe this surface at all.
      const { session, summarySeq } = sessionWithCompactedObservation()
      const nodes = [...session.surface.nodes]
      expect(nodes[0]).toBe(summarySeq)
      expect(nodes[1]).toBeLessThan(nodes[0] as number)
    })

    it('drops the compacted observation from the model-visible text', () => {
      const { session } = sessionWithCompactedObservation()
      const text = visibleText(session)
      expect(text).not.toContain('the fixture report claims a 12% gain')
      expect(text).toContain('SUMMARY: two earlier observations were compacted.')
    })
  })

  describe('the max-seq shortcut is wrong on a compacted history', () => {
    it('produces a set that wrongly includes the shadowed observation', () => {
      const { session, observationSeq, summarySeq } = sessionWithCompactedObservation()
      const maxSeq = session.seq - 1
      const wrong = inferVisibleByMaxSeq(session, maxSeq)
      const right = buildRequestManifest(session).includedSeqs

      // The counterexample, stated as a fact about this session: the shortcut
      // says the model saw the observation, and the model did not.
      expect(wrong).toContain(observationSeq)
      expect(right).not.toContain(observationSeq)
      expect(summarySeq).toBeGreaterThan(observationSeq)
      expect(wrong.length).toBeGreaterThan(right.length)
    })

    it('disagrees with the real derivation by exactly the shadowed nodes', () => {
      const { session, observationSeq } = sessionWithCompactedObservation()
      const wrong = new Set(inferVisibleByMaxSeq(session, session.seq - 1))
      const right = new Set(buildRequestManifest(session).includedSeqs)
      const onlyInWrong = [...wrong].filter(seq => !right.has(seq))
      const onlyInRight = [...right].filter(seq => !wrong.has(seq))

      expect(onlyInWrong).toEqual([observationSeq])
      // Nothing the shortcut omits: the error is one-directional and always
      // claims MORE was seen than really was, which is the dangerous direction.
      expect(onlyInRight).toEqual([])
    })

    it('would report the model as having seen a tool result that compaction removed', () => {
      // Same mechanism, the case the plan names explicitly ("old results may no
      // longer be in the request"). A shadowed tool/result is a removed
      // observation, and the shortcut re-admits it.
      const session = Session.create(SessionId('r04-tool-result'))
      const first = session.append('user/message', createUserMessage({
        content: [{ type: 'text', text: 'OBSERVATION: fetched body says the figure is 12%.' }],
        source: { kind: 'user' },
      }), { surfaceOp: 'append' })
      const second = session.append('user/message', createUserMessage({
        content: [{ type: 'text', text: 'OBSERVATION: a second fetched body.' }],
        source: { kind: 'user' },
      }), { surfaceOp: 'append' })

      session.append('user/message', createUserMessage({
        content: [{ type: 'text', text: 'SUMMARY: both fetched bodies compacted.' }],
        source: { kind: 'plugin', plugin: 'compaction' },
      }), {
        surfaceOp: { op: 'replace', startSeq: first.seq, endSeq: second.seq },
        sourceEventSeqs: [first.seq, second.seq],
      })

      const manifest = buildRequestManifest(session)
      expect(manifest.includedSeqs).toEqual([session.surface.nodes[0]])
      const wrong = inferVisibleByMaxSeq(session, session.seq - 1)
      expect(wrong).toContain(first.seq)
      expect(wrong).toContain(second.seq)
      expect(visibleText(session)).not.toContain('the figure is 12%')
    })
  })
})

// ===========================================================================
// R08 — evidence access is scoped to authorized sessions.
// ===========================================================================

/**
 * Refusal classes. The two must be distinguishable, because "you may not read
 * this" and "this does not exist" are different answers and only one of them is
 * about the caller's authority.
 *
 * `SESSION_QUERY_TOOL_UNAUTHORIZED` is DSH's own refusal code
 * (`packages/session-query/tool-session-query/src/service-boundary.ts:92-97`):
 * `new HarnessError('session target is outside the caller workspace',
 * 'SESSION_QUERY_TOOL_UNAUTHORIZED')`. `SESSION_QUERY_SESSION_NOT_FOUND` is the
 * real not-found code from `SessionQueryError`
 * (`packages/session-query/session-query/src/config.ts`). Reusing the real
 * vocabulary keeps a caller's routing correct across the boundary.
 */
type SessionScopeErrorCode =
  | 'SESSION_QUERY_TOOL_UNAUTHORIZED'
  | 'SESSION_QUERY_SESSION_NOT_FOUND'
  | 'SESSION_SCOPE_INVALID_ALLOWLIST'

class SessionScopeError extends Error {
  readonly code: SessionScopeErrorCode

  constructor(code: SessionScopeErrorCode, message: string) {
    super(message)
    this.name = 'SessionScopeError'
    this.code = code
  }
}

/**
 * A read guard over an allow-list of session ids.
 *
 * The scope holds ONE thing — the ids it is allowed to read — and consults the
 * session store only after the allow-list has admitted the id. That ordering is
 * the whole design: `ctx.sessions.get(id)` returns `undefined` both for "not
 * authorized" and for "does not exist", so consulting the store first would
 * collapse a refusal into an apparent absence. `read()` therefore throws rather
 * than returning `undefined`, and `list()` reports only what is authorized.
 *
 * There is no path argument, no root, no home, and no store accessor. The
 * caller cannot reach `DSH_HOME` through this object even by mistake, because
 * this object has nothing that names a filesystem location.
 */
class SessionScope {
  /**
   * `#` rather than TypeScript's `private`, deliberately.
   *
   * A `private` field is erased at compile time: the value stays reachable as a
   * plain property, so `scope.store` would hand a caller the whole session
   * store and the allow-list would become advisory. `#` is the only form that
   * is actually unreachable from outside, and this test file asserts the
   * absence at runtime rather than trusting the modifier.
   */
  readonly #allowed: ReadonlySet<string>
  readonly #store: SessionStore

  /**
   * @param store - the real session store to read through.
   * @param allowedSessionIds - the ids this scope may read. COPIED, so a caller
   *   mutating its own array afterwards cannot widen a live scope.
   * @throws when the allow-list is empty, which is a configuration error rather
   *   than a scope that silently permits everything.
   */
  constructor(store: SessionStore, allowedSessionIds: readonly string[]) {
    if (allowedSessionIds.length === 0) {
      throw new SessionScopeError(
        'SESSION_SCOPE_INVALID_ALLOWLIST',
        'a session scope requires a non-empty allow-list; an empty list is not a wildcard',
      )
    }
    this.#store = store
    this.#allowed = new Set(allowedSessionIds)
  }

  /**
   * Read one authorized session.
   * @throws `SESSION_QUERY_TOOL_UNAUTHORIZED` when the id is outside the allow-list,
   *   and `SESSION_QUERY_SESSION_NOT_FOUND` when an authorized id has no session.
   */
  read(sessionId: string): Session {
    if (!this.#allowed.has(sessionId)) {
      throw new SessionScopeError(
        'SESSION_QUERY_TOOL_UNAUTHORIZED',
        `session "${sessionId}" is outside this scope's authorized sessions; `
        + `authorized: ${[...this.#allowed].join(', ')}`,
      )
    }
    const session = this.#store.get(SessionId(sessionId))
    if (session === undefined) {
      throw new SessionScopeError(
        'SESSION_QUERY_SESSION_NOT_FOUND',
        `session "${sessionId}" is authorized but does not exist`,
      )
    }
    return session
  }

  /** The authorized ids that currently exist, in allow-list order. */
  list(): readonly string[] {
    return [...this.#allowed].filter(id => this.#store.get(SessionId(id)) !== undefined)
  }
}

/** Build a real session store holding two fabricated sessions. */
async function scopeRig(): Promise<{ ctx: Context; store: SessionStore }> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  const store = ctx.get('sessions') as SessionStore
  store.create(SessionId('session-authorized'))
  store.create(SessionId('session-other-user'))
  return { ctx, store }
}

describe('R08: evidence access is scoped to authorized sessions', () => {
  describe('a read inside the allow-list succeeds', () => {
    it('returns the real session', async () => {
      const { ctx, store } = await scopeRig()
      try {
        const scope = new SessionScope(store, ['session-authorized'])
        const session = scope.read('session-authorized')
        expect(session.id).toBe('session-authorized')
        expect(session).toBe(store.get(SessionId('session-authorized')))
      } finally {
        await ctx.fiber.dispose()
      }
    })

    it('lists only the authorized ids, in allow-list order', async () => {
      const { ctx, store } = await scopeRig()
      try {
        const scope = new SessionScope(store, ['session-other-user', 'session-authorized'])
        expect(scope.list()).toEqual(['session-other-user', 'session-authorized'])
      } finally {
        await ctx.fiber.dispose()
      }
    })
  })

  describe('a read outside the allow-list is refused, not empty', () => {
    it('throws rather than returning undefined for a session that really exists', async () => {
      // The session EXISTS. So the refusal cannot be explained as absence, and
      // an implementation that consulted the store first and returned
      // `undefined` would be reporting "no history" for a session that has one.
      const { ctx, store } = await scopeRig()
      try {
        expect(store.get(SessionId('session-other-user'))).toBeDefined()
        const scope = new SessionScope(store, ['session-authorized'])
        expect(() => scope.read('session-other-user')).toThrow(SessionScopeError)
      } finally {
        await ctx.fiber.dispose()
      }
    })

    it('carries the real unauthorized code, not a not-found code', async () => {
      const { ctx, store } = await scopeRig()
      try {
        const scope = new SessionScope(store, ['session-authorized'])
        let code = 'UNRECORDED'
        try {
          scope.read('session-other-user')
        } catch (error: unknown) {
          code = error instanceof SessionScopeError ? error.code : 'WRONG_TYPE'
        }
        expect(code).toBe('SESSION_QUERY_TOOL_UNAUTHORIZED')
        expect(code).not.toBe('SESSION_QUERY_SESSION_NOT_FOUND')
      } finally {
        await ctx.fiber.dispose()
      }
    })

    it('names the refusal and the authorized set, so the error is actionable', async () => {
      const { ctx, store } = await scopeRig()
      try {
        const scope = new SessionScope(store, ['session-authorized'])
        expect(() => scope.read('session-other-user'))
          .toThrow(/session "session-other-user" is outside this scope's authorized sessions/)
        expect(() => scope.read('session-other-user')).toThrow(/authorized: session-authorized/)
      } finally {
        await ctx.fiber.dispose()
      }
    })

    it('keeps a genuine not-found distinguishable from a refusal', async () => {
      const { ctx, store } = await scopeRig()
      try {
        const scope = new SessionScope(store, ['session-authorized', 'session-never-created'])
        let code = 'UNRECORDED'
        try {
          scope.read('session-never-created')
        } catch (error: unknown) {
          code = error instanceof SessionScopeError ? error.code : 'WRONG_TYPE'
        }
        expect(code).toBe('SESSION_QUERY_SESSION_NOT_FOUND')
      } finally {
        await ctx.fiber.dispose()
      }
    })

    it('does not let list() stand in for a refused read', async () => {
      // An empty list looks like "no history exists", which is a different and
      // misleading answer. The refusal is available as an error, and the
      // authorized-only list does not hide it.
      const { ctx, store } = await scopeRig()
      try {
        const scope = new SessionScope(store, ['session-authorized'])
        expect(scope.list()).not.toContain('session-other-user')
        expect(() => scope.read('session-other-user')).toThrow(SessionScopeError)
      } finally {
        await ctx.fiber.dispose()
      }
    })
  })

  describe('nothing widens the scope implicitly', () => {
    it('refuses to construct a scope from an empty allow-list', async () => {
      // The classic widening: "no ids configured" quietly meaning "all ids".
      const { ctx, store } = await scopeRig()
      try {
        expect(() => new SessionScope(store, [])).toThrow(/an empty list is not a wildcard/)
      } finally {
        await ctx.fiber.dispose()
      }
    })

    it('treats a wildcard entry as a literal id rather than a pattern', async () => {
      const { ctx, store } = await scopeRig()
      try {
        const scope = new SessionScope(store, ['*'])
        expect(scope.list()).toEqual([])
        expect(() => scope.read('session-authorized')).toThrow(/outside this scope's authorized sessions/)
      } finally {
        await ctx.fiber.dispose()
      }
    })

    it('copies the allow-list, so a later mutation cannot widen a live scope', async () => {
      const { ctx, store } = await scopeRig()
      try {
        const callerOwned = ['session-authorized']
        const scope = new SessionScope(store, callerOwned)
        callerOwned.push('session-other-user')
        expect(scope.list()).toEqual(['session-authorized'])
        expect(() => scope.read('session-other-user')).toThrow(SessionScopeError)
      } finally {
        await ctx.fiber.dispose()
      }
    })

    it('exposes no store, root, home or path accessor', async () => {
      const { ctx, store } = await scopeRig()
      try {
        const scope = new SessionScope(store, ['session-authorized'])
        const surface = [
          ...Object.getOwnPropertyNames(scope),
          ...Object.getOwnPropertyNames(SessionScope.prototype),
        ]
        for (const forbidden of ['store', 'sessions', 'root', 'home', 'dshHome', 'path', 'dir', 'cwd']) {
          expect(surface).not.toContain(forbidden)
        }
        // Runtime reachability, not just the property list: a TypeScript
        // `private` would have been erased, leaving `scope.store` a real
        // property. `#store` is unreachable, so both spellings read undefined.
        const probe = scope as unknown as Record<string, unknown>
        expect(probe['store']).toBeUndefined()
        expect(probe['allowed']).toBeUndefined()
        expect(probe['#store']).toBeUndefined()
        // The only callable API is the two reads.
        expect(Object.getOwnPropertyNames(SessionScope.prototype).sort())
          .toEqual(['constructor', 'list', 'read'])
      } finally {
        await ctx.fiber.dispose()
      }
    })

    it('has no constructor route that widens authority', () => {
      // No `allowAll`, no environment fallback, no default parameter. The
      // allow-list is a required argument, and it is the only one that can
      // admit an id.
      const statics = Object.getOwnPropertyNames(SessionScope)
      expect(statics).not.toContain('allowAll')
      expect(statics).not.toContain('fromEnvironment')
      expect(statics).not.toContain('unscoped')
      expect(SessionScope.length).toBe(2)
    })

    it('takes only a session id, so there is no path argument to escape through', async () => {
      const { ctx, store } = await scopeRig()
      try {
        const scope = new SessionScope(store, ['session-authorized'])
        expect(SessionScope.prototype.read.length).toBe(1)
        // A path-shaped argument is just an id that is not on the allow-list.
        expect(() => scope.read('../../.dsh/sessions/session-other-user')).toThrow(SessionScopeError)
      } finally {
        await ctx.fiber.dispose()
      }
    })
  })
})
