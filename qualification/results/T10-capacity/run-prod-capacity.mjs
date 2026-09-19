/**
 * T10 driver: boot the REAL daily profile and assert what the composed product
 * can actually do about child capacity.
 *
 * WHY THE DRIVER IS SEPARATE FROM THE PROBE. The probe is a pure measurement
 * with no opinion, so another gate can reuse it. The judgement lives here, in
 * T10's own results directory, so the probe does not inherit this task's
 * expectations.
 *
 * WHY IT ASSERTS RATHER THAN PRINTS. A runner that only prints makes the reader
 * the oracle, and the reader here is a language model reading its own output.
 * Every claim below is a boolean computed from the artifact, and the exit code
 * follows from it.
 *
 * WHY A REAL BOOT. `--dump-config` does NOT execute plugins: it prints the
 * composed row list and never runs the probe's `apply`. Every question here is
 * about ACTIVATION -- whether the guard's listener is live, whether the `work`
 * tool can find a run -- so only a real `--profile` boot answers it.
 *
 * WHAT IT REFUSES TO DO. It does not call `WorkService.createRun`. Calling it
 * would install the very entry point whose reachability is under test, which is
 * the weaker-oracle failure this whole task is about. The single child the probe
 * creates goes through the model-facing `startContinuable` seam.
 *
 * Usage: node run-prod-capacity.mjs
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { bootAndWait, readResult } from 'file:///D:/DSH/work/dsh-native-daily/qualification/runners/boot-harness.mjs'

const REPO = 'D:/DSH/work/dsh-native-daily'
const HOME = 'D:/DSH/home/t10-capacity'
const PROFILE = 'daily'
const OUT = `${REPO}/qualification/results/T10-capacity/prod-capacity.json`
const OVERLAY = `${REPO}/qualification/runners/verify-t10-capacity.patch.yml`

mkdirSync(`${REPO}/qualification/results/T10-capacity`, { recursive: true })

const failures = []
const checks = []

/**
 * Record one assertion. `ok` is compared with `=== true` rather than coerced,
 * so a `null` measurement can never read as a pass.
 */
function check(label, ok, detail) {
  checks.push({ label, ok: ok === true, detail })
  if (ok !== true) failures.push(`${label} -- observed: ${detail}`)
}

const boot = await bootAndWait({
  home: HOME,
  profile: PROFILE,
  patches: [OVERLAY],
  outPath: OUT,
  // A FOREIGN cwd, so a cwd-relative resolution regression is caught.
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
  console.error(`\n--- stdout (tail) ---\n${boot.stdout.split('\n').slice(-40).join('\n')}`)
  process.exit(2)
}

console.log('\n=== MEASURED ===')
console.log(JSON.stringify(json, null, 2))

// ---- The boot itself -------------------------------------------------------
check('the probe produced no error', json.error === null, JSON.stringify(json.error))
check('the daily-work service is mounted', json.workServicePresent === true,
  String(json.workServicePresent))
check('a real Session was created', json.sessionId !== null, JSON.stringify(json.sessionId))

// ---- (1) THE GUARD IS LIVE ON A COMPOSED PROFILE ---------------------------
// This is the fact that decides whether the hard cap is enforced in a
// PRODUCTION path. It is measured behaviourally: a real child was created
// through the model-facing seam and the service's own ledger moved.
check('the ledger limit is the deployment constant 30', json.gateLimit === 30,
  JSON.stringify(json.gateLimit))
check('the ledger was empty before any child (no run needed)',
  json.ledgerBeforeChild?.liveChildren === 0, JSON.stringify(json.ledgerBeforeChild))
check('a real child was created through the model-facing seam', json.childCreated === true,
  `childId=${JSON.stringify(json.childId)} error=${JSON.stringify(json.childCreateError)}`)
check('THE GUARD IS LIVE: the ledger recorded the child (delta 0 -> 1)',
  json.guardIsLive === true,
  `before=${JSON.stringify(json.ledgerBeforeChild?.liveChildren)} `
  + `after=${JSON.stringify(json.ledgerAfterChild?.liveChildren)} delta=${JSON.stringify(json.ledgerDelta)}`)

// ---- (2) IS THE RUN REACHABLE BY A USER ACTION? ----------------------------
// G-SEAM-31. The `work` tool is the model-facing door to the run. If the product
// could create a run, this call would reach the tool body.
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
// The strongest form of "the hard cap of 30 is enforced in a production path":
// a genuine `startContinuable` through the composed `spawn` provider is refused
// by the live guard, before publication.
check('the ledger reached the boundary of 30',
  json.ledgerAtBoundary?.occupied === 30, JSON.stringify(json.ledgerAtBoundary?.occupied))
check('THE CAP IS BINDING IN PRODUCTION: a real creation call was REFUSED at 30',
  json.capRefusedRealChild === true,
  `refused=${JSON.stringify(json.capRefusedRealChild)} error=${JSON.stringify(json.capRefusalError)}`)
check('the refusal names the deployment constant',
  /hard capacity is 30/.test(json.capRefusalError ?? ''),
  JSON.stringify(json.capRefusalError))
check('the refusal never raised occupancy above 30',
  json.ledgerAfterRefusal?.occupied === 30
  && json.ledgerAfterRefusal?.highWater === 30,
  `occupied=${JSON.stringify(json.ledgerAfterRefusal?.occupied)} `
  + `highWater=${JSON.stringify(json.ledgerAfterRefusal?.highWater)}`)
check('releasing the filler returns the ledger to its pre-boundary state',
  json.ledgerAfterRelease?.occupied === json.ledgerBeforeBoundary?.occupied,
  `after=${JSON.stringify(json.ledgerAfterRelease?.occupied)} `
  + `before-boundary=${JSON.stringify(json.ledgerBeforeBoundary?.occupied)}`)
check('the probe leaked no slot: only its own child remains after the release',
  json.ledgerAfterRelease?.occupied === 1 && json.ledgerAfterRelease?.liveChildren === 1,
  JSON.stringify(json.ledgerAfterRelease))

// ---- Report ---------------------------------------------------------------
const passed = checks.filter(c => c.ok).length
console.log(`\n=== CHECKS: ${String(passed)}/${String(checks.length)} passed ===`)
for (const c of checks) {
  console.log(`  ${c.ok ? 'PASS' : 'FAIL'}  ${c.label}`)
  if (!c.ok) console.log(`        observed: ${c.detail}`)
}

const report = {
  probe: 'T10-capacity production reachability',
  ranAt: new Date().toISOString(),
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
writeFileSync(`${REPO}/qualification/results/T10-capacity/prod-capacity-report.json`,
  JSON.stringify(report, null, 2))

console.log(`\nVERDICT: ${report.verdict}`)
if (failures.length > 0) {
  console.log('\n--- stderr (tail) ---')
  console.log(boot.stderr.split('\n').slice(-30).join('\n'))
}
process.exit(failures.length === 0 ? 0 : 1)
