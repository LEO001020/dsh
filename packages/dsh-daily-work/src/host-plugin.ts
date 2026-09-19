/**
 * The host-profile entry point for the work extension.
 *
 * Mounted ONCE by the host profile. It owns the storage-domain handle.
 *
 * Shape note, learned from a real failure: a plain synchronous
 * `apply(ctx, config)` that kicks off `service.open()` inside `ctx.effect()`
 * returns before the domain is open. A caller that did
 * `await ctx.plugin(...)` and then resolved `ctx.dailyWork` would find a live
 * service whose domain was still opening, and every call would fail with
 * "domain is not open". The first version of this file had exactly that bug and
 * its own test caught it.
 *
 * The correct shape is the one `@deepseek-ai/dsh-storage-domain` itself uses: an
 * `async apply` that returns only after the service is genuinely available, with
 * the handle released by an effect-owned disposer. Cordis awaits the returned
 * promise, so `await ctx.plugin(...)` becomes a real activation edge.
 */
import type { Context } from '@deepseek-ai/cordis'
import { WorkService, type WorkServiceConfig } from './host.ts'

export const name = 'dsh-daily-work'
export const inject = ['storageDomain']

/**
 * Configuration. `targetChildren` is the user's N; it is not the model's to
 * change. The model has a tool, but that tool cannot write this value.
 */
export interface Config extends WorkServiceConfig {}

/**
 * Mount the work service and return after its domain is genuinely open.
 *
 * @param ctx - the host context that owns this extension.
 * @param config - the user-authorized run defaults.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  const service = new WorkService(ctx, config)
  // The effect owns the domain handle. Its disposer is awaited by Cordis, so
  // unloading waits for the storage write chain to drain before releasing.
  ctx.effect(() => () => service.close(), 'dsh-daily-work: run domain')
  await service.open()
}

export { WorkService } from './host.ts'
export type { WorkServiceConfig } from './host.ts'
