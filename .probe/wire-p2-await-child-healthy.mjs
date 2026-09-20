/** P2: async apply AWAITS the child fiber, whose callback is healthy. */
export const name = 'wire-p2-await-child-healthy'
export const inject = []
export async function apply(ctx) {
  await ctx.inject(['agentPresets'], () => { /* healthy */ })
}
