/**
 * Process hygiene: no orphan kernel or broker survives a shutdown.
 *
 * WHY THIS FILE WAS REWRITTEN. The first version compared raw `python.exe` pid
 * SETS: it snapshotted the set, ran a kernel, shut it down, and asserted the set
 * returned to its baseline. That oracle is wrong, and the diagnosis is recorded
 * here because the failure it produced looked exactly like a product defect.
 *
 * This machine runs several other agents' Python, including the ZLoop bridge's own
 * IPython kernel (`E:\zcode-labs\zloop\plugin\runtime\...\bridge.py` ->
 * `ipykernel_launcher`). Those processes START and STOP on their own schedule. A
 * set diff therefore reports "new pids" that this suite never created, and reports
 * "the set grew" when an unrelated agent launched a kernel -- and both readings
 * are indistinguishable from a real leak by timing alone. Measured: a sampler over
 * the full suite attributed 60+ appearing pids, of which **0** had this package in
 * their ancestry.
 *
 * So attribution is by ANCESTRY, which is a fact about the process tree rather
 * than about timing: a process is this suite's iff walking its parent chain
 * reaches a `broker.py` this package started. The control arm below proves the
 * classifier has no false positives by running it while nothing of ours runs.
 *
 * The property being asserted is unchanged and is the one that matters: after
 * `shutdown()`, nothing THIS PACKAGE created is still running.
 */
import { Context } from '@deepseek-ai/cordis'
import Subprocess from '@deepseek-ai/dsh-subprocess-local'
import { execFileSync } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { KernelHost } from './kernel.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const BROKER = resolve(HERE, 'broker.py')
const PYTHON = process.env['DSH_PYTHON'] ?? 'C:/Users/hzq00/AppData/Local/Programs/Python/Python314/python.exe'

let ctx: Context
let root: string
const hosts: KernelHost[] = []

beforeEach(async () => {
  ctx = new Context()
  await ctx.plugin(Subprocess)
  root = await mkdtemp(join(tmpdir(), 'dsh-ipython-cleanup-'))
})

afterEach(async () => {
  for (const host of hosts.splice(0, hosts.length)) {
    await host.shutdown().catch(() => undefined)
  }
  await ctx.fiber.dispose()
  await rm(root, { recursive: true, force: true })
})

interface Proc {
  readonly pid: number
  readonly ppid: number
  readonly name: string
  readonly cmd: string
}

/** Every live python.exe with its parent pid and command line. */
function pythonProcs(): Proc[] {
  return allProcs().filter(proc => /(^|[\\/])python(\.exe)?$/i.test(proc.name))
}

/**
 * Every live process with parent pid and command line.
 *
 * The ancestry walk needs this rather than a python-only list: a broker's chain to
 * this worker passes through `node.exe`, so a python-only map stops one hop short.
 */
function allProcs(): Proc[] {
  const script = [
    'Get-CimInstance Win32_Process',
    '| ForEach-Object { $c = $_.CommandLine; if (-not $c) { $c = "" };',
    'Write-Output ("{0}|{1}|{2}|{3}" -f $_.ProcessId, $_.ParentProcessId, $_.Name, $c) }',
  ].join(' ')
  const out = execFileSync('powershell', ['-NoProfile', '-Command', script], { encoding: 'utf8' })
  const procs: Proc[] = []
  for (const line of out.split(/\r?\n/)) {
    const parts = line.trim().split('|')
    if (parts.length < 4) continue
    const pid = Number(parts[0])
    if (!Number.isFinite(pid) || pid === 0) continue
    procs.push({ pid, ppid: Number(parts[1]), name: parts[2] ?? '', cmd: parts.slice(3).join('|') })
  }
  return procs
}

/**
 * The pids this worker owns, found by walking each process's ancestry up to a
 * `broker.py` that lives in THIS package's directory.
 *
 * Matching on `broker.py` alone would be too weak: another checkout of this
 * package would match, and so would a stale process from an earlier version. The
 * path check pins it to this directory.
 *
 * THE PATH CHECK IS STILL NOT ENOUGH, and this was measured rather than
 * anticipated. `packages/dsh-daily-work/src/data-plane.test.ts:424` mounts the real
 * `KernelService` and spawns THIS package's `src/broker.py`, so while another agent
 * runs that suite, a directory-scoped classifier attributes their brokers and
 * kernels to this file. Measured: the control arm below failed with
 * `[12412, 35124, 11792, 29960]` while nothing of this file's was running -- the
 * exact wrong-oracle shape this file's own header warns about, one level deeper.
 *
 * So the walk must terminate at THIS worker (`process.pid`), not at a shared
 * directory. That is exact, cannot be fooled by another suite, and is what makes
 * the control arm meaningful instead of decorative.
 *
 * The walk also uses the FULL process tree, not the python-only list: the chain
 * from a broker to this worker passes through `node.exe` (the seam's `runner.js`,
 * then vitest's fork), so a python-only map stops one hop above the broker and
 * reports a running kernel as unowned.
 */
function ownedByThisPackage(procs: readonly Proc[]): Set<number> {
  const byPid = new Map(allProcs().map(proc => [proc.pid, proc]))
  const brokerDirectory = resolve(HERE).replace(/\\/g, '/')
  const owned = new Set<number>()
  for (const proc of procs) {
    // THE WHOLE CHAIN IS WALKED FIRST, then classified. Deciding as the walk goes
    // is wrong: this worker is ABOVE the broker, so a loop that stopped at the
    // first `broker.py` would evaluate "does this reach the worker" before it had
    // passed the worker. Measured: that ordering made a running kernel report as
    // unowned, which is the same false-negative shape the control arm exists to
    // catch.
    const chain: Proc[] = []
    const seen = new Set<number>()
    let cursor: Proc | undefined = proc
    while (cursor !== undefined && !seen.has(cursor.pid)) {
      seen.add(cursor.pid)
      chain.push(cursor)
      cursor = byPid.get(cursor.ppid)
    }
    const reachesThisWorker = chain.some(step => step.pid === process.pid)
    const underOurBroker = chain.some(step => {
      const cmd = step.cmd.replace(/\\/g, '/')
      return cmd.includes('broker.py') && cmd.includes(brokerDirectory)
    })
    if (reachesThisWorker && underOurBroker) owned.add(proc.pid)
  }
  return owned
}

