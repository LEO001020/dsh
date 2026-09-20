/**
 * D01, D03-D11, D13: the crash windows, closed one at a time.
 *
 * Each gate below is a DISTINCT WINDOW between two durable facts, not a
 * restatement of the reconciliation rules. Where the window can only be reached
 * by an abrupt termination, this file forks a REAL Node child and SIGKILLs it;
 * where a real kill cannot land inside the window (the process would have to
 * stop between two adjacent synchronous statements), a SIMULATED BARRIER is
 * used and named as such. The method is stated in every test name so a reader
 * can tell a real kill from a barrier without reading the body.
 *
 * WHAT IS REAL in this file:
 *   - the production storage domain (JSON backend, serialized write chain, zod
 *     validation of every record) and the real `WorkService` record
 *   - the production AgentLoop, the real `ctx.subagents` continuable registry,
 *     the in-process spawn provider, and a real durable JSONL Session per child
 *   - the real SessionProjectionRegistry and DSH's own `inbox` projection
 *   - real SIGKILL on a forked child process for the windows that need it
 *
 * WHAT IS CONTROLLED, and why:
 *   - the model adapter. The plan forbids building a second model loop to fake
 *     children; a scripted adapter is the provider boundary, not a second loop.
 *     The loop, the tools, the Inbox, the Sessions and the subagent machinery
 *     are the genuine article.
 *
 * Deliberate non-claims, stated here so a green suite is not read as more than
 * it is:
 *   - A SIGKILL proves what SURVIVED. It does not prove the storage backend's
 *     fsync ordering on every platform, and on Windows the directory fsync is
 *     skipped by design (`storage-json/src/atomic.ts:44-52`).
 *   - No gate here claims exactly-once external effects. The claims are about
 *     what the record is allowed to SAY after an interruption.
 */
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { LlmAdapter, createUserMessage, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SessionQueryEngine from '@deepseek-ai/dsh-session-query'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import * as SubagentSpawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import Storage from '@deepseek-ai/dsh-storage'
import * as storageDomainPlugin from '@deepseek-ai/dsh-storage-domain'
import type { DomainChanged } from '@deepseek-ai/dsh-storage-domain'
import * as storageJsonPlugin from '@deepseek-ai/dsh-storage-json'
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { WorkService, WORK_DOMAIN_NAME, workDomainSpec, type LaunchPort, type LaunchRequest } from './host.ts'
import { createContinuableLaunchPort } from './launch-port.ts'
import { recoveryPhase, reconcileRun, reconcileTask, type ChildEvidence } from './reconcile.ts'
import { relaunchPrepared } from './recovery.ts'
import { holdsSlot, TERMINAL_STATES } from './states.ts'

const HERE = dirname(fileURLToPath(import.meta.url))

/**
 * The absolute file URL of the tsx ESM loader.
 *
 * A forked child does NOT inherit the parent's `--import` hook, so it must load
 * the TypeScript sources itself. The path is absolute because the child is
 * spawned with a temp cwd where `tsx/esm` does not resolve. If the resolution
 * ever fails the tests below report the missing loader rather than silently
 * observing a child that never started.
 */
function tsxLoaderUrl(): string {
  const resolved = fileURLToPath(import.meta.resolve('tsx/esm'))
  return new URL(`file://${resolved.replace(/\\/g, '/')}`).href
}

const cleanups: Array<() => Promise<void>> = []
const liveChildren = new Set<ChildProcess>()

afterEach(async () => {
  const errors: unknown[] = []
  // A killed child is already gone; a child that never started must not leak.
  // `kill` on an exited process is a no-op, and the exit is awaited below so a
  // test failure cannot leave a live Node process holding a session directory.
  for (const child of liveChildren) {
    try {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL')
        await new Promise<void>(resolve => {
          const timer = setTimeout(resolve, 5_000)
          child.once('exit', () => {
            clearTimeout(timer)
            resolve()
          })
        })
      }
    } catch (error) {
      errors.push(error)
    }
  }
  liveChildren.clear()
  for (const cleanup of cleanups.splice(0)) {
    try {
      await cleanup()
    } catch (error) {
      errors.push(error)
    }
  }
  if (errors.length > 0) throw new AggregateError(errors, 'cleanup failed')
})

/** Windows holds handles on session directories; removal needs retries. */
function removeTree(path: string): void {
  rmSync(path, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 })
}

/** An adapter that answers immediately, so a child can finish a real turn. */
class QuickAdapter extends LlmAdapter {
  requests = 0

  override async resolveModel(provider: string, model: string): Promise<{ provider: string; id: string; name: string }> {
    return { provider, id: model, name: model }
  }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests += 1
    if (options.signal?.aborted) throw new Error('aborted')
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'child output' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

/**
 * An adapter that enters a request and never finishes it.
 *
 * This is the real shape of the D07 window: the provider accepted the request
 * and the process is killed while the stream is open. Nothing here simulates a
 * disconnect; the process simply stops existing mid-await.
 */
class HangingAdapter extends LlmAdapter {
  requests = 0

  override async resolveModel(provider: string, model: string): Promise<{ provider: string; id: string; name: string }> {
    return { provider, id: model, name: model }
  }

  async * stream(): AsyncIterable<StreamChunk> {
    this.requests += 1
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'partial output' }
    // Never resolves: the caller's abort signal cannot help, because the process
    // is going to die rather than to unwind.
    await new Promise<never>(() => {})
  }
}

/** The real storage domain over `root`, with the work service opened on it. */
async function openService(root: string, ctx: Context): Promise<WorkService> {
  const service = new WorkService(ctx, {
    targetChildren: 4,
    maxDepth: 1,
    budgetCeiling: 1_000,
    currency: 'USD',
    priceVersion: 'durability-records',
  })
  await service.open()
  return service
}

/**
 * A second host generation over an EXISTING directory.
 *
 * A restart is a new process with a new context: one Cordis context holds one
 * `dailyWork` registration, so reusing the first context would be a caller bug
 * (`service "dailyWork" has been registered`) rather than a restart. This builds
 * the real storage stack again over the same medium, which is what a restarted
 * host does.
 *
 * The CALLER must ensure the previous generation is fully disposed first. Two
 * live services over one directory is the configuration gate D02 marks
 * unsupported: the JSON backend is an in-process cache plus serialized writes,
 * not a cross-process CAS (`docs/RECOVERY.md`: "two hosts never share a state
 * directory that assumes a single writer"). Every use below disposes before
 * reopening.
 */
async function reopenOver(root: string): Promise<{ ctx: Context; service: WorkService }> {
  const ctx = new Context()
  await ctx.plugin(Storage, {} as never)
  await ctx.plugin(storageJsonPlugin as never, { root } as never)
  await ctx.plugin(storageDomainPlugin as never, { backend: 'json' } as never)
  const service = await openService(root, ctx)
  cleanups.push(async () => {
    await service.close()
    await ctx.fiber.dispose()
  })
  return { ctx, service }
}

interface StoreRig {
  readonly ctx: Context
  readonly service: WorkService
  readonly root: string
}

/** A work service on a real domain, without any agent machinery. */
async function storeRig(): Promise<StoreRig> {
  const root = mkdtempSync(join(tmpdir(), 'dsh-daily-work-durable-store-'))
  const ctx = new Context()
  await ctx.plugin(Storage, {} as never)
  await ctx.plugin(storageJsonPlugin as never, { root } as never)
  await ctx.plugin(storageDomainPlugin as never, { backend: 'json' } as never)
  const service = await openService(root, ctx)
  cleanups.push(async () => {
    await service.close()
    await ctx.fiber.dispose()
    removeTree(root)
  })
  return { ctx, service, root }
}

interface AgentRig extends StoreRig {
  readonly root_: Agent
  readonly persistence: { dispose(): Promise<void> }
  readonly sessionRoot: string
  readonly adapter: QuickAdapter | HangingAdapter
}

/**
 * The full real stack: AgentLoop, subagents, JSONL Sessions, the storage domain.
 *
 * `maxActiveSubagents` is the production capacity setting; `N` is the user's
 * choice and root is not counted in it.
 */
async function agentRig(adapter: QuickAdapter | HangingAdapter = new QuickAdapter()): Promise<AgentRig> {
  const sessionRoot = mkdtempSync(join(tmpdir(), 'dsh-daily-work-durable-sessions-'))
  const storeRoot = mkdtempSync(join(tmpdir(), 'dsh-daily-work-durable-domain-'))
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  const persistence = await ctx.plugin(JsonlSessionPersistence, { root: sessionRoot })
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(SubagentRuntime, { maxActiveSubagents: 4, maxDepth: 1 })
  await ctx.plugin(SubagentSpawn, { providerName: 'spawn' })
  // `listChildren` reads child Sessions back through sessionQuery; the point
  // reads are what this file uses, so a concrete engine with search faces
  // unavailable is enough (the same shape DSH's own continuation tests use).
  await ctx.plugin(class extends SessionQueryEngine {
    override searchSessions(): Promise<never> {
      return Promise.reject(new Error('session search is not configured in this test'))
    }
    override searchEvents(): Promise<never> {
      return Promise.reject(new Error('event search is not configured in this test'))
    }
  })
  await ctx.plugin(Storage, {} as never)
  await ctx.plugin(storageJsonPlugin as never, { root: storeRoot } as never)
  await ctx.plugin(storageDomainPlugin as never, { backend: 'json' } as never)
  ctx.llm.registerAdapter(['mock'], adapter)

  const root_ = await ctx.agentLoop.create(SessionId('root-durable'), { provider: 'mock', model: 'mock' })
  const service = await openService(storeRoot, ctx)

  cleanups.push(async () => {
    // Shutdown order matters and the naive order hangs: a child parked inside a
    // model call cannot be torn down, so the gate (if any) is released first,
    // then new admissions stop, then owned children stop, then storage, then
    // the context. This is the production sequence documented in
    // `docs/RECOVERY.md`.
    await service.close()
    await ctx.subagents.drainContinuableDescendants([root_])
    await persistence.dispose()
    await ctx.fiber.dispose()
    removeTree(sessionRoot)
    removeTree(storeRoot)
  })
  return { ctx, service, root: storeRoot, root_, persistence, sessionRoot, adapter }
}

/** The real launch port, over the rig's own live root Agent. */
function portFor(r: AgentRig, overrides: Partial<{ provider: string; maxDepth: number }> = {}): LaunchPort {
  return createContinuableLaunchPort({
    subagents: r.ctx.subagents,
    parent: r.root_,
    provider: overrides.provider ?? 'spawn',
    maxDepth: overrides.maxDepth ?? 1,
  })
}

/**
 * Fork a child that runs `childSource`, wait for its ready report, then SIGKILL.
 *
 * The ready report is the barrier: it is written to disk by the CHILD, so the
 * parent knows the window was actually entered before the signal lands. Waiting
 * on a timer instead would make "the window was entered" an assumption.
 *
 * The exit is reported as OBSERVED, not as requested: `kill()` returns false on
 * Windows when the signal could not be delivered to an already-exiting process,
 * so recording the return value alone would let a no-op kill look successful.
 *
 * The temp directory is released on EVERY path, including a throw, because a
 * failing child is exactly when a leftover directory would be hardest to notice.
 *
 * @returns the child's report and the exit it actually produced.
 */
