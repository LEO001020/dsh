/**
 * R4 driver: boot the REAL daily profile and assert whether a HUMAN command
 * creates a durable run and whether the model's own `work` tool can then
 * resolve it.
 *
 * WHY THE DRIVER IS SEPARATE FROM THE PROBE. The probe is a pure measurement
 * with no opinion, so another gate can reuse it. The judgement lives here, so
 * the probe does not inherit this task's expectations.
 *
 * WHY IT ASSERTS RATHER THAN PRINTS. A runner that only prints makes the reader
 * the oracle, and the reader here is a language model reading its own output.
 * Every claim below is a boolean computed from the artifact, and the exit code
 * follows from it.
 *
 * WHY A REAL BOOT. `--dump-config` does NOT execute plugins: it prints the
 * composed row list and never runs the probe's `apply`. Every question here is
 * about ACTIVATION and about what the REAL seams do when called, so only a real
 * `--profile` boot answers it.
 *
 * WHAT IT REFUSES TO DO. It does not call `WorkService.createRun` or
 * `WorkService.authorizeRun`. Either would install the very entry point whose
 * existence is under test, which is the weaker-oracle failure this whole task is
 * about. The run it measures is created by a `/work start N` line driven through
 * `ctx.commands.execute` — the same entry point the browser's
 * `ctx.remote.commands.execute(...)` reaches.
 *
 * Usage: node run-r4-authorization.mjs [--expect-after]
 *   default        = BEFORE mode: F1 must still reproduce (no command, no run)
 *   --expect-after = AFTER mode: F1 must be CLOSED (command creates the run and
 *                    the real `work` tool resolves it)
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { bootAndWait, readResult } from 'file:///D:/DSH/work/wt-r4/qualification/runners/boot-harness.mjs'

const REPO = 'D:/DSH/work/wt-r4'
const HOME = 'D:/DSH/home/r4'
const PROFILE = 'daily'
const MODE = process.argv.includes('--expect-after') ? 'after' : 'before'
const OUT = `${REPO}/qualification/results/R4-authorization/boot-${MODE}.json`
const REPORT = `${REPO}/qualification/results/R4-authorization/report-${MODE}.json`
const OVERLAY = `${REPO}/qualification/runners/verify-r4-authorization.patch.yml`

mkdirSync(`${REPO}/qualification/results/R4-authorization`, { recursive: true })

const failures = []
const checks = []

/**
 * Record one assertion. `ok` is compared with `=== true` rather than coerced,
 * so a `null` measurement can never read as a pass.
 */
function check(label, ok, detail) {
  checks.push({ label, ok: ok === true, detail })
  if (ok !== true) failures.push(`${label} -- observed: ${detail}`)
}

/** Parse a Connection RPC server-response body, or undefined when it is not one. */
function parseRpc(body) {
  if (typeof body !== 'string') return undefined
  try {
    const parsed = JSON.parse(body)
    return parsed?.type === 'server-response' ? parsed : undefined
  } catch {
    return undefined
  }
}

const boot = await bootAndWait({
  home: HOME,
  profile: PROFILE,
  patches: [OVERLAY],
  outPath: OUT,
  // A FOREIGN cwd, so a cwd-relative resolution regression is caught.
  cwd: 'C:/',
})

console.log(`mode: ${MODE}  port: ${String(boot.port)}  portReleased: ${String(boot.portReleased)}  `
  + `timedOut: ${String(boot.timedOut)}  exitCode: ${String(boot.exitCode)}`)

let json
try {
  const result = readResult(OUT, HOME)
  json = result.json
} catch (error) {
  console.error(`\nFATAL: could not read a result describing this boot: `
    + `${error instanceof Error ? error.message : String(error)}`)
  console.error(`\n--- stderr (tail) ---\n${boot.stderr.split('\n').slice(-40).join('\n')}`)
  console.error(`\n--- stdout (tail) ---\n${boot.stdout.split('\n').slice(-40).join('\n')}`)
  process.exit(2)
}

console.log('\n=== MEASURED ===')
console.log(JSON.stringify(json, null, 2))

