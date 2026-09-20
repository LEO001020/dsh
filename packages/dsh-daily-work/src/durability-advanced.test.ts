/**
 * M9.4 durability-advanced: gates D02, D12 and D14.
 *
 * These three gates share one property that makes them hard to close honestly:
 * each is a claim about something OUTSIDE this process. A second host is a
 * second process; a migrated schema is a file another version wrote; a residual
 * OS process is a real process the kernel is still scheduling. A unit test that
 * fakes any of those three proves only that the fake behaves like the fake.
 *
 * So this file forks real Node processes, writes real files into a real storage
 * root, and probes real pids with `process.kill(pid, 0)`. Where a claim could
 * not be established, the test says so rather than asserting it.
 *
 * The three gates:
 *
 *   D02 (multi-host conflict) — spawn a SECOND real host over the same live
 *       store directory and observe what happens to the data. The measured
 *       answer is that nothing stops it and the loser's committed writes are
 *       silently destroyed. The test asserts that measurement, then asserts
 *       that the deployment-boundary guard added to `host.ts` refuses the
 *       second host while the first is live.
 *
 *   D12 (schema migration) — a record stamped with a version this build does
 *       not accept must make the open FAIL, not be read as if it were current.
 *       The rule is "refuses to start rather than silently reading a backup",
 *       so the test also asserts the file is byte-identical afterwards: a
 *       rejected open must not have rewritten, migrated or truncated anything.
 *
 *   D14 (residual OS processes) — a hard kill of the host does not necessarily
 *       kill the OS processes it started. The test measures whether a detached
 *       grandchild survives, and then asserts the thing the gate is really
 *       about: recovery treats "no Session, no live Agent" as UNKNOWN with the
 *       slot still held, so a surviving process can never be mistaken for a
 *       clean finish.
 */
import { Context } from '@deepseek-ai/cordis'
import FileSystem, { LocalFileSystem } from '@deepseek-ai/dsh-fs-local'
import Storage from '@deepseek-ai/dsh-storage'
import * as storageDomainPlugin from '@deepseek-ai/dsh-storage-domain'
import * as storageJsonPlugin from '@deepseek-ai/dsh-storage-json'
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { EFFECT_RECORD_STATUSES, EffectLedger, identify, sendDecision, type EffectIntent } from './effects.ts'
import { WorkService } from './host.ts'
import { reconcileTask } from './reconcile.ts'
import { relaunchPrepared } from './recovery.ts'
import { holdsSlot, TERMINAL_STATES } from './states.ts'

/** This file's directory, resolved from the module URL rather than from cwd. */
const HERE = dirname(fileURLToPath(import.meta.url))

/**
 * The cwd every spawned child is given, derived from THIS FILE rather than from
 * `process.cwd()`.
 *
 * WHY NOT `process.cwd()`. The children below are started with
 * `--import tsx/esm` and import `@deepseek-ai/*` by bare specifier, so they
 * resolve both through the package's `node_modules` junction farm. Node resolves
 * a bare specifier from the importing module's location, and `tsx` is loaded as
 * an ESM loader BEFORE any module exists, so its resolution falls back to the
 * process cwd. Invoked the documented way (`cd packages/dsh-daily-work && vitest
 * run ...`) `process.cwd()` happens to BE this package, so it worked by
 * coincidence; invoked from the repository root it is the repo root, which has
 * an EMPTY `node_modules`, and every child dies with
 * `ERR_MODULE_NOT_FOUND: Cannot find package 'tsx'`. Measured: four arms of this
 * file failed on exactly that, and the sibling `dep-gates.test.ts` failed the
 * same way while reporting only a bare 60090 ms timeout, because its child's
 * stderr is not captured.
 *
 * Anchoring to `HERE` makes the child's resolution independent of the
 * directory the suite was launched from, which is the property the assertions
 * below actually depend on. `HERE` is `.../src`, whose parent holds the
 * junction farm.
 */
const CHILD_CWD = resolve(HERE, '..')

/** The `single`-layout unit file the JSON backend publishes for our domain. */
const STORE_FILE = 'dsh_daily_work.json'
const HOST_MODULE_URL = new URL('./host.ts', import.meta.url).href
const TSX_LOADER = 'tsx/esm'
const CHILD_TIMEOUT_MS = 90_000

/**
 * The child program, run as a real second (or third) process.
 *
 * Deliberately spawned through `--eval` rather than a checked-in file: this
 * package's tsconfig excludes `*.test.ts` from the build, so a helper `.ts`
 * beside it would be a compiled artifact in `lib/` for no reason. `--eval` also
 * keeps the child's whole behaviour visible at the point of the assertion.
 *
 * argv layout after the `--` separator, stated here once because it is
 * positional and a mis-order would silently misconfigure the child:
 *   [storeDir, reportPath, role, lockArg, goFlagPath, gcScriptPath, gcPidPath]
 * `lockArg === '-'` means "no deployment-boundary guard configured", which is
 * how the unguarded D02 measurement is produced.
 */
const CHILD_SOURCE = `
const [storeDir, reportPath, role, lockArg, goFlagPath, gcScriptPath, gcPidPath] = process.argv.slice(1)
const { writeFileSync, existsSync, readFileSync } = await import('node:fs')
const { spawn } = await import('node:child_process')
const { Context } = await import('@deepseek-ai/cordis')
const Storage = (await import('@deepseek-ai/dsh-storage')).default
const storageJson = await import('@deepseek-ai/dsh-storage-json')
const storageDomain = await import('@deepseek-ai/dsh-storage-domain')
const { WorkService } = await import(${JSON.stringify(HOST_MODULE_URL)})

const report = value => writeFileSync(reportPath, JSON.stringify(value, null, 2), 'utf8')
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
const lockPath = lockArg === '-' ? undefined : lockArg
const ROOT = { session: { header: { id: 'session-child' } } }

async function boot() {
  const ctx = new Context()
  await ctx.plugin(Storage)
  await ctx.plugin(storageJson, { root: storeDir })
  await ctx.plugin(storageDomain, { backend: 'json' })
  const service = new WorkService(ctx, Object.assign(
    { targetChildren: 10, maxDepth: 1, budgetCeiling: 1000, currency: 'USD', priceVersion: 'm94-advanced' },
    lockPath === undefined ? {} : { homeLockPath: lockPath },
  ))
  await service.open()
  return service
}

if (role === 'hold') {
  const service = await boot()
  await service.createRun({ runId: 'run-from-A', root: ROOT, authorizationRef: 'auth-A', targetChildren: 10 })
  report({ phase: 'ready', hostPid: process.pid, runs: service.listRunIds().sort() })
  const deadline = Date.now() + 30000
  while (!existsSync(goFlagPath) && Date.now() < deadline) await pause(25)
  await service.createRun({ runId: 'run-from-A-2', root: ROOT, authorizationRef: 'auth-A', targetChildren: 10 })
  report({ phase: 'wrote-second', hostPid: process.pid, runs: service.listRunIds().sort() })
  await service.close()
  process.exit(0)
}

if (role === 'intrude') {
  let service
  let failure = null
  try {
    service = await boot()
  } catch (error) {
    failure = { name: error.name, message: error.message, code: error.code }
  }
  if (failure !== null) {
    report({ phase: 'refused', hostPid: process.pid, opened: false, failure })
    process.exit(0)
  }
  const runsOnOpen = service.listRunIds().sort()
  await service.createRun({ runId: 'run-from-B', root: ROOT, authorizationRef: 'auth-B', targetChildren: 10 })
  const runsAfterOwnWrite = service.listRunIds().sort()
  await service.close()
  report({ phase: 'wrote', hostPid: process.pid, opened: true, failure: null, runsOnOpen, runsAfterOwnWrite })
  process.exit(0)
}

if (role === 'residual') {
  const service = await boot()
  await service.createRun({ runId: 'run-residual', root: ROOT, authorizationRef: 'auth-R', targetChildren: 10 })
  await service.admit({
    runId: 'run-residual', taskId: 'task-r', childId: 'child-r',
    assignmentDigest: 'digest-r', reservedCost: 5, allowedCapabilities: ['reader'],
  })
  await service.transition({ runId: 'run-residual', taskId: 'task-r', to: 'launching' })
  // A REAL long-lived OS process, detached so it does not share the parent's
  // fate. This is the D14 hazard made concrete: the host will be SIGKILLed and
  // this process is expected to keep running.
  const grandchild = spawn(process.execPath, [gcScriptPath, gcPidPath], { detached: true, stdio: 'ignore' })
  grandchild.unref()
  const deadline = Date.now() + 15000
  while (!existsSync(gcPidPath) && Date.now() < deadline) await pause(25)
  const grandchildPid = Number(readFileSync(gcPidPath, 'utf8'))
  const record = service.getRun('run-residual')
  report({
    phase: 'ready',
    hostPid: process.pid,
    grandchildPid,
    taskState: record.tasks['task-r'].state,
    reserved: record.budget.reserved,
  })
  // A live timer, not a bare unsettled await: an unsettled top-level await does
  // not hold Node's event loop open, so the process would exit normally and the
  // test would be measuring a clean shutdown while claiming to measure a kill.
  setInterval(() => {}, 3_600_000)
  await new Promise(() => {})
}

report({ phase: 'error', reason: 'unknown role ' + String(role) })
process.exit(2)
`

/**
 * Open the real domain over `root` from THIS process.
 *
 * `mountStorage` returns the context alone, for the rigs (the effect ledger, the
 * refusal ledger) that need the storage facility without the work service.
 */
async function mountStorage(root: string): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(Storage, {} as never)
  await ctx.plugin(storageJsonPlugin as never, { root } as never)
  await ctx.plugin(storageDomainPlugin as never, { backend: 'json' } as never)
  return ctx
}

/** The grandchild program: a real process that outlives its parent. */
const RESIDUAL_CHILD_SOURCE = `
import { writeFileSync } from 'node:fs'
writeFileSync(process.argv[2], String(process.pid), 'utf8')
setInterval(() => {}, 3_600_000)
`

interface SpawnedChild {
  readonly name: string
  readonly process: ChildProcess
  readonly reportPath: string
}

const spawned: SpawnedChild[] = []
const strayPids = new Set<number>()
const tempDirs: string[] = []

function makeTempDir(label: string): string {
  const dir = mkdtempSync(join(tmpdir(), `dsh-m94-${label}-`))
  tempDirs.push(dir)
  return dir
}

/**
 * Everything the child program needs, named.
 *
 * The child receives these positionally, so building the argv from a named
 * object rather than a hand-written array is what keeps the two sides in step:
 * an earlier version of this file passed the arguments in the wrong order and
 * the child wrote its report to a file named `-`, which looked like a timeout
 * rather than a wiring bug.
 */
interface ChildTask {
  readonly name: string
  readonly dir: string
  readonly role: 'hold' | 'intrude' | 'residual'
  /** Deployment-boundary lock path, or undefined for the unguarded measurement. */
  readonly lockPath?: string
  readonly goFlagPath?: string
  readonly gcScriptPath?: string
  readonly gcPidPath?: string
}

const stderrByChild = new Map<ChildProcess, { text: string }>()

function spawnHostChild(task: ChildTask): SpawnedChild {
  const reportPath = join(task.dir, `${task.name}.report.json`)
  const child = spawn(
    process.execPath,
    [
      '--import', TSX_LOADER,
      '--input-type=module',
      '--eval', CHILD_SOURCE,
      '--',
      task.dir,
      reportPath,
      task.role,
      task.lockPath ?? '-',
      task.goFlagPath ?? '-',
      task.gcScriptPath ?? '-',
      task.gcPidPath ?? '-',
    ],
    // cwd matters: the child resolves `@deepseek-ai/*` and `tsx` through this
    // package's node_modules, which is where the DSH junctions live. It is
    // derived from THIS FILE, not from the launch directory -- see `CHILD_CWD`.
    { cwd: CHILD_CWD, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env } },
  )
  const entry: SpawnedChild = { name: task.name, process: child, reportPath }
  spawned.push(entry)
  // Keep stderr so a child that dies before reporting produces a diagnosable
  // failure rather than a bare timeout.
  const captured = { text: '' }
  child.stderr?.on('data', (chunk: Buffer) => {
    captured.text += chunk.toString()
  })
  stderrByChild.set(child, captured)
  return entry
}

/** Wait until a file exists, failing loudly if the child died first. */
async function waitForFile(child: SpawnedChild, path: string, timeoutMs = CHILD_TIMEOUT_MS): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!existsSync(path)) {
    if (child.process.exitCode !== null) {
      throw new Error(
        `child "${child.name}" exited (${child.process.exitCode}) before writing ${path}: `
        + stderrByChild.get(child.process)?.text,
      )
    }
    if (Date.now() > deadline) {
      throw new Error(
        `child "${child.name}" did not write ${path} within ${timeoutMs}ms: `
        + stderrByChild.get(child.process)?.text,
      )
    }
    await new Promise(resolve => setTimeout(resolve, 25))
  }
}

async function waitForExit(
  child: SpawnedChild,
  timeoutMs = CHILD_TIMEOUT_MS,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  const proc = child.process
  const exit = await Promise.race([
    new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => {
      if (proc.exitCode !== null || proc.signalCode !== null) {
        resolve({ code: proc.exitCode, signal: proc.signalCode })
        return
      }
      proc.once('exit', (code, signal) => resolve({ code, signal }))
    }),
    new Promise<never>((_, reject) => {
      setTimeout(
        () => reject(new Error(`child "${child.name}" did not exit within ${timeoutMs}ms`)),
        timeoutMs,
      ).unref()
    }),
  ])
  return exit
}

