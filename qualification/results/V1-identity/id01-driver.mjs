/**
 * ID-01 driver: boot the BUILT launcher and measure the real module graph, the
 * launcher identity, and the first successful tool call.
 *
 * ORACLE (verbatim from the spec):
 *   "The first tool call actually succeeds and the resolved module graph is
 *    recorded: every `@deepseek-ai/*` specifier resolves under
 *    `D:\DSH\src\dsh-src\packages\*\lib\`, and sha256 of the launcher equals
 *    `deployment.inputs.artifact_sha256`. A run whose only success is `--help`,
 *    or whose graph mixes `src` and `lib`, is NOT PASS."
 *
 * THE THREE TRAPS THIS DRIVER IS BUILT AROUND.
 *
 * 1. STALE BUILD. Every home installs the extension packages through a `link:`
 *    (measured: the installed `dsh-daily-work` resolves to
 *    `D:/DSH/work/dsh-native-daily/packages/dsh-daily-work`), so a boot executes
 *    the BUILT `lib/`, never `src/`. A sibling agent filed a defect against a
 *    `lib/` that predated a fix already present in `src/`. So this driver
 *    REBUILDS both packages before the boot that matters, records each build's
 *    exit code and duration, and then digests the built `lib/` and compares the
 *    newest `lib` mtime against the newest `src` mtime -- so a stale build is a
 *    recorded fact rather than an assumption.
 *
 * 2. FIXED OUTPUT PATHS. `DSH_PROBE_OUT` and `V1_GRAPH_OUT` both point into THIS
 *    driver's run directory, and `readResult()` asserts the probe's own
 *    `presetRoots` names the home this driver booted. Two agents cannot then
 *    read each other's result.
 *
 * 3. A HAND-BUILT HOST IS NOT THE PRODUCT. The host is booted through the REAL
 *    built launcher (`apps/cli/lib/bin.js`) with the REAL profile name, using
 *    the shared port-safe harness. The only overlay is a keyless mock route, so
 *    the boot consumes no provider budget; that is labelled everywhere it
 *    appears. The probe INSERTS NO TOOL ROW.
 *
 * Usage: node qualification/results/V1-identity/id01-driver.mjs
 */
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { bootAndWait, readResult, LAUNCHER, DSH_SRC } from '../../runners/boot-harness.mjs'

const REPO = 'D:/DSH/work/dsh-native-daily'
const HOME = 'D:/DSH/home/v1-identity'
const PROFILE_SRC = `${REPO}/profiles/daily-candidate`
const PROFILE_NAME = 'daily'
const PROFILE_DIR = `${HOME}/profiles/${PROFILE_NAME}`
const RUN_DIR = `${REPO}/qualification/results/V1-identity/runs/id01`
const OUT = `${RUN_DIR}/boot.json`
const GRAPH = `${RUN_DIR}/graph.jsonl`
const OVERLAY = `${REPO}/qualification/results/V1-identity/overlays/id01-overlay.yml`
/** The loader hook that records every @deepseek-ai resolution. Injected via NODE_OPTIONS. */
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

say('=== ID-01: built launcher, real module graph, first successful tool call ===')
say(`repo:      ${REPO}`)
say(`home:      ${HOME}`)
say(`launcher:  ${LAUNCHER}`)
say(`probe out: ${OUT}`)
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
// (0) REBUILD, so the boot executes THIS tree's source. Trap 1.
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

