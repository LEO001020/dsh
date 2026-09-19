/**
 * T4 driver: boot the REAL daily profile from a FOREIGN cwd and ASSERT the
 * agent-preset plane's tool surface, in two phases.
 *
 * WHY THE DRIVER IS HERE AND NOT IN `qualification/runners/`.
 * The named deliverable there is the PROBE (`verify-t4-preset.mjs` + its
 * `.patch.yml`), and it is deliberately a pure measurement with no opinion --
 * the same shape as `verify-deliverable-surface.mjs`. The judgement lives here,
 * in T4's own results directory, so the probe stays reusable by another gate
 * without inheriting this task's expectations.
 *
 * WHY IT ASSERTS RATHER THAN PRINTS.
 * A runner that only prints makes the reader the oracle, and the reader here is
 * a language model reading its own output. So every claim below is a boolean
 * computed from the artifact, and the exit code follows from it.
 *
 * WHY A REAL BOOT.
 * `--dump-config` does NOT execute plugins: it prints the composed row list and
 * never runs the probe's `apply`. Every question here is about ACTIVATION, so
 * only a real `--profile` boot answers it.
 *
 * WHY A FOREIGN CWD.
 * The preset root is `!!js new URL('presets/', ctx.baseUrl)...`; an earlier
 * revision was cwd-relative and resolved only when the operator stood in the
 * profile directory. Booting from `C:/` is the direction that catches a
 * regression to that form.
 *
 * WHY IT DOES NOT TRUST THE PORT OR THE OUTPUT PATH.
 *   - the port is bound-then-released by `boot-harness.mjs`, never assumed
 *     (3080 was held by a stray probe twice on this machine);
 *   - the result is read through `readResult()`, which asserts the preset ROOTS
 *     name the home that was booted. A probe writing to a fixed path is a
 *     SHARED MUTABLE RESOURCE, and two agents running it cannot tell whose
 *     result they hold -- that produced a false PASS earlier in this project.
 *
 * Usage: node run-verify.mjs <before|after>
 */
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { bootAndWait, readResult } from 'file:///D:/DSH/work/dsh-native-daily/qualification/runners/boot-harness.mjs'

const PHASE = process.argv[2]
if (PHASE !== 'before' && PHASE !== 'after') {
  throw new Error('usage: node run-verify.mjs <before|after>')
}

const REPO = 'D:/DSH/work/dsh-native-daily'
const HOME = 'D:/DSH/home/t4-preset'
const PROFILE = 'daily'
const OUT = `${REPO}/qualification/results/T4-preset/boot-${PHASE}.json`
const OVERLAY = `${REPO}/qualification/runners/verify-t4-preset.patch.yml`

/**
 * The preset file the boot will actually read, and its digest.
 *
 * Recorded in the artifact on purpose. The boot reads the copy INSTALLED under
 * `$DSH_HOME/profiles/daily/presets/`, not the repository source, so a reader
 * who only sees the repository would have no way to tell which composition
 * produced these 27 names. The digest binds the two: the `after` artifact
 * carries the hash of the file whose `tool-pwsh` row is disabled, and a reader
 * can re-hash the repository file to confirm it is the same edit.
 */
const PRESET = `${HOME}/profiles/daily/presets/daily-standard/agent.cordis.yml`
const presetDigest = createHash('sha256').update(readFileSync(PRESET)).digest('hex')

/**
 * Digests of EVERY input this boot reads, so the before/after pair is provably
 * a ONE-VARIABLE experiment.
 *
 * This is not bookkeeping. Several agents are editing this repository at the
 * same time, so a reader who sees only "28 tools" and "27 tools" cannot tell
 * whether the difference came from the preset edit or from someone else's
 * change landing in between. Recording every input digest lets them check: if
 * the two artifacts differ in exactly `presetSha256` and nothing else, the
 * delta is attributable.
 *
 * The boot reads the INSTALLED copies under `$DSH_HOME`, not the repository
 * sources, so both are recorded -- an installed copy can drift from the source
 * it was copied from, and that drift would be invisible otherwise.
 */
