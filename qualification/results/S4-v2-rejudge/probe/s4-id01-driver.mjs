/**
 * S4 ID-01 driver: boot the BUILT launcher from THIS worktree and measure the
 * real module graph, the launcher identity, and the first successful tool call.
 *
 * ORACLE (v2 definition, verbatim):
 *   "The first tool call actually succeeds and the resolved module graph is
 *    recorded: every `@deepseek-ai/*` specifier resolves under
 *    `D:\DSH\src\dsh-src\packages\*\lib\`, and sha256 of the launcher equals
 *    `deployment.inputs.artifact_sha256`. A run whose only success is `--help`,
 *    or whose graph mixes `src` and `lib`, is NOT PASS."
 *
 * WHY THIS IS A COPY OF V1-identity/id01-driver.mjs WITH PATHS REWRITTEN, and
 * what that costs. The v1 driver hardcodes `REPO = D:/DSH/work/dsh-native-daily`
 * and `HOME = D:/DSH/home/v1-identity`; running it unchanged would measure the
 * MAIN checkout's profile and probe, not this writer's tree. So every path is
 * rewritten at `D:/DSH/work/wt-s4` / `D:/DSH/home/s4`, and the digests of the
 * original instruments AND of this copy are recorded in the verdict artifact so
 * a reader can see exactly what diverged. The instrument is not identical to
 * v1's; it is v1's instrument with the tree under measurement changed, which is
 * the only honest way for a second writer to re-measure a v1 FAIL.
 *
 * THE ORACLE IS NOT WEAKENED. No check is dropped and no threshold is moved.
 * The graph clause is the one v1 FAILED on, and it is carried verbatim.
 *
 * Usage: node qualification/results/S4-v2-rejudge/probe/s4-id01-driver.mjs
 */
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { bootAndWait, readResult, LAUNCHER, DSH_SRC } from '../../../runners/boot-harness.mjs'

const REPO = 'D:/DSH/work/wt-s4'
const HOME = 'D:/DSH/home/s4'
const PROFILE_SRC = `${REPO}/profiles/daily-candidate`
const PROFILE_NAME = 'daily'
const PROFILE_DIR = `${HOME}/profiles/${PROFILE_NAME}`
const RUN_DIR = `${REPO}/qualification/results/S4-v2-rejudge/runs/id01`
const OUT = `${RUN_DIR}/boot.json`
const GRAPH = `${RUN_DIR}/graph.jsonl`
const OVERLAY = `${REPO}/qualification/results/S4-v2-rejudge/probe/s4-id01-overlay.yml`
const RECORDER = `${REPO}/qualification/results/S4-v2-rejudge/probe/s4-id01-graph-recorder.mjs`
const SESSION_ROOT = `${RUN_DIR}/sessions`
const FIRST_CALL_FILE = `${RUN_DIR}/first-call-input.txt`
const FIRST_CALL_TEXT = 'S4_ID01_FIRST_TOOL_CALL_ROUND_TRIP'
const TURN_TIMEOUT_MS = 45_000

mkdirSync(RUN_DIR, { recursive: true })
mkdirSync(SESSION_ROOT, { recursive: true })
mkdirSync(`${RUN_DIR}/workspace`, { recursive: true })
writeFileSync(FIRST_CALL_FILE, `${FIRST_CALL_TEXT}\n`, 'utf8')
rmSync(GRAPH, { force: true })

const transcript = []
const say = line => { transcript.push(line); console.log(line) }

say('=== S4 ID-01: built launcher, real module graph, first successful tool call ===')
say(`repo:      ${REPO}`)
say(`home:      ${HOME}`)
say(`launcher:  ${LAUNCHER}`)
say(`probe out: ${OUT}`)
say(`graph out: ${GRAPH}`)
say(`at:        ${new Date().toISOString()}`)

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
const digestLib = dir => {
  const hash = createHash('sha256')
  let count = 0
  if (existsSync(dir)) {
    for (const name of readdirSync(dir).sort()) {
      if (!name.endsWith('.js')) continue
      hash.update(name)
      hash.update(readFileSync(`${dir}/${name}`))
      count += 1
    }
  }
  return { fileCount: count, digest: hash.digest('hex') }
}

