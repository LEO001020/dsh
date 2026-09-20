/**
 * T2 driver: boot the real profile through the shared harness and report the
 * filesystem-provider verdict.
 *
 * WHY A DRIVER AND NOT JUST THE PROBE. The probe runs INSIDE the host and can
 * only see the host's own view. Three facts this task must report are properties
 * of the BOOT, not of the context: the port was genuinely free, the host was
 * killed, and the port was released afterwards. The shared `boot-harness.mjs`
 * owns those, so this driver owns only the READING of the result -- the
 * harness deliberately does not interpret, because a shared helper that also
 * judged would be a second oracle.
 *
 * Usage: node verify-t2-fs.mjs
 */
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { bootAndWait, readResult } from './boot-harness.mjs'

// THE REPO ROOT IS DERIVED FROM THIS FILE'S OWN LOCATION, not hardcoded.
//
// It used to be the literal `D:/DSH/work/dsh-native-daily`, which names ONE
// checkout. Every path built from it -- the result directory, the profile
// source, the digests read back -- therefore belonged to the MAIN tree even when
// this file ran from a git worktree (which the multi-agent discipline requires).
// A runner that reads the main tree and writes into its own tree is reporting a
// fact about a tree it does not own; the reverse overwrites evidence. Both are
// the `G-SEAM-66` corruption class, and the read side is what produced two
// retracted findings in this project (G-SEAM-29, G-SEAM-36).
//
// `import.meta.url` is `.../qualification/runners/<this file>`, so two levels up
// is the repository root of WHICHEVER tree is running -- verified for a worktree,
// where it resolves to that worktree rather than to the main checkout.
import { fileURLToPath } from 'node:url'
import { dirname as __dirnameOf, join as __joinOf } from 'node:path'
const REPO = __joinOf(__dirnameOf(fileURLToPath(import.meta.url)), '..', '..').replace(/\\/g, '/')

const RESULT_DIR = `${REPO}/qualification/results/T2-fs`
const HOME = 'D:/DSH/home/t2-fs'
const PROFILE = 'daily'

const OUT = `${RESULT_DIR}/boot.json`
const VERDICT = `${RESULT_DIR}/VERDICT.json`
const TRANSCRIPT = `${RESULT_DIR}/transcript.txt`

/** SHA-256 of a file, or null when it cannot be read. */
function digest(path) {
  return existsSync(path) ? createHash('sha256').update(readFileSync(path)).digest('hex') : null
}

/**
 * The composition this run describes, as two digests.
 *
 * `installed` is the patch the booted host actually loaded; `repo` is the
 * checked-in copy it is supposed to have come from. A reader who has only one of
 * them cannot tell a stale install from a current one, which is exactly the trap
 * that produced a stale M12 install and a stale-`lib/` false finding earlier in
 * this project. Reporting both makes the comparison mechanical: when they differ,
 * the numbers below describe a composition the repository no longer describes,
 * and the verdict says so in `compositionIsCurrent`.
 */
const composition = {
  installed: digest(`${HOME}/profiles/daily/cordis.patch.yml`),
  repo: digest(`${REPO}/profiles/daily-candidate/cordis.patch.yml`),
}
composition.isCurrent = composition.installed !== null && composition.installed === composition.repo

/**
 * Clear a STALE writer lock left in this home by a previous kill.
 *
 * WHY THIS IS NECESSARY AND WHY IT IS NOT A WORKAROUND FOR A PRODUCT BUG. The
 * credentials store serializes read-render-commit through a `wx` lock file that
 * records the holder's pid (`packages/util/atomic-write/src/index.ts:158-185`).
 * The shared harness stops hosts with `SIGKILL`, and on win32 that is
 * `TerminateProcess` -- so the `finally` that removes the lock never runs and the
 * pid in the file is dead. The NEXT boot then fails with
 *
 *   dsh: startup failed: 1 required plugin did not activate
 *     connection (required)
 *     Error: atomic-write: timed out waiting for the writer lock at ...lock
 *
 * which reads exactly like a composition failure and is not one. That is the same
 * "looks like a composition failure" class as the EADDRINUSE collision the harness
 * was built to avoid. Measured here on the second run of this probe: the first run
 * was SIGKILLed, the second could not activate `connection`, and the run after the
 * stale lock was removed booted normally.
 *
 * It touches only THIS probe's own home, and it only deletes a lock whose recorded
 * pid is not running -- a live holder is never disturbed, so this cannot mask real
 * contention.
 * @returns a description of what was cleared, for the transcript.
 */
