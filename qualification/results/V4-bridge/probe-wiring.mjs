// V4: is the native-call bridge WIRED into the product? (re-measured at identity 0a0996f3)
//
// WHY THIS IS NOT T7's FILE, RE-RUN. T7's `probe-wiring.mjs` classifies hand-run
// measurement drivers with the pattern `t\d+-measure.ts`. This gate's driver is
// `src/v4-bridge-probe.ts`, which that pattern does NOT match, so running T7's
// probe unmodified would list a PROBE as a production caller of `new
// BridgeServer` -- a false positive in the direction that hides the defect. The
// classifier is therefore restated here with an explicit probe list rather than
// the probe file being renamed to fit a pattern (renaming to make a detector
// quiet is the move this project keeps recording as a defect).
//
// WHAT IT MEASURES. Two independent facts:
//   1. The symbol-level call sites of every bridge entry point, partitioned into
//      ENTRY / PROBE / TEST. Anything in NONE of the three IS a real caller.
//   2. The module importers of `bridge.ts` and `native-call.ts`, same partition.
//
// WHAT IT DOES NOT DO. It does not decide whether an unreachable module SHOULD be
// reachable. That is a product question; the companion
// `qualification/runners/import-graph.mjs` answers the compiler-based half.
//
// Bounded to named directories with a depth cap, per this machine's CPU rules.
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

const importers = (name) => files.filter(f =>
  new RegExp(String.raw`(from|import)\s*\(?\s*['"][^'"]*${name}([.]ts)?['"]`).test(read(f)),
).map(rel)

const report = {
  root: ROOT,
  filesScanned: files.length,
  bridgeModuleImporters: importers('bridge'),
  nativeCallModuleImporters: importers('native-call'),
  symbolCallSites: {},
}
for (const symbol of ['createNativeCallHandler', 'new BridgeServer', 'mintLease', 'renderBridgePreamble', 'canPrependPreamble']) {
  report.symbolCallSites[symbol] = files
    .filter(f => read(f).includes(symbol))
    .map(rel)
}

// The three non-caller classes, named EXPLICITLY.
const isTest = p => /[.]test[.]ts$/.test(p)
// Every hand-run measurement driver in this package, by exact path. A driver
// constructs the subject to produce numbers; it is not a product call site.
const PROBE_FILES = new Set([
  'packages/dsh-ipython/src/t7-measure.ts',
  'packages/dsh-ipython/src/v4-bridge-probe.ts',
])
const isProbe = p => PROBE_FILES.has(p)
const isEntry = p => /(host-plugin|ipython-tool|kernel|kernel-plugin|protocol)[.]ts$/.test(p)

const classify = list => list.filter(p => !isTest(p) && !isProbe(p) && !isEntry(p))

report.classes = {
  entryFiles: files.map(rel).filter(isEntry),
  probeFiles: files.map(rel).filter(isProbe),
  testFilesNamingBridge: files.map(rel).filter(p => isTest(p)
    && (read(join(ROOT, p)).includes('BridgeServer') || read(join(ROOT, p)).includes('createNativeCallHandler'))),
}

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
