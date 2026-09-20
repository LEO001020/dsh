/**
 * THE LOUDNESS VERDICT, with the probe-free boot that makes it attributable.
 *
 * WHY A SEPARATE DRIVER. The negative-arm probe proves the guard's PREDICATE
 * fires (it calls `checkBoundarySync` explicitly and catches the refusal), but it
 * cannot prove the BOOT is loud: the probe itself throws `probe-complete` to end
 * the run, and that throw appears in stderr as "1 entry did not activate". Those
 * two facts are indistinguishable in that stderr. So this driver boots the SAME
 * profile with NO probe mounted and reports an explicit verdict over the real
 * stderr, with the healthy boot as the control.
 *
 * THE VERDICT IS EXPLICIT ON PURPOSE. The first version of this file wrote only
 * {exitCode, timedOut, stderr} for each arm, and a reader could not extract a
 * finding from it: an EMPTY stderr is the healthy signature, so "no warning" and
 * "the guard did not fire" are the same bytes. The `verdict` object below states
 * each claim as a boolean computed from those bytes, and `diagnosis` says which
 * of the two readings the pair supports.
 *
 * USAGE
 *   node .probe/measure-loudness-verdict.mjs
 */
import { bootAndWait } from '../qualification/runners/boot-harness.mjs'
import { writeFileSync, mkdirSync } from 'node:fs'

const DIR = 'D:/DSH/work/wt-r1/qualification/results/R1-trusted-local'
mkdirSync(DIR, { recursive: true })

async function arm(label, patches) {
  const boot = await bootAndWait({
    patches,
    home: 'D:/DSH/home/r1',
    profile: 'daily',
    outPath: `${DIR}/loudness-${label}.never-written.json`,
    cwd: 'C:/Windows/Temp',
    // A healthy boot is a server that is SUPPOSED to keep running, so the
    // harness's timeout is the healthy signature. A confining boot must be
    // distinguishable from it by stderr, not by the clock.
    timeoutMs: 30_000,
  })
  const stderr = String(boot.stderr)
  const stdout = String(boot.stdout)
  const entryNamed = /daily-no-sandbox-contract/u.test(stderr)
  const refusalText = /trusted-local contract violated/u.test(stderr)
  const warning = (stderr.match(/warning: \d+ entr(?:y|ies) did not activate/u) ?? [null])[0]
  return {
    label,
    patches,
    port: boot.port,
    exitCode: boot.exitCode,
    timedOut: boot.timedOut,
    served: /dsh web: http:\/\/127\.0\.0\.1:\d+/u.test(stdout),
    activationWarningLine: warning,
    guardEntryNamedOnStderr: entryNamed,
    refusalTextOnStderr: refusalText,
    stderr,
    stdout,
  }
}

const healthy = await arm('healthy', [])
const reverted = await arm('reverted-mode', ['D:/DSH/work/wt-r1/.probe/revert-sandbox-mode.patch.yml'])

const record = {
  ranAt: new Date().toISOString(),
  subject: 'is a CONFINING mode loud at process level, with no probe in the tree?',
  arms: { healthy, reverted },
  verdict: {
    'healthy boot is quiet (control: the warning line is absent)': healthy.activationWarningLine === null,
    'reverted boot names the guard entry on stderr': reverted.guardEntryNamedOnStderr,
    'reverted boot carries the refusal text on stderr': reverted.refusalTextOnStderr,
    'reverted boot is DISTINGUISHABLE from the healthy boot on stderr':
      reverted.stderr.trim() !== healthy.stderr.trim(),
  },
}
record.diagnosis = record.verdict['reverted boot names the guard entry on stderr']
  ? 'LOUD: the confining mode makes the process report a failed entry on stderr, so the deployment cannot be mistaken for a healthy one.'
  : 'SILENT: the confining mode produced the SAME stderr as the healthy control, so the guard refused nothing the operator can see. The startup boundary is NOT loud.'
writeFileSync(`${DIR}/loudness-verdict.json`, JSON.stringify(record, null, 1))
console.log(JSON.stringify(record.verdict, null, 1))
console.log('DIAGNOSIS:', record.diagnosis)
console.log('healthy stderr:', JSON.stringify(healthy.stderr))
console.log('reverted stderr:', JSON.stringify(reverted.stderr))
