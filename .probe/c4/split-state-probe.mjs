/**
 * C4: the split-state consequence, measured rather than argued.
 *
 * THE CLAIM TO TEST. The deep import's second reason for being a defect is that it
 * created a SECOND PHYSICAL MODULE INSTANCE of the attachment provider, so the
 * module-scope `const durableHomes = new Set<string>()` was split between two copies.
 * The product now imports the public seam package instead, so the claim to verify is
 * that the host holds ONE instance of the provider's store body.
 *
 * HOW TO MEASURE IT WITHOUT REACHING INTO A PRIVATE MODULE.
 *
 * The naive instrument is "import `lib/types/store.js` twice and compare" -- but that
 * would itself create module instances, and a probe that creates the thing it is
 * measuring proves nothing. The same mistake in the other direction is to read the
 * provider's `src/`, which is the defect under test.
 *
 * So this measures the FILES ON DISK and the RESOLUTIONS THE BOOT ACTUALLY MADE:
 *
 *   1. How many physical files inside the provider's BUILT tree declare
 *      `durableHomes`? If the entry inlines its copy of `lib/types/store.js`, that is
 *      two files carrying one piece of module-scope state, and the question becomes
 *      which of them the loader was asked for.
 *   2. From the boot's own unfiltered resolution record: which of those files did the
 *      host actually resolve? A file that is never resolved cannot hold a live second
 *      instance.
 *
 * That is an instrument over two artifacts neither of which is the thing it
 * measures, which is the property the earlier attempts lacked.
 *
 * Usage: node .probe/c4/split-state-probe.mjs <graph-all.jsonl>
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const DSH_SRC = process.env.DSH_SRC_ROOT ?? 'D:/DSH/src/dsh-src'
const PROVIDER = join(DSH_SRC, 'packages', 'attachment', 'attachment-local')
const graphPath = process.argv[2]
if (graphPath === undefined) throw new Error('usage: node split-state-probe.mjs <graph-all.jsonl>')

/**
 * Every source file under `dir` whose text contains `needle`.
 *
 * THE EXTENSION SET IS NOT `.js` ALONE, and getting this wrong produced a WRONG
 * ANSWER in the first version of this probe. The BEFORE case's second live instance
 * was `src/store.ts` -- a `.ts` file -- so a `.js`-only walk found two built copies,
 * counted one as resolved, and reported "1 live instance" for BOTH the before and
 * after boots. The probe was blind to exactly the defect it exists to detect, and it
 * reported a confident number while being blind. `.ts`, `.mts`, `.cts` and `.js` are
 * all files this provider ships and all of them can be resolved.
 */
const SOURCE_EXTENSIONS = ['.js', '.mjs', '.cjs', '.ts', '.mts', '.cts']

function filesDeclaring(dir, needle, out = []) {
  if (!existsSync(dir)) return out
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) filesDeclaring(full, needle, out)
    else if (SOURCE_EXTENSIONS.some(ext => entry.name.endsWith(ext))) {
      const text = readFileSync(full, 'utf8')
      if (text.includes(needle)) out.push({ file: full.replace(/\\/g, '/'), occurrences: text.split(needle).length - 1, bytes: statSync(full).size })
    }
  }
  return out
}

const rows = readFileSync(graphPath, 'utf8').split('\n').filter(l => l.trim() !== '').map(l => JSON.parse(l))
const resolvedUrls = new Set(rows.map(r => String(r.url)))

// SCAN THE WHOLE PROVIDER, `src/` INCLUDED, and that is load-bearing. The BEFORE
// case's second live instance was the provider's SOURCE file, reached through the
// `./src/*` export. A scan restricted to `lib/` would report "2 copies, 1 resolved"
// for BOTH the before and after boots and would therefore be blind to exactly the
// defect it exists to detect -- the mistake of looking only where the answer is
// expected to be.
const declaring = [
  ...filesDeclaring(join(PROVIDER, 'lib'), 'durableHomes').map(f => ({ ...f, plane: 'BUILT' })),
  ...filesDeclaring(join(PROVIDER, 'src'), 'durableHomes').map(f => ({ ...f, plane: 'SOURCE' })),
]
const resolvedProviderFiles = [...resolvedUrls].filter(u => u.includes('attachment-local/'))

console.log('=== every file in the provider carrying the module-scope `durableHomes` ===')
for (const f of declaring) {
  const resolved = resolvedUrls.has(`file:///${f.file}`)
  console.log(`  [${f.plane}] ${f.file}`)
  console.log(`      bytes=${String(f.bytes)}  occurrences=${String(f.occurrences)}  RESOLVED BY THE BOOT=${String(resolved)}`)
}
console.log()
console.log('=== every physical attachment-local file the boot resolved ===')
for (const u of resolvedProviderFiles) console.log(`  ${u}`)
console.log()

// The claim, as a boolean with its evidence attached.
const resolvedCopies = declaring.filter(f => resolvedUrls.has(`file:///${f.file}`))
const srcResolved = [...resolvedUrls].some(u => u.includes('attachment-local/src/'))

console.log('=== VERDICT ===')
console.log(`  files in the provider carrying module-scope \`durableHomes\` : ${String(declaring.length)}`)
console.log(`  of those, RESOLVED by this boot                             : ${String(resolvedCopies.length)}`)
for (const f of resolvedCopies) console.log(`      [${f.plane}] ${f.file}`)
console.log(`  any attachment-local/src/ file resolved                     : ${String(srcResolved)}`)
console.log(`  => the host holds ${String(resolvedCopies.length)} live instance(s) of that module-scope state`)

