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
/**
 * The services this plugin needs before it may activate.
 *
 * `subprocess` is the broker's process seam. `tools` is the REGISTRY THE BRIDGE
 * DISPATCHES THROUGH, and it is here because a `ctx.tools` read from a context
 * that did not inject it throws:
 *
 *     BridgeError: BRIDGE_FAILED: cannot get property "tools" without inject
 *
 * WHY THIS IS NOT REDUNDANT WITH THE TOOL ROW'S OWN `inject = ['tools']`. A tool
 * row's inject gates that ROW; this gates the SERVICE, and they are different
 * fibers. The service is constructed with the context this `apply` receives, and
 * `native-call.ts` reaches `ctx.tools.execute(...)` through the SERVICE's
 * context -- so without `tools` here, every cell's `dsh.call` fails while the
 * `ipython` tool itself still resolves and runs.
 *
 * MEASURED, not reasoned: the composition-tier probe
 * (`qualification/runners/r5-bridge-product.mjs`) found this on the first real
 * boot, with exactly that message, AFTER the code-path tests had passed 17/17.
 * Those tests hand the service a context that mounted `ToolRuntime` directly, so
 * the mechanism worked in every test while the PRODUCT failed on the first real
 * cell -- the F2 defect shape one layer down, and the reason the composition
 * tier exists as a separate instrument from the code-path tier.
 */
export const inject = ['subprocess', 'tools']

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
