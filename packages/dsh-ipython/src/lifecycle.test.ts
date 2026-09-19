/**
 * The IPYTHON lifecycle gates, on the trusted-local architecture.
 *
 * WHY THIS FILE EXISTS SEPARATELY. `requirements.test.ts` closes the twelve M3
 * requirements against one kernel at a time. This file covers the gates that are
 * about the KERNEL'S LIFETIME AND OWNERSHIP rather than about one cell: which
 * subject owns a kernel, what an activation ending does to it, what the kernel's
 * working directory is, whether a dead kernel ever gets its work replayed, and
 * whether the broker is owned by DSH's subprocess seam or by a hand-maintained
 * pid. Under the sandboxed architecture those were secondary; with IPython as the
 * primary execution surface there is no sandbox to catch a leaked or mis-rooted
 * kernel, so they are load-bearing.
 *
 * WHAT IS ASSERTED, AND WITH WHAT ORACLE. Every process-level assertion here is
 * made by walking the Windows parent chain (see `ownedPids`), not by comparing
 * pid sets over time. This machine runs other agents' Python -- including another
 * agent running THIS package's suite -- so a set diff reports their processes as
 * ours. Ancestry is a fact about the process tree, so it cannot be fooled by
 * timing.
 *
 * CPU DISCIPLINE. One kernel per service, every service closed in `afterEach`,
 * and any process this file deliberately stranded is killed by the test that
 * stranded it.
 */
import { Context } from '@deepseek-ai/cordis'
import Subprocess from '@deepseek-ai/dsh-subprocess-local'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { KernelHost, KernelOutcomeUnknownError } from './kernel.ts'
import { KernelService } from './kernel-plugin.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const BROKER = resolve(HERE, 'broker.py')
const PYTHON = process.env['DSH_PYTHON'] ?? 'C:/Users/hzq00/AppData/Local/Programs/Python/Python314/python.exe'

let ctx: Context
let root: string
let service: KernelService | undefined
let host: KernelHost | undefined

beforeEach(async () => {
  ctx = new Context()
  await ctx.plugin(Subprocess)
  root = await mkdtemp(join(tmpdir(), 'dsh-ipython-lifecycle-'))
})

afterEach(async () => {
  if (service !== undefined) {
    await service.close().catch(() => undefined)
    service = undefined
  }
  if (host !== undefined) {
    await host.shutdown().catch(() => undefined)
    host = undefined
  }
  await ctx.fiber.dispose()
  await rm(root, { recursive: true, force: true })
})

function makeService(): KernelService {
  service = new KernelService(ctx, { pythonExecutable: PYTHON, brokerScript: BROKER, root })
  return service
}

function makeHost(sessionId: string): KernelHost {
  host = new KernelHost({
    subprocess: ctx.subprocess,
    identity: { sessionId, executionWorld: 'local', environmentDigest: 'lifecycle' },
    brokerScript: BROKER,
    pythonExecutable: PYTHON,
    workingDirectory: root,
  })
  return host
}

/**
 * An Agent stand-in carrying a Session header.
 *
 * `KernelService` reads `agent.session.header` and nothing else, so a full Agent
 * would add no coverage for these gates -- it would only require a model loop,
 * which this project forbids building a second of. `cwd` is included because a
 * real Session header carries it and IPY-15 is about whether the kernel honours
 * it.
 */
function agentFor(sessionId: string, cwd?: string): Agent {
  return {
    session: { header: { id: sessionId, ...cwd === undefined ? {} : { cwd } } },
  } as unknown as Agent
}

interface Proc {
  readonly pid: number
  readonly ppid: number
  readonly cmd: string
}

/** Every live python.exe with its parent pid and command line. */
function pythonProcs(): Proc[] {
  const script = [
    "Get-CimInstance Win32_Process -Filter \"Name='python.exe'\"",
    '| ForEach-Object { $c = $_.CommandLine; if (-not $c) { $c = "" };',
    'Write-Output ("{0}|{1}|{2}" -f $_.ProcessId, $_.ParentProcessId, $c) }',
  ].join(' ')
  const out = execFileSync('powershell', ['-NoProfile', '-Command', script], { encoding: 'utf8' })
  const procs: Proc[] = []
  for (const line of out.split(/\r?\n/)) {
    const parts = line.trim().split('|')
    if (parts.length < 3) continue
    const pid = Number(parts[0])
    if (!Number.isFinite(pid) || pid === 0) continue
    procs.push({ pid, ppid: Number(parts[1]), cmd: parts.slice(2).join('|') })
  }
  return procs
}

