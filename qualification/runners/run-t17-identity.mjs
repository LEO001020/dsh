/**
 * T17 IDENTITY-gate driver: boot a real host and collect the identity probe.
 *
 * WHY THIS FILE EXISTS SEPARATELY FROM THE PROBE.
 * The probe (`qualification/results/T17-identity/probe-plugin.mjs`) runs INSIDE
 * the host's Cordis context and can only see what a plugin can see. The facts
 * that are about the BOOT rather than about the graph -- which launcher binary
 * was spawned, which installed profile patch was read, whether the port came
 * back after the kill -- are only visible from outside. `boot-harness.mjs` owns
 * those mechanics so this driver does not reimplement them, and does not guess a
 * port (3080 was held by a stray probe twice on this machine, and a collision
 * produces `EADDRINUSE` -> "2 required plugins did not activate", which looks
 * like a composition failure and is only a port conflict).
 *
 * WHY IT INSTALLS ITS OWN HOME.
 * A sibling agent's measurement today was invalidated by a STALE INSTALL: the
 * installed profile patch under `$DSH_HOME/profiles/daily/` is a COPY, and on
 * this machine three homes hold three different revisions of it (measured:
 * `t2-fs` = 3755f904, `t4-preset` and `t-root` = 59f23346, `t3-shell` =
 * 5b8b2a8e). Booting any of them measures that home's copy, not this tree. So
 * this driver installs a FRESH profile from the repository and records both
 * digests, which makes "the installed copy matched the repository" a measured
 * fact in the artifact rather than an assumption.
 *
 * WHY IT REBUILDS BEFORE MEASURING.
 * Every home installs the extension packages through a `link:`, so the boot
 * executes the BUILT `lib/`, never `src/`. A `lib/` older than its `src/` means
 * the measurement describes a previous build. The rebuild is therefore part of
 * the measurement, and its result is recorded.
 *
 * Usage: node qualification/runners/run-t17-identity.mjs
 */
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { bootAndWait, readResult, DSH_SRC, LAUNCHER } from './boot-harness.mjs'

const REPO = 'D:/DSH/work/dsh-native-daily'
const HOME = 'D:/DSH/home/t17-identity'
const PROFILE_SRC = `${REPO}/profiles/daily-candidate`
/** The profile's INSTALL name. Chosen by the operator and referenced nowhere. */
const PROFILE_NAME = 'daily'
const PROFILE_DIR = `${HOME}/profiles/${PROFILE_NAME}`
const RESULT_DIR = `${REPO}/qualification/results/T17-identity`
const RUN_DIR = `${RESULT_DIR}/runs/built-launcher`
const OUT = `${RUN_DIR}/boot.json`
const OVERLAY = `${RESULT_DIR}/overlays/smoke-overlay.yml`
const SESSION_ROOT = `${RUN_DIR}/sessions`
const TURN_TIMEOUT_MS = 45_000
/** The file the gate's first-call adapter asks the `read` tool to open. */
const FIRST_CALL_FILE = `${RUN_DIR}/first-call-input.txt`
/** The exact text written there, so the tool result is checkable by a reader. */
const FIRST_CALL_TEXT = 'T17_FIRST_TOOL_CALL_ROUND_TRIP'

mkdirSync(RUN_DIR, { recursive: true })
mkdirSync(SESSION_ROOT, { recursive: true })
// Written BEFORE the boot: the adapter reads the path from the environment at
// module load, and a missing file would make the first call fail in the tool
// body for a reason unrelated to identity.
writeFileSync(FIRST_CALL_FILE, `${FIRST_CALL_TEXT}\n`, 'utf8')

const transcript = []
const say = line => { transcript.push(line); console.log(line) }

say('=== T17 IDENTITY: the running host\'s module identity ===')
say(`repo:     ${REPO}`)
say(`checkout: ${DSH_SRC}`)
say(`home:     ${HOME}`)
say(`launcher: ${LAUNCHER}`)
say(`probe_out:${OUT}`)

