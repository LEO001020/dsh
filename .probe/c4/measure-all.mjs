/**
 * C4 independent ID-01 graph measurement.
 *
 * WHAT THIS ADDS OVER THE TWO INSTRUMENTS ALREADY ON DISK.
 *
 *   - `qualification/results/V1-identity/id01-graph-recorder.mjs` filters INSIDE the
 *     loader hook: only `specifier.startsWith('@deepseek-ai/')` is written. That is
 *     the right filter for the oracle's question, but it means the artifact can never
 *     show a specifier the filter did not match -- a blind spot that is invisible in
 *     the output because the output has no way to represent "not looked at".
 *   - This driver injects `.probe/c4/recorder-all.mjs`, which writes EVERY resolution
 *     and filters in the READER. The reader can then answer the oracle's question AND
 *     check the filter's own coverage: how many resolutions were written, how many
 *     carried an `@deepseek-ai/` specifier, and whether ANY resolution -- under any
 *     spelling -- landed in a source tree.
 *
 * It is otherwise the same boot: the real built launcher, the real `daily` profile,
 * the T17 probe and keyless mock adapter (so no provider budget is consumed), the
 * shared port-safe harness, and the same classifier.
 *
 * Usage: node .probe/c4/measure-all.mjs
 */
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { bootAndWait, readResult, LAUNCHER, DSH_SRC } from '../../qualification/runners/boot-harness.mjs'

const REPO = 'D:/DSH/work/wt-c4'
const HOME = 'D:/DSH/home/c4'
const MAIN_CHECKOUT = 'D:/DSH/work/dsh-native-daily'
const PROFILE_SRC = `${REPO}/profiles/daily-candidate`
const PROFILE_NAME = 'daily'
const PROFILE_DIR = `${HOME}/profiles/${PROFILE_NAME}`
const RUN_DIR = `${REPO}/.probe/c4/runs/id01-all`
const OUT = `${RUN_DIR}/boot.json`
const GRAPH = `${RUN_DIR}/graph-all.jsonl`
const OVERLAY = `${REPO}/qualification/results/C4-graph/id01-overlay-c4.yml`
const RECORDER = `${REPO}/.probe/c4/recorder-all.mjs`
const SESSION_ROOT = `${RUN_DIR}/sessions`
const FIRST_CALL_FILE = `${RUN_DIR}/first-call-input.txt`
const FIRST_CALL_TEXT = 'C4_INDEPENDENT_FIRST_TOOL_CALL'
const TURN_TIMEOUT_MS = 45_000

mkdirSync(RUN_DIR, { recursive: true })
mkdirSync(SESSION_ROOT, { recursive: true })
mkdirSync(`${RUN_DIR}/workspace`, { recursive: true })
writeFileSync(FIRST_CALL_FILE, `${FIRST_CALL_TEXT}\n`, 'utf8')
rmSync(GRAPH, { force: true })

const transcript = []
const say = line => { transcript.push(line); console.log(line) }

say('=== C4 INDEPENDENT ID-01: all-resolution loader hook, wt-c4 ===')
say(`repo:      ${REPO}`)
say(`home:      ${HOME}`)
say(`launcher:  ${LAUNCHER}`)
say(`recorder:  ${RECORDER} (records EVERY resolution; filtering is done by the reader)`)

const sha = path => (existsSync(path) ? createHash('sha256').update(readFileSync(path)).digest('hex') : null)
const newestMtime = (dir, extensions) => {
  if (!existsSync(dir)) return null
  let newest = 0
  for (const name of readdirSync(dir)) {
    if (!extensions.some(ext => name.endsWith(ext))) continue
    newest = Math.max(newest, statSync(`${dir}/${name}`).mtimeMs)
  }
  return newest === 0 ? null : newest
}

// (0) REBUILD, so the boot executes THIS tree's source. The stale-artifact trap.
const rebuilds = []
for (const pkg of ['packages/dsh-daily-work', 'packages/dsh-ipython']) {
  const started = Date.now()
  try {
    execFileSync(process.execPath, [`${DSH_SRC}/node_modules/typescript/bin/tsc`, '-p', 'tsconfig.json'], {
      cwd: `${REPO}/${pkg}`, stdio: 'pipe', timeout: 300_000,
    })
    rebuilds.push({ package: pkg, exitCode: 0, ms: Date.now() - started, error: null })
  } catch (error) {
    rebuilds.push({ package: pkg, exitCode: error.status ?? null, ms: Date.now() - started, error: String(error.message.split('\n')[0]) })
  }
}
for (const row of rebuilds) say(`rebuild ${row.package}: exit=${String(row.exitCode)} in ${String(row.ms)}ms`)

