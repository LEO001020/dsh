/**
 * C4 ID-01 graph measurement: boot THIS worktree's built launcher through the real
 * launcher path and re-classify the real module graph, on the CURRENT tree.
 *
 * ORACLE (verbatim, `acceptance-spec.trusted-local-v2.definition.json`):
 *   "The first tool call actually succeeds and the resolved module graph is
 *    recorded: every `@deepseek-ai/*` specifier resolves under
 *    `D:\DSH\src\dsh-src\packages\*\lib\`, and sha256 of the launcher equals
 *    `deployment.inputs.artifact_sha256`. A run whose only success is `--help`, or
 *    whose graph mixes `src` and `lib`, is NOT PASS."
 *
 * WHAT THIS IS. A faithful equivalent of the archived driver
 * (`qualification/results/V1-identity/id01-driver.mjs`) and of S12's re-measurement:
 * the same shared boot harness, the same loader-hook recorder injected through
 * `NODE_OPTIONS --import`, the same T17 probe and keyless mock adapter, the same
 * classifier. It is not the archived driver itself because that driver names the
 * MAIN checkout and would measure someone else's tree.
 *
 * THE ONE THING IT ADDS OVER ITS PREDECESSORS, and why. Both predecessors measured
 * `fromSource` by classification of the resolved URL. That answers "did the boot
 * resolve a .ts file", which is the oracle's question. It does NOT answer "which
 * package's built artifact NAMED the specifier", and that is the question this
 * slice was sent to settle: the offender was reported as emitted from
 * `packages/dsh-daily-work/lib/artifacts.js`, and a reader needs the PARENT of each
 * resolution to see that for themselves. So every row here carries `parentURL`, the
 * classification records the parent, and the report prints the parent of every
 * non-BUILT row. A graph row with no parent is reported as such rather than
 * silently attributed.
 *
 * THE LAUNCHER CHECK IS REPORTED, NOT ASSERTED AS PASS. `ID-01` also requires the
 * launcher's sha256 to equal `deployment.inputs.artifact_sha256`. That pin describes
 * the MAIN checkout's identity; this writer's slice does not change the launcher.
 * The measurement is reported as a number and the verdict turns on the GRAPH clause.
 *
 * Usage: node qualification/results/C4-graph/id01-measure.mjs
 */
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { bootAndWait, readResult, LAUNCHER, DSH_SRC } from '../../runners/boot-harness.mjs'

const REPO = 'D:/DSH/work/wt-c4'
const HOME = 'D:/DSH/home/c4'
const PROFILE_SRC = `${REPO}/profiles/daily-candidate`
const PROFILE_NAME = 'daily'
const PROFILE_DIR = `${HOME}/profiles/${PROFILE_NAME}`
const RUN_DIR = `${REPO}/qualification/results/C4-graph/runs/id01`
const OUT = `${RUN_DIR}/boot.json`
const GRAPH = `${RUN_DIR}/graph.jsonl`
const OVERLAY = `${REPO}/qualification/results/C4-graph/id01-overlay-c4.yml`
const RECORDER = `${REPO}/qualification/results/V1-identity/id01-graph-recorder.mjs`
const SESSION_ROOT = `${RUN_DIR}/sessions`
const FIRST_CALL_FILE = `${RUN_DIR}/first-call-input.txt`
const FIRST_CALL_TEXT = 'C4_FIRST_TOOL_CALL_ROUND_TRIP'
const TURN_TIMEOUT_MS = 45_000

mkdirSync(RUN_DIR, { recursive: true })
mkdirSync(SESSION_ROOT, { recursive: true })
mkdirSync(`${RUN_DIR}/workspace`, { recursive: true })
writeFileSync(FIRST_CALL_FILE, `${FIRST_CALL_TEXT}\n`, 'utf8')
rmSync(GRAPH, { force: true })

const transcript = []
const say = line => { transcript.push(line); console.log(line) }

say('=== C4 ID-01: wt-c4 built launcher, real module graph, first successful tool call ===')
say(`repo:      ${REPO}`)
say(`home:      ${HOME}`)
say(`launcher:  ${LAUNCHER}`)
say(`graph out: ${GRAPH}`)

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

