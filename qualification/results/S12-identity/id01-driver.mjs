/**
 * S12 ID-01 driver: boot the BUILT launcher, measure the real module graph, then
 * run the two attacks the oracle names — a swapped build, and a `src/` load.
 *
 * ORACLE (verbatim, `acceptance-spec.trusted-local-v2.definition.json`):
 *
 *   "Boot the built launcher `node apps/cli/lib/bin.js --profile daily-candidate`,
 *    then swap it for a different build or load `src/` instead of `lib/`, and
 *    repeat the first successful tool call."
 *
 *   "The first tool call actually succeeds and the resolved module graph is
 *    recorded: every `@deepseek-ai/*` specifier resolves under
 *    `D:\DSH\src\dsh-src\packages\*\lib\`, and sha256 of the launcher equals
 *    `deployment.inputs.artifact_sha256`. A run whose only success is `--help`, or
 *    whose graph mixes `src` and `lib`, is NOT PASS."
 *
 * WHAT THIS DRIVER IS. R2-F4 measured `fromBuilt: 221, fromSource: 0` on `wt-r2f4`.
 * R5/R4/S1 have since changed the plugin graph, so this RE-MEASURES rather than
 * quoting. It reuses the archived recorder (`V1-identity/id01-graph-recorder.mjs`,
 * unchanged, referenced by absolute path) so the instrument is the proven one.
 *
 * THE THREE ARMS, and why each is needed. The oracle's stimulus is not just "boot
 * and look" — it says "then swap it for a different build or load `src/` instead of
 * `lib/`, and repeat". A gate nobody has watched fail is not evidence (round-2 §3.2).
 * So:
 *
 *   ARM A (baseline)  boot the built launcher, unmodified. Must PASS.
 *   ARM B (attack 1)  boot a DIFFERENT BUILD: the launcher is replaced by a copy of
 *                     another app's built entry, so the bytes are a real, working
 *                     built artifact that is simply not the pinned one. The
 *                     launcher-sha256 clause must FAIL while the graph stays clean —
 *                     which is exactly the discrimination the clause exists for.
 *   ARM C (attack 2)  make the product load `src/` instead of `lib/`: a `src/*.ts`
 *                     deep import is injected into a production source file of this
 *                     repository and REBUILT, so the emitted `lib/` carries it. The
 *                     graph clause must FAIL with a SOURCE row. This is the real
 *                     defect shape F4 had, not a synthetic one.
 *
 * ARM C is the one that matters most and is the one most easily faked: a `src`
 * import in a TEST file proves nothing, and injecting into `lib/` by hand would
 * prove only that the classifier works on hand-made input. ARM C mutates the
 * SOURCE, rebuilds with the project's own compiler, and lets the boot emit the
 * graph — so the row that appears is a row the product really produced.
 *
 * WHAT IT DOES NOT DO. It does not consume provider budget: the overlay disables
 * `llm-deepseek` and routes the model to a keyless local adapter. Every run here is
 * a CONTROLLED LOCAL ROUTE proving the module graph and the tool chain, NOT a
 * provider integration.
 *
 * Usage: node qualification/results/S12-identity/id01-driver.mjs [arm]
 *        arm = baseline | swapped | src  (default: baseline)
 */
import { execFileSync } from 'node:child_process'
import { spawn } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { bootAndWait, freePort, isPortFree, portPatch, readResult, sleep, LAUNCHER, DSH_SRC } from '../../runners/boot-harness.mjs'
import { decide, sha256 } from './id01-identity-check.mjs'

/**
 * Boot an ARBITRARY launcher path, mirroring `bootAndWait` exactly except that the
 * launcher is a parameter.
 *
 * WHY THIS EXISTS RATHER THAN A NEW OPTION ON THE SHARED HARNESS. `bootAndWait`
 * hardcodes the launcher, and ARM B needs to execute a different build. Adding a
 * `launcher` option to `qualification/runners/boot-harness.mjs` would change a file
 * that every other writer's runs depend on, for one arm of one case. So the arm
 * carries its own 40-line copy of the boot loop and leaves the shared harness alone.
 * The loop is deliberately identical in shape (free port, wait for the probe, settle,
 * kill, verify release) so a difference in behaviour cannot come from here.
 */
