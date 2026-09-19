/**
 * V2 COMPOSITION boot 1: the deliverable profile's OWN model-facing surface,
 * booted from a FOREIGN cwd with a probe that adds NO row.
 *
 * WHAT THIS ESTABLISHES, case by case (mapped by ORACLE, not by label):
 *   CMP-04  the model-visible tool surface is intact and named
 *   CMP-05  (anchored arm) the preset root is absolute and derived from the profile dir
 *   CMP-11  the ipython tool is carried by the PRODUCT (no overlay inserted a row)
 *   CMP-13  the shell leaves the daily preset (pwsh ABSENT, ipython present)
 *   CMP-01  (part) zero entries report "did not activate"
 *
 * WHY THIS DRIVER EXISTS AT ALL. `verify-deliverable-surface.mjs` is a pure
 * measurement with no opinion; the judgement has to live somewhere, and the
 * oracle for these cases is a comparison against named values. Putting the
 * judgement here rather than editing the shared probe keeps the probe reusable.
 *
 * THE TRAPS IT DEFENDS AGAINST, all of which produced false findings in this
 * project already:
 *   - a FIXED output path (G-FIX-13): `DSH_PROBE_OUT` names this run's file and
 *     `readResult()` asserts the result's `presetRoots` name the home booted;
 *   - a stale INSTALL: every installed input's digest is recorded beside the
 *     repository digest, so a home carrying an old patch is visible as a
 *     mismatch rather than as a composition failure;
 *   - a stale BUILD: the extension packages resolve `lib/`, so the `lib/`
 *     digests of both extension packages are recorded too;
 *   - a port collision: `boot-harness.mjs` binds port 0 and verifies release.
 *
 * Usage: node run-boot1-surface.mjs
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { bootAndWait, readResult } from 'file:///D:/DSH/work/dsh-native-daily/qualification/runners/boot-harness.mjs'

const REPO = 'D:/DSH/work/dsh-native-daily'
const HOME = 'D:/DSH/home/v2-cmp'
const PROFILE = 'daily'
const OUT = `${REPO}/qualification/results/V2-composition/boot1-surface.json`
const OVERLAY = `${REPO}/qualification/runners/verify-deliverable-surface.patch.yml`
const TRANSCRIPT = `${REPO}/qualification/results/V2-composition/boot1-transcript.txt`

const digest = path => {
  try {
    return createHash('sha256').update(readFileSync(path)).digest('hex')
  } catch (error) {
    return `unreadable: ${error instanceof Error ? error.message : String(error)}`
  }
}

const INPUTS = {
  installedProfilePatch: `${HOME}/profiles/daily/cordis.patch.yml`,
  repoProfilePatch: `${REPO}/profiles/daily-candidate/cordis.patch.yml`,
  installedPreset: `${HOME}/profiles/daily/presets/daily-standard/agent.cordis.yml`,
  repoPreset: `${REPO}/profiles/daily-candidate/presets/daily-standard/agent.cordis.yml`,
  workBundlePatch: `${REPO}/packages/dsh-daily-work/cordis.patch.yml`,
  ipythonBundlePatch: `${REPO}/packages/dsh-ipython/cordis.patch.yml`,
  workLibHost: `${REPO}/packages/dsh-daily-work/lib/host.js`,
  ipythonLibTool: `${REPO}/packages/dsh-ipython/lib/ipython-tool.js`,
  overlay: OVERLAY,
}
const inputDigests = Object.fromEntries(Object.entries(INPUTS).map(([k, v]) => [k, digest(v)]))

const boot = await bootAndWait({
  home: HOME,
  profile: PROFILE,
  patches: [OVERLAY],
  outPath: OUT,
  // FOREIGN cwd, on a different drive from both the profile and the repo. This
  // is the direction that catches a cwd-relative preset root (CMP-05).
  cwd: 'C:/',
  timeoutMs: 120_000,
})

writeFileSync(TRANSCRIPT, [
  `# V2 boot 1 -- deliverable surface, foreign cwd`,
  `# command: node ${REPO}/apps/cli/lib/bin.js --profile ${PROFILE} --patch ${OVERLAY} --patch <freeport>.yml --no-open`,
  `# cwd: C:/   DSH_HOME: ${HOME}   port: ${String(boot.port)}   portReleased: ${String(boot.portReleased)}`,
  `# timedOut: ${String(boot.timedOut)}   exitCode: ${String(boot.exitCode)}`,
  '',
  '--- stdout ---',
  boot.stdout,
  '--- stderr ---',
  boot.stderr,
].join('\n'), 'utf8')

let result
let fatal = null
try {
  result = readResult(OUT, HOME).json
} catch (error) {
  fatal = error instanceof Error ? error.message : String(error)
}

// The activation-warning search, over BOTH streams AND the probe's own live
// loader audit. A log scrape alone is ambiguous (a host killed before the audit
// printed shows nothing), which is why the probe's in-process audit is the
// primary and this is the corroboration.
const WARNING_PATTERNS = [
  /did not activate/i,
  /entries? did not activate/i,
  /waiting for services/i,
  /failed to mount/i,
]
const scanText = `${boot.stdout}\n${boot.stderr}`
const warningHits = scanText.split(/\r?\n/).filter(line => WARNING_PATTERNS.some(p => p.test(line)))

const checks = []
const check = (label, ok, detail) => {
  checks.push({ label, ok: ok === true, detail })
  return ok === true
}

if (fatal !== null) {
  checks.push({ label: 'the probe result describes the home this driver booted', ok: false, detail: fatal })
} else {
  check('the probe result describes the home this driver booted', true, result.presetRoots?.map(r => r.path).join(' | '))
  check('the boot did not time out', boot.timedOut === false, String(boot.timedOut))
  check('the port was released', boot.portReleased === true, String(boot.portReleased))

  // ── CMP-01 (partial): no entry failed to activate ────────────────────────
  check('the boot log carries no "did not activate"/"waiting for services"/"failed to mount" line',
    warningHits.length === 0, warningHits.length === 0 ? 'no matching line' : JSON.stringify(warningHits))
  check('the probe reported no error', result.error === null, String(result.error))

  // ── CMP-04: the named surface ───────────────────────────────────────────
  check('CMP-04 toolCountAgentKey is 28', result.toolCountAgentKey === 28, String(result.toolCountAgentKey))
  check('CMP-04 pwsh is present', result.tools?.includes('pwsh') === true, JSON.stringify(result.tools ?? []))
  check('CMP-04 ipython is present', result.ipythonToolPresent === true, String(result.ipythonToolPresent))
  check('CMP-04 work is present', result.workToolPresent === true, String(result.workToolPresent))

  // ── CMP-13: the shell LEFT the preset ───────────────────────────────────
  const shellNames = (result.tools ?? []).filter(n => n === 'pwsh' || n === 'bash' || n === 'shell' || n === 'run_code')
  check('CMP-13 no shell-equivalent tool is in the daily catalog', shellNames.length === 0, JSON.stringify(shellNames))
  check('CMP-13 ipython is present in the same catalog', result.ipythonToolPresent === true, String(result.ipythonToolPresent))
  check('CMP-13 the full measured name set is recorded', Array.isArray(result.tools) && result.tools.length > 0, `${String(result.tools?.length ?? 0)} names`)

  // ── CMP-11: the PRODUCT carries ipython, no overlay inserted a row ──────
  check('CMP-11 the preset root is the INSTALLED profile directory',
    (result.presetRoots ?? []).some(r => String(r.path).toLowerCase().includes('/v2-cmp/profiles/daily/presets')),
    JSON.stringify(result.presetRoots ?? []))
  check('CMP-11 the overlay inserted no tool row (only the probe row)',
    readFileSync(OVERLAY, 'utf8').includes('verify-deliverable-surface') && !/id:\s*ipython-tool/.test(readFileSync(OVERLAY, 'utf8')),
    'overlay names only the probe row')

  // ── CMP-05 (anchored arm) ───────────────────────────────────────────────
  const ownRoot = (result.presetRoots ?? []).find(r => String(r.path).toLowerCase().includes('/v2-cmp/profiles/daily/presets'))
  check('CMP-05 the profile-derived root is ABSOLUTE', ownRoot !== undefined && /^[A-Za-z]:[\\/]/.test(String(ownRoot.path)), String(ownRoot?.path ?? 'absent'))
  check('CMP-05 daily-standard resolves from that root', (result.presetsListed ?? []).some(p => p.id === 'daily-standard'), JSON.stringify(result.presetsListed ?? []))
  check('CMP-05 the default preset id is daily-standard', result.presetDefaultId === 'daily-standard', String(result.presetDefaultId))
}

const verdict = {
  probe: 'V2-composition boot1-surface',
  ranAt: new Date().toISOString(),
  command: `node ${REPO}/../src/dsh-src/apps/cli/lib/bin.js --profile ${PROFILE} --patch ${OVERLAY} --patch <freeport>.yml --no-open`,
  cwd: 'C:/',
  dshHome: HOME,
  port: boot.port,
  portReleased: boot.portReleased,
  timedOut: boot.timedOut,
  exitCode: boot.exitCode,
  inputDigests,
  activationWarningLines: warningHits,
  fatal,
  result,
  checks,
  failures: checks.filter(c => !c.ok).map(c => `${c.label} -- observed: ${c.detail}`),
  ok: checks.every(c => c.ok),
}
writeFileSync(`${REPO}/qualification/results/V2-composition/boot1-verdict.json`, `${JSON.stringify(verdict, null, 2)}\n`, 'utf8')

console.log(`port=${String(boot.port)} released=${String(boot.portReleased)} timedOut=${String(boot.timedOut)}`)
console.log(`toolCountAgentKey=${String(result?.toolCountAgentKey)} pwsh=${String(result?.tools?.includes('pwsh'))} ipython=${String(result?.ipythonToolPresent)} work=${String(result?.workToolPresent)}`)
console.log(`warningLines=${String(warningHits.length)} checks=${String(checks.filter(c => c.ok).length)}/${String(checks.length)}`)
for (const f of verdict.failures) console.log(`FAIL: ${f}`)
