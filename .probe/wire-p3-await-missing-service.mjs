/**
 * P3: async apply AWAITS a child fiber whose dependency NEVER mounts.
 *
 * The question is whether that hangs the boot: the entry's `_initTask` is the
 * apply promise, `EntryTree.getTasks()` includes it, and `loader.await()` loops
 * on those tasks — so an apply that never resolves could stop the process from
 * ever reaching its settled state. This is the `toolCount: 0` shape, where a
 * reportable degradation must not become an unbounded wait.
 */
export const name = 'wire-p3-await-missing-service'
export const inject = []
export async function apply(ctx) {
  await ctx.inject(['serviceThatNeverMounts'], () => { /* never reached */ })
}
