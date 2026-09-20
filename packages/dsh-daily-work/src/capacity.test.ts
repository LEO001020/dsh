/**
 * M6-A: the global hard child capacity and the independent deployment depth cap.
 *
 * WHAT THIS FILE PROVES, and with which N:
 *
 *   | test                                              | N   | why that N |
 *   |---------------------------------------------------|-----|------------|
 *   | 30 occupied => 31st and 32nd refused, never > 30   | 30  | the cap ITSELF is the property; synthetic occupancy is used so no real children are spun up |
 *   | occupancy never exceeds the cap at any instant      | 3   | real agents, smallest N that exercises the refusal |
 *   | all five creation paths share one quota             | 3   | real agents; the paths are what is under test, not the number |
 *   | maxDepth 99 cannot lift the cap                     | 1   | depth is independent of N |
 *   | omitted maxDepth is also refused                    | 1   | same |
 *   | a waiting assignment still occupies                 | 2   | need one holder + one refused |
 *   | a requested-but-unconfirmed cancel still occupies   | 2   | same |
 *   | an idle historical Session is NOT active            | 2   | one live child + one idle session |
 *   | one root really reaches its target                  | 3   | real scripted provider, smallest N that shows top-up |
 *
 * THE LIVE-PAID-PROVIDER ARM IS NOT HERE AND IS NOT FAKED. `UPG-07` requires an
 * authorized frontier provider to drive 30 non-empty children. No such budget is
 * authorized on this machine, so that arm is BLOCKED_EXTERNAL and is recorded as
 * such in FINDINGS.md rather than being replaced by a scripted run. What a
 * scripted adapter proves is the MECHANICAL admission and top-up behaviour, and
 * that is what these tests claim — no more.
 */
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { LlmAdapter, createUserMessage, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SessionQueryEngine from '@deepseek-ai/dsh-session-query'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import * as SubagentSpawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import Storage from '@deepseek-ai/dsh-storage'
import * as storageDomainPlugin from '@deepseek-ai/dsh-storage-domain'
import * as storageJsonPlugin from '@deepseek-ai/dsh-storage-json'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  ChildAdmissionGate,
  ChildCapacityError,
  HARD_CHILD_CAPACITY,
  OCCUPANCY_BUCKETS,
  isSessionBackedChild,
  mountChildAdmissionGuard,
} from './capacity.ts'
import { WorkService, type LaunchRequest } from './host.ts'
import { createContinuableLaunchPort } from './launch-port.ts'
import { holdsSlot } from './states.ts'

/**
 * A scripted adapter that holds every child's model call open until released.
 *
 * The plan forbids building a second model loop to fake children; a scripted
 * adapter is not a second loop, it is the PROVIDER boundary. The loop, the
 * tools, the inbox, the Sessions and the subagent machinery are all genuine.
 * The gate is what is under test, so a held-open provider is what makes
 * "occupied at this instant" a fact rather than a race.
 */
class GatedAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  private release: (() => void) | undefined
  private readonly gate: Promise<void>

  constructor() {
    super()
    let open: () => void = () => {}
    this.gate = new Promise<void>((resolve) => { open = resolve })
    this.release = open
  }

  openAll(): void {
    this.release?.()
  }

  override async resolveModel(provider: string, model: string): Promise<{ provider: string; id: string; name: string }> {
    return { provider, id: model, name: model }
  }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    await this.gate
    if (options.signal?.aborted) throw new Error('aborted')
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'child done' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

/**
 * A model adapter that holds EACH CHILD open independently.
 *
 * The whole-file `GatedAdapter` releases everything at once, which cannot express
 * "nine still running, one finished". This one gates on
 * `GenerateOptions.sessionId`, which the production loop stamps with the child's
 * own session id, so "hold child 7 open" is addressed by that child's durable
 * identity rather than by call order.
 *
 * This is the instrument CAP-04/CAP-05 need: a wave scheduler is only
 * distinguishable from a rolling one if SOME children finish while others are
 * still provably active.
 */
class PerChildGateAdapter extends LlmAdapter {
  /** Every model request seen, in arrival order, with its session. */
  readonly requests: Array<{ readonly sessionId: string; readonly at: number }> = []
  private readonly gates = new Map<string, PromiseWithResolvers<void>>()
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

  /** Let exactly ONE child's held model call complete. */
  release(sessionId: string): void {
    this.gates.get(sessionId)?.resolve()
  }

  /** Let every held and future model call complete. */
  openAll(): void {
    this.released = true
    for (const gate of this.gates.values()) gate.resolve()
  }

  /** Distinct sessions that reached a model request, in first-seen order. */
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
  readonly adapter: GatedAdapter
  readonly gate: ChildAdmissionGate
}

/**
 * Boot the REAL continuable stack plus the work service.
 *
 * `maxActiveSubagents` is set HIGH on purpose (64, above the host cap). That is
 * what makes the host cap the binding constraint: if the per-family pool were
 * the only limit, 64 children would be admitted and these tests would fail. The
 * point being measured is exactly that the per-family pool is NOT a host cap.
 */
