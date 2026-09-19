/**
 * T3 driver: boot the real `daily` profile from a FOREIGN cwd and collect the
 * shell/permission-plane probe result.
 *
 * WHY THIS FILE EXISTS SEPARATELY FROM THE PROBE. The probe (`verify-t3-shell.mjs`)
 * runs INSIDE the host's Cordis context and can only see what a plugin can see.
 * The facts that are about the BOOT rather than about the graph -- the exit code,
 * the stderr warning block, whether the port came back -- are only visible from
 * outside. `boot-harness.mjs` owns those mechanics so this driver does not
 * reimplement them (and does not guess a port, which is what produced the
 * `EADDRINUSE` -> "2 required plugins did not activate" false positive twice).
 *
 * THE FOREIGN CWD IS THE POINT, not a convenience. `scanRoot` does
 * `resolve(expandHomePath(root.path))` and Node's `resolve` is relative to the
 * PROCESS CWD (`packages/preset/agent-presets/src/discovery.ts:285`), so booting
 * from the profile directory would prove nothing about the `!!js` root
 * expression. `C:/Windows/Temp` is used rather than `/tmp` because this is a
 * Windows host and a drive-relative cwd is the exact case the drive-letter strip
 * in the profile's `agent-presets` row exists for (G-FIX-13).
 *
 * Usage: node qualification/runners/run-t3-shell.mjs
 */
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { bootAndWait, readResult } from './boot-harness.mjs'

const HOME = 'D:/DSH/home/t3-shell'
const PROFILE = 'daily'
const RESULT_DIR = 'D:/DSH/work/dsh-native-daily/qualification/results/T3-shell'
const OUT = `${RESULT_DIR}/boot.json`
/** A cwd that is neither the repo nor the profile directory. */
const FOREIGN_CWD = 'C:/Windows/Temp'

/**
 * The built artifacts this boot will actually EXECUTE.
 *
 * WHY THIS LIST EXISTS. Every home on this machine installs `dsh-ipython` and
 * `dsh-daily-work` through a `link:` into this repo, so a booted profile runs
 * their BUILT `lib/`, never their `src/`. That has already produced three stale
 * -artifact false findings in this project (the most recent being G-SEAM-29, a
 * stale `lib/kernel-plugin.js` reported as a product defect). Hashing these
 * files on both sides of the boot is what lets this result claim it measured
 * the build it names.
 */
const TRACKED_ARTIFACTS = [
  'packages/dsh-ipython/lib/ipython-tool.js',
  'packages/dsh-ipython/lib/kernel.js',
  'packages/dsh-ipython/lib/kernel-plugin.js',
  'packages/dsh-ipython/lib/host-plugin.js',
  'packages/dsh-daily-work/lib/tools.js',
  'packages/dsh-daily-work/lib/host-plugin.js',
]

/** @returns a map of artifact path to its SHA-256, or null where unreadable. */
function digestArtifacts() {
  const out = {}
  for (const rel of TRACKED_ARTIFACTS) {
    try {
      out[rel] = createHash('sha256')
        .update(readFileSync(`D:/DSH/work/dsh-native-daily/${rel}`))
        .digest('hex')
    } catch {
      out[rel] = null
    }
  }
  return out
}

mkdirSync(RESULT_DIR, { recursive: true })

// BEFORE the boot: what the run is about to execute.
const artifactsBefore = digestArtifacts()

const boot = await bootAndWait({
  home: HOME,
  profile: PROFILE,
  patches: ['D:/DSH/work/dsh-native-daily/qualification/runners/verify-t3-shell.patch.yml'],
  outPath: OUT,
  cwd: FOREIGN_CWD,
})

// AFTER the boot: did anything change underneath the measurement?
//
// A sibling agent rebuilding one of these mid-boot would mean the executed
// bytes are neither the before nor the after set -- the measurement would
// describe a build that no longer exists. Recorded as a first-class fact so a
// green result cannot silently rest on a moving artifact.
const artifactsAfter = digestArtifacts()
const changedArtifacts = TRACKED_ARTIFACTS.filter(rel => artifactsBefore[rel] !== artifactsAfter[rel])