// ---------------------------------------------------------------------------
// (0) REBUILD, so the measurement describes THIS tree's source.
// ---------------------------------------------------------------------------
const rebuilds = []
for (const pkg of ['packages/dsh-daily-work', 'packages/dsh-ipython']) {
  const cwd = `${REPO}/${pkg}`
  const started = Date.now()
  try {
    // NOTE (F10): this uses `tsconfig.json` -- the BUILD config -- on purpose, and it
    // is NOT the typecheck gate. The build must EXCLUDE `src/**/*.test.ts` so test
    // code never emits into `lib/`, which is exactly why `tsconfig.json` cannot be
    // cited as evidence that "the tests type-check": it exits 0 with or without a
    // test file present. The official typecheck is `pnpm typecheck`, which drives
    // `tsconfig.check.json` (exclude cleared, `noEmit`) across every package. This
    // call is here to REBUILD `lib/` so the measurement below describes this tree's
    // source; it must not be read as a compiler gate.
    execFileSync(process.execPath, [`${DSH_SRC}/node_modules/typescript/bin/tsc`, '-p', 'tsconfig.json'], {
      cwd, stdio: 'pipe', timeout: 300_000,
    })
    rebuilds.push({ package: pkg, exitCode: 0, ms: Date.now() - started, error: null })
  } catch (error) {
    rebuilds.push({
      package: pkg,
      exitCode: error.status ?? null,
      ms: Date.now() - started,
      error: `${error.message.split('\n')[0]}`,
      stderr: String(error.stderr ?? '').slice(-4000),
    })
  }
}
for (const row of rebuilds) {
  say(`rebuild ${row.package}: exit=${String(row.exitCode)} in ${String(row.ms)}ms${row.error === null ? '' : ` -- ${row.error}`}`)
}

/** Digest every built artifact this boot will load, so a stale build is visible. */
const BUILD_DIGESTS = {}
for (const pkg of ['dsh-daily-work', 'dsh-ipython']) {
  const dir = `${REPO}/packages/${pkg}/lib`
  const digest = createHash('sha256')
  const files = []
  if (existsSync(dir)) {
    // Non-recursive on purpose: the build output is flat, and a recursive walk
    // here would be an unbounded filesystem scan for no gain.
    for (const name of readdirSync(dir).sort()) {
      if (!name.endsWith('.js')) continue
      digest.update(name)
      digest.update(readFileSync(`${dir}/${name}`))
      files.push(name)
    }
  }
  BUILD_DIGESTS[pkg] = { fileCount: files.length, digest: digest.digest('hex') }
}

// ---------------------------------------------------------------------------
// (1) FRESH INSTALL of the profile from the repository, so this boot measures
//     the repository's composition and not a previous agent's copy.
// ---------------------------------------------------------------------------
const installedBefore = existsSync(`${PROFILE_DIR}/cordis.patch.yml`)
if (existsSync(`${HOME}/profiles/${PROFILE_NAME}`)) rmSync(`${PROFILE_DIR}`, { recursive: true, force: true })
mkdirSync(`${HOME}/profiles`, { recursive: true })
cpSync(PROFILE_SRC, PROFILE_DIR, { recursive: true })
say(`profile installed: ${PROFILE_SRC} -> ${PROFILE_DIR} (replaced an existing copy: ${String(installedBefore)})`)

const sha = path => existsSync(path)
  ? createHash('sha256').update(readFileSync(path)).digest('hex')
  : null
const repoPatchSha = sha(`${PROFILE_SRC}/cordis.patch.yml`)
const installedPatchSha = sha(`${PROFILE_DIR}/cordis.patch.yml`)
say(`repo profile patch      sha256: ${repoPatchSha}`)
say(`installed profile patch sha256: ${installedPatchSha}`)

