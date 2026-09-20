/**
 * S11 driver — one boot per invocation, so no two boots ever overlap.
 *
 * WHY ONE BOOT PER INVOCATION AND NOT A LOOP. Fifteen writers share this box and
 * a real boot is CPU-heavy. A driver that booted its arms in a loop would put
 * two hosts up at once and is exactly the pattern the round-2 brief forbids. So
 * every arm below is a SEPARATE command, and this file never runs two arms.
 *
 * WHAT EACH ARM IS FOR, stated so the artifacts cannot be read for more than
 * they are:
 *
 *   healthy-probe     the CMP-02 / CMP-04 / CMP-13 measurement. The real
 *                     profile, a foreign cwd, ONE overlay row which is the
 *                     probe itself.
 *   healthy-noprobe   the loudness CONTROL: the same profile with NO probe in
 *                     the tree, so nothing but the product can write to stderr.
 *   confined-probe    a COPY of the profile with `mode: workspace-write`. Gives
 *                     the mode-sensitivity control for the NARRATION read (the
 *                     same channel must render the confining sentence) and the
 *                     confined readings, with the guard's refusal on stderr.
 *   confined-noprobe  the loudness ARM: the same confined copy with NO probe, so
 *                     the refusal on stderr can only have come from the product.
 *
 * USAGE
 *   node qualification/runners/s11-cmp-driver.mjs <arm>
 *
 * The artifact is written to `qualification/results/S11-cmp/<arm>.json` and
 * `readResult()` asserts it names the home THIS caller booted -- a probe writing
 * to a fixed path is a SHARED MUTABLE RESOURCE (G-FIX-13), and a false PASS from
 * a stale artifact is the defect that check exists to prevent.
 */
import { bootAndWait, readResult } from './boot-harness.mjs'
import { writeFileSync, mkdirSync } from 'node:fs'

const WORKTREE = 'D:/DSH/work/wt-s11'
const HOME = 'D:/DSH/home/s11'
const DIR = `${WORKTREE}/qualification/results/S11-cmp`

/**
 * The cwd every arm boots from.
 *
 * A FOREIGN cwd, on purpose, and CMP-04's stimulus requires it: "Boot the real
 * profile from a cwd unrelated to the profile directory". The profile lives at
 * `D:/DSH/home/s11/profiles/daily`; this is on a different drive, so nothing
 * resolves by accident of location. It is also the value `resolve()` falls back
 * to for an agentless call, and the value the narration interpolates for a
 * session whose cwd is unset -- so a cwd-relative defect is visible rather than
 * hidden.
 */
const FOREIGN_CWD = 'C:/Windows/Temp'

/** The overlay for the probe arms: ONE row, and it is the probe. */
const PROBE_PATCH = `${WORKTREE}/qualification/runners/s11-cmp-probe.patch.yml`

const ARMS = {
  'healthy-probe': { profile: 'daily', patches: [PROBE_PATCH], probe: true, timeoutMs: 180_000 },
  'healthy-noprobe': { profile: 'daily', patches: [], probe: false, timeoutMs: 40_000 },
  'confined-probe': { profile: 'daily-s11-confined', patches: [PROBE_PATCH], probe: true, timeoutMs: 180_000 },
  'confined-noprobe': { profile: 'daily-s11-confined', patches: [], probe: false, timeoutMs: 40_000 },
}

const arm = process.argv[2]
if (arm === undefined || !Object.hasOwn(ARMS, arm)) {
  console.error(`usage: node s11-cmp-driver.mjs <${Object.keys(ARMS).join('|')}>`)
  process.exit(2)
}
const spec = ARMS[arm]

mkdirSync(DIR, { recursive: true })
// A probe-free arm never writes this path. It is named `never-written` so a
// reader cannot mistake "no probe in the tree" for "the probe crashed".
const OUT = spec.probe ? `${DIR}/${arm}.json` : `${DIR}/${arm}.never-written.json`

const boot = await bootAndWait({
  patches: spec.patches,
  home: HOME,
  profile: spec.profile,
  outPath: OUT,
  cwd: FOREIGN_CWD,
  timeoutMs: spec.timeoutMs,
})

const stderr = String(boot.stderr)
const stdout = String(boot.stdout)

/**
 * The stderr facts, computed rather than left to a reader.
 *
 * The refusal message is the guard's own text from `no-sandbox-contract.ts`; the
 * failing check id and the observed mode are matched SEPARATELY from the refusal
 * text, because a refusal that does not name what was wrong is a weaker outcome
 * than one that does.
 */
