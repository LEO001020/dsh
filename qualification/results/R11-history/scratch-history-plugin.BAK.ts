/**
 * The host-profile entry point for M7's history and web-provenance plane.
 *
 * WHY THIS FILE EXISTS. `history-plane.ts` and `web-provenance.ts` were, until
 * this entry point existed, TEST-ONLY modules: they had no production importer,
 * so mounting them directly in a test proved they WORK but proved nothing about
 * whether the PRODUCT uses them. That is the defect class this project has
 * already been bitten by three times (`setLaunchPort`, `takeContinuation`, the
 * missing `dsh.bundle` on `dsh-ipython`), and `docs/GAPS.md` G-FIX-04 names the
 * lesson: an oracle weaker than its scenario passes while the product is broken.
 *
 * So this is a real Cordis plugin with a real service name, declared in
 * `cordis.patch.yml` as an `insert` row, loadable by the profile resolver with no
 * test in the loop. `ctx.dailyHistory` is the handle.
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 *
 * It does not mount its own `ctx.sessionQuery`, does not open a database, and
 * does not require one. `ctx.sessionQuery` is DSH's service and a deployment may
 * or may not have it (the shipped profile configures `session-query-sqlite` with
 * `openAt: never`, so full-text search is off but exact reads still work). This
 * plugin therefore injects it as an OPTIONAL dependency: with the service
 * present, `history()` returns an authorized plane; without it, `history()`
 * throws a typed refusal rather than silently returning an empty history.
 *
 * That distinction is the whole point of HIS-01's discipline applied to the
 * deployment itself: "no session-query service is mounted" and "this session has
 * no events" are different facts, and only one of them is about the session.
 *
 * THE AUTHORIZATION SEAM
 *
 * `ctx.sessionQuery` has NO caller authorization (its README says so). The only
 * thing that makes this plugin safe is that it never hands the service out: a
 * caller supplies a {@link HistoryCaller} and receives a {@link HistoryPlane},
 * whose every read re-checks that caller's workspace against the target's. There
 * is no `service` accessor, no `rawQuery()`, and no method that takes a bare
 * SessionId without a caller attached to the plane that will serve it.
 */
import { Context, Service } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { WebFetchResult, WebSearchResult } from '@deepseek-ai/dsh-web'
import {
  createHistoryPlaneFromContext,
  type HistoryCaller,
  type HistoryPlane,
} from './history-plane.ts'
import {
  EXTERNAL_WEB_CONTENT_NOTICE,
  provenanceFromFetch,
  searchProvenance,
  wrapUntrusted,
  type HtmlToMarkdown,
  type ProvenanceRecord,
  type SearchProvenance,
  type UntrustedContent,
} from './web-provenance.ts'

export const name = 'dsh-daily-history'
/**
 * `sessionQuery` is NOT listed here.
 *
 * `inject` makes a service a hard activation requirement, and a deployment
 * without session-query must still boot: this plugin's web-provenance half has
 * no dependency on history at all. The dependency is resolved per call through
 * `ctx.get('sessionQuery')`, which is the optional-dependency form, and a missing
 * service produces a typed refusal instead of a boot failure or an empty result.
 */
export const inject: string[] = []

/** Config for the M7 plane. */
export interface Config {
  /**
   * Byte budget for the dynamic working-state tail.
   *
   * A composition value, not a model argument: the model cannot widen its own
   * tail. Defaults to `DYNAMIC_TAIL_BYTE_BUDGET` when omitted.
   */
  readonly dynamicTailBytes?: number
}

/**
 * The M7 host service, reachable as `ctx.dailyHistory`.
 *
 * Every method takes the CALLER, not just a target. A method that accepted a
 * bare SessionId would have to invent an authority for it, and the only
 * inventions available are "trust the argument" (which makes the caller the
 * authority) or "read anyway" (which is the unauthorized exposure HIS-01
 * refuses).
 */