// ---------------------------------------------------------------------------
// (0) REBUILD, so the boot executes THIS tree's source. The stale-build trap.
// ---------------------------------------------------------------------------
const rebuilds = []
for (const pkg of ['packages/dsh-daily-work', 'packages/dsh-ipython']) {
  const cwd = `${REPO}/${pkg}`
  const started = Date.now()
  try {
    execFileSync(process.execPath, [`${DSH_SRC}/node_modules/typescript/bin/tsc`, '-p', 'tsconfig.json'], {
      cwd, stdio: 'pipe', timeout: 300_000,
    })
    rebuilds.push({ package: pkg, exitCode: 0, ms: Date.now() - started, error: null })
  } catch (error) {
    rebuilds.push({
      package: pkg,
      exitCode: error.status ?? null,
      ms: Date.now() - started,
      error: String(error.message.split('\n')[0]),
      stderr: String(error.stderr ?? '').slice(-4000),
    })
  }
}
for (const row of rebuilds) {
  say(`rebuild ${row.package}: exit=${String(row.exitCode)} in ${String(row.ms)}ms${row.error === null ? '' : ` -- ${row.error}`}`)
}

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

// ---------------------------------------------------------------------------
// (1) FRESH INSTALL of the profile from the repository, WITH THE `link:` TARGETS
//     REWRITTEN TO THIS WORKTREE.
//
// THE TRAP THIS GUARD EXISTS FOR, and it fired on the first revision of this
// driver. `profiles/daily-candidate/package.json` names the MAIN checkout's
// absolute paths on purpose -- that literal is the needle `helpers/new-writer.ps1`
// searches for when it provisions a writer's home. A driver that copies the
// profile and runs `plugin install` WITHOUT the rewrite installs links to
// `D:/DSH/work/dsh-native-daily`, and the boot then executes the MAIN checkout's
// `lib/` while the driver believes it measured its own tree. That is G-SEAM-29 /
// G-SEAM-36 / G-SEAM-61, and it fails SILENTLY.
//
// MEASURED on the first revision of this driver: the offender's recorded parent
// was `file:///D:/DSH/work/dsh-native-daily/packages/dsh-daily-work/lib/artifacts.js`
// -- the MAIN checkout -- not this tree. The rewrite below is what makes the
// measurement a measurement of `D:/DSH/work/wt-c4`.
// ---------------------------------------------------------------------------
if (existsSync(PROFILE_DIR)) rmSync(PROFILE_DIR, { recursive: true, force: true })
mkdirSync(`${HOME}/profiles`, { recursive: true })
cpSync(PROFILE_SRC, PROFILE_DIR, { recursive: true })

const installedPkgPath = `${PROFILE_DIR}/package.json`
const MAIN_CHECKOUT = 'D:/DSH/work/dsh-native-daily'
writeFileSync(installedPkgPath,
  readFileSync(installedPkgPath, 'utf8').replaceAll(MAIN_CHECKOUT, REPO), 'utf8')

// ASSERTED, not assumed: the installed profile must link THIS tree and must NOT
// name the main checkout anywhere. A boot that resolves another tree produces a
// graph that is not this tree's graph, and reporting it as such would be the
// stale-artifact trap this project has already retracted claims over.
const installedPkgJson = readFileSync(installedPkgPath, 'utf8')
const linksThisWorktree = installedPkgJson.includes(REPO)
const stillNamesMain = installedPkgJson.includes(MAIN_CHECKOUT)
say(`installed profile links this worktree: ${String(linksThisWorktree)}  still names main checkout: ${String(stillNamesMain)}`)
if (!linksThisWorktree || stillNamesMain) {
  throw new Error('the installed profile does not link this worktree; the boot would measure another tree')
}

const repoPatchSha = sha(`${PROFILE_SRC}/cordis.patch.yml`)
const installedPatchSha = sha(`${PROFILE_DIR}/cordis.patch.yml`)
say(`profile installed: repo patch ${String(repoPatchSha).slice(0, 16)}... installed ${String(installedPatchSha).slice(0, 16)}... equal=${String(repoPatchSha === installedPatchSha)}`)

let installResult
try {
  const stdout = execFileSync(process.execPath, [LAUNCHER, 'plugin', '--profile', PROFILE_NAME, 'install'], {
    cwd: PROFILE_DIR, env: { ...process.env, DSH_HOME: HOME }, encoding: 'utf8', timeout: 300_000,
  })
  installResult = { exitCode: 0, stdoutTail: stdout.slice(-1200), error: null }
} catch (error) {
  installResult = {
    exitCode: error.status ?? null,
    error: String(error.message.split('\n')[0]),
    stdoutTail: String(error.stdout ?? '').slice(-1200),
    stderrTail: String(error.stderr ?? '').slice(-1200),
  }
}
say(`plugin install: exit=${String(installResult.exitCode)}${installResult.error === null ? '' : ` -- ${installResult.error}`}`)

// ---------------------------------------------------------------------------
// (2) BOOT the real built launcher, ONE host, on a harness-chosen free port.
// ---------------------------------------------------------------------------
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
    V1_GRAPH_OUT: GRAPH,
    NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --import=file:///${RECORDER}`.trim(),
  },
})

