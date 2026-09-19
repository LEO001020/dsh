/**
 * B09 (signal layering) and F06 (turn-stopping cancellation).
 *
 * WHY THESE TWO GATES SHARE A FILE: both are about the same mistake — treating
 * ONE abort signal as if it meant one thing. An `AbortSignal` in this system can
 * mean at least four different things, and confusing them is how a system loses
 * published work or keeps working after its owner stopped:
 *
 *   caller stopped waiting   -> the waiting ends; the published work does not
 *   admission was refused    -> nothing was published; there is no ghost to kill
 *   the owner stopped        -> the product contract stops the work
 *   the turn was aborted     -> a clean abort, not a new correction round
 *
 * WHAT B09 CAN AND CANNOT HONESTLY CLAIM
 *
 * The gate's stimulus names three layers around a published background Job. This
 * project publishes NO background jobs (`grep -rn "ctx.jobs" src/` finds nothing;
 * the `daily-work-host` patch mounts no producer). So the Job-layer claims here
 * are made against the REAL `JobRegistry` (`@deepseek-ai/dsh-jobs-local`) and its
 * documented contract, NOT against this project's own product path. That is a
 * real, mounted registry — but it is not the same thing as this project
 * publishing work through it, and the FINDINGS file says so.
 *
 * The layers that DO exist in this project are asserted against the real
 * `WorkService.drain` and the real `LaunchPort`:
 *
 *   (a) already aborted before the drain   -> nothing is launched at all
 *   (b) aborted mid-drain by the caller    -> later launches stop, admitted work
 *                                             is NOT rolled back into a free state
 *   (c) the exact owner stops              -> the contract's own stop path
 *
 * The `JobRegistry` facts quoted below were read from the pinned source:
 *   packages/jobs/jobs/src/index.ts:36-77   the Service Definition contract
 *   packages/jobs/jobs/src/types.ts:46-91   JobStart / JobHooks
 *   docs/cookbook/adding-a-tool.md:53-55    the producer-side pre-abort rule
 *
 * WHAT F06 IS ACTUALLY ABOUT
 *
 * `agent/turn-stopping` is a SERIAL event with `{agent, turn, signal}` and NO
 * `next` (packages/core/agent/src/runtime-types.ts:381, `@mode serial`). This
 * project deliberately registers NO such hook: the plan says to add one only
 * when measurement shows a real need, and there is no measurement yet. So the
 * honest test is not "our hook cancels well" — there is no hook. It is:
 *
 *   1. the event really is serial and really has no `next`
 *   2. a real listener on a real agent receives the real turn signal, and
 *      aborting it produces a clean aborted turn with no extra model request
 *   3. a throwing listener produces an explicit error turn, not a correction round
 *   4. awaiting the agent's OWN `whenIdle()` inside the listener deadlocks, and
 *      the source shows exactly why — so this project must never do it
 *   5. this project registers no turn-stopping hook anywhere, asserted by
 *      reading its own files, so a future addition fails this test
 */
import { Context } from '@deepseek-ai/cordis'
import type { Events } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { JobId } from '@deepseek-ai/dsh-jobs'
import type { JobHooks, JobOutcome, JobSnapshot, JobStart } from '@deepseek-ai/dsh-jobs'
import LocalJobRegistry from '@deepseek-ai/dsh-jobs-local'
import { LlmAdapter, createUserMessage, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import Storage from '@deepseek-ai/dsh-storage'
import * as storageDomainPlugin from '@deepseek-ai/dsh-storage-domain'
import * as storageJsonPlugin from '@deepseek-ai/dsh-storage-json'
import { readFileSync, readdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { WorkService, type LaunchPort, type LaunchRequest } from './host.ts'
import { createContinuableLaunchPort, type SubagentsLike } from './launch-port.ts'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const PACKAGE_ROOT = join(HERE, '..')
const REPO_ROOT = join(HERE, '..', '..', '..')
/**
 * The PINNED DSH checkout.
 *
 * Hard-coded on purpose. This is the same path `link-dsh.cmd` junctions from and
 * the same commit `compatibility.lock.json` records, and the assertions that use
 * it are about DSH's OWN source, which is not vendored into this repo. A missing
 * checkout must fail loudly rather than skip: a skipped check here would turn
 * "we verified the stock listener obeys INV-L4" into "we verified nothing".
 */
const DSH_SRC = 'D:/DSH/src/dsh-src'

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  const errors: unknown[] = []
  for (const cleanup of cleanups.splice(0)) {
    try {
      await cleanup()
    } catch (error) {
      errors.push(error)
    }
  }
  if (errors.length > 0) throw new AggregateError(errors, 'cleanup failed')
})