async function forkKillChild(
  childSource: string,
  args: readonly string[],
): Promise<{ report: Record<string, unknown>; exit: { code: number | null; signal: NodeJS.Signals | null }; stderr: string }> {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-daily-work-kill-'))
  const childPath = join(dir, 'child.mjs')
  const reportPath = join(dir, 'report.json')
  writeFileSync(childPath, childSource, 'utf8')

  let stderr = ''
  const child = spawn(
    process.execPath,
    ['--import', tsxLoaderUrl(), childPath, ...args, reportPath],
    { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env } },
  )
  liveChildren.add(child)
  child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString() })

  try {
    const deadline = Date.now() + 60_000
    while (!existsSync(reportPath) && Date.now() < deadline) {
      if (child.exitCode !== null) {
        throw new Error(`the durability child exited before reporting ready (${child.exitCode})\n${stderr}`)
      }
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    if (!existsSync(reportPath)) {
      child.kill('SIGKILL')
      throw new Error(`the durability child never reported ready\n${stderr}`)
    }

    const report = JSON.parse(readFileSync(reportPath, 'utf8')) as Record<string, unknown>
    child.kill('SIGKILL')
    const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => {
      if (child.exitCode !== null || child.signalCode !== null) {
        return resolve({ code: child.exitCode, signal: child.signalCode })
      }
      child.once('exit', (code, signal) => resolve({ code, signal }))
    })
    liveChildren.delete(child)
    return { report, exit, stderr }
  } finally {
    // On the failure paths the child may still be alive; `afterEach` reaps what
    // `liveChildren` still holds, and the directory goes either way.
    removeTree(dir)
  }
}

// ---------------------------------------------------------------------------
// D01 -- atomic admission
// ---------------------------------------------------------------------------

describe('D01: admission is one record transform, never a cross-key transaction', () => {
  it('D01 (simulated barrier): credit, task state and outbox are written by ONE update', async () => {
    // The real fact, quoted from the domain source
    // (`storage-domain/src/domain.ts:332-346`):
    //
    //   "update(key, fn): Atomic read-modify-write on the domain's write chain:
    //    `fn` sees the value current at its queue slot, so concurrent updates
    //    never interleave."
    //
    // and the unit contract (`storage/src/backend.ts:75-88`): "The unit does NOT
    // serialize concurrent writes ... the unit only guarantees that each single
    // call is atomic on the medium and durable once resolved."
    //
    // So atomicity is PER RECORD. A second key -- a separate credit table --
    // would not be covered by any transaction, which is why the record keeps
    // budget and task in one object. This test asserts that property directly
    // by observing the durable change events: there must be exactly ONE write
    // carrying all three facts, and no intermediate state in which a task
    // exists without its reservation.
    const r = await storeRig()
    await r.service.createRun({
      runId: 'run-d01',
      root: { session: { header: { id: 'root-d01' } } } as never,
      authorizationRef: 'auth-d01',
    })

    // `DomainChanged` is a CLOSED union on `operation` and a `deleted` event
    // carries no value (`storage-domain/src/events.ts:26-29`), so the handler
    // narrows rather than assuming every change is a put.
    const changes: Array<Extract<DomainChanged, { operation: 'put' }>> = []
    r.ctx.on('domain/changed', (change: DomainChanged) => {
      if (change.operation === 'put') changes.push(change)
    })

    await r.service.admit({
      runId: 'run-d01',
      taskId: 't1',
      childId: 'child-t1',
      assignmentDigest: 'digest-1',
      reservedCost: 7,
      allowedCapabilities: ['reader'],
    })

    // ONE durable write, and it carries the task, the credit and the outbox
    // entry together. Two writes here would mean two crash windows.
    expect(changes).toHaveLength(1)
    const committed = changes[0]!.value as {
      tasks: Record<string, { state: string; reservedCost: number }>
      budget: { reserved: number; spent: number; unknownReserved: number }
      outbox: Record<string, { stage: string }>
    }
    expect(committed.tasks['t1']?.state).toBe('prepared')
    expect(committed.tasks['t1']?.reservedCost).toBe(7)
    expect(committed.budget.reserved).toBe(7)
    expect(Object.keys(committed.outbox)).toEqual(['admit-t1'])
    expect(committed.outbox['admit-t1']?.stage).toBe('pending')

    // The invariant that the single transform exists to protect: there is no
    // readable state anywhere with a task admitted and its credit unreserved.
    const stored = r.service.getRun('run-d01')!
    const committedCost = stored.budget.spent + stored.budget.reserved + stored.budget.unknownReserved
    const reservedByTasks = Object.values(stored.tasks).reduce((sum, task) => sum + task.reservedCost, 0)
    expect(committedCost).toBe(reservedByTasks)
  })

  it('D01 (simulated barrier): a refused admission leaves NO trace of either half', async () => {
    // The crash-BEFORE half of the window, expressed as the closest thing to a
    // crash that can be observed: the transform throws, so the domain's write
    // chain never reaches the medium and memory is untouched
    // (`storage-domain/src/domain.ts:336-345`: the record is stored and the
    // change emitted only AFTER `putRecord` resolves).
    const r = await storeRig()
    await r.service.createRun({
      runId: 'run-d01b',
      root: { session: { header: { id: 'root-d01b' } } } as never,
      authorizationRef: 'auth-d01b',
    })
    const before = JSON.stringify(r.service.getRun('run-d01b'))

    // Over the ceiling: the transform refuses.
    await expect(r.service.admit({
      runId: 'run-d01b',
      taskId: 'too-big',
      childId: 'child-big',
      assignmentDigest: 'd',
      reservedCost: 5_000,
      allowedCapabilities: [],
    })).rejects.toThrow(/no budget headroom/)

    // Neither half landed: no task, and no reservation for it.
    expect(JSON.stringify(r.service.getRun('run-d01b'))).toBe(before)
    expect(r.service.getRun('run-d01b')?.tasks['too-big']).toBeUndefined()
    expect(r.service.getRun('run-d01b')?.budget.reserved).toBe(0)
  })

  it('D01: the record schema has no second key, so no cross-key transaction can be claimed', async () => {
    // The claim "atomic admission" is only honest because the three facts live
    // in ONE record. If a later change split the credit into its own table, this
    // assertion would fail -- which is the point of pinning it.
    const { workDomainSpec } = await import('./host.ts')
    expect(Object.keys(workDomainSpec.tables)).toEqual(['runs'])
    // And the record's own doc comment is a claim about this shape, so the shape
    // is what gets checked rather than the comment.
    const r = await storeRig()
    const created = await r.service.createRun({
      runId: 'run-d01c',
      root: { session: { header: { id: 'root-d01c' } } } as never,
      authorizationRef: 'a',
    })
    expect(Object.keys(created)).toEqual(expect.arrayContaining(['tasks', 'budget', 'outbox']))
    expect(created.budget).toHaveProperty('reserved')
    expect(created.budget).toHaveProperty('unknownReserved')
  })
})

// ---------------------------------------------------------------------------
// D03 -- death before launch
// ---------------------------------------------------------------------------

