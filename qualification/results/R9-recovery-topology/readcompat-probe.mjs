// Read-compat probe: a store written by the PRE-change schema (with `epoch`)
// opened by the POST-change schema (without it). Runs the REAL domain stack.
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import * as storageJsonPlugin from '@deepseek-ai/dsh-storage-json'
import * as storageDomainPlugin from '@deepseek-ai/dsh-storage-domain'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WorkService } from './src/host.ts'

const root = mkdtempSync(join(tmpdir(), 'r9-readcompat-'))
const ctx = new Context()
await ctx.plugin(Storage, {})
await ctx.plugin(storageJsonPlugin, { root })
await ctx.plugin(storageDomainPlugin, { backend: 'json' })
const svc = new WorkService(ctx, { targetChildren: 4, maxDepth: 1, budgetCeiling: 100, currency: 'USD', priceVersion: 'p' })
await svc.open()
await svc.createRun({ runId: 'r1', root: { session: { header: { id: 'root' } } }, authorizationRef: 'a' })
await svc.close()

// Inject the OLD key, as a pre-change build would have written it.
const unit = join(root, 'dsh_daily_work.json')
const doc = JSON.parse(readFileSync(unit, 'utf8'))
doc.tables.runs.r1.epoch = 1
writeFileSync(unit, JSON.stringify(doc), 'utf8')
console.log('injected legacy key: epoch =', JSON.parse(readFileSync(unit,'utf8')).tables.runs.r1.epoch)

const ctx2 = new Context()
await ctx2.plugin(Storage, {})
await ctx2.plugin(storageJsonPlugin, { root })
await ctx2.plugin(storageDomainPlugin, { backend: 'json' })
const svc2 = new WorkService(ctx2, { targetChildren: 4, maxDepth: 1, budgetCeiling: 100, currency: 'USD', priceVersion: 'p' })
try {
  await svc2.open()
  const rec = svc2.getRun('r1')
  console.log('RESULT: opened OK; runId =', rec?.runId, '| has epoch key =', Object.hasOwn(rec ?? {}, 'epoch'))
} catch (e) {
  console.log('RESULT: open REJECTED ->', e?.code ?? e?.message)
} finally {
  await svc2.close().catch(()=>{})
  await ctx.fiber.dispose()
  await ctx2.fiber.dispose()
}
