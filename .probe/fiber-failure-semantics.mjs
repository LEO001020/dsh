/**
 * What does a throw inside `ctx.inject(...)`'s CHILD fiber do to the PARENT
 * entry — and is it LOUD at process level?
 *
 * WHY THIS IS MEASURED RATHER THAN READ. `apply()` registers the startup
 * boundary as `ctx.inject(['sandboxPolicy'], cb)`. That creates a CHILD fiber,
 * not the entry's own fiber, and DSH's activation audit (`inactiveEntries`)
 * classifies by the ENTRY's fiber state. So "the guard refuses at startup" and
 * "the deployment fails loudly" are two DIFFERENT claims, and the second is the
 * one the exit criterion names. The three shapes a throw can take have
 * different consequences, so all three are measured here.
 *
 * NO BOOT, NO CHILD PROCESS, NO CPU LOAD: this is an in-process cordis probe.
 */
import { Context, FiberState } from '@deepseek-ai/cordis'

const name = v => Object.entries(FiberState).find(([, s]) => s === v)?.[0] ?? String(v)
const results = {}

/** Capture unhandled rejections for one arm, since that is how DSH's `installFailLoud` sees a late failure. */
async function arm(label, body) {
  const seen = []
  const onU = e => { seen.push(e instanceof Error ? e.message : String(e)) }
  process.on('unhandledRejection', onU)
  try {
    const { fiber, ctx } = await body()
    await new Promise(r => setTimeout(r, 250))
    results[label] = {
      parentEntryFiberState: name(fiber.state),
      // The two states DSH's audit treats as failures: FAILED is reported with
      // its error; PENDING is reported as "waiting for services".
      auditedAsFailure: fiber.state === FiberState.FAILED || fiber.state === FiberState.PENDING,
      unhandledRejections: seen,
      awaitsThrows: await fiber.await().then(() => false, e => e instanceof Error ? e.message : String(e)),
    }
    await ctx.fiber.dispose()
  } catch (error) {
    results[label] = { probeThrew: error instanceof Error ? error.message : String(error) }
  } finally {
    process.off('unhandledRejection', onU)
  }
}

await arm('A-child-fiber-throws', () => {
  const ctx = new Context()
  const fiber = ctx.plugin({ name: 'parent-a', inject: [], apply(c) {
    c.inject(['svc'], () => { throw new Error('guard refused at startup') })
  } })
  ctx.provide('svc', {})
  return { fiber, ctx }
})

await arm('B-child-fiber-rejects-async', () => {
  const ctx = new Context()
  const fiber = ctx.plugin({ name: 'parent-b', inject: [], apply(c) {
    c.inject(['svc'], async () => { throw new Error('guard refused at startup (async)') })
  } })
  ctx.provide('svc', {})
  return { fiber, ctx }
})

await arm('C-apply-throws-sync', () => {
  const ctx = new Context()
  const fiber = ctx.plugin({ name: 'parent-c', inject: [], apply() { throw new Error('guard refused in apply') } })
  return { fiber, ctx }
})

await arm('D-control-healthy-child', () => {
  const ctx = new Context()
  const fiber = ctx.plugin({ name: 'parent-d', inject: [], apply(c) {
    c.inject(['svc'], () => { /* healthy */ })
  } })
  ctx.provide('svc', {})
  return { fiber, ctx }
})

console.log(JSON.stringify(results, null, 1))
