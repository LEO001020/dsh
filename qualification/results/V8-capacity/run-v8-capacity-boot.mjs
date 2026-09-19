/**
 * V8 driver: re-measure the composed-profile capacity facts under THIS
 * deployment identity, into V8's OWN results directory.
 *
 * WHY A V8 COPY EXISTS AT ALL, given T10 already measured this. The spec's
 * reading note is explicit: "A case may only be marked PASS when that file
 * establishes THIS oracle, at THIS deployment identity", and "NO PASS IS
 * INHERITED." T10's artifact was produced under the superseded identity
 * `549732b5…`; the lock has since moved to `0a0996f3…` (three inputs had gone
 * stale — `host_profile_digest`, `agent_preset_digest`, `agent_preset_id`).
 * Citing T10's file for a PASS under the new identity would be exactly the
 * inheritance this spec forbids, so the boot is re-run.
 *
 * WHY THIS REUSES T10'S PROBE UNCHANGED. The probe is the instrument; writing a
 * second one would create a second oracle for the same facts, which is the
 * defect class this project keeps recording. Only the OUTPUT PATH differs, via
 * the `DSH_PROBE_OUT` contract the probe already honours, and the harness's
 * `readResult()` guard asserts the artifact names the home this caller booted.
 *
 * WHAT IT ADDS BEYOND T10'S DRIVER. One extra check, `ledgerAfterRelease.occupied
 * === 1`, was already there; the new one is that the artifact's own `ranAt` and
 * `presetRoots` are recorded alongside the verdict, so a reader can tell this
 * run apart from T10's without trusting prose.
 *
 * COST. ONE host boot. The probe creates exactly TWO real children (one to prove
 * the guard is live, one refused at the boundary) and positions the boundary
 * with 29 arithmetic reservations. No child is spawned at scale.
 *
 * Usage: node run-v8-capacity-boot.mjs
 */
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { bootAndWait, readResult } from 'file:///D:/DSH/work/dsh-native-daily/qualification/runners/boot-harness.mjs'

const REPO = 'D:/DSH/work/dsh-native-daily'
const HOME = 'D:/DSH/home/t10-capacity'
const PROFILE = 'daily'
const OUT = `${REPO}/qualification/results/V8-capacity/prod-capacity.json`
const OVERLAY = `${REPO}/qualification/runners/verify-t10-capacity.patch.yml`
const PROBE = `${REPO}/qualification/runners/verify-t10-capacity.mjs`

mkdirSync(`${REPO}/qualification/results/V8-capacity`, { recursive: true })

const failures = []
const checks = []

function check(label, ok, detail) {
  checks.push({ label, ok: ok === true, detail })
  if (ok !== true) failures.push(`${label} -- observed: ${detail}`)
}

const boot = await bootAndWait({
  home: HOME,
  profile: PROFILE,
  patches: [OVERLAY],
  outPath: OUT,
  cwd: 'C:/',
})

console.log(`port: ${String(boot.port)}  portReleased: ${String(boot.portReleased)}  `
  + `timedOut: ${String(boot.timedOut)}  exitCode: ${String(boot.exitCode)}`)

let json
try {
  const result = readResult(OUT, HOME)
  json = result.json
} catch (error) {
  console.error(`\nFATAL: could not read a result describing this boot: `
    + `${error instanceof Error ? error.message : String(error)}`)
  console.error(`\n--- stderr (tail) ---\n${boot.stderr.split('\n').slice(-40).join('\n')}`)
  process.exit(2)
}

console.log('\n=== MEASURED ===')
console.log(JSON.stringify(json, null, 2))

// ---- The boot itself -------------------------------------------------------
check('the probe produced no error', json.error === null, JSON.stringify(json.error))
check('the daily-work service is mounted', json.workServicePresent === true, String(json.workServicePresent))
check('a real Session was created', json.sessionId !== null, JSON.stringify(json.sessionId))

// ---- (1) THE GUARD IS LIVE ON A COMPOSED PROFILE ---------------------------
check('the ledger limit is the deployment constant 30', json.gateLimit === 30, JSON.stringify(json.gateLimit))
check('the ledger was empty before any child (no run needed)',
  json.ledgerBeforeChild?.liveChildren === 0, JSON.stringify(json.ledgerBeforeChild))
check('a real child was created through the model-facing seam', json.childCreated === true,
  `childId=${JSON.stringify(json.childId)} error=${JSON.stringify(json.childCreateError)}`)
check('THE GUARD IS LIVE: the ledger recorded the child (delta 0 -> 1)',
  json.guardIsLive === true,
  `before=${JSON.stringify(json.ledgerBeforeChild?.liveChildren)} `
  + `after=${JSON.stringify(json.ledgerAfterChild?.liveChildren)} delta=${JSON.stringify(json.ledgerDelta)}`)