function clearStaleLock() {
  const lock = `${HOME}/.credentials.yaml.lock`
  if (!existsSync(lock)) return 'no lock present'
  const pid = Number.parseInt(readFileSync(lock, 'utf8').trim(), 10)
  if (Number.isInteger(pid)) {
    try {
      process.kill(pid, 0)
      return `lock held by LIVE pid ${String(pid)} -- left alone`
    } catch {
      // ESRCH: no such process, so the lock is stale.
    }
  }
  rmSync(lock)
  return `removed stale lock (dead pid ${String(pid)})`
}

const lines = []
const say = (text) => { lines.push(text); process.stdout.write(`${text}\n`) }

say('=== T2: filesystem provider swap, verified through a real profile boot ===')
say('')
say(`home:     ${HOME}`)
say(`profile:  ${PROFILE}`)
say(`overlay:  ${REPO}/qualification/runners/verify-t2-fs.patch.yml`)
say(`probe_out: ${OUT}`)
say(`stale_lock: ${clearStaleLock()}`)
say('')
say(`composition_installed_sha256: ${String(composition.installed)}`)
say(`composition_repo_sha256:      ${String(composition.repo)}`)
say(`composition_is_current: ${String(composition.isCurrent)}`)
say('')

// Boot from a FOREIGN cwd. This is not incidental: the preset root is derived
// from `ctx.baseUrl`, and the recorded G-FIX-12/G-FIX-13 defects were both
// cwd-dependent preset-root bugs that looked healthy when booted from the
// profile's own directory. `D:/DSH/src/dsh-src` is on a DIFFERENT DRIVE from the
// `E:`-rooted failure in G-FIX-13, so a drive-relative bug would surface here.
const FOREIGN_CWD = 'D:/DSH/src/dsh-src'
const boot = await bootAndWait({
  home: HOME,
  profile: PROFILE,
  patches: [`${REPO}/qualification/runners/verify-t2-fs.patch.yml`],
  outPath: OUT,
  cwd: FOREIGN_CWD,
})

say(`boot_cwd: ${FOREIGN_CWD} (deliberately foreign to the profile directory)`)
say(`port: ${String(boot.port)} (bound by the harness, not assumed)`)
say(`timed_out: ${String(boot.timedOut)}`)
say(`exit_code: ${String(boot.exitCode)}`)
say(`port_released_after_kill: ${String(boot.portReleased)}`)
say('')

// The harness's guard against the G-FIX-13 false PASS: a probe writing to a
// fixed path is a shared mutable resource, so the result must NAME the home we
// booted before any of it is read as ours.
let json
try {
  const read = readResult(OUT, HOME)
  json = read.json
  say(`result_names_this_home: true (presetRoots: ${read.roots.join(', ')})`)
} catch (error) {
  // A missing result is a finding about the BOOT, so the host's own output is
  // dumped rather than swallowed -- otherwise a failed boot and a failed probe
  // are indistinguishable, which is how a composition failure gets misread as a
  // probe bug (and vice versa).
  say(`result_names_this_home: FALSE -- ${error instanceof Error ? error.message : String(error)}`)
  say('')
  say('--- host stdout (tail) ---')
  say(boot.stdout.split('\n').slice(-40).join('\n'))
  say('--- host stderr (tail) ---')
  say(boot.stderr.split('\n').slice(-40).join('\n'))
  writeFileSync(TRANSCRIPT, `${lines.join('\n')}\n`, 'utf8')
  writeFileSync(VERDICT, JSON.stringify({ ok: false, reason: 'no probe result', exitCode: boot.exitCode, portReleased: boot.portReleased }, null, 2))
  process.exit(2)
}
say('')

// The activation warnings are read from the host's own stderr, because a row
// that never activated is exactly the FACT F failure mode (toolCount: 0).
const warningLines = boot.stderr.split('\n').filter(line => line.includes('did not activate'))
say(`activation_warning_lines: ${JSON.stringify(warningLines)}`)
say(`probe_error: ${json.error === null ? 'none' : json.error}`)
say('')