say('')
say(`port: ${String(boot.port)}  portReleased: ${String(boot.portReleased)}  timedOut: ${String(boot.timedOut)}  exitCode: ${String(boot.exitCode)}`)
writeFileSync(`${RUN_DIR}/boot-stdout.txt`, boot.stdout, 'utf8')
writeFileSync(`${RUN_DIR}/boot-stderr.txt`, boot.stderr, 'utf8')

// ---------------------------------------------------------------------------
// (3) READ the probe result, ASSERTING it names the home this driver booted.
// ---------------------------------------------------------------------------
let probe = null
let probeReadError = null
try {
  probe = readResult(OUT, HOME).json
} catch (error) {
  probeReadError = error instanceof Error ? error.message : String(error)
}

// ---------------------------------------------------------------------------
// (4) CLASSIFY the recorded graph.
// ---------------------------------------------------------------------------
const graphRows = []
let graphReadError = null
try {
  const text = readFileSync(GRAPH, 'utf8')
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    try { graphRows.push(JSON.parse(line)) } catch { /* a torn final line is counted below */ }
  }
} catch (error) {
  graphReadError = error instanceof Error ? error.message : String(error)
}

/**
 * Classify a resolved URL by the FILE IT NAMES.
 *
 * DELIBERATELY NOT A `/src/` SUBSTRING TEST. The pinned checkout lives at
 * `D:\DSH\src\dsh-src`, so EVERY path inside it contains a `src` segment. A URL is
 * SOURCE only when the file it names ends in `.ts`, and BUILT only when it names a
 * `lib/*.js`, `lib/*.mjs` or `lib/*.cjs`. Anything else is OTHER and is reported as
 * such rather than guessed at.
 */
