/**
 * Measure the LOUDNESS of the startup refusal, with NO probe in the tree.
 *
 * WHY THIS EXISTS. The negative-arm probe proves the guard's predicate fires,
 * but it cannot prove the boot is LOUD, because the probe itself throws
 * `probe-complete` to end the boot and that throw appears in stderr as
 * "1 entry did not activate". Those two facts are indistinguishable in that
 * stderr, so a reader could not tell whether the guard stopped the deployment or
 * the probe did.
 *
 * This driver boots the SAME profile with and without a reverted mode, with NO
 * probe mounted, and reports the exit code, the stderr and the wall time for
 * each. The claim under test is: a confining mode makes the process FAIL (a
 * non-zero exit or a startup failure on stderr), not merely log a warning.
 *
 * USAGE
 *   node .probe/measure-startup-loudness.mjs
 */
import { bootAndWait } from '../qualification/runners/boot-harness.mjs'
import { writeFileSync, mkdirSync } from 'node:fs'

const DIR = 'D:/DSH/work/wt-r1/qualification/results/R1-trusted-local'
mkdirSync(DIR, { recursive: true })

/**
 * Boot once and report the process-level outcome.
 *
 * `outPath` is a file NOTHING writes, so the harness always runs to its timeout
 * or to process exit -- which is exactly what is being measured. A probe would
 * end the boot early and hide the answer.
 */
async function measure(label, extraPatches) {
  const outPath = `${DIR}/loudness-${label}.never-written.json`
  const started = Date.now()
  const boot = await bootAndWait({
    patches: extraPatches,
    home: 'D:/DSH/home/r1',
    profile: 'daily',
    outPath,
    cwd: 'C:/Windows/Temp',
    // Long enough that a HEALTHY boot is killed by the harness rather than by
    // its own timeout: `timedOut: true` is the healthy signature here, because
    // this deployment is a server that is supposed to keep running.
    timeoutMs: 25_000,
  })
  const elapsed = Date.now() - started
  const record = {
    label,
    patches: extraPatches,
    exitCode: boot.exitCode,
    timedOut: boot.timedOut,
    port: boot.port,
    portReleased: boot.portReleased,
    elapsedMs: elapsed,
    stderr: boot.stderr,
    stdout: boot.stdout,
  }
  writeFileSync(`${DIR}/loudness-${label}.json`, JSON.stringify(record, null, 1))
  console.log(`=== ${label} ===`)
  console.log(`  exitCode=${String(boot.exitCode)} timedOut=${String(boot.timedOut)} elapsedMs=${String(elapsed)}`)
  console.log(`  stderr:\n${boot.stderr.split('\n').slice(0, 12).map(l => `    ${l}`).join('\n')}`)
  return record
}

const healthy = await measure('healthy', [])
const reverted = await measure('reverted-mode', ['D:/DSH/work/wt-r1/.probe/revert-sandbox-mode.patch.yml'])

console.log()
console.log('DIFFERENTIAL:')
console.log(`  healthy  exit=${String(healthy.exitCode)} timedOut=${String(healthy.timedOut)}`)
console.log(`  reverted exit=${String(reverted.exitCode)} timedOut=${String(reverted.timedOut)}`)
console.log(`  the reverted boot mentions the contract: ${reverted.stderr.includes('trusted-local contract')}`)
