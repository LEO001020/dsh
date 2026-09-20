/**
 * S1 driver: boot the REAL installed daily profile and record the mode roster.
 *
 * Run: node qualification/results/S1-single-mode/s1-roster-driver.mjs before
 *      node qualification/results/S1-single-mode/s1-roster-driver.mjs after
 *
 * It boots `--profile daily` from DSH_HOME=D:\DSH\home\s1 -- the profile
 * `helpers/new-writer.ps1` installed for this writer, whose `link:` targets
 * point at THIS worktree (proved by `.writer-provision.json`, and re-proved
 * below by digesting the built libs the boot actually executes).
 *
 * BEFORE and AFTER are the SAME command with the SAME probe: the only variable
 * is `includeShippedRoot` in `profiles/daily-candidate/cordis.patch.yml`. That
 * is what makes the pair an experiment rather than two unrelated observations.
 *
 * THE STALE-PROFILE TRAP. The profile is INSTALLED BY COPY, so an edit to the
 * repository file does not reach a boot until it is re-installed. The driver
 * therefore re-copies the profile -- and re-applies the same link-target
 * rewrite the provisioner applies -- before every boot. Without this step a run
 * would report the PREVIOUS configuration while believing it measured the new
 * one, which is the stale-artifact failure this project already filed twice
 * (G-SEAM-29, G-SEAM-36).
 */
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { bootAndWait, readResult } from '../../runners/boot-harness.mjs'

const HOME = 'D:/DSH/home/s1'
const PROFILE = 'daily'
const INSTALLED = `${HOME}/profiles/${PROFILE}`
const REPO = 'D:/DSH/work/wt-s1'
const RESULTS = `${REPO}/qualification/results/S1-single-mode`

// The SAME rewrite the provisioner applies, applied here so the driver cannot
// silently measure a profile bound to another tree. Kept as a literal string
// replace of the main-tree path for the same reason `new-writer.ps1:99` does it
// that way: that literal is the string the committed profile actually contains.
const MAIN_TREE = 'D:/DSH/work/dsh-native-daily'

const label = process.argv[2] ?? 'before'
if (label !== 'before' && label !== 'after') {
  process.stderr.write('usage: s1-roster-driver.mjs [before|after]\n')
  process.exit(2)
}

mkdirSync(RESULTS, { recursive: true })

// ── 1. Re-install the profile from THIS repo, with the same rewrite ─────────
copyFileSync(`${REPO}/profiles/daily-candidate/cordis.patch.yml`, `${INSTALLED}/cordis.patch.yml`)
{
  const text = readFileSync(`${REPO}/profiles/daily-candidate/package.json`, 'utf8')
    .split(MAIN_TREE).join(REPO)
  writeFileSync(`${INSTALLED}/package.json`, text)
}

// ── 2. Digest the exact bytes the boot will execute ─────────────────────────
// The profile is `link:`-ed, so the boot runs these built libs. Without this a
// reader cannot tell which build the numbers describe.
//
// The paths are the packages' OWN declared entry points (`exports`/`main` in
// each `package.json`), not guesses: `dsh-daily-work` exposes `./lib/host-plugin.js`
// as its main, and `dsh-ipython` exposes `./lib/host-plugin.js` under `./host`
// plus `./lib/ipython-tool.js` under `./tool`. An earlier revision of this file
// named `packages/dsh-ipython/lib/index.js`, which does not exist -- the digest
// came back `null`, which is exactly the "measured zero vs not measured"
// confusion this project records, so the real entries are used and a `null`
// below now means a genuinely missing build.
const TRACKED = [
  'packages/dsh-daily-work/lib/host-plugin.js',
  'packages/dsh-ipython/lib/host-plugin.js',
  'packages/dsh-ipython/lib/ipython-tool.js',
]
const digest = (rel) => {
  const p = join(REPO, rel)
  return existsSync(p) ? createHash('sha256').update(readFileSync(p)).digest('hex') : null
}
const artifacts = Object.fromEntries(TRACKED.map(rel => [rel, digest(rel)]))

