/**
 * V2 COMPOSITION driver: the TWO FAILURE ARMS.
 *
 *   ARM 1 (CMP-05): a CWD-RELATIVE preset root, booted from a foreign cwd. The
 *     oracle requires the preset to be NOT FOUND and the tool count to be 0.
 *   ARM 2 (CMP-03): the sandbox provider rows removed. The oracle requires an
 *     EXPLICIT loader failure naming the missing provider, NOT a silent boot with
 *     an implicit danger-full-access.
 *
 * WHY BOTH ARMS IN ONE DRIVER, RUN SEQUENTIALLY. The CPU directive for this run
 * is one host at a time; `await`ing each boot before starting the next keeps that
 * true. They are separate functions so a failure in arm 1 cannot corrupt arm 2's
 * measurement.
 *
 * WHY A FAILURE DIRECTION IS WORTH A BOOT AT ALL. A gate that only ever measures
 * the success direction cannot distinguish "the mechanism works" from "the
 * mechanism is not doing anything". G-FIX-13 is the recorded instance: a
 * `ctx.baseUrl` fix was verified only in the direction where it worked, and the
 * broken form had been written into `docs/DELIVERY.md` as VERIFIED.
 *
 * Usage: node run-boot5-failure-arms.mjs
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { bootAndWait } from 'file:///D:/DSH/work/dsh-native-daily/qualification/runners/boot-harness.mjs'

const REPO = 'D:/DSH/work/dsh-native-daily'
const HOME = 'D:/DSH/home/v2-cmp'
const PROFILE = 'daily'
const RESULTS = `${REPO}/qualification/results/V2-composition`

const digest = path => existsSync(path)
  ? createHash('sha256').update(readFileSync(path)).digest('hex')
  : null

const results = {
  probe: 'V2-composition failure arms',
  ranAt: new Date().toISOString(),
  inputDigests: {
    installedProfilePatch: digest(`${HOME}/profiles/daily/cordis.patch.yml`),
    repoProfilePatch: digest(`${REPO}/profiles/daily-candidate/cordis.patch.yml`),
    installedPreset: digest(`${HOME}/profiles/daily/presets/daily-standard/agent.cordis.yml`),
    repoPreset: digest(`${REPO}/profiles/daily-candidate/presets/daily-standard/agent.cordis.yml`),
    cwdRelativeOverlay: digest(`${REPO}/qualification/runners/verify-cmp-cwd-relative-root.patch.yml`),
    sandboxRemovedOverlay: digest(`${REPO}/qualification/runners/verify-cmp-sandbox-removed.patch.yml`),
    surfaceProbe: digest(`${REPO}/qualification/runners/verify-deliverable-surface.mjs`),
    surfaceOverlay: digest(`${REPO}/qualification/runners/verify-deliverable-surface.patch.yml`),
  },
  arms: [],
}

/** The activation/loader failure lines the product itself prints. */
const failureLines = text => text.split(/\r?\n/).filter(line =>
  /did not activate|waiting for services|failed to mount|pending|not found|failed to import/i.test(line))

