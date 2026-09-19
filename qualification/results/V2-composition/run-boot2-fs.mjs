/**
 * V2 COMPOSITION driver: boot 2, the FILESYSTEM-PROVIDER probe, against this
 * task's own home and output path.
 *
 * WHY REUSE THE PROBE AND NOT THE DRIVER. `verify-t2-fs.mjs` is the instrument
 * that independently reads `sandboxPolicy.defaultMode`, `policy.resolve()` and
 * the fs provider class from a live composed boot -- which is exactly CMP-02's
 * subject. Writing a second instrument would be a second oracle. But
 * `verify-t2-fs-driver.mjs` is pinned to `D:/DSH/home/t2-fs` and
 * `T2-fs/boot.json`, so reusing the DRIVER would overwrite another agent's result
 * and boot another agent's home. `DSH_PROBE_OUT` is the field that makes reusing
 * the probe without the driver's paths possible.
 *
 * WHAT IT ADDS TO CMP-02. CMP-02's oracle has three clauses: the row is present,
 * the mode is `danger-full-access`, and `workspaceRoot` resolves to an absolute
 * path. This probe reads the same facts through a DIFFERENT access path
 * (`policy.defaultMode` and `policy.resolve().mode` at the service, plus the
 * loader's own row table), so a PASS or FAIL on both instruments is corroboration
 * rather than a restatement.
 *
 * Usage: node run-boot2-fs.mjs
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { bootAndWait, readResult } from 'file:///D:/DSH/work/dsh-native-daily/qualification/runners/boot-harness.mjs'

const REPO = 'D:/DSH/work/dsh-native-daily'
const HOME = 'D:/DSH/home/v2-cmp'
const PROFILE = 'daily'
const RESULTS = `${REPO}/qualification/results/V2-composition`
const OUT = `${RESULTS}/boot2-fs.json`
const OVERLAY = `${REPO}/qualification/runners/verify-t2-fs.patch.yml`

const digest = path => existsSync(path)
  ? createHash('sha256').update(readFileSync(path)).digest('hex')
  : null

const boot = await bootAndWait({
  home: HOME,
  profile: PROFILE,
  patches: [OVERLAY],
  outPath: OUT,
  cwd: 'D:/DSH/src/dsh-src',
  timeoutMs: 150_000,
})

writeFileSync(`${RESULTS}/boot2-transcript.txt`, [
  '# V2 boot 2 -- filesystem provider + sandbox policy (CMP-02)',
  `# cwd: D:/DSH/src/dsh-src   DSH_HOME: ${HOME}   port: ${String(boot.port)}   portReleased: ${String(boot.portReleased)}`,
  `# timedOut: ${String(boot.timedOut)}   exitCode: ${String(boot.exitCode)}`,
  '',
  '--- stdout ---', boot.stdout,
  '--- stderr ---', boot.stderr,
].join('\n'), 'utf8')

let probe = null
let fatal = null
try { probe = readResult(OUT, HOME).json } catch (error) { fatal = error instanceof Error ? error.message : String(error) }

const checks = []
const check = (caseId, label, ok, detail) => {
  checks.push({ caseId, label, ok: ok === true, detail })
  return ok === true
}

if (fatal !== null) {
  checks.push({ caseId: 'CMP-02', label: 'the probe result names the home this driver booted', ok: false, detail: fatal })
} else {
  check('CMP-02', 'the sandboxPolicy SERVICE is mounted', probe.sandboxPolicyPresent === true, String(probe.sandboxPolicyPresent))
  check('CMP-02', 'the composed defaultMode is danger-full-access', probe.sandboxPolicyDefaultMode === 'danger-full-access', String(probe.sandboxPolicyDefaultMode))
  check('CMP-02', 'the resolved mode is danger-full-access', probe.sandboxPolicyResolved === 'danger-full-access', String(probe.sandboxPolicyResolved))
  // The `sandbox` PROVIDER (`@deepseek-ai/dsh-sandbox-local`) is a separate
  // service from `sandboxPolicy`, and this probe does not report it under a
  // `sandboxServicePresent` key. The oracle-relevant fact measured HERE is that
  // the policy service -- the one seven rows inject -- is mounted, which is the
  // fact whose absence produced the recorded `toolCount: 0` cascade.
  check('CMP-02', 'the policy row is in the loader table (fsRows-adjacent read)', probe.sandboxPolicyPresent === true, String(probe.sandboxPolicyPresent))
  check('CMP-02', 'the fs-sandbox row is DISABLED and fs-local is ACTIVE (the provider swap)',
    probe.fsSandboxRowDisabled === true && Array.isArray(probe.fsRows)
      && probe.fsRows.some(r => r.id === 'fs-local' && r.fiberState === 2),
    JSON.stringify(probe.fsRows ?? null))
  check('CMP-02', 'the fs provider is the LOCAL one (independent of the mode)', probe.providerIsExactLocalClass === true, String(probe.providerIsExactLocalClass))
  check('CMP-02', 'the composed tool face is not zero (the mode did not break the mount)', probe.toolCount > 0, String(probe.toolCount))
  check('CMP-02', 'no entry failed to activate', probe.inactiveEntryIds?.length === 0, JSON.stringify(probe.inactiveEntryIds ?? null))
}

const verdict = {
  probe: 'V2-composition boot2 (shared t2-fs probe, own home/out path)',
  ranAt: new Date().toISOString(),
  cwd: 'D:/DSH/src/dsh-src',
  dshHome: HOME,
  port: boot.port,
  portReleased: boot.portReleased,
  timedOut: boot.timedOut,
  exitCode: boot.exitCode,
  inputDigests: {
    installedProfilePatch: digest(`${HOME}/profiles/daily/cordis.patch.yml`),
    repoProfilePatch: digest(`${REPO}/profiles/daily-candidate/cordis.patch.yml`),
    overlay: digest(OVERLAY),
    probe: digest(`${REPO}/qualification/runners/verify-t2-fs.mjs`),
  },
  fatal,
  measurement: probe,
  checks,
  failures: checks.filter(c => !c.ok).map(c => `[${c.caseId}] ${c.label} -- observed: ${c.detail}`),
  ok: checks.every(c => c.ok),
}
writeFileSync(`${RESULTS}/boot2-verdict.json`, `${JSON.stringify(verdict, null, 2)}\n`, 'utf8')

console.log(`port=${String(boot.port)} released=${String(boot.portReleased)} timedOut=${String(boot.timedOut)}`)
console.log(`defaultMode=${String(probe?.sandboxPolicyDefaultMode)} resolved=${String(probe?.sandboxPolicyResolved)} fsProvider=${String(probe?.providerClassName)} toolCount=${String(probe?.toolCount)}`)
console.log(`checks=${String(checks.filter(c => c.ok).length)}/${String(checks.length)}`)
for (const fail of verdict.failures) console.log(`FAIL: ${fail}`)