const buildFreshness = {}
for (const pkg of ['dsh-daily-work', 'dsh-ipython']) {
  const libMtime = newestMtime(`${REPO}/packages/${pkg}/lib`, ['.js'])
  const srcMtime = newestMtime(`${REPO}/packages/${pkg}/src`, ['.ts'])
  buildFreshness[pkg] = {
    newestLibMtime: libMtime === null ? null : new Date(libMtime).toISOString(),
    newestSrcMtime: srcMtime === null ? null : new Date(srcMtime).toISOString(),
    libNewerThanSrc: libMtime !== null && srcMtime !== null && libMtime >= srcMtime,
  }
  say(`build ${pkg}: lib=${buildFreshness[pkg].newestLibMtime} src=${buildFreshness[pkg].newestSrcMtime} fresh=${String(buildFreshness[pkg].libNewerThanSrc)}`)
}

// (1) FRESH INSTALL with the link: targets rewritten to THIS worktree.
if (existsSync(PROFILE_DIR)) rmSync(PROFILE_DIR, { recursive: true, force: true })
mkdirSync(`${HOME}/profiles`, { recursive: true })
cpSync(PROFILE_SRC, PROFILE_DIR, { recursive: true })
writeFileSync(`${PROFILE_DIR}/package.json`,
  readFileSync(`${PROFILE_DIR}/package.json`, 'utf8').replaceAll(MAIN_CHECKOUT, REPO), 'utf8')
const installedPkgJson = readFileSync(`${PROFILE_DIR}/package.json`, 'utf8')
if (!installedPkgJson.includes(REPO) || installedPkgJson.includes(MAIN_CHECKOUT)) {
  throw new Error('the installed profile does not link this worktree; the boot would measure another tree')
}
say('installed profile links this worktree: true  still names main checkout: false')

const repoPatchSha = sha(`${PROFILE_SRC}/cordis.patch.yml`)
const installedPatchSha = sha(`${PROFILE_DIR}/cordis.patch.yml`)
say(`profile installed: repo patch ${String(repoPatchSha).slice(0, 16)}... installed ${String(installedPatchSha).slice(0, 16)}... equal=${String(repoPatchSha === installedPatchSha)}`)

let installResult
try {
  const stdout = execFileSync(process.execPath, [LAUNCHER, 'plugin', '--profile', PROFILE_NAME, 'install'], {
    cwd: PROFILE_DIR, env: { ...process.env, DSH_HOME: HOME }, encoding: 'utf8', timeout: 300_000,
  })
  installResult = { exitCode: 0, error: null, stdoutTail: stdout.slice(-800) }
} catch (error) {
  installResult = { exitCode: error.status ?? null, error: String(error.message.split('\n')[0]) }
}
say(`plugin install: exit=${String(installResult.exitCode)}${installResult.error === null ? '' : ` -- ${installResult.error}`}`)

// (2) BOOT the real built launcher.
const boot = await bootAndWait({
  home: HOME,
  profile: PROFILE_NAME,
  patches: [OVERLAY],
  outPath: OUT,
  cwd: 'C:/Windows/Temp',
  timeoutMs: 180_000,
  env: {
    T17_PROBE_OUT: OUT,
    T17_SESSION_ROOT: SESSION_ROOT,
    T17_SESSION_CWD: `${RUN_DIR}/workspace`,
    T17_LAUNCHER: LAUNCHER,
    T17_LAUNCHER_ARGS: `--profile ${PROFILE_NAME}`,
    T17_PROFILE_NAME: PROFILE_NAME,
    T17_TURN_TIMEOUT_MS: String(TURN_TIMEOUT_MS),
    T17_FIRST_CALL_FILE: FIRST_CALL_FILE,
    C4_GRAPH_OUT: GRAPH,
    NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --import=file:///${RECORDER}`.trim(),
  },
})
say('')
say(`port: ${String(boot.port)}  portReleased: ${String(boot.portReleased)}  timedOut: ${String(boot.timedOut)}`)
writeFileSync(`${RUN_DIR}/boot-stdout.txt`, boot.stdout, 'utf8')
writeFileSync(`${RUN_DIR}/boot-stderr.txt`, boot.stderr, 'utf8')

