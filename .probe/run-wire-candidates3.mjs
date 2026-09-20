/**
 * W1 vs W2, WITHOUT the arm that never settles.
 *
 * The previous run of this probe mixed in an apply that awaits a service which
 * never mounts. Measured consequence: `EntryTree.getTasks()` includes the entry's
 * in-flight apply promise and `loader.await()` loops on it, so `boot()` never
 * reaches `auditStartupEntries` — stdout AND stderr were both empty and the web
 * server never bound. That suppressed the diagnostics for the OTHER arms too, so
 * their results were UNMEASURED rather than negative. This run isolates them.
 */
import { bootAndWait } from '../qualification/runners/boot-harness.mjs'
import { writeFileSync, mkdirSync } from 'node:fs'

const DIR = 'D:/DSH/work/wt-r1/qualification/results/R1-trusted-local'
mkdirSync(DIR, { recursive: true })

const boot = await bootAndWait({
  patches: ['D:/DSH/work/wt-r1/.probe/wire3.patch.yml'],
  home: 'D:/DSH/home/r1', profile: 'daily',
  outPath: `${DIR}/wire-candidates3.never-written.json`,
  cwd: 'C:/Windows/Temp', timeoutMs: 30_000,
})

const stderr = String(boot.stderr)
const verdict = {
  ranAt: new Date().toISOString(),
  subject: 'W1 (deferred await, then throw from apply) vs W2 (row-level inject, direct throw)',
  port: boot.port, exitCode: boot.exitCode, timedOut: boot.timedOut,
  stdout: boot.stdout, stderr,
  activationWarningLine: (stderr.match(/warning: \d+ entr(?:y|ies) did not activate/u) ?? [null])[0],
  w1ThrowListed: /wire-w1-deferred-throw[^\n]*W1-DEFERRED-THROW-MARKER/s.test(stderr),
  w1HealthyListed: /wire-w1-deferred-healthy/u.test(stderr),
  w2ThrowListed: /wire-w2-row-inject-throw[^\n]*W2-ROW-INJECT-THROW-MARKER/s.test(stderr),
  w2HealthyListed: /wire-w2-row-inject-healthy/u.test(stderr),
  webUrlPrinted: /dsh web: http:\/\/127\.0\.0\.1:\d+/u.test(String(boot.stdout)),
}
verdict.VERDICT = {
  'W1: throw from apply after awaiting the dependency is LOUD': verdict.w1ThrowListed,
  'W1: HEALTHY control stays quiet (no false alarm)': !verdict.w1HealthyListed,
  'W2: row-level inject with a direct throw is LOUD': verdict.w2ThrowListed,
  'W2: HEALTHY control stays quiet': !verdict.w2HealthyListed,
  'the boot still served (a violating entry did not stop the process)': verdict.webUrlPrinted,
}
writeFileSync(`${DIR}/wire-candidates3.json`, JSON.stringify(verdict, null, 1))
console.log(JSON.stringify(verdict.VERDICT, null, 1))
console.log('--- stderr ---')
console.log(stderr.split('\n').slice(0, 40).join('\n'))