// ─────────────────────────── ARM 1: cwd-relative root ───────────────────────────
{
  const OUT = `${RESULTS}/boot5-cwd-relative.json`
  const boot = await bootAndWait({
    home: HOME,
    profile: PROFILE,
    patches: [
      `${REPO}/qualification/runners/verify-cmp-cwd-relative-root.patch.yml`,
      `${REPO}/qualification/runners/verify-deliverable-surface.patch.yml`,
    ],
    outPath: OUT,
    // FOREIGN cwd on a different drive. THIS IS THE WHOLE STIMULUS: `./presets`
    // is resolved by Node's `resolve` against the PROCESS cwd
    // (`packages/preset/agent-presets/src/discovery.ts:285`), so from here it
    // points at a directory that does not exist.
    cwd: 'D:/DSH/src/dsh-src',
    timeoutMs: 150_000,
  })
  writeFileSync(`${RESULTS}/boot5-cwd-relative-transcript.txt`, [
    '# V2 boot 5 arm 1 -- CWD-RELATIVE preset root, foreign cwd',
    `# cwd: D:/DSH/src/dsh-src   DSH_HOME: ${HOME}   port: ${String(boot.port)}   portReleased: ${String(boot.portReleased)}`,
    `# timedOut: ${String(boot.timedOut)}   exitCode: ${String(boot.exitCode)}`,
    '',
    '--- stdout ---', boot.stdout,
    '--- stderr ---', boot.stderr,
  ].join('\n'), 'utf8')

  let result = null
  try { result = JSON.parse(readFileSync(OUT, 'utf8')) } catch { result = null }
  const stderrLines = failureLines(`${boot.stdout}\n${boot.stderr}`)
  results.arms.push({
    arm: 'CMP-05 failure direction: cwd-relative preset root',
    cwd: 'D:/DSH/src/dsh-src',
    port: boot.port,
    portReleased: boot.portReleased,
    timedOut: boot.timedOut,
    exitCode: boot.exitCode,
    failureLines: stderrLines,
    result,
    // The oracle's two clauses, computed here so a reader can falsify them.
    presetNotFound: /preset "daily-standard" not found|not found \(available/i.test(`${boot.stdout}\n${boot.stderr}`)
      || (typeof result?.error === 'string' && /not found/i.test(result.error)),
    toolCountZero: result?.toolCountAgentKey === 0,
    ipythonAbsent: result?.ipythonToolPresent === false,
  })
  console.log(`ARM1 port=${String(boot.port)} released=${String(boot.portReleased)} timedOut=${String(boot.timedOut)}`)
  console.log(`ARM1 toolCount=${String(result?.toolCountAgentKey)} error=${String(result?.error)}`)
  for (const line of stderrLines.slice(0, 6)) console.log(`ARM1 line: ${line}`)
}

// ─────────────────────────── ARM 2: sandbox rows removed ────────────────────────
{
  const OUT = `${RESULTS}/boot6-sandbox-removed.json`
  const boot = await bootAndWait({
    home: HOME,
    profile: PROFILE,
    patches: [
      `${REPO}/qualification/runners/verify-cmp-sandbox-removed.patch.yml`,
      `${REPO}/qualification/runners/verify-deliverable-surface.patch.yml`,
    ],
    outPath: OUT,
    cwd: 'D:/DSH/src/dsh-src',
    timeoutMs: 150_000,
  })
  writeFileSync(`${RESULTS}/boot6-sandbox-removed-transcript.txt`, [
    '# V2 boot 6 arm 2 -- sandbox provider rows REMOVED',
    `# cwd: D:/DSH/src/dsh-src   DSH_HOME: ${HOME}   port: ${String(boot.port)}   portReleased: ${String(boot.portReleased)}`,
    `# timedOut: ${String(boot.timedOut)}   exitCode: ${String(boot.exitCode)}`,
    '',
    '--- stdout ---', boot.stdout,
    '--- stderr ---', boot.stderr,
  ].join('\n'), 'utf8')

  let result = null
  try { result = JSON.parse(readFileSync(OUT, 'utf8')) } catch { result = null }
  const scan = `${boot.stdout}\n${boot.stderr}`
  const missingNamed = /sandbox/i.test(scan)
  results.arms.push({
    arm: 'CMP-03 failure direction: sandbox provider rows removed',
    cwd: 'D:/DSH/src/dsh-src',
    port: boot.port,
    portReleased: boot.portReleased,
    timedOut: boot.timedOut,
    exitCode: boot.exitCode,
    failureLines: failureLines(scan),
    result,
    // The oracle's clauses.
    explicitFailure: /did not activate|waiting for services|failed to mount/i.test(scan),
    namesTheMissingProvider: missingNamed,
    // "does NOT boot with an unwrapped argv or an implicit danger-full-access":
    // if the host had fallen back, the probe would have run and the tool face
    // would be populated. A ZERO tool count with an explicit mount error is the
    // opposite of a silent fallback.
    toolCountZero: result?.toolCountAgentKey === 0,
    probeError: result?.error ?? null,
  })
  console.log(`ARM2 port=${String(boot.port)} released=${String(boot.portReleased)} timedOut=${String(boot.timedOut)}`)
  console.log(`ARM2 toolCount=${String(result?.toolCountAgentKey)} error=${String(result?.error)}`)
  for (const line of results.arms[1].failureLines.slice(0, 8)) console.log(`ARM2 line: ${line}`)
}

writeFileSync(`${RESULTS}/boot5-6-failure-arms.json`, `${JSON.stringify(results, null, 2)}\n`, 'utf8')
