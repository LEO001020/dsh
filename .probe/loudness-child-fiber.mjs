/**
 * A probe row that registers its check in a CHILD fiber via `ctx.inject` and
 * DISCARDS the fiber — the shape `no-sandbox-contract`'s startup boundary uses.
 *
 * The subject is whether that shape is loud: the callback throws once the named
 * service appears, and the question is whether the ENTRY ends up FAILED (listed
 * in the activation audit) or ACTIVE (silent).
 */
export const name = 'loudness-child-fiber'
export const inject = []
export function apply(ctx) {
  ctx.inject(['agentPresets'], () => {
    throw new Error('CHILD-FIBER-THROW-MARKER')
  })
}
