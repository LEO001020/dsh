/**
 * The two remaining wiring candidates for the startup boundary, on a REAL boot.
 *
 * W1 -- `inject: []` kept on the plugin (so the guard cannot go pending), an
 *       ASYNC apply that waits for `sandboxPolicy` through a deferred and then
 *       throws from apply's OWN body. The rejection belongs to the entry's own
 *       fiber, which is the shape already measured LOUD in-process.
 * W2 -- the ROW declares `inject: ['sandboxPolicy']` and apply throws directly.
 *       This is the simplest loud wiring, and it is also the one with a KNOWN
 *       cost: the row becomes PENDING (not FAILED) if the dependency never
 *       appears, which is reported as "waiting for services" rather than as a
 *       contract violation — and a pending row is the toolCount:0 precondition.
 *       It is measured here so that cost is a fact rather than an assumption.
 */
import { bootAndWait } from '../qualification/runners/boot-harness.mjs'
import { writeFileSync, mkdirSync } from 'node:fs'

const DIR = 'D:/DSH/work/wt-r1/qualification/results/R1-trusted-local'
mkdirSync(DIR, { recursive: true })

const boot = await bootAndWait({
  patches: ['D:/DSH/work/wt-r1/.probe/wire2.patch.yml'],
  home: 'D:/DSH/home/r1',
  profile: 'daily',
  outPath: `${DIR}/wire-candidates2.never-written.json`,
  cwd: 'C:/Windows/Temp',
  timeoutMs: 30_000,
})

const stderr = String(boot.stderr)
const verdict = {
  ranAt: new Date().toISOString(),
  subject: 'W1 (deferred + throw from apply) vs W2 (row-level inject + direct throw)',
  port: boot.port,
  exitCode: boot.exitCode,
  timedOut: boot.timedOut,
  stdout: boot.stdout,
  stderr,
  activationWarningLine: (stderr.match(/warning: \d+ entr(?:y|ies) did not activate/u) ?? [null])[0],
  w1ThrowListed: /wire-w1-deferred-throw[^\n]*W1-DEFERRED-THROW-MARKER/s.test(stderr),
  w1MarkerAnywhere: stderr.includes('W1-DEFERRED-THROW-MARKER'),
  w1HealthyListed: /wire-w1-deferred-healthy/u.test(stderr),
  w1MissingListed: /wire-w1-deferred-missing/u.test(stderr),
  w2ThrowListed: /wire-w2-row-inject-throw[^\n]*W2-ROW-INJECT-THROW-MARKER/s.test(stderr),
  w2MarkerAnywhere: stderr.includes('W2-ROW-INJECT-THROW-MARKER'),
  w2HealthyListed: /wire-w2-row-inject-healthy/u.test(stderr),
  webUrlPrinted: /dsh web: http:\/\/127\.0\.0\.1:\d+/u.test(String(boot.stdout)),
}
verdict.VERDICT = {
  'W1: a throw from apply body AFTER awaiting the dependency is LOUD': verdict.w1ThrowListed,
  'W1: HEALTHY control stays quiet': !verdict.w1HealthyListed,
  'W1: a never-mounting dependency does not hang the boot (no unhandled pending entry)': verdict.webUrlPrinted && !verdict.w1MissingListed,
  'W2: a row-level inject with a direct throw is LOUD': verdict.w2ThrowListed,
  'W2: HEALTHY control stays quiet': !verdict.w2HealthyListed,
}
writeFileSync(`${DIR}/wire-candidates2.json`, JSON.stringify(verdict, null, 1))
console.log(JSON.stringify(verdict.VERDICT, null, 1))
console.log('--- stderr ---')
console.log(stderr.split('\n').slice(0, 30).join('\n'))