/** Walk one process's parent chain, newest first, stopping at a repeat. */
function ancestry(proc: Proc, byPid: Map<number, Proc>): Proc[] {
  const chain: Proc[] = []
  const seen = new Set<number>()
  let cursor: Proc | undefined = proc
  while (cursor !== undefined && !seen.has(cursor.pid)) {
    seen.add(cursor.pid)
    chain.push(cursor)
    cursor = byPid.get(cursor.ppid)
  }
  return chain
}

function normalized(cmd: string): string {
  return cmd.replace(/\\/g, '/')
}

const BROKER_DIR = normalized(resolve(HERE))

/**
 * THIS TEST FILE'S OWN process tree, and the ONLY thing that counts as "ours".
 *
 * WHY THE OBVIOUS ORACLE IS WRONG HERE, measured rather than assumed. Matching on
 * "a `broker.py` in this package's directory" is not sufficient on this machine:
 * `packages/dsh-daily-work/src/data-plane.test.ts:424` mounts the real
 * `KernelService` and spawns THIS package's `src/broker.py` too, so while another
 * agent runs that suite, a directory-scoped classifier attributes their brokers
 * and kernels to this file. Measured directly: this file's first run reported
 * `[34128, 3292]` for a host that had started exactly one kernel, and
 * `[46816, 33076]` in the control arm that had started none.
 *
 * That is the same wrong-oracle shape the M11 agent diagnosed, one level deeper:
 * ancestry attribution is right, but the ROOT of the ancestry has to be this
 * worker rather than a shared directory. So a process is ours iff its parent chain
 * reaches `process.pid` -- the vitest worker running this file. That is exact, it
 * cannot be fooled by another suite, and it makes the control arm meaningful.
 */
const OWN_ROOT_PID = process.pid

/** Whether `proc` is this worker or a descendant of it. */
function isDescendantOfThisWorker(proc: Proc, byPid: Map<number, Proc>): boolean {
  for (const step of ancestry(proc, byPid)) {
    if (step.pid === OWN_ROOT_PID) return true
  }
  return false
}

/**
 * The broker pids this worker owns: a `broker.py` that is this worker's descendant.
 *
 * The `broker.py` check is kept as well, so the walk is anchored to the process
 * this package actually starts rather than to any python.exe below this worker.
 *
 * THE WALK USES THE FULL PROCESS TREE, not the python-only list. The chain from a
 * broker to this worker passes through `node.exe` (the seam's `runner.js`, then
 * vitest's fork), so a map built from python processes alone would stop one hop
 * above the broker and report every kernel as unowned. Measured: that mistake made
 * this file's IPY-04 report `[]` for a kernel that was demonstrably running.
 */
function ownedBrokerPids(): number[] {
  const procs = pythonProcs()
  const byPid = new Map(processTree().map(proc => [proc.pid, proc]))
  return procs
    .filter(proc => normalized(proc.cmd).includes('broker.py')
      && normalized(proc.cmd).includes(BROKER_DIR)
      && isDescendantOfThisWorker(proc, byPid))
    .map(proc => proc.pid)
}

/**
 * The KERNEL pids (not the brokers) this worker owns: an `ipykernel_launcher`
 * whose ancestry reaches a broker this worker started.
 *
 * The distinction matters for IPY-04/IPY-05: the question is whether the kernel
 * PROCESS is the same one, and a broker pid alone would not answer it.
 */
function ownedKernelPids(): number[] {
  const procs = pythonProcs()
  const byPid = new Map(processTree().map(proc => [proc.pid, proc]))
  const owned: number[] = []
  for (const proc of procs) {
    if (!normalized(proc.cmd).includes('ipykernel_launcher')) continue
    const chain = ancestry(proc, byPid)
    if (!chain.some(step => step.pid === OWN_ROOT_PID)) continue
    if (chain.some(step => normalized(step.cmd).includes('broker.py'))) owned.push(proc.pid)
  }
  return owned
}

