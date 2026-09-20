/**
 * M4 durability runner: kill a real process mid-run and reconcile what survived.
 *
 * This is a T3 test. It does not simulate a crash: it forks a real Node process,
 * lets that process admit work into a real storage domain, kills it with
 * SIGKILL, and then opens the SAME domain directory from a fresh process to see
 * what actually persisted.
 *
 * Why it must be a real process kill rather than an in-process simulation: the
 * question is whether the storage backend's write path survives an abrupt
 * termination. An in-process "abort" still lets the event loop flush; SIGKILL
 * does not. The delivery plan is explicit that a unit-level simulation is not
 * evidence for this gate.
 *
 * Usage (from the package directory):
 *   node --import tsx src/durability-runner.ts child  <storeDir> <reportPath>
 *   node --import tsx src/durability-runner.ts parent <storeDir> <reportPath>
 */
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import * as storageDomainPlugin from '@deepseek-ai/dsh-storage-domain'
import * as storageJsonPlugin from '@deepseek-ai/dsh-storage-json'
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { WorkService } from './host.ts'
import { recoveryPhase, reconcileRun, type ChildEvidence } from './reconcile.ts'

const RUN_ID = 'run-durability'
const TASK_COUNT = 4

/** Mount the real storage domain over `root` and return an open work service. */
async function openService(root: string): Promise<{ ctx: Context; service: WorkService }> {
  const ctx = new Context()
  // NO CONFIG-POSITION `as never`. ID-05's clause (b) names this exact line as the
  // idiom that MASKS a true diagnostic: with the cast, `ctx.plugin(Storage, {} as
  // never)` compiles while the argument is rejected by the signature
  // (`Argument of type '{}' is not assignable to parameter of type 'undefined'`).
  // `Storage` is a service class with NO `Config` schema, so `Spread<never>` makes
  // the config parameter absent -- the correct call OMITS it. Measured: with the
  // cast removed and the argument omitted, this compiles clean.
  await ctx.plugin(Storage)
  // The cast on the PLUGIN argument is ID-05's clause (a): noise, because
  // `GetPluginParameters` already infers `(ctx, config: Config)` from `apply`, so
  // `ctx.plugin(storageJsonPlugin, { root })` type-checks the config against the
  // plugin's OWN `Config` interface. Keeping the cast here would suppress that
  // check -- the cast on the plugin is what made the config argument untypeable in
  // the first place (`GetPluginConfig<never>` is `never`).
  await ctx.plugin(storageJsonPlugin, { root })
  await ctx.plugin(storageDomainPlugin, { backend: 'json' })
  const service = new WorkService(ctx, {
    targetChildren: 10,
    maxDepth: 1,
    // This rig mounts no subagent runtime, so the production port cannot bind and
    // the drain path reports `no launch port installed`. That is correct here:
    // the rig exercises record durability across a hard kill, not launching.
    subagentProvider: 'spawn',
    budgetCeiling: 1000,
    currency: 'USD',
    priceVersion: 'durability-v1',
  })
  await service.open()
  return { ctx, service }
}

/**
 * The child: admit work, then hang forever so the parent can kill it.
 *
 * `process.kill(pid, 'SIGKILL')` cannot be caught, so nothing here gets a chance
 * to flush. Whatever is on disk when the kill lands is what the test observes.
 */