export class HistoryPlaneService extends Service {
  private readonly _planes = new WeakMap<object, HistoryPlane>()
  private readonly _configuredTailBytes: number | undefined
  /**
   * Strong references to the planes, kept ONLY so teardown can dispose them.
   *
   * The `WeakMap` is the per-caller lookup; this array is the disposal list.
   * Keeping both is deliberate: a `WeakMap` alone leaks nothing but cannot be
   * enumerated at teardown, and a plain `Map` alone would keep every caller object
   * alive for the process lifetime. The array holds the PLANES (which this service
   * owns and must release), not the caller objects (which it must not retain).
   */
  private readonly _planeRefs: HistoryPlane[] = []

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'dailyHistory')
    this._configuredTailBytes = config.dynamicTailBytes
  }

  /** Whether the deployment has a session-query service this plane can read through. */
  available(): boolean {
    return this.ctx.get('sessionQuery') !== undefined
  }

  /**
   * Obtain the authorized history plane for one caller.
   *
   * The plane is cached per caller OBJECT, so a long-lived caller does not
   * re-create its replay accounting on every call, and a different caller object
   * can never receive another caller's plane.
   *
   * @param caller - the authority every read through the returned plane is performed under.
   * @returns the plane. Every method on it re-checks the caller.
   * @throws when no `ctx.sessionQuery` service is mounted, naming that as the cause
   *   rather than returning an empty history.
   */
  history(caller: HistoryCaller): HistoryPlane {
    if (this.ctx.get('sessionQuery') === undefined) {
      throw new Error(
        'dailyHistory: no ctx.sessionQuery service is mounted, so history reads are unavailable. '
        + 'This is a DEPLOYMENT fact (the session-query plugin is not loaded), not an absence of history.',
      )
    }
    const cached = this._planes.get(caller)
    if (cached !== undefined) return cached
    const plane = createHistoryPlaneFromContext(this.ctx, caller)
    this._planes.set(caller, plane)
    this._planeRefs.push(plane)
    return plane
  }

  /**
   * Record one fetch result as a provenance record.
   *
   * The result comes from `ctx.web.fetch`, so this service does not perform
   * retrieval and cannot bypass the fetch provider's SSRF and redirect policy.
   * It only records what the fetch produced, with the truncation, transform and
   * hash distinctions WEB-01..08 require.
   *
   * @param result - the real `WebFetchResult`.
   * @param request - the request context plus the artifact the bytes were stored as.
   * @param convert - the HTML->markdown converter, when a derivation is wanted.
   * @returns the record and its gaps.
   */
  recordFetch(
    result: WebFetchResult,
    request: {
      readonly requestedUrl: string
      readonly provider: string
      readonly acquiredAt: string
      readonly artifact: string
      readonly sha256: string
      readonly maxBodyChars?: number
      readonly etag?: string
      readonly lastModified?: string
    },
    convert?: { readonly convert: HtmlToMarkdown; readonly identity: { readonly name: string; readonly version: string } },
  ): { readonly record: ProvenanceRecord; readonly gaps: ProvenanceRecord['acquisition']['gaps'] } {
    return provenanceFromFetch(result, request, convert)
  }

  /**
   * Record one search result as a RANKING.
   *
   * The returned record's `mayBeMore` is `unknown` unless the seam itself cut the
   * list, so a consumer cannot read a top-10 list as an exhausted search.
   */
  recordSearch(
    result: WebSearchResult,
    request: { readonly query: string; readonly provider: string; readonly maxResults?: number; readonly acquiredAt: string },
  ): SearchProvenance {
    return searchProvenance(result, request)
  }

  /**
   * Wrap retrieved content as untrusted data.
   *
   * There is no variant of this method that returns anything with authority:
   * the return type has no such field, and the capability question is answered by
   * a function that ignores its input.
   */
  untrusted(text: string, artifact: { readonly artifact: string; readonly sha256: string }): UntrustedContent {
    return wrapUntrusted(text, artifact)
  }

  /** The notice every consumer must render before retrieved content. */
  get untrustedNotice(): string {
    return EXTERNAL_WEB_CONTENT_NOTICE
  }

  /** The configured dynamic-tail budget, or `undefined` when the default applies. */
  get dynamicTailBytes(): number | undefined {
    return this._configuredTailBytes
  }

  /**
   * Release every caller plane this service handed out.
   *
   * Called from the plugin's `ctx.effect` disposer, because Cordis has no
   * `Service.stop` lifecycle symbol: a service is unregistered automatically when
   * its owning fiber unloads (`vendor/cordis/src/service.ts:11-60`), so an owned
   * resource like a pinned observation lease has to be released by an effect the
   * plugin registers explicitly.
   *
   * Releasing the planes matters: each holds a pinned session-query observation
   * lease, and an undisposed lease keeps a prepared Session pinned in the
   * observation reader's cache.
   */
  dispose(): void {
    for (const plane of this._planeRefs.splice(0)) plane.dispose()
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    dailyHistory: HistoryPlaneService
  }
}

/**
 * Mount the M7 history and provenance service.
 *
 * @param ctx - the host context that owns this extension.
 * @param config - the composition values for the plane.
 */
export function apply(ctx: Context, config: Config = {}): void {
  const service = new HistoryPlaneService(ctx, config)
  ctx.effect(() => () => service.dispose(), 'dsh-daily-history: plane service')
}

export { HistoryPlane, type HistoryCaller, type HistoryPlane as HistoryPlaneType } from './history-plane.ts'
export type { ProvenanceRecord, SearchProvenance, UntrustedContent } from './web-provenance.ts'
export type { SessionId }