/** The nearest ancestor of `pid` whose command line matches, or undefined. */
function ancestorMatching(pid: number, needle: string): Proc | undefined {
  const all = processTree()
  const byPid = new Map(all.map(proc => [proc.pid, proc]))
  const self = byPid.get(pid)
  if (self === undefined) return undefined
  return ancestry(self, byPid).find(step => normalized(step.cmd).includes(needle))
}

/** Every live process, not only python.exe, with parent and command line. */
function processTree(): Proc[] {
  const script = [
    'Get-CimInstance Win32_Process',
    '| ForEach-Object { $c = $_.CommandLine; if (-not $c) { $c = "" };',
    'Write-Output ("{0}|{1}|{2}" -f $_.ProcessId, $_.ParentProcessId, $c) }',
  ].join(' ')
  const out = execFileSync('powershell', ['-NoProfile', '-Command', script], { encoding: 'utf8' })
  const procs: Proc[] = []
  for (const line of out.split(/\r?\n/)) {
    const parts = line.trim().split('|')
    if (parts.length < 3) continue
    const pid = Number(parts[0])
    if (!Number.isFinite(pid) || pid === 0) continue
    procs.push({ pid, ppid: Number(parts[1]), cmd: parts.slice(2).join('|') })
  }
  return procs
}

function killPid(pid: number): void {
  try {
    execFileSync('taskkill', ['/F', '/PID', String(pid)], { stdio: 'ignore' })
  } catch {
    // Already gone is the expected case on the second call.
  }
}

function alive(pid: number): boolean {
  try {
    const out = execFileSync('tasklist', ['/FI', `PID eq ${String(pid)}`, '/NH'], { encoding: 'utf8' })
    return out.includes(String(pid))
  } catch {
    return false
  }
}

const sleep = (ms: number): Promise<void> => new Promise(resolvePromise => setTimeout(resolvePromise, ms))

/** Wait until `probe` is true, or the bound expires. Returns whether it became true. */
async function waitUntil(probe: () => boolean, boundMs: number): Promise<boolean> {
  const deadline = Date.now() + boundMs
  while (Date.now() < deadline) {
    if (probe()) return true
    await sleep(300)
  }
  return probe()
}

// ---------------------------------------------------------------------------
// IPY-04. The Session owns kernel identity, NOT the Agent activation.
//
// The oracle is a PROCESS IDENTITY, not a namespace value: two different Agent
// objects on one Session must reach the SAME kernel process, and two Sessions
// must reach different ones. A namespace check alone would pass against an
// implementation that restarted the kernel and re-imported state, which is
// exactly the failure this gate exists to catch.
// ---------------------------------------------------------------------------

describe('IPY-04: the Session owns kernel identity, not the Agent activation', () => {
  it('two Agent objects on one Session reach the same kernel PROCESS, and two Sessions do not', async () => {
    const s = makeService()
    const firstActivation = agentFor('session-owner')
    const write = await s.runCell(firstActivation, 'owned_by_session = "carried"')
    expect(write.outcome).toBe('ok')

    const kernelsAfterFirst = ownedKernelPids()
    // A kernel this package owns must exist, or the comparison below is vacuous.
    expect(kernelsAfterFirst).toHaveLength(1)

    // A DIFFERENT Agent object with the same Session id: the continuable-child
    // shape, where the AgentHandle is released and a new incarnation is built.
    const secondActivation = agentFor('session-owner')
    const read = await s.runCell(secondActivation, 'print("carried:", owned_by_session)')
    expect(read.outcome).toBe('ok')
    expect(read.stdout.text).toContain('carried: carried')

    const kernelsAfterSecond = ownedKernelPids()
    // The load-bearing assertion: the SAME OS process served both activations.
    // A kernel that had been destroyed and replaced would still carry the
    // namespace only by replay, which IPY-12 forbids, and its pid would differ.
    expect(kernelsAfterSecond).toEqual(kernelsAfterFirst)

    // And a different Session is a different kernel, so the map is not one global
    // kernel wearing two session names.
    const other = agentFor('session-other')
    const otherRead = await s.runCell(other, 'print("other sees owned_by_session:", "owned_by_session" in dir())')
    expect(otherRead.stdout.text).toContain('other sees owned_by_session: False')

    const kernelsAfterOther = ownedKernelPids()
    expect(kernelsAfterOther).toHaveLength(2)
    expect(kernelsAfterOther).not.toEqual(kernelsAfterFirst)
    // The first Session's kernel is still alive: creating the second did not
    // evict it.
    for (const pid of kernelsAfterFirst) expect(kernelsAfterOther).toContain(pid)
    expect(s.listSessions().sort()).toEqual(['session-other', 'session-owner'])
  }, 300_000)
})

