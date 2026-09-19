/**
 * The scheduling gates: C01, C02, C03, C04, C07, C09.
 *
 * This file drives the REAL production `AgentLoop`, the real `ctx.subagents`
 * registry with its continuable machinery, the real in-process spawn provider,
 * a real durable JSONL Session per child, and the real storage domain. The only
 * controlled boundary is the model provider (a scripted adapter), because the
 * plan forbids building a second model loop to fake children.
 *
 * WHY A NEW FILE RATHER THAN MORE CASES IN concurrency.test.ts. That file proves
 * ADMISSION (ten children accepted through the real seam). These gates are about
 * SCHEDULING AFTER admission: refill on a single completion, storm behaviour,
 * deficit reporting, occupancy while a cancel is unconfirmed, and the bounded
 * reaction to provider limits. Three of them need machinery that file does not
 * have: per-child model gates with a recorded timeline (C02), a mounted
 * `llm-retry` so "bounded backoff" is an observed fact rather than an inert
 * policy object (C09), and a small-ceiling run (C09).
 *
 * TIER. C01 is closed at T1 here and stays BLOCKED_EXTERNAL at T5: with a
 * scripted provider this is "production DSH services + controlled provider", not
 * "an authorized live provider running ten real children". That distinction is
 * the reason this file must not promote C01's gate status.
 *
 * WHAT IS NOT ASSERTED, AND WHY. No numeric SLO is asserted for C02. The gate
 * asks for a replacement "within a frozen SLO"; no SLO is frozen anywhere in
 * this repository, so asserting one here would make the test the author of the
 * standard it is judged against. The measured latency is RECORDED in the test
 * output and reported in FINDINGS.md instead.
 */
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { LlmAdapter, LlmError, resolveRetryPolicy } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, ResolvedRetryPolicy, StreamChunk } from '@deepseek-ai/dsh-llm'
import * as LlmRetry from '@deepseek-ai/dsh-llm-retry'
import { startMockLlmServer } from '@deepseek-ai/dsh-llm-mock-server'
import type { MockLlmServer } from '@deepseek-ai/dsh-llm-mock-server'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SessionQueryEngine from '@deepseek-ai/dsh-session-query'
import SubagentRuntime, { delegationDepthOf } from '@deepseek-ai/dsh-subagent'
import type { SubagentListEntry, SubagentRunEndInfo } from '@deepseek-ai/dsh-subagent'
import * as SubagentSpawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import Storage from '@deepseek-ai/dsh-storage'
import * as storageDomainPlugin from '@deepseek-ai/dsh-storage-domain'
import * as storageJsonPlugin from '@deepseek-ai/dsh-storage-json'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { WorkService, type LaunchRequest } from './host.ts'
import { createContinuableLaunchPort } from './launch-port.ts'
import { holdsSlot } from './states.ts'

/** The user's target. Never lowered to make a case pass. */
const N = 10

/**
 * A model adapter that can hold ANY SUBSET of children open, per child.
 *
 * The gate is keyed on `GenerateOptions.sessionId`, which the production loop
 * stamps with `this.session.id`
 * (packages/core/agent-loop/src/agent.ts:615 `sessionId: this.session.id`), so
 * "hold child 7" is addressed by the child's own durable id rather than by a
 * call-order guess. That is what makes "nine still running, one finishes" a
 * scheduled fact instead of a race.
 *
 * Holding is the default because C01/C03/C04 need children resident
 * simultaneously; C02 and C03 release exactly the children they name.
 */
class PerChildGateAdapter extends LlmAdapter {
  /** Every model request this adapter has seen, in arrival order, with its session. */
  readonly requests: Array<{ readonly sessionId: string; readonly at: number }> = []
  private readonly gates = new Map<string, PromiseWithResolvers<void>>()
  /** Field name is deliberately not `openAll`: a class field would shadow the method. */
  private released = false

  private gateFor(sessionId: string): Promise<void> {
    if (this.released) return Promise.resolve()
    let gate = this.gates.get(sessionId)
    if (gate === undefined) {
      gate = Promise.withResolvers<void>()
      this.gates.set(sessionId, gate)
    }
    return gate.promise
  }

  /** Let exactly one child's held model call complete. */
  release(sessionId: string): void {
    this.gates.get(sessionId)?.resolve()
  }

  /** Let every held and every future model call complete. */
  openAll(): void {
    this.released = true
    for (const gate of this.gates.values()) gate.resolve()
  }

  /** Distinct session ids that have reached a model request, in first-seen order. */
  get distinctSessions(): string[] {
    return [...new Set(this.requests.map(entry => entry.sessionId))]
  }

  override async resolveModel(provider: string, model: string): Promise<{ provider: string; id: string; name: string }> {
    return { provider, id: model, name: model }
  }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const sessionId = String(options.sessionId)
    this.requests.push({ sessionId, at: Date.now() })
    await this.gateFor(sessionId)
    if (options.signal?.aborted) throw new Error('aborted')
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: `done ${sessionId}` } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

/**
 * An adapter that refuses every request the way a rate-limited provider does.
 *
 * `providerRetryPolicy` is overridden rather than left to the default because
 * the DEFAULT normal policy is five retries with a 500ms initial delay and
 * `jitterRatio` 0.1 (packages/llm/llm/src/retry-policy.ts:11-19). Left alone, a
 * sustained 429 across ten children would spend tens of seconds in jittered
 * backoff and the case would measure this machine's patience instead of the
 * scheduler's behaviour. A bounded policy with a test-sized clock has the same
 * SHAPE (normal mode, finite `maxRetries`, RATE_LIMIT retryable) and the same
 * stopping rule, which is the property under test.
 */
class RateLimitedAdapter extends LlmAdapter {
  attempts = 0
  private readonly policy: ResolvedRetryPolicy = resolveRetryPolicy({
    mode: 'normal',
    maxRetries: 2,
    retryableCodes: ['RATE_LIMIT', 'SERVER', 'TRANSPORT', 'TIMEOUT'],
    backoff: { initialDelayMs: 5, maxDelayMs: 10, jitterRatio: 0 },
  }, 'scheduling test provider retryPolicy')

  override providerRetryPolicy(_provider: string): ResolvedRetryPolicy {
    return this.policy
  }

  override async resolveModel(provider: string, model: string): Promise<{ provider: string; id: string; name: string }> {
    return { provider, id: model, name: model }
  }

  async * stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.attempts += 1
    // The code is the one the real adapter derives from HTTP 429
    // (packages/llm/llm-deepseek/src/protocols/chat-completions/adapter.ts:102
    // `if (status === 429) return 'RATE_LIMIT'`), so the classification the
    // scheduler reacts to is the production one and not a private invention.
    throw new LlmError('mock rate limit', 'RATE_LIMIT')
  }
}

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

