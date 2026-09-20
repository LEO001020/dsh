/**
 * R2-F4 ID-01 re-measurement: boot THIS worktree's built launcher and re-classify the
 * real module graph, to test whether the graph clause is now satisfiable.
 *
 * ORACLE (verbatim from the spec, `ID-01`):
 *   "The first tool call actually succeeds and the resolved module graph is
 *    recorded: every `@deepseek-ai/*` specifier resolves under
 *    `D:\DSH\src\dsh-src\packages\*\lib\`, and sha256 of the launcher equals
 *    `deployment.inputs.artifact_sha256`. A run whose only success is `--help`, or
 *    whose graph mixes `src` and `lib`, is NOT PASS."
 *
 * WHAT THIS IS, AND WHAT IT IS NOT
 *
 * It is a FAITHFUL EQUIVALENT of the archived driver
 * (`qualification/results/V1-identity/id01-driver.mjs`): the same boot harness, the
 * same recorder injected through `NODE_OPTIONS`, the same probe and mock adapter, the
 * same classifier. It is not the archived driver itself, because that driver names
 * the MAIN checkout (`D:/DSH/work/dsh-native-daily`) and would measure someone else's
 * tree. The two differences from the archived run are stated rather than hidden:
 *
 *   1. the tree under test is `D:/DSH/work/wt-r2f4`, on branch `wt/r2f4`;
 *   2. the home is `D:/DSH/home/r2f4`.
 *
 * THE LAUNCHER CHECK IS REPORTED, NOT ASSERTED AS PASS. `ID-01` also requires the
 * launcher's sha256 to equal `deployment.inputs.artifact_sha256`. That pin describes
 * the MAIN checkout's identity, and this writer's slice does not change the launcher;
 * the measurement is reported as a number so the reader can see it, and the verdict
 * below turns on the GRAPH clause, which is the clause this slice is responsible for.
 *
 * Usage: node .probe/r2f4/id01-remesure.mjs
 */
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { bootAndWait, readResult, LAUNCHER, DSH_SRC } from '../../qualification/runners/boot-harness.mjs'

const REPO = 'D:/DSH/work/wt-r2f4'
const HOME = 'D:/DSH/home/r2f4'
const PROFILE_SRC = `${REPO}/profiles/daily-candidate`
const PROFILE_NAME = 'daily'
const PROFILE_DIR = `${HOME}/profiles/${PROFILE_NAME}`
const RUN_DIR = `${REPO}/.probe/r2f4/runs/id01`
const OUT = `${RUN_DIR}/boot.json`
const GRAPH = `${RUN_DIR}/graph.jsonl`
const OVERLAY = process.env.R2F4_OVERLAY ?? `${REPO}/.probe/r2f4/id01-overlay-wt.yml`
const RECORDER = `${REPO}/qualification/results/V1-identity/id01-graph-recorder.mjs`
const SESSION_ROOT = `${RUN_DIR}/sessions`
const FIRST_CALL_FILE = `${RUN_DIR}/first-call-input.txt`
const FIRST_CALL_TEXT = 'ID01_FIRST_TOOL_CALL_ROUND_TRIP'
const TURN_TIMEOUT_MS = 45_000

mkdirSync(RUN_DIR, { recursive: true })
mkdirSync(SESSION_ROOT, { recursive: true })
mkdirSync(`${RUN_DIR}/workspace`, { recursive: true })
writeFileSync(FIRST_CALL_FILE, `${FIRST_CALL_TEXT}\n`, 'utf8')
rmSync(GRAPH, { force: true })

const transcript = []
const say = line => { transcript.push(line); console.log(line) }

say('=== ID-01 re-measurement: wt-r2f4, built launcher, real module graph ===')
say(`repo:      ${REPO}`)
say(`home:      ${HOME}`)
say(`launcher:  ${LAUNCHER}`)
say(`graph out: ${GRAPH}`)

const sha = path => (existsSync(path) ? createHash('sha256').update(readFileSync(path)).digest('hex') : null)

// ---------------------------------------------------------------------------
// (0) REBUILD, so the boot executes THIS tree's source.
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

