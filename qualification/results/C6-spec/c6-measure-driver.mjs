/**
 * C6 measurement: the CURRENT toolCountAgentKey and pwsh presence.
 *
 * This is NOT a new oracle and it does not judge. It boots the provisioned
 * profile from a foreign cwd with a probe that adds NO tool row -- the same
 * stimulus CMP-04 names -- and records the count verbatim.
 *
 * It also measures the SAME catalog a second way (the global/unscoped view) so
 * that "28" can be tested as a MEASUREMENT QUESTION rather than assumed to be a
 * stale catalog. If some other scope key yields 28 with pwsh absent, then the
 * contradiction is an artifact of how the count is taken.
 */
import { writeFileSync, readFileSync, existsSync } from 'node:fs'
import { bootAndWait } from 'file:///D:/DSH/work/wt-c6/qualification/runners/boot-harness.mjs'

const REPO = 'D:/DSH/work/wt-c6'
const HOME = 'D:/DSH/home/c6'
const OUT = `${REPO}/qualification/results/C6-spec/c6-surface.json`
const PROBE = `${REPO}/qualification/results/C6-spec/c6-surface-probe.mjs`
const OVERLAY = `${REPO}/qualification/results/C6-spec/c6-overlay.patch.yml`
const TRANSCRIPT = `${REPO}/qualification/results/C6-spec/c6-transcript.txt`

writeFileSync(OVERLAY, [
  '# C6: ONE row, the PROBE ONLY. No tool row is inserted, so whatever the',
  '# probe reports is produced by the profile\'s own composition.',
  '- insert:',
  '    - id: c6-surface-probe',
  `      name: '${PROBE}'`,
  '',
].join('\n'), 'utf8')

const boot = await bootAndWait({
  home: HOME,
  profile: 'daily',
  patches: [OVERLAY],
  outPath: OUT,
  cwd: 'C:/',
  timeoutMs: 120_000,
})

writeFileSync(TRANSCRIPT, [
  '# C6 surface measurement -- foreign cwd, probe adds NO tool row',
  `# cwd: C:/   DSH_HOME: ${HOME}   port: ${String(boot.port)}   portReleased: ${String(boot.portReleased)}`,
  `# timedOut: ${String(boot.timedOut)}   exitCode: ${String(boot.exitCode)}`,
  '',
  '--- stdout ---',
  boot.stdout,
  '--- stderr ---',
  boot.stderr,
].join('\n'), 'utf8')

let result = null
let fatal = null
try {
  if (!existsSync(OUT)) throw new Error('probe wrote no result')
  result = JSON.parse(readFileSync(OUT, 'utf8'))
} catch (error) {
  fatal = error instanceof Error ? error.message : String(error)
}

const verdict = {
  probe: 'C6 surface measurement',
  ranAt: new Date().toISOString(),
  cwd: 'C:/',
  dshHome: HOME,
  port: boot.port,
  portReleased: boot.portReleased,
  timedOut: boot.timedOut,
  exitCode: boot.exitCode,
  fatal,
  result,
}
writeFileSync(`${REPO}/qualification/results/C6-spec/c6-verdict.json`, `${JSON.stringify(verdict, null, 2)}\n`, 'utf8')

if (result !== null) {
  console.log(`toolCountAgentKey=${String(result.toolCountAgentKey)}`)
  console.log(`toolCountGlobalKey=${String(result.toolCountGlobalKey)}`)
  console.log(`pwshPresent=${String(result.tools?.includes('pwsh'))}`)
  console.log(`ipythonToolPresent=${String(result.ipythonToolPresent)} workToolPresent=${String(result.workToolPresent)}`)
  console.log(`tools(${String(result.tools?.length ?? 0)})=${JSON.stringify(result.tools ?? [])}`)
  console.log(`error=${JSON.stringify(result.error)}`)
} else {
  console.log(`FATAL: ${String(fatal)}`)
}
