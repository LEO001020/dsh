/** P1: async apply AWAITS the child fiber, whose callback throws. */
export const name = 'wire-p1-await-child-throws'
export const inject = []
export async function apply(ctx) {
  await ctx.inject(['agentPresets'], () => { throw new Error('P1-CHILD-THROW-MARKER') })
}
