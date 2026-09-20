/**
 * AFTER-FIX loudness: is a confining mode loud at process level now?
 *
 * Same two arms as `measure-loudness-verdict.mjs` (healthy control, reverted
 * profile), with NO probe in the tree so nothing but the product can write to
 * stderr. The verdict object is explicit because an EMPTY stderr is the healthy
 * signature, so "no warning" and "the guard did not fire" are the same bytes and
 * a reader must not have to infer which one they are looking at.
 *
 * USAGE
 *   node .probe/measure-loudness-after-fix.mjs
 */
import { bootAndWait } from '../qualification/runners/boot-harness.mjs'
import { writeFileSync, mkdirSync } from 'node:fs'

const DIR = 'D:/DSH/work/wt-r1/qualification/results/R1-trusted-local'
mkdirSync(DIR, { recursive: true })

async function arm(label, patches) {
  const boot = await bootAndWait({
    patches, home: 'D:/DSH/home/r1', profile: 'daily',
    outPath: `${DIR}/loudness-after-${label}.never-written.json`,
    cwd: 'C:/Windows/Temp', timeoutMs: 30_000,
  })
  const stderr = String(boot.stderr)
  const stdout = String(boot.stdout)
  return {
    label, patches,
    port: boot.port, exitCode: boot.exitCode, timedOut: boot.timedOut,
    served: /dsh web: http:\/\/127\.0\.0\.1:\d+/u.test(stdout),
    activationWarningLine: (stderr.match(/warning: \d+ entr(?:y|ies) did not activate/u) ?? [null])[0],
    guardEntryNamedOnStderr: /daily-no-sandbox-contract/u.test(stderr),
    refusalTextOnStderr: /trusted-local contract violated/u.test(stderr),
    // The violating CHECK ID must appear, so the refusal names what was wrong
    // rather than only that something was.
    violationIdOnStderr: /startup\.sandboxPolicy\.mode/u.test(stderr),
    observedConfinedModeOnStderr: /'workspace-write'/u.test(stderr),
    stderr, stdout,
  }
}

const healthy = await arm('healthy', [])
const reverted = await arm('reverted-mode', ['D:/DSH/work/wt-r1/.probe/revert-sandbox-mode.patch.yml'])

const verdict = {
  'healthy boot is quiet (control: no activation warning)': healthy.activationWarningLine === null,
  'healthy boot does NOT name the guard entry (no false alarm)': !healthy.guardEntryNamedOnStderr,
  'reverted boot names the guard entry on stderr': reverted.guardEntryNamedOnStderr,
  'reverted boot carries the refusal text on stderr': reverted.refusalTextOnStderr,
  'reverted boot names the failing check id': reverted.violationIdOnStderr,
  'reverted boot reports the observed confining mode': reverted.observedConfinedModeOnStderr,
  'reverted boot is DISTINGUISHABLE from the healthy control on stderr':
    reverted.stderr.trim() !== healthy.stderr.trim(),
}
const record = {
  ranAt: new Date().toISOString(),
  subject: 'after fixing the startup wiring: is a confining mode loud at process level?',
  arms: { healthy, reverted },
  verdict,
}
record.diagnosis = verdict['reverted boot names the guard entry on stderr']
  ? 'LOUD: the confining mode fails an entry that stderr names, with the failing check id and the observed mode. The deployment cannot be mistaken for a healthy one.'
  : 'STILL SILENT: the guard did not reach a process channel.'
writeFileSync(`${DIR}/loudness-after-fix.json`, JSON.stringify(record, null, 1))
console.log(JSON.stringify(verdict, null, 1))
console.log('DIAGNOSIS:', record.diagnosis)
console.log('--- reverted stderr ---')
console.log(reverted.stderr.split('\n').slice(0, 14).join('\n'))
