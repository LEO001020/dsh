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
import Storage from '@deepseek-ai/dsh-storage'
import * as storageDomainPlugin from '@deepseek-ai/dsh-storage-domain'
import * as storageJsonPlugin from '@deepseek-ai/dsh-storage-json'
import { spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { WorkService } from './host.ts'
import { reconcileTask } from './reconcile.ts'

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