/** An adapter that answers immediately, so a turn reaches its stop boundary. */
class QuickAdapter extends LlmAdapter {
  /** Every model request the loop actually issued. A "correction round" is a second entry. */
  readonly requests: GenerateOptions[] = []

  override async resolveModel(provider: string, model: string): Promise<{ provider: string; id: string; name: string }> {
    return { provider, id: model, name: model }
  }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    if (options.signal?.aborted) throw new Error('aborted')
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'done' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

// ---------------------------------------------------------------------------
// B09 layer (a) and (b): the signals that really exist in this project.
// ---------------------------------------------------------------------------

/**
 * A launch port that records every call AND the exact signal object it was given.
 *
 * `onCall` is the injection point for the mid-drain abort: the test aborts the
 * caller's controller from inside the first launch, which is the only way to
 * land the abort deterministically between two launches instead of racing a
 * timer.
 */
class RecordingPort implements LaunchPort {
  readonly calls: LaunchRequest[] = []
  readonly signals: AbortSignal[] = []
  onCall: ((call: number) => void) | undefined

  async launch(request: LaunchRequest, signal: AbortSignal): Promise<{ childId: string }> {
    this.calls.push(request)
    this.signals.push(signal)
    this.onCall?.(this.calls.length)
    return { childId: request.childId }
  }
}

interface WorkRig {
  readonly ctx: Context
  readonly service: WorkService
  readonly port: RecordingPort
}

/** Mount the REAL storage domain plus this project's work service. No model call. */
async function workRig(): Promise<WorkRig> {
  const storeRoot = mkdtempSync(join(tmpdir(), 'dsh-daily-signal-store-'))
  const ctx = new Context()
  await ctx.plugin(Storage, {} as never)
  await ctx.plugin(storageJsonPlugin as never, { root: storeRoot } as never)
  await ctx.plugin(storageDomainPlugin as never, { backend: 'json' } as never)

  const service = new WorkService(ctx, {
    targetChildren: 4,
    maxDepth: 1,
    budgetCeiling: 1000,
    currency: 'USD',
    priceVersion: 'signal-test',
  })
  await service.open()
  const port = new RecordingPort()
  service.setLaunchPort(port)

  cleanups.push(async () => {
    await service.close()
    await ctx.fiber.dispose()
    rmSync(storeRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  })
  return { ctx, service, port }
}

function request(n: number): LaunchRequest {
  return { taskId: `task-${n}`, childId: `child-${n}`, prompt: `work ${n}`, reservedCost: 1 }
}

describe('B09(a): an abort BEFORE publication creates no ghost', () => {
  it('a drain handed an already-aborted signal launches NOTHING and returns no outcomes', async () => {
    // The service's own guard is `if (signal.aborted) break` at the top of the
    // per-request loop (host.ts:518). An already-aborted signal must therefore
    // produce an EMPTY outcome list, not a list of refusals: nothing was even
    // considered, so there is nothing to report as refused.
    const r = await workRig()
    await r.service.createRun({ runId: 'run-pre', root: { session: { header: { id: 'root' } } } as never, authorizationRef: 'auth' })
    r.service.setReadyTasks('run-pre', 8)

    const controller = new AbortController()
    controller.abort(new Error('the caller had already given up'))

    const outcomes = await r.service.drain('run-pre', [request(0), request(1), request(2)], controller.signal)

    expect(outcomes).toEqual([])
    expect(r.port.calls).toHaveLength(0)
    // No ghost: no task record, no reservation, no consumed slot.
    const record = r.service.getRun('run-pre')
    expect(Object.keys(record?.tasks ?? {})).toEqual([])
    expect(record?.budget.reserved).toBe(0)
    expect(r.service.counts('run-pre').capacityDeficit).toBe(4)
  })

  it('a producer that refuses a pre-aborted call never reaches JobRegistry.start, so no job id exists', async () => {
    // docs/cookbook/adding-a-tool.md:55 — "A pre-aborted call is a failure
    // because no task exists whose id could satisfy the successful output
    // schema", and tool-bash enforces it BEFORE `jobs.start`
    // (packages/shell/tool-bash/src/index.ts:357-364: the `exec.signal.aborted`
    // check precedes the `jobs.start({...})` call).
    //
    // `JobStart` carries NO signal field (packages/jobs/jobs/src/types.ts:46-69),
    // so the registry cannot even be asked about a pre-aborted call: the refusal
    // happens one layer above publication. This asserts the consequence — a
    // refused call publishes no record AND consumes no id.
    const rig = await jobsRig()
    const controller = new AbortController()
    controller.abort()

    // The producer's own gate, reproduced exactly: refuse, do not call start.
    let refused = 0
    const refuseBeforeStart = (signal: AbortSignal): JobId | undefined => {
      if (signal.aborted) {
        refused += 1
        return undefined
      }
      return rig.start({ label: 'never runs' }).id
    }
    const id = refuseBeforeStart(controller.signal)

    expect(refused).toBe(1)
    expect(id).toBeUndefined()
    expect(rig.ctx.jobs.list()).toEqual([])
    // The id counter is untouched, which is the observable form of "no id was
    // ever issued": the NEXT successful start is still `bash-1`.
    expect(rig.start({ label: 'first real job' }).id).toBe('bash-1')
  })

  it('a registry preflight rejection allocates no id and never runs the producer', async () => {
    // packages/jobs/jobs/src/index.ts:74-78 — "Any preflight rejection leaves no
    // job id or execution resource. A throwing starter leaves nothing
    // registered; after it returns, registration cannot fail."
    //
    // Two distinct pre-publication failures, both asserted here: a rejection
    // from the registry's own preflight, and a producer `run()` that throws.
    const rig = await jobsRig()
    let ran = 0
    const throwing: JobStart = {
      kind: 'bash',
      label: 'boom',
      run: () => {
        ran += 1
        throw new Error('producer preflight failed')
      },
    }
    expect(() => rig.ctx.jobs.start(throwing)).toThrow('producer preflight failed')
    expect(ran).toBe(1)
    expect(rig.ctx.jobs.list()).toEqual([])

    // The registry's own refusal: no attached controller for this owner.
    const bare = new Context()
    await bare.plugin(AgentRegistry)
    await bare.plugin(LocalJobRegistry)
    let bareRan = 0
    expect(() => bare.jobs.start({
      kind: 'bash',
      label: 'unserved',
      run: () => {
        bareRan += 1
        return { cancel() {}, done: new Promise<JobOutcome>(() => {}) }
      },
    })).toThrow('no job controller serves this agent')
    expect(bareRan).toBe(0)
    expect(bare.jobs.list()).toEqual([])
    await bare.fiber.dispose()

    // Still no id consumed by either failure.
    expect(rig.start({ label: 'first real job' }).id).toBe('bash-1')
  })
})

describe('B09(b): a CALLER abort after publication ends the waiting, not the work', () => {
  it('aborting mid-drain stops further launches and rolls NOTHING back into a free state', async () => {
    // The load-bearing distinction. `drain` checks the signal only BETWEEN
    // requests (host.ts:518), so an abort can never un-admit a task that is
    // already past its atomic reservation. The slot stays held, and that is
    // correct: the child may exist, so pretending the slot is free would
    // oversubscribe exactly when the system is unhealthy.
    const r = await workRig()
    await r.service.createRun({ runId: 'run-mid', root: { session: { header: { id: 'root' } } } as never, authorizationRef: 'auth' })
    r.service.setReadyTasks('run-mid', 8)

    const controller = new AbortController()
    // Abort from inside the FIRST launch: deterministic, no timer race.
    r.port.onCall = call => {
      if (call === 1) controller.abort(new Error('caller gave up waiting'))
    }

    const outcomes = await r.service.drain('run-mid', [request(0), request(1), request(2)], controller.signal)

    // Exactly one launch reached the port; the abort stopped the rest.
    expect(r.port.calls.map(c => c.taskId)).toEqual(['task-0'])
    expect(outcomes.map(o => o.taskId)).toEqual(['task-0'])
    expect(outcomes[0]?.accepted).toBe(true)

    // The admitted task is NOT rolled back: it holds its slot and its credit.
    const record = r.service.getRun('run-mid')
    expect(record?.tasks['task-0']?.state).toBe('accepted')
    expect(record?.tasks['task-1']).toBeUndefined()
    expect(record?.tasks['task-2']).toBeUndefined()
    expect(record?.budget.reserved).toBe(1)
    expect(record?.terminalTombstones).toEqual([])
    expect(r.service.counts('run-mid').capacityDeficit).toBe(3)

    // And the run is still open: an abort of the WAIT did not close admission.
    expect(record?.phase).toBe('open')
  })

  it('aborting a caller WAIT rejects the wait only; the published work survives and still settles', async () => {
    // This is the Job-layer form of (b), on the REAL registry. The contract is
    // explicit (packages/jobs/jobs/src/index.ts:122-124): "Wait for settlement
    // or timeout without cancelling the job. Caller abort rejects only while the
    // job is live."
    //
    // The oracle's "已发布work不因等待结束丢失" is exactly this: the abort of the
    // waiter must not call the producer's `cancel`, must not move the status,
    // and must not discard the output.
    const rig = await jobsRig()
    const { id, job: p } = rig.start({ label: 'sleep 60' })

    const controller = new AbortController()
    controller.abort()
    await expect(rig.ctx.jobs.wait(id, 30_000, undefined, controller.signal)).rejects.toThrow('wait aborted')

    // The caller's abort did not touch the work.
    expect(p.cancels).toEqual([])
    expect(rig.ctx.jobs.get(id).status).toBe('running')

    // The work then completes normally and its output is still readable.
    p.settle({ status: 'completed', output: 'the real result' })
    await tick()
    expect(rig.ctx.jobs.read(id).text).toBe('the real result')
    expect(rig.ctx.jobs.get(id).status).toBe('completed')
  })

  it('the EXACT caller signal object reaches the port and the provider — never a substitute', async () => {
    // The identity assertion the gate asks for. A wrapper that built its own
    // AbortController would pass every behavioural test above while silently
    // decoupling the caller's abort from the work, so this pins object identity
    // across the whole chain: caller -> drain -> LaunchPort -> startContinuable.
    const r = await workRig()
    await r.service.createRun({ runId: 'run-ident', root: { session: { header: { id: 'root' } } } as never, authorizationRef: 'auth' })
    r.service.setReadyTasks('run-ident', 8)

    const controller = new AbortController()
    await r.service.drain('run-ident', [request(0)], controller.signal)
    expect(r.port.signals).toHaveLength(1)
    expect(r.port.signals[0]).toBe(controller.signal)

    // Now the last hop, through the REAL port into the provider seam. The
    // stand-in is typed as the real `SubagentsLike` slice, so the spec shape it
    // records cannot drift from `SubagentRuntime.startContinuable`.
    const seen: AbortSignal[] = []
    const subagents: SubagentsLike = {
      async startContinuable(spec) {
        seen.push(spec.signal)
        return { childId: spec.childId as never, messageId: 'm1' as never }
      },
    }
    const port = createContinuableLaunchPort({
      subagents,
      parent: { session: { header: { id: 'root' } } } as never,
      provider: 'spawn',
      maxDepth: 1,
    })
    await port.launch(request(0), controller.signal)
    expect(seen).toHaveLength(1)
    expect(seen[0]).toBe(controller.signal)
    expect(seen[0]).not.toBe(new AbortController().signal)
  })
})

describe('B09(c): the real OWNER stops, and the product contract stops the work', () => {
  it('disposing the exact live owner cancels its job and holds the slot until the producer settles', async () => {
    // packages/jobs/jobs/src/types.ts:56-62 — "Owning live agent. Access is
    // fenced by its session id, and agent disposal cancels and awaits the job."
    //
    // The owner here is a REAL Agent created through the registry, because
    // `ensureOwnerCleanup` validates exact instance identity
    // (jobs-local/src/index.ts:448-455) and a hand-made stub is rejected with
    // "is not the registered agent instance". That check is the reason a stale
    // reference cannot stop somebody else's work.
    const rig = await jobsRig({ withLoop: true })
    const handle = await rig.ctx.agents.create({
      sessionId: SessionId('owner-stop'),
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    const owner = handle.agent

    const { id, job: p } = rig.start({ label: 'owned work', owner })
    expect(rig.ctx.jobs.get(id, owner).status).toBe('running')

    const disposal = handle.dispose()
    let disposalSettled = false
    void disposal.then(() => { disposalSettled = true })
    await tick()

    // The contract stopped the work: cancel was called with its reason, the
    // record moved to `stopping`, and disposal is WAITING for the producer.
    expect(p.cancels).toEqual(['owner disposed'])
    expect(rig.ctx.jobs.get(id, owner).status).toBe('stopping')
    expect(disposalSettled).toBe(false)

    // `stopping` is NOT terminal and still occupies the owner's bucket
    // (jobs-local/src/index.ts:322-326 counts `running` OR `stopping`).
    expect(activeOwned(rig.ctx, owner)).toBe(1)

    p.settle({ status: 'killed' })
    await disposal
    expect(disposalSettled).toBe(true)
    expect(rig.ctx.jobs.list(owner)).toEqual([])
  })

  it('service teardown cancels and AWAITS the producer instead of dropping the record', async () => {
    // "Registrations outlive producer and controller fibers. Owner and service
    // disposal cancel live work and await compliant producers; a throwing
    // teardown cancel force-fails only the record."
    // (packages/jobs/jobs/src/index.ts:42-47)
    //
    // The await is the point: teardown that dropped the record immediately would
    // report a clean stop while the work was still running.
    const ctx = new Context()
    const fiber = await ctx.plugin(LocalJobRegistry)
    ctx.jobs.attachController('signal-test')
    const p = producer({ label: 'teardown work' })
    const id = ctx.jobs.start(p.spec)

    const teardown = fiber.dispose()
    let settled = false
    void teardown.then(() => { settled = true })
    await tick()
    expect(p.cancels).toEqual(['jobs service disposed'])
    expect(settled).toBe(false)

    p.settle({ status: 'killed' })
    await teardown
    expect(settled).toBe(true)
    await ctx.fiber.dispose()
  })
})

// ---------------------------------------------------------------------------
// B09 support: a real registry rig, and a producer whose settlement is driven.
// ---------------------------------------------------------------------------

/** Count a real owner's active records through the public read surface. */
function activeOwned(ctx: Context, owner: Agent): number {
  return ctx.jobs.list(owner).filter(j => j.status === 'running' || j.status === 'stopping').length
}

type Producer = ReturnType<typeof producer>

interface JobsRig {
  readonly ctx: Context
  /**
   * Start one producer job, recording it so teardown settles it.
   *
   * WHY THIS EXISTS RATHER THAN A BARE `ctx.jobs.start`: registry teardown
   * cancels live jobs and AWAITS their `done` (jobs-local/src/index.ts:481-487).
   * A test that leaves a job running with an unsettled `done` therefore hangs
   * the cleanup hook — which is itself a small proof of the contract, but a
   * useless way to run a suite.
   */
  start(overrides?: Partial<Omit<JobStart, 'run'>>): { id: JobId; job: Producer }
}

/**
 * Mount the REAL process-local job registry plus a real controller.
 *
 * The controller must be attached from a plugin that INJECTS `jobs`, exactly as
 * `tool-jobs` does: reading the service off a bare context throws
 * "cannot get property jobs without inject". This is the same shape the DSH
 * suite uses, and it is why the controller is a plugin rather than a direct call.
 */
async function jobsRig(options: { withLoop?: boolean } = {}): Promise<JobsRig> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  if (options.withLoop === true) {
    await ctx.plugin(AgentLoop, { agents: [] })
    ctx.llm.registerAdapter(['mock'], new QuickAdapter())
  }
  await ctx.plugin(LocalJobRegistry)
  await ctx.plugin({
    inject: ['jobs'],
    apply(pluginCtx: Context) { pluginCtx.jobs.attachController('signal-test') },
  })
  const live: Producer[] = []
  cleanups.push(async () => {
    // Settle before disposing: disposal waits for every live producer, so a
    // deliberately-unsettled job would stall teardown rather than test it.
    for (const job of live.splice(0)) job.settle({ status: 'killed' })
    await ctx.fiber.dispose()
  })
  return {
    ctx,
    start(overrides = {}) {
      const job = producer(overrides)
      live.push(job)
      return { id: ctx.jobs.start(job.spec), job }
    },
  }
}

/** Let a settlement continuation (`done.then`) run. */
const tick = (): Promise<void> => new Promise(resolve => { setTimeout(resolve, 0) })

/**
 * A controllable producer: settle its `done` on demand and record cancels.
 *
 * `done` deliberately never rejects here. A rejecting `done` is a producer
 * contract violation the registry contains and force-fails
 * (jobs-local/src/index.ts:180-184), which is a different fact from the one
 * these tests are about.
 */
function producer(overrides: Partial<Omit<JobStart, 'run'>> = {}) {
  let settle!: (outcome: JobOutcome) => void
  const cancels: (string | undefined)[] = []
  const hooks: JobHooks = {
    cancel(reason) { cancels.push(reason) },
    done: new Promise<JobOutcome>(resolve => { settle = resolve }),
  }
  const spec: JobStart = {
    kind: overrides.kind ?? 'bash',
    label: overrides.label ?? 'scripted work',
    ...(overrides.owner === undefined ? {} : { owner: overrides.owner }),
    ...(overrides.outputLimitBytes === undefined ? {} : { outputLimitBytes: overrides.outputLimitBytes }),
    run: () => hooks,
  }
  return { spec, settle, cancels }
}

// ---------------------------------------------------------------------------
// F06: turn-stopping.
// ---------------------------------------------------------------------------

interface TurnRig {
  readonly ctx: Context
  readonly agent: Agent
  readonly adapter: QuickAdapter
}

/** Boot the production agent loop with a scripted provider. No subagents needed. */
async function turnRig(sessionId: string): Promise<TurnRig> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  const adapter = new QuickAdapter()
  ctx.llm.registerAdapter(['mock'], adapter)
  const agent = await ctx.agentLoop.create(SessionId(sessionId), { provider: 'mock', model: 'mock' })
  cleanups.push(async () => {
    // Order matters: a turn parked inside a listener cannot be torn down, so
    // cancel first, then let the driver converge, then dispose.
    agent.cancel({ kind: 'user' })
    await ctx.fiber.dispose()
  })
  return { ctx, agent, adapter }
}

/** Every durable turn outcome in the session log, in order. */
function turnEnds(agent: Agent): unknown[] {
  return agent.session.snapshotEvents()
    .filter(event => event.type === 'turn/end')
    .map(event => (event.type === 'turn/end' ? event.data.reason : undefined))
}

function send(agent: Agent, text: string): void {
  agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
}

// A COMPILE-TIME assertion, not a runtime one. `Parameters<...>['length']` is a
// literal for a tuple, so this line stops compiling the moment a `next`
// parameter is added to the event. A `next` would make this a waterfall whose
// listeners must call `next()` to delegate (INV-L5), and every listener written
// against the serial shape would silently stop delegating.
type TurnStoppingParams = Parameters<Events['agent/turn-stopping']>
const turnStoppingTakesNoNext: TurnStoppingParams['length'] extends 1 ? true : never = true

// The same assertion for the payload: exactly `{agent, turn, signal}`.
const turnStoppingPayload: TurnStoppingParams[0] = {
  agent: null as unknown as Agent,
  turn: 0,
  signal: new AbortController().signal,
}

// `JobStart` must not grow a `signal` field. If it did, the pre-abort rule would
// move from the producer into the registry and layer (a) would change meaning.
type JobStartHasSignal = 'signal' extends keyof JobStart ? never : true
const jobStartCarriesNoSignal: JobStartHasSignal = true

describe('F06: agent/turn-stopping is a serial terminal checkpoint', () => {
  it('is declared serial with {agent, turn, signal} and no next, and dispatches that way', async () => {
    // Source of truth: packages/core/agent/src/runtime-types.ts:381 —
    //   'agent/turn-stopping'(this: Scoped<Agent>, payload:
    //     { agent: Agent; turn: number; signal: AbortSignal }): Promise<void> | void
    // with `@mode serial`. Dispatch site:
    // packages/core/agent-loop/src/agent.ts:317 —
    //   await this.dispatch.serial('agent/turn-stopping', { turn, signal })
    //
    // The compile-time assertions above prove the SHAPE. This test proves the
    // DISPATCH matches it, on a real turn: a serial event passes the listener
    // exactly one argument (the payload) and waits for it, while a waterfall
    // passes the payload PLUS `next`. Both are measured here so the contrast is
    // evidence rather than an assumption.
    expect(turnStoppingTakesNoNext).toBe(true)
    expect(turnStoppingPayload.turn).toBe(0)
    expect(jobStartCarriesNoSignal).toBe(true)

    const r = await turnRig('f06-shape')
    const order: string[] = []
    let release: () => void = () => {}
    const gate = new Promise<void>(resolve => { release = resolve })

    // A `function` expression (not an arrow) so `arguments.length` reports what
    // the dispatcher actually passed.
    ctxOnTurnStopping(r.ctx, function (payload) {
      order.push(`stopping-start:${arguments.length}`)
      return gate.then(() => { order.push('stopping-end') })
    })
    r.ctx.on('agent/turn-stopping', function () {
      order.push(`stopping-second:${arguments.length}`)
    })
    // The control: `agent/pre-step` IS a waterfall, so its listener receives the
    // payload AND a `next` callback. Same `function`-expression trick, so both
    // counts come from the same measurement.
    r.ctx.on('agent/pre-step', function (_payload, next) {
      order.push(`pre-step:${arguments.length}`)
      return next()
    })

    send(r.agent, 'go')
    await new Promise(resolve => { setTimeout(resolve, 100) })
    order.push('|gate-still-closed|')
    release()
    await r.agent.whenIdle()

    // Serial: the second listener had not run while the first was parked, and
    // the turn could not close until the first settled.
    expect(order).toEqual([
      'pre-step:2',
      'stopping-start:1',
      '|gate-still-closed|',
      'stopping-end',
      'stopping-second:1',
    ])
    expect(turnEnds(r.agent)).toEqual([{ kind: 'completed' }])
  })

  it('hands a real listener the real turn signal, and aborting it produces a clean aborted turn', async () => {
    // The oracle's first arm: "中止" — an abort. What must NOT happen is a new
    // correction round: the loop must not answer the abort by opening another
    // step to fix things. `adapter.requests` is the measure: one request means
    // one model call for the whole turn.
    const r = await turnRig('f06-abort')
    const seen: Array<{ sameAgent: boolean; turn: number; abortedBefore: boolean; abortedAfter: boolean }> = []

    r.ctx.on('agent/turn-stopping', ({ agent: subject, turn, signal }) => {
      const abortedBefore = signal.aborted
      // Abort the turn from inside the checkpoint. The loop re-checks the signal
      // immediately after the serial dispatch (`signal.throwIfAborted()`,
      // agent.ts:318), so this must land as an aborted turn and nothing else.
      subject.cancel({ kind: 'user' })
      seen.push({ sameAgent: subject === r.agent, turn, abortedBefore, abortedAfter: signal.aborted })
    })

    send(r.agent, 'go')
    await r.agent.whenIdle()

    expect(seen).toHaveLength(1)
    expect(seen[0]).toEqual({ sameAgent: true, turn: 1, abortedBefore: false, abortedAfter: true })
    expect(turnEnds(r.agent)).toEqual([{ kind: 'aborted', reason: { kind: 'user' } }])
    // ONE request: no correction round was opened to compensate for the abort.
    expect(r.adapter.requests).toHaveLength(1)
    // And the agent is genuinely idle with nothing queued behind the abort.
    expect(r.agent.status).toBe('idle')
    expect(r.agent.inbox.nextTurn).toHaveLength(0)
  })

  it('a throwing listener produces an explicit error turn, not a correction round', async () => {
    // The oracle's second arm: "明确错误". A serial dispatch propagates a
    // listener throw into the turn's own failure path, so the turn ends as an
    // error rather than as a silent success — and, again, without a retry step.
    const r = await turnRig('f06-throw')
    const errors: string[] = []
    r.ctx.on('agent/error', ({ error }) => { errors.push(String((error as Error).message)) })
    r.ctx.on('agent/turn-stopping', () => { throw new Error('hook blew up') })

    send(r.agent, 'go')
    await r.agent.whenIdle()

    expect(turnEnds(r.agent)).toEqual([
      { kind: 'error', error: { message: 'hook blew up', code: 'UNKNOWN' } },
    ])
    expect(errors).toEqual(['hook blew up'])
    expect(r.adapter.requests).toHaveLength(1)
    expect(r.agent.status).toBe('idle')
  })

  it('awaiting the agent OWN whenIdle inside the listener deadlocks — and the source shows why', async () => {
    // INV-L4. The event's own documentation states the rule
    // (packages/core/agent/src/runtime-types.ts:252-254): "listeners must not
    // await agent.whenIdle() or their own owner's disposal."
    //
    // THE CYCLE, read from packages/core/agent-loop/src/agent.ts:
    //   :211-216  whenIdle() loops until `this.activityDone` stops changing
    //   :198-208  `activityDone` is the driver promise, resolved only by
    //             `kick()` returning (`...then(driver.resolve, driver.reject)`)
    //   :228      kick() is `while (await this.turn()) {}`
    //   :317      turn() awaits the serial `agent/turn-stopping` dispatch
    // So awaiting whenIdle() inside the listener waits for the driver that is
    // waiting for the listener. It cannot resolve, and neither can disposal,
    // which awaits the same driver.
    //
    // The listener here races whenIdle() against the turn signal so the test can
    // still unwind — the deadlock itself is proven by the timeout below, not by
    // hanging the suite.
    const r = await turnRig('f06-deadlock')
    let entered = false
    r.ctx.on('agent/turn-stopping', async ({ signal }) => {
      entered = true
      await Promise.race([
        r.agent.whenIdle(),
        new Promise<void>(resolve => { signal.addEventListener('abort', () => { resolve() }, { once: true }) }),
      ])
    })

    const idle = r.agent.whenIdle()
    send(r.agent, 'go')
    const race = await Promise.race([
      idle.then(() => 'idle'),
      new Promise<string>(resolve => { setTimeout(() => { resolve('deadlocked') }, 700) }),
    ])

    expect(entered).toBe(true)
    expect(race).toBe('deadlocked')
    expect(r.agent.status).toBe('running')
    // The turn never reached its boundary: no `turn/end` was appended at all.
    expect(turnEnds(r.agent)).toEqual([])

    // Cancelling the turn is the way out, and it is also what makes teardown
    // possible at all: without it the driver would never converge.
    r.agent.cancel({ kind: 'user' })
    await idle
    expect(turnEnds(r.agent)).toEqual([{ kind: 'aborted', reason: { kind: 'user' } }])
  })

  it('this project registers no turn-stopping hook of its own', async () => {
    // The plan's rule: add a turn-stopping hook only when measurement shows a
    // real need. There is no such measurement, so the CORRECT state of this
    // project is "no hook" — and that is a property worth asserting, because a
    // hook added without the care above (no whenIdle, no self-disposal, no
    // unbounded steering) would be a silent regression, not a test failure.
    //
    // The scan is over the project's OWN files, resolved from this test's
    // location, so it cannot pass by looking somewhere else.
    const scanned: string[] = []
    const offenders: string[] = []
    const scan = (path: string): void => {
      scanned.push(path)
      const text = readFileSync(path, 'utf8')
      // The string appears in THIS test file by necessity; the filter below
      // excludes `*.test.ts` so the assertion is about production code.
      if (text.includes('turn-stopping')) offenders.push(path)
    }

    const srcDir = HERE
    for (const name of readdirSync(srcDir)) {
      if (!name.endsWith('.ts') || name.endsWith('.test.ts')) continue
      scan(join(srcDir, name))
    }
    scan(join(PACKAGE_ROOT, 'cordis.patch.yml'))
    for (const profile of ['daily-candidate', 'stock-canary']) {
      scan(join(REPO_ROOT, 'profiles', profile, 'cordis.patch.yml'))
      scan(join(REPO_ROOT, 'profiles', profile, 'package.json'))
    }

    expect(scanned.length).toBeGreaterThan(10)
    expect(offenders).toEqual([])

    // Registering a turn-stopping listener is also possible INDIRECTLY, by
    // mounting a stock bridge that does it (packages/hooks/*/src/index.ts).
    // This project must not name one: those bridges force-continue turns
    // (`agent.steer(...)` on a deny decision) and hooks-codex carries an
    // explicit stop-loop-guard TODO for exactly that reason.
    for (const path of scanned.filter(p => p.endsWith('.yml') || p.endsWith('package.json'))) {
      expect(readFileSync(path, 'utf8')).not.toMatch(/dsh-hooks/)
    }
  })

  it('records, honestly, that the daily profile DOES inherit one stock listener', async () => {
    // THE FINDING THIS GATE MUST NOT HIDE. "This project registers no
    // turn-stopping hook" is true and is asserted above — but it is NOT the same
    // as "nothing listens to this event in the daily profile".
    //
    // The daily-candidate profile composes the `dsh-base` + `dsh-web-app`
    // bundles (profiles/daily-candidate/package.json), and the web-app bundle
    // mounts a stock consumer:
    //   packages/bundle/web-app/cordis.patch.yml:300-301
    //     - id: workspace-changes
    //       name: '@deepseek-ai/dsh-workspace-changes'
    // which registers a real listener:
    //   packages/deliverables/workspace-changes/src/index.ts:153-155
    //     ctx.on('agent/turn-stopping', async ({ agent, turn }) => {
    //       await recorders.get(agent.session)?.stopping(turn)
    //     })
    //
    // This is a STOCK component this project deliberately did not remove (see
    // the "NOT changed here, on purpose" section of the profile patch), so it is
    // not a violation. But it means F06's stimulus is not hypothetical: a real
    // listener runs at the turn's stop boundary in the daily profile, and its
    // `stopping()` call does real work (a git working-tree snapshot) inside the
    // serial dispatch, which is why the abort semantics above matter.
    //
    // The one thing that WOULD be a violation is that listener awaiting its own
    // `whenIdle()`. It does not: `recorder.stopping(turn)` enqueues a bounded
    // record and returns (packages/deliverables/workspace-changes/src/recorder.ts:184-187).
    // Asserted against the pinned source rather than taken on trust.
    const profileManifest = readFileSync(join(REPO_ROOT, 'profiles', 'daily-candidate', 'package.json'), 'utf8')
    expect(profileManifest).toContain('@deepseek-ai/dsh-web-app')

    const webAppBundle = join(DSH_SRC, 'packages', 'bundle', 'web-app', 'cordis.patch.yml')
    const bundleText = readFileSync(webAppBundle, 'utf8')
    expect(bundleText).toContain('@deepseek-ai/dsh-workspace-changes')

    const stockListener = join(DSH_SRC, 'packages', 'deliverables', 'workspace-changes', 'src', 'index.ts')
    const listenerText = readFileSync(stockListener, 'utf8')
    expect(listenerText).toContain("ctx.on('agent/turn-stopping'")

    // INV-L4, checked on the LISTENER BODY rather than the whole file. The file
    // does contain `dispose()` — `forget()` calls `recorder.dispose()` from the
    // effect teardown and the `session/disposed` listener — so a whole-file
    // search would be a false positive. What must not appear is either await
    // INSIDE the turn-stopping handler, which is the deadlock window.
    const body = listenerText.split("ctx.on('agent/turn-stopping'")[1] ?? ''
    const listenerBody = body.slice(0, body.indexOf('\n  })'))
    expect(listenerBody).toContain('stopping(turn)')
    expect(listenerBody).not.toContain('whenIdle')
    expect(listenerBody).not.toContain('dispose')
  })
})

/**
 * Register a turn-stopping listener and keep the dispatcher's real argument
 * count observable.
 *
 * `ctx.on` types the handler from the event map, so an extra declared parameter
 * would be a type error; the `function` expression is what lets the body read
 * `arguments.length` and report what the dispatcher actually passed.
 */
function ctxOnTurnStopping(
  ctx: Context,
  handler: (payload: TurnStoppingParams[0]) => void | Promise<void>,
): void {
  ctx.on('agent/turn-stopping', handler)
}
