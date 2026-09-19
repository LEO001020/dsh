/**
 * The web-search plugin entry point.
 *
 * Registers the ported search provider through the public
 * `ctx.web.registerSearchProvider` seam, so `dsh-tool-web`'s existing
 * `web_search` tool routes to it without any change to the tool or the model's
 * view. There is one tool definition and one provider registry; this package
 * adds a provider, not a second tool.
 *
 * Why a provider rather than a tool: the seam exists precisely so search backends
 * are interchangeable behind one model-facing schema. Adding a tool would give
 * the model two ways to search and two result shapes to reconcile.
 *
 * Credential handling: the config names a credential REFERENCE (`apiKeyEnv`); no
 * value is ever placed in configuration. Presence is read through
 * `ctx.credentials.describe`, which by construction has no field a value could
 * ride in. `available()` therefore reports configuration presence, which is
 * explicitly NOT a tested entitlement and NOT a successful search.
 */
import type { Context } from '@deepseek-ai/cordis'
import { createDualLaneSearchProvider, type DualLaneSearchConfig } from './web-search.ts'

export const name = 'dsh-daily-web-search'
export const inject = ['web']

/** Plugin config. The credential is named, never inlined. */
export interface Config extends DualLaneSearchConfig {}

/**
 * Register the provider.
 *
 * @param ctx - the host context carrying `ctx.web`.
 * @param config - endpoint, credential reference and bounds.
 */
export function apply(ctx: Context, config: Config): void {
  /**
   * Cached credential presence.
   *
   * `describe` is async, but `available()` must be synchronous and local. So
   * presence is read once at mount and refreshed explicitly; it is never probed
   * on the search path. A stale `true` here would claim an entitlement we did
   * not just observe, so the refresh is a real call and not an assumption.
   */
  const presenceCache = new Map<string, boolean>()

  const refresh = async (): Promise<void> => {
    const credentials = ctx.get('credentials')
    if (credentials === undefined) return
    try {
      const info = await credentials.describe(config.apiKeyEnv)
      presenceCache.set(config.apiKeyEnv, info.configured)
    } catch {
      // A credential store that cannot be read is not a configured credential.
      // Reporting "configured" on an error would claim an entitlement we did not
      // observe.
      presenceCache.set(config.apiKeyEnv, false)
    }
  }

  const provider = createDualLaneSearchProvider(config, {
    isConfigured(reference: string): boolean {
      // `describe` returns `{configured, source?, writable}` and has no value
      // slot. Reading presence this way is the difference between "the key is
      // configured" and "the key works", and only the first is being claimed.
      return presenceCache.get(reference) ?? false
    },
  })

  ctx.effect(() => {
    void refresh()
    const dispose = ctx.web.registerSearchProvider(provider)
    return () => {
      dispose()
      presenceCache.clear()
    }
  }, 'dsh-daily-web-search: register provider')
}