// The harness's own guard against the fixed-output-path false PASS: it asserts
// the result names the home this caller booted. If another agent overwrote the
// file, this throws rather than reporting their graph as ours.
let probe = null
let probeError = null
try {
  probe = readResult(OUT, HOME).json
} catch (error) {
  probeError = error instanceof Error ? error.message : String(error)
}

// The stderr warning block, verbatim. `auditStartupEntries` prints
// "N entries did not activate" plus one indented line per inactive entry
// (`packages/boot/app-boot/src/index.ts:820-826`); a `StartupError` prints a
// different, fatal form. Both are recorded raw so the claim can be checked
// against the actual text rather than a paraphrase.
const warningLines = boot.stderr.split('\n').filter(line => /did not activate|waiting for service|startup failed/i.test(line))

const report = {
  driver: 'run-t3-shell',
  home: HOME,
  profile: PROFILE,
  bootCwd: FOREIGN_CWD,
  port: boot.port,
  portReleased: boot.portReleased,
  exitCode: boot.exitCode,
  timedOut: boot.timedOut,
  // WHICH BUILD THIS MEASURED. The profile is `link:`-ed to this repo, so the
  // boot executed these built libs; the digests are the identity of the
  // artifact the numbers below describe.
  buildIdentity: {
    artifacts: artifactsAfter,
    // Non-empty means the artifact set moved during the boot: the executed
    // bytes match neither snapshot, so the run must not be read as a
    // measurement of either. Expected empty.
    changedDuringBoot: changedArtifacts,
    stableDuringBoot: changedArtifacts.length === 0,
  },
  // The single most important number: 0 means no row was left `pending`.
  activationWarningLines: warningLines,
  startupWarningTextPresent: warningLines.length > 0,
  probeError,
  probe,
}

writeFileSync(`${RESULT_DIR}/driver.json`, JSON.stringify(report, null, 2))
process.stdout.write(`RUN-T3-SHELL: ${JSON.stringify({
  port: boot.port,
  portReleased: boot.portReleased,
  exitCode: boot.exitCode,
  timedOut: boot.timedOut,
  warningLines: warningLines.length,
  warningText: warningLines,
  artifactsStableDuringBoot: report.buildIdentity.stableDuringBoot,
  artifactsChangedDuringBoot: changedArtifacts,
  probeError,
  probeSummary: probe === null ? null : {
    activationWarningCount: probe.activationWarningCount,
    inactiveEntryIds: (probe.inactiveEntries ?? []).map(r => r.id),
    postAuditActivationWarningCount: probe.postAuditActivationWarningCount,
    postAuditInactiveEntryIds: (probe.postAuditInactiveEntries ?? []).map(r => r.id),
    postAuditProbeRowState: probe.postAuditProbeRowState,
    postAuditRan: probe.postAuditRan,
    postAuditTimedOut: probe.postAuditTimedOut ?? false,
    permissionPresetsAbsent: probe.permissionPresetsAbsent,
    shellSandboxMode: probe.shellSandboxMode,
    shellClassName: probe.shellClassName,
    toolCount: probe.toolCount,
    ipythonToolPresent: probe.ipythonToolPresent,
    pwshToolPresent: probe.pwshToolPresent,
    pwshAbsenceIsIntentional: probe.pwshAbsenceIsIntentional,
    approvalPolicy: probe.approvalPolicy,
    allAssertionsPass: probe.allAssertionsPass,
    verdict: probe.verdict,
    error: probe.error,
  },
})}\n`)

// Exit non-zero when an assertion failed, so a caller cannot read a green
// summary out of a failed run by accident.
//
// `artifactsStableDuringBoot` is part of this conjunction for a measured
// reason: the profile executes `link:`-ed built libs, so if one changed while
// the host was booting, the numbers describe bytes that were never
// consistently loaded. That is not a product failure -- it is a measurement
// that must be re-run -- and it must not exit 0.
const ok = boot.portReleased
  && probe !== null
  && probe.allAssertionsPass === true
  && report.buildIdentity.stableDuringBoot === true
process.exit(ok ? 0 : 1)