async function bootWith(launcherPath, options) {
  const { home, profile, patches = [], outPath, cwd, timeoutMs = 180_000, settleMs = 900, env = {} } = options
  const chosen = await freePort()
  const portFile = `${outPath}.port.yml`
  portPatch(chosen, portFile)
  if (existsSync(outPath)) rmSync(outPath)
  const argv = [launcherPath, '--profile', profile, ...patches.flatMap(p => ['--patch', p]), '--patch', portFile, '--no-open']
  const child = spawn(process.execPath, argv, {
    cwd, env: { ...process.env, DSH_HOME: home, DSH_PROBE_OUT: outPath, ...env }, stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = '', stderr = ''
  child.stdout.on('data', d => { stdout += String(d) })
  child.stderr.on('data', d => { stderr += String(d) })
  const deadline = Date.now() + timeoutMs
  let timedOut = false
  while (!existsSync(outPath)) {
    if (Date.now() > deadline) { timedOut = true; break }
    if (child.exitCode !== null) { await sleep(settleMs); break }
    await sleep(200)
  }
  if (!timedOut && existsSync(outPath)) await sleep(settleMs)
  child.kill('SIGKILL')
  await sleep(500)
  return { port: chosen, exitCode: child.exitCode, stdout, stderr, timedOut, portReleased: await isPortFree(chosen) }
}

const ARM = process.argv[2] ?? 'baseline'
if (!['baseline', 'swapped', 'src'].includes(ARM)) throw new Error(`unknown arm: ${ARM}`)

const REPO = 'D:/DSH/work/wt-s12'
const HOME = 'D:/DSH/home/s12'
const PROFILE_SRC = `${REPO}/profiles/daily-candidate`
const PROFILE_NAME = 'daily'
const PROFILE_DIR = `${HOME}/profiles/${PROFILE_NAME}`
const RUN_DIR = `${REPO}/qualification/results/S12-identity/runs/id01-${ARM}`
const OUT = `${RUN_DIR}/boot.json`
const GRAPH = `${RUN_DIR}/graph.jsonl`
const OVERLAY = `${REPO}/qualification/results/S12-identity/id01-overlay-s12.yml`
const RECORDER = `${REPO}/qualification/results/V1-identity/id01-graph-recorder.mjs`
const SESSION_ROOT = `${RUN_DIR}/sessions`
const FIRST_CALL_FILE = `${RUN_DIR}/first-call-input.txt`
const FIRST_CALL_TEXT = 'ID01_FIRST_TOOL_CALL_ROUND_TRIP'
const TURN_TIMEOUT_MS = 45_000

/** The production source file ARM C mutates, and the mutation it applies. */
const ATTACK_TARGET = `${REPO}/packages/dsh-daily-work/src/artifacts.ts`
const ATTACK_INJECTION = "import { publishImmutableObjectStream } from '@deepseek-ai/dsh-attachment-local/src/store.ts'\n"

mkdirSync(RUN_DIR, { recursive: true })
mkdirSync(SESSION_ROOT, { recursive: true })
mkdirSync(`${RUN_DIR}/workspace`, { recursive: true })
writeFileSync(FIRST_CALL_FILE, `${FIRST_CALL_TEXT}\n`, 'utf8')
rmSync(GRAPH, { force: true })
rmSync(OUT, { force: true })

const transcript = []
const say = line => { transcript.push(line); console.log(line) }

say(`=== S12 ID-01 driver — ARM ${ARM} ===`)
say(`repo:     ${REPO}`)
say(`home:     ${HOME}`)
say(`launcher: ${LAUNCHER}`)
say(`graph:    ${GRAPH}`)

// ---------------------------------------------------------------------------
// (0) ARM C: mutate a PRODUCTION source file, before any build.
// ---------------------------------------------------------------------------
const targetOriginal = existsSync(ATTACK_TARGET) ? readFileSync(ATTACK_TARGET, 'utf8') : null
let attackApplied = false
if (ARM === 'src') {
  if (targetOriginal === null) throw new Error(`ARM src: attack target missing: ${ATTACK_TARGET}`)
  writeFileSync(ATTACK_TARGET, `${targetOriginal}${ATTACK_INJECTION}`, 'utf8')
  attackApplied = true
  say(`ARM src: injected a src/ deep import into ${ATTACK_TARGET}`)
}

/** Rebuild both packages with the project's own compiler. */
function rebuild() {
  const out = []
  for (const pkg of ['packages/dsh-daily-work', 'packages/dsh-ipython']) {
    const cwd = `${REPO}/${pkg}`
    const started = Date.now()
    try {
      execFileSync(process.execPath, [`${DSH_SRC}/node_modules/typescript/bin/tsc`, '-p', 'tsconfig.json'], {
        cwd, stdio: 'pipe', timeout: 300_000,
      })
      out.push({ package: pkg, exitCode: 0, ms: Date.now() - started, error: null })
    } catch (error) {
      out.push({
        package: pkg, exitCode: error.status ?? null, ms: Date.now() - started,
        error: String(error.message.split('\n')[0]),
        stderr: String(error.stderr ?? '').slice(-4000),
      })
    }
  }
  return out
}

let rebuilds = []
try {
  rebuilds = rebuild()
  for (const row of rebuilds) {
    say(`rebuild ${row.package}: exit=${String(row.exitCode)} in ${String(row.ms)}ms${row.error === null ? '' : ` -- ${row.error}`}`)
  }

  // ARM C PROOF, taken from the EMITTED ARTIFACT rather than from the source: the
  // built file must really carry the forbidden specifier, or the boot would measure
  // an unmutated product and the arm would prove nothing.
  if (ARM === 'src') {
    const emitted = `${REPO}/packages/dsh-daily-work/lib/artifacts.js`
    const text = existsSync(emitted) ? readFileSync(emitted, 'utf8') : ''
    const carries = text.includes('@deepseek-ai/dsh-attachment-local/src/store.ts')
    say(`ARM src: emitted lib/artifacts.js carries the forbidden specifier: ${String(carries)}`)
    writeFileSync(`${RUN_DIR}/attack-applied.json`, `${JSON.stringify({
      target: ATTACK_TARGET, injection: ATTACK_INJECTION,
      emittedFile: emitted, emittedCarriesSpecifier: carries,
    }, null, 2)}\n`, 'utf8')
    if (!carries) {
      // Restore BEFORE failing, so a broken arm cannot leave the product mutated.
      writeFileSync(ATTACK_TARGET, targetOriginal, 'utf8')
      throw new Error('ARM src: the emitted artifact does NOT carry the injected specifier; the arm would prove nothing')
    }
  }

  /** Newest mtime for one extension directly in a directory. */
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
  // (1) FRESH INSTALL of the profile, with `link:` targets rewritten at THIS tree.
  // ---------------------------------------------------------------------------
  if (existsSync(PROFILE_DIR)) rmSync(PROFILE_DIR, { recursive: true, force: true })
  mkdirSync(`${HOME}/profiles`, { recursive: true })
  cpSync(PROFILE_SRC, PROFILE_DIR, { recursive: true })
  const installedPkgPath = `${PROFILE_DIR}/package.json`
  writeFileSync(installedPkgPath,
    readFileSync(installedPkgPath, 'utf8').replaceAll('D:/DSH/work/dsh-native-daily', REPO), 'utf8')

  const installedPkgJson = readFileSync(installedPkgPath, 'utf8')
  const linksThisWorktree = installedPkgJson.includes(REPO)
  say(`installed profile links this worktree: ${String(linksThisWorktree)}`)
  if (!linksThisWorktree) throw new Error('the installed profile does not link this worktree; the boot would measure another tree')
  if (installedPkgJson.includes('D:/DSH/work/dsh-native-daily')) throw new Error('the installed profile still names the MAIN checkout')

  let installResult
  try {
    const stdout = execFileSync(process.execPath, [LAUNCHER, 'plugin', '--profile', PROFILE_NAME, 'install'], {
      cwd: PROFILE_DIR, env: { ...process.env, DSH_HOME: HOME }, encoding: 'utf8', timeout: 300_000,
    })
    installResult = { exitCode: 0, stdoutTail: stdout.slice(-600) }
  } catch (error) {
    installResult = { exitCode: error.status ?? null, error: String(error.message.split('\n')[0]), stderrTail: String(error.stderr ?? '').slice(-600) }
  }
  say(`plugin install: exit=${String(installResult.exitCode)}${installResult.error === undefined ? '' : ` -- ${installResult.error}`}`)

  // ---------------------------------------------------------------------------
  // (2) ARM B: the launcher the boot EXECUTES is a DIFFERENT BUILD.
  //
  // WHAT MAKES THIS A REAL SWAP, and not a hand-made file. The swap artifact is
  // the checkout's OWN OTHER BUILD FACE: `apps/cli/lib/types/bin.js` is the
  // `tsc -b` output that `tsdown` consumes to produce the pinned bundle, so it is
  // a genuine, shipped, executable build of the same source at the same commit —
  // simply not the artifact the lock pins. It is executed by its own path
  // (`SWAP_LAUNCHER`) with a resolution farm of ABSOLUTE junctions built under
  // `.probe/s12-id01/swapped2/`, so it really boots rather than merely being
  // hashed. Its sha256 differs from the pin (`fe01631e…` vs `69c49c87…`), and the
  // run reports which version string it printed, so a reader can see the swapped
  // build is the one that ran.
  //
  // THE PINNED FILE IS NOT TOUCHED. The checkout is read-only, so the attack
  // substitutes the EXECUTED path rather than overwriting the pinned artifact.
  // ---------------------------------------------------------------------------
  let launcherUnderTest = LAUNCHER
  let executedLauncher = LAUNCHER
  let swapProof = null
  if (ARM === 'swapped') {
    const swap = `${REPO}/.probe/s12-id01/swapped2/apps/cli/lib/types/bin.js`
    if (!existsSync(swap)) throw new Error(`ARM swapped: no swap build at ${swap}; run the setup step first`)
    launcherUnderTest = swap
    executedLauncher = swap
    // Prove the swapped build actually RUNS and reports a different identity, so
    // "it was executed" is a measurement rather than an assumption.
    let versionOut = ''
    try {
      versionOut = execFileSync(process.execPath, [swap, '--version'], {
        env: { ...process.env, DSH_HOME: HOME }, encoding: 'utf8', timeout: 60_000,
      }).trim()
    } catch (error) {
      versionOut = `FAILED: ${String(error.message.split('\n')[0])}`
    }
    swapProof = {
      swapArtifact: swap,
      swapSha256: sha256(swap),
      swapVersionOutput: versionOut,
      pinnedLauncherSha256: sha256(LAUNCHER),
      swappedBuildExecuted: versionOut !== '' && !versionOut.startsWith('FAILED'),
    }
    say(`ARM swapped: the pin names ${LAUNCHER} (sha ${String(sha256(LAUNCHER)).slice(0, 16)})`)
    say(`ARM swapped: the boot EXECUTES ${swap} (sha ${String(sha256(swap)).slice(0, 16)})`)
    say(`ARM swapped: that build reports version ${JSON.stringify(versionOut)}`)
    if (!swapProof.swappedBuildExecuted) throw new Error('ARM swapped: the swap build does not execute; the arm would prove nothing')
  }

  // ---------------------------------------------------------------------------
  // (3) BOOT the built launcher on a harness-chosen free port.
  // ---------------------------------------------------------------------------
  const boot = await bootWith(executedLauncher, {
    home: HOME, profile: PROFILE_NAME, patches: [OVERLAY], outPath: OUT,
    cwd: 'C:/Windows/Temp', timeoutMs: 180_000,
    env: {
      T17_PROBE_OUT: OUT, T17_SESSION_ROOT: SESSION_ROOT,
      T17_SESSION_CWD: `${RUN_DIR}/workspace`,
      T17_LAUNCHER: LAUNCHER, T17_LAUNCHER_ARGS: `--profile ${PROFILE_NAME}`,
      T17_PROFILE_NAME: PROFILE_NAME, T17_TURN_TIMEOUT_MS: String(TURN_TIMEOUT_MS),
      T17_FIRST_CALL_FILE: FIRST_CALL_FILE, V1_GRAPH_OUT: GRAPH,
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
  // (4) DECIDE the oracle's clauses from the measured graph.
  // ---------------------------------------------------------------------------
  const lock = JSON.parse(readFileSync(`${REPO}/compatibility.lock.json`, 'utf8'))
  const pin = lock.deployment.inputs.artifact_sha256

  const decision = decide({ graphPath: GRAPH, launcher: launcherUnderTest, pin, probe, expectedText: FIRST_CALL_TEXT })

  const artifact = {
    driver: 's12-id01-driver', arm: ARM, case: 'ID-01',
    ranAt: new Date().toISOString(), tree: REPO, branch: 'wt/s12', home: HOME,
    overlay: OVERLAY,
    overlayNote: 'the archived ID-01 overlay with the two insert names re-pointed at this worktree; keyless mock route, no provider budget',
    recorder: RECORDER,
    recorderSha256: sha256(RECORDER),
    launcherExecuted: executedLauncher,
    launcherMeasured: launcherUnderTest,
    launcherMeasuredSha256: decision.launcherSha256,
    pinnedArtifactSha256: pin,
    swapProof,
    attack: ARM === 'src'
      ? { kind: 'src-injection', target: ATTACK_TARGET, injection: ATTACK_INJECTION, applied: attackApplied }
      : ARM === 'swapped'
        ? { kind: 'swapped-build', executedArtifact: executedLauncher, proof: swapProof }
        : { kind: 'none-baseline' },
    rebuilds, buildFreshness, pluginInstall: installResult,
    port: boot.port, portReleased: boot.portReleased, timedOut: boot.timedOut,
    graph: decision.graph,
    probeReadError,
    clauses: decision.clauses,
    failures: decision.failures,
    verdict: decision.verdict,
  }
  writeFileSync(`${RUN_DIR}/verdict.json`, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8')

  say('')
  say('--- clauses ---')
  for (const row of decision.clauses) say(`${row.ok ? 'ok  ' : 'FAIL'} ${row.label}${row.ok ? '' : `\n       observed: ${row.detail}`}`)
  say('')
  say(`graph: ${String(decision.graph.lineCount)} lines, ${String(decision.graph.distinctSpecifiers)} distinct @deepseek-ai specifiers`)
  say(`  fromBuilt=${String(decision.graph.fromBuilt)} fromSource=${String(decision.graph.fromSource)} fromOther=${String(decision.graph.fromOther)}`)
  say(`  packages\\*\\lib=${String(decision.graph.underPackagesLib)} vendor\\*\\lib=${String(decision.graph.underVendorLib)} node_modules=${String(decision.graph.underNodeModules)}`)
  say(`ARM ${ARM} VERDICT: ${decision.verdict}`)
} finally {
  // RESTORE, always. A failed arm must not leave the product mutated.
  if (ARM === 'src' && targetOriginal !== null) {
    writeFileSync(ATTACK_TARGET, targetOriginal, 'utf8')
    const restored = readFileSync(ATTACK_TARGET, 'utf8') === targetOriginal
    say('')
    say(`ARM src: attack target restored: ${String(restored)}`)
    if (!restored) throw new Error('ARM src: FAILED TO RESTORE the attack target; the product is left mutated')
    // Rebuild the clean source so the tree is not left with a mutated lib/.
    const restoredBuilds = rebuild()
    for (const row of restoredBuilds) {
      say(`restore rebuild ${row.package}: exit=${String(row.exitCode)}`)
    }
  }
  writeFileSync(`${RUN_DIR}/transcript.txt`, `${transcript.join('\n')}\n`, 'utf8')
}