const bootEvidence = {
  stdout,
  stderr,
  served: /dsh web: http:\/\/127\.0\.0\.1:\d+/u.test(stdout),
  activationWarningLine: (stderr.match(/warning: \d+ entr(?:y|ies) did not activate/u) ?? [null])[0],
  guardEntryNamedOnStderr: /daily-no-sandbox-contract/u.test(stderr),
  refusalTextOnStderr: /trusted-local contract violated at the startup boundary/u.test(stderr),
  violationIdOnStderr: /startup\.sandboxPolicy\.mode/u.test(stderr),
  observedConfinedModeOnStderr: /'workspace-write'/u.test(stderr),
  probeCompleteOnStderr: /probe-complete/u.test(stderr),
  port: boot.port,
  portReleased: boot.portReleased,
  timedOut: boot.timedOut,
  exitCode: boot.exitCode,
}

let result = null
let ownershipError = null
if (spec.probe) {
  try {
    const read = readResult(OUT, HOME)
    result = read.json
    result.ownership = { expectedHome: HOME, rootsObserved: read.roots, verified: true }
  } catch (error) {
    ownershipError = String(error?.message ?? error)
  }
}

const record = {
  arm,
  ranAt: new Date().toISOString(),
  profile: spec.profile,
  patches: spec.patches,
  cwd: FOREIGN_CWD,
  probeInTree: spec.probe,
  bootEvidence,
  ownershipError,
  result,
}
writeFileSync(`${DIR}/${arm}.boot.json`, `${JSON.stringify(record, null, 1)}\n`, 'utf8')

// The probe-free verdict, computed here because it is the arm's whole purpose.
if (!spec.probe) {
  const verdict = {
    'boot is SERVED (the process started and bound its port, so this is not a dead boot)': bootEvidence.served,
    'stderr carries the activation warning line': bootEvidence.activationWarningLine !== null,
    'stderr names the guard entry (daily-no-sandbox-contract)': bootEvidence.guardEntryNamedOnStderr,
    'stderr carries the refusal text': bootEvidence.refusalTextOnStderr,
    'stderr names the failing check id (startup.sandboxPolicy.mode)': bootEvidence.violationIdOnStderr,
    'stderr reports the observed confining mode': bootEvidence.observedConfinedModeOnStderr,
    'no probe is in the tree, so the probe cannot have written any of it': !bootEvidence.probeCompleteOnStderr,
  }
  console.log(`=== ${arm} (PROBE-FREE) ===`)
  console.log(`port ${String(bootEvidence.port)} released=${String(bootEvidence.portReleased)} timedOut=${String(bootEvidence.timedOut)} served=${String(bootEvidence.served)}`)
  console.log(JSON.stringify(verdict, null, 1))
  console.log('--- stderr (first 20 lines) ---')
  console.log(stderr.split('\n').slice(0, 20).join('\n'))
} else {
  console.log(`=== ${arm} (probe) ===`)
  console.log(`port ${String(bootEvidence.port)} released=${String(bootEvidence.portReleased)} timedOut=${String(bootEvidence.timedOut)}`)
  console.log('ownershipError:', ownershipError)
  if (result !== null) {
    console.log('presetRoots:', JSON.stringify(result.presetRoots))
    console.log('cmp02.declared:', JSON.stringify(result.cmp02?.declared))
    console.log('cmp02.effective:', JSON.stringify(result.cmp02?.effective))
    console.log('cmp02.narration.contextNames:', JSON.stringify(result.cmp02?.narration?.contextNames))
    console.log('cmp02.narration.policyContextText:', JSON.stringify(result.cmp02?.narration?.policyContextText))
    console.log('cmp02.ptc:', JSON.stringify(result.cmp02?.ptc))
    console.log('cmp02.guard:', JSON.stringify(result.cmp02?.guard))
    console.log('cmp04:', JSON.stringify(result.cmp04))
    console.log('cmp04 assembledMatchesRegistry:', JSON.stringify(result.cmp04?.assembledMatchesRegistry))
    console.log('cmp13:', JSON.stringify(result.cmp13))
    console.log('probeAddsNoRow:', JSON.stringify(result.probeAddsNoRow))
    console.log('loader:', JSON.stringify(result.loader))
    console.log('probe.error:', JSON.stringify(result.error))
  }
  console.log('--- stderr (first 20 lines) ---')
  console.log(stderr.split('\n').slice(0, 20).join('\n'))
}