async function runChild(storeDir: string, reportPath: string): Promise<void> {
  const { service } = await openService(storeDir)
  await service.createRun({
    runId: RUN_ID,
    // KNOWN MASK, DELIBERATELY NOT FIXED HERE -- see the S10 ID-05 findings.
    //
    // `createRun` takes a real `Agent`, and `Agent.session` is the `Session` CLASS,
    // not a structural literal: it has 24 required members (`log`,
    // `surfaceManager`, `surface`, `inheritedEventCount`, ...). The literal below
    // is a fabricated header, so removing this cast is NOT a one-line fix -- it
    // reports, measured:
    //     TS2740: Type '{ id: SessionId; header: {...} }' is missing the
    //             following properties from type 'Session': log, surfaceManager,
    //             surface, inheritedEventCount, and 19 more.
    // The honest fix is to mount the real AgentLoop in this rig and use
    // `ctx.agentLoop.create(SessionId('root-session'), ...)` as the sibling rigs do
    // (`concurrency.test.ts:151`). That is a topology change to a crash rig whose
    // child is SIGKILLed mid-run, and it is outside ID-05's type-level scope. The
    // cast is therefore LEFT IN PLACE and reported rather than silently widened.
    root: { session: { header: { id: 'root-session' } } } as never,
    authorizationRef: 'auth-durability',
    targetChildren: 10,
  })

  // Admit several tasks and move them into different states, so recovery has
  // something interesting to reconcile rather than a uniform block.
  const states = ['launching', 'accepted', 'executing', 'executing'] as const
  for (let i = 0; i < TASK_COUNT; i += 1) {
    await service.admit({
      runId: RUN_ID,
      taskId: `task-${i}`,
      childId: `child-${i}`,
      assignmentDigest: `digest-${i}`,
      reservedCost: 5,
      allowedCapabilities: ['reader'],
    })
    const target = states[i]!
    if (target === 'launching') {
      await service.transition({ runId: RUN_ID, taskId: `task-${i}`, to: 'launching' })
    } else if (target === 'accepted') {
      await service.transition({ runId: RUN_ID, taskId: `task-${i}`, to: 'launching' })
      await service.transition({ runId: RUN_ID, taskId: `task-${i}`, to: 'accepted' })
    } else {
      await service.transition({ runId: RUN_ID, taskId: `task-${i}`, to: 'launching' })
      await service.transition({ runId: RUN_ID, taskId: `task-${i}`, to: 'accepted' })
      await service.transition({ runId: RUN_ID, taskId: `task-${i}`, to: 'executing' })
    }
  }

  // Tell the parent we are ready to be killed, then hang. The report is written
  // BEFORE the kill so the parent knows what the child believed at kill time.
  const before = service.getRun(RUN_ID)
  writeFileSync(
    reportPath,
    JSON.stringify({ phase: 'ready', childBelief: before }, null, 2),
    'utf8',
  )
  // Stay alive until killed.
  //
  // `await new Promise(() => {})` is NOT enough: an unsettled top-level await
  // does not keep Node's event loop alive, so the process exits with code 13
  // ("unsettled top-level await") and the test would be observing a NORMAL exit
  // while claiming to have killed the process. A live timer handle is what
  // actually holds it open.
  //
  // The interval is deliberately long so the child is idle when the signal
  // lands: we want to test the storage write path's durability, not the
  // interruptibility of a busy loop.
  setInterval(() => {}, 3_600_000)
  await new Promise<never>(() => {})
}

/**
 * The parent: run the child, kill it hard, then reconcile from a new process.
 */
