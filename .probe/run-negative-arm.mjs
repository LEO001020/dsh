import { bootAndWait, readResult } from '../qualification/runners/boot-harness.mjs'
import { writeFileSync, mkdirSync } from 'node:fs'

const label = process.argv[2] ?? 'correct-deployment'
const HOME = 'D:/DSH/home/r1'
const DIR = 'D:/DSH/work/wt-r1/qualification/results/R1-trusted-local'
const OUT = `${DIR}/negative-arm-${label}.json`
mkdirSync(DIR, { recursive: true })

const patches = ['D:/DSH/work/wt-r1/.probe/verify-trusted-local-negative-arm.patch.yml']
if (process.argv[3]) patches.push(process.argv[3])

const boot = await bootAndWait({
  patches, home: HOME, profile: 'daily', outPath: OUT, cwd: 'C:/Windows/Temp', timeoutMs: 180_000,
})

let json = null
try { json = readResult(OUT, HOME).json } catch (e) { json = { ownershipCheckFailed: String(e.message) } }
writeFileSync(`${OUT}.boot.json`, JSON.stringify({ label, boot, patches }, null, 1))

// Merge the boot's OWN stderr into the probe artifact, because the probe runs in
// the booted CHILD process and cannot see this driver's copy.
//
// WHY THIS IS LOAD-BEARING. Once the startup boundary is loud, the guard's entry
// FAILS at `apply`, so `ctx.noSandboxContract` is never published and the probe's
// arm A legitimately reads "service absent". That is the correct outcome, but it
// is indistinguishable in the artifact from "the guard never ran" unless the
// stderr naming the failed entry travels WITH the reading. So the corroborating
// channel is written next to the reading rather than left in a sibling file a
// reader has to know to open.
if (json !== null && typeof json === 'object') {
  const stderr = String(boot.stderr)
  json.bootEvidence = {
    stderr,
    guardEntryNamedOnStderr: /daily-no-sandbox-contract/u.test(stderr),
    refusalTextOnStderr: /trusted-local contract violated at the startup boundary/u.test(stderr),
    activationWarningLine: (stderr.match(/warning: \d+ entr(?:y|ies) did not activate/u) ?? [null])[0],
  }
  writeFileSync(OUT, JSON.stringify(json, null, 1))
}

console.log(`=== negative arm: ${label} ===`)
console.log('port', boot.port, 'released', boot.portReleased, 'timedOut', boot.timedOut, 'exit', boot.exitCode)
console.log('stderr (first 1500):', String(boot.stderr).slice(0, 1500))
console.log(JSON.stringify(json, null, 1))