function classifyUrl(url) {
  const path = String(url).replace(/^file:\/\/\//, '').replace(/\//g, '\\')
  if (/\.ts$/i.test(path)) return { kind: 'SOURCE', path }
  if (/\\lib\\.*\.(js|mjs|cjs)$/i.test(path)) return { kind: 'BUILT', path }
  return { kind: 'OTHER', path }
}

const specifiers = new Map()
for (const row of graphRows) {
  if (typeof row.url !== 'string') continue
  const classified = classifyUrl(row.url)
  const existing = specifiers.get(row.specifier)
  if (existing === undefined) {
    specifiers.set(row.specifier, {
      specifier: row.specifier,
      ...classified,
      occurrences: 1,
      parents: row.parentURL === null || row.parentURL === undefined ? [] : [String(row.parentURL)],
    })
  } else {
    existing.occurrences += 1
    if (existing.path !== classified.path) {
      existing.alsoResolvedTo = [...(existing.alsoResolvedTo ?? []), classified.path]
      existing.mixedWithinSpecifier = true
    }
    const parent = row.parentURL === null || row.parentURL === undefined ? null : String(row.parentURL)
    if (parent !== null && !existing.parents.includes(parent)) existing.parents.push(parent)
  }
}
const graph = [...specifiers.values()].sort((a, b) => a.specifier.localeCompare(b.specifier))

const fromBuilt = graph.filter(row => row.kind === 'BUILT').length
const fromSource = graph.filter(row => row.kind === 'SOURCE').length
const fromOther = graph.filter(row => row.kind === 'OTHER').length
const underPackagesLib = graph.filter(row => /\\packages\\[^\\]+(\\[^\\]+)?\\lib\\/i.test(row.path)).length
const underVendorLib = graph.filter(row => /\\vendor\\[^\\]+\\lib\\/i.test(row.path)).length
const underNodeModules = graph.filter(row => /\\node_modules\\/i.test(row.path)).length
const sourceRows = graph.filter(row => row.kind === 'SOURCE')
const mixed = graph.filter(row => row.mixedWithinSpecifier === true)

// THE ORACLE'S OWN CLAUSE, stated as the oracle states it: every @deepseek-ai/*
// specifier that is a MODULE resolution must name a `lib/` tree. `fromSource` is
// the offender count; the offenders are named with their parent so a reader can
// see WHICH built artifact named them.
const offenders = sourceRows.map(row => ({ specifier: row.specifier, resolvedTo: row.path, parents: row.parents }))

say('')
say(`graph: ${String(graphRows.length)} resolution lines, ${String(graph.length)} distinct @deepseek-ai specifiers`)
say(`fromBuilt=${String(fromBuilt)} fromSource=${String(fromSource)} fromOther=${String(fromOther)}`)
say(`underPackagesLib=${String(underPackagesLib)} underVendorLib=${String(underVendorLib)} underNodeModules=${String(underNodeModules)}`)
say(`OFFENDERS (specifiers resolving to a .ts file): ${String(offenders.length)}`)
for (const o of offenders) {
  say(`  ${o.specifier} -> ${o.resolvedTo}`)
  for (const p of o.parents) say(`      named by: ${p}`)
}
say(`OTHER rows (not lib, not .ts) -- reported, not folded into a pass:`)
for (const row of graph.filter(r => r.kind === 'OTHER')) {
  say(`  ${row.specifier} -> ${row.path}`)
  for (const p of row.parents) say(`      named by: ${p}`)
}

// ---------------------------------------------------------------------------
// (5) Assert.
// ---------------------------------------------------------------------------
const checks = []
function check(label, ok, detail) {
  checks.push({ label, ok: ok === true, detail })
}

const lock = JSON.parse(readFileSync(`${REPO}/compatibility.lock.json`, 'utf8'))
const pinnedArtifact = lock.deployment.inputs.artifact_sha256
const launcherSha = sha(LAUNCHER)

check('the probe wrote its result', probe !== null, probeReadError ?? 'present')
check('the result names the home this driver booted', probeReadError === null,
  probeReadError ?? `roots: ${JSON.stringify((probe?.presetRoots ?? []).map(r => r.path))}`)
check('the probe recorded no error', (probe?.errors ?? []).length === 0, JSON.stringify(probe?.errors ?? null))
check('the boot did not time out', boot.timedOut === false, `timedOut=${String(boot.timedOut)}`)
check('the host was killed and the port released', boot.portReleased === true, `portReleased=${String(boot.portReleased)}`)
check('the installed profile patch is the repository one', installedPatchSha === repoPatchSha,
  `installed=${String(installedPatchSha).slice(0, 16)} repo=${String(repoPatchSha).slice(0, 16)}`)
check('every rebuilt package compiled', rebuilds.every(r => r.exitCode === 0), JSON.stringify(rebuilds.map(r => [r.package, r.exitCode])))
check('the built lib/ is newer than src/, so the boot is not running a stale build',
  Object.values(buildFreshness).every(r => r.libNewerThanSrc === true),
  JSON.stringify(buildFreshness))
check('the graph was recorded and is non-empty', graphRows.length > 0, `rows=${String(graphRows.length)} graphReadError=${String(graphReadError)}`)
check('no `@deepseek-ai/*` specifier resolves to a source (.ts) file',
  fromSource === 0,
  `fromBuilt=${String(fromBuilt)} fromSource=${String(fromSource)} fromOther=${String(fromOther)}; offenders=${JSON.stringify(offenders.map(o => [o.specifier, o.resolvedTo]))}`)
check('the graph does not mix src and lib for one specifier', mixed.length === 0, JSON.stringify(mixed.map(r => r.specifier)))
check('sha256 of the launcher equals deployment.inputs.artifact_sha256 (REPORTED, not this slice\'s clause)',
  launcherSha === pinnedArtifact, `onDisk=${String(launcherSha).slice(0, 16)} pinned=${String(pinnedArtifact).slice(0, 16)}`)
check('the first tool call actually succeeded (not `--help`-only)',
  probe?.firstToolCall?.toolResultIsError === false,
  `tool=${JSON.stringify(probe?.firstToolCall?.requestedToolName ?? null)} isError=${String(probe?.firstToolCall?.toolResultIsError ?? null)}`)
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
  driver: 'qualification/results/C4-graph/id01-measure.mjs',
  case: 'ID-01',
  ranAt: new Date().toISOString(),
  tree: REPO,
  home: HOME,
  launcher: LAUNCHER,
  launcherSha256: launcherSha,
  pinnedArtifactSha256: pinnedArtifact,
  recorder: RECORDER,
  recorderSha256: sha(RECORDER),
  overlay: OVERLAY,
  rebuilds,
  buildFreshness,
  pluginInstall: { exitCode: installResult.exitCode, error: installResult.error },
  boot: { port: boot.port, timedOut: boot.timedOut, exitCode: boot.exitCode, portReleased: boot.portReleased },
  graph: {
    lineCount: graphRows.length,
    distinctSpecifiers: graph.length,
    fromBuilt, fromSource, fromOther,
    underPackagesLib, underVendorLib, underNodeModules,
    offenders,
    otherRows: graph.filter(r => r.kind === 'OTHER').map(r => ({ specifier: r.specifier, path: r.path, parents: r.parents })),
    mixed: mixed.map(r => r.specifier),
  },
  checks,
  checksPassed: passed,
  checksTotal: checks.length,
  verdict,
}, null, 2)}\n`, 'utf8')

writeFileSync(`${RUN_DIR}/transcript.txt`, `${transcript.join('\n')}\n`, 'utf8')