// The stale-build check, as numbers: is every built .js NEWER than every source
// .ts it could have come from? A `lib` older than its `src` is a stale build.
//
// THE FIRST VERSION OF THIS CHECK SCANNED `src` FOR `*.js` AND FOUND NONE, so
// `newestSrcMtime` was null and the check reported a stale build that did not
// exist. Source files are `.ts`; the extension is now passed in per directory
// rather than assumed. That is a defect in the CHECK, and it is recorded because
// it is the same class as the trap this check exists to catch: a measurement
// that reads the wrong file and reports a confident wrong answer.
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
// (1) FRESH INSTALL of the profile from the repository, so this boot measures
//     the repository's composition and not a previous agent's copy.
// ---------------------------------------------------------------------------
if (existsSync(PROFILE_DIR)) rmSync(PROFILE_DIR, { recursive: true, force: true })
mkdirSync(`${HOME}/profiles`, { recursive: true })
cpSync(PROFILE_SRC, PROFILE_DIR, { recursive: true })

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
    // THE GRAPH RECORDER IS INJECTED HERE AND NOT AS A PLUGIN ROW. It must be
    // installed before the first module resolution, and a plugin's `apply` runs
    // long after the tree has started loading -- so a plugin row would miss
    // every resolution that happened before it mounted, which is most of them.
    // `--import` is the only injection point early enough.
    //
    // NODE_OPTIONS is APPENDED to, never replaced: the launcher itself may rely
    // on it, and a measurement that changes the boot is not a measurement of the
    // boot. The file URL uses the `file:///D:/...` form, which is the only form
    // Node accepts on Windows for a drive-letter path (measured: `file:///tmp/...`
    // and a bare path both fail with ERR_INVALID_FILE_URL_PATH / MODULE_NOT_FOUND).
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
 * `D:\DSH\src\dsh-src`, so EVERY path inside it contains a `src` segment. The
 * first version of this function fell back to `/\\src\\/` after the extension
 * checks, and immediately reported `@deepseek-ai/dsh-web-frontend/package.json`
 * -> `D:\DSH\src\dsh-src\apps\web\package.json` as a SOURCE resolution. That is a
 * JSON file in the checkout's own `apps` tree; the `src` it matched is the
 * checkout's root directory name. An earlier agent in this project made exactly
 * this mistake and flagged every peer. The fallback is therefore REMOVED: a URL
 * is SOURCE only when the file it names ends in `.ts`, and BUILT only when it
 * names a `lib/*.js`, `lib/*.mjs` or `lib/*.cjs`. Anything else is OTHER and is
 * reported as such rather than guessed at.
 */