async function rig(maxDepth = 1): Promise<Rig> {
  const sessionRoot = mkdtempSync(join(tmpdir(), 'dsh-m12-cap-sessions-'))
  const storeRoot = mkdtempSync(join(tmpdir(), 'dsh-m12-cap-store-'))

  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  const persistence = await ctx.plugin(JsonlSessionPersistence, { root: sessionRoot })
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(SubagentRuntime, { maxActiveSubagents: 64, maxDepth: 8 })
  await ctx.plugin(SubagentSpawn, { providerName: 'spawn' })
  await ctx.plugin(class extends SessionQueryEngine {
    override searchSessions(): Promise<never> {
      return Promise.reject(new Error('session search is not configured in this test'))
    }

    override searchEvents(): Promise<never> {
      return Promise.reject(new Error('event search is not configured in this test'))
    }
  })
  await ctx.plugin(Storage)
  await ctx.plugin(storageJsonPlugin as never, { root: storeRoot } as never)
  await ctx.plugin(storageDomainPlugin as never, { backend: 'json' } as never)

  const adapter = new GatedAdapter()
  ctx.llm.registerAdapter(['mock'], adapter)
  const rootAgent = await ctx.agentLoop.create(SessionId('root-session'), { provider: 'mock', model: 'mock' })

  const service = new WorkService(ctx, {
    targetChildren: 3,
    maxDepth,
    budgetCeiling: 10_000,
    currency: 'USD',
    priceVersion: 'm12-capacity',
    subagentProvider: 'spawn',
  })
  await service.open()

  cleanups.push(async () => {
    // Teardown ORDER matters and getting it wrong hangs: children parked inside a
    // model call cannot be torn down while the driver waits on the gate.
    adapter.openAll()
    await service.close()
    await ctx.subagents.drainContinuableDescendants([rootAgent])
    await persistence.dispose()
    await ctx.fiber.dispose()
    rmSync(sessionRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    rmSync(storeRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  })

  return { ctx, root: rootAgent, service, adapter, gate: service.capacityGate }
}

/** Start one real continuable child and return its id. */
async function startChild(r: Rig, childId: string, label = childId): Promise<string> {
  const started = await r.ctx.subagents.startContinuable({
    provider: 'spawn',
    label,
    childId: SessionId(childId),
    request: {
      parent: r.root,
      prompt: [{ type: 'text', text: `work ${label}` }],
      maxDepth: 1,
    },
    signal: new AbortController().signal,
  })
  return String(started.childId)
}

/**
 * Wait for a condition that a background driver reaches asynchronously.
 *
 * Needed because `startContinuable` resolves at INBOX ACCEPTANCE, not at the
 * first model request ("Resolves when the child's inbox ACCEPTS that prompt,
 * without waiting for the turn to start" — subagent/src/index.ts:254-257). An
 * immediate assertion on a later fact would be asserting on a race.
 */
async function waitFor(condition: () => boolean, what: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (condition()) return
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for ${what}`)
}

describe('CAP-01: the hard capacity is a deployment constant of 30', () => {
  it('is 30, not a config value a caller can raise', () => {
    expect(HARD_CHILD_CAPACITY).toBe(30)
    expect(new ChildAdmissionGate().limit).toBe(30)
  })

  it('REFUSES the 31st and 32nd before publication, at N=30, with synthetic occupancy', () => {
    // N=30 because the CAP is the property. No real children are spun up: the
    // ledger is exercised directly, which is what makes "30 occupied" an exact
    // precondition instead of a race. The real-agent arm follows at N=3.
    const gate = new ChildAdmissionGate()
    const held = Array.from({ length: 30 }, (_, i) => gate.reserveChild(`child-${i}`))
    expect(gate.occupied).toBe(30)

    // The 31st and 32nd are refused, and the refusal names the cap.
    expect(() => gate.reserveChild('child-30')).toThrow(ChildCapacityError)
    expect(() => gate.reserveChild('child-31')).toThrow(/hard capacity is 30/)
    expect(gate.occupied).toBe(30)

    // Occupancy NEVER exceeded the cap at any instant.
    expect(gate.snapshot().highWater).toBe(30)

    // Refusals are counted, not swallowed.
    expect(gate.snapshot().refusals.HOST_CAPACITY_REACHED).toBe(2)

    // Releasing ONE slot admits exactly one replacement, and not two.
    held[0]!.release()
    expect(gate.occupied).toBe(29)
    gate.reserveChild('child-replacement')
    expect(gate.occupied).toBe(30)
    expect(() => gate.reserveChild('child-32')).toThrow(ChildCapacityError)
    expect(gate.snapshot().highWater).toBe(30)
  })

  it('counts occupied as reserved + starting + active_assignment + stopping + unknown_quarantined', () => {
    // The plan's formula is a SUM OVER EXECUTORS: five mutually exclusive states
    // of one executor, each of which occupies. It is NOT five independent things
    // to add up. This case puts ONE executor in each state, so the correct
    // reading is exactly 5.
    const gate = new ChildAdmissionGate(5)
    gate.reserveTask('t-reserved', 'reserved')
    gate.reserveTask('t-starting', 'starting')
    gate.reserveTask('t-active', 'active_assignment')
    gate.reserveTask('t-stopping', 'stopping')
    gate.reserveTask('t-unknown', 'unknown_quarantined')
    expect(gate.occupied).toBe(5)
    expect(() => gate.reserveTask('t-sixth', 'reserved')).toThrow(ChildCapacityError)
    const snapshot = gate.snapshot()
    // Every one of these five is unbacked (no child materialized), so all five
    // are unbacked reservations. `unknownQuarantined` is a DIAGNOSTIC SUBSET of
    // that number, not a sixth class: the quarantined executor is already
    // counted in `unbackedReservations`, and adding it again would report five
    // executors as six.
    expect(snapshot.unbackedReservations).toBe(5)
    expect(snapshot.unknownQuarantined).toBe(1)
    expect(snapshot.liveChildren).toBe(0)
    expect(snapshot.unbackedReservations + snapshot.liveChildren).toBe(snapshot.occupied)
  })

  it('DROPPING ANY ONE BUCKET from the formula changes `occupied`, so a test can catch it', () => {
    // The property that makes the five-bucket test above load-bearing rather
    // than decorative: each bucket is individually NECESSARY. If an
    // implementation forgot `stopping`, or `unknown_quarantined`, or treated
    // `reserved`/`starting` as free, the count would fall by one and this case
    // fails. A test that only asserted a total would pass for a formula that
    // counted two buckets twice and one not at all.
    const buckets = OCCUPANCY_BUCKETS
    const totals = new Map<string, number>()
    for (const bucket of buckets) {
      const gate = new ChildAdmissionGate(30)
      gate.reserveTask('only', bucket)
      totals.set(bucket, gate.occupied)
    }
    for (const bucket of buckets) {
      expect(totals.get(bucket), `bucket "${bucket}" must occupy exactly one slot`).toBe(1)
    }
    // And the whole set together is the sum, with no bucket double-counted.
    const all = new ChildAdmissionGate(30)
    for (const [index, bucket] of buckets.entries()) all.reserveTask(`t-${index}`, bucket)
    expect(all.occupied).toBe(buckets.length)
  })

  it('folds a task slot into its live child rather than double-counting it', () => {
    // Counting both would report one child as two and halve the effective
    // capacity, which is the opposite failure from oversubscribing and just as
    // wrong.
    //
    // THE LAST ASSERTION IN THIS CASE WAS WRONG, AND IS CORRECTED HERE RATHER
    // THAN DELETED. It read
    //   expect(() => gate.reserveChild('c-new')).toThrow(ChildCapacityError)
    // with the justification "the live child is occupying the single remaining
    // slot". That justification is false arithmetic: this gate's capacity is 2
    // and the fold leaves exactly ONE executor, so there is exactly ONE free
    // slot and `c-new` is admitted. The line was written for the PREVIOUS,
    // incorrect count (occupied = 2 here, when t2 was wrongly treated as an
    // addition); the count above was corrected and this line was left behind
    // still asserting the old total. Measured on the unfixed revision, with a
    // direct probe over this same class: occupied = 1, capacity = 2,
    // `reserveChild('c-new')` ADMITTED, occupied became 2, no throw.
    //
    // SO: THE GUARD IS RIGHT AND THE EXPECTATION WAS WRONG. The property this
    // case exists for — a task slot folds into its live child instead of being
    // counted twice — holds and is asserted below: `occupied` stays 1 across the
    // reservation, the materialization AND the quarantined re-reservation, so
    // the host reports one executor while one child is live. Nothing in
    // `capacity.ts` was changed to make this case pass.
    const gate = new ChildAdmissionGate(2)
    gate.reserveTask('t1', 'starting', 'c1')
    expect(gate.occupied).toBe(1)
    gate.reserveChild('c1')
    expect(gate.occupied).toBe(1)
    // A QUARANTINED executor whose child is live is still ONE executor. The
    // quarantine occupies (it is not released early), but it does not make the
    // single live child count twice. The earlier version of this test asserted
    // 2 here and called the extra one "the one case that DOES add"; that was a
    // double count, and it made the gate report a host holding 2 children when
    // it held 1 — the reported-reason-disagrees-with-reality defect class this
    // project recorded as G-FIX-02, in the direction that halves capacity.
    gate.reserveTask('t2', 'unknown_quarantined', 'c1')
    expect(gate.occupied).toBe(1)
    // It is still VISIBLE as quarantined, which is the diagnostic the plan asks
    // for, and the fold is NOT a bypass: the free slot is a REAL free slot, so
    // one genuinely new child fits and the gate is then full.
    expect(gate.snapshot().unknownQuarantined).toBe(1)
    expect(gate.snapshot().liveChildren).toBe(1)
    gate.reserveChild('c-new')
    expect(gate.occupied, 'one folded executor + one new child = 2 of 2').toBe(2)
    expect(() => gate.reserveChild('c-third')).toThrow(ChildCapacityError)
    expect(gate.snapshot().highWater).toBe(2)
    // The quarantined executor was never released by the admissions above.
    expect(gate.snapshot().unknownQuarantined).toBe(1)

    // THE TIGHTEST WITNESS that a folded, quarantined executor still HOLDS its
    // slot — the intent the removed line was reaching for, stated at the
    // capacity where it is actually true. At capacity 1, with the one executor
    // live and quarantined, the single slot is held and a new child is refused.
    const tight = new ChildAdmissionGate(1)
    tight.reserveTask('t', 'unknown_quarantined', 'only')
    tight.reserveChild('only')
    expect(tight.occupied, 'one executor, folded, at capacity 1').toBe(1)
    expect(tight.snapshot().unknownQuarantined).toBe(1)
    expect(() => tight.reserveChild('extra')).toThrow(ChildCapacityError)
    expect(tight.snapshot().refusals.HOST_CAPACITY_REACHED).toBe(1)
  })

  it('a QUARANTINED executor with NO live child still occupies, and is never released early', () => {
    // The half of the quarantine rule that must not be lost in the other
    // direction: an executor whose fate is unestablished holds its place. The
    // plan's rule is "对账不明的执行者不提前 release".
    const gate = new ChildAdmissionGate(2)
    gate.reserveTask('holder', 'active_assignment')
    gate.reserveTask('quarantined', 'unknown_quarantined')
    expect(gate.occupied).toBe(2)
    expect(gate.snapshot().unknownQuarantined).toBe(1)
    // A third admission is refused while the quarantined executor is unresolved.
    expect(() => gate.reserveChild('third')).toThrow(ChildCapacityError)
    // And it is NOT released by the passage of anything: only an explicit
    // release, which a reconciliation owns, frees it.
    expect(gate.occupied).toBe(2)
    gate.releaseTask('quarantined')
    expect(gate.occupied).toBe(1)
  })
})

describe('CAP-04: an executor whose release is unconfirmed keeps its slot', () => {
  it('a cancel that has only been REQUESTED still occupies', () => {
    // N=2: one holder and one refused admission is the smallest pair that shows
    // the slot was not released. The gate's capacity is 2 HERE because the
    // property under test is the bucket's occupancy, not the deployment
    // constant; the deployment constant is asserted in its own test above.
    const gate = new ChildAdmissionGate(2)
    gate.reserveTask('holder', 'stopping')
    gate.reserveTask('other', 'active_assignment')
    expect(gate.occupied).toBe(2)
    expect(() => gate.reserveTask('late', 'reserved')).toThrow(ChildCapacityError)
    // Confirming the cancel is what releases it, and only then.
    gate.releaseTask('holder')
    expect(gate.occupied).toBe(1)
    gate.reserveTask('late', 'reserved')
    expect(gate.occupied).toBe(2)
  })

  it('an assignment waiting on its own tool or provider STILL occupies', async () => {
    // The child is parked inside its own model call (the gate is closed), which
    // is exactly "waiting on its own provider". It must still occupy: waiting is
    // not finishing, and a gate that released here would admit a replacement
    // while the child was still running.
    const r = await rig()
    await startChild(r, 'waiting-child')
    expect(r.gate.occupied).toBe(1)
    expect(r.gate.snapshot().liveChildren).toBe(1)

    // Wait until the child's turn actually reaches the provider. `startContinuable`
    // resolves at INBOX ACCEPTANCE, which is earlier than the first request, so
    // asserting on the request count immediately would be asserting on a race.
    await waitFor(() => r.adapter.requests.length >= 1, 'the child reached its provider call')
    // The child is live AND parked: its provider call has not been released.
    const child = r.ctx.agents.get(SessionId('waiting-child'))
    expect(child).toBeDefined()
    expect(r.gate.hasChild('waiting-child')).toBe(true)

    // A 2-slot gate with this real child plus one reservation refuses a third.
    const two = new ChildAdmissionGate(2)
    two.reserveChild('waiting-child')
    two.reserveTask('filler', 'reserved')
    expect(() => two.reserveChild('third')).toThrow(ChildCapacityError)
    // And the live deployment gate still holds the real child's slot.
    expect(r.gate.occupied).toBe(1)
  })

  it('releases the physical slot on agent/disposed, not on a record transition', async () => {
    const r = await rig()
    await startChild(r, 'dispose-child')
    expect(r.gate.hasChild('dispose-child')).toBe(true)
    await r.ctx.subagents.drainContinuableDescendants([r.root])
    expect(r.gate.hasChild('dispose-child')).toBe(false)
  })
})

describe('CAP-02: every in-process creation path shares one host quota', () => {
  it('the continuable path takes a host slot', async () => {
    const r = await rig()
    await startChild(r, 'continuable-1')
    expect(r.gate.snapshot().liveChildren).toBe(1)
  })

  it('the ONE-SHOT path takes a host slot', async () => {
    // `ctx.subagents.start` reaches `provider.start` with no capacity pool of its
    // own (packages/subagent/subagent/src/index.ts:591), so before this gate the
    // one-shot path was entirely uncounted.
    const r = await rig()
    const run = await r.ctx.subagents.start('spawn', {
      prompt: [{ type: 'text', text: 'one-shot work' }],
      parent: r.root,
      signal: new AbortController().signal,
      maxDepth: 1,
    })
    expect(r.gate.snapshot().liveChildren).toBe(1)
    await run.dispose()
  })

  it('the DIRECT AgentFactory path takes a host slot', async () => {
    // A direct `ctx.agents.create` with child lineage is the funnel every
    // in-process child passes through, including a workflow's `startChild`.
    const r = await rig()
    const handle = await r.ctx.agents.create({
      sessionId: SessionId('direct-child'),
      parentAgent: r.root,
      meta: { origin: 'subagent', delegationDepth: 1, parentSession: r.root.id },
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    expect(r.gate.snapshot().liveChildren).toBe(1)
    await handle.dispose()
  })

  it('the WORKFLOW/PTC path is covered, because it funnels through the one-shot start', async () => {
    // `packages/workflow/workflow-ptc/src/host.ts:197-211` `startChild` calls
    // `this.subagents.start(this.provider, {...})` with NO maxDepth. This test
    // reproduces that exact call shape — one-shot start, no maxDepth — and shows
    // it both takes a host slot AND is refused by the depth ceiling.
    const r = await rig(1)
    const childOfRoot = await startChild(r, 'workflow-parent')
    const parentAgent = r.ctx.agents.get(SessionId(childOfRoot))
    expect(parentAgent).toBeDefined()

    // The workflow shape: no `maxDepth` key at all.
    await expect(
      r.ctx.subagents.start('spawn', {
        prompt: [{ type: 'text', text: 'grandchild via workflow' }],
        parent: parentAgent!,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/depth 2 exceeds maxDepth 1|delegation depth 2/)

    // And the refusal is recorded as a DEPTH refusal, not a capacity one, so a
    // report can tell them apart.
    expect(r.gate.snapshot().refusals.DEPTH_CEILING_EXCEEDED).toBe(1)
    expect(r.gate.snapshot().refusals.HOST_CAPACITY_REACHED).toBe(0)
  })

  it('a non-child session fork does NOT consume a child slot', async () => {
    // A fork sets `parentSession` and `isSeeded` but neither `origin: 'subagent'`
    // nor a delegation depth (packages/api/session-controller/src/commands.ts:264).
    // Over-counting forks would refuse legitimate user work.
    //
    // `isSeeded` requires an explicit seed and inherited count
    // ("seeded session requires an explicit constructor seed",
    // packages/core/session/src/index.ts), so the fork shape is reproduced with
    // both, exactly as the session controller passes them.
    const r = await rig()
    const handle = await r.ctx.agents.create({
      sessionId: SessionId('fork-session'),
      meta: { parentSession: r.root.id, isSeeded: true },
      seed: [],
      // `inheritedEventCount` is a branded `SessionLogOffset`, not a bare number
      // (packages/core/session/src/types.ts), so it must be branded rather than
      // passed as `0`.
      inheritedEventCount: SessionLogOffset(0),
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    // The fork IS live and IS a real session...
    expect(r.ctx.agents.get(SessionId('fork-session'))).toBeDefined()
    // ...and it took no child slot.
    expect(r.gate.snapshot().liveChildren).toBe(0)
    await handle.dispose()
  })
})

describe('CAP-02: maxDepth is an INDEPENDENT hard cap that a caller cannot lift', () => {
  it('a caller passing maxDepth 99 is REFUSED', async () => {
    // MEASURED DEFECT this closes (docs/GAPS.md G-SEAM-18): with the deployment
    // at maxDepth 1, `resolveChildDepth(parent, 99)` admits a depth-2 child,
    // because the request value is an absolute cap the child must not exceed
    // rather than a ceiling on the caller. The deployment boundary now reads the
    // child's own durable depth, which no request field can lower.
    const r = await rig(1)
    const parentId = await startChild(r, 'depth-parent')
    const parentAgent = r.ctx.agents.get(SessionId(parentId))!

    await expect(
      r.ctx.subagents.start('spawn', {
        prompt: [{ type: 'text', text: 'grandchild with a lifted cap' }],
        parent: parentAgent,
        signal: new AbortController().signal,
        maxDepth: 99,
      }),
    ).rejects.toThrow(/delegation depth 2; the deployment ceiling is 1|depth 2 exceeds/)

    expect(r.gate.snapshot().refusals.DEPTH_CEILING_EXCEEDED).toBe(1)
  })

  it('an OMITTED maxDepth is REFUSED too, not read as permission', async () => {
    // The omission path is the same defect one field over: an absent value is
    // not a refusal in `resolveChildDepth`.
    const r = await rig(1)
    const parentId = await startChild(r, 'omit-parent')
    const parentAgent = r.ctx.agents.get(SessionId(parentId))!

    await expect(
      r.ctx.subagents.start('spawn', {
        prompt: [{ type: 'text', text: 'grandchild with no cap named' }],
        parent: parentAgent,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/deployment ceiling is 1|depth 2 exceeds/)

    expect(r.gate.snapshot().refusals.DEPTH_CEILING_EXCEEDED).toBe(1)
  })

  it('the depth ceiling does not consume a capacity slot when it refuses', async () => {
    // A refusal must leave no trace in the ledger, or a rejected grandchild
    // would permanently cost the host a slot.
    const r = await rig(1)
    const parentId = await startChild(r, 'depth-no-leak')
    const parentAgent = r.ctx.agents.get(SessionId(parentId))!
    const before = r.gate.occupied
    await expect(
      r.ctx.subagents.start('spawn', {
        prompt: [{ type: 'text', text: 'refused' }],
        parent: parentAgent,
        signal: new AbortController().signal,
        maxDepth: 99,
      }),
    ).rejects.toThrow()
    expect(r.gate.occupied).toBe(before)
  })

  it('a depth-1 child IS admitted, so the ceiling is not a blanket refusal', async () => {
    // The control arm. Without it, a gate that refused everything would pass.
    const r = await rig(1)
    const childId = await startChild(r, 'legit-child')
    expect(childId).toBe('legit-child')
    expect(r.gate.snapshot().liveChildren).toBe(1)
    expect(r.gate.snapshot().refusals.DEPTH_CEILING_EXCEEDED).toBe(0)
  })
})

describe('CAP-03/CAP-06: real top-up, and NO filler agents', () => {
  it('one root really reaches its target of 3 with the real continuable seam', async () => {
    // N=3: the smallest N that shows admission AND a refusal, driven through the
    // real provider. The target is 3, so the 4th must be refused by the gate.
    const r = await rig()
    const children = await Promise.all([
      startChild(r, 'topup-1'),
      startChild(r, 'topup-2'),
      startChild(r, 'topup-3'),
    ])
    expect(children).toHaveLength(3)
    expect(r.gate.snapshot().liveChildren).toBe(3)

    // The real subagent registry agrees there are three children.
    const listed = await r.ctx.subagents.listChildren(r.root.id)
    expect(listed.length).toBe(3)

    // A fourth exceeds this gate's own limit only when the limit is 3; the
    // deployment limit is 30, so prove the boundary with a 3-slot gate rather
    // than pretending the deployment cap is 3.
    const three = new ChildAdmissionGate(3)
    three.reserveChild('a')
    three.reserveChild('b')
    three.reserveChild('c')
    expect(() => three.reserveChild('d')).toThrow(ChildCapacityError)
  })

  it('ready shortage with a high N runs only what is ready and creates NO filler agent', async () => {
    // CAP-06. N=30 but only 2 ready. The property is that the host runs 2 and
    // reports the shortage — it must not invent 28 idle agents to make the
    // number look right. The plan's rule is "没有任务不补空Agent".
    const r = await rig()
    const runId = 'run-shortage'
    await r.service.createRun({
      runId,
      root: r.root,
      authorizationRef: 'auth',
      targetChildren: 30,
    })
    // Only TWO ready tasks exist.
    r.service.setReadyTasks(runId, 2)

    const outcomes = await r.service.drain(
      runId,
      [
        { taskId: 'task-1', childId: 'child-1', prompt: 'work 1', reservedCost: 1 },
        { taskId: 'task-2', childId: 'child-2', prompt: 'work 2', reservedCost: 1 },
      ],
      new AbortController().signal,
    )
    expect(outcomes.filter(o => o.accepted)).toHaveLength(2)

    // TWO children exist. Not 30. The deficit is reported, not filled.
    expect(r.gate.snapshot().liveChildren).toBe(2)
    const counts = r.service.counts(runId)
    expect(counts.desiredTarget).toBe(30)
    expect(counts.capacityDeficit).toBe(28)
    expect(counts.deficitReason).toBe('insufficient_ready_tasks')

    // The shortage is NOTIFIED to the root through the outbox, not silently held.
    const record = r.service.getRun(runId)!
    const outbox = Object.values(record.outbox)
    expect(outbox.length).toBeGreaterThanOrEqual(2)

    // And no idle Session was created to pad the count.
    const listed = await r.ctx.subagents.listChildren(r.root.id)
    expect(listed.length).toBe(2)
  })

  it('a root is NOT counted in the child target and is not starved of provider budget', async () => {
    // CAP-05. The root holds no child slot, and the run's budget arithmetic
    // keeps a reserve for the root that a child admission cannot eat.
    const r = await rig()
    const runId = 'run-root-budget'
    await r.service.createRun({
      runId,
      root: r.root,
      authorizationRef: 'auth',
      targetChildren: 30,
      rootReserve: 100,
    })
    // The root itself took no slot.
    expect(r.gate.snapshot().liveChildren).toBe(0)

    // A child admission that would eat the root reserve is refused by the SAME
    // comparison the budget gate uses, so the root always retains credit.
    await expect(
      r.service.admit({
        runId,
        taskId: 'greedy',
        childId: 'c-greedy',
        assignmentDigest: 'd',
        reservedCost: 9_901,
        allowedCapabilities: ['reader'],
      }),
    ).rejects.toThrow(/no budget headroom/)

    const report = r.service.budget(runId)
    expect(report.rootAvailable).toBe(100)
  })
})

describe('CAP-07: two roots share one host cap', () => {
  it('the gate is HOST-wide: two roots cannot each hold the full cap', async () => {
    // CAP-07. `maxActiveSubagents` is per-family — the pool is a
    // `WeakMap<Agent, ActivationPool>` keyed by root
    // (continuation-activation.ts:180/605) — so two roots each get a full pool
    // and 2 x 30 = 60 children on a "30 child" deployment. This gate is one
    // ledger for the host, so the SECOND root's request is what gets refused.
    const gate = new ChildAdmissionGate(30)
    // Root A fills 20.
    for (let i = 0; i < 20; i++) gate.reserveChild(`a-${i}`)
    // Root B may take 10 more, and no more.
    for (let i = 0; i < 10; i++) gate.reserveChild(`b-${i}`)
    expect(gate.occupied).toBe(30)
    expect(() => gate.reserveChild('b-10')).toThrow(/hard capacity is 30/)
    // The shortage is VISIBLE: the host reports 30 of 30, and B's own request
    // count is knowable from what it asked for.
    expect(gate.snapshot().occupied).toBe(30)
    expect(gate.snapshot().capacity).toBe(30)
    expect(gate.snapshot().highWater).toBe(30)
  })

  it('two real roots share one host ledger, and the second is refused at the boundary', async () => {
    // CAP-07 through the LIVE stack. A 3-slot gate is mounted on its own context
    // with TWO real roots, because the property is that one ledger bounds both
    // roots — not that the deployment constant is 3.
    //
    // This is the shape the per-family pool cannot produce: with
    // `maxActiveSubagents: 64` the runtime would admit 64 children from root A
    // and another 64 from root B, so a refusal here can only come from the
    // host-wide ledger.
    const ctx = new Context()
    await mountAgentLoopTestDependencies(ctx)
    const sessions = mkdtempSync(join(tmpdir(), 'dsh-m12-cap-2roots-sessions-'))
    const persistence = await ctx.plugin(JsonlSessionPersistence, { root: sessions })
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(SubagentRuntime, { maxActiveSubagents: 64, maxDepth: 8 })
    await ctx.plugin(SubagentSpawn, { providerName: 'spawn' })
    await ctx.plugin(class extends SessionQueryEngine {
      override searchSessions(): Promise<never> {
        return Promise.reject(new Error('session search is not configured in this test'))
      }

      override searchEvents(): Promise<never> {
        return Promise.reject(new Error('event search is not configured in this test'))
      }
    })
    const adapter = new GatedAdapter()
    ctx.llm.registerAdapter(['mock'], adapter)
    const gate = new ChildAdmissionGate(3)
    mountChildAdmissionGuard(ctx, { gate, maxDepth: 8 })
    const rootA = await ctx.agentLoop.create(SessionId('two-roots-a'), { provider: 'mock', model: 'mock' })
    const rootB = await ctx.agentLoop.create(SessionId('two-roots-b'), { provider: 'mock', model: 'mock' })

    cleanups.push(async () => {
      adapter.openAll()
      await ctx.subagents.drainContinuableDescendants([rootA, rootB])
      await persistence.dispose()
      await ctx.fiber.dispose()
      rmSync(sessions, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    })

    const start = (parent: Agent, childId: string): Promise<unknown> => ctx.subagents.startContinuable({
      provider: 'spawn',
      label: childId,
      childId: SessionId(childId),
      request: { parent, prompt: [{ type: 'text', text: childId }], maxDepth: 1 },
      signal: new AbortController().signal,
    })

    // Root A takes two, root B takes the last one. The host is now full.
    await start(rootA, 'a-1')
    await start(rootA, 'a-2')
    await start(rootB, 'b-1')
    expect(gate.occupied).toBe(3)

    // Root B asks for a second child and is REFUSED, even though root B's own
    // target and its own per-family pool both have room. This is the host cap
    // doing the work.
    await expect(start(rootB, 'b-2')).rejects.toThrow(/hard capacity is 3/)
    // Root A is refused too: the cap is not per-root.
    await expect(start(rootA, 'a-3')).rejects.toThrow(/hard capacity is 3/)

    // The shortage is VISIBLE and never exceeded.
    expect(gate.occupied).toBe(3)
    expect(gate.snapshot().highWater).toBe(3)
    expect(gate.snapshot().refusals.HOST_CAPACITY_REACHED).toBe(2)
    expect(ctx.agents.get(SessionId('b-2'))).toBeUndefined()
    expect(ctx.agents.get(SessionId('a-3'))).toBeUndefined()
  })
})

describe('an idle historical Session is NOT active', () => {
  it('does not occupy a slot, and its Session remains readable', async () => {
    // The plan's rule: "idle历史Session不是active". A child that finished its
    // work has been disposed and released, but its Session must still exist —
    // releasing the slot must not delete the history.
    const r = await rig()
    await startChild(r, 'idle-child')
    expect(r.gate.snapshot().liveChildren).toBe(1)

    await r.ctx.subagents.drainContinuableDescendants([r.root])
    expect(r.gate.snapshot().liveChildren).toBe(0)
    // The Session is still there, which is what makes it a historical Session
    // rather than a deleted one. `SubagentListEntry` is a discriminated union on
    // `kind` (subagent/src/control-types.ts:33); the narrow is what makes reading
    // `activity` legal, since only the `child` arm carries it.
    const listed = await r.ctx.subagents.listChildren(r.root.id)
    const idle = listed.find(
      (entry): entry is Extract<typeof entry, { kind: 'child' }> =>
        entry.kind === 'child' && String(entry.id) === 'idle-child',
    )
    expect(idle, 'the settled child must still be listed from its Session').toBeDefined()
    // And it is NOT active: `activity: 'inactive'` is the durable listing saying
    // the logical record exists only in persistence. That is exactly the plan's
    // distinction between "an idle historical Session" and "an active child".
    expect(idle!.activity).toBe('inactive')
    expect(r.ctx.agents.get(SessionId('idle-child'))).toBeUndefined()
  })
})

describe('CAP-08: raising and lowering the target keeps running children', () => {
  it('a raise tops up, and a lower STOPS admissions without killing a working child', async () => {
    // N=3 then 5 then 2: the smallest numbers that show "raised admits more" and
    // "lowered admits none" with real children. The children are REAL and parked
    // inside their provider call, so "not killed" is a fact about live Agents.
    const r = await rig()
    await r.service.createRun({ runId: 'run-raise', root: r.root, authorizationRef: 'auth', targetChildren: 3 })
    r.service.setReadyTasks('run-raise', 10)
    r.service.setLaunchPort({
      async launch(request): Promise<{ childId: string }> {
        await startChild(r, request.childId, request.taskId)
        return { childId: request.childId }
      },
    })
    const signal = new AbortController().signal
    const drain = (ids: string[]): Promise<Array<{ accepted: boolean }>> => r.service.drain(
      'run-raise',
      ids.map(id => ({ taskId: `task-${id}`, childId: `child-${id}`, prompt: `work ${id}`, reservedCost: 1 })),
      signal,
    )

    // Target 3: three admitted, the fourth refused.
    const first = await drain(['1', '2', '3', '4'])
    expect(first.filter(outcome => outcome.accepted)).toHaveLength(3)
    expect(r.gate.snapshot().liveChildren).toBe(3)
    expect(first[3]!.accepted).toBe(false)

    // RAISE 3 -> 5: the extra two are admitted immediately.
    await r.service.setTargetChildren('run-raise', 5)
    const second = await drain(['4', '5', '6'])
    expect(second.filter(outcome => outcome.accepted)).toHaveLength(2)
    expect(r.gate.snapshot().liveChildren).toBe(5)

    // LOWER 5 -> 2: NO new admission, and every working child is still alive.
    await r.service.setTargetChildren('run-raise', 2)
    const third = await drain(['7', '8'])
    expect(third.filter(outcome => outcome.accepted)).toHaveLength(0)
    expect(r.gate.snapshot().liveChildren).toBe(5)
    for (const id of ['child-1', 'child-2', 'child-3', 'child-4', 'child-5']) {
      expect(r.ctx.agents.get(SessionId(id)), `${id} must still be running`).toBeDefined()
      expect(r.gate.hasChild(id), `${id} must still hold its slot`).toBe(true)
    }

    // The lower did not touch the running tasks' own budget reservations.
    const record = r.service.getRun('run-raise')!
    for (const id of ['task-1', 'task-2', 'task-3', 'task-4', 'task-5']) {
      expect(record.tasks[id]?.reservedCost, `${id} budget must be unchanged`).toBe(1)
    }
    expect(record.requestedTarget).toBe(2)

    // Re-maintain: after the working children CONVERGE, the target is honoured
    // again.
    //
    // The provider gate must be OPENED to converge anything: a child parked inside
    // its model call cannot be torn down, because disposal waits for its driver
    // and the driver is waiting on the gate. That is a real property of this stack,
    // not a test artifact — it is why the rig's teardown opens the gate before
    // draining. Opening it converges EVERY child, so the honest sequence is:
    // settle the two tasks, let the children finish, then re-admit to the target.
    r.adapter.openAll()
    for (const id of ['1', '2']) {
      // `accepted -> settling -> confirmed` is the legal path (states.ts
      // TRANSITIONS); `accepted -> confirmed` is not, and the state machine
      // rejects it rather than letting a test skip a step.
      await r.service.transition({ runId: 'run-raise', taskId: `task-${id}`, to: 'settling' })
      await r.service.transition({ runId: 'run-raise', taskId: `task-${id}`, to: 'confirmed' })
    }
    // The two settled tasks released their slots; the other three still hold
    // theirs while their children finish.
    expect(r.gate.occupied).toBe(3)
    await waitFor(
      () => r.gate.snapshot().liveChildren === 0,
      'the released children to finish and dispose',
    )
    // The host is now empty, so the target of 4 admits again. This is the
    // "re-maintain N after convergence" half of CAP-08.
    await r.service.setTargetChildren('run-raise', 4)
    const fourth = await drain(['9'])
    expect(fourth.filter(outcome => outcome.accepted)).toHaveLength(1)
    // The task really was ADMITTED, which is the property being claimed. Its
    // state is `accepted` and not a refusal, so re-admission happened. Note what
    // is deliberately NOT asserted here: `liveChildren` is back to 0, because the
    // provider gate was opened above and the child therefore completed
    // immediately. Asserting a nonzero live count here would be asserting on a
    // race rather than on the property.
    expect(r.service.getRun('run-raise')?.tasks['task-9']?.state).toBe('accepted')
    expect(r.gate.snapshot().refusals.HOST_CAPACITY_REACHED).toBe(0)
  })
})

describe('the gate refuses BEFORE publication, not after', () => {
  it('the creating call rejects and the caller receives no child', async () => {
    // This is the pre-publication property in its observable form: the caller
    // gets a REJECTION from the creating call, not a child that it must then be
    // told to drop. `agent/created` is a `serial` event, so a throwing listener
    // rejects the announcement and the loop's rollback disposes the unpublished
    // child — the caller never receives a handle.
    const r = await rig(1)
    const parentId = await startChild(r, 'prepub-parent')
    const parentAgent = r.ctx.agents.get(SessionId(parentId))!
    const before = r.gate.occupied

    await expect(
      r.ctx.subagents.start('spawn', {
        prompt: [{ type: 'text', text: 'must not publish' }],
        parent: parentAgent,
        signal: new AbortController().signal,
        maxDepth: 99,
      }),
    ).rejects.toThrow(ChildCapacityError)

    // No child was published, and the refusal cost no slot.
    expect(r.gate.occupied).toBe(before)
    expect(r.gate.hasChild('grandchild')).toBe(false)
  })

  it('a capacity refusal at the boundary also rejects the creating call', async () => {
    // The same property on the CAPACITY arm rather than the depth arm. The
    // deployment cap is 30, so the boundary is reached with a gate whose limit
    // is 1 mounted on its own isolated context — the gate is the unit under
    // test and the refusal still travels through the real creation path.
    const r = await rig()
    const ctx = new Context()
    // `mountAgentLoopTestDependencies` is what provides `ctx.llm`; without it
    // `registerAdapter` has no service to reach. The rig above uses it for the
    // same reason.
    await mountAgentLoopTestDependencies(ctx)
    const nestedSessions = mkdtempSync(join(tmpdir(), 'dsh-m12-cap-nested-sessions-'))
    const persistence = await ctx.plugin(JsonlSessionPersistence, { root: nestedSessions })
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(SubagentRuntime, { maxActiveSubagents: 64, maxDepth: 8 })
    await ctx.plugin(SubagentSpawn, { providerName: 'spawn' })
    await ctx.plugin(class extends SessionQueryEngine {
      override searchSessions(): Promise<never> {
        return Promise.reject(new Error('session search is not configured in this test'))
      }

      override searchEvents(): Promise<never> {
        return Promise.reject(new Error('event search is not configured in this test'))
      }
    })
    const adapter = new GatedAdapter()
    ctx.llm.registerAdapter(['mock'], adapter)
    const nestedGate = new ChildAdmissionGate(1)
    mountChildAdmissionGuard(ctx, { gate: nestedGate, maxDepth: 8 })
    const nestedRoot = await ctx.agentLoop.create(SessionId('nested-root'), { provider: 'mock', model: 'mock' })

    cleanups.push(async () => {
      adapter.openAll()
      await ctx.subagents.drainContinuableDescendants([nestedRoot])
      await persistence.dispose()
      await ctx.fiber.dispose()
      rmSync(nestedSessions, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    })

    // First child: admitted, taking the single slot.
    await ctx.subagents.startContinuable({
      provider: 'spawn',
      label: 'nested-1',
      childId: SessionId('nested-1'),
      request: { parent: nestedRoot, prompt: [{ type: 'text', text: 'one' }], maxDepth: 1 },
      signal: new AbortController().signal,
    })
    expect(nestedGate.occupied).toBe(1)

    // Second child: REFUSED by the boundary, and the creating call rejects.
    await expect(ctx.subagents.startContinuable({
      provider: 'spawn',
      label: 'nested-2',
      childId: SessionId('nested-2'),
      request: { parent: nestedRoot, prompt: [{ type: 'text', text: 'two' }], maxDepth: 1 },
      signal: new AbortController().signal,
    })).rejects.toThrow(ChildCapacityError)

    expect(nestedGate.occupied).toBe(1)
    expect(nestedGate.snapshot().highWater).toBe(1)
    expect(nestedGate.snapshot().refusals.HOST_CAPACITY_REACHED).toBe(1)
    expect(ctx.agents.get(SessionId('nested-2'))).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// CAP-04 / CAP-05 — ROLLING REFILL, at SMALL N.
//
// WHY SMALL N IS SUFFICIENT, and why it is the right choice here. "Rolling"
// versus "wave" is not a statement about how many children exist; it is a
// statement about WHICH children must be finished before a replacement is
// admitted. The discriminating observation is therefore:
//
//     the interval between ONE child reaching confirmed terminal and its
//     replacement's ADMISSION, measured while other children are still active.
//
// That observation needs exactly two children that stay active and one that
// finishes — so N=3 distinguishes the two policies completely, and N=30 adds
// nothing but cost. A wave scheduler refuses the refill while ANY sibling is
// active, so it cannot produce the observation at N=3 for the same reason it
// cannot at N=30: the siblings never finish in this rig. The assertion is not a
// latency SLO (none is frozen in this repository) but the existence of the
// refill under conditions where a wave policy provably cannot produce one.
//
// THE PROVIDER IS A CONTROLLED LOCAL ROUTE. `live_provider_budget_authorized` is
// false, so no paid model drives these children. The loop, the Sessions, the
// Inbox, the subagent registry and the host ledger are all REAL; the model
// boundary is a scripted adapter. This test therefore proves the MECHANICAL
// admission and refill behaviour and does NOT claim a live-provider result.
// ---------------------------------------------------------------------------

describe('CAP-04/CAP-05: rolling refill at N=3, on a controlled local provider route', () => {
  interface RefillRig {
    readonly ctx: Context
    readonly root: Agent
    readonly service: WorkService
    readonly adapter: PerChildGateAdapter
    readonly gate: ChildAdmissionGate
  }

  /** Live children of the root, read from the REAL registry. */
  const liveChildrenOf = (ctx: Context, root: Agent): string[] =>
    ctx.agents.list()
      .filter(agent => agent.session.header.parentSession === root.id)
      .map(agent => String(agent.id))

  /**
   * Wait for a condition, and on timeout report the state that made it fail.
   *
   * The reporting is what turns "a wave scheduler hangs" into a legible result:
   * the failure names how many children were still live, which is the evidence
   * that the refill was WITHHELD rather than merely late.
   */
  async function waitForRefill(
    condition: () => boolean,
    what: string,
    diagnostic: () => string,
    timeoutMs = 20_000,
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (condition()) return
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    throw new Error(
      `timed out after ${timeoutMs}ms waiting for ${what}. A wave scheduler fails here rather than being `
      + `slow, because the sibling children are held open and never finish. State at timeout: ${diagnostic()}`,
    )
  }

  /**
   * Boot the real continuable stack with PER-CHILD model gates.
   *
   * `maxActiveSubagents: 64` is ABOVE the host cap on purpose: that is what
   * makes the host-wide ledger the binding constraint, so a refusal here can
   * only come from this project's gate rather than from DSH's per-root pool.
   */
  async function refillRig(target: number): Promise<RefillRig> {
    const sessionRoot = mkdtempSync(join(tmpdir(), 'dsh-t10-refill-sessions-'))
    const storeRoot = mkdtempSync(join(tmpdir(), 'dsh-t10-refill-store-'))
    const ctx = new Context()
    await mountAgentLoopTestDependencies(ctx)
    const persistence = await ctx.plugin(JsonlSessionPersistence, { root: sessionRoot })
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(SubagentRuntime, { maxActiveSubagents: 64, maxDepth: 1 })
    await ctx.plugin(SubagentSpawn, { providerName: 'spawn' })
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
    const root = await ctx.agentLoop.create(SessionId('t10-refill-root'), { provider: 'mock', model: 'mock' })
    const service = new WorkService(ctx, {
      targetChildren: target,
      maxDepth: 1,
      budgetCeiling: 10_000,
      currency: 'USD',
      priceVersion: 't10-refill',
      subagentProvider: 'spawn',
    })
    await service.open()
    cleanups.push(async () => {
      adapter.openAll()
      await service.close()
      await ctx.subagents.drainContinuableDescendants([root])
      await persistence.dispose()
      await ctx.fiber.dispose()
      rmSync(sessionRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
      rmSync(storeRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    })
    return { ctx, root, service, adapter, gate: service.capacityGate }
  }

  const request = (n: number): LaunchRequest => ({
    taskId: `task-${n}`, childId: `child-${n}`, prompt: `work ${n}`, reservedCost: 1,
  })

  /** Confirm a task, which is the only transition that frees its slot. */
  async function confirm(r: RefillRig, runId: string, taskId: string): Promise<void> {
    await r.service.transition({ runId, taskId, to: 'settling' })
    await r.service.transition({ runId, taskId, to: 'confirmed', spentCost: 0 })
  }

  it('ONE completion refills while TWO siblings are still ACTIVE (N=3)', async () => {
    const N = 3
    const r = await refillRig(N)
    const runId = 'run-rolling'
    await r.service.createRun({ runId, root: r.root, authorizationRef: 'auth', targetChildren: N })
    r.service.setReadyTasks(runId, 8)
    r.service.setLaunchPort(createContinuableLaunchPort({
      subagents: r.ctx.subagents, parent: r.root, provider: 'spawn', maxDepth: 1,
    }))

    // ---- A full wave of N real children, each parked in its own model call.
    const first = await r.service.drain(
      runId, [request(0), request(1), request(2)], new AbortController().signal,
    )
    expect(first.filter(outcome => outcome.accepted)).toHaveLength(N)
    await waitForRefill(
      () => r.adapter.distinctSessions.filter(id => id !== String(r.root.id)).length === N,
      'all N children reaching their own model request',
      () => `${String(r.adapter.distinctSessions.length)} sessions seen`,
    )
    expect(r.gate.snapshot().liveChildren).toBe(N)
    expect(r.gate.occupied).toBe(N)

    // ---- The N+1th is refused: the target really binds at N. -------------
    const over = await r.service.drain(runId, [request(9)], new AbortController().signal)
    expect(over[0]?.accepted).toBe(false)
    expect(r.gate.snapshot().liveChildren).toBe(N)

    // ---- Release EXACTLY ONE child; the other N-1 stay held open. --------
    const settling = liveChildrenOf(r.ctx, r.root)[0]!
    const settlingTask = `task-${settling.slice('child-'.length)}`
    r.adapter.release(settling)
    await waitForRefill(
      () => r.ctx.agents.get(SessionId(settling)) === undefined,
      `${settling} to leave the registry`,
      () => `${String(liveChildrenOf(r.ctx, r.root).length)} still live`,
    )

    // THE PRECONDITION THAT MAKES THE NEXT ASSERTION MEANINGFUL: the wave is NOT
    // over. Without this, a wave scheduler would pass and the case would prove
    // nothing.
    const stillLive = liveChildrenOf(r.ctx, r.root)
    expect(stillLive, 'N-1 siblings must still be active').toHaveLength(N - 1)
    expect(stillLive).not.toContain(settling)
    // And they still HOLD their slots: an unfinished child is not a free slot.
    expect(stillLive.filter(id => r.gate.hasChild(id))).toHaveLength(N - 1)

    // The completed task's slot is freed only by its CONFIRMED transition.
    await confirm(r, runId, settlingTask)
    expect(r.service.counts(runId).capacityDeficit).toBe(1)

    // ---- THE ROLLING REFILL. --------------------------------------------
    // Admitted NOW, with N-1 children still active. A wave scheduler waits for
    // those siblings, which never finish in this rig, so `waitForRefill` reports
    // the live count instead of the refill.
    const replacement = await r.service.drain(runId, [request(50)], new AbortController().signal)
    expect(replacement[0]?.accepted).toBe(true)
    await waitForRefill(
      () => r.adapter.distinctSessions.includes('child-50'),
      'the replacement reaching its OWN model request while siblings are held open',
      () => `${String(liveChildrenOf(r.ctx, r.root).length)} live; `
        + `replacement seen: ${String(r.adapter.distinctSessions.includes('child-50'))}`,
    )

    // Back at exactly N, never above it, with the originals still running.
    const nowLive = liveChildrenOf(r.ctx, r.root)
    expect(nowLive).toHaveLength(N)
    expect(nowLive).toContain('child-50')
    expect(nowLive).not.toContain(settling)
    expect(r.gate.occupied).toBe(N)
    expect(r.gate.snapshot().highWater).toBe(N)
    expect(r.service.counts(runId).capacityDeficit).toBe(0)

    // N+1 DISTINCT children have now run while the cap was never exceeded. This
    // is the difference between "N concurrent" and "N total": the replacement is
    // a new child, admitted because one of the N terminated.
    const all = r.adapter.distinctSessions.filter(id => id !== String(r.root.id))
    expect(all).toHaveLength(N + 1)
    expect(new Set(all).size).toBe(N + 1)
  }, 60_000)

  it('THREE sequential single completions each refill, with siblings held open (N=3)', async () => {
    // A SUSTAINED property rather than a one-off: a wave scheduler fails on the
    // first round, and a "refill once then latch" bug fails on the second.
    const N = 3
    const r = await refillRig(N)
    const runId = 'run-sustained'
    await r.service.createRun({ runId, root: r.root, authorizationRef: 'auth', targetChildren: N })
    r.service.setReadyTasks(runId, 20)
    r.service.setLaunchPort(createContinuableLaunchPort({
      subagents: r.ctx.subagents, parent: r.root, provider: 'spawn', maxDepth: 1,
    }))

    await r.service.drain(runId, [request(0), request(1), request(2)], new AbortController().signal)
    await waitForRefill(
      () => r.gate.snapshot().liveChildren === N,
      'the full N to be resident',
      () => `liveChildren=${String(r.gate.snapshot().liveChildren)}`,
    )

    for (let round = 0; round < 3; round += 1) {
      const victim = liveChildrenOf(r.ctx, r.root)[0]!
      const victimTask = `task-${victim.slice('child-'.length)}`
      r.adapter.release(victim)
      await waitForRefill(
        () => r.ctx.agents.get(SessionId(victim)) === undefined,
        `round ${String(round)}: ${victim} to leave`,
        () => `${String(liveChildrenOf(r.ctx, r.root).length)} live`,
      )
      await confirm(r, runId, victimTask)
      const admitted = await r.service.drain(runId, [request(60 + round)], new AbortController().signal)
      expect(admitted[0]?.accepted, `round ${String(round)} must refill`).toBe(true)
      await waitForRefill(
        () => r.adapter.distinctSessions.includes(`child-${String(60 + round)}`),
        `round ${String(round)}: child-${String(60 + round)} to reach a model request`,
        () => `${String(liveChildrenOf(r.ctx, r.root).length)} live`,
      )
      expect(liveChildrenOf(r.ctx, r.root)).toHaveLength(N)
      expect(r.gate.occupied).toBe(N)
      expect(r.gate.snapshot().highWater).toBe(N)
    }
    // N + 3 distinct children ran; the host never held more than N.
    expect(r.adapter.distinctSessions.filter(id => id !== String(r.root.id))).toHaveLength(N + 3)
    expect(r.gate.snapshot().highWater).toBe(N)
  }, 90_000)

  it('CAP-06 FIXED: two freed slots admit exactly two, not three', async () => {
    // =====================================================================
    // THIS CASE WAS `it.fails` AND IS NOW A REAL ASSERTION. The history is kept
    // because the before/after pair is the evidence that the defect was closed.
    //
    // WHAT WAS WRONG, and where. `WorkService.drain` (`host.ts`) coalesced like
    // this:
    //
    //     const inFlight = this.pendingDrain.get(runId)
    //     if (inFlight !== undefined) await inFlight
    //     const task = this.runDrain(runId, requests, signal)   // <-- no re-check
    //     this.pendingDrain.set(runId, task)
    //
    // A burst of K concurrent calls therefore awaited the SAME in-flight drain,
    // and when that one settled all K-1 waiters resumed in one microtask batch.
    // Each then started its OWN `runDrain` without re-reading `pendingDrain`, so
    // K-1 drains ran CONCURRENTLY. Each read the record with `countRun` before
    // the others' `admit` had committed, so they all observed the same deficit
    // and all admitted.
    //
    // MEASURED BEFORE THE FIX: two freed slots at target 3, three concurrent
    // drains -> three accepted, four tasks holding slots against a target of
    // three, four live children. The trace was
    //   req(70) accepted=true, req(71) accepted=true, req(72) accepted=true
    // with the deficit reading 2 for every one of them. Archived under
    // `qualification/results/R3-f5-admission/`.
    //
    // WHY THE EXISTING C03 CASE DID NOT CATCH IT. `scheduling.test.ts` C03 frees
    // THREE slots and then storms THREE refills, so three admissions is the
    // CORRECT answer there and the over-admission is invisible. The defect only
    // shows when the number of concurrent requests EXCEEDS the number of free
    // slots — which is the case that matters, because that is the case that
    // oversubscribes.
    //
    // THE FIX, and why it is not in the coalescer. The target check moved INSIDE
    // one storage-domain `update` (`WorkService.tryReserveAdmission`), where the
    // domain's per-domain write chain serializes it against every other write to
    // this run — the same place the BUDGET check already was, which is why CAP-09
    // never had this hole. `drain` also gained a single-leader generation loop,
    // but that layer is EFFICIENCY ONLY: this test would pass with the coalescer
    // removed entirely, and `f5-admission.test.ts` proves that by driving the
    // reservation path with the leader bypassed.
    // =====================================================================
    const N = 3
    const r = await refillRig(N)
    const runId = 'run-storm'
    await r.service.createRun({ runId, root: r.root, authorizationRef: 'auth', targetChildren: N })
    r.service.setReadyTasks(runId, 20)
    r.service.setLaunchPort(createContinuableLaunchPort({
      subagents: r.ctx.subagents, parent: r.root, provider: 'spawn', maxDepth: 1,
    }))

    await r.service.drain(runId, [request(0), request(1), request(2)], new AbortController().signal)
    await waitForRefill(
      () => r.gate.snapshot().liveChildren === N,
      'the full N to be resident',
      () => `liveChildren=${String(r.gate.snapshot().liveChildren)}`,
    )

    // Free exactly TWO slots, leaving one child active.
    const victims = liveChildrenOf(r.ctx, r.root).slice(0, 2)
    for (const victim of victims) r.adapter.release(victim)
    await waitForRefill(
      () => victims.every(id => r.ctx.agents.get(SessionId(id)) === undefined),
      'the two released children to leave the registry',
      () => `${String(liveChildrenOf(r.ctx, r.root).length)} live`,
    )
    for (const victim of victims) await confirm(r, runId, `task-${victim.slice('child-'.length)}`)
    expect(r.service.counts(runId).capacityDeficit).toBe(2)

    // THREE concurrent refills against TWO free slots. The correct answer is 2.
    const signal = new AbortController().signal
    const [a, b, c] = await Promise.all([
      r.service.drain(runId, [request(70)], signal),
      r.service.drain(runId, [request(71)], signal),
      r.service.drain(runId, [request(72)], signal),
    ])
    const admitted = [...a, ...b, ...c].filter(outcome => outcome.accepted)
    // THE PROPERTY. Currently measured at 3; the defect is exactly that this is
    // not 2.
    expect(admitted, 'two freed slots admit exactly two, never three').toHaveLength(2)

    // And the record must not hold more tasks than the target.
    const record = r.service.getRun(runId)!
    const held = Object.values(record.tasks).filter(task => holdsSlot(task.state)).length
    expect(held, 'held tasks must never exceed the target').toBeLessThanOrEqual(N)
    expect(liveChildrenOf(r.ctx, r.root).length).toBeLessThanOrEqual(N)
  }, 60_000)
})

// ---------------------------------------------------------------------------
// THE FALSIFICATION ARM.
//
// A test that cannot fail is not evidence. The case above asserts a refill
// happens mid-wave; this one runs a DELIBERATELY WAVE-SCHEDULED policy through
// the SAME measurement and shows it produces NO refill. Same rig, same N, same
// service, same completion edge — only the refill POLICY differs. If the
// assertion above were satisfiable by wave scheduling, this arm would pass too
// and the pair would prove nothing.
// ---------------------------------------------------------------------------

describe('CAP-05 falsification: a WAVE policy produces no refill under the same measurement', () => {
  it('declines while a sibling is active, where the rolling path admits (N=3)', async () => {
    const N = 3
    const sessionRoot = mkdtempSync(join(tmpdir(), 'dsh-t10-wave-sessions-'))
    const storeRoot = mkdtempSync(join(tmpdir(), 'dsh-t10-wave-store-'))
    const ctx = new Context()
    await mountAgentLoopTestDependencies(ctx)
    const persistence = await ctx.plugin(JsonlSessionPersistence, { root: sessionRoot })
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(SubagentRuntime, { maxActiveSubagents: 64, maxDepth: 1 })
    await ctx.plugin(SubagentSpawn, { providerName: 'spawn' })
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
    const root = await ctx.agentLoop.create(SessionId('t10-wave-root'), { provider: 'mock', model: 'mock' })
    const service = new WorkService(ctx, {
      targetChildren: N, maxDepth: 1, budgetCeiling: 10_000, currency: 'USD',
      priceVersion: 't10-wave', subagentProvider: 'spawn',
    })
    await service.open()
    cleanups.push(async () => {
      adapter.openAll()
      await service.close()
      await ctx.subagents.drainContinuableDescendants([root])
      await persistence.dispose()
      await ctx.fiber.dispose()
      rmSync(sessionRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
      rmSync(storeRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    })

    const runId = 'run-wave'
    await service.createRun({ runId, root, authorizationRef: 'auth', targetChildren: N })
    service.setReadyTasks(runId, 10)
    service.setLaunchPort(createContinuableLaunchPort({
      subagents: ctx.subagents, parent: root, provider: 'spawn', maxDepth: 1,
    }))
    const live = (): string[] => ctx.agents.list()
      .filter(agent => agent.session.header.parentSession === root.id)
      .map(agent => String(agent.id))
    /** The launch request shape, declared locally: this arm is its own rig. */
    const request = (n: number): LaunchRequest => ({
      taskId: `task-${n}`, childId: `child-${n}`, prompt: `work ${n}`, reservedCost: 1,
    })
    const waitFor = async (condition: () => boolean, what: string): Promise<void> => {
      const deadline = Date.now() + 20_000
      while (Date.now() < deadline) {
        if (condition()) return
        await new Promise(resolve => setTimeout(resolve, 10))
      }
      throw new Error(`timed out waiting for ${what}`)
    }

    await service.drain(runId, [request(0), request(1), request(2)], new AbortController().signal)
    await waitFor(() => live().length === N, 'three children resident')

    // Complete ONE child, leaving N-1 active.
    adapter.release('child-0')
    await waitFor(() => ctx.agents.get(SessionId('child-0')) === undefined, 'child-0 to leave')
    await service.transition({ runId, taskId: 'task-0', to: 'settling' })
    await service.transition({ runId, taskId: 'task-0', to: 'confirmed', spentCost: 0 })
    expect(service.counts(runId).capacityDeficit).toBe(1)
    expect(live()).toHaveLength(N - 1)

    // ---- THE WAVE POLICY, made executable. -------------------------------
    // A free slot exists and the run's own deficit is 1, so the SERVICE would
    // admit. The wave policy declines because a sibling is still active — this
    // is the scheduling discipline the requirement forbids, written out so the
    // case runs against it rather than against a description of it.
    const waveWouldRefill = live().length === 0
    expect(waveWouldRefill, 'a wave scheduler sees N-1 active siblings and declines').toBe(false)
    const waveAdmissions = waveWouldRefill
      ? await service.drain(runId, [request(80)], new AbortController().signal)
      : []
    expect(waveAdmissions.filter(outcome => outcome.accepted)).toHaveLength(0)
    expect(adapter.distinctSessions).not.toContain('child-80')
    expect(live()).toHaveLength(N - 1)

    // ---- The SAME state, under the rolling policy. -----------------------
    // Identical preconditions — one free slot, N-1 active siblings — and the
    // refill happens immediately. This is the discriminator: the only difference
    // between the arms is the policy, so the assertion in the case above cannot
    // be satisfied by wave scheduling.
    const rolling = await service.drain(runId, [request(81)], new AbortController().signal)
    expect(rolling[0]?.accepted, 'the rolling path admits under the SAME conditions').toBe(true)
    await waitFor(() => adapter.distinctSessions.includes('child-81'), 'child-81 to reach a model request')
    expect(live()).toHaveLength(N)
    expect(live()).toEqual(expect.arrayContaining(['child-1', 'child-2', 'child-81']))
  }, 60_000)
})

// ---------------------------------------------------------------------------
// CAP-07 / CAP-08 — a stopping or quarantined executor HOLDS its slot.
//
// These are reasoning checks over the ledger, not load tests: the rule is about
// WHICH states occupy, and the smallest witness is one holder plus one refused
// admission. No child is spawned.
// ---------------------------------------------------------------------------

describe('CAP-07/CAP-08: a stopping or quarantined executor holds capacity', () => {
  it('CAP-07: a slot is NOT released on `cancel requested`, only on quiescence', () => {
    // The plan's rule: a SENT cancel is not a CONFIRMED cancel. The bucket moves
    // to `stopping`, which still occupies, so the 31st admission is still
    // refused while the cancel is in flight.
    const gate = new ChildAdmissionGate(2)
    gate.reserveTask('stopping-executor', 'active_assignment')
    gate.reserveTask('other', 'active_assignment')
    expect(gate.occupied).toBe(2)
    expect(() => gate.reserveTask('late', 'reserved')).toThrow(ChildCapacityError)

    // The cancel is REQUESTED: the bucket changes, the occupancy does not.
    gate.reserveTask('stopping-executor', 'stopping')
    expect(gate.occupied, 'a requested cancel must not free the slot').toBe(2)
    expect(() => gate.reserveTask('late', 'reserved')).toThrow(ChildCapacityError)

    // ONLY quiescence releases it.
    gate.releaseTask('stopping-executor')
    expect(gate.occupied).toBe(1)
    gate.reserveTask('late', 'reserved')
    expect(gate.occupied).toBe(2)
  })

  it('CAP-08: a quarantined executor holds capacity, and a live one is counted ONCE', () => {
    // Two directions, both required:
    //   - quarantine OCCUPIES (never released early);
    //   - a quarantined executor that is ALSO live is ONE executor, not two.
    // The second is the direction a naive "quarantine always adds" rule gets
    // wrong, and getting it wrong halves the effective cap exactly when the cap
    // matters most.
    const unbacked = new ChildAdmissionGate(2)
    unbacked.reserveTask('q', 'unknown_quarantined')
    unbacked.reserveTask('live-elsewhere', 'active_assignment')
    expect(unbacked.occupied, 'a quarantined executor occupies').toBe(2)
    expect(() => unbacked.reserveTask('third', 'reserved')).toThrow(ChildCapacityError)
    expect(unbacked.snapshot().unknownQuarantined).toBe(1)

    const backed = new ChildAdmissionGate(3)
    backed.reserveTask('t', 'unknown_quarantined', 'c1')
    backed.reserveChild('c1')
    expect(backed.occupied, 'a quarantined executor whose child is live is still ONE').toBe(1)
    expect(backed.snapshot().unknownQuarantined, 'and it is still reported as quarantined').toBe(1)
    // The diagnostic subset never inflates the total.
    expect(backed.snapshot().occupied).toBe(backed.snapshot().liveChildren + backed.snapshot().unbackedReservations)
  })

  it('a reservation admits the child it reserved, at exactly capacity', () => {
    // The deadlock this closes, measured before the fix: with a reservation taken
    // for each child and the host exactly full, materializing those children was
    // REFUSED because the ledger charged room for a child its own reservation
    // already covered. At capacity C with C reservations the host admitted ZERO
    // children — it wedged at precisely the capacity it exists to sustain.
    const C = 3
    const gate = new ChildAdmissionGate(C)
    for (const id of ['c1', 'c2', 'c3']) gate.reserveTask(`t-${id}`, 'starting', id)
    expect(gate.occupied).toBe(C)
    // Every reserved child materializes: each is a CONVERSION, not a new slot.
    for (const id of ['c1', 'c2', 'c3']) {
      expect(() => gate.reserveChild(id), `${id} must materialize under its own reservation`).not.toThrow()
    }
    expect(gate.occupied, 'still exactly C executors, now all backed').toBe(C)
    expect(gate.snapshot().liveChildren).toBe(C)
    expect(gate.snapshot().unbackedReservations).toBe(0)
    // A genuinely NEW child with no reservation is still refused: the fold must
    // not become a bypass.
    expect(() => gate.reserveChild('c-new')).toThrow(ChildCapacityError)
    expect(gate.snapshot().highWater).toBe(C)
  })
})

// ---------------------------------------------------------------------------
// CAP-09 / CAP-10 / CAP-11 — deficit reporting, a lower that does not cancel,
// and the root's own headroom. All are pure record/gate reasoning; none spawns
// a child, and the N used is the smallest that shows the property.
// ---------------------------------------------------------------------------

describe('CAP-09/CAP-10/CAP-11: deficit, a lower that cancels nothing, root headroom', () => {
  it('CAP-09: a ready shortage at N=30 with 2 ready creates exactly 2 REAL children', async () => {
    // The plan's rule is "没有任务不补空Agent": the system must NOT invent 28 idle
    // agents to make the number look right. The target stays 30 and the deficit
    // is REPORTED, not filled.
    //
    // The child count here is TWO, which is the point: the case runs at N=30
    // because the SHORTAGE is only expressible at a high target, but it does not
    // run 30 children. Two real ones is the whole cost.
    const r = await rig()
    const runId = 'run-shortage'
    await r.service.createRun({
      runId, root: r.root, authorizationRef: 'auth', targetChildren: 30,
    })
    r.service.setReadyTasks(runId, 2)

    const outcomes = await r.service.drain(
      runId,
      [
        { taskId: 'task-1', childId: 'child-1', prompt: 'work 1', reservedCost: 1 },
        { taskId: 'task-2', childId: 'child-2', prompt: 'work 2', reservedCost: 1 },
      ],
      new AbortController().signal,
    )
    expect(outcomes.filter(outcome => outcome.accepted)).toHaveLength(2)

    // TWO children exist. Not 30.
    expect(r.gate.snapshot().liveChildren).toBe(2)
    const counts = r.service.counts(runId)
    expect(counts.desiredTarget, 'the target is NOT silently reduced').toBe(30)
    expect(counts.capacityDeficit).toBe(28)
    expect(counts.deficitReason).toBe('insufficient_ready_tasks')

    // The shortage is RECORDED against the run, so a reader can see it without
    // polling a counter. `admit` writes one outbox entry per admitted task.
    const record = r.service.getRun(runId)!
    expect(Object.keys(record.outbox).length).toBeGreaterThanOrEqual(2)

    // And no idle Session was created to pad the count: the real registry agrees
    // there are exactly two children.
    const listed = await r.ctx.subagents.listChildren(r.root.id)
    expect(listed.length).toBe(2)
  })

  it('CAP-10: lowering N stops new admission WITHOUT fabricating cancellations', async () => {
    // "N下降温和收敛；N变化不改正在运行任务的原budget." A lower is a target change and
    // NOTHING else: no kill, no cancel, no rewritten budget.
    const r = await rig()
    const runId = 'run-lower'
    await r.service.createRun({ runId, root: r.root, authorizationRef: 'auth', targetChildren: 3 })
    r.service.setReadyTasks(runId, 10)
    r.service.setLaunchPort({
      async launch(request): Promise<{ childId: string }> {
        await startChild(r, request.childId, request.taskId)
        return { childId: request.childId }
      },
    })
    const signal = new AbortController().signal
    const drain = (ids: readonly string[]): Promise<Array<{ accepted: boolean }>> => r.service.drain(
      runId,
      ids.map(id => ({ taskId: `task-${id}`, childId: `child-${id}`, prompt: `work ${id}`, reservedCost: 1 })),
      signal,
    )

    // Three admitted at target 3.
    expect((await drain(['1', '2', '3'])).filter(outcome => outcome.accepted)).toHaveLength(3)
    expect(r.gate.snapshot().liveChildren).toBe(3)

    // LOWER 3 -> 1.
    await r.service.setTargetChildren(runId, 1)
    const after = await drain(['4', '5'])
    expect(after.filter(outcome => outcome.accepted), 'a lower admits nothing new').toHaveLength(0)

    // NOTHING was cancelled, killed or rewritten.
    const record = r.service.getRun(runId)!
    for (const id of ['1', '2', '3']) {
      expect(record.tasks[`task-${id}`]?.state, `task-${id} must not be cancelled`).not.toBe('cancelled')
      expect(record.tasks[`task-${id}`]?.reservedCost, `task-${id} budget must be unchanged`).toBe(1)
      expect(r.ctx.agents.get(SessionId(`child-${id}`)), `child-${id} must still be running`).toBeDefined()
      expect(r.gate.hasChild(`child-${id}`), `child-${id} must still hold its slot`).toBe(true)
    }
    expect(record.tasks['task-4']).toBeUndefined()
    expect(record.tasks['task-5']).toBeUndefined()
    // The lower is recorded as a TARGET, not as a cancellation count.
    expect(record.requestedTarget).toBe(1)
    expect(record.terminalTombstones, 'no task was tombstoned by the lower').toEqual([])
  })

  it('CAP-11: the root is not counted in N and keeps its own provider headroom', async () => {
    // Two halves: the root holds no child slot, and a child admission that would
    // eat the root's reserve is refused by the SAME comparison the budget gate
    // uses — so the root always retains credit to integrate results.
    const r = await rig()
    const runId = 'run-root'
    await r.service.createRun({
      runId, root: r.root, authorizationRef: 'auth', targetChildren: 30, rootReserve: 100,
    })
    // The root took no child slot.
    expect(r.gate.snapshot().liveChildren).toBe(0)

    // A greedy child admission is refused, and the refusal names the budget.
    await expect(
      r.service.admit({
        runId,
        taskId: 'greedy',
        childId: 'c-greedy',
        assignmentDigest: 'd',
        reservedCost: 9_901,
        allowedCapabilities: ['reader'],
      }),
    ).rejects.toThrow(/no budget headroom/)

    // The root's reserve is intact, and the refusal cost no slot.
    expect(r.service.budget(runId).rootAvailable).toBe(100)
    expect(r.gate.occupied, 'a refused admission leaves no slot behind').toBe(0)
  })
})

// ---------------------------------------------------------------------------
// T10 — THE MANDATORY N=10 ARM, and the arithmetic at the deployment's OWN
// numbers (target 10, hard cap 30, root excluded).
//
// WHAT IS DIFFERENT HERE FROM EVERY CASE ABOVE. The cases above run at N=3 or
// N=30-SYNTHETIC because the property under test was the gate's logic. This
// block runs at the numbers the DEPLOYMENT actually ships
// (`cordis.patch.yml`: `targetChildren: 10`, `maxActiveSubagents: 10`,
// `HARD_CHILD_CAPACITY = 30`), because the mandatory requirement is stated in
// those numbers: "N=10 real rolling child top-up is MANDATORY", "the root is NOT
// counted in the 10", "the hard capacity is a deployment constant of 30".
//
// COST, stated rather than hidden. Ten real children ARE spawned here — the
// requirement names a real count and an arithmetic-only substitute would be a
// weaker oracle for it. They are not 30, and the cap arm is measured
// arithmetically on the same ledger rather than by spawning 30, which is the
// user's own instruction. The provider is the scripted local route (no paid
// budget is authorized), so this proves the MECHANICAL admission/refill at N=10
// and does not claim a live-provider result.
//
// G-SEAM-31, WHICH BOUNDS WHAT THIS PROVES. The run these cases measure is
// created by calling `service.createRun(...)` DIRECTLY. That is a
// TEST-INSTALLED ENTRY POINT: `createRun` has no production caller, so no user
// action on the composed profile can reach any of it (docs/GAPS.md G-SEAM-31,
// re-verified in qualification/results/T10-capacity/create-run-callers.txt).
// The arithmetic and the refill below are therefore claims about the MECHANISM,
// not about the product. The composed-profile claim is measured separately and
// reported as FAIL/BLOCKED, never as PASS on the strength of these cases.
// ---------------------------------------------------------------------------

describe('T10: the mandatory N=10 arm at the deployment numbers', () => {
  const N10 = 10

  interface N10Rig {
    readonly ctx: Context
    readonly root: Agent
    readonly service: WorkService
    readonly adapter: PerChildGateAdapter
    readonly gate: ChildAdmissionGate
  }

  /**
   * Boot the real continuable stack at the SHIPPED deployment numbers.
   *
   * `maxActiveSubagents: 10` is the composed profile's own value
   * (`cordis.patch.yml`), NOT raised above the host cap. That is deliberate and
   * it is the difference from the `refillRig` above: here the per-root pool and
   * the host ledger are set to the same number, so a refusal at 11 is
   * over-determined and this rig cannot tell them apart. The HOST cap of 30 is
   * therefore measured arithmetically on this ledger, and the "which ceiling
   * refused" question is answered by the two-roots case in CAP-07, which raises
   * the pool above the ledger on purpose.
   */
  async function n10Rig(): Promise<N10Rig> {
    const sessionRoot = mkdtempSync(join(tmpdir(), 'dsh-t10-n10-sessions-'))
    const storeRoot = mkdtempSync(join(tmpdir(), 'dsh-t10-n10-store-'))
    const ctx = new Context()
    await mountAgentLoopTestDependencies(ctx)
    const persistence = await ctx.plugin(JsonlSessionPersistence, { root: sessionRoot })
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(SubagentRuntime, { maxActiveSubagents: N10, maxDepth: 1 })
    await ctx.plugin(SubagentSpawn, { providerName: 'spawn' })
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
    const root = await ctx.agentLoop.create(SessionId('t10-n10-root'), { provider: 'mock', model: 'mock' })
    const service = new WorkService(ctx, {
      targetChildren: N10,
      maxDepth: 1,
      budgetCeiling: 10_000,
      currency: 'USD',
      priceVersion: 't10-n10',
      subagentProvider: 'spawn',
    })
    await service.open()
    cleanups.push(async () => {
      adapter.openAll()
      await service.close()
      await ctx.subagents.drainContinuableDescendants([root])
      await persistence.dispose()
      await ctx.fiber.dispose()
      rmSync(sessionRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
      rmSync(storeRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    })
    return { ctx, root, service, adapter, gate: service.capacityGate }
  }

  /** Live children of a root, read from the REAL agent registry. */
  const liveChildrenOf = (ctx: Context, root: Agent): string[] =>
    ctx.agents.list()
      .filter(agent => agent.session.header.parentSession === root.id)
      .map(agent => String(agent.id))

  /** Wait for a background driver to reach a condition, reporting state on timeout. */
  async function waitForN10(
    condition: () => boolean,
    what: string,
    diagnostic: () => string,
    timeoutMs = 30_000,
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (condition()) return
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    throw new Error(`timed out after ${timeoutMs}ms waiting for ${what}. State: ${diagnostic()}`)
  }

  const requestN = (n: number): LaunchRequest => ({
    taskId: `task-${n}`, childId: `child-${n}`, prompt: `work ${n}`, reservedCost: 1,
  })

  it('the ADMIT/REFUSE BOUNDARY at target 10 and hard cap 30, with the root excluded', () => {
    // THE ARITHMETIC, measured on the deployment's own ledger rather than
    // described. The root is excluded BY CONSTRUCTION: `isSessionBackedChild`
    // reads the child's own durable header, and a root carries neither
    // `origin: 'subagent'` nor a delegation depth, so `mountChildAdmissionGuard`
    // returns before touching the ledger. That is asserted live in the case
    // below; here the ledger's own boundary is what is measured.
    const gate = new ChildAdmissionGate()
    expect(gate.limit, 'the deployment constant is 30, not a setting').toBe(30)
    expect(HARD_CHILD_CAPACITY).toBe(30)

    // --- The TARGET band: 10 occupied is what a healthy deployment holds. ---
    const held = Array.from({ length: N10 }, (_, i) => gate.reserveChild(`n10-${i}`))
    expect(gate.occupied).toBe(10)
    expect(gate.occupied, 'the target of 10 is NOT the cap').toBeLessThan(gate.limit)

    // --- The HARD band: the cap binds at 30, and 30 is where a refusal starts.
    for (let i = N10; i < 30; i += 1) gate.reserveChild(`n10-${i}`)
    expect(gate.occupied).toBe(30)
    expect(gate.snapshot().highWater).toBe(30)
    expect(() => gate.reserveChild('n10-30'), 'the 31st is refused').toThrow(ChildCapacityError)
    expect(() => gate.reserveChild('n10-31'), 'the 32nd is refused').toThrow(/hard capacity is 30/)
    expect(gate.occupied, 'a refusal never raises occupancy').toBe(30)
    expect(gate.snapshot().highWater, 'never exceeded 30 at any instant').toBe(30)
    expect(gate.snapshot().refusals.HOST_CAPACITY_REACHED).toBe(2)

    // The refusal carries the numbers, so a report can state them without
    // re-deriving anything.
    let refusal: ChildCapacityError | undefined
    try {
      gate.reserveChild('n10-32')
    } catch (error) {
      refusal = error as ChildCapacityError
    }
    expect(refusal?.code).toBe('HOST_CAPACITY_REACHED')
    expect(refusal?.occupied).toBe(30)
    expect(refusal?.capacity).toBe(30)

    // --- The 30-band is 3x the 10-band: 20 more children fit above the target.
    held[0]!.release()
    expect(gate.occupied).toBe(29)
    gate.reserveChild('n10-refill')
    expect(gate.occupied).toBe(30)
    expect(() => gate.reserveChild('n10-33')).toThrow(ChildCapacityError)
    expect(gate.snapshot().highWater).toBe(30)

    // THE ARITHMETIC, stated as the numbers it is: at target 10 the host holds
    // 10 executors and has 20 slots of headroom below the cap of 30; the 31st
    // child is the first refusal; the target of 10 is a SUSTAINED figure that
    // never binds the cap.
    expect(gate.limit - N10, 'headroom above the target').toBe(20)
    expect(gate.limit - gate.occupied, 'headroom at the cap').toBe(0)
  })

  it('the root EXCLUSION is the classifier, not the mount order', async () => {
    // WHY THIS CASE EXISTS. The case above asserts "the root holds no slot", but
    // in that rig the root is created BEFORE the service opens, so its
    // `agent/created` event fired before the guard was ever mounted. The
    // assertion would therefore hold even if `isSessionBackedChild` returned
    // true for everything — a weaker oracle than the scenario, which is the
    // defect class this project keeps recording. This case removes the
    // confound: the gate is mounted FIRST, then a root and a child are created
    // AFTER it, and the classifier's answer is read directly in both
    // directions.
    const r = await n10Rig()

    // A SECOND root, created after the guard is live. Its creation must not
    // consume a child slot.
    const laterRoot = await r.ctx.agentLoop.create(
      SessionId('t10-later-root'), { provider: 'mock', model: 'mock' },
    )
    expect(r.gate.hasChild('t10-later-root'), 'a root created AFTER the mount takes no slot').toBe(false)
    expect(r.gate.occupied, 'and the ledger is still empty').toBe(0)

    // THE CLASSIFIER ITSELF, both directions. This is the load-bearing half:
    // a root is not a session-backed child, and a child is.
    expect(isSessionBackedChild(laterRoot), 'a root is NOT a session-backed child').toBe(false)
    expect(isSessionBackedChild(r.root), 'nor is the first root').toBe(false)

    // Now a REAL child through the same live guard: it IS classified as a child
    // and it DOES take a slot. Without this half, a classifier that returned
    // false for everything would pass the two assertions above.
    await r.ctx.subagents.startContinuable({
      provider: 'spawn',
      label: 'discriminator-child',
      childId: SessionId('discriminator-child'),
      request: { parent: laterRoot, prompt: [{ type: 'text', text: 'work' }], maxDepth: 1 },
      signal: new AbortController().signal,
    })
    const child = r.ctx.agents.get(SessionId('discriminator-child'))
    expect(child, 'the child is live').toBeDefined()
    expect(isSessionBackedChild(child!), 'a child IS a session-backed child').toBe(true)
    expect(r.gate.hasChild('discriminator-child'), 'and it took a slot').toBe(true)
    expect(r.gate.snapshot().liveChildren, 'exactly one executor: the child, not the two roots').toBe(1)
    expect(r.gate.occupied, 'the two roots are not executors').toBe(1)
  }, 60_000)

  it('REAL N=10: ten children in flight, the 11th refused, and the root holds no slot', async () => {
    const r = await n10Rig()
    const runId = 'run-n10'
    await r.service.createRun({ runId, root: r.root, authorizationRef: 'auth', targetChildren: N10 })
    r.service.setReadyTasks(runId, 20)
    r.service.setLaunchPort(createContinuableLaunchPort({
      subagents: r.ctx.subagents, parent: r.root, provider: 'spawn', maxDepth: 1,
    }))

    // --- TEN REAL CHILDREN, admitted through the real continuable seam. ------
    const outcomes = await r.service.drain(
      runId,
      Array.from({ length: N10 }, (_, i) => requestN(i)),
      new AbortController().signal,
    )
    expect(outcomes.filter(o => o.accepted), 'all ten admitted').toHaveLength(N10)

    // Every one reaches its OWN model request and is parked there, so "ten in
    // flight" is a fact about live provider calls rather than a race.
    await waitForN10(
      () => r.adapter.distinctSessions.filter(id => id !== String(r.root.id)).length === N10,
      'all ten children to reach their own model request',
      () => `${String(r.adapter.distinctSessions.length)} sessions seen`,
    )
    expect(r.adapter.distinctSessions.filter(id => id !== String(r.root.id)), 'ten DISTINCT children')
      .toHaveLength(N10)

    // The real registry agrees, and the HOST ledger agrees.
    const listed = await r.ctx.subagents.listChildren(r.root.id)
    expect(listed, 'the real subagent registry lists ten').toHaveLength(N10)
    expect(r.gate.snapshot().liveChildren, 'the host ledger holds ten').toBe(N10)
    expect(r.gate.occupied).toBe(N10)

    // --- THE ROOT IS NOT ONE OF THE TEN, AND HOLDS NO SLOT. ------------------
    expect(listed.map(c => String(c.id)), 'the root is not among the children')
      .not.toContain(String(r.root.id))
    expect(r.gate.hasChild(String(r.root.id)), 'the root took no child slot').toBe(false)
    expect(r.gate.snapshot().liveChildren, 'ten children means ten, not eleven').toBe(N10)

    // --- THE 11TH IS REFUSED at the target, and the ledger never rose above 10.
    const over = await r.service.drain(runId, [requestN(99)], new AbortController().signal)
    expect(over[0]?.accepted, 'the 11th is refused while ten hold their slots').toBe(false)
    expect(r.gate.occupied).toBe(N10)
    expect(r.gate.snapshot().highWater).toBe(N10)
    expect(liveChildrenOf(r.ctx, r.root)).toHaveLength(N10)
    // The refused task did not leak a slot or a child.
    expect(r.service.getRun(runId)?.tasks['task-99']).toBeUndefined()
    expect(r.ctx.agents.get(SessionId('child-99'))).toBeUndefined()

    // The run reports the target it was given, un-reduced.
    expect(r.service.counts(runId).desiredTarget).toBe(N10)
    expect(r.service.counts(runId).capacityDeficit, 'no deficit at a full target').toBe(0)
  }, 90_000)

  it('REAL N=10 ROLLING REFILL: one completion admits exactly one more, back to ten', async () => {
    // THE MANDATORY PROPERTY, measured at N=10. "Rolling" is not "a batch of
    // ten": the discriminating observation is that a replacement is admitted
    // while the OTHER NINE are still provably active. A wave scheduler cannot
    // produce that, because those nine never finish in this rig.
    const r = await n10Rig()
    const runId = 'run-n10-rolling'
    await r.service.createRun({ runId, root: r.root, authorizationRef: 'auth', targetChildren: N10 })
    r.service.setReadyTasks(runId, 40)
    r.service.setLaunchPort(createContinuableLaunchPort({
      subagents: r.ctx.subagents, parent: r.root, provider: 'spawn', maxDepth: 1,
    }))

    await r.service.drain(
      runId,
      Array.from({ length: N10 }, (_, i) => requestN(i)),
      new AbortController().signal,
    )
    await waitForN10(
      () => r.gate.snapshot().liveChildren === N10,
      'the full ten to be resident',
      () => `liveChildren=${String(r.gate.snapshot().liveChildren)}`,
    )

    // --- THREE ROUNDS. A "refill once then latch" bug fails on round 1. ------
    for (let round = 0; round < 3; round += 1) {
      const before = liveChildrenOf(r.ctx, r.root)
      expect(before, `round ${String(round)}: ten active before the completion`).toHaveLength(N10)

      // Complete EXACTLY ONE child. The other nine stay parked in their own
      // model calls — this is the precondition that makes the refill assertion
      // mean something.
      const victim = before[0]!
      const victimTask = `task-${victim.slice('child-'.length)}`
      r.adapter.release(victim)
      await waitForN10(
        () => r.ctx.agents.get(SessionId(victim)) === undefined,
        `round ${String(round)}: ${victim} to leave the registry`,
        () => `${String(liveChildrenOf(r.ctx, r.root).length)} live`,
      )

      // NINE still active, and all nine still HOLD their slots. Without this
      // the round would prove nothing about rolling behaviour.
      const stillLive = liveChildrenOf(r.ctx, r.root)
      expect(stillLive, `round ${String(round)}: nine siblings must still be active`).toHaveLength(N10 - 1)
      expect(stillLive).not.toContain(victim)
      expect(
        stillLive.filter(id => r.gate.hasChild(id)),
        `round ${String(round)}: an unfinished child is not a free slot`,
      ).toHaveLength(N10 - 1)

      // The completion frees the slot only at its CONFIRMED transition.
      await r.service.transition({ runId, taskId: victimTask, to: 'settling' })
      await r.service.transition({ runId, taskId: victimTask, to: 'confirmed', spentCost: 0 })
      expect(r.service.counts(runId).capacityDeficit, `round ${String(round)}: one slot freed`).toBe(1)

      // --- THE REFILL, with nine siblings still active. ---------------------
      const replacementN = 100 + round
      const replacement = await r.service.drain(runId, [requestN(replacementN)], new AbortController().signal)
      expect(replacement[0]?.accepted, `round ${String(round)}: exactly one replacement is admitted`).toBe(true)
      await waitForN10(
        () => r.adapter.distinctSessions.includes(`child-${String(replacementN)}`),
        `round ${String(round)}: the replacement to reach its own model request`,
        () => `${String(liveChildrenOf(r.ctx, r.root).length)} live`,
      )

      // Back at EXACTLY ten, never eleven, with the originals still running.
      const now = liveChildrenOf(r.ctx, r.root)
      expect(now, `round ${String(round)}: the count returns to ten`).toHaveLength(N10)
      expect(now).toContain(`child-${String(replacementN)}`)
      expect(now).not.toContain(victim)
      expect(r.gate.occupied, `round ${String(round)}: the ledger is back to ten`).toBe(N10)
      expect(r.gate.snapshot().highWater, `round ${String(round)}: never above ten`).toBe(N10)
      expect(r.service.counts(runId).capacityDeficit, `round ${String(round)}: deficit cleared`).toBe(0)

      // ONE completion admitted EXACTLY one, not two: the round's arithmetic.
      expect(now).toHaveLength(before.length)
    }

    // TEN PLUS THREE DISTINCT CHILDREN have now run while the host never held
    // more than ten. That is the difference between "10 concurrent" and "10
    // total", and it is the property the requirement names.
    const all = r.adapter.distinctSessions.filter(id => id !== String(r.root.id))
    expect(all, 'ten originals plus three replacements').toHaveLength(N10 + 3)
    expect(new Set(all).size, 'every one a distinct child').toBe(N10 + 3)
    expect(r.gate.snapshot().highWater, 'the peak was never above the target').toBe(N10)
    expect(r.gate.snapshot().refusals.HOST_CAPACITY_REACHED, 'no capacity refusal at a full target').toBe(0)
  }, 120_000)

  it('the ROOT keeps its own inference budget while ten children are in flight', async () => {
    // THE SECOND MANDATORY HALF: "the root is NOT counted in the 10, and must
    // retain its own separate inference budget". Two facts, both measured:
    //   1. the root can still make its OWN model calls while ten children are
    //      parked in theirs — a live provider request from the root's session;
    //   2. that request is not counted against the 10 and does not consume a
    //      child slot, and the root's credit is intact.
    const r = await n10Rig()
    const runId = 'run-root-budget'
    // A ceiling with an explicit reserve, so "the root keeps credit" is a
    // number rather than an adjective.
    await r.service.createRun({
      runId, root: r.root, authorizationRef: 'auth', targetChildren: N10, rootReserve: 500,
    })
    r.service.setReadyTasks(runId, 20)
    r.service.setLaunchPort(createContinuableLaunchPort({
      subagents: r.ctx.subagents, parent: r.root, provider: 'spawn', maxDepth: 1,
    }))
    await r.service.drain(
      runId,
      Array.from({ length: N10 }, (_, i) => requestN(i)),
      new AbortController().signal,
    )
    await waitForN10(
      () => r.gate.snapshot().liveChildren === N10,
      'ten children in flight',
      () => `liveChildren=${String(r.gate.snapshot().liveChildren)}`,
    )

    // --- FACT 1: the ROOT takes a turn of its own, NOW, while ten are parked.
    const before = r.adapter.requests.filter(entry => entry.sessionId === String(r.root.id)).length
    r.root.followup(createUserMessage({
      content: [{ type: 'text', text: 'root integrates while children work' }],
      source: { kind: 'plugin', plugin: 't10-capacity' },
    }))
    await waitForN10(
      () => r.adapter.requests.filter(entry => entry.sessionId === String(r.root.id)).length > before,
      'the ROOT to reach its OWN provider call while ten children are in flight',
      () => `root requests=${String(r.adapter.requests.filter(e => e.sessionId === String(r.root.id)).length)}, `
        + `children live=${String(r.gate.snapshot().liveChildren)}`,
    )
    // The root's request is a REAL model call, and it is the ROOT's session.
    const rootRequests = r.adapter.requests.filter(entry => entry.sessionId === String(r.root.id))
    expect(rootRequests.length, 'the root made its own provider call').toBeGreaterThan(before)
    expect(rootRequests.every(entry => entry.sessionId === String(r.root.id)), 'addressed to the root session').toBe(true)

    // --- FACT 2: it was NOT counted in the 10, and cost no child slot. -------
    expect(r.gate.snapshot().liveChildren, 'still exactly ten children').toBe(N10)
    expect(r.gate.hasChild(String(r.root.id)), 'the root holds no child slot').toBe(false)
    expect(r.gate.occupied, 'the root is not an executor in the ledger').toBe(N10)
    // The root's session is not among the ten children the registry lists.
    const listed = await r.ctx.subagents.listChildren(r.root.id)
    expect(listed.map(c => String(c.id))).not.toContain(String(r.root.id))
    expect(listed).toHaveLength(N10)

    // --- FACT 2b: the root's CREDIT is intact, and a greedy child cannot eat it.
    const report = r.service.budget(runId)
    expect(report.rootReserve).toBe(500)
    expect(report.rootAvailable, 'the root retains its whole reserve').toBe(500)
    expect(report.childCeiling, 'the children are bounded by ceiling - rootReserve').toBe(10_000 - 500)
    await expect(
      r.service.admit({
        runId,
        taskId: 'greedy',
        childId: 'child-greedy',
        assignmentDigest: 'd',
        reservedCost: 9_501,
        allowedCapabilities: ['reader'],
      }),
    ).rejects.toThrow(/no budget headroom/)
    expect(r.service.budget(runId).rootAvailable, 'the refusal did not touch the reserve').toBe(500)
    expect(r.gate.occupied, 'and it leaked no slot').toBe(N10)
    expect(r.gate.snapshot().refusals.HOST_CAPACITY_REACHED, 'a budget refusal is not a capacity refusal').toBe(0)
  }, 90_000)
})
