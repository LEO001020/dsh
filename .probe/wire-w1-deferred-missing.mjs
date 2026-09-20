/**
 * W1 hazard arm: the deferred waits for a service that NEVER mounts. The
 * question is whether apply's never-settling promise hangs the boot.
 */
export const name = 'wire-w1-deferred-missing'
export const inject = []
export async function apply(ctx) {
  await new Promise((resolve) => {
    ctx.inject(['serviceThatNeverMounts'], () => { resolve(undefined) })
  })
}
