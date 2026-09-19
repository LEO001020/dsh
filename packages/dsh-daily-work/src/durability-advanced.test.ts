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
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { EffectLedger, identify, type EffectIntent } from './effects.ts'
import { WorkService } from './host.ts'
import { applyWorkerSettlement, RefusalLedger } from './recovery.ts'
import { reconcileTask } from './reconcile.ts'

/** This file's directory, resolved from the module URL rather than from cwd. */
const HERE = dirname(fileURLToPath(import.meta.url))

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
    // package's node_modules, which is where the DSH junctions live.
    { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env } },
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
    // package's node_modules, which is where the DSH junctions live.
    { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env } },
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
// T9-A: the epoch guard — is it wireable, and what does its absence cost?
// ---------------------------------------------------------------------------

/**
 * THE FINDING THIS SECTION EXISTS TO SETTLE.
 *
 * `docs/GAPS.md` G-SEAM-21 records that `recovery.ts`'s epoch guard is
 * unreachable from production. A previous agent concluded that wiring it would
 * "invent a caller rather than connect a real one". That conclusion is tested
 * here rather than inherited, because the tree has changed since: a production
 * launch port now exists, `createRun` binds it, and `subagent/end` is emitted by
 * the real subagent registry with the child's `SessionId` — which IS the
 * reserved `childId` the record stores.
 *
 * The answer is that the conclusion still holds, but for a sharper reason than
 * "there is no event": there IS a real event carrying a real child identity, and
 * there is STILL no settlement that could ever be stale, because the epoch is
 * never bumped. Wiring the guard to `subagent/end` today would produce a
 * reachable guard whose precondition cannot occur — the same defect class
 * (`mechanism implemented, unit-tested, correct, while the product reaches
 * nothing that matters`) in a new and harder-to-see form. That is worse than
 * leaving it unreachable, because it would read as closed.
 *
 * WHAT IS MEASURED, and it is the damage the field exists to prevent:
 *   1. The reachability claim, re-derived from the tree rather than cited.
 *   2. That the epoch is never bumped — across a REAL SIGKILL and a real
 *      re-adoption, the record still reads epoch 1.
 *   3. That WITHOUT the guard, a settlement from the previous generation IS
 *      APPLIED by the production `transition` path: the task moves to a terminal
 *      state and its reservation is RELEASED, so budget authority is exercised
 *      by a generation that never admitted the work.
 *   4. That WITH the guard, the same settlement is refused and retained — so the
 *      guard is correct and the gap is purely reachability.
 */