/** Newest mtime in a directory for one extension. */
const newestMtime = (dir, extensions) => {
  if (!existsSync(dir)) return null
  let newest = 0
  for (const name of readdirSync(dir)) {
    if (!extensions.some(ext => name.endsWith(ext))) continue
    newest = Math.max(newest, statSync(`${dir}/${name}`).mtimeMs)
  }
  return newest === 0 ? null : newest
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
// (1) FRESH INSTALL of the profile from THIS repository.
// ---------------------------------------------------------------------------
if (existsSync(PROFILE_DIR)) rmSync(PROFILE_DIR, { recursive: true, force: true })
mkdirSync(`${HOME}/profiles`, { recursive: true })
const { cpSync, writeFileSync: writeSync } = await import('node:fs')
cpSync(PROFILE_SRC, PROFILE_DIR, { recursive: true })

// REWRITE the `link:` targets at THIS worktree, exactly as `helpers/new-writer.ps1`
// does. The repository's `profiles/daily-candidate/package.json` names the MAIN
// checkout by absolute path, so a plain copy would make this boot measure someone
// else's code -- the stale-artifact trap (G-SEAM-29/36) in a new costume.
const installedPkgPath = `${PROFILE_DIR}/package.json`
const repoProfilePkg = readFileSync(installedPkgPath, 'utf8')
writeSync(installedPkgPath, repoProfilePkg.replaceAll('D:/DSH/work/dsh-native-daily', REPO), 'utf8')

// PROVE the installed profile now names THIS worktree, so a boot that measured the
// main checkout cannot be reported as this tree's result.
const installedPkgJson = readFileSync(installedPkgPath, 'utf8')
const linksThisWorktree = installedPkgJson.includes(REPO)
say(`installed profile links this worktree: ${String(linksThisWorktree)}`)
if (!linksThisWorktree) throw new Error('the installed profile does not link this worktree; the boot would measure another tree')
if (installedPkgJson.includes('D:/DSH/work/dsh-native-daily')) {
  throw new Error('the installed profile still names the MAIN checkout; the rewrite did not take')
}

let installResult
try {
  const stdout = execFileSync(process.execPath, [LAUNCHER, 'plugin', '--profile', PROFILE_NAME, 'install'], {
    cwd: PROFILE_DIR, env: { ...process.env, DSH_HOME: HOME }, encoding: 'utf8', timeout: 300_000,
  })
  installResult = { exitCode: 0, stdoutTail: stdout.slice(-800) }
} catch (error) {
  installResult = {
    exitCode: error.status ?? null,
    error: String(error.message.split('\n')[0]),
    stderrTail: String(error.stderr ?? '').slice(-800),
  }
}
say(`plugin install: exit=${String(installResult.exitCode)}${installResult.error === undefined ? '' : ` -- ${installResult.error}`}`)

// ---------------------------------------------------------------------------
// (2) BOOT the real built launcher, on a harness-chosen free port.
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
    R2F4_OUT: process.env.R2F4_OUT ?? '',
    NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --import=file:///${RECORDER}`.trim(),
  },
})

say('')
say(`port: ${String(boot.port)} portReleased: ${String(boot.portReleased)} timedOut: ${String(boot.timedOut)} exitCode: ${String(boot.exitCode)}`)
writeFileSync(`${RUN_DIR}/boot-stdout.txt`, boot.stdout, 'utf8')
writeFileSync(`${RUN_DIR}/boot-stderr.txt`, boot.stderr, 'utf8')

let probe = null
let probeReadError = null
try {
  probe = readResult(OUT, HOME).json
} catch (error) {
  probeReadError = error instanceof Error ? error.message : String(error)
}
say(`probe: ${probeReadError ?? 'read and bound to this home'}`)

// ---------------------------------------------------------------------------
// (3) CLASSIFY the graph, with the ARCHIVED classifier verbatim.
// ---------------------------------------------------------------------------
const graphRows = []
let graphReadError = null
try {
  for (const line of readFileSync(GRAPH, 'utf8').split('\n')) {
    if (line.trim() === '') continue
    try { graphRows.push(JSON.parse(line)) } catch { /* torn final line */ }
  }
} catch (error) {
  graphReadError = error instanceof Error ? error.message : String(error)
}

