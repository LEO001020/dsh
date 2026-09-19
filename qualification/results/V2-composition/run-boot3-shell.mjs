/**
 * V2 COMPOSITION driver: boot 3, the SHELL/PERMISSION-PLANE probe, against THIS
 * task's own home and its own output path.
 *
 * WHY A SEPARATE DRIVER RATHER THAN `run-t3-shell.mjs`. That driver is pinned to
 * `D:/DSH/home/t3-shell` and to `T3-shell/boot.json`. Reusing the PROBE is right
 * -- it is the instrument that measures exactly what CMP-01 and CMP-06 need, and
 * writing a second one would be a second oracle. Reusing the DRIVER would mean
 * overwriting another agent's result file and booting another agent's home, which
 * is the fixed-output-path trap (G-FIX-13) at the driver level.
 *
 * So: the shared probe, this task's home, this task's output path. `DSH_PROBE_OUT`
 * is what makes that possible, and `readResult()` then asserts the result names
 * the home booted here.
 *
 * WHAT IT ADDS TO CMP-01 AND CMP-06:
 *   - CMP-01's oracle says "the boot output contains no `warning: N entries did
 *     not activate` line. The measured count is recorded verbatim." The probe
 *     reads the LIVE loader audit at TWO checkpoints, the second of which is
 *     after the product's own `auditStartupEntries` ran, so the count is a
 *     measurement of the product's own view rather than a log scrape.
 *   - CMP-06 needs the effective approval policy read from the live service,
 *     which is the probe's `approvalPolicy` field.
 *
 * Usage: node run-boot3-shell.mjs
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { bootAndWait, readResult } from 'file:///D:/DSH/work/dsh-native-daily/qualification/runners/boot-harness.mjs'

const REPO = 'D:/DSH/work/dsh-native-daily'
const HOME = 'D:/DSH/home/v2-cmp'
const PROFILE = 'daily'
const RESULTS = `${REPO}/qualification/results/V2-composition`
const OUT = `${RESULTS}/boot3-shell.json`
const OVERLAY = `${REPO}/qualification/runners/verify-t3-shell.patch.yml`

const digest = path => existsSync(path)
  ? createHash('sha256').update(readFileSync(path)).digest('hex')
  : null

const boot = await bootAndWait({
  home: HOME,
  profile: PROFILE,
  patches: [OVERLAY],
  outPath: OUT,
  // FOREIGN cwd. The probe's own header names this as the direction that tests
  // the cwd-dependent preset root, and the two recorded preset-root defects
  // (G-FIX-12, G-FIX-13) both looked healthy from the profile's own directory.
  cwd: 'D:/DSH/src/dsh-src',
  timeoutMs: 150_000,
})

writeFileSync(`${RESULTS}/boot3-transcript.txt`, [
  '# V2 boot 3 -- shell/permission plane (CMP-01, CMP-06)',
  `# cwd: D:/DSH/src/dsh-src   DSH_HOME: ${HOME}   port: ${String(boot.port)}   portReleased: ${String(boot.portReleased)}`,
  `# timedOut: ${String(boot.timedOut)}   exitCode: ${String(boot.exitCode)}`,
  '',
  '--- stdout ---', boot.stdout,
  '--- stderr ---', boot.stderr,
].join('\n'), 'utf8')

let probe = null
let fatal = null
try { probe = readResult(OUT, HOME).json } catch (error) { fatal = error instanceof Error ? error.message : String(error) }

const scan = `${boot.stdout}\n${boot.stderr}`
// The product's OWN warning form, quoted from
// `packages/boot/app-boot/src/index.ts:820-826`. Recorded verbatim, because
// CMP-01's oracle is about the LINE, not a paraphrase of it.
const warningLines = scan.split(/\r?\n/).filter(line => /did not activate|waiting for service|startup failed|failed to mount/i.test(line))
const countMatch = /(\d+) entr(?:y|ies) did not activate/.exec(scan)

const checks = []
const check = (caseId, label, ok, detail) => {
  checks.push({ caseId, label, ok: ok === true, detail })
  return ok === true
}

if (fatal !== null) {
  checks.push({ caseId: 'CMP-01', label: 'the probe result names the home this driver booted', ok: false, detail: fatal })
} else {
  // ═══ CMP-01 ═══ "Zero entries report `did not activate`, `pending`, or
  // `waiting for services`; the boot output contains no `warning: N entries did
  // not activate` line. The measured count is recorded verbatim."
  check('CMP-01', 'the boot output carries NO "N entries did not activate" line',
    countMatch === null, countMatch === null ? 'no such line' : `measured: "${countMatch[0]}"`)
  check('CMP-01', 'no "waiting for service(s)" line appears anywhere in the boot output',
    !/waiting for service/i.test(scan), JSON.stringify(warningLines))
  // The probe's own field names, read from the artifact rather than guessed:
  // `inactiveEntries` / `postAuditInactiveEntries` / `postAuditRan` / `entryCount`
  // / `postAuditEntryCount` / `activationWarningCount` / `allAssertionsPass`.
  check('CMP-01', 'the live loader audit reports ZERO inactive entries (mid-apply)',
    probe.inactiveEntries?.length === 0, JSON.stringify(probe.inactiveEntries ?? null))
  check('CMP-01', 'the POST-AUDIT loader snapshot reports ZERO inactive entries',
    probe.postAuditInactiveEntries?.length === 0, JSON.stringify(probe.postAuditInactiveEntries ?? null))
  check('CMP-01', 'the post-audit snapshot RAN (the product audit had completed)',
    probe.postAuditRan === true, String(probe.postAuditRan))
  check('CMP-01', 'the loader audit actually RAN (the entry table is non-empty)',
    probe.entryCount > 0 && probe.postAuditEntryCount > 0, `entryCount=${String(probe.entryCount)} postAudit=${String(probe.postAuditEntryCount)}`)
  check('CMP-01', "the probe's own activation-warning count is 0", probe.activationWarningCount === 0, String(probe.activationWarningCount))
  check('CMP-01', 'every assertion inside the shared probe passed', probe.allAssertionsPass === true, String(probe.allAssertionsPass))
  check('CMP-01', 'the probe reported no error', probe.error === null, String(probe.error))

  // ═══ CMP-06 (corroboration) ═══ the live approval service's own config.
  check('CMP-06', 'the live approval service reports policy=never', probe.approvalPolicy === 'never', String(probe.approvalPolicy))
  check('CMP-06', 'the live shell reports sandboxMode undefined (the unconfined executor)',
    probe.shellSandboxModeIsUndefined === true, String(probe.shellSandboxModeIsUndefined))
  check('CMP-06', 'the permission-presets service is absent', probe.permissionPresetsServicePresent === false, String(probe.permissionPresetsServicePresent))
  // THE ROW IS PRESENT AND DISABLED, NOT ABSENT -- and the difference matters.
  // `permissionPresetsRowPresent` means the id exists in the loader TABLE;
  // `permissionPresetsAbsent` means the SERVICE is gone. The profile disables the
  // row rather than deleting it (a patch cannot delete a row), so asserting
  // "the row is absent" would have been asserting something false. The
  // oracle-relevant facts are that the SERVICE is unreachable and the row is
  // disabled, and both are measured.
  check('CMP-06', 'the permissionPresets SERVICE is unreachable', probe.permissionPresetsAbsent === true, String(probe.permissionPresetsAbsent))
  check('CMP-06', 'the permission row is present-but-disabled (not deleted, and not active)',
    probe.permissionPresetsRowPresent === true && probe.permissionPresetsServicePresent === false,
    `row=${String(probe.permissionPresetsRowPresent)} service=${String(probe.permissionPresetsServicePresent)}`)
  check('CMP-13', 'the shared probe independently measures pwsh ABSENT', probe.pwshToolPresent === false, String(probe.pwshToolPresent))
  check('CMP-13', 'the shared probe independently measures ipython PRESENT', probe.ipythonToolPresent === true, String(probe.ipythonToolPresent))
}

const verdict = {
  probe: 'V2-composition boot3 (shared t3-shell probe, own home/out path)',
  ranAt: new Date().toISOString(),
  cwd: 'D:/DSH/src/dsh-src',
  dshHome: HOME,
  port: boot.port,
  portReleased: boot.portReleased,
  timedOut: boot.timedOut,
  exitCode: boot.exitCode,
  activationWarningLines: warningLines,
  activationCountMatch: countMatch === null ? null : countMatch[0],
  inputDigests: {
    installedProfilePatch: digest(`${HOME}/profiles/daily/cordis.patch.yml`),
    repoProfilePatch: digest(`${REPO}/profiles/daily-candidate/cordis.patch.yml`),
    installedPreset: digest(`${HOME}/profiles/daily/presets/daily-standard/agent.cordis.yml`),
    repoPreset: digest(`${REPO}/profiles/daily-candidate/presets/daily-standard/agent.cordis.yml`),
    overlay: digest(OVERLAY),
    probe: digest(`${REPO}/qualification/runners/verify-t3-shell.mjs`),
  },
  fatal,
  measurement: probe,
  checks,
  failures: checks.filter(c => !c.ok).map(c => `[${c.caseId}] ${c.label} -- observed: ${c.detail}`),
  ok: checks.every(c => c.ok),
}
writeFileSync(`${RESULTS}/boot3-verdict.json`, `${JSON.stringify(verdict, null, 2)}\n`, 'utf8')

console.log(`port=${String(boot.port)} released=${String(boot.portReleased)} timedOut=${String(boot.timedOut)}`)
console.log(`activationCountMatch=${String(countMatch?.[0] ?? 'none')} entryCount=${String(probe?.entryCount)} inactive=${JSON.stringify(probe?.inactiveEntries)} postAuditInactive=${JSON.stringify(probe?.postAuditInactiveEntries)}`)
console.log(`approvalPolicy=${String(probe?.approvalPolicy)} shellSandboxModeUndefined=${String(probe?.shellSandboxModeIsUndefined)}`)
console.log(`checks=${String(checks.filter(c => c.ok).length)}/${String(checks.length)}`)
for (const fail of verdict.failures) console.log(`FAIL: ${fail}`)