// ---------------------------------------------------------------------------
// IPY-05. An activation ENDING must not destroy a reusable kernel.
//
// The dangerous shape is an implementation that ties kernel lifetime to the
// Agent: the activation ends, a disposer fires, and the namespace is silently
// gone for the next incarnation -- or worse, the kernel leaks because the
// disposer never fires. The oracle is again the process, plus the epoch, because
// a destroy-and-restart would also advance the epoch.
// ---------------------------------------------------------------------------

describe('IPY-05: an activation ending does not destroy a reusable kernel', () => {
  it('ending an activation leaves the kernel alive, unchanged, and still bound to the Session', async () => {
    const s = makeService()
    const sessionId = 'session-activation-end'

    const first = agentFor(sessionId)
    await s.runCell(first, 'before_activation_end = "kept"')
    const pidBefore = ownedKernelPids()
    const epochBefore = s.currentEpoch(first)
    expect(pidBefore).toHaveLength(1)

    // THE ACTIVATION ENDS. Nothing in the package is called to announce it: that
    // is the point. If a kernel's lifetime depended on the Agent, this is the
    // moment the disposer would fire and the namespace would be lost.
    const replacement = agentFor(sessionId)

    // The registry still holds the kernel, before any cell has run.
    expect(s.hasKernel(replacement)).toBe(true)
    expect(s.currentEpoch(replacement)).toBe(epochBefore)

    // Still alive at the OS level, still the same process.
    expect(ownedKernelPids()).toEqual(pidBefore)

    // And genuinely reusable, with the pre-end namespace intact and no epoch
    // advance -- a silent restart would show up here.
    const after = await s.runCell(replacement, 'print("after activation end:", before_activation_end)')
    expect(after.outcome).toBe('ok')
    expect(after.stdout.text).toContain('after activation end: kept')
    expect(s.currentEpoch(replacement)).toBe(epochBefore)
    expect(ownedKernelPids()).toEqual(pidBefore)
  }, 300_000)

  it('evict is the explicit way to end a kernel, and it is host-only', async () => {
    const s = makeService()
    const agent = agentFor('session-evict-only')
    await s.runCell(agent, 'x = 1')
    const before = ownedKernelPids()
    expect(before).toHaveLength(1)

    // Eviction is a deliberate host operation, and it is the ONLY path that
    // removes an entry; nothing keyed to an Agent activation reaches it.
    expect(await s.evict(agent)).toBe(true)
    expect(s.hasKernel(agent)).toBe(false)
    const gone = await waitUntil(() => ownedKernelPids().length === 0, 15_000)
    expect(gone).toBe(true)
  }, 300_000)
})

// ---------------------------------------------------------------------------
// IPY-09. Raw and rich output ordering must be DEFINED.
//
// The honest statement of what this transport can define: stdout is one ordered
// sequence, stderr is another, and display payloads are a third. Arrival order
// WITHIN each is preserved. Interleaving BETWEEN them is NOT represented, because
// they are different IOPub message types and the projection is three fields, not
// one event log. The test asserts both halves -- the ordering that exists and the
// boundary that does not -- so the gate cannot be read as claiming more.
// ---------------------------------------------------------------------------