// ---- The boot itself -------------------------------------------------------
check('the probe produced no error', json.error === null,
  `${JSON.stringify(json.error)} phase=${JSON.stringify(json.errorPhase)}`)
check('the daily-work service is mounted', json.workServicePresent === true,
  String(json.workServicePresent))
check('a real Session was created on the deployment preset', json.sessionId !== null,
  JSON.stringify(json.sessionId))
check('the Session mounted the daily-standard preset', json.agentPreset === 'daily-standard',
  JSON.stringify(json.agentPreset))

// ---- NEGATIVE ARM 1: Session creation alone creates no run -----------------
// The count is PER SESSION, and the reason is a measured property of the store
// rather than a convenience: the run domain is DURABLE and keyed to a DSH_HOME,
// so a second boot over the same home still holds the runs a previous boot
// created for sessions that no longer exist. A host-wide count would therefore
// report a correct boot as "Session creation created a run". The host-wide
// number is recorded alongside for context and is not the oracle.
check('SESSION CREATION ALONE CREATES NO RUN',
  json.runCountAfterSessionCreate === 0,
  `runsForThisSession=${JSON.stringify(json.runCountAfterSessionCreate)} `
  + `hostWideRuns=${JSON.stringify(json.hostRunCountAfterSessionCreate)}`)

// ---- NEGATIVE ARM 2: the model cannot create a run -------------------------
check('the `work` tool does not advertise a create action',
  Array.isArray(json.workToolActions) && !json.workToolActions.includes('create'),
  JSON.stringify(json.workToolActions))
check('a raw model call naming a create action does NOT create a run',
  json.runCountAfterModelCreateAttempt === json.runCountBeforeModelCreateAttempt,
  `beforeModelCreate=${JSON.stringify(json.runCountBeforeModelCreateAttempt)} `
  + `afterModelCreate=${JSON.stringify(json.runCountAfterModelCreateAttempt)} `
  + `error=${JSON.stringify(json.modelCreateErrorText)}`)

// ---- NEGATIVE ARM 3: settings are not an action ---------------------------
check('a real settings write does not create a run',
  json.runCountAfterSettingsReload === json.runCountBeforeSettingsReload,
  `beforeSettings=${JSON.stringify(json.runCountBeforeSettingsReload)} `
  + `afterSettings=${JSON.stringify(json.runCountAfterSettingsReload)} `
  + `settingsError=${JSON.stringify(json.settingsReloadError)}`)

