/**
 * Which wiring makes the startup boundary's refusal LOUD, without hanging the
 * boot when the dependency never appears?
 *
 * ESTABLISHED before this run (see `loudness-channel.json` and `.probe-fiber*.mjs`):
 * a throw inside a DISCARDED `ctx.inject` child fiber leaves the ENTRY's fiber
 * ACTIVE, and DSH's activation audit classifies by the entry's fiber — so the
 * refusal produced no stderr line at all. The fix candidates are measured here
 * on a REAL boot, all in ONE process, and P3 is the one that decides whether the
 * fix is safe: an `await` on a dependency that never mounts must not stop the
 * loader from settling.
 */
import { bootAndWait } from '../qualification/runners/boot-harness.mjs'
import { writeFileSync, mkdirSync } from 'node:fs'

const DIR = 'D:/DSH/work/wt-r1/qualification/results/R1-trusted-local'
mkdirSync(DIR, { recursive: true })

const boot = await bootAndWait({
  patches: ['D:/DSH/work/wt-r1/.probe/wire.patch.yml'],
  home: 'D:/DSH/home/r1',
  profile: 'daily',
  outPath: `${DIR}/wire-candidates.never-written.json`,
  cwd: 'C:/Windows/Temp',
  timeoutMs: 30_000,
})

const stderr = String(boot.stderr)
const verdict = {
  ranAt: new Date().toISOString(),
  subject: 'wiring candidates for the startup boundary: loud on violation, safe when the dependency never mounts',
  port: boot.port,
  exitCode: boot.exitCode,
  timedOut: boot.timedOut,
  elapsedMs: boot.elapsedMs ?? null,
  stdout: boot.stdout,
  stderr,
  activationWarningLine: (stderr.match(/warning: \d+ entr(?:y|ies) did not activate/u) ?? [null])[0],
  p1ChildThrowListedOnStderr: /wire-p1-await-child-throws[^\n]*P1-CHILD-THROW-MARKER/s.test(stderr),
  p1MarkerAnywhere: stderr.includes('P1-CHILD-THROW-MARKER'),
  p2HealthyListed: /wire-p2-await-child-healthy/u.test(stderr),
  p3MissingServiceListed: /wire-p3-await-missing-service/u.test(stderr),
  p3MarkerAnywhere: stderr.includes('serviceThatNeverMounts'),
  // The healthy boot signature: the server started and printed its URL, and the
  // process was still alive at the harness timeout.
  webUrlPrinted: /dsh web: http:\/\/127\.0\.0\.1:\d+/u.test(String(boot.stdout)),
}
verdict.VERDICT = {
  'P1: awaiting a child fiber whose callback throws is LOUD (entry FAILED, named on stderr)': verdict.p1ChildThrowListedOnStderr,
  'P2: the same wiring on a HEALTHY callback stays quiet (no false alarm)': !verdict.p2HealthyListed,
  'P3: awaiting a child fiber whose dependency never mounts does NOT hang the boot': verdict.webUrlPrinted,
  'P3: the never-mounted dependency is named on stderr': verdict.p3MissingServiceListed,
}
writeFileSync(`${DIR}/wire-candidates.json`, JSON.stringify(verdict, null, 1))
console.log(JSON.stringify(verdict.VERDICT, null, 1))
console.log('--- stderr (first 25 lines) ---')
console.log(stderr.split('\n').slice(0, 25).join('\n'))