// `plugin install` materialises `node_modules` for the `link:` dependencies.
// Without it the profile's bundles do not resolve and the boot fails with
// `cannot resolve profile bundle "dsh-daily-work"` -- which is a property of the
// install step, not of the composition.
let installResult
try {
  const stdout = execFileSync(process.execPath, [LAUNCHER, 'plugin', '--profile', PROFILE_NAME, 'install'], {
    cwd: PROFILE_DIR,
    env: { ...process.env, DSH_HOME: HOME },
    encoding: 'utf8',
    timeout: 300_000,
  })
  installResult = { exitCode: 0, stdoutTail: stdout.slice(-2000), error: null }
} catch (error) {
  installResult = {
    exitCode: error.status ?? null,
    stdoutTail: String(error.stdout ?? '').slice(-2000),
    error: String(error.message.split('\n')[0]),
    stderrTail: String(error.stderr ?? '').slice(-2000),
  }
}
say(`plugin install: exit=${String(installResult.exitCode)}${installResult.error === null ? '' : ` -- ${installResult.error}`}`)

// ---------------------------------------------------------------------------
// (2) BOOT the real host with the probe mounted, on a harness-chosen free port.
// ---------------------------------------------------------------------------
const boot = await bootAndWait({
  home: HOME,
  profile: PROFILE_NAME,
  patches: [OVERLAY],
  outPath: OUT,
  // A FOREIGN cwd: neither the repo nor the profile directory. The preset root
  // is `!!js new URL('presets/', ctx.baseUrl)...`, and an earlier revision was
  // cwd-relative and resolved only from inside the profile directory (G-FIX-13).
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
  },
})

mkdirSync(`${RUN_DIR}/workspace`, { recursive: true })

say('')
say(`port: ${String(boot.port)}  portReleased: ${String(boot.portReleased)}  timedOut: ${String(boot.timedOut)}  exitCode: ${String(boot.exitCode)}`)
say(`boot cwd: C:/Windows/Temp`)

writeFileSync(`${RUN_DIR}/boot-stdout.txt`, boot.stdout, 'utf8')
writeFileSync(`${RUN_DIR}/boot-stderr.txt`, boot.stderr, 'utf8')

// ---------------------------------------------------------------------------
// (3) READ the result, and ASSERT it describes the home this driver booted.
//     `readResult` is the guard against the fixed-output-path false PASS.
// ---------------------------------------------------------------------------
let probe = null
let probeReadError = null
try {
  probe = readResult(OUT, HOME).json
} catch (error) {
  probeReadError = error instanceof Error ? error.message : String(error)
}

const checks = []
/**
 * Record one assertion. `ok` is compared with `=== true` rather than coerced, so
 * a `null` measurement can never read as a pass.
 * @param label - what was asserted, phrased so a reader can falsify it.
 * @param ok - the measured outcome.
 * @param detail - the measurement, recorded on BOTH branches.
 */
function check(label, ok, detail) {
  checks.push({ label, ok: ok === true, detail })
}

check('the probe wrote its result', probe !== null, probeReadError ?? `probe present: ${String(probe !== null)}`)
check('the result names the home this driver booted', probeReadError === null,
  probeReadError ?? `roots: ${JSON.stringify((probe?.presetRoots ?? []).map(r => r.path))}`)
check('the probe recorded no error', (probe?.errors ?? []).length === 0, JSON.stringify(probe?.errors ?? null))
check('the installed profile patch is the repository one', installedPatchSha === repoPatchSha,
  `installed ${String(installedPatchSha)} vs repo ${String(repoPatchSha)}`)
check('the probe confirms the installed copy matched the repository',
  probe?.installedProfilePatch?.installedMatchesRepo === true,
  JSON.stringify(probe?.installedProfilePatch ?? null))
