/**
 * Measure DSH's OWN loudness channel for the two failure shapes the guard can
 * take, on a REAL boot of the composed daily profile.
 *
 * WHY A BOOT AND NOT A REASONING STEP. The claim "the guard fails LOUD at
 * startup" depends on how DSH reports a failure, and DSH's own source shows two
 * different classifications (FAILED -> listed with its error; ACTIVE -> not
 * listed at all). Which one the guard's wiring produces is a property of the
 * COMPOSED host, so it is measured here rather than inferred.
 *
 * ONE BOOT. No probe result file: the finding IS the stderr, so the harness is
 * allowed to run to its timeout (the healthy signature for a server).
 */
import { bootAndWait } from '../qualification/runners/boot-harness.mjs'
import { writeFileSync, mkdirSync } from 'node:fs'

const DIR = 'D:/DSH/work/wt-r1/qualification/results/R1-trusted-local'
mkdirSync(DIR, { recursive: true })

const boot = await bootAndWait({
  patches: ['D:/DSH/work/wt-r1/.probe/loudness.patch.yml'],
  home: 'D:/DSH/home/r1',
  profile: 'daily',
  outPath: `${DIR}/loudness-channel.never-written.json`,
  cwd: 'C:/Windows/Temp',
  timeoutMs: 30_000,
})

const stderr = String(boot.stderr)
const verdict = {
  ranAt: new Date().toISOString(),
  subject: 'DSH loudness channel for an async-apply rejection vs a discarded child-fiber throw',
  port: boot.port,
  exitCode: boot.exitCode,
  timedOut: boot.timedOut,
  stdout: boot.stdout,
  stderr,
  // The three questions, answered as booleans over the REAL stderr.
  asyncApplyRejectionListed: /loudness-async-apply[^\n]*ASYNC-APPLY-REJECTION-MARKER/s.test(stderr),
  asyncApplyMarkerAnywhere: stderr.includes('ASYNC-APPLY-REJECTION-MARKER'),
  childFiberThrowListed: /loudness-child-fiber[^\n]*CHILD-FIBER-THROW-MARKER/s.test(stderr),
  childFiberMarkerAnywhere: stderr.includes('CHILD-FIBER-THROW-MARKER'),
  activationWarningLine: (stderr.match(/warning: \d+ entr(?:y|ies) did not activate/u) ?? [null])[0],
}
verdict.VERDICT = {
  'async-apply rejection is LOUD (entry FAILED, named on stderr)': verdict.asyncApplyRejectionListed,
  'discarded child-fiber throw is LOUD (entry FAILED, named on stderr)': verdict.childFiberThrowListed,
}
writeFileSync(`${DIR}/loudness-channel.json`, JSON.stringify(verdict, null, 1))
console.log(JSON.stringify(verdict.VERDICT, null, 1))
console.log('--- stderr ---')
console.log(stderr.split('\n').slice(0, 30).join('\n'))