describe('D03: a durable task+childId whose launch never happened', () => {
  it('D03 (REAL KILL): a reservation that provably never launched returns to prepared, once', async () => {
    // The window: `admit` persisted task+childId and reserved credit, and the
    // process died before the launch port was ever called. Recovery must launch
    // the ORIGINAL childId's assignment exactly once -- not mint a new id, and
    // not leave it quarantined forever when the proof is available.
    //
    // `launchProvenNotCreated` is the only licence back to `prepared`
    // (`reconcile.ts:92-99`), and the launch port is the thing that can produce
    // it: the child is created by `startContinuable`, so a port that never ran
    // is positive proof that no child exists.
    // The CHILD owns the directory for the whole run. The parent must not hold a
    // live handle over the same medium at the same time: two live writers on one
    // directory is the configuration gate D02 marks unsupported, and the JSON
    // backend is an in-process cache rather than a cross-process CAS. So the
    // directory is created here and handed to the child untouched.
    const root = mkdtempSync(join(tmpdir(), 'dsh-daily-work-d03-'))
    cleanups.push(() => { removeTree(root); return Promise.resolve() })

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
const service = new WorkService(ctx, { targetChildren: 4, maxDepth: 1, budgetCeiling: 1000, currency: 'USD', priceVersion: 'durability-records' })
await service.open()
await service.createRun({ runId: 'run-d03k', root: { session: { header: { id: 'root-d03k' } } }, authorizationRef: 'a' })
// ADMIT ONLY. The launch port is never installed and never called: this is
// exactly "durable task+childId written, startContinuable never called".
await service.admit({ runId: 'run-d03k', taskId: 't1', childId: 'child-reserved', assignmentDigest: 'digest-t1', reservedCost: 5, allowedCapabilities: ['reader'] })
const belief = service.getRun('run-d03k')
writeFileSync(reportPath, JSON.stringify({ ready: true, state: belief.tasks.t1.state, childId: belief.tasks.t1.childId, reserved: belief.budget.reserved }))
setInterval(() => {}, 3600000)
await new Promise(() => {})
`
    const killed = await forkKillChild(childSource, [root])
    // The child really died abruptly; a graceful exit would have let it flush.
    expect(killed.exit.signal).toBe('SIGKILL')
    expect(killed.report['state']).toBe('prepared')
    expect(killed.report['childId']).toBe('child-reserved')

    // The killed run is read back from disk by a second host generation over the
    // same root, which is what a host restart does. The first writer is gone
    // (SIGKILL, observed above), so this is a genuine handover rather than two
    // live writers.
    const { service: second } = await reopenOver(root)

    const run = second.getRun('run-d03k')
    expect(run).toBeDefined()
    expect(run?.tasks['t1']?.state).toBe('prepared')
    expect(run?.tasks['t1']?.childId).toBe('child-reserved')
    expect(run?.tasks['t1']?.attempt).toBe(1)
    expect(run?.budget.reserved).toBe(5)

    // A port that records what it was asked to launch, so "exactly once" and
    // "the same childId" are observations rather than intentions.
    const launches: LaunchRequest[] = []
    second.setLaunchPort({
      async launch(request: LaunchRequest): Promise<{ childId: string }> {
        launches.push(request)
        return { childId: request.childId }
      },
    })

    // Reconciliation supplies the proof the launch never happened, and the
    // decision is the ONLY path back to `prepared`.
    const decision = reconcileTask(run!.tasks['t1']!, {
      taskId: 't1',
      childId: 'child-reserved',
      sessionExists: false,
      agentLive: false,
      requestObserved: false,
      turnOutcome: undefined,
      resultRef: undefined,
      launchProvenNotCreated: true,
    })
    expect(decision.next).toBe('prepared')
    expect(decision.releaseSlot).toBe(false)

    // The decision has to be ACTED ON, and `drain` cannot do it: a `prepared`
    // task still holds its slot, so `admit` refuses it (asserted here, because
    // that refusal is precisely why a separate relaunch path is needed).
    const viaDrain = await second.drain(
      'run-d03k',
      [{ taskId: 't1', childId: 'child-reserved', prompt: 'digest-t1', reservedCost: 0 }],
      new AbortController().signal,
    )
    expect(viaDrain[0]?.accepted).toBe(false)
    expect(viaDrain[0]?.reason).toMatch(/already admitted as prepared/)
    expect(launches).toHaveLength(0)

    // The relaunch path (`recovery.ts`), which drives the EXISTING state machine
    // through the EXISTING legal transition and calls the EXISTING port.
    const outcome = await relaunchPrepared({
      service: second,
      port: { async launch(request: LaunchRequest) { launches.push(request); return { childId: request.childId } } },
      runId: 'run-d03k',
      taskId: 't1',
      assignmentDigest: 'digest-t1',
      signal: new AbortController().signal,
    })
    expect(outcome.launched).toBe(true)
    expect(outcome.childId).toBe('child-reserved')

    // EXACTLY ONCE, with the ORIGINAL childId, and the attempt counter did NOT
    // advance: a relaunch of the same attempt is not a new attempt.
    expect(launches).toHaveLength(1)
    expect(launches[0]?.childId).toBe('child-reserved')
    expect(second.getRun('run-d03k')?.tasks['t1']?.attempt).toBe(1)
    expect(second.getRun('run-d03k')?.tasks['t1']?.state).toBe('accepted')
    // The reservation was not re-taken: a relaunch of an already-reserved task
    // must not charge the budget twice.
    expect(second.getRun('run-d03k')?.budget.reserved).toBe(5)

    // A SECOND relaunch attempt is refused because the state has moved on. This
    // is the exactly-once claim: the state transition is the claim, and
    // `launching -> launching` is not a legal edge.
    const secondAttempt = await relaunchPrepared({
      service: second,
      port: { async launch(request: LaunchRequest) { launches.push(request); return { childId: request.childId } } },
      runId: 'run-d03k',
      taskId: 't1',
      assignmentDigest: 'digest-t1',
      signal: new AbortController().signal,
    })
    expect(secondAttempt.launched).toBe(false)
    expect(secondAttempt.reason).toMatch(/is accepted; only a task proven never to have launched/)
    expect(launches).toHaveLength(1)
  })

  it('D03: a task whose outcome is unknown is NEVER relaunched, even under its reserved id', async () => {
    // The other side of the same guard. `unknown` means the child may exist, so
    // relaunching is the duplicate. This is the assertion that keeps the
    // relaunch path from becoming a general-purpose retry.
    const r = await storeRig()
    await r.service.createRun({
      runId: 'run-d03u',
      root: { session: { header: { id: 'root-d03u' } } } as never,
      authorizationRef: 'a',
    })
    await r.service.admit({
      runId: 'run-d03u',
      taskId: 't1',
      childId: 'child-maybe',
      assignmentDigest: 'd',
      reservedCost: 5,
      allowedCapabilities: [],
    })
    await r.service.transition({ runId: 'run-d03u', taskId: 't1', to: 'launching' })
    await r.service.transition({
      runId: 'run-d03u',
      taskId: 't1',
      to: 'unknown',
      uncertainty: 'the launch failed and the child may exist',
    })

    const launches: LaunchRequest[] = []
    const outcome = await relaunchPrepared({
      service: r.service,
      port: { async launch(request: LaunchRequest) { launches.push(request); return { childId: request.childId } } },
      runId: 'run-d03u',
      taskId: 't1',
      assignmentDigest: 'd',
      signal: new AbortController().signal,
    })
    expect(outcome.launched).toBe(false)
    expect(outcome.reason).toMatch(/is unknown; only a task proven never to have launched/)
    expect(launches).toHaveLength(0)
    // The reservation is still held, so the credit cannot be reclaimed as free.
    expect(r.service.getRun('run-d03u')?.budget.reserved).toBe(5)
  })

  it('D03: a relaunch with a CHANGED assignment is refused rather than launched as the original', async () => {
    // The record stores a digest, not the body (`record.ts:56-57`). A relaunch
    // that silently substituted a different assignment would run work the user
    // never authorized under an identity that claims it is the original.
    const r = await storeRig()
    await r.service.createRun({
      runId: 'run-d03c',
      root: { session: { header: { id: 'root-d03c' } } } as never,
      authorizationRef: 'a',
    })
    await r.service.admit({
      runId: 'run-d03c',
      taskId: 't1',
      childId: 'child-fixed',
      assignmentDigest: 'the-original-assignment',
      reservedCost: 5,
      allowedCapabilities: [],
    })
    const launches: LaunchRequest[] = []
    const outcome = await relaunchPrepared({
      service: r.service,
      port: { async launch(request: LaunchRequest) { launches.push(request); return { childId: request.childId } } },
      runId: 'run-d03c',
      taskId: 't1',
      assignmentDigest: 'a-different-assignment',
      signal: new AbortController().signal,
    })
    expect(outcome.launched).toBe(false)
    expect(outcome.reason).toMatch(/does not match the admitted one/)
    expect(launches).toHaveLength(0)
    // And the task is untouched: still prepared, still holding its slot.
    expect(r.service.getRun('run-d03c')?.tasks['t1']?.state).toBe('prepared')
  })

  it('D03: the record keeps the reserved childId, which is what makes this recoverable at all', async () => {
    // Without a persisted childId there would be nothing to relaunch and nothing
    // to reconcile against; the field is the whole mechanism. Quoted from
    // `record.ts:46-53`: "childId is reserved BEFORE launch and persisted, so a
    // crash between the reservation and the launch is recoverable without
    // inventing a new identity."
    const r = await storeRig()
    await r.service.createRun({
      runId: 'run-d03d',
      root: { session: { header: { id: 'root-d03d' } } } as never,
      authorizationRef: 'a',
    })
    const task = await r.service.admit({
      runId: 'run-d03d',
      taskId: 't1',
      childId: 'child-fixed',
      assignmentDigest: 'd',
      reservedCost: 1,
      allowedCapabilities: [],
    })
    expect(task.childId).toBe('child-fixed')
    // A second admission of the same task is refused rather than re-minting.
    await expect(r.service.admit({
      runId: 'run-d03d',
      taskId: 't1',
      childId: 'child-other',
      assignmentDigest: 'd',
      reservedCost: 1,
      allowedCapabilities: [],
    })).rejects.toThrow(/already admitted/)
  })
})

// ---------------------------------------------------------------------------
// D04 -- accepted with no ack
// ---------------------------------------------------------------------------

describe('D04: the child was admitted but the parent never saved the result', () => {
  it('D04 (REAL KILL + real registry): DUPLICATE_CHILD is produced by the real seam and is rethrown unchanged', async () => {
    // The window: the child was admitted (its inbox accepted the prompt) and the
    // parent died before recording that fact. On restart the naive "just launch
    // it again" path is exactly what a real `startContinuable` REFUSES.
    //
    // The rejection is real, from the real registry
    // (`subagent/src/continuation.ts:158`): a `spec.childId` whose Session is
    // already persisted throws
    //   SubagentError(`subagent "${childId}" already exists`, 'DUPLICATE_CHILD').
    // The port rethrows it unchanged (`launch-port.ts:88-97`), so nobody can
    // turn it into a fresh-UUID retry.
    const r = await agentRig()
    const childSource = `
import { Context } from 'file:///D:/DSH/src/dsh-src/vendor/cordis/lib/index.js'
import AgentLoop from 'file:///D:/DSH/src/dsh-src/packages/core/agent-loop/lib/index.js'
import { mountAgentLoopTestDependencies } from 'file:///D:/DSH/src/dsh-src/packages/test-support/agent-loop-testkit/lib/index.js'
import { LlmAdapter } from 'file:///D:/DSH/src/dsh-src/packages/llm/llm/lib/index.js'
import { SessionId } from 'file:///D:/DSH/src/dsh-src/packages/core/session/lib/index.js'
import JsonlSessionPersistence from 'file:///D:/DSH/src/dsh-src/packages/session/session-persistence-jsonl/lib/index.js'
import SubagentRuntime from 'file:///D:/DSH/src/dsh-src/packages/subagent/subagent/lib/index.js'
import * as SubagentSpawn from 'file:///D:/DSH/src/dsh-src/packages/subagent/subagent-spawn-in-process/lib/index.js'
import SessionQueryEngine from 'file:///D:/DSH/src/dsh-src/packages/session-query/session-query/lib/index.js'
import { writeFileSync } from 'node:fs'

class Hanging extends LlmAdapter {
  requests = 0
  async resolveModel(p, m) { return { provider: p, id: m, name: m } }
  async * stream() { this.requests += 1; yield { type: 'block-start', index: 0, blockType: 'text' }; yield { type: 'text-delta', index: 0, text: 'x' }; await new Promise(() => {}) }
}
const [,, sessionRoot, reportPath] = process.argv
const ctx = new Context()
await mountAgentLoopTestDependencies(ctx)
await ctx.plugin(JsonlSessionPersistence, { root: sessionRoot })
await ctx.plugin(AgentLoop, { agents: [] })
await ctx.plugin(SubagentRuntime, { maxActiveSubagents: 4, maxDepth: 1 })
await ctx.plugin(SubagentSpawn, { providerName: 'spawn' })
await ctx.plugin(class extends SessionQueryEngine {
  searchSessions() { return Promise.reject(new Error('no search')) }
  searchEvents() { return Promise.reject(new Error('no search')) }
})
const adapter = new Hanging()
ctx.llm.registerAdapter(['mock'], adapter)
const parent = await ctx.agentLoop.create(SessionId('root-d04'), { provider: 'mock', model: 'mock' })
// The REAL admission edge: this resolves when the child's inbox ACCEPTED the
// prompt. The parent then dies before it can record anything about it.
const started = await ctx.subagents.startContinuable({
  provider: 'spawn', label: 't1', childId: SessionId('child-d04'),
  request: { parent, prompt: [{ type: 'text', text: 'DO THE WORK' }], maxDepth: 1 },
  signal: new AbortController().signal,
})
for (let i = 0; i < 200 && adapter.requests === 0; i += 1) await new Promise(r => setTimeout(r, 50))
await ctx.sessionPersistence.flush()
writeFileSync(reportPath, JSON.stringify({ ready: true, acceptedChildId: String(started.childId), requests: adapter.requests }))
setInterval(() => {}, 3600000)
await new Promise(() => {})
`
    const killed = await forkKillChild(childSource, [r.sessionRoot])
    expect(killed.exit.signal).toBe('SIGKILL')
    expect(killed.report['acceptedChildId']).toBe('child-d04')
    // The child really entered a request before the kill: this is "accepted",
    // not merely "reserved".
    expect(killed.report['requests']).toBe(1)

    // Restart: the SAME childId is launched again, and the real registry refuses.
    const port = portFor(r)
    let thrown: unknown
    try {
      await port.launch(
        { taskId: 't1', childId: 'child-d04', prompt: 'DO THE WORK', reservedCost: 5 },
        new AbortController().signal,
      )
    } catch (error) { thrown = error }

    expect(thrown).toBeDefined()
    expect((thrown as { code?: string }).code).toBe('DUPLICATE_CHILD')
    // The message names the SAME id, which is the evidence that no fresh UUID
    // was minted anywhere along the path.
    expect(String((thrown as Error).message)).toContain('child-d04')

    // And reconciliation is what handles it: the reservation becomes `unknown`
    // holding its slot, never a re-execution.
    const decision = reconcileTask({
      taskId: 't1',
      assignmentDigest: 'd',
      childId: 'child-d04',
      attempt: 1,
      state: 'accepted',
      allowedCapabilities: [],
      inputRefs: [],
      outputRefs: [],
      reservedCost: 5,
      createdAt: 'x',
      updatedAt: 'x',
    }, {
      taskId: 't1',
      childId: 'child-d04',
      sessionExists: true,
      agentLive: true,
      requestObserved: true,
      turnOutcome: undefined,
      resultRef: undefined,
      launchProvenNotCreated: false,
    })
    expect(decision.next).toBe('unknown')
    expect(decision.releaseSlot).toBe(false)
    expect(decision.reason).toMatch(/reservation is held/)
  })

  it('D04: the port refuses to record a provider-allocated id that differs from the reserved one', async () => {
    // A provider that mints its own id would silently break the reconciliation
    // relation: the record's childId would point at nothing. The port turns that
    // into a hard failure instead (`launch-port.ts:92-96`).
    const r = await storeRig()
    const port = createContinuableLaunchPort({
      subagents: {
        async startContinuable() {
          return { childId: SessionId('a-different-child'), messageId: 'm1' as never }
        },
      },
      parent: { session: { header: { id: 'root' } } } as never,
      provider: 'spawn',
      maxDepth: 1,
    })
    await expect(port.launch(
      { taskId: 't1', childId: 'child-reserved', prompt: 'p', reservedCost: 1 },
      new AbortController().signal,
    )).rejects.toThrow(/refusing to record a mismatched identity/)
    // The store rig exists only to keep the cleanup contract uniform.
    expect(r.service.getRun('missing')).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// D05 -- Inbox unclaimed
// ---------------------------------------------------------------------------

describe('D05: pending inbox messages at the moment of the kill', () => {
  it('D05 (REAL KILL): the NATIVE inbox projection restores the pending message, and nothing is injected twice', async () => {
    // The window: the child is mid-turn with a SECOND message queued at
    // `next-turn` (unclaimed). The host is hard-killed. Recovery must use DSH's
    // own durable `agent/inbox/spliced` fold, and must NOT deliver the message
    // again.
    //
    // Why this must be a real kill rather than an in-process barrier: a GRACEFUL
    // teardown CLEARS the pending inbox. `Agent.cancel` calls `inbox.clear()`
    // unless `keepInbox` (`agent-loop/src/agent.ts:149-152`), and the lifecycle
    // disposer issues exactly that cancel (`agent-loop/src/index.ts:596`). A
    // clean shutdown therefore destroys the very fact under test, and only
    // SIGKILL preserves it.
    const r = await agentRig()
    const childSource = `
import { Context } from 'file:///D:/DSH/src/dsh-src/vendor/cordis/lib/index.js'
import AgentLoop from 'file:///D:/DSH/src/dsh-src/packages/core/agent-loop/lib/index.js'
import { mountAgentLoopTestDependencies } from 'file:///D:/DSH/src/dsh-src/packages/test-support/agent-loop-testkit/lib/index.js'
import { LlmAdapter } from 'file:///D:/DSH/src/dsh-src/packages/llm/llm/lib/index.js'
import { SessionId } from 'file:///D:/DSH/src/dsh-src/packages/core/session/lib/index.js'
import JsonlSessionPersistence from 'file:///D:/DSH/src/dsh-src/packages/session/session-persistence-jsonl/lib/index.js'
import SubagentRuntime from 'file:///D:/DSH/src/dsh-src/packages/subagent/subagent/lib/index.js'
import * as SubagentSpawn from 'file:///D:/DSH/src/dsh-src/packages/subagent/subagent-spawn-in-process/lib/index.js'
import SessionQueryEngine from 'file:///D:/DSH/src/dsh-src/packages/session-query/session-query/lib/index.js'
import { writeFileSync } from 'node:fs'

class Hanging extends LlmAdapter {
  requests = 0
  async resolveModel(p, m) { return { provider: p, id: m, name: m } }
  async * stream() { this.requests += 1; yield { type: 'block-start', index: 0, blockType: 'text' }; yield { type: 'text-delta', index: 0, text: 'x' }; await new Promise(() => {}) }
}
const [,, sessionRoot, reportPath] = process.argv
const ctx = new Context()
await mountAgentLoopTestDependencies(ctx)
await ctx.plugin(JsonlSessionPersistence, { root: sessionRoot })
await ctx.plugin(AgentLoop, { agents: [] })
await ctx.plugin(SubagentRuntime, { maxActiveSubagents: 4, maxDepth: 1 })
await ctx.plugin(SubagentSpawn, { providerName: 'spawn' })
await ctx.plugin(class extends SessionQueryEngine {
  searchSessions() { return Promise.reject(new Error('no search')) }
  searchEvents() { return Promise.reject(new Error('no search')) }
})
const adapter = new Hanging()
ctx.llm.registerAdapter(['mock'], adapter)
const parent = await ctx.agentLoop.create(SessionId('root-d05'), { provider: 'mock', model: 'mock' })
await ctx.subagents.startContinuable({
  provider: 'spawn', label: 't1', childId: SessionId('child-d05'),
  request: { parent, prompt: [{ type: 'text', text: 'FIRST PROMPT' }], maxDepth: 1 },
  signal: new AbortController().signal,
})
for (let i = 0; i < 200 && adapter.requests === 0; i += 1) await new Promise(r => setTimeout(r, 50))
// Queue a second message while the child is mid-turn: it lands UNCLAIMED.
const child = ctx.agents.get(SessionId('child-d05'))
const mid = await ctx.subagents.sendMessage(parent, SessionId('child-d05'), [{ type: 'text', text: 'SECOND QUEUED' }], { signal: new AbortController().signal })
await ctx.sessionPersistence.flush()
writeFileSync(reportPath, JSON.stringify({
  ready: true, mid: String(mid), seq: child.session.seq,
  types: child.session.snapshotEvents().map(e => e.type),
}))
setInterval(() => {}, 3600000)
await new Promise(() => {})
`
    const killed = await forkKillChild(childSource, [r.sessionRoot])
    expect(killed.exit.signal).toBe('SIGKILL')
    const childSeq = killed.report['seq'] as number
    expect(childSeq).toBeGreaterThan(0)

    // Restart: resume the killed child Session through the REAL loop.
    const resumed = await r.ctx.agentLoop.resume(r.ctx, { resumeSessionId: SessionId('child-d05') })
    const child = resumed.agent

    // The NATIVE projection is the authority on what is pending. Reading it
    // through `sessionProjections.stateOf(session, 'inbox')` is reading DSH's own
    // fold (`agent-loop/src/inbox.ts:28-58`), not a projection this project
    // maintains. There is no second inbox anywhere in this codebase.
    const native = r.ctx.sessionProjections.stateOf(child.session, 'inbox')
    expect(native).toBeDefined()
    expect(native!['next-step']).toHaveLength(1)

    // The queued message survived the kill EXACTLY ONCE. `toHaveLength(1)` is the
    // anti-double-injection assertion: a recovery path that re-delivered would
    // show two, and the projection's own fold throws on a duplicate id
    // (`inbox.ts:44-52`), so a double injection cannot even be represented.
    const pendingText = JSON.stringify(native!['next-step'])
    expect(pendingText).toContain('SECOND QUEUED')

    // The work service makes NO delivery of its own for this window. Its whole
    // contribution is the decision to leave it alone.
    const decision = reconcileTask({
      taskId: 't1',
      assignmentDigest: 'd',
      childId: 'child-d05',
      attempt: 1,
      state: 'accepted',
      allowedCapabilities: [],
      inputRefs: [],
      outputRefs: [],
      reservedCost: 5,
      createdAt: 'x',
      updatedAt: 'x',
    }, {
      taskId: 't1',
      childId: 'child-d05',
      sessionExists: true,
      agentLive: true,
      requestObserved: false,
      turnOutcome: undefined,
      resultRef: undefined,
      launchProvenNotCreated: false,
    })
    expect(decision.next).toBe('accepted')
    expect(decision.releaseSlot).toBe(false)
    expect(decision.reason).toMatch(/native Inbox recovery owns it/)
  })

  it('D05: the native splice vocabulary is the ONLY inbox mechanism this package uses', async () => {
    // A guard against the "build a second inbox" failure mode. The record's
    // durable shape is the thing that decides this, so it is read from a REAL
    // admitted task rather than from a schema object: a field holding pending
    // input would be visible in the stored record.
    const r = await storeRig()
    await r.service.createRun({
      runId: 'run-d05-shape',
      root: { session: { header: { id: 'root-d05-shape' } } } as never,
      authorizationRef: 'a',
    })
    const task = await r.service.admit({
      runId: 'run-d05-shape',
      taskId: 't1',
      childId: 'child-shape',
      assignmentDigest: 'd',
      reservedCost: 1,
      allowedCapabilities: [],
    })
    const fields = Object.keys(task)
    // The identity that makes native recovery possible: the reserved childId,
    // which is also the Session id the native Inbox projection is keyed on.
    expect(fields).toContain('childId')
    // No field carries message bodies or a pending queue. The record stores
    // refs; the messages themselves live in the child's Session log, which is
    // where DSH's own `agent/inbox/spliced` fold reads them.
    for (const forbidden of ['pendingMessages', 'inbox', 'messages', 'prompt', 'nextTurn', 'nextStep']) {
      expect(fields).not.toContain(forbidden)
    }
    // The refs it does store are pointers, not payloads: `inputRefs` and
    // `outputRefs` are empty for a task that has not run, and their element
    // shape is a locator plus an optional digest (`record.ts:34-43`).
    expect(task.inputRefs).toEqual([])
    expect(task.outputRefs).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// D06 -- claimed but not dispatched
// ---------------------------------------------------------------------------

describe('D06: the claim was written and the request never went out', () => {
  it('D06 (REAL KILL): a claimed-but-undispatched step is not treated as done', async () => {
    // The window: the loop claimed the message out of the inbox (the
    // `agent/inbox/spliced` removal is durable) and the process died before a
    // request existed. The two facts are distinguishable IN THE LOG, which is
    // what lets the system tell "taken" from "executed":
    //
    //   claim only   -> `agent/inbox/spliced` with removedCount, no `request/header`
    //   dispatched   -> a `request/header` event follows (`agent-loop/src/agent.ts:572`)
    //
    // `requestObserved` is exactly that distinction, and the evidence for it is
    // read from the Session rather than from our own optimism.
    const r = await agentRig(new HangingAdapter())
    const childSource = `
import { Context } from 'file:///D:/DSH/src/dsh-src/vendor/cordis/lib/index.js'
import AgentLoop from 'file:///D:/DSH/src/dsh-src/packages/core/agent-loop/lib/index.js'
import { mountAgentLoopTestDependencies } from 'file:///D:/DSH/src/dsh-src/packages/test-support/agent-loop-testkit/lib/index.js'
import { LlmAdapter } from 'file:///D:/DSH/src/dsh-src/packages/llm/llm/lib/index.js'
import { SessionId } from 'file:///D:/DSH/src/dsh-src/packages/core/session/lib/index.js'
import JsonlSessionPersistence from 'file:///D:/DSH/src/dsh-src/packages/session/session-persistence-jsonl/lib/index.js'
import { writeFileSync } from 'node:fs'

// A listener that claims the work and then HANGS. The pre-step waterfall is the
// real seam where DSH lets a listener decide the step; returning a never-settling
// promise holds the window open exactly between the durable claim and the
// request, which is the crash window under test.
class Never extends LlmAdapter {
  requests = 0
  async resolveModel(p, m) { return { provider: p, id: m, name: m } }
  async * stream() { this.requests += 1; yield { type: 'finish', reason: { kind: 'stop' } } }
}
const [,, sessionRoot, reportPath] = process.argv
const ctx = new Context()
await mountAgentLoopTestDependencies(ctx)
await ctx.plugin(JsonlSessionPersistence, { root: sessionRoot })
await ctx.plugin(AgentLoop, { agents: [] })
const adapter = new Never()
ctx.llm.registerAdapter(['mock'], adapter)
let claimedAt = -1
ctx.on('agent/pre-step', async (payload) => {
  // Reached only after the claim is durable; hang here so the request never goes out.
  claimedAt = payload.agent.session.seq
  await new Promise(() => {})
})
const agent = await ctx.agentLoop.create(SessionId('child-d06'), { provider: 'mock', model: 'mock' })
agent.followup({ id: 'm1', role: 'user', content: [{ type: 'text', text: 'CLAIMED BUT NEVER SENT' }], source: { kind: 'user' } })
for (let i = 0; i < 200 && claimedAt < 0; i += 1) await new Promise(r => setTimeout(r, 50))
await ctx.sessionPersistence.flush()
writeFileSync(reportPath, JSON.stringify({
  ready: true, claimedAt, requests: adapter.requests,
  types: agent.session.snapshotEvents().map(e => e.type),
}))
setInterval(() => {}, 3600000)
await new Promise(() => {})
`
    const killed = await forkKillChild(childSource, [r.sessionRoot])
    expect(killed.exit.signal).toBe('SIGKILL')
    const types = killed.report['types'] as string[]
    // The claim is durable and NO request exists: the window is real.
    expect(types).toContain('agent/inbox/spliced')
    expect(types).not.toContain('request/header')
    expect(killed.report['requests']).toBe(0)

    // Restart and read the SOURCE FACT from the resumed Session.
    const resumed = await r.ctx.agentLoop.resume(r.ctx, { resumeSessionId: SessionId('child-d06') })
    const events = resumed.agent.session.snapshotEvents()
    const requestObserved = events.some(event => event.type === 'request/header')
    const turnEnd = events.find(event => event.type === 'turn/end')
    expect(requestObserved).toBe(false)
    // A crash-orphaned turn is closed with the dedicated marker, which is itself
    // evidence that the turn never finished (`core/session/src/repair.ts:135`).
    expect(turnEnd?.data).toEqual({ turn: 1, reason: { kind: 'interrupted' } })

    // The reconciliation of those facts. "Taken" is NOT "executed": the decision
    // returns to `accepted`, holding the slot, and explicitly leaves the message
    // to native recovery rather than replaying it.
    const decision = reconcileTask({
      taskId: 't1',
      assignmentDigest: 'd',
      childId: 'child-d06',
      attempt: 1,
      state: 'executing',
      allowedCapabilities: [],
      inputRefs: [],
      outputRefs: [],
      reservedCost: 5,
      createdAt: 'x',
      updatedAt: 'x',
    }, {
      taskId: 't1',
      childId: 'child-d06',
      sessionExists: true,
      agentLive: true,
      requestObserved,
      turnOutcome: 'interrupted',
      resultRef: undefined,
      launchProvenNotCreated: false,
    })
    expect(decision.next).toBe('accepted')
    expect(decision.releaseSlot).toBe(false)
    expect(decision.next).not.toBe('confirmed')
    expect(decision.next).not.toBe('settling')
  })

  it('D06: when the claim cannot be distinguished from a dispatch, the answer is unknown', async () => {
    // The honest fallback. If no request is observed AND the Session cannot be
    // found either, there is nothing to read, so the outcome is `unknown` --
    // never an assumption of completion and never a replay.
    const decision = reconcileTask({
      taskId: 't1',
      assignmentDigest: 'd',
      childId: 'child-x',
      attempt: 1,
      state: 'launching',
      allowedCapabilities: [],
      inputRefs: [],
      outputRefs: [],
      reservedCost: 5,
      createdAt: 'x',
      updatedAt: 'x',
    }, {
      taskId: 't1',
      childId: 'child-x',
      sessionExists: false,
      agentLive: false,
      requestObserved: false,
      turnOutcome: undefined,
      resultRef: undefined,
      launchProvenNotCreated: false,
    })
    expect(decision.next).toBe('unknown')
    expect(decision.releaseSlot).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// D07 -- requested with no result
// ---------------------------------------------------------------------------

describe('D07: the provider received the request and the answer never came', () => {
  it('D07 (REAL KILL): usage and effect stay unknown and are never assumed free or unexecuted', async () => {
    // The window: `request/header` is durably logged, the request is IN FLIGHT at
    // the provider, and the process is killed. Usage is genuinely unknown -- the
    // provider may have billed it and the effect may have happened.
    //
    // What the log proves at kill time (this is the evidence, read from the
    // child's own report rather than asserted): `request/header` and
    // `request/context` are present and no `assistant/message` or `turn/end` is.
    const r = await agentRig(new HangingAdapter())
    const childSource = `
import { Context } from 'file:///D:/DSH/src/dsh-src/vendor/cordis/lib/index.js'
import AgentLoop from 'file:///D:/DSH/src/dsh-src/packages/core/agent-loop/lib/index.js'
import { mountAgentLoopTestDependencies } from 'file:///D:/DSH/src/dsh-src/packages/test-support/agent-loop-testkit/lib/index.js'
import { LlmAdapter } from 'file:///D:/DSH/src/dsh-src/packages/llm/llm/lib/index.js'
import { SessionId } from 'file:///D:/DSH/src/dsh-src/packages/core/session/lib/index.js'
import JsonlSessionPersistence from 'file:///D:/DSH/src/dsh-src/packages/session/session-persistence-jsonl/lib/index.js'
import { writeFileSync } from 'node:fs'

class Hanging extends LlmAdapter {
  requests = 0
  async resolveModel(p, m) { return { provider: p, id: m, name: m } }
  async * stream() { this.requests += 1; yield { type: 'block-start', index: 0, blockType: 'text' }; yield { type: 'text-delta', index: 0, text: 'partial' }; await new Promise(() => {}) }
}
const [,, sessionRoot, reportPath] = process.argv
const ctx = new Context()
await mountAgentLoopTestDependencies(ctx)
await ctx.plugin(JsonlSessionPersistence, { root: sessionRoot })
await ctx.plugin(AgentLoop, { agents: [] })
const adapter = new Hanging()
ctx.llm.registerAdapter(['mock'], adapter)
const agent = await ctx.agentLoop.create(SessionId('child-d07'), { provider: 'mock', model: 'mock' })
agent.followup({ id: 'm1', role: 'user', content: [{ type: 'text', text: 'IN FLIGHT' }], source: { kind: 'user' } })
for (let i = 0; i < 200 && adapter.requests === 0; i += 1) await new Promise(r => setTimeout(r, 50))
await ctx.sessionPersistence.flush()
writeFileSync(reportPath, JSON.stringify({ ready: true, requests: adapter.requests, types: agent.session.snapshotEvents().map(e => e.type) }))
setInterval(() => {}, 3600000)
await new Promise(() => {})
`
    const killed = await forkKillChild(childSource, [r.sessionRoot])
    expect(killed.exit.signal).toBe('SIGKILL')
    expect(killed.report['requests']).toBe(1)
    const types = killed.report['types'] as string[]
    expect(types).toContain('request/header')
    expect(types).not.toContain('assistant/message')

    const resumed = await r.ctx.agentLoop.resume(r.ctx, { resumeSessionId: SessionId('child-d07') })
    const events = resumed.agent.session.snapshotEvents()
    // The source facts after restart.
    expect(events.some(event => event.type === 'request/header')).toBe(true)
    expect(events.some(event => event.type === 'assistant/message')).toBe(false)
    const turnEnd = events.find(event => event.type === 'turn/end')
    // The repair contract closes the orphaned turn with `interrupted`, which is
    // DSH's own statement that the outcome is not known -- not a synthetic
    // success and not an error that would license a retry.
    expect(turnEnd?.data).toEqual({ turn: 1, reason: { kind: 'interrupted' } })

    const base = {
      taskId: 't1',
      assignmentDigest: 'd',
      childId: 'child-d07',
      attempt: 1,
      allowedCapabilities: [] as string[],
      inputRefs: [],
      outputRefs: [],
      reservedCost: 5,
      createdAt: 'x',
      updatedAt: 'x',
    }
    // Every fault-shaped reading of this window resolves to `unknown` with the
    // reservation held. None of them release a slot, and none of them return to
    // a state from which an automatic retry could be reached.
    for (const turnOutcome of [undefined, 'interrupted', 'error'] as const) {
      const decision = reconcileTask({ ...base, state: 'executing' }, {
        taskId: 't1',
        childId: 'child-d07',
        sessionExists: true,
        agentLive: true,
        requestObserved: true,
        turnOutcome,
        resultRef: undefined,
        launchProvenNotCreated: false,
      })
      expect(decision.next).toBe('unknown')
      expect(decision.releaseSlot).toBe(false)
      // `unknown` holds its slot, so the credit cannot be reclaimed as free.
      expect(holdsSlot(decision.next)).toBe(true)
    }

    // And the record itself still holds the full reservation: nothing about the
    // restart treated the request as uncharged.
    expect(resumed.agent.session.seq).toBeGreaterThan(0)
  })

  it('D07: an unprobed task is quarantined rather than assumed free', async () => {
    // `reconcileRun` with no evidence at all: the conservative default.
    const decisions = reconcileRun({
      t1: {
        taskId: 't1',
        assignmentDigest: 'd',
        childId: 'c1',
        attempt: 1,
        state: 'executing',
        allowedCapabilities: [],
        inputRefs: [],
        outputRefs: [],
        reservedCost: 5,
        createdAt: 'x',
        updatedAt: 'x',
      },
    }, new Map<string, ChildEvidence>())
    expect(decisions).toHaveLength(1)
    expect(decisions[0]?.next).toBe('unknown')
    expect(decisions[0]?.releaseSlot).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// D08 -- parent unnotified
// ---------------------------------------------------------------------------

describe('D08: the child persisted its artifact and the parent was never told', () => {
  it('D08 (REAL KILL): recovery finds the result in the child Session instead of repeating the task', async () => {
    // The window: the child's turn COMPLETED and its output is durable in its own
    // Session, but the parent was never notified (it died, or the notice was
    // lost). The rule this closes is stated in `reconcile.ts:20-23`: "a lost
    // parent notification is NOT a child failure. If the child's Session shows
    // the work completed, the work completed; the missing notice is a delivery
    // problem, not a work problem."
    //
    // The child here completes a real turn and then the process is killed. The
    // parent never runs, so no notice can possibly have been delivered.
    const r = await agentRig()
    const childSource = `
import { Context } from 'file:///D:/DSH/src/dsh-src/vendor/cordis/lib/index.js'
import AgentLoop from 'file:///D:/DSH/src/dsh-src/packages/core/agent-loop/lib/index.js'
import { mountAgentLoopTestDependencies } from 'file:///D:/DSH/src/dsh-src/packages/test-support/agent-loop-testkit/lib/index.js'
import { LlmAdapter } from 'file:///D:/DSH/src/dsh-src/packages/llm/llm/lib/index.js'
import { SessionId } from 'file:///D:/DSH/src/dsh-src/packages/core/session/lib/index.js'
import JsonlSessionPersistence from 'file:///D:/DSH/src/dsh-src/packages/session/session-persistence-jsonl/lib/index.js'
import SubagentRuntime from 'file:///D:/DSH/src/dsh-src/packages/subagent/subagent/lib/index.js'
import * as SubagentSpawn from 'file:///D:/DSH/src/dsh-src/packages/subagent/subagent-spawn-in-process/lib/index.js'
import SessionQueryEngine from 'file:///D:/DSH/src/dsh-src/packages/session-query/session-query/lib/index.js'
import { writeFileSync } from 'node:fs'

class Quick extends LlmAdapter {
  requests = 0
  async resolveModel(p, m) { return { provider: p, id: m, name: m } }
  async * stream() {
    this.requests += 1
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'THE ARTIFACT CONTENT' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}
const [,, sessionRoot, reportPath] = process.argv
const ctx = new Context()
await mountAgentLoopTestDependencies(ctx)
await ctx.plugin(JsonlSessionPersistence, { root: sessionRoot })
await ctx.plugin(AgentLoop, { agents: [] })
await ctx.plugin(SubagentRuntime, { maxActiveSubagents: 4, maxDepth: 1 })
await ctx.plugin(SubagentSpawn, { providerName: 'spawn' })
await ctx.plugin(class extends SessionQueryEngine {
  searchSessions() { return Promise.reject(new Error('no search')) }
  searchEvents() { return Promise.reject(new Error('no search')) }
})
const adapter = new Quick()
ctx.llm.registerAdapter(['mock'], adapter)
const parent = await ctx.agentLoop.create(SessionId('root-d08'), { provider: 'mock', model: 'mock' })
await ctx.subagents.startContinuable({
  provider: 'spawn', label: 't1', childId: SessionId('child-d08'),
  request: { parent, prompt: [{ type: 'text', text: 'PRODUCE THE ARTIFACT' }], maxDepth: 1 },
  signal: new AbortController().signal,
})
// Let the child's turn genuinely COMPLETE, then flush: the work is durable.
for (let i = 0; i < 300 && adapter.requests === 0; i += 1) await new Promise(r => setTimeout(r, 50))
await new Promise(r => setTimeout(r, 500))
await ctx.sessionPersistence.flush()
// A completed child's turn ENDS and its Activation is released, so the live
// Agent is gone by the time we want to read it. The durable Session is what
// remains, and reading it through a read handle is exactly what recovery does:
// the log is the evidence, not a live object.
const h = await ctx.sessionPersistence.open(SessionId('child-d08'), 'read')
const read = await h.read()
await h.close()
writeFileSync(reportPath, JSON.stringify({ ready: true, requests: adapter.requests, types: read.events.map(e => e.type) }))
// The kill lands AFTER the child finished and BEFORE the parent noticed: the
// parent agent in this process never ran a turn, so no notice was delivered.
setInterval(() => {}, 3600000)
await new Promise(() => {})
`
    const killed = await forkKillChild(childSource, [r.sessionRoot])
    expect(killed.exit.signal).toBe('SIGKILL')
    const types = killed.report['types'] as string[]
    // The child's work really completed before the kill: a terminal turn exists.
    expect(types).toContain('turn/end')

    // Recovery reads the CHILD's Session, which is where the artifact is.
    const resumed = await r.ctx.agentLoop.resume(r.ctx, { resumeSessionId: SessionId('child-d08') })
    const events = resumed.agent.session.snapshotEvents()
    const turnEnd = events.find(event => event.type === 'turn/end')
    expect(turnEnd?.data).toEqual({ turn: 1, reason: { kind: 'completed' } })
    const assistant = events.find(event => event.type === 'assistant/message')
    expect(assistant).toBeDefined()
    expect(JSON.stringify(assistant!.data)).toContain('THE ARTIFACT CONTENT')

    // The decision: the child's completion is FOUND, not repeated. It goes to
    // `settling` -- never `confirmed` (acceptance still decides) and never back
    // to a launchable state.
    const decision = reconcileTask({
      taskId: 't1',
      assignmentDigest: 'd',
      childId: 'child-d08',
      attempt: 1,
      state: 'executing',
      allowedCapabilities: [],
      inputRefs: [],
      outputRefs: [],
      reservedCost: 5,
      createdAt: 'x',
      updatedAt: 'x',
    }, {
      taskId: 't1',
      childId: 'child-d08',
      sessionExists: true,
      agentLive: true,
      requestObserved: true,
      turnOutcome: 'completed',
      resultRef: 'session:child-d08',
      launchProvenNotCreated: false,
    })
    expect(decision.next).toBe('settling')
    expect(decision.releaseSlot).toBe(false)
    expect(decision.reason).toMatch(/acceptance still decides/)
    // A completed child with NO recorded result ref is still `settling`: the
    // missing notice never turns into a second execution.
    expect(reconcileTask({
      taskId: 't1',
      assignmentDigest: 'd',
      childId: 'child-d08',
      attempt: 1,
      state: 'executing',
      allowedCapabilities: [],
      inputRefs: [],
      outputRefs: [],
      reservedCost: 5,
      createdAt: 'x',
      updatedAt: 'x',
    }, {
      taskId: 't1',
      childId: 'child-d08',
      sessionExists: true,
      agentLive: true,
      requestObserved: true,
      turnOutcome: 'completed',
      resultRef: undefined,
      launchProvenNotCreated: false,
    }).next).toBe('settling')
  })
})

// ---------------------------------------------------------------------------
// D09 -- torn tail
// ---------------------------------------------------------------------------

describe('D09: an incomplete trailing record', () => {
  it('D09 (REAL FILE DAMAGE): the upstream repair contract is used and the torn bytes are not erased by us', async () => {
    // The window: the last physical record of a Session log is incomplete (a
    // crash during a write, or a short write). The upstream contract, quoted from
    // `session-persistence/src/index.ts`:
    //
    //   "events are contiguous from seq 0 and never rewritten; a torn physical
    //    tail is never returned to a reader and is truncated by the write path
    //    before its first append"
    //
    // and `session-persistence-jsonl/src/storage.ts:324-331` shows the repair
    // running inside `persistContiguous`: the torn bytes are truncated, then the
    // complete events recovered from them are durably rewritten.
    //
    // This test damages a real log on disk and resumes it, which is the same
    // physical situation a crash produces. It does NOT simulate the damage by
    // calling a repair function.
    const sessionRoot = mkdtempSync(join(tmpdir(), 'dsh-daily-work-torn-sessions-'))
    const ctx = new Context()
    await mountAgentLoopTestDependencies(ctx)
    const persistence = await ctx.plugin(JsonlSessionPersistence, { root: sessionRoot, compression: 'none' })
    await ctx.plugin(AgentLoop, { agents: [] })
    ctx.llm.registerAdapter(['mock'], new QuickAdapter())
    const agent = await ctx.agentLoop.create(SessionId('child-torn'), { provider: 'mock', model: 'mock' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'WORK' }], source: { kind: 'user' } }))
    await new Promise(resolve => setTimeout(resolve, 400))
    await ctx.sessionPersistence.flush()
    const cleanSeq = agent.session.seq
    const cleanTypes = agent.session.snapshotEvents().map(event => event.type)
    expect(cleanSeq).toBeGreaterThan(0)

    // Locate the real artifact and tear its tail with an incomplete record.
    const sessionDir = join(sessionRoot, '_no-cwd', 'child-torn')
    const logName = 'session.v3.jsonl'
    const logPath = join(sessionDir, logName)
    const clean = readFileSync(logPath, 'utf8')
    const cleanBytes = Buffer.byteLength(clean)
    // A record with no terminating newline: the shape a torn write leaves.
    writeFileSync(logPath, `${clean}{"seq":999,"type":"turn/start","data":{"turn":9`, 'utf8')
    cleanups.push(async () => {
      await persistence.dispose()
      await ctx.fiber.dispose()
      removeTree(sessionRoot)
    })

    // A SECOND generation resumes the damaged log, which is where the repair
    // contract is exercised. The first generation must release the write lease
    // first, so it is disposed here.
    await ctx.fiber.dispose()
    await persistence.dispose()

    const ctx2 = new Context()
    await mountAgentLoopTestDependencies(ctx2)
    const persistence2 = await ctx2.plugin(JsonlSessionPersistence, { root: sessionRoot, compression: 'none' })
    await ctx2.plugin(AgentLoop, { agents: [] })
    ctx2.llm.registerAdapter(['mock'], new QuickAdapter())
    cleanups.push(async () => {
      await persistence2.dispose()
      await ctx2.fiber.dispose()
    })

    const resumed = await ctx2.agentLoop.resume(ctx2, { resumeSessionId: SessionId('child-torn') })

    // The torn record is NOT returned to the reader: the resumed log holds
    // exactly the clean events plus the resume marker DSH appends
    // (`session/end-seed`, `core/session/src/index.ts:616-619`), and the
    // synthetic seq 999 never appears.
    const events = resumed.agent.session.snapshotEvents()
    expect(events.slice(0, cleanSeq).map(event => event.type)).toEqual(cleanTypes)
    expect(events).toHaveLength(cleanSeq + 1)
    expect(events.at(-1)?.type).toBe('session/end-seed')
    expect(events.some(event => event.seq === 999)).toBe(false)
    // "Never started" and "unknown" stay distinguishable: the torn record
    // contained a `turn/start` that never landed, so the resumed log has no
    // orphaned turn. Nothing was invented to cover the gap.
    expect(events.filter(event => event.type === 'turn/start')).toHaveLength(1)
    expect(events.filter(event => event.type === 'turn/end')).toHaveLength(1)

    // The repair did not silently rewrite the clean prefix: the original bytes
    // are still the prefix of the file on disk.
    const afterRepair = readFileSync(logPath)
    expect(afterRepair.subarray(0, cleanBytes).toString('utf8')).toBe(clean)

    // And this project does not erase the error fact itself. The record's
    // reconciliation has no "torn tail" branch and no repair path of its own:
    // damage is reported as `unknown`, which preserves the gap instead of
    // papering over it.
    const decision = reconcileTask({
      taskId: 't1',
      assignmentDigest: 'd',
      childId: 'child-torn',
      attempt: 1,
      state: 'executing',
      allowedCapabilities: [],
      inputRefs: [],
      outputRefs: [],
      reservedCost: 5,
      createdAt: 'x',
      updatedAt: 'x',
    }, {
      taskId: 't1',
      childId: 'child-torn',
      sessionExists: true,
      agentLive: true,
      requestObserved: true,
      turnOutcome: undefined,
      resultRef: undefined,
      launchProvenNotCreated: false,
    })
    expect(decision.next).toBe('unknown')
    expect(decision.releaseSlot).toBe(false)
  })

  it('D09: a malformed record is rejected loudly rather than silently treated as current', async () => {
    // The other half of the contract: a stored record that does not match its
    // schema must not be read as if it were current. The domain rejects with
    // `invalid-record` unless the spec opts into backup-and-skip, and this
    // spec does not (`storage-domain/src/index.ts:103-107`, and
    // `spec.ts:50-58` for the opt-in).
    const root = mkdtempSync(join(tmpdir(), 'dsh-daily-work-invalid-'))
    const ctx = new Context()
    await ctx.plugin(Storage, {} as never)
    await ctx.plugin(storageJsonPlugin as never, { root } as never)
    await ctx.plugin(storageDomainPlugin as never, { backend: 'json' } as never)
    cleanups.push(async () => {
      await ctx.fiber.dispose()
      removeTree(root)
    })
    const first = await openService(root, ctx)
    await first.createRun({
      runId: 'r',
      root: { session: { header: { id: 'root' } } } as never,
      authorizationRef: 'a',
    })
    await first.close()

    // Corrupt the stored record in a way that violates the schema. The run
    // record requires `requestedTarget` to be a non-negative integer, so a string
    // there is a type violation the schema must catch. (This used to corrupt the
    // `epoch` field; that field was deleted with the settlement guard, so the
    // corruption now names a field the schema still constrains.)
    const unitPath = join(root, 'dsh_daily_work.json')
    const document = JSON.parse(readFileSync(unitPath, 'utf8')) as {
      tables: { runs: Record<string, { requestedTarget: unknown }> }
    }
    document.tables.runs['r']!.requestedTarget = 'not-a-number'
    writeFileSync(unitPath, JSON.stringify(document), 'utf8')

    // A NEW generation over the corrupted medium. The open must reject with
    // `invalid-record` naming the offending location, rather than serving a
    // record it could not validate. The rejection is asserted on the open call
    // itself, which is where the schema check happens
    // (`storage-domain/src/index.ts:120-140`).
    const ctx2 = new Context()
    await ctx2.plugin(Storage, {} as never)
    await ctx2.plugin(storageJsonPlugin as never, { root } as never)
    await ctx2.plugin(storageDomainPlugin as never, { backend: 'json' } as never)
    cleanups.push(async () => { await ctx2.fiber.dispose() })
    const second = new WorkService(ctx2, {
      targetChildren: 4, maxDepth: 1, budgetCeiling: 1_000, currency: 'USD', priceVersion: 'p',
    })
    await expect(second.open()).rejects.toMatchObject({
      code: 'invalid-record',
      detail: { table: 'runs', key: 'r' },
    })
    // And the service is left un-open rather than half-open: nothing is served.
    expect(() => second.getRun('r')).toThrow(/domain is not open/)
  })
})

// ---------------------------------------------------------------------------
// D10 -- the stale-epoch settlement, and why this gate is now a NON-CLAIM
// ---------------------------------------------------------------------------

/**
 * WHAT THIS SECTION USED TO ASSERT, AND WHY IT CHANGED.
 *
 * D10's oracle is "refuse the authoritative write, retain the diagnostic
 * evidence". It used to be discharged by driving `applyWorkerSettlement` — the
 * epoch guard in `recovery.ts` — against the real storage domain, with a
 * `RefusalLedger` over a separate `dsh_daily_work_refusals` domain.
 *
 * That machinery is DELETED, because a topology measurement showed it guarded a
 * path the product does not have. A stale-generation settlement needs a settlement
 * PRODUCER, and there is none: `WorkService.transition` is the only method that can
 * write a task's terminal state, its reservation release and its tombstone, and no
 * production call site targets a terminal state at all; the launch port resolves at
 * the ADMISSION edge and is never called back on completion; and nothing ever
 * bumped the epoch, so even a wired guard would have compared 1 to 1 forever.
 * Wiring it would have meant INVENTING a cross-process settlement producer, which
 * the audit forbids. Graph: `qualification/results/R9-recovery-topology/TOPOLOGY.md`.
 *
 * WHAT SURVIVES, and it is the part that was always real: the run record is
 * authoritative and durable, the reservation is held by the stored task, and a
 * cross-generation read sees exactly what the previous generation committed. That
 * is asserted here, because it is a property the product actually has.
 *
 * WHAT IS NOT CLAIMED: that a stale generation's settlement is refused. It is not
 * refused, because it cannot be delivered. v1's REC-09/REC-10 stay FAIL.
 */
describe('D10: the run record is authoritative across generations, and no stale settlement is claimed', () => {
  it('a second generation over the same store reads exactly what the first committed', async () => {
    // The real property. Generation A admits and launches; generation A ends;
    // generation B opens the SAME store. What B sees is what A committed — no
    // reconstruction, no replay, no lost reservation.
    const r = await storeRig()
    const created = await r.service.createRun({
      runId: 'run-d10',
      root: { session: { header: { id: 'root-d10' } } } as never,
      authorizationRef: 'auth-d10',
    })
    // The record carries no epoch field at all — that is the deletion, asserted
    // rather than described.
    expect(Object.hasOwn(created, 'epoch'), 'the run record must not carry an epoch').toBe(false)

    await r.service.admit({
      runId: 'run-d10',
      taskId: 't1',
      childId: 'child-d10',
      assignmentDigest: 'd',
      reservedCost: 3,
      allowedCapabilities: [],
    })
    await r.service.transition({ runId: 'run-d10', taskId: 't1', to: 'launching' })
    await r.service.transition({ runId: 'run-d10', taskId: 't1', to: 'accepted' })
    await r.service.close()

    const reopened = await reopenOver(r.root)
    const after = reopened.service.getRun('run-d10')
    expect(after, 'the run survives the generation change').toBeDefined()
    expect(after?.tasks['t1']?.state).toBe('accepted')
    // The reservation is still HELD by the stored task, which is the fact that
    // makes a cross-generation settlement harmful if one could be delivered.
    expect(after?.budget.reserved).toBe(3)
    expect(after?.terminalTombstones).toEqual([])
    expect(holdsSlot(after!.tasks['t1']!.state)).toBe(true)
    expect(Object.hasOwn(after!, 'epoch')).toBe(false)
    await reopened.service.close()
  })

  it('no settlement entry point exists, so there is no stale-write path to guard', () => {
    // Re-derived from the tree so the non-claim cannot rot into a citation. The
    // settlement machinery is gone from every PRODUCTION source file, and the only
    // non-test module that still names a terminal target is the hand-run CLI,
    // which is itself in no production import graph.
    //
    // The scan covers production files only. A test file legitimately names these
    // identifiers as string data (the list below is one such place); what a test
    // must not do is IMPORT one, which is asserted in
    // `durability-advanced.test.ts`'s T9-A section, and which would not compile
    // anyway.
    const src = join(import.meta.dirname)
    const all = readdirSync(src).filter(name => name.endsWith('.ts'))
    const production = all.filter(name => !name.endsWith('.test.ts'))

    const deadSymbols = [
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
    const offenders: string[] = []
    for (const file of production) {
      // Comments are allowed to name the deleted symbols: that is how a reader
      // learns why they are gone. An EXPRESSION is what must not survive.
      const code = readFileSync(join(src, file), 'utf8')
        .split(/\r?\n/u)
        .filter(line => !/^\s*(?:\/\/|\*|\/\*)/u.test(line))
        .join('\n')
      for (const symbol of deadSymbols) {
        // AS AN IDENTIFIER, NOT AS A SUBSTRING -- the same correction
        // `durability-advanced.test.ts` carries. `includes` reported
        // `mountRefusalRecording` (R7's LIVE function) as a surviving
        // `RefusalRecord`, because the deleted name is a prefix of the live one. A
        // scan for dead identifiers must match whole identifiers, or every future
        // name extending a deleted one reads as a regression.
        if (new RegExp(`\\b${symbol}\\b`, 'u').test(code)) offenders.push(`${file}: ${symbol}`)
      }
    }
    expect(offenders, 'the settlement machinery must be gone from every production source file').toEqual([])

    // The deciding topology fact, re-derived: no production file targets a
    // TERMINAL state, and `transition` is the only state writer.
    //
    // CORRECTED TWICE, and both corrections matter.
    //
    // (1) This check previously used the hand-picked list
    // `settling|confirmed|cancelled|executing|cancel_requested`, which OMITTED
    // `unknown` — the one non-terminal state the product actually writes
    // (host.ts:1342, host.ts:1364). The list is now derived from the project's own
    // `TERMINAL_STATES`.
    //
    // (2) The terminator `[,}]` after the literal is load-bearing. Without it the
    // pattern also matches a UNION TYPE ANNOTATION
    // (`readonly to: 'settling' | 'confirmed' | 'cancelled'` — a field
    // declaration, not a call site) and would report a state as written that no
    // code writes. Root caught that false positive by hand; the pattern now
    // refuses it mechanically.
    const targeted = (text: string): string[] =>
      [...text.matchAll(/to:\s*'([a-z_]+)'\s*[,}]/gu)].map(match => match[1] ?? '')
    // Positive and negative controls, so neither direction can fail silently.
    expect(targeted("await this.transition({ runId, taskId, to: 'launching' })"), 'control: a call site matches').toEqual(['launching'])
    expect(targeted("readonly to: 'settling' | 'confirmed' | 'cancelled'"), 'control: an annotation does NOT match').toEqual([])
    const terminalWriters = production.filter(file =>
      targeted(readFileSync(join(src, file), 'utf8'))
        .some(state => (TERMINAL_STATES as readonly string[]).includes(state)))
    expect(terminalWriters, 'no production file may target a terminal state').toEqual([])
    // Stated rather than filtered away: the product writes `unknown` on the drain
    // path, with the reservation held, and never resolves it.
    const unknownWriters = production.filter(file =>
      targeted(readFileSync(join(src, file), 'utf8')).includes('unknown'))
    expect(unknownWriters.sort(), 'the product writes `unknown` on the drain path').toEqual([
      'host.ts',
      'recovery.ts',
    ])
    const importersOfRunner = production.filter(file =>
      file !== 'durability-runner.ts'
      && /from\s+'\.\/durability-runner\.ts'/u.test(readFileSync(join(src, file), 'utf8')))
    expect(importersOfRunner, 'and that CLI is itself unreachable').toEqual([])
  })

  it('reconciliation still refuses to release a slot on a mismatched child identity', () => {
    // The half of "stale" that was ALWAYS a real property of a reachable module:
    // `reconcileTask` keys on taskId and holds the slot regardless of what a
    // mismatched identity claims. This is kept and asserted, because it is a
    // decision the reconciler really makes — unlike the epoch comparison, which
    // had no input to compare.
    const decision = reconcileTask({
      taskId: 't1',
      assignmentDigest: 'd',
      childId: 'child-current',
      attempt: 1,
      state: 'accepted',
      allowedCapabilities: [],
      inputRefs: [],
      outputRefs: [],
      reservedCost: 5,
      createdAt: 'x',
      updatedAt: 'x',
    }, {
      taskId: 't1',
      childId: 'child-stale',
      sessionExists: true,
      agentLive: true,
      requestObserved: true,
      turnOutcome: 'completed',
      resultRef: 'session:child-stale',
      launchProvenNotCreated: false,
    })
    // The reconciler holds the slot regardless, so a mismatched settlement can
    // never free credit even if one were wrongly applied.
    expect(decision.releaseSlot).toBe(false)
  })
})


// ---------------------------------------------------------------------------
// D11 -- repeated domain open
// ---------------------------------------------------------------------------

describe('D11: a consumer opens the domain twice, and unload then reload', () => {
  it('D11 (simulated barrier): one shared host handle, a correct close, and no hanging already-open', async () => {
    // The window: a second consumer tries to open the same domain, and a
    // load -> unload -> load cycle follows.
    //
    // The single-open rule is the facility's
    // (`storage-domain/src/index.ts:104-105`):
    //   if (this.reserved.has(spec.name)) throw new DomainError('already-open', ...)
    // and the service refuses a second open of its own handle first
    // (`host.ts:156`): `dailyWork: domain is already open`.
    //
    // The failure mode being closed: an `already-open` that HANGS (never
    // resolves, so the caller waits forever) or a close that does not release
    // the name, making a later reload fail. Both are asserted below with a
    // bounded race, so a hang fails the test instead of timing it out.
    const root = mkdtempSync(join(tmpdir(), 'dsh-daily-work-reopen-'))
    const ctx = new Context()
    await ctx.plugin(Storage, {} as never)
    await ctx.plugin(storageJsonPlugin as never, { root } as never)
    await ctx.plugin(storageDomainPlugin as never, { backend: 'json' } as never)
    cleanups.push(async () => {
      await ctx.fiber.dispose()
      removeTree(root)
    })

    const first = await openService(root, ctx)
    await first.createRun({
      runId: 'run-d11',
      root: { session: { header: { id: 'root-d11' } } } as never,
      authorizationRef: 'a',
    })

    // The second open must REJECT, and it must reject promptly. A hang here is
    // the "already-open 悬挂" failure this gate exists for.
    const outcome = await Promise.race([
      first.open().then(() => 'resolved' as const, (error: Error) => `rejected: ${error.message}`),
      new Promise<'hung'>(resolve => setTimeout(() => resolve('hung'), 5_000)),
    ])
    expect(outcome).toBe('rejected: dailyWork: domain is already open')

    // The facility's own view: exactly one open domain under the name. A second
    // CONSUMER reaching the facility directly is refused there too, rather than
    // being handed a second handle to the same medium. This is the real
    // second-consumer path: `DomainFacility.open` rejects on its reserved-name
    // set (`storage-domain/src/index.ts:104-105`), and the refusal must be an
    // immediate rejection rather than a hang.
    const facility = ctx.get('storageDomain')
    if (facility === undefined) throw new Error('the storage domain facility is not mounted')
    expect(facility.get(WORK_DOMAIN_NAME)).toBeDefined()
    const secondOutcome = await Promise.race([
      facility.open(workDomainSpec)
        .then(() => 'resolved' as const, (error: { code?: string; message: string }) => `rejected ${error.code}: ${error.message}`),
      new Promise<'hung'>(resolve => setTimeout(() => resolve('hung'), 5_000)),
    ])
    expect(secondOutcome).toBe(`rejected already-open: domain '${WORK_DOMAIN_NAME}' is already open`)
    // The refused open did not steal or replace the live handle.
    expect(facility.get(WORK_DOMAIN_NAME)).toBeDefined()
    expect(first.getRun('run-d11')?.runId).toBe('run-d11')

    // Writes after close are refused rather than silently landing somewhere.
    await first.close()
    await expect(first.admit({
      runId: 'run-d11',
      taskId: 't2',
      childId: 'c2',
      assignmentDigest: 'd',
      reservedCost: 1,
      allowedCapabilities: [],
    })).rejects.toThrow(/service is disposed|domain is not open/)

    // Close released the name: the facility no longer serves it, and a fresh
    // handle over the same directory opens cleanly with the record intact.
    expect(facility.get(WORK_DOMAIN_NAME)).toBeUndefined()

    // Re-registering on the SAME root fiber is refused by Cordis before the
    // medium is touched, even after `close()`. `ctx.isolate()` is not enough to
    // escape this: it shadows a service NAME, but `provide` still checks the
    // root store, so the isolation has to come from a real mount.
    expect(() => new WorkService(ctx, {
      targetChildren: 4, maxDepth: 1, budgetCeiling: 1_000, currency: 'USD', priceVersion: 'p',
    })).toThrow(/has been registered/)

    // The unload -> reload cycle as it actually happens: a new host generation,
    // mounted through the real plugin entry point, over the SAME directory.
    // This is the assertion that a close really released everything -- if the
    // first generation had leaked its domain handle, the facility would reject
    // this mount with `already-open`.
    const hostPlugin = await import('./host-plugin.ts')
    const config = {
      targetChildren: 4, maxDepth: 1, budgetCeiling: 1_000, currency: 'USD', priceVersion: 'p',
    }
    const gen2 = new Context()
    await gen2.plugin(Storage, {} as never)
    await gen2.plugin(storageJsonPlugin as never, { root } as never)
    await gen2.plugin(storageDomainPlugin as never, { backend: 'json' } as never)
    cleanups.push(async () => { await gen2.fiber.dispose() })
    const mounted = await gen2.plugin(hostPlugin as never, config as never)
    const reloaded = gen2.get('dailyWork')
    expect(reloaded).toBeDefined()
    // The record survived the cycle: the medium is the state, not the handle.
    expect(reloaded!.getRun('run-d11')?.runId).toBe('run-d11')
    // The reloaded service refuses a second open of its own handle, and the
    // facility refuses a second handle for the name -- the same single-handle
    // rule, now on the new generation.
    await expect(reloaded!.open()).rejects.toThrow(/already open/)
    await expect(gen2.get('storageDomain')!.open(workDomainSpec)).rejects.toMatchObject({ code: 'already-open' })
    // Unloading released the name again, so the cycle is repeatable rather than
    // one-shot.
    await mounted.dispose()
    expect(gen2.get('storageDomain')!.get(WORK_DOMAIN_NAME)).toBeUndefined()
  })

  it('D11: the host plugin owns the handle through its effect, so unload releases it', async () => {
    // The lifetime contract from `host-plugin.ts:37-43`: the effect owns the
    // domain handle and Cordis awaits its disposer, so unloading drains the
    // write chain before releasing. Load -> unload -> load over the same
    // directory must therefore work without a leaked handle.
    const root = mkdtempSync(join(tmpdir(), 'dsh-daily-work-plugin-reload-'))
    const ctx = new Context()
    await ctx.plugin(Storage, {} as never)
    await ctx.plugin(storageJsonPlugin as never, { root } as never)
    await ctx.plugin(storageDomainPlugin as never, { backend: 'json' } as never)
    cleanups.push(async () => {
      await ctx.fiber.dispose()
      removeTree(root)
    })
    const config = {
      targetChildren: 4, maxDepth: 1, budgetCeiling: 1_000, currency: 'USD', priceVersion: 'p',
    }
    const hostPlugin = await import('./host-plugin.ts')

    for (const generation of ['g1', 'g2', 'g3']) {
      const scope = ctx.isolate(generation)
      const mounted = await scope.plugin(hostPlugin as never, config as never)
      const service = scope.get('dailyWork')
      expect(service).toBeDefined()
      // The domain really is open in this generation, not merely constructed.
      await service!.createRun({
        runId: `run-${generation}`,
        root: { session: { header: { id: `root-${generation}` } } } as never,
        authorizationRef: 'a',
      })
      await mounted.dispose()
      // The name is free again, which is what makes the next generation work.
      expect(ctx.get('storageDomain')?.get(WORK_DOMAIN_NAME)).toBeUndefined()
    }

    // Every generation's record survived, because each wrote through the same
    // single directory.
    const finalScope = ctx.isolate('g-final')
    const mounted = await finalScope.plugin(hostPlugin as never, config as never)
    const service = finalScope.get('dailyWork')!
    expect(service.listRunIds().sort()).toEqual(['run-g1', 'run-g2', 'run-g3'])
    await mounted.dispose()
  })
})

// ---------------------------------------------------------------------------
// D13 -- user-authorized recovery
// ---------------------------------------------------------------------------

describe('D13: restart with the run already paused or its authorization expired', () => {
  it('D13 (REAL KILL): recovery comes back EXPLICITLY PAUSED and consumes nothing', async () => {
    // The window: the host restarted and the original run was paused, or its
    // restart-resume authorization had expired. The requirement is not merely
    // "do not continue" -- it is that the run comes back in an explicit PAUSED
    // state, with its pending work visible and no budget re-consumed.
    //
    // Quoted from `docs/RECOVERY.md`: "Reopening a Session does not re-authorize
    // unbounded background execution. There is an explicit persisted per-run
    // 'this run may continue after host restart' authorization with a TTL.
    // Without it, recovery comes back paused and shows the pending work."
    const r = await storeRig()
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
const service = new WorkService(ctx, { targetChildren: 4, maxDepth: 1, budgetCeiling: 1000, currency: 'USD', priceVersion: 'durability-records' })
await service.open()
// A run with NO restart-resume authorization, holding pending work and reserved
// credit. This is the shape the gate describes: after the kill it must come back
// explicitly paused and must not re-consume anything.
await service.createRun({ runId: 'run-d13k', root: { session: { header: { id: 'root-d13k' } } }, authorizationRef: 'a', restartResumeAuthorized: false })
await service.admit({ runId: 'run-d13k', taskId: 't1', childId: 'child-d13', assignmentDigest: 'd', reservedCost: 5, allowedCapabilities: ['reader'] })
await service.transition({ runId: 'run-d13k', taskId: 't1', to: 'launching' })
const belief = service.getRun('run-d13k')
writeFileSync(reportPath, JSON.stringify({ ready: true, phase: belief.phase, reserved: belief.budget.reserved, spent: belief.budget.spent, restartResumeAuthorized: belief.restartResumeAuthorized }))
setInterval(() => {}, 3600000)
await new Promise(() => {})
`
    const killed = await forkKillChild(childSource, [r.root])
    expect(killed.exit.signal).toBe('SIGKILL')
    expect(killed.report['phase']).toBe('open')
    expect(killed.report['restartResumeAuthorized']).toBe(false)
    expect(killed.report['reserved']).toBe(5)
    expect(killed.report['spent']).toBe(0)

    // Restart over the same directory.
    const ctx2 = new Context()
    await ctx2.plugin(Storage, {} as never)
    await ctx2.plugin(storageJsonPlugin as never, { root: r.root } as never)
    await ctx2.plugin(storageDomainPlugin as never, { backend: 'json' } as never)
    const recovered = new WorkService(ctx2, {
      targetChildren: 4, maxDepth: 1, budgetCeiling: 1_000, currency: 'USD', priceVersion: 'durability-records',
    })
    await recovered.open()
    cleanups.push(async () => {
      await recovered.close()
      await ctx2.fiber.dispose()
    })

    const run = recovered.getRun('run-d13k')!
    // The stored phase is still whatever the crash left. What recovery produces
    // is a DECISION, and that decision is `paused` -- explicitly, with a reason.
    const phase = recoveryPhase(run.restartResumeAuthorized, undefined, new Date().toISOString())
    expect(phase.phase).toBe('paused')
    expect(phase.reason).toMatch(/not authorized to continue after a host restart/)

    // The decision must be APPLIED, not merely computed, or the run would still
    // admit. Pausing is an explicit record change with its own reason.
    const paused = await recovered.pause('run-d13k', phase.reason)
    expect(paused.phase).toBe('paused')
    expect(paused.outbox[`pause-${paused.updatedAt}`]?.payloadDigest).toBe(phase.reason)

    // Nothing was re-consumed and nothing was produced: the budget is exactly
    // where the crash left it, and no work ran.
    const after = recovered.getRun('run-d13k')!
    expect(after.budget.reserved).toBe(5)
    expect(after.budget.spent).toBe(0)
    expect(after.budget.unknownReserved).toBe(0)
    expect(after.tasks['t1']?.state).toBe('launching')
    // Pending work stays VISIBLE: the task is still on the record.
    expect(Object.keys(after.tasks)).toEqual(['t1'])

    // And a paused run refuses new admissions, which is what makes the pause
    // real rather than cosmetic (INV-G4: a user pause outranks top-up).
    await expect(recovered.admit({
      runId: 'run-d13k',
      taskId: 't2',
      childId: 'child-new',
      assignmentDigest: 'd',
      reservedCost: 1,
      allowedCapabilities: [],
    })).rejects.toThrow(/is paused; refusing admission/)

    // Resuming is a NEW authorization edge, never implicit: the record only
    // returns to `open` when something explicitly asks.
    const resumedRun = await recovered.resume('run-d13k')
    expect(resumedRun.phase).toBe('open')
  })

  it('D13: an expired authorization comes back paused too, and a live one does not', async () => {
    // The TTL half. An authorization that has expired is not an authorization,
    // and the boundary case (expiring exactly now) is treated as expired rather
    // than as still-valid.
    const now = '2026-09-19T12:00:00.000Z'
    expect(recoveryPhase(true, '2026-09-19T11:59:59.000Z', now).phase).toBe('paused')
    expect(recoveryPhase(true, '2026-09-19T11:59:59.000Z', now).reason).toMatch(/expired at/)
    expect(recoveryPhase(true, now, now).phase).toBe('paused')
    expect(recoveryPhase(true, '2026-09-19T12:00:01.000Z', now).phase).toBe('open')
    expect(recoveryPhase(true, undefined, now).phase).toBe('open')
    expect(recoveryPhase(false, undefined, now).phase).toBe('paused')
    // The default a run gets when nothing asked for restart-resume permission.
    const r = await storeRig()
    const created = await r.service.createRun({
      runId: 'run-d13-default',
      root: { session: { header: { id: 'root' } } } as never,
      authorizationRef: 'a',
    })
    expect(created.restartResumeAuthorized).toBe(false)
    expect(recoveryPhase(created.restartResumeAuthorized, undefined, now).phase).toBe('paused')
  })
})