interface Rig {
  readonly ctx: Context
  readonly root: Agent
  readonly service: WorkService
  readonly adapter: PerChildGateAdapter
  /** Every real `subagent/end` edge, in order. */
  readonly ends: SubagentRunEndInfo[]
  /**
   * Every durable Session event observed on the live bus, tagged with its
   * session. Recorded AT EVENT TIME so a claim about a child's own log survives
   * that child's disposal: a settled activation is removed from the live
   * Session store, so `ctx.sessions.get()` after the fact returns undefined and
   * would silently turn a real assertion into a vacuous one.
   */
  readonly sessionEvents: Array<{ readonly sessionId: string; readonly event: SessionEvent }>
}

interface RigOptions {
  /** Hard ceiling for the run's budget. Defaults to a comfortable 10000. */
  readonly budgetCeiling?: number
  /**
   * Mount `@deepseek-ai/dsh-llm-retry`. Without it a provider's `retryPolicy`
   * is captured in the registration and never executed, so "bounded backoff"
   * would be an assertion about a data structure rather than about behaviour.
   */
  readonly withRetry?: boolean
}

/**
 * Boot the real stack. `maxActiveSubagents` is N, which is the same setting the
 * C2 profile patch writes (packages/dsh-daily-work/cordis.patch.yml, DIFFERENCE
 * 1); passing it directly is that value reaching the same service.
 */