const checks = {
  // ── the provider swap itself ─────────────────────────────────────────────
  'fs service present': json.fsPresent === true,
  'provider class is LocalFileSystem (exact constructor)': json.providerIsExactLocalClass === true,
  'provider is NOT SandboxedFileSystem (instanceof)': json.providerIsInstanceOfSandboxClass === false,
  'SandboxedFileSystem absent from prototype chain': json.sandboxClassInPrototypeChain === false,
  'fs-sandbox row is disabled in the composed tree': json.fsSandboxRowDisabled === true,
  'fs-local row is ACTIVE in the composed tree': json.fsLocalRowActive === true,
  // ── the observation policy is RETAINED ───────────────────────────────────
  'fs-observation-policy row is ACTIVE': json.fsObservationPolicyRowActive === true,
  'fs/write-intent is still answered by a listener': json.writeIntentWithNoActor?.ok === true,
  // Asserted on the CODE, not on the message text. `FsError` carries the class on
  // `.code` (`packages/fs/fs/src/types.ts:196-202`) and this project's rule is to
  // route on the code rather than parse the message -- the first version of this
  // check looked for `FS_NOT_OBSERVED` inside `message`, so a listener that
  // answered CORRECTLY still failed it. See the `attempt()` note in the probe.
  'fs/edit-intent is still answered by a listener (FS_NOT_OBSERVED)': json.editIntentWithNoActor?.ok === false
    && json.editIntentWithNoActor?.code === 'FS_NOT_OBSERVED',
  // ── correctness that must SURVIVE the swap ───────────────────────────────
  'read/write/edit round-trips through the real tools': json.roundTrip?.roundTripOk === true,
  'stale-version write/edit is REFUSED': json.staleVersion?.refused === true,
  'the refusal is FS_STALE_VERSION': json.staleVersion?.codeIsStaleVersion === true,
  'the refused mutation had NO effect': json.staleVersion?.contentUnchangedAfterRefusal === true,
  'a non-matching exact edit is REFUSED': json.exactMatch?.refused === true,
  'the refusal is FS_EDIT_NOT_FOUND': json.exactMatch?.codeIsEditNotFound === true,
  'the refused edit had NO effect': json.exactMatch?.contentUnchangedAfterRefusal === true,
  // ── the tool face was not broken (the 28-tool baseline) ──────────────────
  'tool face is not zero': json.toolCount > 0,
  'ipython is present in the tool face': json.ipythonToolPresent === true,
  'no entry failed to activate': json.inactiveEntryIds?.length === 0,
  'no activation warnings on stderr': warningLines.length === 0,
  // ── the containment delta is REPORTED (direction is a measurement) ───────
  'the containment outcome is measured, not assumed': typeof json.outsideWorkspaceWriteSucceeded === 'boolean',
  'outside-workspace READ was never fenced (the control)': json.outsideWorkspaceRead?.isError === false,
  'the host was killed and the port released': boot.portReleased === true,
}

say('--- checks ---')
let failed = 0
for (const [label, ok] of Object.entries(checks)) {
  if (!ok) failed += 1
  say(`${ok ? 'ok  ' : 'FAIL'} ${label}`)
}
say('')
say(`checks_passed: ${Object.keys(checks).length - failed}/${Object.keys(checks).length}`)

const verdict = {
  ok: failed === 0,
  checksPassed: Object.keys(checks).length - failed,
  checksTotal: Object.keys(checks).length,
  checks,
  // WHICH COMPOSITION these numbers describe. A reader who cannot tell a stale
  // install from a current one cannot re-check anything, so both digests and the
  // comparison are fields rather than an inference from the transcript.
  composition,
  // The two facts a reader must not have to infer, reported side by side.
  sandboxPolicyDefaultMode: json.sandboxPolicyDefaultMode ?? null,
  fsSandboxMode: json.fsSandboxMode ?? null,
  containmentEffect: json.sandboxPolicyDefaultMode === 'danger-full-access'
    ? 'NONE -- the fence already short-circuited under this default (fs-sandbox/src/index.ts:125)'
    : 'ACTIVE -- the fence applied to writeText/editText before the swap',
  outsideWorkspaceWriteSucceeded: json.outsideWorkspaceWriteSucceeded ?? null,
  escalationFieldsAdvertised: json.escalationFieldsAdvertised ?? null,
  toolCount: json.toolCount ?? null,
  ipythonToolPresent: json.ipythonToolPresent ?? null,
  providerClassName: json.providerClassName ?? null,
  resolvedModuleRealpaths: json.resolvedModuleRealpaths ?? null,
  fsRows: json.fsRows ?? null,
  // The non-activation finding, reported with each entry's own state and error
  // rather than as a bare id list, so PENDING and FAILED are distinguishable.
  inactiveEntryIds: json.inactiveEntryIds ?? null,
  nonActiveEntries: json.nonActiveEntries ?? null,
  selfRowId: json.selfRowId ?? null,
  selfRowFiberState: json.selfRowFiberState ?? null,
  loaderInternalPresent: json.loaderInternalPresent ?? null,
  boot: { port: boot.port, timedOut: boot.timedOut, exitCode: boot.exitCode, portReleased: boot.portReleased },
  activationWarningLines: warningLines,
  probeError: json.error ?? null,
}
writeFileSync(VERDICT, JSON.stringify(verdict, null, 2), 'utf8')
writeFileSync(TRANSCRIPT, `${lines.join('\n')}\n`, 'utf8')
say('')
say(`verdict: ${VERDICT}`)
process.exit(verdict.ok ? 0 : 1)