// ── 3. Boot and read the probe's own answer ─────────────────────────────────
const outPath = `${RESULTS}/roster-${label}.json`
const patchPath = `${RESULTS}/s1-roster-probe.patch.yml`
writeFileSync(patchPath, [
  '# S1 verification overlay: THE PROBE ONLY. No preset row, no agent-presets row.',
  "# The roster this measures is produced by the profile's own composition.",
  '- insert:',
  '    - id: s1-roster-probe',
  `      name: '${REPO}/qualification/results/S1-single-mode/s1-roster-probe.mjs'`,
  '',
].join('\n'))

const boot = await bootAndWait({
  home: HOME,
  profile: PROFILE,
  patches: [patchPath],
  outPath,
  cwd: REPO,
  timeoutMs: 120_000,
})

let probe = null
let probeError = null
try {
  // The harness's guard against the fixed-output-path false PASS: it asserts
  // the result names the home this caller booted.
  probe = readResult(outPath, HOME).json
} catch (error) {
  probeError = error instanceof Error ? error.message : String(error)
}

const report = {
  label,
  driver: 's1-roster-driver',
  home: HOME,
  profile: PROFILE,
  bootCwd: REPO,
  port: boot.port,
  portReleased: boot.portReleased,
  exitCode: boot.exitCode,
  timedOut: boot.timedOut,
  executedArtifacts: artifacts,
  sourceProfilePatchSha256: createHash('sha256')
    .update(readFileSync(`${REPO}/profiles/daily-candidate/cordis.patch.yml`)).digest('hex'),
  probe,
  probeError,
  activationWarnings: boot.stderr.split('\n')
    .filter(l => /did not activate|waiting for service|startup failed/i.test(l)),
  stderrTail: boot.stderr.split('\n').slice(-25).join('\n'),
}
writeFileSync(`${RESULTS}/driver-${label}.json`, JSON.stringify(report, null, 2))

process.stdout.write(`\n=== S1 roster boot (${label}) ===\n`)
process.stdout.write(`port: ${String(boot.port)}  exit: ${String(boot.exitCode)}  timedOut: ${String(boot.timedOut)}\n`)
if (probeError !== null) process.stdout.write(`PROBE READ ERROR: ${probeError}\n`)
if (probe !== null) {
  process.stdout.write(`roots:\n${(probe.roots ?? []).map(r => `  ${r.trust}  ${r.path}`).join('\n')}\n`)
  process.stdout.write(`shippedRootPresent: ${String(probe.shippedRootPresent)}\n`)
  process.stdout.write(`listedIds: ${JSON.stringify(probe.listedIds)}\n`)
  process.stdout.write(`listedCount: ${String(probe.listedCount)}\n`)
  process.stdout.write(`defaultId: ${String(probe.defaultId)}\n`)
  process.stdout.write(`selectionPolicy: ${JSON.stringify(probe.selectionPolicy)}\n`)
  for (const [id, r] of Object.entries(probe.resolveOf ?? {})) {
    process.stdout.write(`resolve(${id}): ${r.resolved ? `OK ${String(r.path)}` : `THROWS ${String(r.error)}`}\n`)
  }
  process.stdout.write(`sessionAgentPreset: ${String(probe.sessionAgentPreset)}\n`)
  process.stdout.write(`toolCountAgentKey: ${String(probe.toolCountAgentKey)}  ipython: ${String(probe.ipythonToolPresent)}  work: ${String(probe.workToolPresent)}\n`)
  if (probe.error !== null && probe.error !== undefined) process.stdout.write(`probe error: ${String(probe.error)}\n`)
}
process.stdout.write(`activationWarnings: ${String(report.activationWarnings.length)}\n`)
for (const line of report.activationWarnings) process.stdout.write(`  ${line}\n`)
