// R9 product-tier probe — the "which build did you measure" proof for the AFTER
// state. It must be COPIED INTO THE PACKAGE before running, because bare
// specifiers (`@deepseek-ai/*`) resolve from the importing file's directory, not
// from cwd — so a copy run from this evidence directory cannot resolve them:
//
//   cd D:/DSH/work/wt-r9/packages/dsh-daily-work
//   cp ../../qualification/results/R9-recovery-topology/product-probe.mjs ./r9-product-probe.mjs
//   node --import tsx ./r9-product-probe.mjs
//   rm ./r9-product-probe.mjs
//
// It imports the WorkService from a path built from cwd, so the probe measures
// the tree it was pointed at rather than the directory it lives in; it boots the
// real storage stack, creates a run, and prints the record's field set and the
// domain's table set. The claims it checks:
//   - the run record carries no `epoch`;
//   - the work domain has exactly one table (`runs`), i.e. no
//     `dsh_daily_work_refusals`.
//
// Archived output: `product-probe.txt`.
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import * as storageJsonPlugin from '@deepseek-ai/dsh-storage-json'
import * as storageDomainPlugin from '@deepseek-ai/dsh-storage-domain'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

// Resolved from cwd, so a run from the wrong directory fails loudly instead of
// silently measuring a different tree.
const hostPath = resolve(process.cwd(), 'src', 'host.ts')
const host = await import(pathToFileURL(hostPath).href)
console.log('measured source:', hostPath)

const root = mkdtempSync(join(tmpdir(), 'r9-prod-'))
const ctx = new Context()
await ctx.plugin(Storage, {})
await ctx.plugin(storageJsonPlugin, { root })
await ctx.plugin(storageDomainPlugin, { backend: 'json' })
const svc = new host.WorkService(ctx, {
  targetChildren: 4, maxDepth: 1, budgetCeiling: 100, currency: 'USD', priceVersion: 'p',
})
await svc.open()
const rec = await svc.createRun({
  runId: 'r1', root: { session: { header: { id: 'root' } } }, authorizationRef: 'a',
})
console.log('run keys:', Object.keys(rec).sort().join(','))
console.log('has epoch:', Object.hasOwn(rec, 'epoch'))
console.log('domain tables:', Object.keys(host.workDomainSpec.tables).join(','))
await svc.close()
await ctx.fiber.dispose()
