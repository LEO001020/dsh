/**
 * V2 COMPOSITION driver for boot 4: runs `verify-cmp-composition.mjs` inside a
 * real composed boot and JUDGES its output against the CMP oracles.
 *
 * WHY THE JUDGEMENT IS HERE AND NOT IN THE PROBE. The probe is a pure
 * measurement so that another gate can reuse it without inheriting this task's
 * expectations. A probe that also judged would be a second oracle, which is the
 * defect class this project records as G-FIX-04.
 *
 * EVERY CHECK BELOW NAMES THE CASE IT BELONGS TO AND THE EXACT ORACLE SENTENCE
 * IT TESTS, so a reader can falsify a PASS without asking the author.
 *
 * Usage: node run-boot4-composition.mjs
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { bootAndWait, readResult } from 'file:///D:/DSH/work/dsh-native-daily/qualification/runners/boot-harness.mjs'

const REPO = 'D:/DSH/work/dsh-native-daily'
const HOME = 'D:/DSH/home/v2-cmp'
const PROFILE = 'daily'
const OUT = `${REPO}/qualification/results/V2-composition/boot4-composition.json`
const OVERLAY = `${REPO}/qualification/runners/verify-cmp-composition.patch.yml`
const TRANSCRIPT = `${REPO}/qualification/results/V2-composition/boot4-transcript.txt`

const digest = path => existsSync(path)
  ? createHash('sha256').update(readFileSync(path)).digest('hex')
  : null

const boot = await bootAndWait({
  home: HOME,
  profile: PROFILE,
  patches: [OVERLAY],
  outPath: OUT,
  // Foreign cwd, so a cwd-relative preset root cannot make this boot look healthy.
  cwd: 'D:/DSH/src/dsh-src',
  timeoutMs: 150_000,
})

writeFileSync(TRANSCRIPT, [
  '# V2 boot 4 -- composition probe (CMP-02/03/06/07/08/09/10)',
  `# cwd: D:/DSH/src/dsh-src   DSH_HOME: ${HOME}   port: ${String(boot.port)}   portReleased: ${String(boot.portReleased)}`,
  `# timedOut: ${String(boot.timedOut)}   exitCode: ${String(boot.exitCode)}`,
  '',
  '--- stdout ---',
  boot.stdout,
  '--- stderr ---',
  boot.stderr,
].join('\n'), 'utf8')

let f = null
let fatal = null
try {
  f = readResult(OUT, HOME).json
} catch (error) {
  fatal = error instanceof Error ? error.message : String(error)
}

const checks = []
const check = (caseId, label, ok, detail) => {
  checks.push({ caseId, label, ok: ok === true, detail })
  return ok === true
}

if (fatal !== null) {
  checks.push({ caseId: 'CMP-*', label: 'the probe result names the home this driver booted', ok: false, detail: fatal })
} else {
  check('CMP-01', 'the boot log has no activation warning', !/did not activate|waiting for services|failed to mount/i.test(`${boot.stdout}\n${boot.stderr}`),
    'no matching line')
  check('CMP-*', 'the probe reported no error', f.error === null, String(f.error))

  // ═══ CMP-02 ═══ "A row with `id: sandbox-policy` is present (NOT deleted), its
  // configured mode is `danger-full-access`, and its `workspaceRoot` resolves to
  // an absolute path."
  const s = f.sandbox
  check('CMP-02', 'a row with id sandbox-policy is present in the loader', s.policyRowInLoader === true, String(s.policyRowInLoader))
  check('CMP-02', 'the sandbox-policy row is ACTIVE (fiber state 2)', s.policyRowFiberState === 2, String(s.policyRowFiberState))
  check('CMP-02', 'the composed mode is danger-full-access', s.defaultMode === 'danger-full-access', String(s.defaultMode))
  check('CMP-02', 'workspaceRoot resolves to an ABSOLUTE path', /^[A-Za-z]:[\\/]/.test(String(s.workspaceRoot ?? '')), String(s.workspaceRoot))
  check('CMP-02', 'the sandbox provider row is mounted', s.sandboxServicePresent === true, String(s.sandboxServicePresent))

  // ═══ CMP-03 ═══ "the three values are separately observable, and the deployment
  // default is recorded as EXPLICITLY CONFIGURED rather than a fallback."
  check('CMP-03', 'defaultMode is separately observable', s.defaultMode !== null && s.defaultMode !== undefined, String(s.defaultMode))
  check('CMP-03', 'a session override is separately observable', Array.isArray(s.perSession) && s.perSession.length > 0 && 'override' in s.perSession[0], JSON.stringify(s.perSession))
  check('CMP-03', 'resolve({}) mode is separately observable', s.resolveWithNoSession !== null && s.resolveWithNoSession !== undefined, JSON.stringify(s.resolveWithNoSession))
  check('CMP-03', 'the composed row config carries the mode key explicitly (not a fallback)',
    s.policyRowConfigAsComposed !== null && Object.hasOwn(s.policyRowConfigAsComposed ?? {}, 'mode'),
    JSON.stringify(s.policyRowConfigAsComposed))

  // ═══ CMP-06 ═══ "The effective policy is `never` and is declared explicitly in
  // the profile patch ... A model-originated attempt to change it has no effect."
  const a = f.approval
  check('CMP-06', 'the configured approval policy is never', a.configuredPolicy === 'never', String(a.configuredPolicy))
  check('CMP-06', 'the effective policy for a real session is never', a.effectivePolicyForSession === 'never', String(a.effectivePolicyForSession))
  check('CMP-06', 'no session-level override exists', a.sessionOverride === null, String(a.sessionOverride))
  check('CMP-06', 'no policy-changing tool is in the model catalog', a.modelCatalogHasPolicyTool === false, String(a.modelCatalogHasPolicyTool))
  const anyPolicyToolSucceeded = (a.policyToolGuesses ?? []).some(g => g.result?.isError === false && g.result?.threw === false)
  check('CMP-06', 'every model-originated policy-tool attempt failed', a.policyToolGuesses?.length > 0 && anyPolicyToolSucceeded === false,
    JSON.stringify(a.policyToolGuesses ?? []))
  // THE HOST-CODE ROUTE, AND WHAT IT ACTUALLY PROVES. `approval.setPolicy` is a
  // plain host API and it SUCCEEDS when host code calls it -- measured. So the
  // protection here is UNREACHABILITY from the model, NOT immutability of the
  // value. Both facts are asserted separately, because conflating them would be
  // the over-claim this case's oracle is written to prevent: "not model-writable"
  // is what it says, and that is what is measured.
  check('CMP-06', 'the host-code route to setPolicy EXISTS (the value is not immutable)',
    a.hostApiSetPolicyAttempt === 'no throw', String(a.hostApiSetPolicyAttempt))
  check('CMP-06', 'the host-code route actually changed the policy (proving it is live)',
    a.policyAfterHostApiAttempt === 'ask', String(a.policyAfterHostApiAttempt))
  // The read that decides the case is taken BEFORE the host-code probe ran, so
  // the probe's own mutation cannot contaminate it.
  check('CMP-06', 'the effective policy BEFORE any attempt was never', a.effectivePolicyForSession === 'never', String(a.effectivePolicyForSession))
  check('CMP-06', 'no permission-preset row is mounted (the user-facing route is gone)',
    a.permissionPresetsServicePresent === false && a.permissionRowDisabled === true && a.uiPermissionRowDisabled === true,
    JSON.stringify({ service: a.permissionPresetsServicePresent, row: a.permissionRowDisabled, ui: a.uiPermissionRowDisabled }))

  // ═══ CMP-07 ═══ "The dumped row carries every required key with its intended
  // value, and no unmentioned key has silently reverted to a schema default."
  const subagent = (f.patchedRows ?? []).find(r => r.id === 'subagent')
  check('CMP-07', 'the subagent row is resolved', subagent !== undefined, JSON.stringify((f.patchedRows ?? []).map(r => r.id)))
  check('CMP-07', 'subagent.maxActiveSubagents is 10 (the intended value)', subagent?.config?.maxActiveSubagents === 10, String(subagent?.config?.maxActiveSubagents))
  check('CMP-07', 'subagent.maxDepth is 1 (the sibling key did NOT revert)', subagent?.config?.maxDepth === 1, String(subagent?.config?.maxDepth))
  check('CMP-07', 'the subagent row carries BOTH keys, not one', subagent?.configKeys?.length === 2, JSON.stringify(subagent?.configKeys))
  const presets = (f.patchedRows ?? []).find(r => r.id === 'agent-presets')
  check('CMP-07', 'agent-presets carries all four intended keys', presets?.configKeys?.length === 4, JSON.stringify(presets?.configKeys))
  check('CMP-07', 'agent-presets.includeShippedRoot did not revert', presets?.config?.includeShippedRoot === true, String(presets?.config?.includeShippedRoot))
  check('CMP-07', 'agent-presets.includeUserRoot did not revert', presets?.config?.includeUserRoot === true, String(presets?.config?.includeUserRoot))

  // ═══ CMP-08 ═══ "Each agent's catalog contains exactly its own rows, and no
  // module-scope state crosses sessions."
  const dailyP = (f.presets ?? []).find(p => p?.label === 'daily-standard')
  const shippedP = (f.presets ?? []).find(p => p?.label === 'standard')
  check('CMP-08', 'two presets were mounted in one process', dailyP !== undefined && shippedP !== undefined,
    JSON.stringify((f.presets ?? []).map(p => p?.label)))
  check('CMP-08', 'daily-standard mounts ipython and work', dailyP?.ipythonPresent === true && dailyP?.workPresent === true,
    `ipython=${String(dailyP?.ipythonPresent)} work=${String(dailyP?.workPresent)}`)
  check('CMP-08', 'the shipped standard preset does NOT mount ipython or work',
    shippedP?.ipythonPresent === false && shippedP?.workPresent === false,
    `ipython=${String(shippedP?.ipythonPresent)} work=${String(shippedP?.workPresent)}`)
  check('CMP-08', 'the two catalogs differ (they are not one shared catalog)',
    dailyP?.toolCount !== shippedP?.toolCount, `${String(dailyP?.toolCount)} vs ${String(shippedP?.toolCount)}`)
  // THE MODULE-SCOPE HALF. Two agents on the SAME standing preset each call the
  // real `work` tool; each must resolve its OWN run. A module-scope `currentRun`
  // -- the contamination bug `src/tools.ts`'s own header warns about -- would make
  // both resolve to one run.
  const ptr = f.roots?.perSessionToolResolution
  check('CMP-08', 'each agent resolved its OWN run through the real work tool',
    ptr?.resolvesItsOwnRun === true, JSON.stringify({ A: ptr?.runIdA, B: ptr?.runIdB }))
  check('CMP-08', 'no module-scope state crosses the two sessions (the runs are not the same)',
    ptr?.noCrossResolution === true, JSON.stringify({ A: ptr?.runIdA, B: ptr?.runIdB }))

  // ═══ CMP-09 ═══ "Each run's tasks, credit reservation and cancellation are
  // fully separated; no task id, reservation or tombstone appears in the other
  // run's record."
  const r = f.roots?.interleaved
  check('CMP-09', 'two runs were created on one standing scope', (f.roots?.created ?? []).filter(c => c.ok).length === 2,
    JSON.stringify(f.roots?.created ?? []))
  check('CMP-09', 'the two runs have distinct root sessions', r?.distinctRoots === true, String(r?.distinctRoots))
  check('CMP-09', 'no task id crosses between the runs', r?.noTaskIdCrosses === true, JSON.stringify({ A: r?.A?.taskIds, B: r?.B?.taskIds }))
  check('CMP-09', 'no tombstone crosses between the runs', r?.noTombstoneCrosses === true,
    JSON.stringify({ A: r?.A?.tombstones, B: r?.B?.tombstones }))
  check('CMP-09', 'the reservations are separate (A released its cancelled task, B did not)',
    r?.reservedA === 0 && r?.reservedB === 5, `A=${String(r?.reservedA)} B=${String(r?.reservedB)}`)

  // ═══ CMP-10 ═══ "The host-scoped row is registered exactly once (no duplicate
  // registration error, no second handle) and the agent-scoped tool row comes
  // from the preset."
  const reg = f.registration
  const dupes = Object.entries(reg?.rowIdCounts ?? {}).filter(([, n]) => n > 1)
  check('CMP-10', 'no host row id is registered more than once', dupes.length === 0, JSON.stringify(dupes))
  check('CMP-10', 'the work host row is registered exactly once', reg?.rowIdCounts?.['daily-work-host'] === 1, String(reg?.rowIdCounts?.['daily-work-host']))
  check('CMP-10', 'the ipython kernel host row is registered exactly once', reg?.rowIdCounts?.['ipython-kernel-host'] === 1, String(reg?.rowIdCounts?.['ipython-kernel-host']))
  check('CMP-10', 'no duplicate-registration warning on stderr',
    !/already registered|duplicate|second handle|provide\(\) throws/i.test(boot.stderr), 'no matching line')
  check('CMP-10', 'the agent-scoped tool rows live in the PRESET, not the host plane',
    (reg?.presetCompositions ?? []).some(c => c.id === 'daily-standard'
      && c.rowIds.includes('daily-work-tools') && c.rowIds.includes('ipython-tool')
      && c.rowNamesById?.['daily-work-tools'] === 'dsh-daily-work/tools'
      && c.rowNamesById?.['ipython-tool'] === 'dsh-ipython/tool'),
    JSON.stringify(reg?.presetCompositions ?? []))
  const dailyRows = (reg?.presetCompositions ?? []).find(c => c.id === 'daily-standard')
  check('CMP-10', 'the daily preset carries no HOST row (bundle and preset own different halves)',
    (dailyRows?.rowIds ?? []).every(id => id !== 'daily-work-host' && id !== 'ipython-kernel-host'),
    JSON.stringify(dailyRows?.rowIds ?? []))
  check('CMP-10', 'the work host row is in the HOST plane, registered exactly once',
    reg?.rowIdCounts?.['daily-work-host'] === 1, String(reg?.rowIdCounts?.['daily-work-host']))

  check('CMP-*', 'the port was released after the kill', boot.portReleased === true, String(boot.portReleased))
}

const verdict = {
  probe: 'V2-composition boot4',
  ranAt: new Date().toISOString(),
  cwd: 'D:/DSH/src/dsh-src',
  dshHome: HOME,
  port: boot.port,
  portReleased: boot.portReleased,
  timedOut: boot.timedOut,
  exitCode: boot.exitCode,
  inputDigests: {
    installedProfilePatch: digest(`${HOME}/profiles/daily/cordis.patch.yml`),
    repoProfilePatch: digest(`${REPO}/profiles/daily-candidate/cordis.patch.yml`),
    installedPreset: digest(`${HOME}/profiles/daily/presets/daily-standard/agent.cordis.yml`),
    repoPreset: digest(`${REPO}/profiles/daily-candidate/presets/daily-standard/agent.cordis.yml`),
    workBundlePatch: digest(`${REPO}/packages/dsh-daily-work/cordis.patch.yml`),
    ipythonBundlePatch: digest(`${REPO}/packages/dsh-ipython/cordis.patch.yml`),
    workLibHost: digest(`${REPO}/packages/dsh-daily-work/lib/host.js`),
    ipythonLibTool: digest(`${REPO}/packages/dsh-ipython/lib/ipython-tool.js`),
    overlay: digest(OVERLAY),
  },
  fatal,
  measurement: f,
  checks,
  failures: checks.filter(c => !c.ok).map(c => `[${c.caseId}] ${c.label} -- observed: ${c.detail}`),
  ok: checks.every(c => c.ok),
}
writeFileSync(`${REPO}/qualification/results/V2-composition/boot4-verdict.json`, `${JSON.stringify(verdict, null, 2)}\n`, 'utf8')

console.log(`port=${String(boot.port)} released=${String(boot.portReleased)} timedOut=${String(boot.timedOut)}`)
console.log(`checks=${String(checks.filter(c => c.ok).length)}/${String(checks.length)}`)
for (const fail of verdict.failures) console.log(`FAIL: ${fail}`)