check('the loader tree settled before the probe sampled it', probe?.settle?.settled === true,
  `settled=${String(probe?.settle?.settled)} waitedMs=${String(probe?.settle?.waitedMs)} stillMoving=${JSON.stringify(probe?.settle?.stillMoving ?? null)}`)
check('the host was killed and the port released', boot.portReleased === true, `portReleased: ${String(boot.portReleased)}`)
check('the boot did not time out', boot.timedOut === false, `timedOut: ${String(boot.timedOut)}`)

// The identity gate proper.
const verdict = probe?.singletonVerdict ?? null
check('every shared package resolved to ONE physical copy', verdict?.pass === true, JSON.stringify(verdict))
check('no shared package came from a third copy', (verdict?.hostInstancesFromNeitherCandidate ?? []).length === 0,
  JSON.stringify(verdict?.hostInstancesFromNeitherCandidate ?? null))
check('the tree does not mix src and lib', verdict?.mixedSourceAndBuilt === false,
  `fromBuilt=${String(verdict?.hostInstancesFromBuiltEntry)} fromSource=${String(verdict?.hostInstancesFromSourceEntry)}`)

// The symbol identity: the root cause.
const symbol = probe?.symbolIdentity ?? null
check('the scheduler symbol is declared with Symbol(), not Symbol.for()', symbol?.declarationKind === 'Symbol',
  `declarationKind=${JSON.stringify(symbol?.declarationKind)} evidence=${JSON.stringify(symbol?.declarationKindEvidence)}`)
check('the host\'s ToolRuntime answers the LIB copy of the scheduler symbol',
  symbol?.hostInstanceHasLibSymbol === true, `hostInstanceHasLibSymbol: ${JSON.stringify(symbol?.hostInstanceHasLibSymbol)}`)
check('the host\'s ToolRuntime does NOT answer the SRC copy of the scheduler symbol',
  symbol?.hostInstanceHasSrcSymbol === false, `hostInstanceHasSrcSymbol: ${JSON.stringify(symbol?.hostInstanceHasSrcSymbol)}`)
check('the scheduler object carries all four methods', symbol?.hostInstanceSchedulerUsable === true,
  JSON.stringify(symbol?.hostInstanceSchedulerMethods ?? null))

// The first tool call.
const first = probe?.firstToolCall ?? null
check('a real Session was created for the first-tool-call measurement', first?.sessionCreated === true,
  `sessionId: ${JSON.stringify(first?.sessionId)}`)
check('the model is offered a non-empty catalog', (first?.toolCountAgentKey ?? 0) > 0,
  `toolCountAgentKey: ${String(first?.toolCountAgentKey)} firstTool: ${JSON.stringify(first?.firstToolOffered)}`)
check('the agent-keyed view is non-empty while the context-keyed view is empty (G-FIX-06)',
  (first?.toolCountAgentKey ?? 0) > 0 && first?.toolCountContextKey === 0,
  `agentKey=${String(first?.toolCountAgentKey)} contextKey=${String(first?.toolCountContextKey)}`)
check('the prompt was admitted', first?.promptAccepted === true, `promptAccepted: ${String(first?.promptAccepted)} rejection: ${JSON.stringify(first?.promptRejection)}`)
check('the turn completed rather than hanging', first?.turnTimedOut === false, `turnTimedOut: ${String(first?.turnTimedOut)} waitedMs: ${String(first?.turnWaitMs)}`)
check('the first call named the tool the adapter asked for',
  first?.toolCallRequested?.name === 'read', `toolCallRequested: ${JSON.stringify(first?.toolCallRequested)}`)
check('the first tool call SUCCEEDED', first?.firstCallSucceeded === true,
  `isError=${JSON.stringify(first?.toolResultIsError)} errorCode=${JSON.stringify(first?.toolResultErrorCode)} text=${JSON.stringify(first?.toolResultText)}`)
