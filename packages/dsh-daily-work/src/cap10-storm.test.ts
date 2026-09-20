/**
 * S9 / CAP-10 — a completion storm neither duplicates nor misses a top-up.
 *
 * THE ORACLE, verbatim from the v2 definition:
 *
 *   "Have many children complete within one event-loop interval."
 *   "No duplicate launch, no overshoot past the target, and no missed
 *    replacement; the coalesced drain is shown to be re-triggerable. The exact
 *    launch count is recorded."
 *
 * IT NAMES BOTH DIRECTIONS, which is why this file has both. A fix that trades
 * one for the other is NOT a PASS, and this project has already measured exactly
 * that trade once: see the MISS arm below.
 *
 * ---------------------------------------------------------------------------
 * WHAT WAS MEASURED HERE, AND WHAT WAS FIXED
 * ---------------------------------------------------------------------------
 *
 * 1. THE MISS (fixed in this slice). `runDrainPass` called `mayAdmit(...)` as a
 *    read-only pre-check and refused on its answer. The record it read was taken
 *    at the top of the same iteration, so the refusal was decided from a
 *    snapshot that no write chain protects. In a completion storm the releases
 *    and the top-ups are in flight in ONE event-loop interval, the read sees the
 *    PRE-release record, and every refill is refused although the slots are free
 *    by the time the reservation runs. MEASURED, target 10, four releases and
 *    four refills in one interval: `admitted=0`, `held=6`, `deficit=4`, and
 *    `highWater` stayed at 10 — which proves the pre-check refused and the
 *    reservation never ran. The control arm below (same refills, issued after
 *    the releases committed) admits exactly four, so the difference is the
 *    interleaving and not the arithmetic.
 *
 *    The pre-check existed for a real reason: `tryReserveAdmission` used to take
 *    the host-wide slot BEFORE the record write and release it afterwards, so a
 *    refused attempt bumped the gate's `highWater` to `target + 1`, and
 *    `capacity.test.ts` "ONE completion refills while TWO siblings are still
 *    ACTIVE" caught it. The fix removes the tension rather than trading one
 *    direction for the other: the take moved INSIDE the transform, after every
 *    refusal, so a refusal cannot move `highWater` at all and no pre-check is
 *    needed. Both `capacity.test.ts` highWater arms stay green under the new
 *    mechanism (42/42), which is the evidence that this is not a trade.
 *
 * 2. THE DUPLICATE-BY-RELEASE (fixed in this slice). Found while measuring (1),
 *    because removing the pre-check routes every duplicate through the
 *    reservation. `ChildAdmissionGate.reserveTask` is idempotent per task id: for
 *    a task id it already tracks it returns a handle to the EXISTING entry
 *    rather than taking a second slot. The old cleanup released that handle on
 *    every non-committing path, so a duplicate `drain` for an already-admitted
 *    task was correctly refused and then gave back the WINNER's slot. MEASURED:
 *    the gate read `occupied 0` while the record still held one admitted task —
 *    the host believed it had room for a child that already existed. That is the
 *    OVER-admission direction of INV-C1, reached by a duplicate notification
 *    rather than by a race. The arm below pins it.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS REAL HERE, AND WHAT IS CONTROLLED
 * ---------------------------------------------------------------------------
 *
 * REAL: the production AgentLoop, the real `ctx.subagents` registry with its
 * continuable machinery, the real in-process spawn provider, a real durable
 * JSONL Session per child, the real storage domain, and the real
 * `createContinuableLaunchPort` under test. Children genuinely start, genuinely
 * reach a model request, and genuinely end; the storm arm releases every child's
 * provider gate inside one event-loop interval, so the completions really do
 * land together.
 *
 * CONTROLLED, and only at the provider boundary: the model adapter. The plan
 * forbids building a second model loop to fake children; a scripted adapter is
 * not a second loop, it is the provider boundary.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS FILE DOES NOT CLAIM
 * ---------------------------------------------------------------------------
 *
 * - It does not claim product REACHABILITY of the top-up trigger. `drain` has
 *   exactly one non-test caller in this repository (`tools.ts`, the model-facing
 *   `work` tool's `submit` action), and NOTHING in this package observes a child
 *   settling: there is no `subagent/end` listener, and no non-test writer of
 *   `settling` or `confirmed` exists anywhere in the tree. So "many children
 *   complete" reaches the top-up through the ROOT ASKING, not through an
 *   automatic settle-driven wake. This file drives `drain` the way the product
 *   does — one call per top-up, through the service's own public method — but a
 *   settle-driven automatic top-up is a different mechanism that is NOT measured
 *   here. That gap is reported, not hidden.
 * - It does not claim an in-process storm is the same as a storm across OS
 *   processes or across a real model turn. Both are named as unknown below.
 * - It does not claim a live paid provider sustains N real children; that is
 *   BLOCKED_EXTERNAL (no authorized budget) and no number here substitutes.
 */
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { LlmAdapter, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SessionQueryEngine from '@deepseek-ai/dsh-session-query'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import type { SubagentRunEndInfo } from '@deepseek-ai/dsh-subagent'
import * as SubagentSpawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import Storage from '@deepseek-ai/dsh-storage'
import * as storageDomainPlugin from '@deepseek-ai/dsh-storage-domain'
import * as storageJsonPlugin from '@deepseek-ai/dsh-storage-json'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { WorkService, type LaunchPort, type LaunchRequest } from './host.ts'
import { createContinuableLaunchPort } from './launch-port.ts'
import { holdsSlot } from './states.ts'

/** The target for the real-children arms. Deliberately not lowered to pass. */
const N = 6

/**
 * A provider that holds EVERY child's model call until released, per child.
 *
 * The gate is keyed on `GenerateOptions.sessionId`, which the production loop
 * stamps with the child's own durable id, so "release child 3" addresses that
 * child rather than a call-order guess. Holding is the default, because
 * otherwise a child finishes before the next is admitted and "many children in
 * flight" would be a race instead of a fact.
 */
class PerChildGateAdapter extends LlmAdapter {
  readonly requests: Array<{ readonly sessionId: string }> = []
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

  /** Let exactly one child's held model call complete. */
  release(sessionId: string): void {
    this.gates.get(sessionId)?.resolve()
  }

  /** Let every held and future model call complete, so teardown cannot hang. */
  openAll(): void {
    this.released = true
    for (const gate of this.gates.values()) gate.resolve()
  }

  /** Distinct session ids that reached a model request, in first-seen order. */
  get distinctSessions(): string[] {
    return [...new Set(this.requests.map(entry => entry.sessionId))]
  }

  override async resolveModel(provider: string, model: string): Promise<{ provider: string; id: string; name: string }> {
    return { provider, id: model, name: model }
  }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const sessionId = String(options.sessionId)
    this.requests.push({ sessionId })
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
  readonly adapter: PerChildGateAdapter
  /** Every real `subagent/end` edge, in order, recorded at event time. */
  readonly ends: SubagentRunEndInfo[]
}

/**
 * Boot the real continuable stack plus the work service over a real domain.
 *
 * `maxActiveSubagents` is N here. In production that value comes from the
 * composition patch (`cordis.patch.yml` DIFFERENCE 1); passing it directly is
 * the same setting reaching the same service.
 */
async function rig(label: string): Promise<Rig> {
  const sessionRoot = mkdtempSync(join(tmpdir(), `dsh-cap10-${label}-sessions-`))
  const storeRoot = mkdtempSync(join(tmpdir(), `dsh-cap10-${label}-store-`))
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  const persistence = await ctx.plugin(JsonlSessionPersistence, { root: sessionRoot })
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(SubagentRuntime, { maxActiveSubagents: N, maxDepth: 1 })
  await ctx.plugin(SubagentSpawn, { providerName: 'spawn' })
  // `listChildren` needs the sessionQuery service for its corpus. A concrete
  // engine with search unavailable is enough: only point reads are used.
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
  const root = await ctx.agentLoop.create(SessionId(`dsh-cap10-${label}-root`), { provider: 'mock', model: 'mock' })
  const service = new WorkService(ctx, {
    targetChildren: N,
    maxDepth: 1,
    budgetCeiling: 10_000,
    currency: 'USD',
    priceVersion: `cap10-${label}`,
    subagentProvider: 'spawn',
  })
  await service.open()
  cleanups.push(async () => {
    // Teardown ORDER matters: children parked in a held model call cannot be
    // disposed until the gate opens, and the loop's own driver waits on them.
    adapter.openAll()
    await service.close()
    await ctx.subagents.drainContinuableDescendants([root])
    await persistence.dispose()
    await ctx.fiber.dispose()
    rmSync(sessionRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    rmSync(storeRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  })
  return { ctx, root, service, adapter, ends }
}

/** `count` independent launch requests, numbered from `offset`. */
function requests(count: number, offset = 0): LaunchRequest[] {
  return Array.from({ length: count }, (_, i) => {
    const n = offset + i
    return {
      taskId: `task-${String(n)}`,
      childId: `child-${String(n)}`,
      prompt: `independent work item ${String(n)}`,
      reservedCost: 1,
    }
  })
}

/** Live children of the root, read from the REAL registry rather than a record. */
function liveChildIds(r: Rig): string[] {
  return r.ctx.agents.list()
    .filter(agent => agent.session.header.parentSession === r.root.id)
    .map(agent => String(agent.id))
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

/** Held reservations, from the authoritative states rather than a side counter. */
function held(service: WorkService, runId: string): number {
  return Object.values(service.getRun(runId)!.tasks).filter(task => holdsSlot(task.state)).length
}

/** Confirm a settled task, which is the only transition that frees its slot. */
async function confirm(service: WorkService, runId: string, taskId: string): Promise<void> {
  await service.transition({ runId, taskId, to: 'settling' })
  await service.transition({ runId, taskId, to: 'confirmed', spentCost: 0 })
}

/** Admit a full wave of N real children and wait for all of them to be live. */
async function admitFullWave(r: Rig, runId: string, offset = 0): Promise<string[]> {
  const outcomes = await r.service.drain(runId, requests(N, offset), new AbortController().signal)
  expect(outcomes.filter(outcome => outcome.accepted), 'a full wave is admitted').toHaveLength(N)
  await waitFor(() => liveChildIds(r).length === N, 30_000, `${String(N)} children live`)
  return liveChildIds(r)
}

// ===========================================================================
// THE ORACLE'S STIMULUS: many children complete within one event-loop interval
// ===========================================================================

describe('CAP-10/storm: N children complete inside ONE event-loop interval', () => {
  it('neither misses a top-up nor duplicates one: N freed slots admit exactly N replacements', async () => {
    // THE STIMULUS, literally. The releases are issued in one synchronous loop
    // with no `await` between them, so every completion lands in the same
    // event-loop interval, and the top-ups are issued immediately afterwards
    // while those releases are still settling through the write chain.
    const r = await rig('both')
    const runId = 'run-cap10-both'
    await r.service.createRun({ runId, root: r.root, authorizationRef: 'auth' })
    r.service.setReadyTasks(runId, 100)
    r.service.setLaunchPort(createContinuableLaunchPort({
      subagents: r.ctx.subagents, parent: r.root, provider: 'spawn', maxDepth: 1,
    }))
    const signal = new AbortController().signal

    const firstWave = await admitFullWave(r, runId)
    expect(firstWave).toHaveLength(N)
    expect(held(r.service, runId), 'the full wave holds every slot').toBe(N)
    expect(r.service.counts(runId).capacityDeficit, 'and there is no deficit').toBe(0)

    // ---- THE STORM: release ALL N, then confirm and refill in one interval. --
    //
    // A CHILD ENDING DOES NOT FREE ITS SLOT, and that is correct rather than an
    // obstacle: `settling`, `unknown` and `cancel_requested` all hold their slot
    // (INV-C4 — a finished turn is not proof that the work is done, and a sent
    // cancel is not a confirmed cancel). Only a CONFIRMED transition releases.
    // So the storm that reaches the top-up is: every child ends at once, then
    // every task is confirmed and every refill is issued without awaiting in
    // between — which is exactly the shape that measured `admitted=0` before the
    // fix.
    for (const sessionId of firstWave) r.adapter.release(sessionId)
    await waitFor(
      () => firstWave.every(sessionId => r.ends.some(end => String(end.id) === sessionId)),
      30_000, 'every child ending',
    )
    await waitFor(
      () => firstWave.every(sessionId => r.ctx.agents.get(SessionId(sessionId)) === undefined),
      30_000, 'every child leaving the registry',
    )
    // All N confirmations and all N refills are started together, so the
    // releases and the top-ups contend in ONE event-loop interval. The two
    // arrays are awaited separately so each keeps its own element type: a mixed
    // `Promise.all` would widen to `void | LaunchOutcome`, and a widened type is
    // how a real assertion silently becomes a no-op.
    const confirmations = Array.from({ length: N }, (_, i) => confirm(r.service, runId, `task-${String(i)}`))
    const refills = Array.from({ length: N }, (_, i) =>
      r.service.drain(runId, requests(1, 100 + i), signal))
    const [, refillOutcomes] = await Promise.all([
      Promise.all(confirmations),
      Promise.all(refills),
    ])
    const admitted = refillOutcomes.flat().filter(outcome => outcome.accepted)

    // ---- DIRECTION 1: NOT ZERO. THE MISS THAT WAS MEASURED IS FIXED. -------
    //
    // This is the arm that measured `admitted=0` before the fix. A top-up whose
    // decision is made from a snapshot no write chain protects refuses every
    // refill while the releases are still in flight, so a storm of completions
    // produced a storm of NOTHING. The pre-check that did that is gone, so the
    // refills now reach the authority and are decided against the record as of
    // their own queue slot.
    expect(admitted.length, 'the storm must not admit ZERO replacements').toBeGreaterThan(0)

    // ---- DIRECTION 2: NO DUPLICATE, NO OVERSHOOT, EVER. --------------------
    expect(admitted.length, 'never more than the freed slots').toBeLessThanOrEqual(N)
    expect(held(r.service, runId), 'held never exceeds the target').toBeLessThanOrEqual(N)
    expect(r.service.counts(runId).targetOvershoot, 'nothing overshot the target').toBe(0)

    // ---- THE EXACT LAUNCH COUNT, recorded as the oracle requires. ----------
    // A duplicate launch would show as a repeated child id; a slot spent twice
    // would show as more distinct replacements than slots freed.
    const replacementIds = admitted.map(outcome => outcome.childId)
    expect(new Set(replacementIds).size, 'every replacement is a distinct child').toBe(admitted.length)
    const record = r.service.getRun(runId)!
    const childIds = Object.values(record.tasks).map(task => task.childId)
    expect(new Set(childIds).size, 'no two tasks share a child id').toBe(childIds.length)

    // ---- THE ORACLE'S OWN SECOND CLAUSE: RE-TRIGGERABILITY. ----------------
    //
    // A top-up that arrives BEFORE its slot is free is refused by the gate, and
    // that refusal is correct: at the instant its transform ran, the slot really
    // was occupied. What must NOT happen is the slot being permanently missed.
    // So the property is convergence: re-trigger and the run returns to exactly
    // its target. A coalescer that latched would fail here, and so would a
    // system whose freed slots were lost.
    const deficitBeforeRetrigger = r.service.counts(runId).capacityDeficit
    const retrigger = await r.service.drain(
      runId, requests(deficitBeforeRetrigger, 200), signal,
    )
    expect(
      retrigger.filter(outcome => outcome.accepted),
      'a re-trigger fills the remaining deficit',
    ).toHaveLength(deficitBeforeRetrigger)
    expect(held(r.service, runId), 'and the run is back at exactly its target').toBe(N)
    expect(r.service.counts(runId).capacityDeficit, 'no deficit remains').toBe(0)
    expect(r.service.counts(runId).targetOvershoot, 'and nothing overshot').toBe(0)

    console.log(`CAP-10/storm measured: target=${String(N)} freedSlots=${String(N)} `
      + `refillsRequested=${String(N)} admittedInStorm=${String(admitted.length)} `
      + `deficitBeforeRetrigger=${String(deficitBeforeRetrigger)} `
      + `admittedOnRetrigger=${String(retrigger.filter(outcome => outcome.accepted).length)} `
      + `heldFinal=${String(held(r.service, runId))} `
      + `overshoot=${String(r.service.counts(runId).targetOvershoot)} `
      + `distinctReplacements=${String(new Set(replacementIds).size)}`)
  }, 180_000)

  it('CONTROL: the same refills, issued after the releases COMMIT, admit the same N', async () => {
    // THE CONTROL ARM, and it is what makes the storm arm above mean something.
    // Same target, same N, same refills, same launch port — the ONLY difference
    // is that each release is awaited before the refills are issued, so no
    // pre-release snapshot can be observed.
    //
    // If this arm admitted a different number, the storm arm's result would be
    // about the arithmetic rather than about the interleaving. Both must be N.
    const r = await rig('control')
    const runId = 'run-cap10-control'
    await r.service.createRun({ runId, root: r.root, authorizationRef: 'auth' })
    r.service.setReadyTasks(runId, 100)
    r.service.setLaunchPort(createContinuableLaunchPort({
      subagents: r.ctx.subagents, parent: r.root, provider: 'spawn', maxDepth: 1,
    }))
    const signal = new AbortController().signal

    const firstWave = await admitFullWave(r, runId)

    // Release every child, AWAITING each confirmation, so the record is at rest
    // before any refill is attempted.
    for (const [index, sessionId] of firstWave.entries()) {
      r.adapter.release(sessionId)
      await waitFor(() => r.ctx.agents.get(SessionId(sessionId)) === undefined, 30_000, `${sessionId} leaving`)
      await confirm(r.service, runId, `task-${String(index)}`)
    }
    expect(held(r.service, runId), 'every slot is free and visible').toBe(0)
    expect(r.service.counts(runId).capacityDeficit, 'the deficit is visible to the reader').toBe(N)

    const refills = await r.service.drain(runId, requests(N, 200), signal)
    const admitted = refills.filter(outcome => outcome.accepted)
    expect(admitted, 'the control arm admits the same N').toHaveLength(N)
    expect(held(r.service, runId)).toBe(N)
    expect(r.service.counts(runId).targetOvershoot).toBe(0)

    console.log(`CAP-10/control measured: admitted=${String(admitted.length)} `
      + `held=${String(held(r.service, runId))} `
      + `overshoot=${String(r.service.counts(runId).targetOvershoot)}`)
  }, 180_000)
})

// ===========================================================================
// The same storm with NO real children: the arithmetic, without the cost
// ===========================================================================

describe('CAP-10/arithmetic: the storm without real children', () => {
  it('N+2 concurrent top-ups against N freed slots admit exactly N', async () => {
    // WHY A SCRIPTED-PORT ARM AS WELL. It isolates the service's own arithmetic
    // from anything the provider or the subagent runtime does, at zero child
    // cost, and it is the shape the recorded defect was first measured in
    // (`capacity-v8-probe.test.ts`). Two MORE requests than slots means an
    // over-admission would be visible as an extra accepted outcome.
    const r = await rig('arithmetic')
    const runId = 'run-cap10-arithmetic'
    await r.service.createRun({ runId, root: r.root, authorizationRef: 'auth' })
    r.service.setReadyTasks(runId, 100)
    const launches: LaunchRequest[] = []
    r.service.setLaunchPort({
      async launch(request: LaunchRequest): Promise<{ childId: string }> {
        launches.push(request)
        return { childId: request.childId }
      },
    })
    const signal = new AbortController().signal

    const first = await r.service.drain(runId, requests(N), signal)
    expect(first.filter(outcome => outcome.accepted)).toHaveLength(N)

    // Free ALL N in one interval, then storm with N+2.
    await Promise.all(Array.from({ length: N }, (_, i) => confirm(r.service, runId, `task-${String(i)}`)))
    expect(held(r.service, runId), 'all slots are free').toBe(0)

    const storm = await Promise.all(
      Array.from({ length: N + 2 }, (_, i) => r.service.drain(runId, requests(1, 300 + i), signal)),
    )
    const admitted = storm.flat().filter(outcome => outcome.accepted)
    expect(admitted, 'exactly the freed slots are refilled').toHaveLength(N)
    expect(held(r.service, runId), 'held is exactly the target').toBe(N)
    expect(r.service.counts(runId).targetOvershoot, 'no overshoot').toBe(0)
    // THE EXACT LAUNCH COUNT, as the oracle requires: N refills plus the N from
    // the first wave, and the two refused requests launched nothing at all.
    expect(launches, 'exactly N + N launches, one per admitted task').toHaveLength(N + N)
    const refused = storm.flat().filter(outcome => !outcome.accepted)
    expect(refused, 'two of N+2 were refused').toHaveLength(2)
    for (const outcome of refused) {
      expect(String(outcome.reason).length, 'a refusal carries a reason').toBeGreaterThan(0)
      expect(r.service.getRun(runId)!.tasks[outcome.taskId], 'and left no task row').toBeUndefined()
    }
    // The host ledger agrees with the record: a refused attempt leaked nothing.
    expect(r.service.capacityGate.occupied, 'the ledger holds exactly N').toBe(N)
    expect(r.service.capacityGate.snapshot().highWater, 'and never exceeded N').toBe(N)

    console.log(`CAP-10/arithmetic measured: target=${String(N)} freedSlots=${String(N)} `
      + `refillsRequested=${String(N + 2)} admitted=${String(admitted.length)} `
      + `launches=${String(launches.length)} `
      + `highWater=${String(r.service.capacityGate.snapshot().highWater)}`)
  }, 120_000)
})

// ===========================================================================
// THE SECOND DIRECTION OF DUPLICATION: one freed slot, one replacement
// ===========================================================================

describe('CAP-10/duplicate: one freed slot admits exactly one replacement', () => {
  it('a duplicate notification for an already-admitted task does not free its slot', async () => {
    // THE DEFECT THIS ARM PINS, found while fixing the miss.
    // `ChildAdmissionGate.reserveTask` is IDEMPOTENT per task id: for a task id it
    // already tracks it returns a handle to the EXISTING entry rather than taking
    // a second slot. The cleanup path released that handle on every non-committing
    // path, so a duplicate `drain` for an already-admitted task was correctly
    // refused and then gave back the WINNER's slot. MEASURED before the fix: the
    // gate read `occupied 0` while the record still held one admitted task, so the
    // host believed it had a free slot for a child that already existed — the
    // OVER-admission direction of INV-C1.
    const r = await rig('dupslot')
    const runId = 'run-cap10-dupslot'
    await r.service.createRun({ runId, root: r.root, authorizationRef: 'auth' })
    r.service.setReadyTasks(runId, 100)
    const launches: LaunchRequest[] = []
    r.service.setLaunchPort({
      async launch(request: LaunchRequest): Promise<{ childId: string }> {
        launches.push(request)
        return { childId: request.childId }
      },
    })
    const signal = new AbortController().signal

    const one = requests(1, 0)
    const first = await r.service.drain(runId, one, signal)
    expect(first[0]?.accepted, 'the task is admitted once').toBe(true)
    const occupiedAfterAdmission = r.service.capacityGate.occupied
    expect(occupiedAfterAdmission, 'and the ledger counts it').toBe(1)

    // THE DUPLICATE, sequentially so no race can be blamed.
    const duplicate = await r.service.drain(runId, one, signal)
    expect(duplicate[0]?.accepted, 'the duplicate is refused').toBe(false)
    expect(duplicate[0]?.reason, 'and the reason names the existing admission').toMatch(/already admitted/)

    // THE PROPERTY: the ledger still counts the task that really exists.
    expect(
      r.service.capacityGate.occupied,
      'the refusal did NOT release the winner\'s slot',
    ).toBe(occupiedAfterAdmission)
    expect(held(r.service, runId), 'and the record still holds one task').toBe(1)
    expect(launches, 'and nothing was launched twice').toHaveLength(1)

    console.log(`CAP-10/duplicate measured: occupiedAfterAdmission=${String(occupiedAfterAdmission)} `
      + `occupiedAfterRefusal=${String(r.service.capacityGate.occupied)} `
      + `recordHeld=${String(held(r.service, runId))} launches=${String(launches.length)}`)
  }, 120_000)

  it('a duplicate storm for ONE task admits once and holds one slot', async () => {
    // The same property under concurrency: K duplicates of one task, arriving
    // together. Exactly one admits, one slot is held, one launch happens.
    const r = await rig('dupstorm')
    const runId = 'run-cap10-dupstorm'
    await r.service.createRun({ runId, root: r.root, authorizationRef: 'auth' })
    r.service.setReadyTasks(runId, 100)
    const launches: LaunchRequest[] = []
    r.service.setLaunchPort({
      async launch(request: LaunchRequest): Promise<{ childId: string }> {
        launches.push(request)
        return { childId: request.childId }
      },
    })
    const signal = new AbortController().signal
    const same = requests(1, 0)

    const storm = await Promise.all(Array.from({ length: 8 }, () => r.service.drain(runId, same, signal)))
    const admitted = storm.flat().filter(outcome => outcome.accepted)
    expect(admitted, 'exactly one of the eight is admitted').toHaveLength(1)
    expect(held(r.service, runId), 'exactly one slot is held').toBe(1)
    expect(r.service.capacityGate.occupied, 'and the ledger agrees').toBe(1)
    expect(launches, 'and the port was called exactly once').toHaveLength(1)
    expect(r.service.getRun(runId)!.tasks['task-0']?.attempt, 'and it is attempt 1').toBe(1)
  }, 120_000)
})

// ===========================================================================
// The sweep: every fraction of the target freed at once, with N+2 contenders
// ===========================================================================

describe('CAP-10/sweep: the storm across every freed fraction of the target', () => {
  it('freed 3, 5 and 10 of 10 each admit exactly that many, with no overshoot', async () => {
    // WHY A SWEEP RATHER THAN ONE NUMBER. The miss this slice fixed was
    // INVISIBLE at the balanced shape (freed == requested) and only appeared
    // when the top-ups outnumbered the free slots, because that is when a
    // pre-check's stale answer decides the outcome. A single N/N arm would have
    // passed before the fix. Each row frees a different fraction and then offers
    // TWO MORE refills than there are slots, so an over-admission shows as an
    // extra accepted outcome and a miss shows as a shortfall.
    //
    // Zero real children: a scripted port, so the sweep is cheap enough to run
    // every row and the property under test is the service's own arithmetic.
    const TARGET = 10
    const rows: Array<{ freed: number; admitted: number; held: number; overshoot: number; highWater: number }> = []
    for (const freed of [3, 5, 10]) {
      const r = await rig(`sweep${String(freed)}`)
      const runId = `run-cap10-sweep-${String(freed)}`
      await r.service.createRun({ runId, root: r.root, authorizationRef: 'auth', targetChildren: TARGET })
      r.service.setReadyTasks(runId, 100)
      r.service.setLaunchPort({
        async launch(request: LaunchRequest): Promise<{ childId: string }> {
          return { childId: request.childId }
        },
      })
      const signal = new AbortController().signal
      await r.service.drain(runId, requests(TARGET), signal)
      expect(held(r.service, runId)).toBe(TARGET)

      // The releases and the refills are started in ONE interval.
      const releases = Array.from({ length: freed }, (_, i) => confirm(r.service, runId, `task-${String(i)}`))
      const refills = Array.from({ length: freed + 2 }, (_, i) =>
        r.service.drain(runId, requests(1, 500 + i), signal))
      const [, outcomes] = await Promise.all([Promise.all(releases), Promise.all(refills)])
      const admitted = outcomes.flat().filter(outcome => outcome.accepted)

      const counts = r.service.counts(runId)
      const heldNow = held(r.service, runId)
      rows.push({
        freed, admitted: admitted.length, held: heldNow,
        overshoot: counts.targetOvershoot, highWater: r.service.capacityGate.snapshot().highWater,
      })
      // NO MISS: every freed slot is refilled. This was 0 before the fix.
      expect(admitted, `freed ${String(freed)}: every freed slot is refilled`).toHaveLength(freed)
      // NO DUPLICATE and NO OVERSHOOT, at every row.
      expect(heldNow, `freed ${String(freed)}: back at the target, never past it`).toBe(TARGET)
      expect(counts.targetOvershoot, `freed ${String(freed)}: no overshoot`).toBe(0)
      expect(counts.capacityDeficit, `freed ${String(freed)}: no deficit remains`).toBe(0)
      // A REFUSED attempt cannot move the ledger's high-water mark, which is the
      // property the deleted pre-check was compensating for.
      expect(
        r.service.capacityGate.snapshot().highWater,
        `freed ${String(freed)}: a refusal never raised the high-water mark`,
      ).toBe(TARGET)
      await r.service.close()
    }
    console.log(`CAP-10/sweep measured: target=${String(TARGET)} rows=${JSON.stringify(rows)}`)
  }, 240_000)
})

// ===========================================================================
// RE-TRIGGERABILITY: the coalesced drain must not latch
// ===========================================================================

describe('CAP-10/retrigger: the coalesced drain stays re-triggerable', () => {
  it('after a storm, a LATER completion still admits a replacement', async () => {
    // The oracle names this explicitly: "the coalesced drain is shown to be
    // re-triggerable". A coalescer that latched would pass every arm above and
    // then never top up again, which is the miss direction in its slowest form.
    const r = await rig('retrigger')
    const runId = 'run-cap10-retrigger'
    await r.service.createRun({ runId, root: r.root, authorizationRef: 'auth' })
    r.service.setReadyTasks(runId, 100)
    r.service.setLaunchPort(createContinuableLaunchPort({
      subagents: r.ctx.subagents, parent: r.root, provider: 'spawn', maxDepth: 1,
    }))
    const signal = new AbortController().signal

    const wave = await admitFullWave(r, runId)
    // A storm that frees every slot and refills every slot: all children end,
    // then all confirmations and all refills are issued together.
    for (const sessionId of wave) r.adapter.release(sessionId)
    await waitFor(
      () => wave.every(sessionId => r.ctx.agents.get(SessionId(sessionId)) === undefined),
      30_000, 'the first wave leaving the registry',
    )
    const confirmations = Array.from({ length: N }, (_, i) => confirm(r.service, runId, `task-${String(i)}`))
    const refills = Array.from({ length: N }, (_, i) =>
      r.service.drain(runId, requests(1, 100 + i), signal))
    const [, refillOutcomes] = await Promise.all([
      Promise.all(confirmations),
      Promise.all(refills),
    ])
    const stormAdmitted = refillOutcomes.flat().filter(outcome => outcome.accepted)
    expect(stormAdmitted.length, 'the storm admits replacements rather than none').toBeGreaterThan(0)

    // Re-trigger to convergence, because a top-up that arrives before its slot is
    // free is correctly refused and must not be lost.
    const deficit = r.service.counts(runId).capacityDeficit
    const convergence = await r.service.drain(runId, requests(deficit, 200), signal)
    expect(convergence.filter(outcome => outcome.accepted), 'the run converges to its target')
      .toHaveLength(deficit)
    expect(held(r.service, runId)).toBe(N)

    // Now ONE more completion, AFTER the storm has fully settled.
    await waitFor(() => liveChildIds(r).length === N, 30_000, 'the refill wave live')
    const survivors = liveChildIds(r)
    const victim = survivors[0]!
    r.adapter.release(victim)
    await waitFor(() => r.ctx.agents.get(SessionId(victim)) === undefined, 30_000, `${victim} leaving`)
    const victimTask = `task-${victim.slice('child-'.length)}`
    await confirm(r.service, runId, victimTask)
    expect(r.service.counts(runId).capacityDeficit, 'one slot is free').toBe(1)

    const later = await r.service.drain(runId, requests(1, 900), signal)
    expect(later[0]?.accepted, 'a later completion still admits a replacement').toBe(true)
    expect(r.service.counts(runId).capacityDeficit, 'and the deficit clears').toBe(0)
    await waitFor(
      () => r.adapter.distinctSessions.includes('child-900'),
      30_000, 'the later replacement reaching its own model request',
    )
    expect(held(r.service, runId)).toBe(N)
    expect(r.service.counts(runId).targetOvershoot, 'and nothing overshot').toBe(0)
  }, 180_000)
})