if (MODE === 'before') {
  // ---- BEFORE: F1 must reproduce -----------------------------------------
  check('G-SEAM-31 BEFORE: the `/work` command is NOT registered on the composed profile',
    json.workCommandRegistered === false, String(json.workCommandRegistered))
  check('G-SEAM-31 BEFORE: no run exists after every attempted user action',
    json.runCountAfterStart === 0, JSON.stringify(json.runCountAfterStart))
  check('G-SEAM-31 BEFORE: the model-facing `work` tool cannot resolve a run',
    json.workToolIsError === true && /no active run/i.test(json.workToolErrorText ?? ''),
    `isError=${JSON.stringify(json.workToolIsError)} error=${JSON.stringify(json.workToolErrorText)}`)
} else {
  // ---- AFTER: F1 must be closed ------------------------------------------
  check('the `/work` command IS registered in the agent-scoped view',
    json.workCommandRegistered === true,
    `names=${JSON.stringify(json.workCommandNames)}`)
  check('`/work start 10` through CommandRuntime SUCCEEDS',
    json.startResultKind === 'success',
    `kind=${JSON.stringify(json.startResultKind)} text=${JSON.stringify(json.startResultText)} `
    + `error=${JSON.stringify(json.startError)}`)
  check('A DURABLE RUN EXISTS after `/work start 10`',
    json.runCountAfterStart === 1 && json.runAfterStart !== null,
    `runsForThisSession=${JSON.stringify(json.runCountAfterStart)} `
    + `hostWideRuns=${JSON.stringify(json.hostRunCountAfterStart)} run=${JSON.stringify(json.runAfterStart)}`)
  check('the run records the ROOT SESSION that authorized it',
    json.runAfterStart?.rootSessionId === json.sessionId,
    `${JSON.stringify(json.runAfterStart?.rootSessionId)} vs ${JSON.stringify(json.sessionId)}`)
  check('the run records target N=10 from the command',
    json.runAfterStart?.requestedTarget === 10, JSON.stringify(json.runAfterStart?.requestedTarget))
  check('the run records an authorization ref naming the human command',
    typeof json.runAfterStart?.authorizationRef === 'string'
    && /human-command/.test(json.runAfterStart.authorizationRef)
    && json.runAfterStart.authorizationRef.includes(json.startCommandId ?? '\u0000'),
    JSON.stringify(json.runAfterStart?.authorizationRef))

  // ---- DUPLICATE START is deterministic ---------------------------------
  check('DUPLICATE `/work start 10` is deterministic and creates NO second run',
    json.runCountAfterDuplicateStart === 1 && json.duplicateRunId === json.runAfterStart?.runId,
    `runCount=${JSON.stringify(json.runCountAfterDuplicateStart)} `
    + `runId=${JSON.stringify(json.duplicateRunId)} text=${JSON.stringify(json.duplicateStartText)}`)

  // ---- CONCURRENCY: two simultaneous authorizations for ONE session -----
  // The check-then-act race the root agent found. Before the fix both calls
  // reported `Run authorized` and the second write replaced the first record.
  check('TWO CONCURRENT authorizations leave exactly ONE run',
    json.runCountAfterConcurrentStart === 1,
    `runs=${JSON.stringify(json.runCountAfterConcurrentStart)} `
    + `texts=${JSON.stringify(json.concurrentStartTexts)}`)
  check('exactly ONE concurrent call reports that it created the run',
    json.concurrentClaimedCreated === 1,
    `claimedCreated=${JSON.stringify(json.concurrentClaimedCreated)} `
    + `texts=${JSON.stringify(json.concurrentStartTexts)}`)

  // ---- THE UI ROUTE reaches the SAME handler ----------------------------
  check('the typert Remote gateway is mounted (the UI route exists)',
    json.uiRouteAvailable === true, String(json.uiRouteAvailable))
  check('the UI route `commands/execute` resolves `/work status` on a live agent',
    json.uiStatusInvokeError === null && json.uiStatusUnresolved === false
    && json.uiStatusInvoke?.result?.kind === 'success',
    `error=${JSON.stringify(json.uiStatusInvokeError)} `
    + `unresolved=${JSON.stringify(json.uiStatusUnresolved)} `
    + `value=${JSON.stringify(json.uiStatusInvoke)}`)
  check('a read through the UI route creates no run',
    json.runCountAfterUiStatus === 1, JSON.stringify(json.runCountAfterUiStatus))
  check('the UI route is IDEMPOTENT too: `/work start 5` on an active run creates no second run',
    json.runCountAfterUiStart === 1
    && json.uiStartInvoke?.result?.kind === 'success'
    && /already active/i.test(json.uiStartInvoke?.result?.text ?? ''),
    `runCount=${JSON.stringify(json.runCountAfterUiStart)} value=${JSON.stringify(json.uiStartInvoke)} `
    + `error=${JSON.stringify(json.uiStartInvokeError)}`)

  // ---- THE FULL-TRANSPORT ARM: real HTTP, as the browser does -----------
  check('the real HTTP transport is available (connection + webServer port)',
    json.httpArmAvailable === true && json.httpArmOrigin !== null,
    `available=${JSON.stringify(json.httpArmAvailable)} origin=${JSON.stringify(json.httpArmOrigin)} `
    + `error=${JSON.stringify(json.httpArmError)}`)
  check('POST /api/commands/execute resolves `/work status` over real HTTP',
    json.httpStatusStatus === 200
    && parseRpc(json.httpStatusBody)?.result?.ok === true
    && parseRpc(json.httpStatusBody)?.result?.value?.result?.kind === 'success',
    `status=${JSON.stringify(json.httpStatusStatus)} body=${String(json.httpStatusBody).slice(0, 400)}`)
  check('a read over real HTTP creates no run',
    json.runCountAfterHttpStatus === 1, JSON.stringify(json.runCountAfterHttpStatus))
  check('the REAL UI ACTION over HTTP is idempotent: no second run',
    json.httpStartStatus === 200
    && parseRpc(json.httpStartBody)?.result?.ok === true
    && /already active/i.test(parseRpc(json.httpStartBody)?.result?.value?.result?.text ?? '')
    && json.runCountAfterHttpStart === 1,
    `status=${JSON.stringify(json.httpStartStatus)} runs=${JSON.stringify(json.runCountAfterHttpStart)} `
    + `body=${String(json.httpStartBody).slice(0, 400)}`)

  // ---- TARGET UPDATE is durable -----------------------------------------
  check('`/work target 7` updates the durable record',
    json.targetUpdateKind === 'success' && json.targetAfterUpdate === 7,
    `kind=${JSON.stringify(json.targetUpdateKind)} target=${JSON.stringify(json.targetAfterUpdate)}`)

  // ---- THE CLAUSE THAT PROVES F1 IS CLOSED ------------------------------
  check('the real `work` tool is present in the agent-keyed catalog',
    json.workToolPresent === true, `toolCount=${JSON.stringify(json.toolCountAgentKey)}`)
  check('THE REAL `work` TOOL NOW RESOLVES THE RUN (F1 CLOSED)',
    json.workToolIsError === false && json.workToolRunIdMatches === true,
    `isError=${JSON.stringify(json.workToolIsError)} value=${JSON.stringify(json.workToolValue)} `
    + `error=${JSON.stringify(json.workToolErrorText)}`)
  check('the tool reports the LIVE target the human set',
    json.workToolValue?.desiredTarget === 7, JSON.stringify(json.workToolValue?.desiredTarget))

  // ---- STOP does not prematurely free capacity --------------------------
  check('`/work stop` succeeds and moves the run out of `open`',
    json.stopKind === 'success' && json.phaseAfterStop !== null && json.phaseAfterStop !== 'open',
    `kind=${JSON.stringify(json.stopKind)} phase=${JSON.stringify(json.phaseAfterStop)}`)
  check('STOP does not free child capacity (the ledger limit is untouched)',
    json.gateAfterStop?.capacity === 30,
    JSON.stringify(json.gateAfterStop))

  // ---- Durable human-command lifecycle ----------------------------------
  const runEvents = json.commandRunEvents ?? []
  const doneEvents = json.commandDoneEvents ?? []
  check('the human command lifecycle is on the session log with source.kind=user',
    runEvents.length >= 4 && runEvents.every(e => e.sourceKind === 'user'),
    `runEvents=${JSON.stringify(runEvents)}`)
  check('every command/run has a paired command/done',
    runEvents.length === doneEvents.length
    && runEvents.every(run => doneEvents.some(done => done.commandId === run.commandId)),
    `runs=${runEvents.length} dones=${doneEvents.length}`)
}

const report = {
  probe: 'R4-authorization',
  mode: MODE,
  measuredUnder: {
    worktree: REPO,
    dshHome: HOME,
    profile: PROFILE,
    port: boot.port,
    portReleased: boot.portReleased,
    launcher: 'D:/DSH/src/dsh-src/apps/cli/lib/bin.js',
    presetRoots: json.presetRoots,
  },
  passed: checks.filter(c => c.ok).length,
  failed: failures.length,
  checks,
  failures,
  verdict: failures.length === 0 ? 'PASS' : 'FAIL',
}
writeFileSync(REPORT, JSON.stringify(report, null, 2))

console.log(`\n=== ${MODE.toUpperCase()} VERDICT: ${report.verdict} `
  + `(${String(report.passed)}/${String(checks.length)}) ===`)
if (failures.length > 0) {
  console.log('\nFAILURES:')
  for (const failure of failures) console.log(`  - ${failure}`)
}
process.exit(failures.length === 0 ? 0 : 1)
