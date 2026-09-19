// REC-03: "a crash before admission publishes nothing."
//
// WHAT THIS MEASURES, and why the existing evidence was not enough.
//
// The tree already had two halves of this window, and neither is this one:
//
//   D01 (simulated barrier)  — a REFUSED admission leaves no trace of either
//                              half. In-process; no process ever died.
//   D03 (REAL KILL)          — admit persisted, launch never called. The task IS
//                              published (correctly: the write committed), and
//                              the retry is licensed only by positive proof.
//
// REC-03's stimulus is "kill the host before a child or cell starts, then
// restart", and its oracle's first half is "NO task is published for the
// interrupted attempt". So the window under test is the one D03 does NOT cover:
// a real SIGKILL that lands after the process opened the store and BEFORE the
// admission write committed. The measurement is the reopened store's own
// contents.
//
// THE POSITIVE CONTROL IS NOT OPTIONAL, and it is the reason this script forks
// TWO children rather than one. A reopened store showing zero tasks cannot
// distinguish "the admission never committed" from "the reopen cannot read tasks
// at all" or "the run was never created". So the control child runs the SAME
// program with `admit` enabled, is SIGKILLed at the SAME point, and its reopened
// store MUST show the task and its reservation. Without that arm the first
// measurement is an empty negative.
//
// Both children are killed with SIGKILL and their liveness is re-probed before
// the script continues, so a child that somehow survived cannot be holding the
// store directory when the parent reopens it.
//
// USAGE (cwd matters — the child resolves @deepseek-ai/* through the package's
// node_modules junctions):
//   cd packages/dsh-daily-work
//   node ../../qualification/runners/v6-rec03-crash-before-admission.mjs <outPath>
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, existsSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PACKAGE_SRC = join(HERE, '..', '..', 'packages', 'dsh-daily-work', 'src')
const HOST_TS = pathToFileURL(join(PACKAGE_SRC, 'host.ts')).href
const TSX_LOADER = 'tsx/esm'
const CHILD_TIMEOUT_MS = 90_000

const outPath = process.argv[2]
if (outPath === undefined) throw new Error('usage: v6-rec03-crash-before-admission.mjs <outPath>')

/**
 * The child program. `mode` is `admit` (control) or `skip` (the window).
 *
 * Both modes write their report and then hang on a live timer, so the SIGKILL
 * lands on an IDLE process. A busy process would make the kill racy and the test
 * would be measuring interruptibility rather than durability.
 */
const CHILD_SOURCE = `
import { Context } from 'file:///D:/DSH/src/dsh-src/vendor/cordis/lib/index.js'
import Storage from 'file:///D:/DSH/src/dsh-src/packages/storage/storage/lib/index.js'
import * as storageDomainPlugin from 'file:///D:/DSH/src/dsh-src/packages/storage/storage-domain/lib/index.js'
import * as storageJsonPlugin from 'file:///D:/DSH/src/dsh-src/packages/storage/storage-json/lib/index.js'
import { WorkService } from ${JSON.stringify(HOST_TS)}
import { writeFileSync } from 'node:fs'

// \`--eval\` has NO script path in argv, so \`argv[0]\` is the node binary and the
// real arguments begin at index 1. Destructuring \`[,, storeDir, ...]\` here
// silently shifted every argument by two: the store was created at the REPORT
// path and the report write threw, which presented as EISDIR in the parent.
const [storeDir, reportPath, mode] = process.argv.slice(1)
const ctx = new Context()
await ctx.plugin(Storage, {})
await ctx.plugin(storageJsonPlugin, { root: storeDir })
await ctx.plugin(storageDomainPlugin, { backend: 'json' })
const service = new WorkService(ctx, {
  targetChildren: 10, maxDepth: 1, budgetCeiling: 1000, currency: 'USD', priceVersion: 'v6-rec03',
})
await service.open()
await service.createRun({ runId: 'run-rec03', root: { session: { header: { id: 'root-rec03' } } }, authorizationRef: 'auth-rec03' })

if (mode === 'admit') {
  await service.admit({
    runId: 'run-rec03', taskId: 't1', childId: 'child-rec03',
    assignmentDigest: 'digest-rec03', reservedCost: 7, allowedCapabilities: ['reader'],
  })
}
// mode === 'skip': the process is killed here — the store is open and the run
// exists, and the admission this attempt INTENDED has not been written.
const belief = service.getRun('run-rec03')
writeFileSync(reportPath, JSON.stringify({
  ready: true, mode, pid: process.pid,
  taskKeys: Object.keys(belief.tasks), reserved: belief.budget.reserved,
}))
setInterval(() => {}, 3600000)
await new Promise(() => {})
`

/** Probe a pid for liveness. `pid <= 0` is refused: `process.kill(0,0)` signals the caller's group. */
function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) throw new Error(`refusing to probe a non-pid: ${String(pid)}`)
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if (error.code === 'EPERM') return true
    return false
  }
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