let probe = null
let probeReadError = null
try {
  probe = readResult(OUT, HOME).json
} catch (error) {
  probeReadError = error instanceof Error ? error.message : String(error)
}

// (3) READ the unfiltered graph.
const allRows = []
let graphReadError = null
try {
  for (const line of readFileSync(GRAPH, 'utf8').split('\n')) {
    if (line.trim() === '') continue
    try { allRows.push(JSON.parse(line)) } catch { /* torn final line */ }
  }
} catch (error) {
  graphReadError = error instanceof Error ? error.message : String(error)
}

/**
 * The oracle's own classification: a URL is SOURCE only when the file it names ends
 * in `.ts`; BUILT only when it names `lib/*.js|mjs|cjs`; anything else is OTHER.
 * NOT a `/src/` substring test -- the checkout lives at `D:\DSH\src\dsh-src`, so
 * every path inside it contains a `src` segment.
 */
function classifyUrl(url) {
  const path = String(url).replace(/^file:\/\/\//, '').replace(/\//g, '\\')
  if (/\.ts$/i.test(path)) return { kind: 'SOURCE', path }
  if (/\\lib\\.*\.(js|mjs|cjs)$/i.test(path)) return { kind: 'BUILT', path }
  return { kind: 'OTHER', path }
}

// FILTER HERE, IN THE READER -- not in the hook.
const scoped = allRows.filter(row => String(row.specifier).startsWith('@deepseek-ai/'))
const specifiers = new Map()
for (const row of scoped) {
  if (typeof row.url !== 'string') continue
  const classified = classifyUrl(row.url)
  const existing = specifiers.get(row.specifier)
  const parent = row.parentURL === null || row.parentURL === undefined ? null : String(row.parentURL)
  if (existing === undefined) {
    specifiers.set(row.specifier, {
      specifier: row.specifier, ...classified, occurrences: 1,
      parents: parent === null ? [] : [parent],
    })
  } else {
    existing.occurrences += 1
    if (existing.path !== classified.path) {
      existing.alsoResolvedTo = [...(existing.alsoResolvedTo ?? []), classified.path]
      existing.mixedWithinSpecifier = true
    }
    if (parent !== null && !existing.parents.includes(parent)) existing.parents.push(parent)
  }
}
const graph = [...specifiers.values()].sort((a, b) => a.specifier.localeCompare(b.specifier))
const fromBuilt = graph.filter(r => r.kind === 'BUILT').length
const fromSource = graph.filter(r => r.kind === 'SOURCE').length
const fromOther = graph.filter(r => r.kind === 'OTHER').length
const underPackagesLib = graph.filter(r => /\\packages\\[^\\]+(\\[^\\]+)?\\lib\\/i.test(r.path)).length
const underVendorLib = graph.filter(r => /\\vendor\\[^\\]+\\lib\\/i.test(r.path)).length
const underNodeModules = graph.filter(r => /\\node_modules\\/i.test(r.path)).length
const offenders = graph.filter(r => r.kind === 'SOURCE').map(r => ({ specifier: r.specifier, resolvedTo: r.path, parents: r.parents }))
const mixed = graph.filter(r => r.mixedWithinSpecifier === true)

// THE FILTER'S OWN COVERAGE, which the archived instrument cannot report.
// Every resolution that landed in a SOURCE tree, under ANY specifier spelling.
const allSourceResolutions = allRows
  .filter(row => /\.ts$/i.test(String(row.url)))
  .map(row => ({ specifier: row.specifier, url: row.url, parentURL: row.parentURL ?? null }))
const scopedSourceResolutions = allSourceResolutions.filter(row => String(row.specifier).startsWith('@deepseek-ai/'))

// TREE BINDING: the graph must name THIS worktree.
const wtUrl = `file:///${REPO}`.toLowerCase()
const allParents = [...new Set(graph.flatMap(r => r.parents))]
const parentsUnderThisTree = allParents.filter(p => p.toLowerCase().startsWith(wtUrl))
const parentsUnderMainCheckout = allParents.filter(p => p.toLowerCase().startsWith('file:///d:/dsh/work/dsh-native-daily'))
const parentsUnderAnyOtherWorktree = allParents.filter(p => {
  const lower = p.toLowerCase()
  if (lower.startsWith(wtUrl)) return false
  return /\/work\/[^/]+\/packages\//.test(lower) && !lower.startsWith('file:///d:/dsh/src/')
})

say('')
say(`TOTAL resolutions recorded (unfiltered): ${String(allRows.length)}`)
say(`  of which @deepseek-ai/* specifiers : ${String(scoped.length)}`)
say(`  resolutions landing in a .ts file, ANY specifier: ${String(allSourceResolutions.length)}`)
for (const row of allSourceResolutions) say(`    ${row.specifier} -> ${row.url}  (parent ${row.parentURL})`)
say('')
say(`TREE BINDING: ${String(parentsUnderThisTree.length)} distinct parent(s) under ${REPO}`)
say(`  parents under the MAIN checkout: ${String(parentsUnderMainCheckout.length)}`)
say(`  parents under any OTHER worktree: ${String(parentsUnderAnyOtherWorktree.length)}`)
say('')
say(`graph: ${String(scoped.length)} @deepseek-ai resolution lines, ${String(graph.length)} distinct specifiers`)
say(`fromBuilt=${String(fromBuilt)} fromSource=${String(fromSource)} fromOther=${String(fromOther)}`)
say(`underPackagesLib=${String(underPackagesLib)} underVendorLib=${String(underVendorLib)} underNodeModules=${String(underNodeModules)}`)
say(`OFFENDERS (specifiers resolving to a .ts file): ${String(offenders.length)}`)
for (const o of offenders) {
  say(`  ${o.specifier} -> ${o.resolvedTo}`)
  for (const p of o.parents) say(`      named by: ${p}`)
}
for (const row of graph.filter(r => r.kind === 'OTHER')) {
  say(`OTHER (not lib, not .ts): ${row.specifier} -> ${row.path}`)
  for (const p of row.parents) say(`      named by: ${p}`)
}

// (4) Assert.
const checks = []
const check = (label, ok, detail) => { checks.push({ label, ok: ok === true, detail }) }
const lock = JSON.parse(readFileSync(`${REPO}/compatibility.lock.json`, 'utf8'))
const pinnedArtifact = lock.deployment.inputs.artifact_sha256
const launcherSha = sha(LAUNCHER)

check('the probe wrote its result', probe !== null, probeReadError ?? 'present')
check('the result names the home this driver booted', probeReadError === null, probeReadError ?? 'ok')
check('the probe recorded no error', (probe?.errors ?? []).length === 0, JSON.stringify(probe?.errors ?? null))
check('the boot did not time out', boot.timedOut === false, `timedOut=${String(boot.timedOut)}`)
check('the host was killed and the port released', boot.portReleased === true, `portReleased=${String(boot.portReleased)}`)
check('the installed profile patch is the repository one', installedPatchSha === repoPatchSha, `installed=${String(installedPatchSha).slice(0, 16)} repo=${String(repoPatchSha).slice(0, 16)}`)
check('every rebuilt package compiled', rebuilds.every(r => r.exitCode === 0), JSON.stringify(rebuilds.map(r => [r.package, r.exitCode])))
check('the built lib/ is newer than src/, so the boot is not running a stale build',
  Object.values(buildFreshness).every(r => r.libNewerThanSrc === true), JSON.stringify(buildFreshness))
check('the graph was recorded and is non-empty', allRows.length > 0, `rows=${String(allRows.length)} graphReadError=${String(graphReadError)}`)
check('THE GRAPH NAMES THIS WORKTREE: no parent is under the main checkout',
  parentsUnderMainCheckout.length === 0, JSON.stringify(parentsUnderMainCheckout))
check('THE GRAPH NAMES THIS WORKTREE: no parent is under another worktree of this project',
  parentsUnderAnyOtherWorktree.length === 0, JSON.stringify(parentsUnderAnyOtherWorktree))
check('THE GRAPH NAMES THIS WORKTREE: the project\'s own built lib/ was loaded from here',
  parentsUnderThisTree.some(p => p.includes('/wt-c4/packages/dsh-daily-work/lib/')),
  `parents under ${REPO}: ${String(parentsUnderThisTree.length)}`)
check('no `@deepseek-ai/*` specifier resolves to a source (.ts) file', fromSource === 0,
  `fromBuilt=${String(fromBuilt)} fromSource=${String(fromSource)} fromOther=${String(fromOther)}; offenders=${JSON.stringify(offenders.map(o => [o.specifier, o.resolvedTo]))}`)
check('NO specifier of ANY spelling resolved to a .ts file (the filter\'s own coverage)',
  allSourceResolutions.length === 0, JSON.stringify(allSourceResolutions.slice(0, 5)))
check('the graph does not mix src and lib for one specifier', mixed.length === 0, JSON.stringify(mixed.map(r => r.specifier)))
check('sha256 of the launcher equals deployment.inputs.artifact_sha256 (REPORTED, not this slice\'s clause)',
  launcherSha === pinnedArtifact, `onDisk=${String(launcherSha).slice(0, 16)} pinned=${String(pinnedArtifact).slice(0, 16)}`)
check('the first tool call actually succeeded (not `--help`-only)',
  probe?.firstToolCall?.firstCallSucceeded === true,
  `requested=${JSON.stringify(probe?.firstToolCall?.toolCallRequested?.name ?? null)} isError=${String(probe?.firstToolCall?.toolResultIsError ?? null)} endReason=${JSON.stringify(probe?.firstToolCall?.turnEndReason ?? null)}`)
check('the tool result carries the file\'s own text',
  typeof probe?.firstToolCall?.toolResultText === 'string' && probe.firstToolCall.toolResultText.includes(FIRST_CALL_TEXT),
  String(probe?.firstToolCall?.toolResultText ?? '').slice(0, 200))

const passed = checks.filter(c => c.ok).length
const verdict = checks.every(c => c.ok) ? 'PASS' : 'FAIL'
say('')
say(`checks: ${String(passed)}/${String(checks.length)}  VERDICT: ${verdict}`)
for (const c of checks) {
  say(`  [${c.ok ? 'ok  ' : 'FAIL'}] ${c.label}`)
  if (!c.ok) say(`         ${c.detail}`)
}

writeFileSync(`${RUN_DIR}/verdict.json`, `${JSON.stringify({
  driver: '.probe/c4/measure-all.mjs',
  case: 'ID-01 (graph clause), independent instrument',
  ranAt: new Date().toISOString(),
  tree: REPO, home: HOME, launcher: LAUNCHER,
  launcherSha256: launcherSha, pinnedArtifactSha256: pinnedArtifact,
  recorder: RECORDER, recorderSha256: sha(RECORDER),
  recorderNote: 'records EVERY resolution; the @deepseek-ai filter is applied in the reader, so the filter\'s coverage is itself reportable',
  overlay: OVERLAY,
  rebuilds, buildFreshness,
  pluginInstall: { exitCode: installResult.exitCode, error: installResult.error },
  boot: { port: boot.port, timedOut: boot.timedOut, exitCode: boot.exitCode, portReleased: boot.portReleased },
  graph: {
    allResolutionLines: allRows.length,
    scopedResolutionLines: scoped.length,
    distinctSpecifiers: graph.length,
    fromBuilt, fromSource, fromOther,
    underPackagesLib, underVendorLib, underNodeModules,
    offenders, mixed: mixed.map(r => r.specifier),
    otherRows: graph.filter(r => r.kind === 'OTHER').map(r => ({ specifier: r.specifier, path: r.path, parents: r.parents })),
    allSourceResolutions,
    scopedSourceResolutionCount: scopedSourceResolutions.length,
    treeBinding: { repo: REPO, distinctParents: allParents.length, parentsUnderThisTree, parentsUnderMainCheckout, parentsUnderAnyOtherWorktree },
  },
  probeReadError,
  checks, checksPassed: passed, checksTotal: checks.length, verdict,
}, null, 2)}\n`, 'utf8')
writeFileSync(`${RUN_DIR}/transcript.txt`, `${transcript.join('\n')}\n`, 'utf8')
