// T7: is the native-call bridge WIRED into the product?
//
// Measured from the IMPORT GRAPH on disk, not from a doc comment. A module with
// no production importer cannot run in the shipped profile, so "the seam is
// correct" and "the product uses it" are two different facts and this script
// separates them.
//
// Bound to named directories and capped depth, per this machine's CPU rules.
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = process.argv[2] ?? 'D:/DSH/work/dsh-native-daily'
const PKGS = join(ROOT, 'packages')
const SKIP = new Set(['node_modules', 'lib', '.git', '.ipython-kernels', '.probe', 'dist'])

function walk(dir, depth, acc) {
  if (depth > 6) return acc
  let entries
  try { entries = readdirSync(dir) } catch { return acc }
  for (const e of entries) {
    if (SKIP.has(e)) continue
    const p = join(dir, e)
    let st
    try { st = statSync(p) } catch { continue }
    if (st.isDirectory()) walk(p, depth + 1, acc)
    else if (/[.](ts|mjs|js|yml|yaml|json)$/.test(e)) acc.push(p)
  }
  return acc
}

const rel = p => p.slice(ROOT.length).replace(/[\\/]+/g, '/').replace(/^\//, '')
const files = walk(PKGS, 0, [])
const read = f => { try { return readFileSync(f, 'utf8') } catch { return '' } }

// A module importer is `from '.../name'` or `import('.../name')`.
const importers = (name) => files.filter(f =>
  new RegExp(String.raw`(from|import)\s*\(?\s*['"][^'"]*${name}([.]ts)?['"]`).test(read(f)),
).map(rel)

const report = {
  root: ROOT,
  filesScanned: files.length,
  bridgeModuleImporters: importers('bridge'),
  nativeCallModuleImporters: importers('native-call'),
  // The symbols that would prove a production wiring, by name.
  symbolCallSites: {},
}
for (const symbol of ['createNativeCallHandler', 'new BridgeServer', 'mintLease', 'renderBridgePreamble', 'canPrependPreamble']) {
  report.symbolCallSites[symbol] = files
    .filter(f => read(f).includes(symbol))
    .map(rel)
}

// Three classes, and the partition is the measurement.
//
//   ENTRY    -- declared in package.json `exports`, so a profile can load it.
//   PROBE    -- a hand-run measurement driver (`t*-measure.ts`). It drives the
//               subject to produce numbers. Counting one as a caller would turn
//               the wiring verdict red for a probe and hide the fact it exists
//               to report, so probes are named explicitly rather than filtered
//               by a heuristic.
//   TEST     -- a vitest file. Proven-but-unwired.
//
// Anything in NONE of the three that names a bridge symbol IS a real caller and
// would be the finding this probe exists to detect.
const isTest = p => /[.]test[.]ts$/.test(p)
const isProbe = p => /(^|\/)t\d+-measure[.]ts$/.test(p)
const isEntry = p => /(host-plugin|ipython-tool|kernel|kernel-plugin|protocol)[.]ts$/.test(p)

const classify = list => list.filter(p => !isTest(p) && !isProbe(p) && !isEntry(p))

report.classes = {
  entryFiles: files.map(rel).filter(isEntry),
  probeFiles: files.map(rel).filter(isProbe),
  testFilesNamingBridge: files.map(rel).filter(p => isTest(p) && (read(join(ROOT, p)).includes('BridgeServer') || read(join(ROOT, p)).includes('createNativeCallHandler'))),
}

// The verdict. `new BridgeServer` is the constructor: the one call that STARTS
// a bridge. Zero real callers means no bridge is ever started in the product.
report.verdict = {
  productionCallSites: Object.fromEntries(
    Object.entries(report.symbolCallSites).map(([k, v]) => [k, classify(v)]),
  ),
  productionImportersOfBridge: classify(report.bridgeModuleImporters),
  productionImportersOfNativeCall: classify(report.nativeCallModuleImporters),
}
report.verdict.bridgeIsStartedInProduction =
  report.verdict.productionCallSites['new BridgeServer'].length > 0

console.log(JSON.stringify(report, null, 2))