async function runParent(storeDir: string, reportPath: string): Promise<number> {
  const selfPath = fileURLToPath(import.meta.url)
  const tsxLoader = 'tsx/esm'
  const child = spawn(
    process.execPath,
    ['--import', tsxLoader, selfPath, 'child', storeDir, reportPath],
    { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env } },
  )
  let childStderr = ''
  child.stderr.on('data', (chunk: Buffer) => {
    childStderr += chunk.toString()
  })

  // Wait for the child to report that it is ready, with a bounded wait.
  const deadline = Date.now() + 60_000
  while (!existsSync(reportPath) && Date.now() < deadline) {
    if (child.exitCode !== null) {
      process.stderr.write(`durability: child exited early (${child.exitCode})\n${childStderr}\n`)
      return 2
    }
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  if (!existsSync(reportPath)) {
    process.stderr.write('durability: child never reported ready\n')
    child.kill('SIGKILL')
    return 2
  }

  const before = JSON.parse(readFileSync(reportPath, 'utf8')) as {
    childBelief: { tasks: Record<string, { state: string }>; budget: { reserved: number } }
  }

  // THE KILL. SIGKILL cannot be caught, so no flush runs.
  //
  // `child.kill()` returns false when the signal could not be delivered, and on
  // Windows a signal to an already-exiting process can report false while the
  // process still dies. Either way the honest record is the exit code and
  // signal we OBSERVE, not the return value we asked for. Recording only the
  // return value would let a no-op kill look like a successful one.
  const signalRequested = child.kill('SIGKILL')
  const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => {
    if (child.exitCode !== null || child.signalCode !== null) {
      return resolve({ code: child.exitCode, signal: child.signalCode })
    }
    child.once('exit', (code, signal) => resolve({ code, signal }))
  })

  // Reopen the SAME directory in THIS process and see what survived.
  const { service } = await openService(storeDir)
  const after = service.getRun(RUN_ID)

  const report: Record<string, unknown> = {
    phase: 'reconciled',
    killSignalRequested: 'SIGKILL',
    killRequestAccepted: signalRequested,
    childExitCode: exit.code,
    childExitSignal: exit.signal,
    // The honest statement of "the process died without running any cleanup":
    // it exited with a signal rather than a normal code. On Windows Node reports
    // the signal name for a killed child; a null code with a signal is exactly
    // the abrupt-termination shape.
    terminatedAbruptly: exit.signal !== null,
    childBeliefStates: Object.fromEntries(
      Object.entries(before.childBelief.tasks).map(([k, v]) => [k, v.state]),
    ),
    childBeliefReserved: before.childBelief.budget.reserved,
    recordSurvived: after !== undefined,
  }

  if (after === undefined) {
    report['verdict'] = 'FAIL: the run record did not survive the kill'
    writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf8')
    return 1
  }

  const afterStates = Object.fromEntries(Object.entries(after.tasks).map(([k, v]) => [k, v.state]))
  report['afterStates'] = afterStates
  report['afterReserved'] = after.budget.reserved

  // Reconcile each task from evidence. In this runner there is no live child, so
  // the honest evidence is "no Session, no live Agent" for every task, which the
  // reconciler must turn into `unknown` - NOT into a relaunch.
  const evidenceMap = new Map<string, ChildEvidence>()
  for (const task of Object.values(after.tasks)) {
    evidenceMap.set(task.taskId, {
      taskId: task.taskId,
      childId: task.childId ?? '',
      sessionExists: false,
      agentLive: false,
      requestObserved: false,
      turnOutcome: undefined,
      resultRef: undefined,
      launchProvenNotCreated: false,
    })
  }
  const decisions = reconcileRun(after.tasks, evidenceMap)
  report['decisions'] = decisions

  // The restart-authorization rule: this run was created WITHOUT restart
  // permission, so recovery must come back paused.
  report['recovery'] = recoveryPhase(after.restartResumeAuthorized, undefined, new Date().toISOString())

  const allUnknownOrAccepted = decisions.every(d => d.next === 'unknown' || d.next === 'accepted')
  const diedAbruptly = exit.signal !== null
  const noSlotReleased = decisions.every(d => !d.releaseSlot)
  const everyTaskPersisted = Object.keys(before.childBelief.tasks).length === Object.keys(after.tasks).length
  const reservationIntact = after.budget.reserved === before.childBelief.budget.reserved

  report['checks'] = {
    childTerminatedAbruptly: diedAbruptly,
    everyAdmittedTaskPersisted: everyTaskPersisted,
    reservationSurvivedExactly: reservationIntact,
    reconciliationNeverReplayed: allUnknownOrAccepted,
    reconciliationNeverReleasedASlot: noSlotReleased,
    recoveryCameBackPaused: report['recovery'] !== undefined
      && (report['recovery'] as { phase: string }).phase === 'paused',
  }

  const pass = Object.values(report['checks'] as Record<string, boolean>).every(Boolean)
  report['verdict'] = pass ? 'PASS' : 'FAIL'
  writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf8')

  await service.close()
  return pass ? 0 : 1
}

const [mode, storeDir, reportPath] = process.argv.slice(2)
if (mode === 'child' && storeDir !== undefined && reportPath !== undefined) {
  await runChild(storeDir, reportPath)
} else if (mode === 'parent') {
  const dir = storeDir ?? mkdtempSync(join(tmpdir(), 'dsh-durability-store-'))
  const out = reportPath ?? join(tmpdir(), `dsh-durability-report-${Date.now()}.json`)
  const code = await runParent(dir, out)
  process.stderr.write(`durability report: ${out}\n`)
  // The temp store is left in place on failure so it can be inspected.
  if (code === 0) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  process.exit(code)
} else {
  process.stderr.write('usage: durability-runner.ts <child|parent> [storeDir] [reportPath]\n')
  process.exit(2)
}