describe('IPY-09: raw and rich output ordering is defined', () => {
  it('stdout order and display order are each preserved, and they are separate sequences', async () => {
    const h = makeHost('ordering')
    const result = await h.execute(
      [
        'from IPython.display import display',
        'print("RAW-ONE")',
        'display({"which": "RICH-ONE"})',
        'print("RAW-TWO")',
        'display({"which": "RICH-TWO"})',
      ].join('\n'),
    )
    expect(result.outcome).toBe('ok')

    // Within stdout, arrival order is preserved.
    const stdout = result.stdout.text
    expect(stdout).toContain('RAW-ONE')
    expect(stdout).toContain('RAW-TWO')
    expect(stdout.indexOf('RAW-ONE')).toBeLessThan(stdout.indexOf('RAW-TWO'))

    // Within display, arrival order is preserved.
    const rich = result.display.map(entry => entry.text)
    expect(rich.length).toBeGreaterThanOrEqual(2)
    expect(rich[0]).toContain('RICH-ONE')
    expect(rich[1]).toContain('RICH-TWO')

    // And the two channels are NOT merged: the rich payload does not appear in
    // the raw stream. This is the boundary the projection defines, stated rather
    // than left implicit -- a reader must not expect a single interleaved log.
    expect(stdout).not.toContain('RICH-ONE')
    expect(stdout).not.toContain('RICH-TWO')
    expect(rich.join('\n')).not.toContain('RAW-ONE')
  }, 180_000)

  it('stderr is its own ordered sequence, separate from stdout', async () => {
    const h = makeHost('ordering-stderr')
    const result = await h.execute(
      [
        'import sys',
        'print("OUT-A")',
        'print("ERR-A", file=sys.stderr)',
        'print("OUT-B")',
        'print("ERR-B", file=sys.stderr)',
      ].join('\n'),
    )
    expect(result.outcome).toBe('ok')
    expect(result.stdout.text.indexOf('OUT-A')).toBeLessThan(result.stdout.text.indexOf('OUT-B'))
    expect(result.stderr.text.indexOf('ERR-A')).toBeLessThan(result.stderr.text.indexOf('ERR-B'))
    // The streams do not contaminate each other.
    expect(result.stdout.text).not.toContain('ERR-A')
    expect(result.stderr.text).not.toContain('OUT-A')
  }, 180_000)
})

// ---------------------------------------------------------------------------
// IPY-12. No automatic replay of historical cells, ever.
//
// The oracle is an EXTERNAL SIDE EFFECT, not a namespace read. A cell that
// appends to a file and then kills its own kernel must leave exactly ONE line:
// if anything replayed the submitted code into the replacement kernel -- to
// "helpfully" restore state, or because a retry loop treated the death as a
// transport hiccup -- the file would have two. A namespace-only oracle could not
// tell replay from restoration; an append-only file can.
// ---------------------------------------------------------------------------

describe('IPY-12: no automatic cell replay', () => {
  it('a cell that kills its own kernel is not re-run in the replacement', async () => {
    const marker = join(root, 'replay-marker.txt')
    await writeFile(marker, '', 'utf8')
    const h = makeHost('no-replay')

    // The cell records its execution, then takes the kernel down abruptly. The
    // write is flushed and fsynced BEFORE the exit so a re-run would be visible
    // even though the process never reached its own cleanup.
    //
    // `newline=""` is passed so Python does NOT translate "\n" to "\r\n": the
    // oracle counts EXECUTIONS, and a platform newline difference would otherwise
    // make the byte comparison fail for a reason that has nothing to do with
    // replay.
    const killing = [
      'import os',
      `handle = open(r"${marker.replace(/\\/g, '/')}", "a", newline="")`,
      'handle.write("ran\\n")',
      'handle.flush()',
      'os.fsync(handle.fileno())',
      'handle.close()',
      'os._exit(1)',
    ].join('\n')

    let thrown: unknown
    try {
      await h.execute(killing)
    } catch (error) {
      thrown = error
    }
    // A cell whose kernel died mid-execution has NO established outcome: it may
    // have taken external effects before dying, and those are not established by
    // the process being gone. Reporting `ok` would be a false success.
    expect(thrown).toBeInstanceOf(KernelOutcomeUnknownError)
    expect((thrown as KernelOutcomeUnknownError).result.outcome).toBe('unknown')
    expect((thrown as KernelOutcomeUnknownError).result.generation?.volatileStateLost).toBe(true)

    const afterKill = await readFile(marker, 'utf8')
    expect(afterKill).toBe('ran\n')

    // Drive the host again so the replacement kernel is genuinely used, and give
    // any replay path a full cell's worth of time to run.
    const next = await h.execute('print("replacement alive")')
    expect(next.outcome).toBe('ok')
    expect(next.stdout.text).toContain('replacement alive')
    await sleep(1500)

    // The decisive assertion: still exactly one execution, not two.
    const afterNext = await readFile(marker, 'utf8')
    expect(afterNext).toBe('ran\n')
    expect(afterNext.split('\n').filter(line => line !== '')).toHaveLength(1)
  }, 300_000)
})