check('the tool result carries the file\'s own text, so the call reached a real tool body',
  typeof first?.toolResultText === 'string' && first.toolResultText.includes(FIRST_CALL_TEXT),
  `expected substring ${JSON.stringify(FIRST_CALL_TEXT)} in ${JSON.stringify(first?.toolResultText)}`)
check('the turn did NOT die on the module-identity symptom',
  first?.turnEndErrorMessage === null || !String(first.turnEndErrorMessage).includes("reading 'prepare'"),
  `turnEndReason=${JSON.stringify(first?.turnEndReason)} error=${JSON.stringify(first?.turnEndErrorMessage)} code=${JSON.stringify(first?.turnEndErrorCode)}`)

// The launcher identity.
const launcher = probe?.launcherIdentity ?? null
check('the recorded launcher_realpath carries no control characters',
  (launcher?.lockedRealpathControlChars ?? ['missing']).length === 0,
  JSON.stringify(launcher?.lockedRealpathControlChars ?? null))
check('the launcher on disk matches the recorded artifact_sha256',
  launcher?.launcherSha256MatchesLockedArtifact === true,
  `onDisk=${JSON.stringify(launcher?.launcherSha256)} pinned=${JSON.stringify(launcher?.lockedArtifactSha256)}`)
check('the running process IS the launcher the lock names',
  launcher?.runningMatchesLockedRealpath === true,
  `argv1=${JSON.stringify(launcher?.runningArgv1Realpath)} locked=${JSON.stringify(launcher?.lockedRealpath)}`)
check('the recorded identity recomputes from its inputs under the declared algorithm',
  launcher?.identityRecomputes === true,
  `recorded=${JSON.stringify(launcher?.identityRecorded)} recomputed=${JSON.stringify(launcher?.identityRecomputed)} algorithm=${JSON.stringify(launcher?.identityAlgorithm)}`)

// COVERAGE. A digest that recomputes over a value that has since moved proves
// the wrong thing, so each file-named input is checked against disk separately.
const coverage = launcher?.inputCoverage ?? {}
const staleInputs = Object.entries(coverage).filter(([, row]) => row.matches !== true).map(([key]) => key)
check('every file-named identity input still matches the file on disk', staleInputs.length === 0,
  `stale or unreadable: ${JSON.stringify(staleInputs)}; rows: ${JSON.stringify(coverage)}`)

const failures = checks.filter(row => !row.ok)
const verdictWord = probeReadError !== null ? 'BLOCKED' : failures.length === 0 ? 'PASS' : 'FAIL'

const artifact = {
  driver: 'run-t17-identity',
  ranAt: new Date().toISOString(),
  home: HOME,
  profileName: PROFILE_NAME,
  profileSource: PROFILE_SRC,
  overlay: OVERLAY,
  launcher: LAUNCHER,
  launcherSha256: sha(LAUNCHER),
  bootCwd: 'C:/Windows/Temp',
  port: boot.port,
  portReleased: boot.portReleased,
  timedOut: boot.timedOut,
  exitCode: boot.exitCode,
  rebuilds,
  buildDigests: BUILD_DIGESTS,
  pluginInstall: installResult,
  profilePatchDigests: { repo: repoPatchSha, installed: installedPatchSha },
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
say(`checks_passed: ${String(checks.length - failures.length)}/${String(checks.length)}`)
say(`verdict: ${verdictWord}`)
say(`artifact: ${RUN_DIR}/verdict.json`)
if (probe !== null) {
  say('')
  say(`toolCount (agent key): ${String(probe.firstToolCall?.toolCountAgentKey)}  first tool: ${JSON.stringify(probe.firstToolCall?.firstToolOffered)}`)
  say(`singleton: ${JSON.stringify(probe.singletonVerdict)}`)
  say(`turn end: reason=${JSON.stringify(probe.firstToolCall?.turnEndReason)} error=${JSON.stringify(probe.firstToolCall?.turnEndErrorMessage)}`)
}

process.exit(verdictWord === 'PASS' ? 0 : 1)