/**
 * Classify a resolved URL by the FILE IT NAMES. Copied from the archived driver
 * because the classification IS the oracle: a `.ts` file is SOURCE, a `lib/*.js` is
 * BUILT, anything else is OTHER. The `/src/` substring test is deliberately NOT used
 * (the checkout lives at `D:\DSH\src\dsh-src`, so every path contains `src`).
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
    specifiers.set(row.specifier, { specifier: row.specifier, ...classified, occurrences: 1 })
  } else {
    existing.occurrences += 1
    if (existing.path !== classified.path) {
      existing.alsoResolvedTo = [...(existing.alsoResolvedTo ?? []), classified.path]
      existing.mixedWithinSpecifier = true
    }
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

// ---------------------------------------------------------------------------
// (4) Assert the GRAPH clause and the first-call clause.
// ---------------------------------------------------------------------------
const checks = []
const check = (label, ok, detail) => { checks.push({ label, ok: ok === true, detail }) }

const lock = JSON.parse(readFileSync(`${REPO}/compatibility.lock.json`, 'utf8'))
const pinnedArtifact = lock.deployment.inputs.artifact_sha256
const launcherSha = sha(LAUNCHER)

check('the probe wrote its result and it names this home', probe !== null, probeReadError ?? 'present')
check('every rebuilt package compiled', rebuilds.every(r => r.exitCode === 0), JSON.stringify(rebuilds.map(r => [r.package, r.exitCode])))
check('the graph was recorded and is non-empty', graphRows.length > 0, `lines=${String(graphRows.length)}`)
// THE CLAUSE THIS SLICE IS RESPONSIBLE FOR.
check('no @deepseek-ai specifier resolved to a source (.ts) file', fromSource === 0,
  `fromBuilt=${String(fromBuilt)} fromSource=${String(fromSource)} fromOther=${String(fromOther)}; `
  + `offenders=${JSON.stringify(sourceRows.map(r => [r.specifier, r.path]))}`)
check('no specifier resolved to two different files (no mixed graph within a specifier)',
  graph.every(row => row.mixedWithinSpecifier !== true),
  JSON.stringify(graph.filter(row => row.mixedWithinSpecifier === true).map(r => [r.specifier, r.path, r.alsoResolvedTo])))
check('the resolved files sit under the checkout lib/ trees (packages, vendor or node_modules)',
  fromBuilt === underPackagesLib + underVendorLib + underNodeModules,
  `fromBuilt=${String(fromBuilt)} packages=${String(underPackagesLib)} vendor=${String(underVendorLib)} node_modules=${String(underNodeModules)}`)
// REPORTED, not asserted: this pin describes the main checkout's identity.
check('REPORTED: sha256 of the launcher equals deployment.inputs.artifact_sha256 (a MAIN-checkout pin)',
  launcherSha === pinnedArtifact,
  `onDisk=${String(launcherSha).slice(0, 16)} pinned=${String(pinnedArtifact).slice(0, 16)}`)

const first = probe?.firstToolCall ?? null
check('the first tool call SUCCEEDED', first?.firstCallSucceeded === true,
  `requested=${JSON.stringify(first?.toolCallRequested?.name)} isError=${JSON.stringify(first?.toolResultIsError)}`)
check('the tool result carries the file\'s own text', typeof first?.toolResultText === 'string' && first.toolResultText.includes(FIRST_CALL_TEXT),
  JSON.stringify(first?.toolResultText))

const graphFailures = checks.filter(row => !row.ok && !row.label.startsWith('REPORTED:'))

const artifact = {
  driver: 'r2f4-id01-remesure',
  case: 'ID-01 (graph clause)',
  ranAt: new Date().toISOString(),
  tree: REPO,
  branch: 'wt/r2f4',
  home: HOME,
  overlay: OVERLAY,
  overlayNote: 'the archived ID-01 overlay with the two insert names re-pointed at this worktree; keyless mock route, no provider budget',
  rebuilds,
  buildFreshness,
  pluginInstall: installResult,
  port: boot.port,
  timedOut: boot.timedOut,
  launcherSha256: launcherSha,
  pinnedArtifactSha256: pinnedArtifact,
  graph: {
    lineCount: graphRows.length,
    distinctSpecifiers: graph.length,
    fromBuilt,
    fromSource,
    fromOther,
    underPackagesLib,
    underVendorLib,
    underNodeModules,
    sourceRows,
  },
  probeReadError,
  checks,
  graphFailures: graphFailures.map(row => `${row.label} -- observed: ${row.detail}`),
  graphClauseVerdict: graphFailures.length === 0 ? 'PASS' : 'FAIL',
}

writeFileSync(`${RUN_DIR}/verdict.json`, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8')
writeFileSync(`${RUN_DIR}/transcript.txt`, `${transcript.join('\n')}\n`, 'utf8')

say('')
say('--- checks ---')
for (const row of checks) say(`${row.ok ? 'ok  ' : 'FAIL'} ${row.label}${row.ok ? '' : `\n       observed: ${row.detail}`}`)
say('')
say(`graph: ${String(graphRows.length)} resolution lines, ${String(graph.length)} distinct @deepseek-ai specifiers`)
say(`  from BUILT: ${String(fromBuilt)}  from SOURCE: ${String(fromSource)}  OTHER: ${String(fromOther)}`)
say(`  under packages\\*\\lib\\: ${String(underPackagesLib)}  under vendor\\*\\lib\\: ${String(underVendorLib)}  node_modules: ${String(underNodeModules)}`)
say(`GRAPH CLAUSE VERDICT: ${artifact.graphClauseVerdict}`)