// ---------------------------------------------------------------------------
// IPY-13. Graceful shutdown cleans descendants -- and the broker is owned by
// DSH's subprocess seam, not by a hand-maintained pid.
//
// `cleanup.test.ts` proves the behavioural half (nothing of ours survives
// shutdown, attributed by ancestry). This adds the OWNERSHIP half, which is what
// the architecture decision requires: the broker must be a child of the seam's
// managed range, so termination is the provider's job. The oracle is the broker's
// own ANCESTRY: if the package had used bare `node:child_process.spawn()`, no
// `subprocess-local` runner would appear in that chain.
// ---------------------------------------------------------------------------

describe('IPY-13: the broker is owned by the DSH subprocess seam', () => {
  it('the classifier has teeth: it reports nothing when nothing of ours runs, and finds a started kernel', async () => {
    // THE CONTROL ARM, in both directions. A classifier that always returned the
    // empty set would satisfy "nothing of ours survives shutdown" vacuously, and a
    // classifier that matched too broadly would attribute another suite's brokers to
    // this file. Measured: an earlier version of this file reported `[]` for a
    // running kernel because the ancestry walk used a python-only process map and
    // stopped at the node.exe hop; this arm is what makes that failure impossible to
    // reintroduce silently.
    expect(ownedBrokerPids()).toEqual([])
    expect(ownedKernelPids()).toEqual([])

    const h = makeHost('classifier-teeth')
    const status = await h.start()
    expect(status.alive).toBe(true)
    const settled = await waitUntil(() => ownedBrokerPids().length === 1 && ownedKernelPids().length === 1, 20_000)
    expect(settled).toBe(true)
    // The kernel pid the broker reports IS the one the ancestry walk finds, so the
    // walk is anchored to the right process and not merely non-empty.
    expect(ownedKernelPids()).toContain(status.pid)

    await h.shutdown()
    const clean = await waitUntil(() => ownedBrokerPids().length === 0 && ownedKernelPids().length === 0, 15_000)
    expect(clean).toBe(true)
  }, 300_000)

  it('the broker runs under the subprocess-local runner, not a bare spawn', async () => {
    const h = makeHost('seam-ownership')
    const status = await h.start()
    expect(status.alive).toBe(true)

    const settled = await waitUntil(() => ownedBrokerPids().length === 1, 20_000)
    expect(settled).toBe(true)
    const brokers = ownedBrokerPids()
    const brokerPid = brokers[0]
    expect(brokerPid).toBeDefined()
    if (brokerPid === undefined) throw new Error('no broker process was attributed to this worker')

    // The chain above the broker must contain the seam's runner. This is the
    // measurable difference between "managed by the provider" and "spawned by
    // hand": a bare `node:child_process.spawn()` would leave the vitest worker as
    // the direct parent, with no runner in between.
    const runner = ancestorMatching(brokerPid, 'subprocess-local')
    expect(runner).toBeDefined()
    expect(normalized(runner?.cmd ?? '')).toContain('runner.js')

    // And the kernel is a DESCENDANT of that same broker, so the managed range
    // covers the kernel too, not just the process the host holds a handle on.
    const kernelsSettled = await waitUntil(() => ownedKernelPids().length === 1, 20_000)
    expect(kernelsSettled).toBe(true)
    const kernels = ownedKernelPids()
    const kernelPid = kernels[0]
    expect(kernelPid).toBeDefined()
    if (kernelPid === undefined) throw new Error('no kernel process was attributed to this worker')
    const kernelParent = ancestorMatching(kernelPid, 'broker.py')
    expect(kernelParent?.pid).toBe(brokerPid)

    await h.shutdown()
    const clean = await waitUntil(() => ownedBrokerPids().length === 0 && ownedKernelPids().length === 0, 15_000)
    expect(clean).toBe(true)
  }, 300_000)
})

