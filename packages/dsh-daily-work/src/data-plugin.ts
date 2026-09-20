/**
 * The host-profile entry point for the data-plane extension.
 *
 * WHY A SEPARATE PLUGIN ROW
 *
 * The data plane must be reachable from a REAL composed profile, not only from a
 * test that mounts it directly. This project has three recorded instances of a
 * module that passed its own tests while the product never loaded it, so the
 * service is registered by a `cordis.patch.yml` row and the profile-resolver
 * probe asserts `ctx.dailyData` is present on a real boot.
 *
 * SHAPE
 *
 * The same shape as `host-plugin.ts`, for the same measured reason: an `async
 * apply` that returns only after the service is genuinely usable. A plain
 * synchronous `apply` that kicks off `open()` inside `ctx.effect()` would return
 * before the reference domain is open, and a caller resolving `ctx.dailyData`
 * immediately afterwards would hold a live service whose domain was still
 * opening.
 */
import type { Context } from '@deepseek-ai/cordis'
import { DataPlaneService, type DataServiceConfig } from './data-service.ts'

export const name = 'dsh-daily-data'
/**
 * `attachments` is a HARD requirement, not a wish list.
 *
 * The data plane stores bytes through the public `ctx.attachments` capability
 * instead of deep-importing a provider's source path (defect F4). `inject` is a
 * readiness gate, so naming it here means this row activates only once the
 * composition has actually mounted an attachment provider -- and if a deployment
 * removed that row, the failure is a visible "waiting for services (missing:
 * attachments)" rather than a data plane that boots and then fails on its first
 * capture. The provider is a base-bundle row (`attachment-local`), so this adds no
 * new deployment obligation.
 */
export const inject = ['storageDomain', 'attachments']

/** Configuration. Every field is optional; the service supplies real defaults. */
export interface Config extends DataServiceConfig {}

/**
 * Mount the data-plane service and return after its reference domain is open.
 *
 * @param ctx - the host context that owns this extension.
 * @param config - the deployment's artifact root and quota.
 */
export async function apply(ctx: Context, config: Config = {}): Promise<void> {
  const service = new DataPlaneService(ctx, config)
  // The effect owns the domain handle, so unloading waits for the reference write
  // chain to drain before releasing -- the same discipline `host-plugin.ts` uses.
  ctx.effect(() => () => service.close(), 'dsh-daily-data: reference domain')
  await service.open(ctx.storageDomain)
}

export { DataPlaneService, DATA_DOMAIN_NAME, dataDomainSpec, StorageReferenceLog } from './data-service.ts'
export type { DataServiceConfig } from './data-service.ts'
