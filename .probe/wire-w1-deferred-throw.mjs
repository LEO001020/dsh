/**
 * W1: `inject: []` on the plugin, an ASYNC apply that waits for the dependency
 * through a deferred resolved by `ctx.inject`'s callback, and then THROWS from
 * apply's OWN body — so the rejection belongs to apply's promise (the entry's
 * own fiber) rather than to a discarded child fiber.
 */
export const name = 'wire-w1-deferred-throw'
export const inject = []
export async function apply(ctx) {
  const ready = new Promise((resolve) => {
    const existing = ctx.get('sandboxPolicy')
    if (existing !== undefined) return resolve(existing)
    ctx.inject(['sandboxPolicy'], () => { resolve(ctx.get('sandboxPolicy')) })
  })
  await ready
  throw new Error('W1-DEFERRED-THROW-MARKER')
}