// ---------------------------------------------------------------------------
// (0) REBUILD, so the boot executes THIS tree's source. A `lib/` older than its
//     `src/` is a stale build, and this project has filed two FALSE findings by
//     measuring one (G-SEAM-29, G-SEAM-36).
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
    newestLibMtimeMs: libMtime,
    newestLibMtime: libMtime === null ? null : new Date(libMtime).toISOString(),
    newestSrcMtimeMs: srcMtime,
    newestSrcMtime: srcMtime === null ? null : new Date(srcMtime).toISOString(),
    libNewerThanSrc: libMtime !== null && srcMtime !== null && libMtime >= srcMtime,
    buildDigest: digestLib(`${REPO}/packages/${pkg}/lib`),
  }
  say(`build ${pkg}: lib newest=${buildFreshness[pkg].newestLibMtime} src newest=${buildFreshness[pkg].newestSrcMtime} libNewerThanSrc=${String(buildFreshness[pkg].libNewerThanSrc)} files=${String(buildFreshness[pkg].buildDigest.fileCount)} digest=${buildFreshness[pkg].buildDigest.digest.slice(0, 16)}...`)
}

// ---------------------------------------------------------------------------
// (1) FRESH INSTALL of the profile from THIS repository tree, so the boot
//     measures this tree's composition and not a previous agent's copy.
// ---------------------------------------------------------------------------
if (existsSync(PROFILE_DIR)) rmSync(PROFILE_DIR, { recursive: true, force: true })
mkdirSync(`${HOME}/profiles`, { recursive: true })
cpSync(PROFILE_SRC, PROFILE_DIR, { recursive: true })

// ═══════════════════════════════════════════════════════════════════════════
// THE TRAP THIS BLOCK EXISTS FOR, MEASURED THE HARD WAY.
//
// The repository's own `profiles/daily-candidate/package.json` carries
// `link:D:/DSH/work/dsh-native-daily/...` -- the MAIN checkout. `new-writer.ps1`
// rewrites both targets at the writer's worktree when it provisions the home,
// and the comment here USED TO claim the copy therefore already carried the
// rewrite. That was FALSE: this driver deletes the provisioned profile and
// re-copies the REPOSITORY one, which restores the main-checkout links.
//
// MEASURED CONSEQUENCE of that bug, first run: the boot resolved
// `dsh-daily-work` to `D:\DSH\work\dsh-native-daily\packages\dsh-daily-work`,
// whose BUILT `lib/artifacts.js` still contains the F4 deep import
// (`import { publishImmutableObjectStream } from
// '@deepseek-ai/dsh-attachment-local/src/store.ts'`, main checkout line 73), and
// whose `daily-work-command` row failed to activate. The driver reported a FAIL
// on the graph clause and on the first tool call -- a measurement of the MAIN
// checkout presented as a measurement of this tree. That is exactly the
// stale-artifact defect class (G-SEAM-29/36) the brief names, produced here by
// the driver's own file copy.
//
// So the rewrite is REPRODUCED here, in the same shape the provisioner uses, and
// then ASSERTED. A reader can see which physical packages the boot loaded.
// ═══════════════════════════════════════════════════════════════════════════
const pkgJsonPath = `${PROFILE_DIR}/package.json`
const pkgText = readFileSync(pkgJsonPath, 'utf8')
const rewrittenText = pkgText.replaceAll('D:/DSH/work/dsh-native-daily', REPO)
const rewriteHappened = rewrittenText !== pkgText
writeFileSync(pkgJsonPath, rewrittenText, 'utf8')

const installedPkg = JSON.parse(readFileSync(pkgJsonPath, 'utf8'))
const linkTargets = Object.entries(installedPkg.dependencies ?? {}).map(([k, v]) => ({ name: k, target: String(v) }))
const linksPointHere = linkTargets.every(entry => entry.target.includes('wt-s4'))
say(`profile links: ${linkTargets.map(e => `${e.name}=${e.target}`).join(' | ')}`)
say(`profile links were REWRITTEN at this worktree: ${String(rewriteHappened)}; all point here: ${String(linksPointHere)}`)
if (!linksPointHere || !rewriteHappened) {
  // Refusing loudly is the point: a boot that resolves another checkout is not a
  // measurement of this tree, and proceeding would file a verdict about code this
  // writer does not own.
  say('REFUSING: the profile does not link this worktree, so any verdict would describe another checkout.')
  process.exit(3)
}