function makeHost(): KernelHost {
  const host = new KernelHost({
    subprocess: ctx.subprocess,
    identity: { sessionId: `cleanup-${hosts.length}`, executionWorld: 'local', environmentDigest: 'test-env' },
    brokerScript: BROKER,
    pythonExecutable: PYTHON,
    workingDirectory: root,
  })
  hosts.push(host)
  return host
}

const sleep = (ms: number): Promise<void> => new Promise(resolvePromise => setTimeout(resolvePromise, ms))

describe('process hygiene', () => {
  it('the classifier reports nothing of ours when nothing of ours is running', async () => {
    // THE CONTROL ARM. Without it, "0 owned processes" after a shutdown is not
    // evidence: a classifier that always returned the empty set would pass every
    // other test in this file. This runs while no kernel of ours exists.
    expect([...ownedByThisPackage(pythonProcs())]).toEqual([])
    await sleep(1500)
    expect([...ownedByThisPackage(pythonProcs())]).toEqual([])
  }, 60_000)

  it('a started kernel is attributed to this package, so the classifier has teeth', async () => {
    const host = makeHost()
    const status = await host.start()
    await sleep(1000)

    const owned = ownedByThisPackage(pythonProcs())
    // The kernel is a DESCENDANT of the broker, so ancestry attribution must find
    // it. Asserting the kernel pid specifically is what proves the walk works
    // rather than happening to find only the broker.
    //
    // Asserted rather than asserted-away: `status.pid` is `number | undefined`, and
    // a `!` here would turn "the broker did not report a pid" into a comparison
    // against `undefined` that silently passes for the wrong reason.
    expect(status.pid).toBeDefined()
    if (status.pid === undefined) throw new Error('the broker reported no kernel pid')
    expect(owned.has(status.pid)).toBe(true)
    // And more than one process: the broker itself plus the kernel.
    expect(owned.size).toBeGreaterThanOrEqual(2)
  }, 120_000)

  it('shutdown leaves none of this package\'s processes running', async () => {
    const host = makeHost()
    const status = await host.start()
    expect(status.pid).toBeDefined()
    if (status.pid === undefined) throw new Error('the broker reported no kernel pid')
    const kernelPid = status.pid
    await host.execute('marker = "resident"')
    await sleep(500)
    expect(ownedByThisPackage(pythonProcs()).has(kernelPid)).toBe(true)

    await host.shutdown()
    // Bounded wait, with the bound asserted: a process that is merely slow to be
    // reaped must not be reported as a leak, but the wait must END.
    //
    // THE BOUND IS MEASURED AT THE MOMENT CLEAN IS OBSERVED, not afterwards. The
    // enumeration itself spawns PowerShell and costs ~2 s under load, so a check of
    // `deadline - Date.now()` placed after the last probe can go negative and report
    // an overshoot that is an artefact of the MEASUREMENT, not of the teardown. That
    // is the load-dependent-oracle class this project already recorded (G-VER-01),
    // and it failed here for exactly that reason before this comment existed.
    const boundMs = 15_000
    const startedWaiting = Date.now()
    let owned = ownedByThisPackage(pythonProcs())
    let elapsedAtClean: number | undefined = owned.size === 0 ? 0 : undefined
    while (elapsedAtClean === undefined && Date.now() - startedWaiting < boundMs) {
      await sleep(500)
      owned = ownedByThisPackage(pythonProcs())
      if (owned.size === 0) elapsedAtClean = Date.now() - startedWaiting
    }
    expect(owned).toEqual(new Set())
    // The wait did not have to run to its bound, which is the difference between
    // "clean" and "we stopped looking".
    expect(elapsedAtClean).toBeDefined()
    expect(elapsedAtClean ?? boundMs).toBeLessThan(boundMs)
  }, 120_000)

  it('two sequential kernels do not accumulate this package\'s processes', async () => {
    for (let index = 0; index < 2; index += 1) {
      const host = makeHost()
      await host.execute('x = 1')
      await host.shutdown()
    }
    const deadline = Date.now() + 15_000
    let owned = ownedByThisPackage(pythonProcs())
    while (owned.size > 0 && Date.now() < deadline) {
      await sleep(500)
      owned = ownedByThisPackage(pythonProcs())
    }
    expect(owned).toEqual(new Set())
  }, 180_000)

  it('a kernel killed out from under the host is still cleaned up by shutdown', async () => {
    // The escalation path: the kernel dies, the broker replaces it, and the
    // replacement must not be the thing that leaks. This is the case where a
    // naive implementation would leave the SECOND kernel behind, because the
    // handle it holds refers to the first.
    const host = makeHost()
    const status = await host.start()
    execFileSync('taskkill', ['/F', '/PID', String(status.pid)], { stdio: 'ignore' })
    await sleep(1500)
    await host.execute('pass').catch(() => undefined)

    await host.shutdown()
    const deadline = Date.now() + 15_000
    let owned = ownedByThisPackage(pythonProcs())
    while (owned.size > 0 && Date.now() < deadline) {
      await sleep(500)
      owned = ownedByThisPackage(pythonProcs())
    }
    expect(owned).toEqual(new Set())
  }, 180_000)
})
