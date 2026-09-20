/**
 * V10 reachability check: which RES/OBS production paths are reachable from the
 * product, and which are only reachable from tests.
 *
 * WHY THIS IS A SEPARATE INSTRUMENT. Three of the cases in this slice turn on a
 * NEGATIVE reachability claim -- RES-02 ("the tier vocabulary cannot express
 * primary_read or understood"), OBS-01 ("the cache never hits"), and the
 * `dailyHistory` consumer question. A negative claim about reachability is
 * exactly the claim this project has retracted three times (G-FIX-04, G-FIX-05,
 * G-FIX-06), so it is measured rather than asserted.
 *
 * THE METHOD, and its limits. For each module of interest this walks the
 * repository's own `.ts`/`.mjs`/`.js` sources under two NAMED directories
 * (`packages/`, `qualification/runners/`), NOT a drive root, and reports every
 * file that imports the module. Test files and build output are classified
 * separately, because "only a test imports it" and "the product imports it" are
 * different facts.
 *
 * WHAT IT DOES NOT DO. It does not resolve re-exports transitively through
 * package boundaries: it reports DIRECT importers, which is the conservative
 * direction (a module with only test importers is reported as such). The
 * composed-profile reachability is measured separately, in the boot probes.
 *
 * Run: node qualification/results/V10-research-obs/probe-reachability.mjs
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const REPO = 'D:/DSH/work/dsh-native-daily'
/** Named roots only. Never a drive root, and the walk is depth-capped. */
const ROOTS = [
  { dir: `${REPO}/packages`, maxDepth: 4 },
  { dir: `${REPO}/qualification/runners`, maxDepth: 1 },
]

/** The modules whose reachability this slice's cases depend on. */
const TARGETS = [
  { id: 'history-plane', needle: 'history-plane', claim: 'the M7 history plane implementation' },
  { id: 'history-plugin', needle: 'history-plugin', claim: 'the M7 plugin entry point (the profile row)' },
  { id: 'web-provenance', needle: 'web-provenance', claim: 'the M7 provenance/locator implementation' },
  { id: 'web-search', needle: 'web-search', claim: 'the ported web-search provider' },
  { id: 'observations', needle: 'observations', claim: 'the observation capture module' },
  { id: 'recovery', needle: 'recovery.ts', claim: 'the recovery module' },
  { id: 'reconcile', needle: 'reconcile.ts', claim: 'the reconcile module' },
]

const out = []
const say = line => { out.push(line); console.log(line) }

/** Collect source files under one named root, depth-capped. */
function collect(dir, maxDepth, depth = 0) {
  const found = []
  let entries
  try { entries = readdirSync(dir) } catch { return found }
  for (const entry of entries) {
    if (entry === 'node_modules' || entry === 'lib' || entry === '.git' || entry === '__pycache__') continue
    const path = join(dir, entry)
    let info
    try { info = statSync(path) } catch { continue }
    if (info.isDirectory()) {
      if (depth < maxDepth) found.push(...collect(path, maxDepth, depth + 1))
      continue
    }
    if (/\.(ts|mts|mjs|js)$/u.test(entry) && !entry.endsWith('.d.ts')) found.push(path)
  }
  return found
}

say('=== V10 reachability: which RES/OBS production paths the product actually imports ===')
say(`roots: ${ROOTS.map(root => `${root.dir} (depth <= ${String(root.maxDepth)})`).join(', ')}`)

const files = []
for (const root of ROOTS) {
  const batch = collect(root.dir, root.maxDepth)
  say(`  ${root.dir}: ${String(batch.length)} source files`)
  files.push(...batch)
}
say(`total files scanned: ${String(files.length)}`)

// An EMPTY TRAVERSAL IS A TRAP (a loop over zero elements passes vacuously), so
// the count is asserted here rather than assumed.
if (files.length === 0) {
  say('')
  say('STOP: the traversal found ZERO files. Every negative below would be vacuous.')
  process.exitCode = 1
}

say('')
say('--- direct importers, per target ---')
for (const target of TARGETS) {
  const hits = []
  for (const path of files) {
    const text = readFileSync(path, 'utf8')
    // Only IMPORT-EDGE occurrences count. A file that merely MENTIONS the name
    // (a comment, a docs string) is not an importer, and counting mentions is how
    // a reachability claim gets inflated.
    const isImporter = new RegExp(`(?:from|import)\\s*['"\`][^'"\`]*${target.needle.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}[^'"\`]*['"\`]`, 'u').test(text)
      || new RegExp(`import\\(\\s*['"\`][^'"\`]*${target.needle.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}`, 'u').test(text)
    if (isImporter) hits.push(relative(REPO, path).replace(/\\/gu, '/'))
  }
  const tests = hits.filter(path => /\.test\.(?:ts|mts|js|mjs)$/u.test(path))
  const production = hits.filter(path => !/\.test\.(?:ts|mts|js|mjs)$/u.test(path))
  say('')
  say(`${target.id} (${target.claim})`)
  say(`  PRODUCTION importers (${String(production.length)}): ${JSON.stringify(production)}`)
  say(`  TEST importers       (${String(tests.length)}): ${JSON.stringify(tests)}`)
  say(`  reachable from a non-test path: ${String(production.length > 0)}`)
}

say('')
say('--- the dailyHistory service: what CALLS it ---')
// `dailyHistory` is a SERVICE NAME, not a module path: the question is whether any
// non-test source calls `ctx.dailyHistory.history(...)` or reaches the service.
const callers = []
for (const path of files) {
  const text = readFileSync(path, 'utf8')
  if (!text.includes('dailyHistory')) continue
  const rel = relative(REPO, path).replace(/\\/gu, '/')
  const callsHistory = /dailyHistory\s*[?]?\.\s*history\s*\(/u.test(text)
  const getsService = /get\(\s*['"`]dailyHistory['"`]\s*\)/u.test(text)
  callers.push({ path: rel, isTest: /\.test\./u.test(rel), callsHistory, getsService })
}
for (const caller of callers) {
  say(`  ${caller.path}  test=${String(caller.isTest)}  get('dailyHistory')=${String(caller.getsService)}  .history(...)=${String(caller.callsHistory)}`)
}
const productionCallers = callers.filter(caller => !caller.isTest && caller.callsHistory)
say(`  PRODUCTION callers of .history(...): ${String(productionCallers.length)} ${JSON.stringify(productionCallers.map(c => c.path))}`)

say('')
say('--- the IPython broker protocol: could a host callback ride it? ---')
const protocol = readFileSync(`${REPO}/packages/dsh-ipython/src/protocol.ts`, 'utf8')
const opMatch = /export type BrokerOpName =([\s\S]*?)\n\n/u.exec(protocol)
say(`BrokerOpName members: ${JSON.stringify((opMatch?.[1] ?? '').split('|').map(part => part.trim().replace(/['"]/gu, '')).filter(Boolean))}`)
const msgMatch = /export type BrokerMessage =([^\n]*)/u.exec(protocol)
say(`BrokerMessage members: ${JSON.stringify(msgMatch?.[1] ?? null)}`)
const eventMatch = /export type BrokerEvent =([\s\S]*?)\n\n/u.exec(protocol)
say(`BrokerEvent members: ${JSON.stringify([...new Set((eventMatch?.[1] ?? '').match(/'[a-z_]+'/gu) ?? [])])}`)
say('  A host-callback message type would have to appear in one of those unions.')
const hasCallback = /host[_-]?callback|callback[_-]?request|tool[_-]?call/iu.test(protocol)
say(`  a host-callback / tool-call message type is present: ${String(hasCallback)}`)