/** Fork the child, wait for its report, SIGKILL it, and CONFIRM it is gone. */
async function killChildAtReport(label, mode) {
  const dir = mkdtempSync(join(tmpdir(), `v6-rec03-${label}-`))
  const reportPath = join(dir, 'report.json')
  let stderr = ''
  const child = spawn(
    process.execPath,
    ['--import', TSX_LOADER, '--input-type=module', '--eval', CHILD_SOURCE, '--', dir, reportPath, mode],
    { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env } },
  )
  child.stderr?.on('data', chunk => { stderr += chunk.toString() })

  const deadline = Date.now() + CHILD_TIMEOUT_MS
  while (!existsSync(reportPath) && Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`child "${label}" exited (${child.exitCode}) before reporting:\n${stderr}`)
    }
    await sleep(50)
  }
  if (!existsSync(reportPath)) {
    child.kill('SIGKILL')
    throw new Error(`child "${label}" never reported:\n${stderr}`)
  }
  const report = JSON.parse(readFileSync(reportPath, 'utf8'))
  const childPid = report.pid

  const signalRequested = child.kill('SIGKILL')
  const exit = await new Promise(resolve => {
    if (child.exitCode !== null || child.signalCode !== null) {
      return resolve({ code: child.exitCode, signal: child.signalCode })
    }
    child.once('exit', (code, signal) => resolve({ code, signal }))
  })
  // CONFIRMED, not assumed: the store directory cannot be reopened honestly while
  // a writer may still hold it.
  const goneDeadline = Date.now() + 15_000
  while (pidAlive(childPid) && Date.now() < goneDeadline) await sleep(50)
  const confirmedGone = !pidAlive(childPid)
  if (!confirmedGone) throw new Error(`child "${label}" (pid ${childPid}) survived SIGKILL`)

  return { dir, report, exit, signalRequested, confirmedGone, stderr }
}

/**
 * Reopen the store from THIS process and read what actually persisted.
 *
 * The imports are ABSOLUTE `file://` URLs into the pinned checkout, not bare
 * specifiers. This runner lives under `qualification/runners/`, which is outside
 * any package's `node_modules` chain, so a bare `@deepseek-ai/cordis` here fails
 * with ERR_MODULE_NOT_FOUND — measured, and the reason the shape is spelled out.
 */
const DSH = 'file:///D:/DSH/src/dsh-src'
async function reopen(dir) {
  const { Context } = await import(`${DSH}/vendor/cordis/lib/index.js`)
  const Storage = (await import(`${DSH}/packages/storage/storage/lib/index.js`)).default
  const storageJson = await import(`${DSH}/packages/storage/storage-json/lib/index.js`)
  const storageDomain = await import(`${DSH}/packages/storage/storage-domain/lib/index.js`)
  const { WorkService } = await import(pathToFileURL(join(PACKAGE_SRC, 'host.ts')).href)
  const ctx = new Context()
  await ctx.plugin(Storage, {})
  await ctx.plugin(storageJson, { root: dir })
  await ctx.plugin(storageDomain, { backend: 'json' })
  const service = new WorkService(ctx, {
    targetChildren: 10, maxDepth: 1, budgetCeiling: 1000, currency: 'USD', priceVersion: 'v6-rec03',
  })
  await service.open()
  const run = service.getRun('run-rec03')
  const observed = {
    runExists: run !== undefined,
    taskKeys: run === undefined ? [] : Object.keys(run.tasks).sort(),
    reserved: run?.budget.reserved,
    phase: run?.phase,
  }
  await service.close()
  await ctx.fiber.dispose()
  return observed
}

const result = { case: 'REC-03', identity: '0a0996f3944b552827f995defe98d9ea87ca9209f2957b2c244e6c89b14d9461', arms: {} }

// ARM 1 — the window: SIGKILL before the admission write.
const windowArm = await killChildAtReport('window', 'skip')
const windowObserved = await reopen(windowArm.dir)
result.arms.window = {
  what: 'SIGKILL after createRun, before admit; the admission this attempt intended was never written',
  childReport: windowArm.report,
  exit: windowArm.exit,
  signalRequested: windowArm.signalRequested,
  childConfirmedGone: windowArm.confirmedGone,
  reopened: windowObserved,
}
rmSync(windowArm.dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 })

// ARM 2 — the positive control: the SAME program WITH admit, killed at the same point.
const controlArm = await killChildAtReport('control', 'admit')
const controlObserved = await reopen(controlArm.dir)
result.arms.control = {
  what: 'the same program WITH admit, killed at the same point — proves the reopen can SEE a committed task',
  childReport: controlArm.report,
  exit: controlArm.exit,
  signalRequested: controlArm.signalRequested,
  childConfirmedGone: controlArm.confirmedGone,
  reopened: controlObserved,
}
rmSync(controlArm.dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 })

result.checks = {
  windowKilledAbruptly: windowArm.exit.signal === 'SIGKILL',
  windowPublishedNoTask: windowObserved.taskKeys.length === 0,
  windowReservedNothing: windowObserved.reserved === 0,
  windowRunStillExists: windowObserved.runExists === true,
  controlKilledAbruptly: controlArm.exit.signal === 'SIGKILL',
  controlPublishedTheTask: controlObserved.taskKeys.includes('t1'),
  controlReservedTheCredit: controlObserved.reserved === 7,
}
result.verdict = Object.values(result.checks).every(Boolean) ? 'PASS' : 'FAIL'

writeFileSync(outPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8')
console.log(JSON.stringify(result, null, 2))
process.exit(result.verdict === 'PASS' ? 0 : 1)
