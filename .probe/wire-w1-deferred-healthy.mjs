/** W1 control: the same deferred wiring on a HEALTHY check must stay quiet. */
export const name = 'wire-w1-deferred-healthy'
export const inject = []
export async function apply(ctx) {
  const ready = new Promise((resolve) => {
    const existing = ctx.get('sandboxPolicy')
    if (existing !== undefined) return resolve(existing)
    ctx.inject(['sandboxPolicy'], () => { resolve(ctx.get('sandboxPolicy')) })
  })
  await ready
}
