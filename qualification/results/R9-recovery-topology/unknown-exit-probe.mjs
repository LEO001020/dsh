// R9 falsification probe — the measurement that decided the corrected topology
// fact. Run it COPIED INTO THE PACKAGE (bare specifiers and the relative
// `./src/host.ts` resolve from the importing file's directory):
//
//   cd D:/DSH/work/wt-r9/packages/dsh-daily-work
//   cp ../../qualification/results/R9-recovery-topology/unknown-exit-probe.mjs ./r9-unknown-exit.mjs
//   node --import tsx ./r9-unknown-exit.mjs
//   rm ./r9-unknown-exit.mjs
//
// WHAT IT PROVES, and why it exists. An earlier version of TOPOLOGY.md claimed
// "no production call site targets a terminal state; the product never performs a
// terminal-state write", supported by a test whose state list OMITTED `unknown`.
// Root falsified that. This probe measures what the product ACTUALLY does:
//
//   1. a failing launch drives the task to `unknown` on the real drain path
//      (the same path the model-facing `work` tool uses, tools.ts:162);
//   2. the reservation stays held (`releaseReservation: false`);
//   3. NOTHING can move the task out of `unknown` — a re-drain is refused by
//      `admit` (host.ts:823-825) and `relaunchPrepared` refuses non-`prepared`
//      (recovery.ts:103-116).
//
// Point 3 is the corrected, stronger basis for the deletion: the product writes an
// in-flight state it has no path to leave, so no settlement — stale or current —
// has a state to resolve.
//
// Archived output: `unknown-exit-probe.txt`.
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import * as storageJsonPlugin from '@deepseek-ai/dsh-storage-json'
import * as storageDomainPlugin from '@deepseek-ai/dsh-storage-domain'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WorkService } from './src/host.ts'
import { relaunchPrepared } from './src/recovery.ts'

const root = mkdtempSync(join(tmpdir(), 'r9-unknown-exit-'))
const ctx = new Context()
await ctx.plugin(Storage, {})
await ctx.plugin(storageJsonPlugin, { root })
await ctx.plugin(storageDomainPlugin, { backend: 'json' })
const svc = new WorkService(ctx, {
  targetChildren: 4, maxDepth: 1, budgetCeiling: 100, currency: 'USD', priceVersion: 'p',
})
await svc.open()
await svc.createRun({ runId: 'r1', root: { session: { header: { id: 'root' } } }, authorizationRef: 'a' })

// 1. A port that FAILS -> the launch-failure arm at host.ts:1361.
svc.setLaunchPort({ async launch() { throw new Error('provider exploded') } })
const request = { taskId: 't1', childId: 'c1', prompt: 'p', reservedCost: 5 }
const first = await svc.drain('r1', [request], new AbortController().signal)
const afterFailure = svc.getRun('r1')
console.log('1. drain outcome      :', JSON.stringify(first))
console.log('   state              :', afterFailure.tasks.t1.state, '(expected: unknown)')
console.log('   reservation held   :', afterFailure.budget.reserved, '(expected: 5)')
console.log('   uncertainty        :', afterFailure.tasks.t1.uncertainty)

// 2. EXIT ATTEMPT — re-drain. `admit` refuses a slot-holding task.
const second = await svc.drain('r1', [request], new AbortController().signal)
console.log('2. re-drain           :', JSON.stringify(second))
console.log('   state              :', svc.getRun('r1').tasks.t1.state, '(expected: still unknown)')

// 3. EXIT ATTEMPT — relaunchPrepared, the kept recovery function.
const relaunch = await relaunchPrepared({
  service: svc,
  port: { async launch(r) { return { childId: r.childId } } },
  runId: 'r1', taskId: 't1', assignmentDigest: 'p', signal: new AbortController().signal,
})
console.log('3. relaunchPrepared   :', JSON.stringify(relaunch))
console.log('   state              :', svc.getRun('r1').tasks.t1.state, '(expected: still unknown)')
console.log('   reservation held   :', svc.getRun('r1').budget.reserved, '(expected: still 5)')

await svc.close()
await ctx.fiber.dispose()