const repoPatchSha = sha(`${PROFILE_SRC}/cordis.patch.yml`)
const installedPatchSha = sha(`${PROFILE_DIR}/cordis.patch.yml`)
say(`profile installed: repo patch ${String(repoPatchSha).slice(0, 16)}... installed ${String(installedPatchSha).slice(0, 16)}... equal=${String(repoPatchSha === installedPatchSha)}`)

let installResult
try {
  const stdout = execFileSync(process.execPath, [LAUNCHER, 'plugin', '--profile', PROFILE_NAME, 'install'], {
    cwd: PROFILE_DIR, env: { ...process.env, DSH_HOME: HOME }, encoding: 'utf8', timeout: 300_000,
  })
  installResult = { exitCode: 0, stdoutTail: stdout.slice(-1500), error: null }
} catch (error) {
  installResult = {
    exitCode: error.status ?? null,
    error: String(error.message.split('\n')[0]),
    stdoutTail: String(error.stdout ?? '').slice(-1500),
    stderrTail: String(error.stderr ?? '').slice(-1500),
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
  // A FOREIGN cwd: neither the repo nor the profile directory.
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

const norm = value => String(value).replace(/\\/g, '/')

/**
 * Classify a resolved URL by the FILE IT NAMES.
 *
 * COPIED FROM V1's id01-driver.mjs VERBATIM, because the classification IS part
 * of the oracle and re-inventing it would be re-inventing the question. The
 * first version of THIS driver used a `/src/` substring fallback and immediately
 * produced three false FAILs: every path inside the pinned checkout contains a
 * `src` segment (the checkout is `D:\DSH\src\dsh-src`), so `vendor/cordis/lib/…`
 * and `node_modules/…` were both reported as SOURCE resolutions.
 *
 * A URL is SOURCE only when the file it names ends in `.ts`; BUILT only when it
 * names a `lib/*.js|mjs|cjs` at ANY DEPTH (the build emits a nested `lib/types/`
 * tree). Anything else is OTHER and reported rather than guessed at.
 */
function classifyUrl(url) {
  const path = String(url).replace(/^file:\/\/\//, '').replace(/\//g, '\\')
  if (/\.ts$/i.test(path)) return { kind: 'SOURCE', path }
  if (/\\lib\\.*\.(js|mjs|cjs)$/i.test(path)) return { kind: 'BUILT', path }
  return { kind: 'OTHER', path }
}

// Per-SPECIFIER, not per-row: the oracle asks whether a specifier resolved under
// `packages\*\lib\` and whether the graph MIXES src and lib, and both are
// properties of the specifier's resolution rather than of one occurrence.
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
const outsideCheckout = graph.filter(row => !String(row.path).toLowerCase().startsWith(norm(DSH_SRC).replace(/\//g, '\\').toLowerCase()))
const mixedSpecifiers = graph.filter(row => row.mixedWithinSpecifier === true)
const jsonManifestReads = graph.filter(r => r.kind === 'OTHER' && /package\.json$/i.test(r.path))
const otherUnclassified = graph.filter(r => r.kind === 'OTHER' && !/package\.json$/i.test(r.path))

// ---------------------------------------------------------------------------
// (5) THE CHECKS, judged here rather than in the harness.
// ---------------------------------------------------------------------------
const lock = JSON.parse(readFileSync(`${REPO}/compatibility.lock.json`, 'utf8'))
const lockedArtifactSha = lock.deployment?.inputs?.artifact_sha256 ?? null
const lockedRealpath = lock.deployment?.inputs?.launcher_realpath ?? null
const launcherSha = sha(LAUNCHER)

const checks = []
const check = (name, ok, observed) => { checks.push({ name, ok, observed }); say(`${ok ? 'ok  ' : 'FAIL'} ${name}${observed === undefined ? '' : `\n       observed: ${typeof observed === 'string' ? observed : JSON.stringify(observed)}`}`) }

check('the probe wrote its result', probe !== null, probeReadError ?? undefined)
if (probe !== null) {
  check('the result names the home this driver booted', true, readResult(OUT, HOME).roots.join(' | '))
  check('the probe recorded no error', (probe.errors ?? []).length === 0, probe.errors)
  check('the installed profile patch is the repository one', repoPatchSha === installedPatchSha)
  check('every rebuilt package compiled', rebuilds.every(r => r.exitCode === 0), rebuilds.map(r => `${r.package}=${String(r.exitCode)}`))
  check('the built lib/ is newer than src/, so the boot is not running a stale build', Object.values(buildFreshness).every(f => f.libNewerThanSrc === true), Object.fromEntries(Object.entries(buildFreshness).map(([k, v]) => [k, { lib: v.newestLibMtime, src: v.newestSrcMtime }])))
  check('sha256 of the launcher equals deployment.inputs.artifact_sha256', launcherSha === lockedArtifactSha, { launcherSha256: launcherSha, lockedArtifactSha256: lockedArtifactSha })
  const li = probe.launcherIdentity ?? {}
  check('the probe confirms the running process IS that launcher', li.runningMatchesLockedRealpath === true && li.launcherSha256MatchesLockedArtifact === true, { runningArgv1Realpath: li.runningArgv1Realpath, lockedRealpath: li.lockedRealpath, runningMatchesLockedRealpath: li.runningMatchesLockedRealpath, launcherSha256MatchesLockedArtifact: li.launcherSha256MatchesLockedArtifact })
  check('the boot did not time out', boot.timedOut === false)
  check('the host was killed and the port released', boot.portReleased === true)
  const ftc = probe.firstToolCall ?? {}
  check('a real Session was created', ftc.sessionCreated === true, { sessionId: ftc.sessionId, agentPreset: ftc.agentPreset })
  check('the turn completed rather than hanging', ftc.turnTimedOut === false, { turnWaitMs: ftc.turnWaitMs, turnTimedOut: ftc.turnTimedOut, turnEndReason: ftc.turnEndReason })
  check('the first tool call SUCCEEDED', ftc.firstCallSucceeded === true, { toolCallRequested: ftc.toolCallRequested, toolResultSeen: ftc.toolResultSeen, toolResultIsError: ftc.toolResultIsError, turnEndReason: ftc.turnEndReason })
  check("the tool result carries the file's own text, so the call reached a real tool body", typeof ftc.toolResultText === 'string' && ftc.toolResultText.includes(FIRST_CALL_TEXT), { expected: FIRST_CALL_TEXT, observed: ftc.toolResultText })
  check('the success is not merely `--help`', boot.stdout.includes('--help') === false && ftc.sessionCreated === true && ftc.firstCallSucceeded === true)
  check('the turn did NOT die on the module-identity symptom', ftc.identityDefectSymptom?.startsWith('absent') === true, ftc.identityDefectSymptom)
  check('the singleton verdict is a single BUILT instance per peer', probe.singletonVerdict?.pass === true, probe.singletonVerdict)
}

check('the graph was recorded and is non-empty', graphRows.length > 0, { rows: graphRows.length, graphReadError })
// THE CLAUSE v1 FAILED ON, CARRIED VERBATIM.
check('no @deepseek-ai specifier resolved to a source (.ts) file', fromSource === 0, { fromBuilt, fromSource, fromOther, offenders: graph.filter(r => r.kind === 'SOURCE').map(r => [r.specifier, r.path]) })
check('no specifier resolved to two different files (no mixed graph within a specifier)', mixedSpecifiers.length === 0, mixedSpecifiers.map(r => [r.specifier, r.path, r.alsoResolvedTo]))
check('every resolved file is inside the pinned checkout', outsideCheckout.length === 0, outsideCheckout.map(r => [r.specifier, r.path]))
// `fromOther` is expected to hold ONE row: `@deepseek-ai/dsh-web-frontend/package.json`
// -> `apps/web/package.json`, a manifest read rather than a module load. It is
// EXCLUDED BY NAME and the exclusion is asserted to be exactly that one row --
// a blanket `fromOther === 0` would hide a real unclassified row, and a blanket
// tolerance would hide a genuine stray. Both halves are checked.
check('the only non-lib resolution is the web app manifest read', otherUnclassified.length === 0 && jsonManifestReads.length <= 1, { manifestReads: jsonManifestReads.map(r => [r.specifier, r.path]), unclassified: otherUnclassified.map(r => [r.specifier, r.path]) })
check('the resolved files sit under the checkout lib/ trees (packages, vendor or node_modules)', fromBuilt === underPackagesLib + underVendorLib + underNodeModules, { fromBuilt, packages: underPackagesLib, vendor: underVendorLib, node_modules: underNodeModules })

const failed = checks.filter(c => !c.ok)
say('')
say(`graph: ${String(graphRows.length)} resolution lines, ${String(graph.length)} distinct @deepseek-ai specifiers`)
say(`  from BUILT: ${String(fromBuilt)}  SOURCE: ${String(fromSource)}  OTHER: ${String(fromOther)}`)
say(`  under packages\\*\\lib\\: ${String(underPackagesLib)}  vendor\\*\\lib\\: ${String(underVendorLib)}  node_modules: ${String(underNodeModules)}`)
say(`checks_passed: ${String(checks.length - failed.length)}/${String(checks.length)}`)
say(`verdict: ${failed.length === 0 ? 'PASS' : 'FAIL'}`)

const verdict = {
  case_id: 'ID-01',
  measured_at: new Date().toISOString(),
  worktree: REPO,
  branch: (() => { try { return execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: REPO, encoding: 'utf8' }).trim() } catch { return null } })(),
  head: (() => { try { return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO, encoding: 'utf8' }).trim() } catch { return null } })(),
  home: HOME,
  launcher: LAUNCHER,
  instrument: {
    this_driver: sha(`${REPO}/qualification/results/S4-v2-rejudge/probe/s4-id01-driver.mjs`),
    this_probe: sha(`${REPO}/qualification/results/S4-v2-rejudge/probe/s4-id01-probe.mjs`),
    this_recorder: sha(RECORDER),
    this_adapter: sha(`${REPO}/qualification/results/S4-v2-rejudge/probe/s4-id01-adapter.mjs`),
    v1_original_probe: sha(`${REPO}/qualification/results/T17-identity/probe-plugin.mjs`),
    v1_original_adapter: sha(`${REPO}/qualification/results/T17-identity/first-call-adapter.mjs`),
  },
  rebuilds,
  buildFreshness,
  profile: { links: linkTargets, linksPointHere, repoPatchSha, installedPatchSha },
  boot: { port: boot.port, portReleased: boot.portReleased, timedOut: boot.timedOut, exitCode: boot.exitCode },
  graph: {
    rows: graphRows.length,
    distinctSpecifiers: graph.length,
    fromBuilt,
    fromSource,
    fromOther,
    underPackagesLib,
    underVendorLib,
    underNodeModules,
    sourceResolutions: graph.filter(r => r.kind === 'SOURCE'),
    mixedSpecifiers: mixedSpecifiers.map(r => [r.specifier, r.path, r.alsoResolvedTo]),
    outsideCheckout: outsideCheckout.map(r => [r.specifier, r.path]),
    jsonManifestReads: jsonManifestReads.map(r => [r.specifier, r.path]),
    otherUnclassified: otherUnclassified.map(r => [r.specifier, r.path]),
  },
  checks,
  checksPassed: checks.length - failed.length,
  checksTotal: checks.length,
  verdict: failed.length === 0 ? 'PASS' : 'FAIL',
}
writeFileSync(`${RUN_DIR}/verdict.json`, `${JSON.stringify(verdict, null, 2)}\n`, 'utf8')
writeFileSync(`${RUN_DIR}/transcript.txt`, `${transcript.join('\n')}\n`, 'utf8')
say(`artifact: ${RUN_DIR}/verdict.json`)