const INPUTS = {
  installedProfilePatch: `${HOME}/profiles/daily/cordis.patch.yml`,
  repoProfilePatch: `${REPO}/profiles/daily-candidate/cordis.patch.yml`,
  installedPreset: PRESET,
  repoPreset: `${REPO}/profiles/daily-candidate/presets/daily-standard/agent.cordis.yml`,
  workBundlePatch: `${REPO}/packages/dsh-daily-work/cordis.patch.yml`,
  ipythonBundlePatch: `${REPO}/packages/dsh-ipython/cordis.patch.yml`,
  overlay: OVERLAY,
}
const inputDigests = {}
for (const [label, path] of Object.entries(INPUTS)) {
  try {
    inputDigests[label] = createHash('sha256').update(readFileSync(path)).digest('hex')
  } catch (error) {
    // A missing input is recorded as missing, never silently omitted: an
    // absent digest that reads as "unchanged" is worse than no digest.
    inputDigests[label] = `unreadable: ${error instanceof Error ? error.message : String(error)}`
  }
}

const failures = []
const checks = []

/**
 * Record one assertion. `ok` is compared with `=== true` rather than coerced,
 * so a `null` measurement can never read as a pass.
 * @param label - what was asserted, phrased so a reader can falsify it.
 * @param ok - the measured outcome.
 * @param detail - the measurement, recorded on BOTH branches.
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
  // A FOREIGN cwd, on a different drive from both the profile and the repo.
  cwd: 'C:/',
})

console.log(`phase: ${PHASE}`)
console.log(`port: ${String(boot.port)}  portReleased: ${String(boot.portReleased)}  timedOut: ${String(boot.timedOut)}  exitCode: ${String(boot.exitCode)}`)
console.log(`boot_cwd: C:/   home: ${HOME}   profile: ${PROFILE}`)

// (0) A result must exist AND describe this boot. `readResult` is what proves
//     the second half; without it the rest of this file could be judging
//     another agent's run.
let result
try {
  result = readResult(OUT, HOME)
} catch (error) {
  console.error(`\nFATAL: ${error instanceof Error ? error.message : String(error)}`)
  console.error(`\n--- stderr ---\n${boot.stderr}`)
  console.error(`\n--- stdout ---\n${boot.stdout}`)
  process.exit(2)
}
const { json } = result

// (1) The boot itself. "did not activate" is the all-or-nothing failure: a
//     preset with ANY non-activating row fails to mount ENTIRELY, and the
//     measured symptom is `toolCountAgentKey: 0` with every tool absent. Both
//     the log line and the live in-process audit are checked, because the log
//     line's ABSENCE could mean "healthy" or "never printed".
const warningLines = boot.stderr.split('\n').filter(line => line.includes('did not activate'))
check('zero "did not activate" warning lines at boot', warningLines.length === 0,
  `${String(warningLines.length)} line(s): ${JSON.stringify(warningLines)}`)
check('the live loader audit reports zero inactive entries',
  Array.isArray(json.inactiveEntries) && json.inactiveEntries.length === 0,
  `${JSON.stringify(json.inactiveEntries)} (of ${String(json.loaderEntryCount)} loader entries)`)
check('the probe produced no error', json.error === null, JSON.stringify(json.error))
check('a real Session was created', json.sessionCreated === true, `sessionId: ${JSON.stringify(json.sessionId)}`)
check('the Session mounted the deployment default preset', json.agentPreset === 'daily-standard',
  JSON.stringify(json.agentPreset))
check('the roster resolved the deployment-added preset', json.presetDefaultId === 'daily-standard',
  JSON.stringify(json.presetDefaultId))
check('`daily-standard` is listed as an available preset',
  Array.isArray(json.presetsListed) && json.presetsListed.some(p => p.id === 'daily-standard'),
  JSON.stringify(json.presetsListed.map(p => p.id)))

// (2) The catalog is non-empty and agent-keyed. An empty catalog would make
//     every "tool X is absent" assertion below vacuously true -- exactly the
//     failure the count assertion exists to exclude.
const tools = Array.isArray(json.tools) ? json.tools : []
check('the agent-keyed catalog is non-empty', json.toolCountAgentKey > 0,
  `toolCountAgentKey: ${String(json.toolCountAgentKey)}`)
check('toolCountAgentKey equals the length of the reported list',
  json.toolCountAgentKey === tools.length,
  `count ${String(json.toolCountAgentKey)} vs list ${String(tools.length)}`)
// The contrast is kept as evidence (G-FIX-06): the context key owns no scope
// layer, so it collapses to the global layer and holds zero agent tools.
check('the context-keyed view is the empty one (G-FIX-06 contrast)',
  json.toolCountContextKey === 0, `toolCountContextKey: ${String(json.toolCountContextKey)}`)

// (3) The host-plane services the two bundles provide. These are asserted so
//     that "the preset lost a row" and "the bundle never mounted" stay
//     separable.
for (const [label, key] of [
  ['the ipython KERNEL service resolves', 'kernelServicePresent'],
  ['the dailyWork service resolves', 'workServicePresent'],
  ['the dailyData service resolves', 'dataServicePresent'],
  ['the dailyHistory service resolves', 'historyServicePresent'],
  ['the programmaticScope service resolves', 'programmaticScopePresent'],
  ['the dailyWriters service resolves', 'writersServicePresent'],
]) check(label, json[key] === true, `${key}: ${JSON.stringify(json[key])}`)

// (4) THE TARGET OF THIS CHANGE.
if (PHASE === 'after') {
  check('`pwsh` is ABSENT from the model catalog', json.pwshToolPresent === false,
    `pwshToolPresent: ${JSON.stringify(json.pwshToolPresent)}; tools.includes('pwsh'): ${String(tools.includes('pwsh'))}`)
} else {
  // The BEFORE run RECORDS the starting state rather than asserting it: if the
  // baseline is not what the task describes, that is a finding about the
  // baseline, not a failure of the change.
  console.log(`baseline pwshToolPresent: ${JSON.stringify(json.pwshToolPresent)} (recorded, not asserted)`)
  console.log(`baseline toolCountAgentKey: ${String(json.toolCountAgentKey)} (recorded, not asserted)`)
}
check('`ipython` is PRESENT in the model catalog', json.ipythonToolPresent === true,
  `ipythonToolPresent: ${JSON.stringify(json.ipythonToolPresent)}`)
check('`ipython` takes exactly one parameter, `code`', json.ipythonIsOnlyParameter === true,
  `parameterNames: ${JSON.stringify(json.ipythonParameterNames)}`)
check('no kernel lifecycle tool exists',
  Array.isArray(json.forbiddenLifecycleTools) && json.forbiddenLifecycleTools.length === 0,
  JSON.stringify(json.forbiddenLifecycleTools))

// (5) Every row this preset is supposed to KEEP must still own its tools.
//     Asserted row by row rather than as a count, because "27 entries" is not
//     the claim -- "the fs row is still mounted" is.
const rowTools = json.rowTools ?? {}
for (const [row, names] of Object.entries(rowTools)) {
  const missing = names.filter(name => !tools.includes(name))
  check(`row \`${row}\` still registers ${names.join('/')}`, missing.length === 0,
    `missing: ${JSON.stringify(missing)}`)
}

// (6) THE SANDBOX ESCALATION FIELDS, ATTRIBUTED RATHER THAN CLAIMED.
//
// Two different planes advertise `sandbox_permissions` + `justification`, and
// conflating them would let this change take credit for another agent's:
//   - `pwsh` carries them because the mounted `shell` backend confines
//     (packages/shell/tool-pwsh/src/index.ts:196 reads `ctx.shell.sandboxMode`;
//     `pwsh-sandbox` overrides it at packages/shell/pwsh-sandbox/src/index.ts:83).
//     THIS preset's change removes the whole tool, so it removes its fields.
//   - `write`/`edit` carry them because the mounted `fs` backend confines
//     (packages/fs/tool-fs/src/sandbox.ts:45; the base class reports
//     `undefined` at packages/fs/fs/src/index.ts:104 and only a confining
//     backend overrides it). THIS preset's change does NOT touch that gate --
//     it is the fs PROVIDER SWAP, which is a different task.
//
// So the assertion here is only about `pwsh`. The joint "zero tools advertise
// escalation fields" result is recorded as a fact, never asserted as this
// change's outcome.
const escalation = json.escalationFieldsByTool ?? {}
const escalationTools = json.toolsWithEscalationFields ?? []
console.log(`tools advertising escalation fields: ${JSON.stringify(escalationTools)}`)
console.log(`  shell.sandboxMode: ${JSON.stringify(json.shellSandboxMode)}   fs.sandboxMode: ${JSON.stringify(json.fsSandboxMode)}`)
if (PHASE === 'after') {
  check('`pwsh` is gone from the tools advertising escalation fields',
    !escalationTools.includes('pwsh'),
    `toolsWithEscalationFields: ${JSON.stringify(escalationTools)}`)
}

// (7) The exact catalog, asserted against a PINNED list on the AFTER run.
//     Pinning a second copy here is deliberate: if a future edit silently drops
//     a row, a count assertion alone would still pass as long as some other row
//     appeared.
const EXPECTED_AFTER = [
  'ask_user_question', 'create_goal', 'edit', 'exit_plan_mode', 'get_goal', 'glob',
  'grep', 'interrupt_agent', 'ipython', 'job_kill', 'job_list', 'job_output',
  'list_agents', 'present', 'read', 'read_image', 'send_message', 'skill',
  'subagent', 'subagent_fork', 'todo_write', 'update_goal', 'web_fetch',
  'web_search', 'work', 'workflow', 'write',
]
if (PHASE === 'after') {
  const expected = [...EXPECTED_AFTER].sort()
  const same = expected.length === tools.length && expected.every((name, index) => name === tools[index])
  check('the catalog is EXACTLY the pinned 27-name list', same,
    `expected ${String(expected.length)} [${expected.join(', ')}] vs observed ${String(tools.length)} [${tools.join(', ')}]`)
}

const summary = {
  phase: PHASE,
  port: boot.port,
  portReleased: boot.portReleased,
  timedOut: boot.timedOut,
  exitCode: boot.exitCode,
  bootCwd: 'C:/',
  home: HOME,
  presetPath: PRESET,
  presetSha256: presetDigest,
  inputDigests,
  presetRoots: result.roots,
  activationWarningLines: warningLines,
  loaderEntryCount: json.loaderEntryCount,
  inactiveEntries: json.inactiveEntries,
  hostRowsOfInterest: json.hostRowsOfInterest,
  toolCountAgentKey: json.toolCountAgentKey,
  toolCountContextKey: json.toolCountContextKey,
  pwshToolPresent: json.pwshToolPresent,
  ipythonToolPresent: json.ipythonToolPresent,
  ipythonParameterNames: json.ipythonParameterNames,
  escalationFieldsByTool: json.escalationFieldsByTool,
  toolsWithEscalationFields: json.toolsWithEscalationFields,
  shellSandboxMode: json.shellSandboxMode,
  fsSandboxMode: json.fsSandboxMode,
  agentPreset: json.agentPreset,
  tools,
  checks,
  failures,
  verdict: failures.length === 0 ? 'PASS' : 'FAIL',
}
writeFileSync(`${REPO}/qualification/results/T4-preset/verify-${PHASE}.json`,
  `${JSON.stringify(summary, null, 2)}\n`, 'utf8')

console.log(`preset: ${PRESET}`)
console.log(`presetSha256: ${presetDigest}`)
console.log(`input digests:`)
for (const [label, digest] of Object.entries(inputDigests)) console.log(`  ${label}: ${digest}`)
console.log(`\ntoolCountAgentKey: ${String(json.toolCountAgentKey)}`)
console.log(`tools: ${tools.join(', ')}`)
console.log(`presetRoots: ${result.roots.join(' | ')}`)
console.log(`\n${String(checks.length - failures.length)}/${String(checks.length)} checks passed`)
for (const failure of failures) console.log(`  FAIL: ${failure}`)
console.log(`\nVERDICT ${PHASE}: ${summary.verdict}`)

if (failures.length > 0) {
  console.log(`\n--- stderr ---\n${boot.stderr}`)
  process.exit(1)
}

// A leaked listener is a leftover this driver owns, so it is a failure here.
if (boot.portReleased !== true) {
  console.error(`\nFATAL: port ${String(boot.port)} is still bound after the host was killed`)
  process.exit(3)
}