function readReport(child: SpawnedChild): Record<string, unknown> {
  return JSON.parse(readFileSync(child.reportPath, 'utf8')) as Record<string, unknown>
}

/** The runs the store file actually holds, read without opening the domain. */
function runsOnDisk(dir: string): string[] {
  const document = JSON.parse(readFileSync(join(dir, STORE_FILE), 'utf8')) as {
    tables: { runs: Record<string, unknown> }
  }
  return Object.keys(document.tables.runs).sort()
}

function storeDigest(dir: string): string {
  return createHash('sha256').update(readFileSync(join(dir, STORE_FILE))).digest('hex')
}

/**
 * Probe a pid for liveness.
 *
 * `pid <= 0` is rejected outright: `process.kill(0, 0)` signals the CALLER's
 * whole process group and succeeds, so a missing or unparsed pid would read as
 * "alive" and turn a lost process into a passing assertion. That failure mode
 * was observed while building this test, which is why the guard is here.
 *
 * `EPERM` means the process exists but this user may not signal it, so it
 * counts as alive.
 */
function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) throw new Error(`refusing to probe a non-pid: ${String(pid)}`)
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EPERM') return true
    return false
  }
}

/** Kill a pid hard and confirm by probing that it is gone. */
async function killAndConfirm(pid: number): Promise<boolean> {
  if (!pidAlive(pid)) return true
  try {
    process.kill(pid, 'SIGKILL')
  } catch {
    // Already gone between the probe and the signal; the confirmation below is
    // what decides, not this return value.
  }
  const deadline = Date.now() + 15_000
  while (pidAlive(pid) && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  return !pidAlive(pid)
}

/**
 * Fork a real child that boots a `WorkService`, performs the statements in
 * `childSource`, writes a report, then idles until it is hard-killed.
 *
 * The exit is reported as OBSERVED rather than as requested: `kill()` returns
 * false on Windows when the signal could not be delivered to an already-exiting
 * process, so recording the return value alone would let a no-op kill look
 * successful.
 *
 * @returns the child's report and the exit it actually produced.
 */
async function forkKillChild(
  childSource: string,
  args: readonly string[],
): Promise<{ report: Record<string, unknown>; exit: { code: number | null; signal: NodeJS.Signals | null }; stderr: string }> {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-daily-work-t9-'))
  const childPath = join(dir, 'child.mjs')
  const reportPath = join(dir, 'report.json')
  writeFileSync(childPath, childSource, 'utf8')

  let stderr = ''
  const child = spawn(
    process.execPath,
    ['--import', TSX_LOADER, childPath, ...args, reportPath],
    // cwd matters: the child resolves `@deepseek-ai/*` and `tsx` through this
    // package's node_modules, which is where the DSH junctions live. It is
    // derived from THIS FILE, not from the launch directory -- see `CHILD_CWD`.
    { cwd: CHILD_CWD, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env } },
  )
  spawned.push({ name: 't9-fork-kill', process: child, reportPath })
  child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString() })

  try {
    const deadline = Date.now() + CHILD_TIMEOUT_MS
    while (!existsSync(reportPath) && Date.now() < deadline) {
      if (child.exitCode !== null) {
        throw new Error(`the T9 child exited before reporting ready (${child.exitCode})\n${stderr}`)
      }
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    if (!existsSync(reportPath)) {
      child.kill('SIGKILL')
      throw new Error(`the T9 child never reported ready\n${stderr}`)
    }

    const report = JSON.parse(readFileSync(reportPath, 'utf8')) as Record<string, unknown>
    child.kill('SIGKILL')
    const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => {
      if (child.exitCode !== null || child.signalCode !== null) {
        return resolve({ code: child.exitCode, signal: child.signalCode })
      }
      child.once('exit', (code, signal) => resolve({ code, signal }))
    })
    return { report, exit, stderr }
  } finally {
    // The child may still be alive on the failure paths; `afterEach` reaps what
    // `spawned` still holds, and the directory goes either way.
    rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 })
  }
}

/** Open the real domain over `root` from THIS process. */
async function openService(root: string, homeLockPath?: string): Promise<{ ctx: Context; service: WorkService }> {
  const ctx = new Context()
  await ctx.plugin(Storage, {} as never)
  await ctx.plugin(storageJsonPlugin as never, { root } as never)
  await ctx.plugin(storageDomainPlugin as never, { backend: 'json' } as never)
  const service = new WorkService(ctx, {
    targetChildren: 10,
    maxDepth: 1,
    budgetCeiling: 1000,
    currency: 'USD',
    priceVersion: 'm94-advanced',
    ...homeLockPath === undefined ? {} : { homeLockPath },
  })
  await service.open()
  return { ctx, service }
}

/**
 * Seed a store with one real run, then close it.
 *
 * Returns the directory holding a valid v1 record that the D12 cases then
 * corrupt in place, which is the only way to reproduce a record written by a
 * different version of this code.
 */
async function seedStore(): Promise<string> {
  const dir = makeTempDir('d12')
  const { service } = await openService(dir)
  await service.createRun({
    runId: 'run-1',
    root: { session: { header: { id: 'session-seed' } } } as never,
    authorizationRef: 'auth-seed',
    targetChildren: 10,
  })
  await service.close()
  return dir
}

/** Rewrite the stored run record in place, the way a foreign version would. */
function patchStoredRecord(dir: string, mutate: (record: Record<string, unknown>) => void): void {
  const path = join(dir, STORE_FILE)
  const document = JSON.parse(readFileSync(path, 'utf8')) as {
    tables: { runs: Record<string, Record<string, unknown>> }
  }
  const record = document.tables.runs['run-1']
  if (record === undefined) throw new Error('the seeded store has no run-1 to patch')
  mutate(record)
  writeFileSync(path, `${JSON.stringify(document, null, 2)}\n`, 'utf8')
}

afterEach(async () => {
  // Kill host children first: a live child holds the store directory open, and
  // on Windows a directory with an open handle cannot be removed.
  for (const child of spawned.splice(0)) {
    if (child.process.exitCode === null && child.process.signalCode === null) {
      child.process.kill('SIGKILL')
      await waitForExit(child).catch(() => {})
    }
  }
  for (const pid of [...strayPids]) {
    strayPids.delete(pid)
    await killAndConfirm(pid)
  }
  stderrByChild.clear()
  for (const dir of tempDirs.splice(0)) {
    // maxRetries because Windows releases a killed process's handles a moment
    // after the signal, and a removal racing that release fails with EBUSY.
    rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
  }
})

describe('D02: a second host over one live store', () => {
  it('measures what upstream actually does: no refusal, and silent loss of the loser\'s writes', { timeout: 180_000 }, async () => {
    const dir = makeTempDir('d02-open')
    const goFlag = join(dir, 'go.flag')

    // Host A is live and holding the store. No guard is configured, which is
    // the upstream default: this is the measurement, not a setup step.
    const hostA = spawnHostChild({ name: 'hostA', dir, role: 'hold', goFlagPath: goFlag })
    await waitForFile(hostA, join(dir, 'hostA.report.json'))
    const readyA = readReport(hostA)
    const pidA = readyA['hostPid'] as number
    expect(readyA['phase']).toBe('ready')

    // The SECOND host, a real separate process, opens the same live directory.
    const hostB = spawnHostChild({ name: 'hostB', dir, role: 'intrude', goFlagPath: goFlag })
    const exitB = await waitForExit(hostB)
    expect(exitB.code).toBe(0)
    const reportB = readReport(hostB)

    // FINDING 1: nothing refuses it. The domain layer's single-open rule and
    // the backend's "exactly one live handle" rule are both PER-PROCESS, so a
    // second process is not a second handle as far as either can see.
    expect(reportB['opened']).toBe(true)
    expect(reportB['failure']).toBeNull()
    expect(reportB['runsOnOpen']).toEqual(['run-from-A'])

    // B's write is real and durable at the moment B closes: B reads its own run
    // back from its own domain. This is not a lost-in-memory update.
    expect(reportB['runsAfterOwnWrite']).toEqual(['run-from-A', 'run-from-B'])
    expect(runsOnDisk(dir)).toEqual(['run-from-A', 'run-from-B'])

    // Now A writes again. A's in-memory snapshot predates B's write, and the
    // `single` layout republishes the WHOLE unit, so A's publish erases B's run.
    writeFileSync(goFlag, 'go', 'utf8')
    const exitA = await waitForExit(hostA)
    expect(exitA.code).toBe(0)
    const doneA = readReport(hostA)

    // A never saw B's run at all: no conflict was detected, no error raised.
    expect(doneA['runs']).toEqual(['run-from-A', 'run-from-A-2'])

    // FINDING 2: the on-disk truth. run-from-B is gone. B committed a write,
    // observed it, closed cleanly, and its work was destroyed by a host that
    // never knew it existed. Last-completion-wins, exactly as the backend's
    // README states, and nothing anywhere reports a problem.
    expect(runsOnDisk(dir)).toEqual(['run-from-A', 'run-from-A-2'])
    expect(runsOnDisk(dir)).not.toContain('run-from-B')

    expect(pidA).toBeGreaterThan(0)
  })

  it('refuses the second host once the deployment-boundary guard is configured', { timeout: 180_000 }, async () => {
    const dir = makeTempDir('d02-guard')
    const lockPath = join(dir, 'owner.lock')
    const goFlag = join(dir, 'go.flag')

    const hostA = spawnHostChild({ name: 'hostA', dir, role: 'hold', lockPath, goFlagPath: goFlag })
    await waitForFile(hostA, join(dir, 'hostA.report.json'))
    const pidA = readReport(hostA)['hostPid'] as number

    // The guard's claim is a real identity, not merely "a file exists".
    const lock = JSON.parse(readFileSync(lockPath, 'utf8')) as { pid: number; token: string }
    expect(lock.pid).toBe(pidA)
    expect(lock.token.length).toBeGreaterThan(0)
    expect(pidAlive(lock.pid)).toBe(true)

    const hostB = spawnHostChild({ name: 'hostB', dir, role: 'intrude', lockPath, goFlagPath: goFlag })
    const exitB = await waitForExit(hostB)
    expect(exitB.code).toBe(0)
    const reportB = readReport(hostB)

    // The second host is blocked, and the refusal names the live holder so an
    // operator can act on it rather than guess.
    expect(reportB['opened']).toBe(false)
    const failure = reportB['failure'] as { name: string; message: string }
    expect(failure.message).toContain('refusing to open the work domain')
    expect(failure.message).toContain(String(pidA))
    expect(failure.message).toContain('no cross-process write locking')

    // And the store is untouched by the refused host: it never reached a write.
    expect(runsOnDisk(dir)).toEqual(['run-from-A'])

    // A still owns the store and can still write to it.
    writeFileSync(goFlag, 'go', 'utf8')
    expect((await waitForExit(hostA)).code).toBe(0)
    expect(runsOnDisk(dir)).toEqual(['run-from-A', 'run-from-A-2'])
  })

  it('releases the claim on a clean close, so the next generation is not locked out', { timeout: 180_000 }, async () => {
    const dir = makeTempDir('d02-release')
    const lockPath = join(dir, 'owner.lock')
    const goFlag = join(dir, 'go.flag')

    const hostA = spawnHostChild({ name: 'hostA', dir, role: 'hold', lockPath, goFlagPath: goFlag })
    await waitForFile(hostA, join(dir, 'hostA.report.json'))
    expect(existsSync(lockPath)).toBe(true)

    writeFileSync(goFlag, 'go', 'utf8')
    expect((await waitForExit(hostA)).code).toBe(0)

    // A exited through its own close(), so the KERNEL lock is gone and a fresh
    // host over the same directory starts normally.
    //
    // The note FILE remains, deliberately. It is no longer the exclusion object:
    // releasing closes a kernel handle, and the note is only an error message.
    // Deleting it would add a file-removal step whose failure modes are exactly
    // what the old protocol got wrong. What proves the claim is free is that the
    // next host OPENS -- asserted here -- not the absence of a file.
    const { service } = await openService(dir, lockPath)
    expect(service.listRunIds().sort()).toEqual(['run-from-A', 'run-from-A-2'])
    await service.close()
  })

  it('does not refuse a store because its advisory note is unreadable', async () => {
    const dir = makeTempDir('d02-unreadable')
    const lockPath = join(dir, 'owner.lock')
    // An unreadable note with NO kernel lock held is a free store. The note is
    // advisory, so it cannot refuse: letting a file we cannot parse block a host
    // would give corrupt debris the power to wedge the deployment permanently.
    writeFileSync(lockPath, 'not a lock record', 'utf8')

    const { service } = await openService(dir, lockPath)
    // The new holder replaces the unreadable note with its own identity, so the
    // next refusal names a real process rather than debris.
    expect(JSON.parse(readFileSync(lockPath, 'utf8')).pid).toBe(process.pid)
    await service.close()
  })
})

