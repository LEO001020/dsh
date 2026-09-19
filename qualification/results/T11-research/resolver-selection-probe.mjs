// T11 INDEPENDENT RE-VERIFICATION of the two claims R6 recorded:
//   1. the `daily-web-search` row IS composed (the port is reachable), and
//   2. the composed `web` row does NOT select it.
// Reading cordis.patch.yml is not the check -- the row could compose and still
// not be selected, or compose in a bundle whose patch never loads. So this goes
// through the REAL `loadProfile` / `composeEntries` from the pinned checkout,
// against a THROWAWAY $DSH_HOME whose profile lists dsh-daily-work among its
// bundles. No repo file is written and no DSH_HOME outside the temp dir is read.
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const SRC = 'D:/DSH/src/dsh-src'
const mod = await import(pathToFileURL(join(SRC, 'packages/boot/app-boot/lib/index.js')).href)
const { loadProfile, composeEntries } = mod

const HOME = process.env.DSH_HOME
const installAnchor = join(SRC, 'apps/cli/package.json')
const profile = loadProfile('dsh', 'daily-candidate', installAnchor, HOME)

console.log('DSH_HOME =', HOME)
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
console.log('daily-web-search row present:', row !== undefined)
if (row !== undefined) console.log(JSON.stringify(row, null, 1))

const web = entries.find(e => e.id === 'web')
console.log('web row:', JSON.stringify(web, null, 1))

console.log('\n=== SELECTION ===')
const selected = web?.config?.searchProvider
const ours = row?.config?.id
console.log('web.searchProvider =', JSON.stringify(selected ?? null))
console.log('our provider id    =', JSON.stringify(ours ?? null))
console.log(selected === ours
  ? 'MATCH: the composed seam selects the ported provider'
  : `MISMATCH: the seam selects ${String(selected)}, not ${String(ours)}`)

// The decisive observable: is the id the composed web row names actually the id
// of a row that is ALSO composed? If not, the selection names a provider that
// must come from somewhere else entirely.
const named = entries.filter(e => e.id === 'web-search-deepseek')
console.log('\nshipped deepseek provider row(s):', named.length)
for (const n of named) console.log('  ', JSON.stringify({ id: n.id, name: n.name, config: n.config }))

// And where does the selection VALUE come from? Recorded so the finding is
// attributable to a file rather than to "the deployment".
console.log('\n=== PROVENANCE OF THE SELECTION VALUE ===')
for (const layer of profile.layers) {
  const raw = (await import('node:fs')).readFileSync(layer.patchPath, 'utf8')
  if (raw.includes('searchProvider')) {
    console.log(`  ${layer.packageName}: ${layer.patchPath} CONTAINS searchProvider`)
  }
}