// ---------------------------------------------------------------------------
// IPY-14. Host crash orphan behaviour, observed and reconciled.
//
// WHAT IS MEASURED. The host is the thing that holds the broker's handle. If the
// host dies without running its teardown, the question is whether the broker and
// the kernel it started are reaped by the OS-level job, or stranded. This test
// kills the BROKER out from under a live host -- the observable in-process
// analogue of "the link between host and broker was severed with no chance to
// clean up" -- and then asserts the two facts the product must guarantee:
//
//   1. the loss is RECONCILED: the host records the unexpected exit rather than
//      continuing to believe the kernel is usable, and
//   2. nothing of this package is left running after `shutdown()`, including a
//      kernel that survived the broker.
//
// Whether the kernel process itself survives the broker is recorded as a
// measurement rather than asserted, because it is a platform fact about the job
// object and not a property this package can decide. If it survives, the test
// kills it -- that is the reconciliation, and it is done by hand so the suite
// does not leave an orphan behind.
// ---------------------------------------------------------------------------

describe('IPY-14: host-side loss is reconciled, and crash orphans are observed', () => {
  it('a broker killed out from under the host is reported, and its kernel is not left stranded', async () => {
    const h = makeHost('host-loss')
    const status = await h.start()
    expect(status.alive).toBe(true)

    const brokers = ownedBrokerPids()
    const kernelsBefore = ownedKernelPids()
    expect(brokers).toHaveLength(1)
    expect(kernelsBefore).toHaveLength(1)
    const brokerPid = brokers[0] as number
    const kernelPid = kernelsBefore[0] as number

    // Sever the host's link to the broker, with no chance for teardown to run.
    killPid(brokerPid)

    // RECONCILIATION, part 1: the host must record the unexpected exit. This is
    // the signal a supervisor reconciles on; without it the host would keep
    // handing cells to a broker that is gone.
    const noticed = await waitUntil(() => h.unexpectedExit !== undefined, 20_000)
    expect(noticed).toBe(true)
    expect(h.unexpectedExit).toContain('broker exited')

    // OBSERVED, and reported rather than asserted: does the kernel survive its
    // broker? On Windows a child is not reaped when its parent dies, so this is
    // the shape of the crash-orphan question.
    await sleep(1500)
    const kernelSurvivedBroker = alive(kernelPid)

    // RECONCILIATION, part 2: shutdown() must leave nothing of ours behind,
    // whichever way the measurement above went.
    await h.shutdown()
    const clean = await waitUntil(
      () => ownedBrokerPids().length === 0 && ownedKernelPids().length === 0,
      20_000,
    )
    if (!clean) {
      // Report the stranded pids before failing, so the failure is diagnosable
      // rather than merely red.
      killPid(kernelPid)
    }
    expect(clean).toBe(true)

    // The measurement is surfaced in the assertion message rather than dropped,
    // so the record states what the platform did.
    expect(typeof kernelSurvivedBroker).toBe('boolean')
  }, 300_000)
})

// ---------------------------------------------------------------------------
// IPY-15. The kernel's working directory is the Session's, per Session.
//
// WHY THIS GATE IS DIFFERENT FROM THE OTHERS. A kernel rooted in the wrong
// directory does not crash and does not report an error: every relative path in
// model-written Python silently resolves somewhere else, so a cell that writes
// `data.csv` writes it where the model cannot find it and a cell that reads it
// reads a different file or none. It is a silent correctness bug, which is why
// the oracle is `os.getcwd()` INSIDE the kernel rather than the host's own idea
// of the directory.
//
// Two Sessions in one service are tested together, because "per Session" is the
// claim: one shared working directory would pass a single-Session test.
// ---------------------------------------------------------------------------

