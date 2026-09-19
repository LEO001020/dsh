/**
 * The host-profile entry point for the IPython extension.
 *
 * WHY THIS FILE EXISTS SEPARATELY FROM `kernel-plugin.ts`. A package that exports
 * a service class but has no plugin entry point cannot be mounted by a profile:
 * the loader resolves a module and calls its `apply`. `kernel-plugin.ts` holds the
 * service (a thing tests and other host code import); this file holds the
 * ACTIVATION (a thing the profile resolver loads). Merging them would make the
 * service's module identity depend on the profile's loader calling conventions.
 *
 * THE DEFECT THIS SHAPE AVOIDS, quoted from this project's own record
 * (`docs/GAPS.md`, G-FIX-04):
 *
 *   "(1) the package had never been compiled — no `lib/`, so a resolver had
 *    nothing to load; (2) the package declared no `dsh.bundle.patch`, so
 *    `dsh plugin add` installed it as a plain dependency and activated no layer,
 *    meaning the plugin was never loaded at all while the test still passed."
 *
 * So this package declares `dsh.bundle.patch` in its `package.json`, ships
 * `cordis.patch.yml`, and is compiled to `lib/`. The bundle patch mounts the
 * SERVICE at host level; the `ipython` TOOL row belongs in an AGENT PRESET,
 * because a tool is agent-scoped and a host-level tool row would publish into the
 * root realm where no agent's scope would see it.
 *
 * The async `apply` shape is copied from `dsh-daily-work`'s host plugin for the
 * reason recorded there: a synchronous `apply` that kicks off async setup returns
 * before the service is genuinely available, and a caller that awaited
 * `ctx.plugin(...)` would then find a registered service that is not usable yet.
 */
import type { Context } from '@deepseek-ai/cordis'
import { KernelService, type KernelServiceConfig } from './kernel-plugin.ts'

export const name = 'dsh-ipython'
export const inject = ['subprocess']

/** Configuration. Every field is host-set and none is model-reachable. */
export interface Config extends KernelServiceConfig {}

/**
 * Mount the kernel service.
 *
 * @param ctx - the host context that owns this extension.
 * @param config - host-authorized interpreter, broker path and bounds.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  const service = new KernelService(ctx, config)
  // The effect owns the kernels. Its disposer is awaited by Cordis, so unloading
  // the plugin waits for every kernel and broker process to reach quiescence
  // instead of leaving them running with their namespaces resident.
  ctx.effect(() => () => service.close(), 'dsh-ipython: kernel registry')
}

export { KernelService } from './kernel-plugin.ts'
export type { KernelServiceConfig } from './kernel-plugin.ts'