async function rig(options: RigOptions = {}): Promise<Rig> {
  const sessionRoot = mkdtempSync(join(tmpdir(), 'dsh-daily-sched-sessions-'))
  const storeRoot = mkdtempSync(join(tmpdir(), 'dsh-daily-sched-store-'))

  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  const persistence = await ctx.plugin(JsonlSessionPersistence, { root: sessionRoot })
  if (options.withRetry === true) await ctx.plugin(LlmRetry, {})
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(SubagentRuntime, { maxActiveSubagents: N, maxDepth: 1 })
  await ctx.plugin(SubagentSpawn, { providerName: 'spawn' })
  // `listChildren` needs the sessionQuery service for its corpus. A concrete
  // engine with search unavailable is enough: only point reads are used, and
  // this is the same shape DSH's own continuation tests use.
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

  const adapter = new PerChildGateAdapter()
  ctx.llm.registerAdapter(['mock'], adapter)

  const ends: SubagentRunEndInfo[] = []
  ctx.on('subagent/end', (info: SubagentRunEndInfo) => {
    ends.push(info)
  })
  // The durable firehose, captured at event time (see `Rig.sessionEvents`).
  const sessionEvents: Array<{ readonly sessionId: string; readonly event: SessionEvent }> = []
  ctx.on('session/event', (session: Session, event: SessionEvent) => {
    sessionEvents.push({ sessionId: String(session.header.id), event })
  })

  const root = await ctx.agentLoop.create(SessionId('root-scheduling'), { provider: 'mock', model: 'mock' })
  const service = new WorkService(ctx, {
    targetChildren: N,
    maxDepth: 1,
    budgetCeiling: options.budgetCeiling ?? 10_000,
    currency: 'USD',
    priceVersion: 'scheduling-test',
  })
  await service.open()

  cleanups.push(async () => {
    // Teardown ORDER matters. Children parked inside a held model call cannot be
    // disposed: their driver is waiting on the gate, and disposing the fiber
    // waits for that driver. So: release the gate, close the service, drain the
    // family, then dispose persistence and the context. This is also the
    // production shutdown order.
    //
    // The temp directories are removed in a `finally` because the teardown
    // itself can throw (a child that refuses to settle, a domain that will not
    // close). Without the `finally`, one failing case leaves its directories
    // behind for the whole session -- observed as 32 orphans after the early
    // red runs of this file. A rig that leaks on failure is a rig whose
    // failures are hard to distinguish from a machine that is merely full.
    try {
      adapter.openAll()
      await service.close()
      await ctx.subagents.drainContinuableDescendants([root])
      await persistence.dispose()
      await ctx.fiber.dispose()
    } finally {
      rmSync(sessionRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
      rmSync(storeRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    }
  })

  return { ctx, root, service, adapter, ends, sessionEvents }
}

/** Install the REAL launch port over the live subagent registry. */
function portFor(r: Rig, agentOptions?: { readonly provider: string; readonly model: string }) {
  return createContinuableLaunchPort({
    subagents: r.ctx.subagents,
    parent: r.root,
    provider: 'spawn',
    maxDepth: 1,
    ...(agentOptions === undefined ? {} : { agentOptions }),
  })
}

/** `count` independent launch requests, numbered from `offset`. */
function requests(count: number, offset = 0): LaunchRequest[] {
  return Array.from({ length: count }, (_, i) => {
    const n = offset + i
    return { taskId: `task-${n}`, childId: `child-${n}`, prompt: `independent work item ${n}`, reservedCost: 1 }
  })
}

/** The task id paired with a `child-<n>` id, so a case never guesses the pairing. */
function taskOf(childId: string): string {
  return `task-${childId.slice('child-'.length)}`
}

/** Poll a condition, because the real registry settles on its own schedule. */
async function waitFor(condition: () => boolean, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (condition()) return
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  if (!condition()) throw new Error(`timed out after ${timeoutMs}ms waiting for ${what}`)
}

/** Live children of the root, read from the REAL registry. */
function liveChildIds(r: Rig): string[] {
  return r.ctx.agents.list()
    .filter(agent => agent.session.header.parentSession === r.root.id)
    .map(agent => String(agent.id))
}

/**
 * Distinct sessions that reached a model request, EXCLUDING the root.
 *
 * The root is excluded because it is not a child and must never be counted as
 * one, but it is not silent either: DSH's continuation manager delivers a
 * settlement message to the parent when a child ends
 * (packages/subagent/subagent/src/continuation-activation.ts:870-880
 * `notifySettlement` -> `parent.inject(message)`), which wakes the root and
 * gives it a real turn of its own. That turn is a model request carrying the
 * ROOT's session id, so a naive "distinct sessions" count would silently
 * include the root in the ten.
 */
function childRequestSessions(r: Rig): string[] {
  return r.adapter.distinctSessions.filter(id => id !== String(r.root.id))
}

/** Distinct sessions that reached a model request and are the ROOT's own. */
function rootRequestSessions(r: Rig): string[] {
  return r.adapter.distinctSessions.filter(id => id === String(r.root.id))
}

/**
 * Children the REAL subagent listing reports for this root.
 *
 * NOTE the reading: `listChildren` is a DURABLE enumeration. A child whose
 * activation was disposed still appears, reported as `activity: 'inactive'`
 * (packages/subagent/subagent/src/list-children.ts, cold path through the
 * Session query corpus). So this list is the right instrument for "which
 * distinct children ever existed" and the WRONG instrument for "how many slots
 * are occupied". Occupancy comes from `liveChildIds` and from the run record.
 */
function listedChildren(r: Rig): Promise<SubagentListEntry[]> {
  return r.ctx.subagents.listChildren(r.root.id)
}

/** Durable children the registry currently reports as RESIDENT. */
async function listedRunningChildren(r: Rig): Promise<SubagentListEntry[]> {
  const children = await listedChildren(r)
  return children.filter(child => child.kind === 'child' && child.activity === 'running')
}

/** Every durable event one child's own Session log recorded, captured live. */
function eventsOf(r: Rig, sessionId: string): SessionEvent[] {
  return r.sessionEvents
    .filter(entry => entry.sessionId === sessionId)
    .map(entry => entry.event)
}

/** Release a held child and wait until it has really left the registry. */
async function settleChild(r: Rig, childId: string): Promise<void> {
  r.adapter.release(childId)
  await waitFor(() => r.ends.some(end => String(end.id) === childId), 30_000, `${childId} ending`)
  await waitFor(() => r.ctx.agents.get(SessionId(childId)) === undefined, 30_000, `${childId} leaving the registry`)
}

/** Confirm a settled task, which is the only transition that frees its slot. */
async function confirm(r: Rig, runId: string, taskId: string): Promise<void> {
  await r.service.transition({ runId, taskId, to: 'settling' })
  await r.service.transition({ runId, taskId, to: 'confirmed', spentCost: 0 })
}

describe('C01: ten distinct children carry real work, root excluded', () => {
  it('runs ten distinct children from twenty submitted tasks with target N=10', async () => {
    // The gate's stimulus, literally: the root submits at least 20 independent
    // tasks while the target is 10. Twenty requests go in; the ceiling holds.
    const r = await rig()
    await r.service.createRun({ runId: 'run-c01', root: r.root, authorizationRef: 'user-authorized' })
    r.service.setReadyTasks('run-c01', 20)
    r.service.setLaunchPort(portFor(r))

    const submitted = requests(20)
    expect(new Set(submitted.map(request => request.taskId)).size).toBe(20)
    const outcomes = await r.service.drain('run-c01', submitted, new AbortController().signal)
    const accepted = outcomes.filter(outcome => outcome.accepted)
    const refused = outcomes.filter(outcome => !outcome.accepted)
    expect(accepted).toHaveLength(N)
    expect(refused).toHaveLength(10)
    // The ten refusals are the ceiling holding, not a failure: the target is
    // exactly full, so there is no deficit left to explain.
    for (const outcome of refused) expect(outcome.reason).toBe('none')

    // A child is only carrying REAL work once its own session has entered a
    // model request. Admission is not execution, so this waits for the fact.
    await waitFor(() => childRequestSessions(r).length === N, 30_000, 'ten children reaching a model request')
    const childSessions = childRequestSessions(r)

    // TEN DISTINCT children: distinct childIds, and each a distinct Session.
    expect(new Set(childSessions).size).toBe(N)
    for (const sessionId of childSessions) {
      expect(r.ctx.sessions.get(SessionId(sessionId))).toBeDefined()
    }
    // Each of the ten is a live Agent still working, not an idle placeholder.
    for (const sessionId of childSessions) {
      expect(r.ctx.agents.get(SessionId(sessionId))?.status).toBe('running')
    }

    // The ROOT is not counted among the ten. Asserted three ways, because the
    // root is NOT silent in general: DSH's continuation manager injects a
    // settlement message into the parent when a child ends
    // (packages/subagent/subagent/src/continuation-activation.ts:870-880
    // `notifySettlement` -> `parent.inject(message)`), which gives the root a
    // real turn of its own. So "the root never calls the model" is NOT a
    // property to assert; "the root's turns are never counted as children" is.
    expect(childSessions).not.toContain(String(r.root.id))
    const rootRequests = rootRequestSessions(r)
    for (const sessionId of childSessions) expect(sessionId).not.toBe(String(r.root.id))
    // In THIS case the root has no turn at all, and that is checkable rather
    // than assumed: no child settled (all ten are held inside their model call),
    // so no settlement message was ever delivered to it.
    expect(rootRequests).toHaveLength(0)
    // Every request the adapter saw is accounted for by exactly one of the two
    // sets, so no request belongs to an unaccounted session.
    expect(r.adapter.distinctSessions.length).toBe(N + rootRequests.length)

    // The REAL registry agrees: ten RESIDENT children, none of them the root.
    // `activity: 'running'` is the field that distinguishes a resident child
    // from a durable record of one that already ended.
    const children = await listedRunningChildren(r)
    expect(children).toHaveLength(N)
    expect(children.map(child => String(child.id)).sort()).toEqual([...childSessions].sort())
    expect(children.map(child => String(child.id))).not.toContain(String(r.root.id))

    // Every one is a genuine continuable child at delegation depth 1 with the
    // root as its durable parent, which is what makes it a child rather than a
    // second root.
    for (const child of children) {
      const agent = r.ctx.agents.get(child.id)
      expect(agent).toBeDefined()
      expect(delegationDepthOf(agent!)).toBe(1)
      expect(agent!.session.header.origin).toBe('subagent')
      expect(agent!.session.header.parentSession).toBe(r.root.id)
    }

    // The stored record agrees with the observation: ten tasks accepted, none
    // claimed to be executing on the strength of admission alone.
    const record = r.service.getRun('run-c01')!
    expect(Object.values(record.tasks).filter(task => task.state === 'accepted')).toHaveLength(N)
    expect(r.service.counts('run-c01').capacityDeficit).toBe(0)
    // The ten refused tasks were never admitted, so they hold nothing.
    expect(Object.keys(record.tasks)).toHaveLength(N)

    // The root remains a live, separate agent with its own session identity.
    expect(r.ctx.agents.get(r.root.id)).toBe(r.root)
    expect(String(r.root.id)).not.toBe('')
  }, 90_000)

  it('does not count the root own settlement-driven turn as one of the ten children', async () => {
    // The sharper half of "root is not counted". DSH's continuation manager
    // injects a settlement message into the parent when a child ends
    // (packages/subagent/subagent/src/continuation-activation.ts:870-880
    // `notifySettlement` -> `parent.inject(message)`), so the root DOES take a
    // real model turn. That turn must not be mistaken for an eleventh child,
    // and it must not disturb the ten slots.
    const r = await rig()
    await r.service.createRun({ runId: 'run-c01b', root: r.root, authorizationRef: 'user-authorized' })
    r.service.setReadyTasks('run-c01b', 20)
    r.service.setLaunchPort(portFor(r))

    await r.service.drain('run-c01b', requests(N), new AbortController().signal)
    await waitFor(() => childRequestSessions(r).length === N, 30_000, 'ten children reaching a model request')
    expect(rootRequestSessions(r)).toHaveLength(0)

    // Settle one child. Its end delivers a settlement message to the root, which
    // wakes it and gives it a turn of its own.
    const settling = childRequestSessions(r)[0]!
    await settleChild(r, settling)
    await waitFor(() => rootRequestSessions(r).length > 0, 30_000, 'the root taking its own settlement-driven turn')
    const rootSessions = rootRequestSessions(r)
    // The root's turn is real and is attributable to the ROOT's session, never
    // to a child's.
    expect(rootSessions.length).toBeGreaterThan(0)
    expect(new Set(rootSessions)).toEqual(new Set([String(r.root.id)]))

    // The ten are still ten distinct CHILDREN, and the root is not among them.
    const children = childRequestSessions(r)
    expect(children).not.toContain(String(r.root.id))
    expect(new Set(children).size).toBe(children.length)
    // Eleven distinct sessions have now called the model: ten children plus the
    // root's one. The partition is exact, which is what proves the root's turn
    // was excluded rather than silently folded in.
    expect(r.adapter.distinctSessions.length).toBe(children.length + new Set(rootSessions).size)

    // The run record is untouched by the root's turn: still ten held slots, and
    // the settlement does not free one (only a confirmed transition does).
    const record = r.service.getRun('run-c01b')!
    expect(Object.keys(record.tasks)).toHaveLength(N)
    expect(Object.values(record.tasks).filter(task => holdsSlot(task.state))).toHaveLength(N)
    expect(r.service.counts('run-c01b').capacityDeficit).toBe(0)
    // And the root's own turn is not a task: no task carries the root's session
    // id as its child.
    expect(Object.values(record.tasks).map(task => task.childId)).not.toContain(String(r.root.id))
  }, 90_000)
})

describe('C02: a single completion refills without waiting for the wave', () => {
  it('admits one replacement as soon as one child settles, with nine still running', async () => {
    const r = await rig()
    await r.service.createRun({ runId: 'run-c02', root: r.root, authorizationRef: 'user-authorized' })
    r.service.setReadyTasks('run-c02', 20)
    r.service.setLaunchPort(portFor(r))

    await r.service.drain('run-c02', requests(N), new AbortController().signal)
    await waitFor(() => childRequestSessions(r).length === N, 30_000, 'ten children running')
    expect(r.service.counts('run-c02').capacityDeficit).toBe(0)

    // The timeline. Every entry is a real observation with a real timestamp; the
    // refill latency below is measured from these, not asserted against an SLO
    // this repository never froze.
    const timeline: Array<{ readonly at: number; readonly what: string }> = []
    const mark = (what: string): void => {
      timeline.push({ at: Date.now(), what })
    }

    // Settle exactly ONE child: its turn ends, the registry disposes the
    // activation, and its slot becomes freeable.
    const settling = childRequestSessions(r)[0]!
    mark(`release ${settling}`)
    await settleChild(r, settling)
    mark(`${settling} ended and left the registry`)

    // The other NINE are still running. Without this the case would prove
    // nothing about refilling mid-wave.
    const stillRunning = liveChildIds(r).filter(id => r.ctx.agents.get(SessionId(id))?.status === 'running')
    expect(stillRunning).toHaveLength(N - 1)
    expect(stillRunning).not.toContain(settling)

    // The run record still holds the settled child's slot: only a confirmed
    // transition releases it, which is what makes the refill an explicit act
    // rather than an inference from an end event.
    expect(r.service.counts('run-c02').capacityDeficit).toBe(0)
    expect(r.ends.find(end => String(end.id) === settling)?.stopReason).toBe('completed')

    // Confirm the completed task: this is the transition that frees the slot.
    const freedAt = Date.now()
    mark('slot freed by confirmation')
    await confirm(r, 'run-c02', taskOf(settling))
    expect(r.service.counts('run-c02').capacityDeficit).toBe(1)

    const replacement = await r.service.drain('run-c02', requests(1, 500), new AbortController().signal)
    const refillLatencyMs = Date.now() - freedAt
    expect(replacement[0]?.accepted).toBe(true)
    mark(`child-500 admitted (+${refillLatencyMs}ms)`)

    // The replacement reaches a real model request while the original nine are
    // STILL held: the wave did not have to finish for it to start.
    await waitFor(
      () => childRequestSessions(r).includes('child-500'),
      30_000,
      'the replacement reaching its own model request',
    )
    const replacementReachedAt = Date.now()
    mark('replacement reached a model request')
    // Eleven CHILDREN have now run; the root's own settlement-driven turns are
    // excluded from that count by construction.
    expect(childRequestSessions(r)).toHaveLength(N + 1)
    const runningNow = liveChildIds(r).filter(id => r.ctx.agents.get(SessionId(id))?.status === 'running')
    expect(runningNow).toHaveLength(N)
    expect(runningNow).toContain('child-500')
    expect(runningNow).not.toContain(settling)
    expect(r.service.counts('run-c02').capacityDeficit).toBe(0)

    // The measured numbers, reported rather than asserted. No SLO for either
    // exists in this repository, so a bound here would be invented.
    const observed = timeline
      .map((entry, index) => `${index === 0 ? '+0ms' : `+${entry.at - timeline[0]!.at}ms`} ${entry.what}`)
      .join('\n    ')
    console.log(`C02 refill timeline (measured; no SLO is asserted):\n    ${observed}`)
    console.log(`C02 measured refill latency, confirmation -> replacement admitted: ${refillLatencyMs}ms`)
    console.log(
      `C02 measured replacement latency, admitted -> first model request: ${replacementReachedAt - freedAt - refillLatencyMs}ms`,
    )
    // The only thing a measurement without a frozen SLO can support: the
    // latency is a real, non-negative duration and the replacement is a real
    // distinct child.
    expect(refillLatencyMs).toBeGreaterThanOrEqual(0)
    expect(new Set(childRequestSessions(r)).size).toBe(N + 1)
  }, 90_000)
})

describe('C03: a completion storm neither double-launches nor misses a refill', () => {
  it('serializes concurrent drains and admits exactly one child per freed slot', async () => {
    const r = await rig()
    await r.service.createRun({ runId: 'run-c03', root: r.root, authorizationRef: 'user-authorized' })
    r.service.setReadyTasks('run-c03', 20)
    r.service.setLaunchPort(portFor(r))

    await r.service.drain('run-c03', requests(N), new AbortController().signal)
    await waitFor(() => childRequestSessions(r).length === N, 30_000, 'ten children running')
    const firstWave = [...childRequestSessions(r)]

    // ---- Part 1: three concurrent drains against a FULL target. -----------
    // All three are started in the same event-loop interval. Each carries a
    // DIFFERENT task, so a spurious admission would be visible as an extra
    // child rather than as an ambiguous count.
    const signal = new AbortController().signal
    const fullStorm = await Promise.all([
      r.service.drain('run-c03', requests(1, 900), signal),
      r.service.drain('run-c03', requests(1, 901), signal),
      r.service.drain('run-c03', requests(1, 902), signal),
    ])
    expect([...fullStorm].flat().filter(outcome => outcome.accepted)).toHaveLength(0)
    for (const outcome of [...fullStorm].flat()) expect(outcome.reason).toBe('none')
    expect(liveChildIds(r)).toHaveLength(N)

    // ---- Part 2: free THREE slots, then storm the refill. ----------------
    // The three children finish inside one event-loop interval: all three gates
    // are released before the next await resolves.
    const settling = firstWave.slice(0, 3)
    for (const sessionId of settling) r.adapter.release(sessionId)
    await waitFor(
      () => settling.every(id => r.ends.some(end => String(end.id) === id)),
      30_000,
      'the three released children ending',
    )
    await waitFor(
      () => settling.every(id => r.ctx.agents.get(SessionId(id)) === undefined),
      30_000,
      'the three released children leaving the registry',
    )
    expect(liveChildIds(r)).toHaveLength(N - 3)
    for (const sessionId of settling) await confirm(r, 'run-c03', taskOf(sessionId))
    expect(r.service.counts('run-c03').capacityDeficit).toBe(3)

    const refills = [requests(1, 700)[0]!, requests(1, 701)[0]!, requests(1, 702)[0]!]
    const [a, b, c] = await Promise.all([
      r.service.drain('run-c03', [refills[0]!], signal),
      r.service.drain('run-c03', [refills[1]!], signal),
      r.service.drain('run-c03', [refills[2]!], signal),
    ])

    // THE STORM RULE. Three freed slots and three concurrent refill requests
    // admit exactly three children: one per slot, never four. The drains are
    // serialized by the service's per-run coalescing, so each sees the state the
    // previous one left rather than all three reading the same stale deficit.
    const admitted = [...a, ...b, ...c].filter(outcome => outcome.accepted)
    expect(admitted).toHaveLength(3)
    expect(r.service.counts('run-c03').capacityDeficit).toBe(0)
    await waitFor(
      () => admitted.every(outcome => childRequestSessions(r).includes(outcome.childId)),
      30_000,
      'every storm refill reaching a model request',
    )
    // NO OVERSHOOT: the target is exactly full, and no child id repeats.
    // Occupancy is read from the LIVE registry, not from `listChildren`: that
    // listing is durable and would count the three children that just ended.
    expect(liveChildIds(r)).toHaveLength(N)
    expect(await listedRunningChildren(r)).toHaveLength(N)
    const allSessions = childRequestSessions(r)
    expect(new Set(allSessions).size).toBe(allSessions.length)

    // ---- Part 3: the coalesced drain is RE-TRIGGERABLE. ------------------
    // If coalescing had latched, a later completion could never refill again,
    // which is the "missed refill" half of the oracle. Free one more slot and
    // trigger again; it must admit.
    const secondWave = liveChildIds(r)
    const nextToSettle = secondWave[0]!
    await settleChild(r, nextToSettle)
    await confirm(r, 'run-c03', taskOf(nextToSettle))
    expect(r.service.counts('run-c03').capacityDeficit).toBe(1)
    const later = await r.service.drain('run-c03', requests(1, 800), signal)
    expect(later[0]?.accepted).toBe(true)
    expect(r.service.counts('run-c03').capacityDeficit).toBe(0)
    await waitFor(
      () => childRequestSessions(r).includes('child-800'),
      30_000,
      'the later refill reaching a model request',
    )
    expect(liveChildIds(r)).toHaveLength(N)

    // NO DUPLICATE LAUNCH, across the whole case: every child id appears exactly
    // once in the durable listing, and no two tasks share a child id.
    const children = await listedChildren(r)
    expect(new Set(children.map(child => String(child.id))).size).toBe(children.length)
    // The durable listing has to account for every child this case ever created:
    // ten, plus the three storm refills, plus the later one.
    expect(children).toHaveLength(N + 4)
    const record = r.service.getRun('run-c03')!
    const childIds = Object.values(record.tasks).map(task => task.childId)
    expect(new Set(childIds).size).toBe(childIds.length)
    // And the run is at the target, not past it.
    expect(liveChildIds(r).length).toBeLessThanOrEqual(N)
  }, 120_000)
})

describe('C04: an insufficient ready supply is reported, never padded with placeholders', () => {
  it('creates exactly three real children and reports a seven-slot deficit', async () => {
    // The hard product rule: with three ready tasks and target 10, the system
    // must NOT create seven sleep/idle placeholder children to look full.
    const r = await rig()
    await r.service.createRun({ runId: 'run-c04', root: r.root, authorizationRef: 'user-authorized' })
    r.service.setReadyTasks('run-c04', 3)
    r.service.setLaunchPort(portFor(r))

    const outcomes = await r.service.drain('run-c04', requests(3), new AbortController().signal)
    expect(outcomes.filter(outcome => outcome.accepted)).toHaveLength(3)
    await waitFor(() => childRequestSessions(r).length === 3, 30_000, 'three children reaching a model request')

    // The deficit is EXPLICIT and the reason names the cause.
    const counts = r.service.counts('run-c04')
    expect(counts.desiredTarget).toBe(N)
    expect(counts.readyTasks).toBe(3)
    expect(counts.capacityDeficit).toBe(N - 3)
    expect(counts.deficitReason).toBe('insufficient_ready_tasks')

    // THE HARD RULE, part 1: the deficit does not become work on its own. There
    // is no timer and no polling loop in the service (`drain` is "a plain async
    // function with no timer", src/host.ts), so waiting changes nothing. Seven
    // placeholder children would have to appear here if the system padded.
    await new Promise(resolve => setTimeout(resolve, 400))
    expect(childRequestSessions(r)).toHaveLength(3)
    expect(liveChildIds(r)).toHaveLength(3)
    expect(r.service.counts('run-c04').capacityDeficit).toBe(N - 3)

    // The deficit is unchanged and still REPORTED with its reason, rather than
    // being silently absorbed by lowering the target.
    expect(r.service.counts('run-c04').desiredTarget).toBe(N)
    expect(r.service.counts('run-c04').deficitReason).toBe('insufficient_ready_tasks')

    // THE HARD RULE, part 2, asserted against the REAL registry rather than the
    // record: exactly three children exist. Not ten, and not ten with seven idle.
    const children = await listedChildren(r)
    expect(children).toHaveLength(3)
    expect(await listedRunningChildren(r)).toHaveLength(3)
    expect(new Set(children.map(child => String(child.id))).size).toBe(3)
    // Every existing child is one that reached a model request: no child exists
    // that is merely resident.
    expect(new Set(childRequestSessions(r))).toEqual(new Set(children.map(child => String(child.id))))

    // COALESCING, and no duplicate admission: three concurrent drains carrying
    // the SAME submission must produce exactly one child. The service coalesces
    // per run (`pendingDrain`), and the loser is refused because the task is
    // already admitted rather than because a slot was double-spent.
    const signal = new AbortController().signal
    const duplicate = requests(1, 400)[0]!
    const coalesced = await Promise.all([
      r.service.drain('run-c04', [duplicate], signal),
      r.service.drain('run-c04', [duplicate], signal),
      r.service.drain('run-c04', [duplicate], signal),
    ])
    const duplicateAccepted = [...coalesced].flat().filter(outcome => outcome.accepted)
    expect(duplicateAccepted).toHaveLength(1)
    for (const outcome of [...coalesced].flat().filter(outcome => !outcome.accepted)) {
      expect(outcome.reason).toMatch(/already admitted/)
    }
    await waitFor(() => childRequestSessions(r).includes('child-400'), 30_000, 'the one admitted duplicate')
    // One new real child, so four; never four copies of the same submission.
    expect(childRequestSessions(r)).toHaveLength(4)
    expect(liveChildIds(r)).toHaveLength(4)
    expect(r.service.counts('run-c04').capacityDeficit).toBe(N - 4)

    // Nothing in the record claims a slot with no child behind it: the held
    // slots equal the admitted tasks, and the remainder is REPORTED as deficit.
    const record = r.service.getRun('run-c04')!
    const holding = Object.values(record.tasks).filter(task => holdsSlot(task.state))
    expect(holding).toHaveLength(4)
    expect(holding.every(task => task.childId !== undefined)).toBe(true)
    expect(N - holding.length).toBe(r.service.counts('run-c04').capacityDeficit)
    // The deficit is still explained by the ready supply, which is the honest
    // reason: the root has not asked for more work than it has given.
    expect(r.service.counts('run-c04').deficitReason).toBe('insufficient_ready_tasks')
  }, 90_000)
})

describe('C07: a cancel that has not finished keeps the slot occupied', () => {
  it('holds the slot while an interrupted child is still running, and refuses the premature refill', async () => {
    const r = await rig()
    await r.service.createRun({ runId: 'run-c07', root: r.root, authorizationRef: 'user-authorized' })
    r.service.setReadyTasks('run-c07', 20)
    r.service.setLaunchPort(portFor(r))

    await r.service.drain('run-c07', requests(N), new AbortController().signal)
    await waitFor(() => childRequestSessions(r).length === N, 30_000, 'ten children running')

    // Drive the target child into `executing` from observed liveness, which is
    // the only thing that makes it an ACTIVE assignment.
    const victim = childRequestSessions(r)[0]!
    const victimTask = taskOf(victim)
    r.service.observe('run-c07', {
      taskId: victimTask,
      startedRealWork: true,
      waitingOnOwnedTool: false,
      providerWaiting: false,
    })
    await r.service.transition({ runId: 'run-c07', taskId: victimTask, to: 'executing' })
    expect(r.service.counts('run-c07').activeAssignments).toBe(1)

    // Send the interrupt through the REAL service. It is fire-and-return: "the
    // cancel signal is issued before this returns, but the target may keep
    // running until it observes the signal"
    // (packages/subagent/subagent/src/index.ts:318-320). The adapter holds its
    // model call and does not observe the abort, which is exactly the window
    // this gate names: SIGTERM/interrupt sent, child still running.
    r.ctx.subagents.interrupt(SessionId(victim), { kind: 'ancestor', agent: r.root })
    // Let the interrupt be delivered, then check the child is STILL WORKING.
    // The slot is therefore genuinely occupied, not merely recorded as such.
    await new Promise(resolve => setTimeout(resolve, 200))
    expect(r.ctx.agents.get(SessionId(victim))?.status).toBe('running')

    // Record the request. The slot is NOT released by the request alone.
    await r.service.transition({ runId: 'run-c07', taskId: victimTask, to: 'cancel_requested' })
    const afterCancel = r.service.getRun('run-c07')!
    expect(afterCancel.tasks[victimTask]?.state).toBe('cancel_requested')
    expect(afterCancel.budget.reserved).toBe(N)

    // `holdsSlot` in src/states.ts is the single source of truth for occupancy.
    // Both states this gate names must still hold a slot.
    expect(holdsSlot('cancel_requested')).toBe(true)
    expect(holdsSlot('unknown')).toBe(true)

    // A premature refill is therefore refused: there is no free slot, and the
    // reason is that the target is full rather than a quiet overshoot.
    const premature = await r.service.drain('run-c07', requests(1, 300), new AbortController().signal)
    expect(premature[0]?.accepted).toBe(false)
    expect(premature[0]?.reason).toBe('none')
    expect(r.service.counts('run-c07').capacityDeficit).toBe(0)
    expect(r.service.counts('run-c07').stopping).toBe(1)

    // NO OVERSHOOT against the real registry: still ten children, and the
    // refused task has no child behind it and no record.
    expect(liveChildIds(r)).toHaveLength(N)
    expect(await listedChildren(r)).toHaveLength(N)
    expect(childRequestSessions(r)).not.toContain('child-300')
    expect(r.service.getRun('run-c07')?.tasks['task-300']).toBeUndefined()
    expect(r.service.getRun('run-c07')?.budget.reserved).toBe(N)

    // Now let the child actually stop. Only a CONFIRMED cancel releases.
    await settleChild(r, victim)
    // An interrupted child ends `aborted`, not `completed`: an aborted turn is
    // not evidence the work happened, so it cannot be confirmed.
    expect(r.ends.find(end => String(end.id) === victim)?.stopReason).toBe('aborted')

    await r.service.transition({
      runId: 'run-c07',
      taskId: victimTask,
      to: 'cancelled',
      uncertainty: 'cancelled by the user before any result was produced',
    })
    // Only NOW is the slot free, and exactly one refill is admitted.
    expect(r.service.counts('run-c07').capacityDeficit).toBe(1)
    const refill = await r.service.drain('run-c07', requests(1, 301), new AbortController().signal)
    expect(refill[0]?.accepted).toBe(true)
    expect(r.service.counts('run-c07').capacityDeficit).toBe(0)
    await waitFor(() => childRequestSessions(r).includes('child-301'), 30_000, 'the refill reaching a model request')
    // Ten children again, never eleven.
    expect(liveChildIds(r)).toHaveLength(N)
  }, 120_000)

  it('keeps an unknown-outcome task occupying its slot against a full target', async () => {
    // The second half of the gate: `unknown` holds. A run whose target is 10
    // with nine demonstrably working plus one unestablishable outcome has NO
    // free slot, even though only nine are provably running.
    const r = await rig()
    await r.service.createRun({ runId: 'run-c07b', root: r.root, authorizationRef: 'user-authorized' })
    r.service.setReadyTasks('run-c07b', 20)
    r.service.setLaunchPort(portFor(r))

    await r.service.drain('run-c07b', requests(N), new AbortController().signal)
    await waitFor(() => childRequestSessions(r).length === N, 30_000, 'ten children running')

    // One child's outcome becomes unestablishable, as a lost reply would leave
    // it. `unknown` is a resting state, not a failure, and it holds the slot.
    await r.service.transition({
      runId: 'run-c07b',
      taskId: 'task-9',
      to: 'unknown',
      uncertainty: 'the provider accepted the request and never answered; the effect cannot be established',
      releaseReservation: false,
    })
    const counts = r.service.counts('run-c07b')
    expect(counts.quarantinedUnknown).toBe(1)
    expect(counts.capacityDeficit).toBe(0)

    const refused = await r.service.drain('run-c07b', requests(1, 320), new AbortController().signal)
    expect(refused[0]?.accepted).toBe(false)
    // The nine free-LOOKING slots do not exist: occupancy counts the
    // quarantined one, so the ceiling is intact and the credit is held.
    expect(r.service.getRun('run-c07b')?.budget.reserved).toBe(N)
    expect(liveChildIds(r)).toHaveLength(N)
    expect(childRequestSessions(r)).not.toContain('child-320')
    expect(r.service.getRun('run-c07b')?.tasks['task-320']).toBeUndefined()
  }, 90_000)
})

describe('C09: provider limits are reported, never disguised as execution', () => {
  it('a sustained 429 through the real wire keeps the target at 10 and reports a block', async () => {
    // The fault is produced by a REAL HTTP/SSE server, so the status code and
    // the Retry-After header are wire facts rather than a stub's claim.
    const server: MockLlmServer = await startMockLlmServer({
      sequence: ['rate_limit'],
      repeatLast: true,
      port: 0,
      host: '127.0.0.1',
      retryAfterMs: 1_000,
    })
    cleanups.push(async () => {
      await server.close()
    })
    const response = await fetch(`${server.baseURL}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'mock', messages: [{ role: 'user', content: 'hi' }] }),
    })
    expect(response.status).toBe(429)
    expect(response.headers.get('retry-after')).toBe('1')
    expect(server.requests).toHaveLength(1)
    await response.text()

    // `withRetry` is what makes "bounded backoff" a behavioural claim: without
    // the executor mounted, an adapter's `retryPolicy` is captured in the
    // registration and never runs.
    const r = await rig({ withRetry: true })
    const limited = new RateLimitedAdapter()
    r.ctx.llm.registerAdapter(['limited'], limited)

    await r.service.createRun({ runId: 'run-c09', root: r.root, authorizationRef: 'user-authorized' })
    r.service.setReadyTasks('run-c09', 20)
    r.service.setLaunchPort(portFor(r, { provider: 'limited', model: 'limited-model' }))

    const outcomes = await r.service.drain('run-c09', requests(N), new AbortController().signal)
    expect(outcomes.filter(outcome => outcome.accepted)).toHaveLength(N)

    // Each child's turn fails with RATE_LIMIT. Normal mode with maxRetries 2
    // means three attempts per child and then a stop: bounded, not unbounded.
    await waitFor(() => limited.attempts >= N * 3, 30_000, 'every child exhausting its bounded retries')
    await new Promise(resolve => setTimeout(resolve, 300))
    const attemptsAfterSettle = limited.attempts
    expect(attemptsAfterSettle).toBe(N * 3)
    // BOUNDED, asserted by waiting: an unbounded retry would keep climbing here.
    await new Promise(resolve => setTimeout(resolve, 600))
    expect(limited.attempts).toBe(attemptsAfterSettle)

    // The retries were SCHEDULED and durable, not silent, and the recorded
    // policy is what makes "bounded" checkable rather than merely claimed:
    // each edge carries its own `mode`, `retry`, `maxRetries` and `delayMs`
    // (packages/llm/llm-retry/src/types.ts:19-31).
    //
    // Read from the captured event firehose rather than `ctx.sessions.get()`: a
    // child whose activation was disposed is removed from the live Session
    // store, so a post-hoc lookup returns undefined and would make this
    // assertion vacuous exactly when the children have finished failing.
    const childEvents = eventsOf(r, 'child-0')
    expect(childEvents.length).toBeGreaterThan(0)
    const retryEdges = childEvents.filter(event => event.type === 'llm/retry')
    expect(retryEdges).toHaveLength(2)
    const retryData = retryEdges.map(edge => {
      if (edge.type !== 'llm/retry') throw new Error('unreachable: filtered to llm/retry')
      return edge.data
    })
    // BOUNDED, structurally: normal mode with a finite retry budget. `always`
    // mode is the unbounded shape and is explicitly not what ran.
    expect(retryData.map(data => data.mode)).toEqual(['normal', 'normal'])
    expect(retryData.map(data => data.retry)).toEqual([1, 2])
    expect(retryData.map(data => (data.mode === 'normal' ? data.maxRetries : -1))).toEqual([2, 2])
    // The backoff is a real, finite wait and it grows, which is what
    // distinguishes backoff from a hot retry loop. `jitterRatio: 0` on this
    // adapter's policy makes the two delays exactly the configured schedule.
    expect(retryData.map(data => data.delayMs)).toEqual([5, 10])
    for (const data of retryData) {
      expect(data.failure.code).toBe('RATE_LIMIT')
      expect(data.delayMs).toBeLessThanOrEqual(10)
    }
    // And the retry wait really ENDED rather than being abandoned: each
    // scheduled retry has its paired `llm/retry-started` transition.
    expect(childEvents.filter(event => event.type === 'llm/retry-started')).toHaveLength(2)

    // THE RULE: the target fact is unchanged, and the system did NOT secretly
    // drop to 8.
    const counts = r.service.counts('run-c09')
    expect(counts.desiredTarget).toBe(N)
    expect(counts.readyTasks).toBe(20)
    // WAITING IS NOT WRAPPED AS EXECUTION. This is the load-bearing assertion of
    // the gate: zero children are counted as carrying real work, and zero are
    // reported as queued at the provider, even though ten requests were issued
    // and ten slots are held.
    expect(counts.activeAssignments).toBe(0)
    expect(counts.providerWaiting).toBe(0)
    expect(counts.waitingOwnedTool).toBe(0)

    // The record does not claim a working wave either. Every task still holds
    // its slot and its credit, because an errored turn is not proof that nothing
    // happened.
    const record = r.service.getRun('run-c09')!
    const states = Object.values(record.tasks).map(task => task.state)
    expect(states.filter(state => holdsSlot(state))).toHaveLength(N)
    expect(states).not.toContain('confirmed')
    expect(record.budget.reserved).toBe(N)

    // REPORTING GAP, stated rather than hidden. `deficitReason` is about the
    // TARGET being unfilled, and here it is not: ten slots are held, so the
    // deficit is zero and the reason is `none`. A reader who looked only at
    // `deficitReason` would see a quiet, healthy, full wave while nothing at all
    // is executing. The block IS observable, but through `activeAssignments: 0`
    // together with ten held slots -- not through the deficit vocabulary, which
    // has no value for "every held slot belongs to work whose last attempt
    // failed". Asserted here as the observed value so the gap cannot be
    // mistaken for a passing reason.
    expect(counts.capacityDeficit).toBe(0)
    expect(counts.deficitReason).toBe('none')
    // The observable consequence of the block: a NEW submission is refused.
    // Its recorded reason is likewise `none` (there is no deficit to explain),
    // which is the same gap seen from the caller's side.
    const blocked = await r.service.drain('run-c09', requests(1, 980), new AbortController().signal)
    expect(blocked[0]?.accepted).toBe(false)
    expect(blocked[0]?.reason).toBe('none')
    expect(r.service.getRun('run-c09')?.tasks['task-980']).toBeUndefined()
    // The run is still honest about the ten slots it is holding: none of them is
    // reported as a live worker, which is what stops this from reading as
    // "ten children are executing".
    expect(r.service.counts('run-c09').durablyAdmitted).toBe(N)
    // Recorded, not assumed: how many of the ten children DSH still holds
    // resident after their error turns. A failed turn settles the child, so the
    // platform's own capacity frees while OUR record deliberately keeps the ten
    // slots -- which is the intended asymmetry (an errored turn is not proof
    // that no effect occurred, so only reconciliation may release).
    console.log(
      `C09 after a sustained 429: record holds ${counts.durablyAdmitted} slots, `
      + `DSH still has ${liveChildIds(r).length} resident children, activeAssignments ${counts.activeAssignments}`,
    )

    // And the limit is visible in each child's own Session as an error turn
    // carrying the RATE_LIMIT code, rather than as a green no-op.
    const turnEnd = childEvents.filter(event => event.type === 'turn/end').at(-1)
    expect(turnEnd).toBeDefined()
    expect(turnEnd!.data.reason.kind).toBe('error')
    const failure = turnEnd!.data.reason.kind === 'error' ? turnEnd!.data.reason.error : undefined
    expect(failure?.code).toBe('RATE_LIMIT')
  }, 120_000)

  it('an exhausted child budget blocks with a real reason and does not lower the target', async () => {
    // The same rule from the other side: "429 / budget insufficient /
    // authorization missing keeps the target fact unchanged, shows
    // blocked/deficit, does not secretly drop to 8". Here the block comes from
    // the run's own ceiling, which is the only form of it that can be produced
    // without a live provider.
    const r = await rig({ budgetCeiling: 10 })
    await r.service.createRun({
      runId: 'run-c09b',
      root: r.root,
      authorizationRef: 'user-authorized',
      // Two units are the root's own reserved inference credit, so the child
      // ceiling is 8 against a target of 10. This is the C05 shape.
      rootReserve: 2,
    })
    r.service.setReadyTasks('run-c09b', 20)
    r.service.setLaunchPort(portFor(r))

    const outcomes = await r.service.drain('run-c09b', requests(N), new AbortController().signal)
    const accepted = outcomes.filter(outcome => outcome.accepted)
    const refused = outcomes.filter(outcome => !outcome.accepted)
    // The child ceiling is 10 - 2 = 8, so exactly eight are admitted.
    expect(accepted).toHaveLength(8)
    expect(refused).toHaveLength(2)
    for (const outcome of refused) expect(outcome.reason).toBe('budget_blocked')

    const counts = r.service.counts('run-c09b')
    // THE TARGET IS NOT LOWERED. It still says 10, and the block says why.
    expect(counts.desiredTarget).toBe(N)
    expect(counts.deficitReason).toBe('budget_blocked')

    // The budget report is a fact, not a guess: the child ceiling is reached
    // exactly, and the root's reserve is untouched and still available.
    const budget = r.service.budget('run-c09b')
    expect(budget.childCeiling).toBe(8)
    expect(budget.childCommitted).toBe(8)
    expect(budget.rootAvailable).toBe(2)
    expect(budget.halted).toBe(false)

    // A later drain with a fresh task is refused for the same real reason, and
    // no ninth child is created. This is "does not secretly drop to 8" seen from
    // the other side: the system reports 8 of 10 blocked rather than rewriting
    // its target as 8.
    const later = await r.service.drain('run-c09b', requests(1, 950), new AbortController().signal)
    expect(later[0]?.accepted).toBe(false)
    expect(later[0]?.reason).toBe('budget_blocked')
    await waitFor(() => liveChildIds(r).length === 8, 30_000, 'eight children resident')
    expect(liveChildIds(r)).toHaveLength(8)
    expect(r.service.getRun('run-c09b')?.tasks['task-950']).toBeUndefined()
    expect(r.service.counts('run-c09b').desiredTarget).toBe(N)
  }, 90_000)
})