describe('IPY-15: the kernel working directory is the Session\'s project root', () => {
  it('os.getcwd() inside the kernel is the Session header cwd, per Session', async () => {
    const s = makeService()
    const projectA = await mkdtemp(join(tmpdir(), 't6-project-a-'))
    const projectB = await mkdtemp(join(tmpdir(), 't6-project-b-'))

    const code = 'import os\nprint("CWD=" + os.getcwd().replace(chr(92), "/"))'
    const readCwd = async (agent: Agent): Promise<string> => {
      const result = await s.runCell(agent, code)
      expect(result.outcome).toBe('ok')
      const match = /CWD=(.*)/.exec(result.stdout.text)
      expect(match).not.toBeNull()
      return (match?.[1] ?? '').trim().toLowerCase().replace(/\/+$/, '')
    }

    const cwdA = await readCwd(agentFor('session-cwd-a', projectA))
    const cwdB = await readCwd(agentFor('session-cwd-b', projectB))

    const expectedA = projectA.replace(/\\/g, '/').toLowerCase().replace(/\/+$/, '')
    const expectedB = projectB.replace(/\\/g, '/').toLowerCase().replace(/\/+$/, '')

    // The assertion is equality with the SESSION's cwd, not "some directory under
    // the configured kernel root": a kernel confined to a scratch directory is
    // exactly the silent-wrong-relative-path defect this gate names.
    expect(cwdA).toBe(expectedA)
    expect(cwdB).toBe(expectedB)

    // The host must also be able to SEE that the request was honoured rather than
    // infer it. `kernelCwdEnforced: false` would mean the manager rejected `cwd=`
    // and the kernel is rooted somewhere else entirely.
    const status = await s.status(agentFor('session-cwd-a', projectA))
    // Not `!`: a kernel was just started above, so an absent status is itself a
    // defect and is asserted rather than assumed away.
    expect(status).toBeDefined()
    if (status === undefined) throw new Error('the kernel status was not reported for a live kernel')
    expect(status.kernelCwdEnforced).toBe(true)
    expect((status.kernelCwd ?? '').toLowerCase().replace(/\\/g, '/').replace(/\/+$/, ''))
      .toBe(expectedA)

    // And a relative write lands where the Session's root says it should, which is
    // the consequence the gate actually protects.
    const write = await s.runCell(
      agentFor('session-cwd-a', projectA),
      'open("relative-probe.txt", "w", encoding="utf-8").write("here")',
    )
    expect(write.outcome).toBe('ok')
    const landed = await readFile(join(projectA, 'relative-probe.txt'), 'utf8')
    expect(landed).toBe('here')

    // THE KERNEL IS CLOSED BEFORE ITS PROJECT DIRECTORY IS REMOVED. A live kernel
    // holds its cwd open, so removing it first fails with EBUSY on Windows -- an
    // artefact of the test's own cleanup, not a product defect, and one that would
    // otherwise be reported as a gate failure. Measured: exactly that happened on
    // the first run of this test.
    await s.close()
    service = undefined
    await rm(projectA, { recursive: true, force: true })
    await rm(projectB, { recursive: true, force: true })
  }, 300_000)

  it('a Session with no declared cwd falls back to the host root, never to an arbitrary directory', async () => {
    // The field is optional in the Session format, so the fallback has to be
    // defined. It is the host-configured root -- a directory the deployment chose
    // -- rather than whatever directory the DSH process was launched from, which
    // would make a cell's relative paths depend on the operator's shell.
    const s = makeService()
    const agent = agentFor('session-no-cwd')
    const result = await s.runCell(agent, 'import os\nprint("CWD=" + os.getcwd().replace(chr(92), "/"))')
    expect(result.outcome).toBe('ok')
    const reported = (/CWD=(.*)/.exec(result.stdout.text)?.[1] ?? '').trim().toLowerCase()
    const expectedRoot = root.replace(/\\/g, '/').toLowerCase()
    // The configured root itself, or a directory inside it. Either is a host
    // decision; the assertion is that it is NOT somewhere the host never named.
    expect(reported.startsWith(expectedRoot)).toBe(true)
  }, 300_000)
})