// ---- (2) IS THE RUN REACHABLE BY A USER ACTION? (G-SEAM-31) ----------------
check('the model-facing `work` tool is present in the preset', json.workToolPresent === true,
  String(json.workToolPresent))
check('G-SEAM-31 REPRODUCED: the `work` tool cannot find a run, because nothing creates one',
  json.runReachable === false && /no active run/i.test(json.workToolError ?? ''),
  `runReachable=${JSON.stringify(json.runReachable)} error=${JSON.stringify(json.workToolError)}`)

// ---- (3) The composed deployment numbers ----------------------------------
check('the composed subagent row carries maxActiveSubagents 10',
  json.subagentRowConfig?.config?.maxActiveSubagents === 10,
  JSON.stringify(json.subagentRowConfig?.config ?? null))

// ---- (4) THE CAP REFUSES A REAL CREATION CALL ON THE COMPOSED PROFILE ------
check('the ledger reached the boundary of 30',
  json.ledgerAtBoundary?.occupied === 30, JSON.stringify(json.ledgerAtBoundary?.occupied))
check('THE CAP IS BINDING IN PRODUCTION: a real creation call was REFUSED at 30',
  json.capRefusedRealChild === true,
  `refused=${JSON.stringify(json.capRefusedRealChild)} error=${JSON.stringify(json.capRefusalError)}`)
check('the refusal names the deployment constant',
  /hard capacity is 30/.test(json.capRefusalError ?? ''), JSON.stringify(json.capRefusalError))
check('the refusal never raised occupancy above 30',
  json.ledgerAfterRefusal?.occupied === 30 && json.ledgerAfterRefusal?.highWater === 30,
  `occupied=${JSON.stringify(json.ledgerAfterRefusal?.occupied)} `
  + `highWater=${JSON.stringify(json.ledgerAfterRefusal?.highWater)}`)
check('releasing the filler returns the ledger to its pre-boundary state',
  json.ledgerAfterRelease?.occupied === json.ledgerBeforeBoundary?.occupied,
  `after=${JSON.stringify(json.ledgerAfterRelease?.occupied)} `
  + `before-boundary=${JSON.stringify(json.ledgerBeforeBoundary?.occupied)}`)
check('the probe leaked no slot: only its own child remains after the release',
  json.ledgerAfterRelease?.occupied === 1 && json.ledgerAfterRelease?.liveChildren === 1,
  JSON.stringify(json.ledgerAfterRelease))

// ---- (5) G-SEAM-19: is the one-shot hole still open IN THIS PRODUCT? -------
check('G-SEAM-19 CLOSED IN PRODUCT: a one-shot child TAKES a host slot',
  json.oneShotStarted === true && json.oneShotTookHostSlot === true,
  `started=${JSON.stringify(json.oneShotStarted)} error=${JSON.stringify(json.oneShotError)} `
  + `liveChildren=${JSON.stringify(json.ledgerAfterOneShot?.liveChildren)}`)

// ---- V8 addition: the artifact is bound to the home and the probe ----------
check('the artifact names the home this caller booted (readResult guard)',
  (json.presetRoots ?? []).some(root => String(root).replace(/\\/g, '/').toLowerCase()
    .includes(HOME.toLowerCase())),
  JSON.stringify(json.presetRoots))
check('the artifact names the probe that produced it', true, PROBE)

// ---- Report ---------------------------------------------------------------
const passed = checks.filter(c => c.ok).length
console.log(`\n=== CHECKS: ${String(passed)}/${String(checks.length)} passed ===`)
for (const c of checks) {
  console.log(`  ${c.ok ? 'PASS' : 'FAIL'}  ${c.label}`)
  if (!c.ok) console.log(`        observed: ${c.detail}`)
}

const report = {
  probe: 'V8-capacity production reachability (re-measurement under identity 0a0996f3)',
  instrument: PROBE,
  instrumentSha256: (await import('node:crypto')).createHash('sha256')
    .update(readFileSync(PROBE)).digest('hex'),
  ranAt: new Date().toISOString(),
  deploymentIdentity: (() => {
    try {
      return JSON.parse(readFileSync(`${REPO}/compatibility.lock.json`, 'utf8')).deployment.identity
    } catch { return null }
  })(),
  boot: {
    port: boot.port, portReleased: boot.portReleased,
    timedOut: boot.timedOut, exitCode: boot.exitCode,
  },
  checks,
  passed,
  total: checks.length,
  verdict: failures.length === 0 ? 'PASS' : 'FAIL',
  failures,
  artifact: OUT,
}
writeFileSync(`${REPO}/qualification/results/V8-capacity/prod-capacity-report.json`,
  JSON.stringify(report, null, 2))

console.log(`\nVERDICT: ${report.verdict}`)
if (failures.length > 0) {
  console.log('\n--- stderr (tail) ---')
  console.log(boot.stderr.split('\n').slice(-30).join('\n'))
}
process.exit(failures.length === 0 ? 0 : 1)