describe('D12: a record version this build does not accept', () => {
  it('rejects a v2-shaped run record at open instead of reading it as current', async () => {
    const dir = await seedStore()
    expect(runsOnDisk(dir)).toEqual(['run-1'])

    patchStoredRecord(dir, record => {
      record['version'] = 2
      record['fieldAddedInV2'] = 'a value this build has no schema for'
    })
    const digestBefore = storeDigest(dir)

    // The domain validates every stored record with zod during `open`, so the
    // failure surfaces there rather than on a later read.
    let thrown: unknown
    try {
      const opened = await openService(dir)
      await opened.service.close()
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeDefined()
    const error = thrown as { name: string; code?: string; detail?: { table: string; key: string } }
    expect(error.name).toBe('DomainError')
    expect(error.code).toBe('invalid-record')
    // The location is part of the contract: an operator must be able to find
    // the offending record without guessing.
    expect(error.detail).toEqual({ table: 'runs', key: 'run-1' })

    // The plan's rule is "refuses to start rather than silently reading a
    // backup". A rejected open must therefore not have rewritten, migrated or
    // truncated the file it refused: the bytes are untouched.
    expect(storeDigest(dir)).toBe(digestBefore)
    expect(runsOnDisk(dir)).toEqual(['run-1'])
  })

  it('rejects a malformed record rather than dropping it', async () => {
    const dir = await seedStore()
    patchStoredRecord(dir, record => {
      const budget = record['budget'] as Record<string, unknown>
      budget['spent'] = 'not-a-number'
    })
    const digestBefore = storeDigest(dir)

    await expect(openService(dir)).rejects.toMatchObject({
      name: 'DomainError',
      code: 'invalid-record',
      detail: { table: 'runs', key: 'run-1' },
    })

    // No backup-and-skip: this domain's records are authoritative, so a
    // malformed one must not be quietly moved aside and the host started
    // anyway with the run missing.
    expect(storeDigest(dir)).toBe(digestBefore)
  })

  it('rejects a foreign unit version and a non-JSON medium, each with its own code', async () => {
    const versionDir = await seedStore()
    const versionPath = join(versionDir, STORE_FILE)
    const document = JSON.parse(readFileSync(versionPath, 'utf8')) as { unit: { version: number } }
    document.unit.version = 2
    writeFileSync(versionPath, `${JSON.stringify(document, null, 2)}\n`, 'utf8')

    // The whole-unit header version is the BACKEND's check, not the domain's,
    // so it fails with the backend's own code before any record is validated.
    await expect(openService(versionDir)).rejects.toMatchObject({
      name: 'StorageError',
      code: 'version-mismatch',
    })

    const brokenDir = await seedStore()
    writeFileSync(join(brokenDir, STORE_FILE), '{ this is not json', 'utf8')
    await expect(openService(brokenDir)).rejects.toMatchObject({
      name: 'StorageError',
      code: 'malformed-medium',
    })
  })

  it('opens the same directory normally once the record matches the current schema', async () => {
    // The control: the rejections above are about the record's shape, not a
    // directory left unusable by the failed opens.
    const dir = await seedStore()
    patchStoredRecord(dir, record => {
      record['version'] = 2
    })
    await expect(openService(dir)).rejects.toThrow(/does not match its schema/)

    patchStoredRecord(dir, record => {
      record['version'] = 1
    })
    const { service } = await openService(dir)
    expect(service.getRun('run-1')?.version).toBe(1)
    expect(service.getRun('run-1')?.budget.reserved).toBe(0)
    await service.close()
  })
})

describe('D14: OS processes that outlive a hard kill', () => {
  it('measures that a detached grandchild survives, and that recovery does not read that as cleanup', { timeout: 180_000 }, async () => {
    const dir = makeTempDir('d14')
    const gcScriptPath = join(dir, 'residual-child.mjs')
    const gcPidPath = join(dir, 'grandchild.pid')
    writeFileSync(gcScriptPath, RESIDUAL_CHILD_SOURCE, 'utf8')

    const host = spawnHostChild({
      name: 'host',
      dir,
      role: 'residual',
      gcScriptPath,
      gcPidPath,
    })
    await waitForFile(host, join(dir, 'host.report.json'))
    const ready = readReport(host)
    expect(ready['phase']).toBe('ready')

    const hostPid = ready['hostPid'] as number
    const grandchildPid = ready['grandchildPid'] as number
    expect(hostPid).toBeGreaterThan(0)
    expect(grandchildPid).toBeGreaterThan(0)
    expect(grandchildPid).not.toBe(hostPid)

    // Before the kill both are genuinely alive, so the probe is measuring a
    // real process rather than a pid file someone wrote.
    expect(pidAlive(hostPid)).toBe(true)
    expect(pidAlive(grandchildPid)).toBe(true)
    strayPids.add(grandchildPid)

    // The task was durably admitted and moved to launching: the host believed
    // it had started a child, and that belief is on the medium.
    expect(ready['taskState']).toBe('launching')
    expect(ready['reserved']).toBe(5)

    // THE KILL. SIGKILL cannot be caught, so no shutdown hook runs and no
    // child cleanup is attempted.
    const signalRequested = host.process.kill('SIGKILL')
    const exit = await waitForExit(host)
    expect(exit.signal).not.toBeNull()
    expect(pidAlive(hostPid)).toBe(false)

    // MEASURED, not assumed: does the OS process the host started still run?
    const residualSurvived = pidAlive(grandchildPid)

    // Reopen the store from THIS process, as a restarted host would.
    const { service } = await openService(dir)
    const record = service.getRun('run-residual')
    expect(record).toBeDefined()
    const task = record?.tasks['task-r']
    expect(task).toBeDefined()

    // The record still says `launching`: nothing wrote a terminal state on the
    // way down, so recovery starts from a truthful last-known position.
    expect(task?.state).toBe('launching')
    expect(record?.budget.reserved).toBe(5)

    // The gate's actual oracle. Recovery is given the only evidence a restarted
    // host has for a local child: no Session, no live Agent. That absence is
    // NOT proof the process is gone, and the reconciler must therefore return
    // `unknown` with the slot and its credit still held.
    const decision = reconcileTask(task!, {
      taskId: 'task-r',
      childId: 'child-r',
      sessionExists: false,
      agentLive: false,
      requestObserved: false,
      turnOutcome: undefined,
      resultRef: undefined,
      launchProvenNotCreated: false,
    })
    expect(decision.next).toBe('unknown')
    expect(decision.releaseSlot).toBe(false)
    expect(decision.reason).toContain('quarantined')

    // And the record must not have been advanced to a state that would imply
    // the child finished or was cleaned up.
    expect(['confirmed', 'cancelled', 'settling']).not.toContain(task?.state)

    await service.close()

    // The honest report of what was observed. `residualSurvived` is recorded
    // either way; this build measured `true` on this platform, so the test
    // fails loudly if that ever stops being true rather than quietly passing.
    expect(residualSurvived).toBe(true)

    // Cleanup that is OBSERVED rather than assumed: the probe must report the
    // process gone before the test is allowed to pass.
    expect(await killAndConfirm(grandchildPid)).toBe(true)
    strayPids.delete(grandchildPid)
    expect(pidAlive(grandchildPid)).toBe(false)
    expect(signalRequested || exit.signal !== null).toBe(true)
  })

  it('does not treat a missing pid as proof that a process is gone', () => {
    // A pid that cannot exist on this platform, so the probe's negative answer
    // is real rather than a lucky accident of the process table.
    const deadPid = 0x7ffffff0
    expect(pidAlive(deadPid)).toBe(false)

    // The trap this guards: `process.kill(0, 0)` signals the caller's whole
    // process group and SUCCEEDS, so an unparsed or zero pid would read as
    // alive. The probe refuses such input instead of answering it.
    expect(() => pidAlive(0)).toThrow(/refusing to probe a non-pid/)
    expect(() => pidAlive(Number.NaN)).toThrow(/refusing to probe a non-pid/)

    // The caller's own process is trivially alive, which is the positive
    // control for the same code path.
    expect(pidAlive(process.pid)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// T9-A: the epoch question is CLOSED BY DELETION, and this is the non-claim
// ---------------------------------------------------------------------------

/**
 * WHAT THIS SECTION MEASURES NOW, and why it changed shape.
 *
 * It used to assert that `recovery.ts`'s epoch guard was correct, unit-tested and
 * unreachable — the finding filed as G-SEAM-21 and as the v1 cases REC-09/REC-10.
 * The guard, the `WorkerSettlement` type, the `RefusalLedger` and the run record's
 * `epoch` field have since been DELETED, and the reason is a topology measurement
 * rather than a preference:
 *
 *   The guard was not merely unreachable, it guarded a path that does not exist.
 *   A stale-generation settlement needs a settlement PRODUCER. `WorkService.
 *   transition` is the only method that can write a task's terminal state, its
 *   reservation release and its tombstone, and NO production call site targets
 *   `settling`, `confirmed`, `cancelled`, `executing` or `cancel_requested`. The
 *   launch port resolves at the ADMISSION edge and is never called back on
 *   completion. The package has no completion listener, no settlement entry
 *   point, no outbox consumer, no IPC channel and no second process. And nothing
 *   ever bumped the epoch: `initialRunRecord` wrote the literal 1 and no other
 *   code read or wrote it, so even a wired guard would have compared 1 to 1
 *   forever. Full graph: `qualification/results/R9-recovery-topology/TOPOLOGY.md`.
 *
 * So wiring it would have meant INVENTING a cross-process settlement producer,
 * which the audit forbids. The honest resolution is the other direction, and it is
 * the one measured here.
 *
 * WHAT THIS REMOVAL IS: a CLAIM that was never true is removed — an epoch that
 * looked like a guard only because nothing checked it. It is NOT the removal of a
 * mechanism the product relied on. Same shape as G-SEAM-50, where CMP-06's
 * sandbox-policy protection is unreachability rather than immutability.
 *
 * v1's REC-09/REC-10 stay FAIL. Nothing here makes them pass, and nothing here
 * edits the frozen spec, `qualification/gates.json` or `compatibility.lock.json`.
 */
describe('T9-A: the run epoch is DELETED, and v2 does not claim the guarantee', () => {
  it('the deleted settlement machinery has no surviving reference anywhere in the source', () => {
    // The removal must be total. A dangling import, a stale type reference or a
    // leftover domain name would be a compile error at best and a resurrected
    // claim at worst, so this is asserted over EVERY TypeScript file in the
    // package, tests included.
    //
    // Two different checks, because the two file kinds carry different risk:
    //   - PRODUCTION files must not mention these identifiers in CODE at all.
    //     Comments may name them: that is where the deletion is documented.
    //   - TEST files are allowed to name them as string DATA (the assertion lists
    //     below do exactly that), so what is checked there is that no test
    //     IMPORTS a deleted symbol. A test that imported one would not compile,
    //     which is the real dangling-reference risk.
    const src = join(import.meta.dirname)
    const all = readdirSync(src).filter(name => name.endsWith('.ts'))
    // The identifiers that no longer exist. `relaunchPrepared` is deliberately
    // NOT in this list: it is a different claim (gate D03) and is kept.
    const dead = [
      'applyWorkerSettlement',
      'WorkerSettlement',
      'SettlementOutcome',
      'RefusalLedger',
      'RefusalRecord',
      'refusalRecordSchema',
      'refusalDomainSpec',
      'REFUSAL_DOMAIN_NAME',
      'dsh_daily_work_refusals',
    ]
    const codeMentions: string[] = []
    const importers: string[] = []
    for (const file of all) {
      const text = readFileSync(join(src, file), 'utf8')
      const code = text.split(/\r?\n/u)
        .filter(line => !/^\s*(?:\/\/|\*|\/\*)/u.test(line))
        .join('\n')
      if (!file.endsWith('.test.ts')) {
        for (const symbol of dead) {
          // AS AN IDENTIFIER, NOT AS A SUBSTRING. `includes` reported
          // `mountRefusalRecording` (R7's LIVE function, added after this list was
          // written) as a surviving `RefusalRecord`, because the deleted name is a
          // prefix of the live one. A scan for dead identifiers has to match whole
          // identifiers, or every future name that extends a deleted one reads as a
          // regression -- and the pressure then runs the wrong way, toward renaming
          // a live function to appease a test.
          if (new RegExp(`\\b${symbol}\\b`, 'u').test(code)) codeMentions.push(`${file}: ${symbol}`)
        }
      } else {
        // Every import statement, so a deleted symbol reached through
        // `import { x } from './recovery.ts'` is caught wherever it appears.
        //
        // IDENTIFIER-EXACT, for the same reason the production scan above is:
        // `includes` reported `mountRefusalRecording` -- R7's LIVE function -- as an
        // import of the deleted `RefusalRecord`, because the dead name is a prefix
        // of the live one.
        for (const statement of text.matchAll(/import\s*(?:type\s*)?\{[^}]*\}\s*from\s*'[^']+'/gu)) {
          for (const symbol of dead) {
            if (new RegExp(`\\b${symbol}\\b`, 'u').test(statement[0])) importers.push(`${file}: ${symbol}`)
          }
        }
      }
    }
    expect(codeMentions, 'no PRODUCTION file may mention the deleted machinery in code').toEqual([])
    expect(importers, 'no test may IMPORT a deleted symbol').toEqual([])
  })

  it('the run record no longer carries an epoch, and nothing writes or reads one', () => {
    const src = join(import.meta.dirname)
    const production = readdirSync(src).filter(name => name.endsWith('.ts') && !name.endsWith('.test.ts'))
    // Comments are stripped before matching, because the corrected comment in
    // `record.ts` QUOTES the line that was removed — that quotation is the
    // documentation, and it must not read as the declaration.
    const strip = (text: string): string =>
      text.split(/\r?\n/u).filter(line => !/^\s*(?:\/\/|\*|\/\*)/u.test(line)).join('\n')
    const recordCode = strip(readFileSync(join(src, 'record.ts'), 'utf8'))
    // The field is GONE from both the schema and the initialiser. Asserting the
    // absence is the point: the field was inert, and an inert field documented as
    // a guarantee is the defect this slice exists to remove.
    expect(recordCode, 'the schema must not declare an epoch field').not.toMatch(/epoch:\s*z\.number/u)
    expect(recordCode, 'the initialiser must not write an epoch').not.toMatch(/^\s*epoch:\s*1,/mu)
    // And no PRODUCTION module mentions it in code at all — the removal is total,
    // not merely relocated.
    const codeMentions: string[] = []
    for (const file of production) {
      const code = strip(readFileSync(join(src, file), 'utf8'))
      // `kernel-lifecycle.ts` has a KERNEL epoch, a different field with the same
      // word (G-SEAM-43); it is excluded by name so this assertion stays about the
      // RUN record rather than about the word.
      if (file !== 'kernel-lifecycle.ts' && /\bepoch\b/u.test(code)) codeMentions.push(file)
    }
    expect(codeMentions, 'no production module may reference a run epoch').toEqual([])
  })

  it('is unreachable from every PACKAGE ENTRY POINT, not merely from a direct import', () => {
    // The stronger form of the reachability finding, and the one that decides
    // whether a module with no DIRECT importer is a live defect or a documentation
    // problem: a module can still be reachable transitively. This closes that gap
    // by walking the import graph from the package's own published entry points.
    //
    // It is KEPT after the epoch deletion because its subject is the reachability
    // of the recovery modules as a class — which is exactly what the topology
    // measurement rests on — and because the `host.ts` control makes it
    // falsifiable rather than an empty negative.
    const src = join(import.meta.dirname)
    const pkg = JSON.parse(readFileSync(join(src, '..', 'package.json'), 'utf8')) as {
      readonly exports: Record<string, unknown>
    }
    // `exports` maps a subpath to `{ types, default }`; the `.default` is the
    // built file, so the corresponding source is its basename under `src/`.
    const entryPoints = Object.values(pkg.exports)
      .filter((value): value is { readonly default: string } => typeof value === 'object' && value !== null && 'default' in value)
      .map(value => value.default.replace('./lib/', '').replace(/\.js$/u, '.ts'))
    expect(entryPoints.length, 'the package must publish entry points for this to be a real measurement').toBeGreaterThan(4)
    const missingEntries = entryPoints.filter(name => !existsSync(join(src, name)))
    expect(missingEntries, 'every published entry point must resolve to a real source file').toEqual([])

    const production = readdirSync(src).filter(name => name.endsWith('.ts') && !name.endsWith('.test.ts'))
    // Every relative import specifier in a production file, including `import
    // type` and `export ... from`, because a type-only coupling still means the
    // module is part of the graph a reader would have to reason about.
    const specifiers = (name: string): string[] =>
      [...readFileSync(join(src, name), 'utf8').matchAll(/from\s+'(\.[^']+)'/gu)].map(match => match[1] ?? '')
    // The edges point the way the CODE reaches: an entry point reaches whatever it
    // imports. Walking `importersOf` instead would answer "which modules import an
    // entry point", which is a different question and produces a wrong YES for any
    // module that happens to import `host.ts` — an earlier version of this test had
    // exactly that bug and `recovery.ts` came back reachable for that reason.
    const importsOf = (name: string): string[] =>
      specifiers(name)
        .filter(specifier => specifier.endsWith('.ts'))
        .map(specifier => specifier.slice(2))
        .filter(target => production.includes(target))
    const closureFrom = (start: readonly string[]): Set<string> => {
      const seen = new Set(start)
      const queue = [...start]
      while (queue.length > 0) {
        for (const next of importsOf(queue.pop() ?? '')) {
          if (!seen.has(next)) {
            seen.add(next)
            queue.push(next)
          }
        }
      }
      return seen
    }

    const reachable = closureFrom(entryPoints)
    // The measurement: `recovery.ts` is in NO entry point's transitive closure.
    // The `host.ts` control is what makes this falsifiable — it IS reachable, so
    // the walk is capable of finding reachable modules and this is not an empty
    // negative produced by a broken traversal.
    expect(reachable.has('recovery.ts'), 'recovery.ts must be in no entry point\'s transitive closure').toBe(false)
    expect(reachable.has('host.ts'), 'control: host.ts IS reachable, so the walk works').toBe(true)
    // The same walk, for the module `recovery.ts` depends on for its decisions.
    expect(reachable.has('reconcile.ts'), 'reconcile.ts is likewise unreachable from the product').toBe(false)
  })

  it('the consequence: only TESTS reach these modules, so the product never reconciles at all', () => {
    // THE HONEST HALF, and it is stronger than "the epoch field is inert". If
    // `recovery.ts` and `reconcile.ts` are reachable only from test files, then no
    // production code path calls `reconcileTask`, `relaunchPrepared` — or, before
    // its deletion, the settlement guard. The product therefore does not reconcile
    // an unknown outcome — it cannot, because there is no caller.
    //
    // This test is UNCHANGED by the epoch deletion and is deliberately kept: its
    // subject is reachability of the recovery modules as a class, not the guard.
    // It is also the independent corroboration of the topology measurement, since
    // it re-derives the importer sets rather than citing them.
    //
    // What that does and does not mean for the "never auto-replay" constraint is
    // measured rather than asserted, and the answer is asymmetric:
    //   - the product CANNOT auto-replay an unknown effect, because nothing in it
    //     reaches `reconcileTask` (whose every uncertain branch returns `unknown`)
    //     or `EffectLedger.perform` (whose only send-licensing states are proofs
    //     about our own write ordering);
    //   - but it also cannot REFUSE to, because refusing is a decision the absent
    //     caller would have made. An unknown outcome is left in the record and no
    //     path resolves it.
    // The constraint holds by omission, not by enforcement. That distinction is
    // the finding, and it is why "unknown effects are never replayed" must not be
    // reported as a property the product enforces.
    const src = join(import.meta.dirname)
    const testFiles = readdirSync(src).filter(name => name.endsWith('.test.ts'))
    const production = readdirSync(src).filter(name => name.endsWith('.ts') && !name.endsWith('.test.ts'))
    const importsOf = (name: string): string[] =>
      [...readFileSync(join(src, name), 'utf8').matchAll(/from\s+'(\.[^']+)'/gu)]
        .map(match => (match[1] ?? '').slice(2))
        .filter(specifier => specifier.endsWith('.ts'))
    const importersOf = (target: string, pool: readonly string[]): string[] =>
      pool.filter(name => name !== target && importsOf(name).includes(target))

    // MEASURED: the importer sets of the modules, split by kind.
    const testImporters = (target: string): string[] => importersOf(target, testFiles).sort()
    const productionImporters = (target: string): string[] => importersOf(target, production).sort()

    expect(productionImporters('recovery.ts'), 'recovery.ts has NO production importer').toEqual([])
    // `recovery.ts` still has exactly two test importers. What they import changed
    // — `durability-records.test.ts` now takes only `relaunchPrepared`, and the
    // settlement API is gone — but the reachability claim this test makes is about
    // the module, and it still holds.
    expect(testImporters('recovery.ts'), 'and its only importers are tests').toEqual([
      'durability-advanced.test.ts',
      'durability-records.test.ts',
    ])
    // `reconcile.ts` DOES have one production importer, and naming it honestly is
    // the point: `durability-runner.ts` is a CLI entry executed by hand
    // (`docs/OPERATIONS.md`), it is in no `exports` subpath and no profile mounts
    // it. Counting that as production reachability would be the same "presence is
    // not reachability" error this whole gate is about, so the two assertions
    // below are deliberately separate: the importer exists, AND that importer is
    // itself unreachable.
    expect(productionImporters('reconcile.ts'), 'reconcile.ts\'s only production importer is the hand-run CLI').toEqual([
      'durability-runner.ts',
    ])
    expect(productionImporters('durability-runner.ts'), 'and that CLI is itself in no production import graph').toEqual([])
    expect(productionImporters('effects.ts'), 'the effect ledger has no production importer at all').toEqual([])
    expect(productionImporters('effects.ts').length + testImporters('effects.ts').length, 'it is reachable from tests only').toBe(2)
    expect(testImporters('effects.ts'), 'namely these two').toEqual([
      'durability-advanced.test.ts',
      'effects.test.ts',
    ])
  })

  it('the DECIDING topology fact: no production call site targets a TERMINAL state', () => {
    // This is the measurement the deletion rests on, re-derived from the tree so
    // it cannot rot into a citation. `transition` is the only method that moves a
    // task's state, so the question is which states any production caller targets.
    //
    // CORRECTED AFTER A FALSIFIED FIRST DRAFT. The first version of this test
    // hand-picked the state list `settling|confirmed|cancelled|executing|
    // cancel_requested` — which OMITTED `unknown`, the one non-terminal state the
    // product actually writes (host.ts:1342, host.ts:1364). The test therefore
    // certified a claim ("no production call site targets a terminal state") whose
    // supporting sentence ("the product never reaches a terminal state, and the
    // only sites that ever did are deleted or unreachable") was false as written.
    // A hand-picked list can hide the very state that matters; deriving from the
    // exported `TERMINAL_STATES` constant is what makes this checkable.
    const src = join(import.meta.dirname)
    const production = readdirSync(src).filter(name => name.endsWith('.ts') && !name.endsWith('.test.ts'))
    // Derived, not hand-picked: the project's own definition of terminal.
    expect([...TERMINAL_STATES], 'terminal means confirmed|cancelled (states.ts:67-70)').toEqual([
      'confirmed',
      'cancelled',
    ])
    // HARDENED: the terminator `[,}]` after the literal is load-bearing. Without
    // it the pattern also matches a UNION TYPE ANNOTATION
    // (`readonly to: 'settling' | 'confirmed' | 'cancelled'`, which is a field
    // declaration, not a call site) and would report a state as written that no
    // code writes. Root caught exactly that false positive by hand in the base
    // tree; the pattern now refuses it mechanically. Both failure directions are
    // therefore closed: a state can neither be omitted by a hand-picked list, nor
    // invented by matching a declaration.
    const targeted = (text: string): string[] =>
      [...text.matchAll(/to:\s*'([a-z_]+)'\s*[,}]/gu)].map(match => match[1] ?? '')
    // Positive control: the pattern must still find a real call site, or the
    // "no writer" results below would be an empty negative from a broken matcher.
    expect(
      targeted("await this.transition({ runId, taskId, to: 'launching' })"),
      'control: a real call site must match',
    ).toEqual(['launching'])
    expect(
      targeted("readonly to: 'settling' | 'confirmed' | 'cancelled'"),
      'control: a type annotation must NOT match',
    ).toEqual([])
    const terminalWriters: string[] = []
    const unknownWriters: string[] = []
    for (const file of production) {
      const states = targeted(readFileSync(join(src, file), 'utf8'))
      if (states.some(state => (TERMINAL_STATES as readonly string[]).includes(state))) terminalWriters.push(file)
      if (states.includes('unknown')) unknownWriters.push(file)
    }
    // FACT 1, and it is the load-bearing one: no production file targets a terminal
    // state. The hand-run CLI is the only non-test file that names a terminal-ish
    // target at all (it writes `executing`, which is NOT terminal) — so the list
    // below is empty, and the CLI's reachability is asserted separately.
    expect(terminalWriters, 'no production file may target a terminal state').toEqual([])
    // FACT 2, stated rather than filtered away: the product DOES write the
    // non-terminal uncertainty state `unknown`, on the drain path.
    expect(unknownWriters.sort(), 'the product writes `unknown` on the drain path').toEqual([
      'host.ts',
      'recovery.ts',
    ])
    const host = readFileSync(join(src, 'host.ts'), 'utf8')
    expect(host, 'host.ts:1342 — no launch port installed').toMatch(/to: 'unknown',\s*\n\s*uncertainty: 'no launch port installed'/u)
    expect(host, 'host.ts:1364 — launch failed').toMatch(/to: 'unknown',\s*\n\s*uncertainty: `launch failed/u)
    // Both keep the reservation, which is what makes the state worth leaving.
    const unknownWrites = [...host.matchAll(/to: 'unknown',[\s\S]{0,220}?releaseReservation: false/gu)]
    expect(unknownWrites, 'both `unknown` writes hold the reservation').toHaveLength(2)
    // And the CLI that writes `executing` is itself unreachable, which is what
    // makes excluding it honest rather than convenient.
    const importersOfRunner = production.filter(name =>
      name !== 'durability-runner.ts'
      && /from\s+'\.\/durability-runner\.ts'/u.test(readFileSync(join(src, name), 'utf8')))
    expect(importersOfRunner, 'the hand-run CLI has no importer').toEqual([])
  })

  it('and nothing can move a task OUT of `unknown`, which is the state the product leaves it in', async () => {
    // THE SHARPER HALF, and the one that survives the correction above. The
    // product writes `unknown` and never resolves it: a settlement is the act of
    // LEAVING an in-flight state, and for the state the product actually leaves a
    // task in there is no exit on any production path.
    //
    // The exits the state machine permits from `unknown` are
    // `accepted | executing | settling | confirmed | cancelled | cancel_requested`
    // (states.ts:93). Every one of them except `accepted` has NO production writer
    // at all, and `accepted` is unreachable for an `unknown` task because `admit`
    // refuses a task that still holds its slot (host.ts:823-825) — and `unknown`
    // holds one (states.ts:63). Measured here through the REAL drain, the same
    // path the model-facing `work` tool uses (tools.ts:162).
    const root = makeTempDir('r9-unknown-exit')
    const { ctx, service } = await openService(root)
    try {
      const runId = 'run-unknown-exit'
      await service.createRun({
        runId,
        root: { session: { header: { id: 'root-unknown-exit' } } } as never,
        authorizationRef: 'auth',
      })
      // A port that FAILS, so the drain takes the launch-failure arm (host.ts:1361).
      service.setLaunchPort({
        async launch(): Promise<{ childId: string }> {
          throw new Error('provider exploded')
        },
      })
      const request = { taskId: 't1', childId: 'c1', prompt: 'p', reservedCost: 5 }
      const first = await service.drain(runId, [request], new AbortController().signal)
      expect(first[0]?.reason).toBe('launch_failed_unknown')
      const afterFailure = service.getRun(runId)
      // The state the product leaves: `unknown`, reservation held, uncertainty named.
      expect(afterFailure?.tasks['t1']?.state).toBe('unknown')
      expect(afterFailure?.budget.reserved, 'the reservation stays held').toBe(5)
      expect(afterFailure?.tasks['t1']?.uncertainty).toMatch(/launch failed/u)
      expect(holdsSlot(afterFailure!.tasks['t1']!.state), '`unknown` holds a slot').toBe(true)

      // EXIT ATTEMPT 1 — re-drain the same task. Refused by `admit`, because the
      // task holds its slot.
      const second = await service.drain(runId, [request], new AbortController().signal)
      expect(second[0]?.accepted).toBe(false)
      expect(second[0]?.reason, 'admit refuses a slot-holding task').toMatch(/already admitted as unknown/u)
      expect(service.getRun(runId)?.tasks['t1']?.state, 'still unknown after a re-drain').toBe('unknown')

      // EXIT ATTEMPT 2 — `relaunchPrepared`, the kept recovery function. It refuses
      // anything that is not `prepared`, so it cannot resolve `unknown` either.
      const relaunch = await relaunchPrepared({
        service,
        port: { async launch(request) { return { childId: request.childId } } },
        runId,
        taskId: 't1',
        assignmentDigest: 'p',
        signal: new AbortController().signal,
      })
      expect(relaunch.launched).toBe(false)
      expect(relaunch.reason, 'relaunchPrepared only accepts `prepared`').toMatch(/is unknown; only a task proven never to have launched/u)
      expect(service.getRun(runId)?.tasks['t1']?.state, 'still unknown after relaunchPrepared').toBe('unknown')
      expect(service.getRun(runId)?.budget.reserved, 'and the reservation is still held').toBe(5)
    } finally {
      await service.close()
      await ctx.fiber.dispose()
    }
  })

  it('`host.ts` no longer claims a per-await epoch re-check it does not perform', () => {
    // Two comments in `host.ts` stated the top-up contract in the grammar of
    // enforcement ("we re-check the run epoch"; "authority is bound to the live
    // object plus the run epoch"). Neither was true of the code: the word `epoch`
    // appeared in that file ONLY inside those comments. They are corrected, and
    // the correction is asserted so the false claim cannot come back.
    const host = readFileSync(join(join(import.meta.dirname), 'host.ts'), 'utf8')
    const code = host.split(/\r?\n/u)
      .filter(line => !/^\s*(?:\/\/|\*|\/\*)/u.test(line))
      .join('\n')
    expect(code, 'host.ts must contain no epoch EXPRESSION').not.toMatch(/\bepoch\b/u)
    // The claim is gone, and what is actually enforced is named instead.
    expect(host).not.toContain('After every await we re-check the run epoch')
    expect(host).not.toContain('bound to the live object plus the run epoch')
    expect(host).toContain('tool-protocol-guards.ts')
    // The REAL await-boundary re-checks, quoted from the loop they guard.
    //
    // ASSERTED AS THE INVARIANT, NOT AS ONE SPELLING OF IT -- the same correction
    // `sec-gates.test.ts` carries, because this case duplicated the assertion. It
    // pinned two separate one-line guards, which is the shape R9's tree had; R3's
    // admission rework replaced that loop with a batched form checking both
    // conditions in one combined guard before doing any work:
    //
    //     if (this.disposed || entry.signal.aborted) break
    //
    // Same protection, so the old spelling failed a correct tree. What is asserted
    // is what the case is about: work stops once the service is disposed or the
    // caller's signal has aborted, and it BREAKS rather than inventing an outcome.
    expect(code, 'the drain must still stop on a disposed service').toMatch(/this\.disposed/u)
    expect(code, 'the drain must still stop on an aborted caller').toMatch(/signal\.aborted/u)
    expect(code, 'the combined guard must break rather than invent an outcome')
      .toMatch(/this\.disposed \|\| entry\.signal\.aborted\) break/u)
  })

  it('the v1 FAIL is preserved: REC-09 and REC-10 still read FAIL in the frozen spec', () => {
    // The historical record must not be retroactively improved. This slice may not
    // make an old case pass by changing the product after the fact, and it must not
    // edit the frozen spec either.
    // Derived from THIS file's location rather than from a repo-root constant:
    // the spec lives outside the package and this file has no such constant.
    // src/ -> dsh-daily-work/ -> packages/ -> repo root.
    const specPath = join(import.meta.dirname, '..', '..', '..', 'qualification', 'specs', 'acceptance-spec.trusted-local-v1.json')
    const spec = JSON.parse(readFileSync(specPath, 'utf8')) as
      | { readonly id: string; readonly status: string }[]
      | { readonly cases: { readonly id: string; readonly status: string }[] }
    const cases = Array.isArray(spec) ? spec : spec.cases
    const byId = new Map(cases.map(entry => [entry.id, entry.status]))
    expect(byId.get('REC-09'), 'v1 REC-09 stays FAIL — the guarantee was never true').toBe('FAIL')
    expect(byId.get('REC-10'), 'v1 REC-10 stays FAIL — the guard was never reachable').toBe('FAIL')
  })
})


// ---------------------------------------------------------------------------
// T9-B: the real rewind consequence, measured rather than inherited
// ---------------------------------------------------------------------------

/**
 * The corrected probe's claim, re-derived in-process.
 *
 * `qualification/results/R4-upgrade/FINDINGS.md` §7 records that
 * `u06-rollback.mjs`'s fake remote returns `{ kind: 'accepted' }` where
 * `EffectPerformResult` is discriminated on `status`, so the stored record has
 * NO `status` key and the rehearsal's R3 step passed on `undefined`. It also
 * records what the CORRECTED fixture shows. Both halves are re-measured here
 * rather than taken from that report.
 *
 * The finding is sharper than the rehearsal's prose: when the effect ledger
 * genuinely lives inside the rewound tree, the outcome is not a refusal at all.
 * The ledger opens CLEANLY with ZERO operations, so the local knowledge of an
 * effect the world still remembers is SILENTLY GONE. That is what a rollback
 * procedure has to be written against.
 */
describe('T9-B: the effect ledger across a real state rewind', () => {
  /** A counting fake remote, with the CORRECT discriminator. */
  function countingRemote(): {
    readonly adapter: {
      readonly kind: string
      readonly capabilities: { readonly idempotencyKey: boolean; readonly queryable: boolean }
      perform: (intent: EffectIntent, identity: { readonly operationId: string }) => Promise<{ readonly status: 'confirmed'; readonly resultRef: string }>
      query: (operationId: string) => Promise<{ readonly status: 'confirmed'; readonly resultRef: string } | { readonly status: 'not_started'; readonly detail: string }>
    }
    performCount: () => number
  } {
    let performed = 0
    const committed = new Map<string, string>()
    return {
      adapter: {
        kind: 't9b-remote',
        capabilities: { idempotencyKey: true, queryable: true },
        async perform(_intent: EffectIntent, identity: { readonly operationId: string }) {
          performed += 1
          const resultRef = `remote-${String(performed)}`
          committed.set(identity.operationId, resultRef)
          return { status: 'confirmed' as const, resultRef }
        },
        async query(operationId: string) {
          const held = committed.get(operationId)
          return held === undefined
            ? { status: 'not_started' as const, detail: 'the remote has no record of this operation' }
            : { status: 'confirmed' as const, resultRef: held }
        },
      },
      performCount: () => performed,
    }
  }

  it('the rehearsal\'s fixture defect is real: `kind` instead of `status` stores a record with no status', async () => {
    // Reproduce the DEFECT deliberately, so the claim that it produced a
    // `status`-less record is a measurement rather than a reading of the script.
    const root = makeTempDir('t9b-defect')
    const ctx = await mountStorage(root)
    const ledger = new EffectLedger(ctx)
    await ledger.open()
    const intent: EffectIntent = { kind: 't9b-defect', logicalKey: 'k', parameters: { b: 1 } }
    const broken = {
      kind: 't9b-defect',
      capabilities: { idempotencyKey: true, queryable: false },
      // THE DEFECT, verbatim in shape: `kind` where `EffectPerformResult` is
      // discriminated on `status`.
      async perform(): Promise<never> {
        return { kind: 'accepted', resultRef: 'remote-1' } as never
      },
      async query(): Promise<never> {
        throw new Error('not queryable')
      },
    }
    const attempt = await ledger.perform(broken, intent)
    // The outcome is `undefined` and the stored record has no `status` VALUE. The
    // rehearsal's R3 check is `performed.performed ? PASS : FAIL`, which is true
    // here — so it passed on a record the schema would reject at reopen.
    expect(attempt.performed).toBe(true)
    expect(attempt.outcome).toBeUndefined()
    const stored = ledger.get(identify(intent).operationId)
    expect(stored, 'the record exists').toBeDefined()
    // IN MEMORY the key is present and its value is `undefined`: `send` spreads
    // `status: result.status` where `result.status` is `undefined`. Asserting
    // `Object.hasOwn(...) === false` here would be asserting something FALSE, and
    // an earlier version of this test did exactly that — the defect is not a
    // missing key in the object, it is an undefined VALUE that the medium cannot
    // represent.
    expect(Object.hasOwn(stored ?? {}, 'status'), 'in memory the key EXISTS, with an undefined value').toBe(true)
    expect((stored as { status?: unknown } | undefined)?.status, 'and that value is undefined, which is the defect').toBeUndefined()
    await ledger.close()
    await ctx.fiber.dispose()

    // ON DISK the key is GONE, which is the part that matters: JSON has no
    // representation for `undefined`, so the serialized document simply omits it.
    // This is the artifact the next generation validates, so it is the one to
    // assert on — and it is why the reopen below is refused.
    const persistedPath = join(root, 'dsh_daily_effects.json')
    expect(existsSync(persistedPath), 'the effect ledger is one JSON unit file in the store root').toBe(true)
    const persisted = JSON.parse(readFileSync(persistedPath, 'utf8')) as {
      readonly tables?: { readonly operations?: Record<string, Record<string, unknown>> }
    }
    const documents = Object.values(persisted.tables?.operations ?? {})
    expect(documents, 'exactly one operation document was persisted').toHaveLength(1)
    expect(Object.hasOwn(documents[0] ?? {}, 'status'), 'the PERSISTED record has NO status key').toBe(false)
    expect(Object.hasOwn(documents[0] ?? {}, 'attempts'), 'and the rest of the record is intact, so only `status` was lost').toBe(true)

    // And a second generation over that directory is REFUSED, because the
    // status-less document fails the domain's own schema.
    const reopened = await mountStorage(root)
    const second = new EffectLedger(reopened)
    let refusal: unknown
    try {
      await second.open()
    } catch (error) {
      refusal = error
    }
    await reopened.fiber.dispose()
    expect(refusal, 'a status-less effect record must be refused at open').toBeDefined()
    expect(String((refusal as { message?: string }).message)).toMatch(/does not match its schema/)
  })

  it('with the CORRECTED fixture the ledger opens and reconciles from the remote, never re-sending', async () => {
    const root = makeTempDir('t9b-corrected')
    const ctx = await mountStorage(root)
    const ledger = new EffectLedger(ctx)
    await ledger.open()
    const remote = countingRemote()
    const intent: EffectIntent = { kind: 't9b-remote', logicalKey: 'run-t9b/task-1/send', parameters: { b: 1 } }

    const performed = await ledger.perform(remote.adapter, intent)
    expect(performed.performed).toBe(true)
    expect(performed.outcome).toBe('confirmed')
    expect(performed.resultRef).toBe('remote-1')
    expect(remote.performCount()).toBe(1)
    await ledger.close()
    await ctx.fiber.dispose()

    // A NEW ledger over the same store reconciles from the durable record, and
    // the transport is not invoked again.
    const reopened = await mountStorage(root)
    const second = new EffectLedger(reopened)
    await second.open()
    try {
      const reconciled = await second.reconcile(remote.adapter, intent)
      expect(reconciled.performed).toBe(false)
      expect(reconciled.outcome).toBe('confirmed')
      expect(remote.performCount(), 'the transport was invoked once, by the original call').toBe(1)
      // The stored record HAS a status key, which is the whole difference.
      const stored = second.get(identify(intent).operationId)
      expect(stored?.status).toBe('confirmed')
    } finally {
      await second.close()
      await reopened.fiber.dispose()
    }
  })

  it('when the effect store IS inside the rewound tree, the local knowledge is SILENTLY GONE', async () => {
    // The real rewind consequence, and the one a rollback procedure must be
    // written against. A pre-upgrade snapshot is taken, the effect runs and is
    // recorded, then the tree is rewound to the snapshot.
    const live = makeTempDir('t9b-rewind-live')
    const snapshot = makeTempDir('t9b-rewind-snapshot')

    // The snapshot is taken while the store is QUIESCENT, which is what makes it
    // a consistent snapshot rather than a copy of a live database.
    const empty = await mountStorage(live)
    const emptyLedger = new EffectLedger(empty)
    await emptyLedger.open()
    await emptyLedger.close()
    await empty.fiber.dispose()
    cpSync(live, snapshot, { recursive: true })

    // The new version runs and performs an effect that the WORLD commits.
    const remote = countingRemote()
    const intent: EffectIntent = { kind: 't9b-remote', logicalKey: 'run-t9b/task-2/send', parameters: { b: 2 } }
    const before = await mountStorage(live)
    const ledger = new EffectLedger(before)
    await ledger.open()
    const performed = await ledger.perform(remote.adapter, intent)
    expect(performed.outcome).toBe('confirmed')
    expect(ledger.listOperationIds()).toHaveLength(1)
    await ledger.close()
    await before.fiber.dispose()

    // THE REWIND: the state is restored from the pre-upgrade snapshot.
    rmSync(live, { recursive: true, force: true })
    cpSync(snapshot, live, { recursive: true })

    const after = await mountStorage(live)
    const rewound = new EffectLedger(after)
    // NOT a refusal: the snapshot is a valid, schema-conforming store, it simply
    // does not contain the effect.
    await rewound.open()
    try {
      expect(rewound.listOperationIds(), 'the rewound ledger opens CLEANLY with ZERO operations').toEqual([])
      // The reconciliation cannot be driven from the local ledger at all, because
      // the ledger no longer knows the operation existed.
      expect(rewound.get(identify(intent).operationId)).toBeUndefined()
      // And the WORLD still remembers it, which is the asymmetry: rolling back
      // software is not rolling back the world.
      const identity = identify(intent)
      const queried = await remote.adapter.query(identity.operationId)
      expect(queried.status).toBe('confirmed')
      expect(remote.performCount(), 'the effect is not re-sent by the reconciliation').toBe(1)
    } finally {
      await rewound.close()
      await after.fiber.dispose()
    }
  })

  // -------------------------------------------------------------------------
  // DELIVERABLE 2: unknown effects must never be auto-replayed
  // -------------------------------------------------------------------------

  it('a lost reply that MAY have committed is reconciled by QUERY, and the transport is never invoked twice', async () => {
    // THE HARD CONSTRAINT, measured at the ledger. The scenario is the dangerous
    // one: the remote DID commit and the reply was lost, so a replay would
    // duplicate a real external effect. `perform` is called repeatedly, which is
    // what an automatic replay would look like from outside.
    const root = makeTempDir('t9b-unknown')
    const ctx = await mountStorage(root)
    const ledger = new EffectLedger(ctx)
    await ledger.open()
    try {
      let sends = 0
      let queries = 0
      const committed = new Set<string>()
      const lossy = {
        kind: 't9b-lossy',
        capabilities: { idempotencyKey: true, queryable: true },
        async perform(_intent: EffectIntent, identity: { readonly operationId: string }) {
          sends += 1
          // The commit lands, THEN the reply is lost. This is the "timed out but
          // possibly committed" shape: from the caller's side it is a throw.
          committed.add(identity.operationId)
          throw new Error('the reply was lost after the remote committed')
        },
        async query(operationId: string) {
          queries += 1
          return committed.has(operationId)
            ? { status: 'confirmed' as const, resultRef: 'remote-committed' }
            : { status: 'not_started' as const, detail: 'the remote has no record' }
        },
      }
      const intent: EffectIntent = { kind: 't9b-lossy', logicalKey: 'run-t9b/lost-reply', parameters: { b: 3 } }

      const first = await ledger.perform(lossy as never, intent)
      expect(first.performed, 'the first call did invoke the transport').toBe(true)
      expect(first.outcome, 'a thrown call is not proof the remote did nothing').toBe('unknown')
      expect(sends).toBe(1)
      const recorded = ledger.get(identify(intent).operationId)
      expect(recorded?.status, 'the record rests at unknown, not at a retry-triggering state').toBe('unknown')

      // The second call is the replay opportunity. It must RECONCILE, and the
      // measurement is the transport invocation count, not the return value.
      const second = await ledger.perform(lossy as never, intent)
      expect(second.performed, 'the second call did NOT invoke the transport').toBe(false)
      expect(second.outcome, 'and it established the truth from the remote instead').toBe('confirmed')
      expect(sends, 'THE CONSTRAINT: exactly one transport invocation across both calls').toBe(1)
      expect(queries, 'the resolution came from a query').toBe(1)

      // A third call, and a bare reconcile, both stay at one send. The count is
      // asserted after each so a regression cannot hide behind a later one.
      await ledger.perform(lossy as never, intent)
      expect(sends).toBe(1)
      const bare = await ledger.reconcile(lossy as never, intent)
      expect(bare.performed, 'reconcile has no code path to the transport at all').toBe(false)
      expect(bare.outcome).toBe('confirmed')
      expect(sends, 'and still exactly one invocation in total').toBe(1)
    } finally {
      await ledger.close()
      await ctx.fiber.dispose()
    }
  })

  it('the send decision table licenses a send from exactly two states, and BOTH are proofs about our own write order', () => {
    // Exhaustive over the closed status vocabulary, so this cannot be satisfied by
    // testing only the interesting rows. The two send-licensing states are the
    // only ones that assert something about OUR OWN action rather than about the
    // remote: `absent` (nothing was ever recorded) and `intent_recorded` (the
    // `sent` marker is written BEFORE the transport call, so its absence proves
    // the call was never made).
    const licensed = EFFECT_RECORD_STATUSES.filter(status => sendDecision(status).send)
    expect(licensed, 'exactly one recorded status licenses a send').toEqual(['intent_recorded'])
    expect(sendDecision('absent').send, 'and the absent case does too').toBe(true)

    // The rows that matter for the constraint: every state that COULD already
    // have reached the remote refuses. `not_started` is the subtle one and it
    // refuses deliberately — even a positive remote statement that nothing
    // happened is not a licence, because resending is a new authorization.
    for (const status of ['sent', 'unknown', 'confirmed', 'not_started'] as const) {
      const decision = sendDecision(status)
      expect(decision.send, `"${status}" must NOT license an automatic send`).toBe(false)
      expect(decision.reason.length, `"${status}" must say why, in words a reader can check`).toBeGreaterThan(20)
    }
    // The reason for `unknown` names the guess, which is the actual defect being
    // prevented: a resend would be a bet on whether the first one landed.
    expect(sendDecision('unknown').reason).toMatch(/a resend would be a guess/u)
  })

  it('an adapter that can be neither keyed nor queried is NOT RUN AT ALL, rather than run and left unknown', async () => {
    // The strongest form of the constraint. An adapter with no idempotency key and
    // no queryable result cannot be reconciled after a lost reply, so the module
    // refuses to invoke it in the first place. The measurement is that the
    // transport was invoked ZERO times, and that the record says `unknown` rather
    // than a clean failure a caller might retry.
    const root = makeTempDir('t9b-unreconcilable')
    const ctx = await mountStorage(root)
    const ledger = new EffectLedger(ctx)
    await ledger.open()
    try {
      let invocations = 0
      const unreconcilable = {
        kind: 't9b-unreconcilable',
        capabilities: { idempotencyKey: false, queryable: false },
        async perform() {
          invocations += 1
          return { status: 'confirmed' as const, resultRef: 'x' }
        },
        async query(): Promise<never> {
          throw new Error('not queryable')
        },
      }
      const intent: EffectIntent = { kind: 't9b-unreconcilable', logicalKey: 'run-t9b/unreconcilable', parameters: { b: 4 } }
      const attempt = await ledger.perform(unreconcilable as never, intent)
      expect(attempt.performed, 'nothing was performed').toBe(false)
      expect(invocations, 'THE MEASUREMENT: the transport was never invoked').toBe(0)
      expect(attempt.outcome, 'and the honest answer is unknown, not a clean failure').toBe('unknown')
      expect(attempt.reason).toMatch(/not run automatically/u)
      // Recorded as `unknown` so a later reconcile sees it. NOT as a failure,
      // which is the distinction that stops a caller retrying it.
      expect(ledger.get(identify(intent).operationId)?.status).toBe('unknown')
    } finally {
      await ledger.close()
      await ctx.fiber.dispose()
    }
  })

  it('the PRODUCT path does not replay either: a launch that may have succeeded is quarantined, and a second drain refuses', async () => {
    // The same constraint at the reachable layer. `EffectLedger` has no production
    // importer (see T9-A), so the constraint must also be measured on the path the
    // product actually runs: `WorkService.drain`, which is what the `work` tool's
    // `submit` action calls. The launch port here throws AFTER the request was
    // written, so the child may exist — the exact case where a blind retry
    // double-launches.
    const root = makeTempDir('t9b-product-unknown')
    const { ctx, service } = await openService(root)
    try {
      const runId = 'run-t9b-product-unknown'
      await service.createRun({
        runId,
        root: { session: { header: { id: 'root-t9b-product-unknown' } } } as never,
        authorizationRef: 'auth',
      })
      let launches = 0
      service.setLaunchPort({
        async launch() {
          launches += 1
          throw new Error('the launch timed out after the request was written')
        },
      })
      const request = { taskId: 't1', childId: 'c1', prompt: 'p', reservedCost: 7 }
      const first = await service.drain(runId, [request], new AbortController().signal)
      expect(first[0]?.accepted).toBe(false)
      expect(first[0]?.reason, 'reported as unknown, not as a clean failure').toBe('launch_failed_unknown')
      expect(launches, 'the first drain did attempt the launch').toBe(1)

      const quarantined = service.getRun(runId)
      expect(quarantined?.tasks['t1']?.state, 'the task is QUARANTINED, not failed').toBe('unknown')
      expect(quarantined?.tasks['t1']?.uncertainty).toMatch(/timed out/u)
      expect(quarantined?.budget.reserved, 'and the reservation is HELD, because the child may exist').toBe(7)
      expect(quarantined?.terminalTombstones, 'no tombstone was written, so the task is not closed').toEqual([])

      // THE REPLAY OPPORTUNITY: the same request, drained again. A system that
      // retried an unknown outcome would call the port a second time here.
      const second = await service.drain(runId, [request], new AbortController().signal)
      expect(second[0]?.accepted).toBe(false)
      expect(second[0]?.reason, 'the refusal names the quarantined state').toMatch(/already admitted as unknown/u)
      expect(launches, 'THE CONSTRAINT: the product did NOT replay the launch').toBe(1)

      // And the state is still exactly what it was: a refused replay does not
      // clear the quarantine or release the reservation.
      const after = service.getRun(runId)
      expect(after?.tasks['t1']?.state).toBe('unknown')
      expect(after?.budget.reserved).toBe(7)
    } finally {
      await service.close()
      await ctx.fiber.dispose()
    }
  })

  // -------------------------------------------------------------------------
  // DELIVERABLE 3: attempt_status and effect_status are SEPARATE
  // -------------------------------------------------------------------------

  it('a FAILED ATTEMPT does not imply the effect did not happen — the two statuses are recorded separately', async () => {
    // The conflation this guards against: treating "the call failed" as "the
    // effect did not happen". The scenario makes them provably different — the
    // remote COMMITTED and the call still threw — so any code that derived one
    // from the other would be wrong here and right nowhere that matters.
    const root = makeTempDir('t9b-separate-status')
    const ctx = await mountStorage(root)
    const ledger = new EffectLedger(ctx)
    await ledger.open()
    try {
      const committed = new Set<string>()
      const lossy = {
        kind: 't9b-separate',
        capabilities: { idempotencyKey: true, queryable: true },
        async perform(_intent: EffectIntent, identity: { readonly operationId: string }) {
          committed.add(identity.operationId)
          throw new Error('connection reset after the remote accepted the request')
        },
        async query(operationId: string) {
          return committed.has(operationId)
            ? { status: 'confirmed' as const, resultRef: 'the-effect-really-happened' }
            : { status: 'not_started' as const, detail: 'no record' }
        },
      }
      const intent: EffectIntent = { kind: 't9b-separate', logicalKey: 'run-t9b/separate-status', parameters: { b: 5 } }
      const attempt = await ledger.perform(lossy as never, intent)

      // ATTEMPT status: the call failed. That is a fact about the CALL.
      expect(attempt.performed, 'the attempt did happen').toBe(true)
      expect(attempt.outcome, 'and the attempt did not establish an outcome').toBe('unknown')

      // EFFECT status: the effect COMMITTED. That is a fact about the WORLD, and
      // it is not derivable from the attempt status above. Only a query
      // establishes it, which is why the query exists.
      const reconciled = await ledger.reconcile(lossy as never, intent)
      expect(reconciled.outcome, 'THE SEPARATION: the failed attempt had in fact committed').toBe('confirmed')
      expect(reconciled.resultRef).toBe('the-effect-really-happened')
      expect(reconciled.performed, 'and establishing it required no second invocation').toBe(false)
      // The record carries the EFFECT status, which is the one that governs any
      // later decision. `attempts` records that one transport call was made,
      // which is the separate fact the record keeps alongside it.
      const record = ledger.get(identify(intent).operationId)
      expect(record?.status, 'the stored status is the effect status').toBe('confirmed')
      expect(record?.attempts, 'and the attempt count is kept as its own field').toBe(1)
    } finally {
      await ledger.close()
      await ctx.fiber.dispose()
    }
  })

  it('no `safe_to_retry` predicate exists, and the nearest predicate refuses rather than permits', () => {
    // The task asked whether `safe_to_retry` is computed as "idempotent AND the
    // effect definitively did not happen" and ONLY that. The measurement is that
    // NO SUCH PREDICATE EXISTS anywhere in this repository, so the question of
    // whether it is computed correctly does not yet arise — there is nothing to
    // get wrong, and also nothing that can refuse on a caller's behalf.
    //
    // WHAT IS SEARCHED FOR IS A DEFINITION, not the string. Two earlier versions
    // of this test were wrong in instructive ways and both are recorded here
    // because the mistake is easy to repeat:
    //   - v1 matched the bare string and found itself in this very test file;
    //   - v2 excluded `*.test.ts`, which fixed that and then found this run's own
    //     `GATES.md`, which discusses the predicate by name in prose.
    // A prose mention computes nothing. The honest question is whether a
    // PREDICATE is defined, so the pattern requires definition syntax, and the
    // sanity check below proves the pattern is capable of matching a real
    // definition — without it, this would pass for the wrong reason.
    const definition = /(?:function\s+safe_?to_?retry|(?:const|let|var)\s+safe_?to_?retry|safe_?to_?retry\s*[:=])/iu
    expect(definition.test('export function safeToRetry(x) { return x }'), 'the pattern must match a function definition').toBe(true)
    expect(definition.test('const safe_to_retry = true'), 'and a const definition').toBe(true)
    expect(definition.test('safeToRetry: false'), 'and an object-literal member').toBe(true)
    expect(definition.test('whether `safe_to_retry` is computed as …'), 'but NOT a prose mention').toBe(false)

    const repoRoot = join(import.meta.dirname, '..', '..', '..')
    const searchRoots = ['packages', 'docs', 'profiles', 'qualification'].map(name => join(repoRoot, name))
    const hits: string[] = []
    // THE ONE FILE THAT MUST BE SKIPPED, and why it is not a fudge. This file
    // contains the pattern above as a REGEX LITERAL, and that literal's own source
    // text contains the definition shapes the pattern matches — so a walk that
    // read this file would match itself no matter how the pattern is written. The
    // self-exclusion is therefore structural rather than a convenience, and the
    // `hits.length` assertion below still covers every other source file in the
    // repository, which is where a predicate would actually be defined.
    const selfFile = 'durability-advanced.test.ts'
    const walk = (dir: string, depth: number): void => {
      if (depth > 4 || !existsSync(dir)) return
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
        if (entry.name === selfFile) continue
        const full = join(dir, entry.name)
        if (entry.isDirectory()) {
          walk(full, depth + 1)
          continue
        }
        if (!/\.(?:ts|mjs|js)$/u.test(entry.name)) continue
        if (definition.test(readFileSync(full, 'utf8'))) hits.push(full.slice(repoRoot.length + 1))
      }
    }
    for (const dir of searchRoots) walk(dir, 0)
    expect(hits, 'no `safe_to_retry` predicate is DEFINED anywhere in the product').toEqual([])

    // The predicate that DOES exist is a refusal device, and the measurement is
    // that `unknown` — the classification that would tempt a caller to retry —
    // is refused.
    const effectsSource = readFileSync(join(import.meta.dirname, 'effects.ts'), 'utf8')
    expect(effectsSource, 'the module has a sanctioned-reading predicate').toMatch(/export function mayRunAutomatically/u)
    expect(effectsSource, 'and it passes ONLY a read_only verdict').toMatch(/return verdict\.classification === 'read_only'/u)
  })
})

// ---------------------------------------------------------------------------
// T9-C: FILESYSTEM gates FS-01..FS-06
// ---------------------------------------------------------------------------

/**
 * WHY THIS FAMILY IS DIFFERENT UNDER THE NO-SANDBOX ARCHITECTURE.
 *
 * In a trusted-local deployment the model writes Python that can mutate files
 * DIRECTLY (`open().write()`, `os.rename()`, `shutil`), bypassing the DSH `fs`
 * tool entirely. Those mutations are ENVIRONMENT CHANGES, not DSH fs receipts. So
 * FS-06 is the load-bearing gate of this family: the verifier must be able to
 * rediscover the final world from Git and the filesystem rather than trusting a
 * tool receipt, because in this architecture the receipt is not a complete
 * account of what happened.
 *
 * FS-01..FS-05 are properties of the `fs` provider the deployment actually
 * mounts, so they are measured against the REAL `@deepseek-ai/dsh-fs-local`
 * rather than a re-implementation. A re-implementation would prove only that the
 * re-implementation agrees with itself.
 */
describe('T9-C: FILESYSTEM gates FS-01..FS-06', () => {
  /** A real `LocalFileSystem` over a real directory. */
  function mountFs(cwd: string): { readonly ctx: Context; readonly fs: LocalFileSystem } {
    const ctx = new Context()
    // `diffBasisMaxBytes` is required by the backend's own config validation when
    // the config object is passed explicitly.
    const fs = new LocalFileSystem(ctx, { cwd, diffBasisMaxBytes: 10 * 1024 * 1024 })
    return { ctx, fs }
  }

  it('FS-01: a native write is published atomically, and a refused write leaves the original intact', async () => {
    // The property: a reader never observes a partial file. The mechanism is
    // stage-to-a-private-dir then rename, so the observable consequence is that
    // the target either has its old bytes or its new bytes and nothing between.
    const root = makeTempDir('t9c-fs01')
    const { ctx, fs } = mountFs(root)
    try {
      const target = await fs.resolve('out.txt')
      const created = await fs.writeText(target, 'first version\n')
      expect(created.operation).toBe('create')
      // A create has no before-side, which is what distinguishes it from an update.
      expect(created.before).toBeNull()

      const updated = await fs.writeText(target, 'second version\n')
      expect(updated.operation).toBe('update')
      expect(updated.before).toBe('first version\n')
      expect(updated.after).toBe('second version\n')
      // The version moved, so a stale guard built on the FIRST version can now
      // be shown to reject.
      expect(String(updated.version)).not.toBe(String(created.version))

      // The content on disk is the complete new content, never a prefix.
      expect(readFileSync(join(root, 'out.txt'), 'utf8')).toBe('second version\n')
      // And the staging residue is gone: publication removes its private dir, so
      // a successful write leaves no `.tmp` sibling behind.
      const siblings = readdirSync(root).filter(name => name !== 'out.txt')
      expect(siblings, 'a committed write leaves no staging residue').toEqual([])

      // The refusal path: an abort before publication must leave the ORIGINAL
      // bytes and no residue. This is the atomicity claim that matters most,
      // because a torn write is indistinguishable from a successful one.
      const controller = new AbortController()
      controller.abort()
      let aborted: unknown
      try {
        await fs.writeText(target, 'should never land\n', undefined, controller.signal)
      } catch (error) {
        aborted = error
      }
      expect((aborted as { code?: string }).code).toBe('FS_ABORTED')
      expect(readFileSync(join(root, 'out.txt'), 'utf8'), 'an aborted write must not touch the target').toBe('second version\n')
      expect(readdirSync(root).filter(name => name !== 'out.txt'), 'an aborted write leaves no residue').toEqual([])
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('FS-02: a stale version is REJECTED with a typed code, and a fresh one is accepted', async () => {
    // The guard's whole purpose: an edit or overwrite computed from an old read
    // must not silently clobber content it never saw. The code matters, because a
    // caller branches on it rather than parsing a message.
    const root = makeTempDir('t9c-fs02')
    const { ctx, fs } = mountFs(root)
    try {
      const target = await fs.resolve('guarded.txt')
      const created = await fs.writeText(target, 'v1\n')

      // Someone else moves the file on.
      await fs.writeText(target, 'v2 written by someone else\n')

      // A write guarded on the FIRST version is refused, not applied.
      let stale: unknown
      try {
        await fs.writeText(target, 'clobber\n', { kind: 'replaceIfVersion', version: created.version })
      } catch (error) {
        stale = error
      }
      expect((stale as { code?: string }).code).toBe('FS_STALE_VERSION')
      expect((stale as { message?: string }).message).toMatch(/file changed since it was read/)
      expect(readFileSync(join(root, 'guarded.txt'), 'utf8'), 'the refused write must not have landed').toBe('v2 written by someone else\n')

      // The POSITIVE control: the same guarded write with the CURRENT version is
      // accepted, so the refusal is a staleness check and not a blanket refusal.
      const current = await fs.stat(target)
      expect(current).toBeDefined()
      const accepted = await fs.writeText(
        target,
        'v3\n',
        { kind: 'replaceIfVersion', version: current?.version ?? created.version },
      )
      expect(accepted.operation).toBe('update')
      expect(readFileSync(join(root, 'guarded.txt'), 'utf8')).toBe('v3\n')

      // A create-if-absent onto an EXISTING file is refused with its own code, so
      // "already there" is distinguishable from "changed under you".
      let notObserved: unknown
      try {
        await fs.writeText(target, 'x\n', { kind: 'createIfAbsent' })
      } catch (error) {
        notObserved = error
      }
      expect((notObserved as { code?: string }).code).toBe('FS_NOT_OBSERVED')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('FS-03: concurrent same-target mutations are SERIALIZED — exactly one wins, the rest see the new version', async () => {
    // The claim is not "no interleaving is possible in theory" but a measured
    // outcome: the backend serializes per target key, so a read-guard-write
    // window cannot interleave and exactly one of N guarded writes succeeds.
    const root = makeTempDir('t9c-fs03')
    const { ctx, fs } = mountFs(root)
    try {
      const target = await fs.resolve('contended.txt')
      const created = await fs.writeText(target, 'base\n')

      // All five guard on the SAME observed version and start together.
      const results = await Promise.allSettled(
        Array.from({ length: 5 }, (_unused, index) =>
          fs.writeText(target, `writer-${String(index)}\n`, { kind: 'replaceIfVersion', version: created.version })),
      )
      const fulfilled = results.filter(result => result.status === 'fulfilled')
      const rejected = results.filter(result => result.status === 'rejected')
      expect(fulfilled, 'exactly one guarded write may win').toHaveLength(1)
      expect(rejected, 'the rest must be refused').toHaveLength(4)
      // Every refusal is the STALE code, not an IO error: the losers lost the
      // staleness race, which is the designed outcome.
      for (const result of rejected) {
        expect((result as PromiseRejectedResult).reason.code).toBe('FS_STALE_VERSION')
      }
      // And the file holds exactly one writer's content, complete.
      const finalText = readFileSync(join(root, 'contended.txt'), 'utf8')
      expect(finalText).toMatch(/^writer-[0-4]\n$/)

      // The same serialization protects the edit path's read->match->write
      // window: two concurrent unconditional edits must both apply, in some
      // order, with neither losing the other's change.
      const editTarget = await fs.resolve('edited.txt')
      await fs.writeText(editTarget, 'AAA\n')
      const edits = await Promise.all([
        fs.editText(editTarget, { oldString: 'AAA', newString: 'BBB', replaceAll: false }),
        fs.editText(editTarget, { oldString: 'BBB', newString: 'CCC', replaceAll: false }),
      ])
      expect(edits).toHaveLength(2)
      // Whichever order they ran in, the file is one of the two consistent
      // results — never a torn or partially-applied mix.
      expect(['BBB\n', 'CCC\n']).toContain(readFileSync(join(root, 'edited.txt'), 'utf8'))
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('FS-04: exact edit semantics are preserved — literal match, ambiguity refused, missing text reported', async () => {
    // The tool's value over a hand-written `open().write()` is precisely this:
    // literal replacement with an explicit ambiguity rule. If it silently picked
    // the first match, "edit" would mean "rewrite something near here".
    const root = makeTempDir('t9c-fs04')
    const { ctx, fs } = mountFs(root)
    try {
      const target = await fs.resolve('src.txt')
      await fs.writeText(target, 'alpha beta gamma\n')

      const applied = await fs.editText(target, { oldString: 'beta', newString: 'BETA', replaceAll: false })
      expect(applied.before).toBe('alpha beta gamma\n')
      expect(applied.after).toBe('alpha BETA gamma\n')
      expect(readFileSync(join(root, 'src.txt'), 'utf8')).toBe('alpha BETA gamma\n')

      // AMBIGUOUS: two matches with replaceAll false is refused rather than
      // silently choosing one.
      const ambiguousTarget = await fs.resolve('ambiguous.txt')
      await fs.writeText(ambiguousTarget, 'x x x\n')
      let ambiguous: unknown
      try {
        await fs.editText(ambiguousTarget, { oldString: 'x', newString: 'y', replaceAll: false })
      } catch (error) {
        ambiguous = error
      }
      expect((ambiguous as { code?: string }).code).toBe('FS_AMBIGUOUS_EDIT')
      expect(readFileSync(join(root, 'ambiguous.txt'), 'utf8'), 'a refused edit changes nothing').toBe('x x x\n')

      // replaceAll IS the explicit opt-in, and it replaces every occurrence.
      const all = await fs.editText(ambiguousTarget, { oldString: 'x', newString: 'y', replaceAll: true })
      expect(all.after).toBe('y y y\n')
      expect(readFileSync(join(root, 'ambiguous.txt'), 'utf8')).toBe('y y y\n')

      // NOT FOUND: the literal text is absent, which is its own code.
      let missing: unknown
      try {
        await fs.editText(target, { oldString: 'not present', newString: 'x', replaceAll: false })
      } catch (error) {
        missing = error
      }
      expect((missing as { code?: string }).code).toBe('FS_EDIT_NOT_FOUND')

      // An empty oldString is refused: replacing "" would be an insertion whose
      // position is undefined.
      let empty: unknown
      try {
        await fs.editText(target, { oldString: '', newString: 'x', replaceAll: false })
      } catch (error) {
        empty = error
      }
      expect(empty, 'an empty oldString must be refused').toBeDefined()
      expect((empty as { code?: string }).code).toBe('FS_EDIT_NOT_FOUND')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('FS-05: line endings are preserved through an edit, so a CRLF file stays CRLF', async () => {
    // A silent LF conversion rewrites every line of a file the model only meant
    // to touch once. That is a whole-file diff for a one-line change, and it is
    // the failure this gate exists to catch.
    const root = makeTempDir('t9c-fs05')
    const { ctx, fs } = mountFs(root)
    try {
      const crlfPath = join(root, 'crlf.txt')
      // Written as bytes so the fixture's line endings are unambiguous.
      writeFileSync(crlfPath, Buffer.from('one\r\ntwo\r\nthree\r\n', 'utf8'))
      const crlfTarget = await fs.resolve('crlf.txt')

      const edited = await fs.editText(crlfTarget, { oldString: 'two', newString: 'TWO', replaceAll: false })
      // The in-memory diff basis is LF-normalized, so a consumer comparing hunks
      // is not shown every line as changed.
      expect(edited.before).toBe('one\ntwo\nthree\n')
      expect(edited.after).toBe('one\nTWO\nthree\n')
      // But the STORAGE keeps CRLF, which is the property that matters.
      const onDisk = readFileSync(crlfPath, 'utf8')
      expect(onDisk, 'a CRLF file must stay CRLF').toBe('one\r\nTWO\r\nthree\r\n')
      expect(onDisk, 'no doubled carriage returns').not.toMatch(/\r\r/u)

      // The LF case is unchanged: an LF file stays LF and gains no CR.
      const lfPath = join(root, 'lf.txt')
      writeFileSync(lfPath, Buffer.from('a\nb\n', 'utf8'))
      const lfTarget = await fs.resolve('lf.txt')
      await fs.editText(lfTarget, { oldString: 'b', newString: 'B', replaceAll: false })
      expect(readFileSync(lfPath, 'utf8')).toBe('a\nB\n')

      // ── THE OVERWRITE PATH IS A DIFFERENT CONTRACT, and this case measured it
      // wrongly at first. The assertion that used to sit here was
      //
      //   expect(readFileSync(crlfPath,'utf8'), 'a write normalizes content to
      //     the file\'s own style').toBe('x\r\ny\r\nz\r\n')
      //
      // and it was FALSE, in a way worth recording because the two paths are easy
      // to conflate. `editText` restores the target's style because it makes a
      // PARTIAL change: it captures `original.lineEndings` and calls
      // `restoreLineEndings(edited.content, original.lineEndings)` before the
      // atomic write, precisely so a one-line edit is not a whole-file rewrite
      // (`packages/fs/fs-local/src/index.ts:253-255`, with the comment
      // "line-ending restoration is a storage detail the diff ignores").
      // `writeText` does NOT do this and is not supposed to: it is a FULL
      // replacement in which the caller has stated the complete content, so the
      // bytes written are the bytes given, and `normalizeLineEndings` is applied
      // only to the returned `after` diff basis (`:224-227`). Restoring a style
      // the caller did not ask for would make `write` unable to produce an LF
      // file from a CRLF one at all.
      //
      // MEASURED, both directions, against the real backend (probe:
      // `.probe-t2/crlf-probe.mjs`, recorded in
      // `qualification/results/T2-fs/FINDINGS.md`): LF content onto a CRLF file
      // leaves LF on disk; CRLF content onto a CRLF file leaves CRLF on disk.
      // The contract is content-faithful, and the style-preserving behaviour
      // belongs to `edit` alone.
      //
      // The original fear behind the wrong assertion is real and is kept: a
      // whole-file rewrite of a CRLF file IS what you get from `write`, which is
      // why the tool layer must use `edit` for a surgical change. The assertion
      // below pins that split rather than denying it.
      const overwritten = await fs.writeText(crlfTarget, 'x\ny\nz\n')
      expect(overwritten.after, 'the diff basis is LF-normalized').toBe('x\ny\nz\n')
      expect(
        readFileSync(crlfPath, 'utf8'),
        'write is a FULL replacement: it writes the content it was given, and does not restore the target\'s style',
      ).toBe('x\ny\nz\n')

      // The control that makes the line above a contract rather than a quirk:
      // CRLF content given to `write` lands as CRLF. So the write path is
      // content-faithful in BOTH directions, and the earlier LF result was the
      // caller's content and not a hidden normalizer.
      const crlfAgain = await fs.writeText(crlfTarget, 'p\r\nq\r\n')
      expect(
        readFileSync(crlfPath, 'utf8'),
        'CRLF content written by `write` lands as CRLF: the path is content-faithful, not LF-only',
      ).toBe('p\r\nq\r\n')
      // And `after` is still LF-normalized even when the bytes on disk are CRLF,
      // so a hunk consumer sees only the genuinely changed lines.
      expect(crlfAgain.after, 'the diff basis is LF-normalized regardless of the bytes written').toBe('p\nq\n')

      // The two paths, side by side on the SAME file, so the difference is the
      // measurement rather than an inference: `write` imposes the caller's
      // content, then `edit` preserves what is on disk.
      const restyled = await fs.writeText(crlfTarget, 'm\r\nn\r\n')
      expect(restyled.operation).toBe('update')
      await fs.editText(crlfTarget, { oldString: 'n', newString: 'N', replaceAll: false })
      expect(
        readFileSync(crlfPath, 'utf8'),
        'an edit after a CRLF write preserves CRLF, because edit restores the style it read',
      ).toBe('m\r\nN\r\n')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('FS-06: a RAW PYTHON mutation is visible to the verifier from the world, not from a DSH receipt', async () => {
    // THE LOAD-BEARING GATE OF THIS FAMILY under the no-sandbox architecture.
    //
    // In a trusted-local deployment the model writes Python that mutates files
    // directly. Those mutations produce NO DSH fs outcome — no `operation`, no
    // `version`, no `before`/`after` — so a verifier that trusted the tool
    // receipt would certify a tree it never looked at. The verifier must be able
    // to rediscover the final world from Git and the filesystem.
    //
    // The measurement is a real `python.exe` process, run the way the IPython
    // surface runs one: same OS user, full authority, no DSH tools involved.
    const root = makeTempDir('t9c-fs06')
    const { ctx, fs } = mountFs(root)
    try {
      // A real repository, so "visible to Git" is a real answer rather than an
      // inference from mtimes.
      const git = (...args: readonly string[]): string =>
        execFileSync('git', [...args], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
      git('init', '--quiet')
      git('config', 'user.email', 't9@example.invalid')
      git('config', 'user.name', 'T9')
      writeFileSync(join(root, 'tracked.txt'), 'original tracked content\n')
      git('add', 'tracked.txt')
      git('commit', '--quiet', '-m', 'baseline')
      const baselineHead = git('rev-parse', 'HEAD').trim()

      // (1) A mutation through the DSH fs TOOL. It produces a receipt: the
      // outcome names the operation, the version and the before/after basis.
      const toolTarget = await fs.resolve('tracked.txt')
      const toolWrite = await fs.writeText(toolTarget, 'written through the dsh fs tool\n')
      expect(toolWrite.operation).toBe('update')
      expect(toolWrite.before).toBe('original tracked content\n')
      // The tool's own stat agrees with the version its write returned, so a
      // receipt-based verifier would see a consistent story here.
      const afterTool = await fs.stat(toolTarget)
      expect(String(afterTool?.version)).toBe(String(toolWrite.version))

      // (2) A mutation through RAW PYTHON, bypassing the tool entirely. This is
      // the architecture's normal case, and it produces NO DSH outcome at all.
      //
      // `newline=''` IS PART OF THE FIXTURE, and its absence was a real defect in
      // this case rather than a detail. `Path.write_text` opens in TEXT mode, so
      // CPython translates every `\n` to the platform line separator: on this
      // Windows host a script that writes `"...tool\n"` produces the bytes
      // `...tool\r\n` (MEASURED: `write_text('x\n')` yields `b'x\r\n'` with the
      // default, `b'x\n'` with `newline=''`). The assertions below compare the
      // file to the exact LF string, so without this the case was measuring the
      // HOST'S TEXT-MODE TRANSLATION rather than whether the mutation is visible —
      // and it failed for that reason, not because anything was invisible.
      //
      // `newline=''` makes the fixture's bytes the ones the script states. It does
      // NOT weaken the gate: the mutation still bypasses DSH entirely, still
      // produces no fs receipt, and is still asserted to be visible from the
      // world. It removes an accidental platform coupling, which is the honest
      // fix — the alternative, normalizing the comparison, would have left the
      // fixture's bytes unknown and the assertion unable to say what it read.
      const python = 'C:/Users/hzq00/AppData/Local/Programs/Python/Python314/python.exe'
      const script = [
        "import os, pathlib",
        `root = pathlib.Path(${JSON.stringify(root.replace(/\\/g, '/'))})`,
        // A direct overwrite of a tracked file...
        "(root / 'tracked.txt').write_text('mutated by raw python, no dsh tool\\n', encoding='utf-8', newline='')",
        // ...and a brand-new file the tool never heard of.
        "(root / 'raw-only.txt').write_text('created by raw python\\n', encoding='utf-8', newline='')",
        // ...and a rename, which is the mutation class a write-only tool cannot see.
        "os.rename(root / 'raw-only.txt', root / 'raw-renamed.txt')",
        "print('PYTHON-MUTATED')",
      ].join('\n')
      const pythonOut = execFileSync(python, ['-c', script], { encoding: 'utf8' })
      expect(pythonOut).toContain('PYTHON-MUTATED')

      // THE FINDING, in three measurements.
      //
      // (a) The DSH fs receipt is now WRONG about the world. The tool's recorded
      // version no longer matches the file, so a verifier that trusted the
      // receipt would report the tool's content as current.
      const afterPython = await fs.stat(toolTarget)
      expect(afterPython, 'the target still exists').toBeDefined()
      expect(
        String(afterPython?.version),
        'the version the tool recorded is NOT the version of the file on disk',
      ).not.toBe(String(toolWrite.version))
      expect(readFileSync(join(root, 'tracked.txt'), 'utf8')).toBe('mutated by raw python, no dsh tool\n')
      // And the tool has NO knowledge of the file Python created: it cannot be
      // enumerated from any fs outcome, only from the directory.
      expect(existsSync(join(root, 'raw-only.txt')), 'the rename really happened').toBe(false)
      expect(existsSync(join(root, 'raw-renamed.txt')), 'the raw creation is on disk').toBe(true)

      // (b) GIT sees both mutations. This is what makes the verifier able to
      // rediscover the world rather than trust a receipt: the repository is an
      // independent witness of the same tree.
      const status = git('status', '--porcelain')
      expect(status, 'git sees the tracked file as modified').toMatch(/^ M tracked\.txt$/mu)
      expect(status, 'git sees the raw-created file as untracked').toMatch(/^\?\? raw-renamed\.txt$/mu)
      expect(git('rev-parse', 'HEAD').trim(), 'nothing was committed by the mutation').toBe(baselineHead)
      // The worktree diff names the raw mutation's actual content, which is what
      // a verifier would judge.
      const diff = git('diff', '--no-color', 'tracked.txt')
      expect(diff).toContain('+mutated by raw python, no dsh tool')
      expect(diff).toContain('-original tracked content')

      // (c) The VERIFIER's own read of the world — an independent re-read plus a
      // content digest — reproduces the raw mutation without consulting any DSH
      // receipt. This is the property FS-06 asks for.
      const verifierBytes = readFileSync(join(root, 'tracked.txt'))
      const verifierDigest = createHash('sha256').update(verifierBytes).digest('hex')
      const independentDigest = createHash('sha256').update('mutated by raw python, no dsh tool\n').digest('hex')
      expect(verifierDigest, 'the verifier recomputes the digest from the WORLD').toBe(independentDigest)

      // And the receipt-vs-world distinction is not merely philosophical: a
      // guarded write built on the tool's STALE receipt is refused, which is how
      // the system refuses to act as if the receipt were current.
      let stale: unknown
      try {
        await fs.writeText(toolTarget, 'based on the stale receipt\n', { kind: 'replaceIfVersion', version: toolWrite.version })
      } catch (error) {
        stale = error
      }
      expect((stale as { code?: string }).code).toBe('FS_STALE_VERSION')
      expect(readFileSync(join(root, 'tracked.txt'), 'utf8'), 'the refused write left the raw mutation in place').toBe('mutated by raw python, no dsh tool\n')
    } finally {
      await ctx.fiber.dispose()
    }
  }, 120_000)
})