describe('T9-A: the epoch guard (G-SEAM-21) — unreachable, and what that costs', () => {
  it('the guard has no production importer and the epoch has no production writer', () => {
    // Re-derived here from the SOURCE TREE, by name, so this finding cannot rot
    // into a citation of a document that may itself go stale.
    const src = join(import.meta.dirname)
    const production = readdirSync(src).filter(name => name.endsWith('.ts') && !name.endsWith('.test.ts'))

    const importers: string[] = []
    const epochWriters: string[] = []
    for (const file of production) {
      if (file === 'recovery.ts') continue
      const text = readFileSync(join(src, file), 'utf8')
      if (/from\s+'\.\/recovery\.ts'/u.test(text)) importers.push(file)
      // A WRITE of the field, not a mention in a comment. `epoch: 1` in the
      // initialiser and a zod declaration are both declarations; only an
      // assignment inside a mutation would be a bump.
      const code = text.split(/\r?\n/u).filter(line => !/^\s*(?:\/\/|\*|\/\*)/u.test(line)).join('\n')
      if (/\bepoch\s*:/u.test(code) || /\bepoch\s*=/u.test(code)) epochWriters.push(file)
    }
    // THE FINDING, re-measured. `recovery.ts` is imported by no production module.
    expect(importers, 'recovery.ts must have no production importer').toEqual([])
    // And the only production file that even mentions the field in code is the
    // schema/initialiser in `record.ts` — no bump exists anywhere.
    expect(epochWriters, 'no production module may WRITE the epoch').toEqual(['record.ts'])
    const record = readFileSync(join(src, 'record.ts'), 'utf8')
    expect(record, 'the sole writer is the schema declaration').toMatch(/epoch: z\.number\(\)\.int\(\)\.min\(1\)/u)
    expect(record, 'and the sole value ever written is the literal 1').toMatch(/epoch: 1,/u)
    // There is no `resume`-time bump either, which is the second half of the
    // double unreachability: the guard's precondition cannot occur.
    const host = readFileSync(join(src, 'host.ts'), 'utf8')
    const resume = /async resume\(runId: string, now = new Date\(\)\.toISOString\(\)\): Promise<RunRecord> \{([\s\S]*?)\n  \}/u.exec(host)
    expect(resume, 'the production resume path must be locatable').not.toBeNull()
    expect(resume?.[1], 'resume must not bump the epoch').not.toMatch(/epoch/u)
  })

  it('a REAL SIGKILL and a real re-adoption do NOT bump the epoch, so no settlement can be stale', { timeout: 180_000 }, async () => {
    // The window the field promises to handle: host A admits work and launches a
    // child, host A dies, host B re-adopts the run. If the epoch were bumped on
    // re-adoption, a settlement from A's child would carry a stale value. It is
    // not bumped, so it cannot.
    const root = makeTempDir('t9a-epoch')
    const childSource = `
import { Context } from 'file:///D:/DSH/src/dsh-src/vendor/cordis/lib/index.js'
import Storage from 'file:///D:/DSH/src/dsh-src/packages/storage/storage/lib/index.js'
import * as storageDomainPlugin from 'file:///D:/DSH/src/dsh-src/packages/storage/storage-domain/lib/index.js'
import * as storageJsonPlugin from 'file:///D:/DSH/src/dsh-src/packages/storage/storage-json/lib/index.js'
import { WorkService } from 'file:///${HERE.replace(/\\/g, '/')}/host.ts'
import { writeFileSync } from 'node:fs'

const [,, storeDir, reportPath] = process.argv
const ctx = new Context()
await ctx.plugin(Storage, {})
await ctx.plugin(storageJsonPlugin, { root: storeDir })
await ctx.plugin(storageDomainPlugin, { backend: 'json' })
const service = new WorkService(ctx, { targetChildren: 10, maxDepth: 1, budgetCeiling: 1000, currency: 'USD', priceVersion: 't9a' })
await service.open()
await service.createRun({ runId: 'run-t9a', root: { session: { header: { id: 'root-t9a' } } }, authorizationRef: 'auth-t9a' })
await service.admit({ runId: 'run-t9a', taskId: 't1', childId: 'child-t9a', assignmentDigest: 'digest-t9a', reservedCost: 7, allowedCapabilities: ['reader'] })
await service.transition({ runId: 'run-t9a', taskId: 't1', to: 'launching' })
await service.transition({ runId: 'run-t9a', taskId: 't1', to: 'accepted' })
const belief = service.getRun('run-t9a')
writeFileSync(reportPath, JSON.stringify({ ready: true, epoch: belief.epoch, state: belief.tasks.t1.state, reserved: belief.budget.reserved }))
setInterval(() => {}, 3600000)
await new Promise(() => {})
`
    const killed = await forkKillChild(childSource, [root])
    // The kill was real and abrupt, so no cleanup ran.
    expect(killed.exit.signal).toBe('SIGKILL')
    // The generation that admitted the work was at epoch 1.
    expect(killed.report['epoch']).toBe(1)
    expect(killed.report['state']).toBe('accepted')
    expect(killed.report['reserved']).toBe(7)

    // Host B: a NEW service over the SAME store. This is a re-adoption.
    const { ctx, service } = await openService(root)
    try {
      const adopted = service.getRun('run-t9a')
      expect(adopted, 'the run must survive').toBeDefined()
      // THE MEASUREMENT: the re-adopting generation reads the SAME epoch. Nothing
      // bumped it, so "a settlement from a previous host generation" is a value
      // no code in this package can produce.
      expect(adopted?.epoch, 're-adoption must NOT bump the epoch — this is the second half of G-SEAM-21').toBe(1)
      // The production resume path re-opens the phase and leaves the epoch alone.
      await service.pause('run-t9a', 'recovered after a host restart')
      const resumed = await service.resume('run-t9a')
      expect(resumed.phase).toBe('open')
      expect(resumed.epoch, 'resume must not bump the epoch').toBe(1)
    } finally {
      await service.close()
      await ctx.fiber.dispose()
    }
  })

  it('WITHOUT the guard, a previous generation\'s settlement IS applied and RELEASES the reservation', { timeout: 120_000 }, async () => {
    // The concrete damage, measured through the PRODUCTION transition path — the
    // same method `runDrain` uses. This is what the field exists to prevent and
    // what its inertness actually costs.
    const root = makeTempDir('t9a-damage')
    const first = await openService(root)
    const runId = 'run-t9a-damage'
    await first.service.createRun({
      runId,
      root: { session: { header: { id: 'root-t9a-damage' } } } as never,
      authorizationRef: 'auth',
    })
    await first.service.admit({
      runId,
      taskId: 't1',
      childId: 'child-t9a-damage',
      assignmentDigest: 'd',
      reservedCost: 7,
      allowedCapabilities: ['reader'],
    })
    await first.service.transition({ runId, taskId: 't1', to: 'launching' })
    await first.service.transition({ runId, taskId: 't1', to: 'accepted' })
    // Generation A ends. Generation B re-adopts the same durable store.
    await first.service.close()
    await first.ctx.fiber.dispose()

    const second = await openService(root)
    try {
      const before = second.service.getRun(runId)
      expect(before?.budget.reserved).toBe(7)
      expect(before?.tasks['t1']?.state).toBe('accepted')
      expect(before?.terminalTombstones).toEqual([])

      // THE STALE SETTLEMENT, applied through the production path. The child id
      // is a STRING the re-adopted child legitimately carries, and the epoch is
      // the only field that could distinguish the generations — and it agrees.
      await second.service.transition({ runId, taskId: 't1', to: 'settling' })
      await second.service.transition({ runId, taskId: 't1', to: 'confirmed' })

      const after = second.service.getRun(runId)
      // The damage, in the record's own numbers:
      //   - the task is TERMINAL, so it can never be reconciled again;
      //   - the reservation is RELEASED, so credit the new generation believed
      //     was held becomes free and can be committed to new work;
      //   - a tombstone is written, so the taskId can never be re-admitted.
      expect(after?.tasks['t1']?.state).toBe('confirmed')
      expect(after?.budget.reserved, 'the reservation is released by a generation that never admitted it').toBe(0)
      expect(after?.terminalTombstones).toEqual(['t1'])
      // And nothing anywhere recorded that this was a stale claim: there is no
      // refusal, no audit entry, no uncertainty string. The record simply moved.
      expect(after?.tasks['t1']?.uncertainty).toBeUndefined()
    } finally {
      await second.service.close()
      await second.ctx.fiber.dispose()
    }
  })

  it('WITH the guard, the same settlement is refused and the evidence is retained', async () => {
    // The other half, so the finding is precise: the guard is CORRECT. The gap is
    // reachability, not logic. `applyWorkerSettlement` refuses the epoch-1 claim
    // from a generation that is not current, and records why.
    const root = makeTempDir('t9a-guard')
    const { ctx, service } = await openService(root)
    const ledger = new RefusalLedger(ctx)
    await ledger.open()
    try {
      const runId = 'run-t9a-guard'
      await service.createRun({
        runId,
        root: { session: { header: { id: 'root-t9a-guard' } } } as never,
        authorizationRef: 'auth',
      })
      await service.admit({
        runId,
        taskId: 't1',
        childId: 'child-t9a-guard',
        assignmentDigest: 'd',
        reservedCost: 7,
        allowedCapabilities: ['reader'],
      })
      await service.transition({ runId, taskId: 't1', to: 'launching' })
      await service.transition({ runId, taskId: 't1', to: 'accepted' })

      // A settlement carrying an epoch that is NOT the record's. The record is at
      // 1, so the only value that can be stale is anything else — which is the
      // point: no production code can produce one, so this input can only be
      // written by hand, which is exactly why the guard is unreachable.
      const refused = await applyWorkerSettlement({
        service,
        ledger,
        settlement: { runId, epoch: 0, taskId: 't1', childId: 'child-t9a-guard', to: 'confirmed' },
      })
      expect(refused.accepted).toBe(false)
      expect(refused.reason).toMatch(/carries epoch 0 but run "run-t9a-guard" is at epoch 1/)
      expect(refused.reason).toMatch(/stale generation cannot write authoritative state/)

      // The authoritative state is untouched: no confirmation, no release, no
      // tombstone, and the epoch is unchanged.
      const after = service.getRun(runId)
      expect(after?.tasks['t1']?.state).toBe('accepted')
      expect(after?.budget.reserved).toBe(7)
      expect(after?.terminalTombstones).toEqual([])
      expect(after?.epoch).toBe(1)

      // The diagnostic evidence IS retained, in its own store, so a silent
      // refusal cannot destroy the only record that a stale worker existed.
      expect(refused.refusalRef).toBeDefined()
      const retained = ledger.get(refused.refusalRef ?? '')
      expect(retained?.epoch).toBe(0)
      expect(retained?.reason).toMatch(/stale generation/)
      expect(ledger.entries()).toHaveLength(1)
    } finally {
      await ledger.close()
      await service.close()
      await ctx.fiber.dispose()
    }
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
    // The outcome is `undefined` and the stored record has no `status` key. The
    // rehearsal's R3 check is `performed.performed ? PASS : FAIL`, which is true
    // here — so it passed on a record the schema would reject at reopen.
    expect(attempt.performed).toBe(true)
    expect(attempt.outcome).toBeUndefined()
    const stored = ledger.get(identify(intent).operationId)
    expect(stored, 'the record exists').toBeDefined()
    expect(Object.hasOwn(stored ?? {}, 'status'), 'the stored record has NO status key').toBe(false)
    await ledger.close()
    await ctx.fiber.dispose()

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

      // A full-file overwrite preserves the target's EXISTING style rather than
      // imposing one, which is what keeps a one-line write from rewriting a file.
      const overwritten = await fs.writeText(crlfTarget, 'x\ny\nz\n')
      expect(overwritten.after, 'the diff basis is LF-normalized').toBe('x\ny\nz\n')
      expect(readFileSync(crlfPath, 'utf8'), 'a write normalizes content to the file\'s own style').toBe('x\r\ny\r\nz\r\n')
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
      const python = 'C:/Users/hzq00/AppData/Local/Programs/Python/Python314/python.exe'
      const script = [
        "import os, pathlib",
        `root = pathlib.Path(${JSON.stringify(root.replace(/\\/g, '/'))})`,
        // A direct overwrite of a tracked file...
        "(root / 'tracked.txt').write_text('mutated by raw python, no dsh tool\\n', encoding='utf-8')",
        // ...and a brand-new file the tool never heard of.
        "(root / 'raw-only.txt').write_text('created by raw python\\n', encoding='utf-8')",
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
