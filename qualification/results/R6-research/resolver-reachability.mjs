// Verify production reachability of the ported web-search row through the REAL
// profile resolver, and record which search provider the composed `web` row
// actually selects. Reading cordis.patch.yml is NOT the check: the row could be
// present and still not be the selected provider, or present in a bundle whose
// patch never loads.
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const SRC = 'D:/DSH/src/dsh-src'
const mod = await import(pathToFileURL(join(SRC, 'packages/boot/app-boot/lib/index.js')).href)
const { loadProfile, composeEntries } = mod

const HOME = process.env.DSH_HOME
const installAnchor = join(SRC, 'apps/cli/package.json')
const profile = loadProfile('dsh', 'daily-candidate', installAnchor, HOME)

console.log('=== BUNDLE LAYERS (resolved by the real resolver) ===')
for (const layer of profile.layers) {
  console.log(`  ${layer.packageName}`)
  console.log(`      dir=${layer.packageDir}`)
  console.log(`      patch=${layer.patchPath} exists=${existsSync(layer.patchPath)}`)
}
console.log(`  profile own patch: ${profile.patchPath} (${profile.patches.length} entries)`)

const entries = composeEntries([...profile.layers.map(l => l.patches), profile.patches])
console.log(`\n=== COMPOSED ENTRIES (${entries.length}) ===`)
const row = entries.find(e => e.id === 'daily-web-search')
console.log('daily-web-search row:', JSON.stringify(row, null, 1))
const web = entries.find(e => e.id === 'web')
console.log('web row:', JSON.stringify(web, null, 1))

// The decisive question: with our provider mounted, does the seam select it?
console.log('\n=== SELECTION ===')
console.log('web.searchProvider =', JSON.stringify(web?.config?.searchProvider ?? null))
console.log('our provider id    =', JSON.stringify(row?.config?.id ?? null))
const selected = web?.config?.searchProvider
const ours = row?.config?.id
console.log(selected === ours
  ? 'MATCH: the composed seam selects the ported provider'
  : `MISMATCH: the seam selects ${String(selected)}, not ${String(ours)}`)

const named = entries.filter(e => e.id === 'web-search-deepseek')
console.log('shipped deepseek provider row present:', named.length > 0)