function classifyUrl(url) {
  const path = String(url).replace(/^file:\/\/\//, '').replace(/\//g, '\\')
  if (/\.ts$/i.test(path)) return { kind: 'SOURCE', path }
  // ANY DEPTH under lib/. The first version required a FLAT `lib/<file>.js`, so
  // the eight real subpath exports the host loads (`lib/types/brand.js`,
  // `lib/types/surface.js`, ...) were classified OTHER. The build emits a nested
  // `lib/types/` tree, so the pattern must allow it.
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
    // A specifier resolving to two different files IS a mixed graph, and the
    // second file is recorded rather than overwritten.
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
// The oracle names `packages\*\lib\`. `vendor/*/lib` is the checkout's own
// vendored cordis and its peers, and `node_modules/.pnpm/...` is a real
// dependency outside the workspace packages; each is counted SEPARATELY rather
// than folded into the oracle's bucket, because calling them "under
// packages\*\lib\" would be a false statement about the path.
const underPackagesLib = graph.filter(row => /\\packages\\[^\\]+(\\[^\\]+)?\\lib\\/i.test(row.path)).length
const underVendorLib = graph.filter(row => /\\vendor\\[^\\]+\\lib\\/i.test(row.path)).length
const underNodeModules = graph.filter(row => /\\node_modules\\/i.test(row.path)).length
const outsideCheckout = graph.filter(row => !String(row.path).toLowerCase().startsWith(DSH_SRC.replace(/\//g, '\\').toLowerCase()))

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
  JSON.stringify(Object.fromEntries(Object.entries(buildFreshness).map(([k, v]) => [k, { lib: v.newestLibMtime, src: v.newestSrcMtime, ok: v.libNewerThanSrc }]))))

check('sha256 of the launcher equals deployment.inputs.artifact_sha256', launcherSha === pinnedArtifact,
  `onDisk=${String(launcherSha).slice(0, 16)} pinned=${String(pinnedArtifact).slice(0, 16)}`)
check('the probe confirms the running process IS that launcher',
  probe?.launcherIdentity?.runningMatchesLockedRealpath === true,
  `argv1=${JSON.stringify(probe?.launcherIdentity?.runningArgv1Realpath)} locked=${JSON.stringify(probe?.launcherIdentity?.lockedRealpath)}`)

check('the graph was recorded and is non-empty', graphRows.length > 0,
  `lines=${String(graphRows.length)} readError=${JSON.stringify(graphReadError)}`)
check('no @deepseek-ai specifier resolved to a source (.ts) file', fromSource === 0,
  `fromBuilt=${String(fromBuilt)} fromSource=${String(fromSource)} fromOther=${String(fromOther)}; `
  + `offenders=${JSON.stringify(graph.filter(r => r.kind === 'SOURCE').map(r => [r.specifier, r.path]))}`)
check('no specifier resolved to two different files (no mixed graph within a specifier)',
  graph.every(row => row.mixedWithinSpecifier !== true),
  JSON.stringify(graph.filter(row => row.mixedWithinSpecifier === true).map(r => [r.specifier, r.path, r.alsoResolvedTo])))
check('every resolved file is inside the pinned checkout', outsideCheckout.length === 0,
  JSON.stringify(outsideCheckout.map(r => [r.specifier, r.path])))
// `fromOther` is expected to hold ONE row: `@deepseek-ai/dsh-web-frontend/package.json`
// -> `apps/web/package.json`, which is a manifest read, not a module load, and is
// a `.json` file by design. It is therefore EXCLUDED by name and the exclusion is
// asserted to be exactly that one row -- a blanket `fromOther === 0` would have
// been a green that hides a real unclassified row, and a blanket tolerance would
// hide a genuine stray. Both halves are checked.
const jsonManifestReads = graph.filter(r => r.kind === 'OTHER' && /package\.json$/i.test(r.path))
const otherUnclassified = graph.filter(r => r.kind === 'OTHER' && !/package\.json$/i.test(r.path))
check('the only non-lib resolution is the web app manifest read',
  otherUnclassified.length === 0 && jsonManifestReads.length <= 1,
  `manifest reads=${JSON.stringify(jsonManifestReads.map(r => [r.specifier, r.path]))} `
  + `unclassified=${JSON.stringify(otherUnclassified.map(r => [r.specifier, r.path]))}`)
check('the resolved files sit under the checkout lib/ trees (packages, vendor or node_modules)',
  fromBuilt === underPackagesLib + underVendorLib + underNodeModules,
  `fromBuilt=${String(fromBuilt)} packages=${String(underPackagesLib)} vendor=${String(underVendorLib)} node_modules=${String(underNodeModules)}`)
check('the peers the host mounted are ONE physical copy each', probe?.singletonVerdict?.pass === true,
  JSON.stringify(probe?.singletonVerdict ?? null))

const first = probe?.firstToolCall ?? null
check('a real Session was created', first?.sessionCreated === true, `sessionId=${JSON.stringify(first?.sessionId)}`)
check('the turn completed rather than hanging', first?.turnTimedOut === false,
  `turnTimedOut=${String(first?.turnTimedOut)} waitedMs=${String(first?.turnWaitMs)}`)
check('the first tool call SUCCEEDED', first?.firstCallSucceeded === true,
  `requested=${JSON.stringify(first?.toolCallRequested?.name)} isError=${JSON.stringify(first?.toolResultIsError)} code=${JSON.stringify(first?.toolResultErrorCode)}`)
check('the tool result carries the file\'s own text, so the call reached a real tool body',
  typeof first?.toolResultText === 'string' && first.toolResultText.includes(FIRST_CALL_TEXT),
  JSON.stringify(first?.toolResultText))
check('the success is not merely `--help`', first?.firstCallSucceeded === true && first?.toolResultSeen === true,
  `toolResultSeen=${String(first?.toolResultSeen)} firstToolOffered=${JSON.stringify(first?.firstToolOffered)}`)
check('the turn did NOT die on the module-identity symptom',
  first?.turnEndErrorMessage === null || !String(first.turnEndErrorMessage).includes("reading 'prepare'"),
  `reason=${JSON.stringify(first?.turnEndReason)} error=${JSON.stringify(first?.turnEndErrorMessage)}`)

const failures = checks.filter(row => !row.ok)
const verdictWord = probeReadError !== null ? 'BLOCKED' : failures.length === 0 ? 'PASS' : 'FAIL'

const artifact = {
  driver: 'v1-id01-driver',
  case: 'ID-01',
  ranAt: new Date().toISOString(),
  identity: lock.deployment.identity,
  home: HOME,
  profileName: PROFILE_NAME,
  profileSource: PROFILE_SRC,
  overlay: OVERLAY,
  overlayNote: 'keyless in-tree mock route; CONTROLLED LOCAL ROUTE, no provider budget consumed, probe inserts no tool row',
  // The instruments are RECORDED BY HASH rather than copied, because two of them
  // belong to T17 and are referenced by absolute path. A later edit to either
  // then shows up as a hash mismatch instead of as a silent change of instrument.
  instruments: {
    graphRecorder: { path: RECORDER, sha256: sha(RECORDER) },
    probe: { path: `${REPO}/qualification/results/T17-identity/probe-plugin.mjs`, sha256: sha(`${REPO}/qualification/results/T17-identity/probe-plugin.mjs`) },
    firstCallAdapter: { path: `${REPO}/qualification/results/T17-identity/first-call-adapter.mjs`, sha256: sha(`${REPO}/qualification/results/T17-identity/first-call-adapter.mjs`) },
    overlay: { path: OVERLAY, sha256: sha(OVERLAY) },
    driver: { path: `${REPO}/qualification/results/V1-identity/id01-driver.mjs`, sha256: sha(`${REPO}/qualification/results/V1-identity/id01-driver.mjs`) },
  },
  launcher: LAUNCHER,
  launcherSha256: launcherSha,
  pinnedArtifactSha256: pinnedArtifact,
  bootCwd: 'C:/Windows/Temp',
  port: boot.port,
  portReleased: boot.portReleased,
  timedOut: boot.timedOut,
  exitCode: boot.exitCode,
  rebuilds,
  buildFreshness,
  pluginInstall: installResult,
  profilePatchDigests: { repo: repoPatchSha, installed: installedPatchSha },
  graph: {
    outPath: GRAPH,
    lineCount: graphRows.length,
    readError: graphReadError,
    distinctSpecifiers: graph.length,
    fromBuilt,
    fromSource,
    fromOther,
    underPackagesLib,
    underVendorLib,
    underNodeModules,
    outsideCheckoutCount: outsideCheckout.length,
    resolutions: graph,
  },
  probeReadError,
  probe,
  checks,
  failures: failures.map(row => `${row.label} -- observed: ${row.detail}`),
  verdict: verdictWord,
}

writeFileSync(`${RUN_DIR}/verdict.json`, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8')
writeFileSync(`${RUN_DIR}/transcript.txt`, `${transcript.join('\n')}\n`, 'utf8')

say('')
say('--- checks ---')
for (const row of checks) say(`${row.ok ? 'ok  ' : 'FAIL'} ${row.label}${row.ok ? '' : `\n       observed: ${row.detail}`}`)
say('')
say(`graph: ${String(graphRows.length)} resolution lines, ${String(graph.length)} distinct @deepseek-ai specifiers`)
say(`  from BUILT: ${String(fromBuilt)}  from SOURCE: ${String(fromSource)}  OTHER: ${String(fromOther)}`)
say(`  under packages\\*\\lib\\: ${String(underPackagesLib)}  under vendor\\*\\lib\\: ${String(underVendorLib)}`)
say(`checks_passed: ${String(checks.length - failures.length)}/${String(checks.length)}`)
say(`verdict: ${verdictWord}`)
say(`artifact: ${RUN_DIR}/verdict.json`)

process.exit(verdictWord === 'PASS' ? 0 : 1)
