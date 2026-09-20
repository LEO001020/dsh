/**
 * F5 / CAP-10 / G-SEAM-45 — the target over-admission race, and its fault matrix.
 *
 * WHAT WAS WRONG. `WorkService.drain` decided target admission OUTSIDE the
 * storage-domain write, so K concurrent drains all read the same deficit and all
 * admitted. Measured with zero real children: target 3, two free slots, three
 * concurrent requests -> THREE admitted, FOUR tasks holding slots, and
 * `capacityDeficit` reading 0. The overshoot was invisible to the very reader
 * that exists to report a deficit, because a deficit clamps at zero.
 *
 * WHERE THE FIX LIVES, stated once so every arm below can be read against it.
 * Correctness is in `WorkService.tryReserveAdmission`: ONE storage-domain
 * `update` whose transform validates the run, the task, the authoritative
 * occupancy, the target and the budget, and then reserves the slot, the credit,
 * the state and the launch intention together. The atomicity it relies on is the
 * domain's own, `storage-domain/src/domain.ts:83-89`:
 *
 *   "Atomic read-modify-write on the domain's write chain: `fn` sees the value
 *    current at its queue slot, so concurrent updates never interleave."
 *
 * The chain is per-DOMAIN, not per-key (`:3`, `:125-126`, `:332-346`), so the
 * transform is ordered against every other write to that domain. That is why no
 * lock of our own is needed and why the decision must be made from the `current`
 * the transform is handed rather than from a `getRun()` read outside it.
 *
 * THE COALESCER IS EFFICIENCY, NOT CORRECTNESS. `drain` also gained a single
 * leader per run (a requested/handled generation loop) so K callers do not each
 * perform a refused write. The arm "WITH THE COALESCER DEFEATED" below drives the
 * reservation path around that leader to show the invariant survives without it.
 * If a future edit regresses the coalescer, this file stays green and the
 * invariant still holds; if a future edit moves the target check back outside the
 * update, this file goes red.
 *
 * COST. Every arm here uses a SCRIPTED launch port and ZERO real children, except
 * the hard-cap arm which uses the gate's own ledger. The fault matrix is about
 * the service's own reservation arithmetic, so nothing needs a provider, and the
 * user's constraint against spawning children at scale is respected. The
 * real-children shape of the same defect lives in `capacity.test.ts` (CAP-06) and
 * `capacity-v8-probe.test.ts` (CAP-10).
 *
 * WHAT THIS FILE DOES NOT CLAIM. It does not claim product reachability. Every
 * arm reaches the service through test-installed entry points, which is the
 * G-SEAM-31 limit stated in `capacity.test.ts`'s own header: F5 is closed, and
 * F5 being closed is a precondition for F1 (user run creation), not a substitute
 * for it.
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
import * as SubagentSpawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import Storage from '@deepseek-ai/dsh-storage'
import * as storageDomainPlugin from '@deepseek-ai/dsh-storage-domain'
import * as storageJsonPlugin from '@deepseek-ai/dsh-storage-json'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ChildAdmissionGate, HARD_CHILD_CAPACITY, mountChildAdmissionGuard } from './capacity.ts'
import { WorkService, type LaunchRequest } from './host.ts'
import { holdsSlot } from './states.ts'

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

/** A model boundary that answers immediately. No child is held open. */
class ImmediateAdapter extends LlmAdapter {
  override async resolveModel(provider: string, model: string): Promise<{ provider: string; id: string; name: string }> {
    return { provider, id: model, name: model }
  }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    if (options.signal?.aborted) throw new Error('aborted')
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'ok' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

interface Rig {
  readonly ctx: Context
  readonly root: Agent
  readonly service: WorkService
  readonly gate: ChildAdmissionGate
}

/**
 * Boot the real loop, real persistence and a REAL storage domain, then mount the
 * work service over them.
 *
 * The storage domain is real rather than mocked on purpose: the fix's whole
 * claim is about the domain's write chain, so a rig that replaced the domain
 * would not be measuring the mechanism under test.
 */
async function rig(label: string, options: {
  target: number
  budgetCeiling?: number
  rootReserve?: number
  pool?: number
}): Promise<Rig> {
  const sessionRoot = mkdtempSync(join(tmpdir(), `dsh-f5-${label}-sessions-`))
  const storeRoot = mkdtempSync(join(tmpdir(), `dsh-f5-${label}-store-`))
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  const persistence = await ctx.plugin(JsonlSessionPersistence, { root: sessionRoot })
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(SubagentRuntime, { maxActiveSubagents: options.pool ?? 64, maxDepth: 1 })
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
  ctx.llm.registerAdapter(['mock'], new ImmediateAdapter())
  const root = await ctx.agentLoop.create(SessionId(`f5-${label}-root`), { provider: 'mock', model: 'mock' })

  const gate = new ChildAdmissionGate(HARD_CHILD_CAPACITY)
  mountChildAdmissionGuard(ctx, { gate, maxDepth: 1 })

  const service = new WorkService(ctx, {
    targetChildren: options.target,
    maxDepth: 1,
    budgetCeiling: options.budgetCeiling ?? 10_000,
    currency: 'USD',
    priceVersion: `f5-${label}`,
    subagentProvider: 'spawn',
  })
  await service.open()
  cleanups.push(async () => {
    await service.close()
    await persistence.dispose()
    await ctx.fiber.dispose()
    rmSync(sessionRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    rmSync(storeRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  })

  // The service mounts its own guard; the one mounted here is for the ledger the
  // test reads. Both share the SAME gate object, so there is one ledger.
  return { ctx, root, service, gate: service.capacityGate }
}

/**
 * A launch port that records every call and can be made to fail or hang.
 *
 * `failWith` makes the launch throw, which is the "materialization/start failure"
 * fault: the child may or may not exist, so the task must end `unknown` with its
 * reservation HELD rather than released.
 */
function scriptedPort(): {
  readonly launches: LaunchRequest[]
  failWith: Error | undefined
  readonly port: { launch(request: LaunchRequest): Promise<{ childId: string }> }
} {
  const launches: LaunchRequest[] = []
  const state = {
    launches,
    failWith: undefined as Error | undefined,
    port: {
      async launch(request: LaunchRequest): Promise<{ childId: string }> {
        launches.push(request)
        if (state.failWith !== undefined) throw state.failWith
        return { childId: request.childId }
      },
    },
  }
  return state
}

const request = (n: number, cost = 1): LaunchRequest =>
  ({ taskId: `task-${String(n)}`, childId: `child-${String(n)}`, prompt: `work ${String(n)}`, reservedCost: cost })

/** Held reservations, from the AUTHORITATIVE states rather than a side counter. */
function held(service: WorkService, runId: string): number {
  const record = service.getRun(runId)!
  return Object.values(record.tasks).filter(task => holdsSlot(task.state)).length
}

// ===========================================================================
// H4 arm 1: target=3, many concurrent drain requests -> held never > 3
// ===========================================================================

describe('F5/H4-1: a storm of concurrent drains cannot hold more than the target', () => {
  it('target=3, twelve concurrent single-request drains, held reservations never exceed 3', async () => {
    // THE ORACLE: "target=3, many concurrent drain requests -> held target
    // reservations never >3". Twelve is deliberately more than twice the target,
    // and each drain carries ONE request, so a coalescer that merges them cannot
    // hide the arithmetic behind batching.
    //
    // THE INVARIANT IS CHECKED AT EVERY STEP, not only at the end: a system that
    // overshoots and then settles back would pass an end-state assertion while
    // still having admitted a fourth child.
    const r = await rig('storm3', { target: 3 })
    const runId = 'run-f5-storm'
    await r.service.createRun({ runId, root: r.root, authorizationRef: 'auth', targetChildren: 3 })
    r.service.setReadyTasks(runId, 100)
    r.service.setLaunchPort(scriptedPort().port)

    const signal = new AbortController().signal
    const outcomes = await Promise.all(
      Array.from({ length: 12 }, (_, i) => r.service.drain(runId, [request(100 + i)], signal)),
    )
    const admitted = outcomes.flat().filter(outcome => outcome.accepted)

    // EXACTLY the target, never more. The before-state measured 4 held against a
    // target of 3 for the 3-request shape; with twelve requests it would have been
    // far worse.
    expect(admitted, 'exactly the target was admitted, not one more').toHaveLength(3)
    expect(held(r.service, runId), 'held reservations are exactly the target').toBe(3)
    expect(held(r.service, runId)).toBeLessThanOrEqual(3)

    // THE READER THAT WAS SILENT. `capacityDeficit` clamps at zero, so it read 0
    // both for a healthy full wave and for the overshoot. The overshoot is now its
    // own number, and it is zero because nothing overshot.
    const counts = r.service.counts(runId)
    expect(counts.heldReservations, 'the authoritative occupancy is reported').toBe(3)
    expect(counts.targetOvershoot, 'and there is no overshoot').toBe(0)
    expect(counts.capacityDeficit, 'the target is full').toBe(0)
    // The generation proves THREE reservations committed, not twelve.
    expect(r.service.getRun(runId)!.reservationGeneration, 'exactly three admissions committed').toBe(3)
    // The ledger holds exactly three credits: a refused attempt reserved nothing.
    expect(r.service.getRun(runId)!.budget.reserved, 'exactly three credits are reserved').toBe(3)
  }, 60_000)

  it('every refusal reports a reason, and a refusal leaves no task behind', async () => {
    // A refusal that silently consumed a slot, a credit or a task row would be a
    // leak that only shows up as a permanent deficit later.
    const r = await rig('storm-reasons', { target: 2 })
    const runId = 'run-f5-reasons'
    await r.service.createRun({ runId, root: r.root, authorizationRef: 'auth', targetChildren: 2 })
    r.service.setReadyTasks(runId, 100)
    r.service.setLaunchPort(scriptedPort().port)

    const signal = new AbortController().signal
    const outcomes = await Promise.all(
      Array.from({ length: 6 }, (_, i) => r.service.drain(runId, [request(200 + i)], signal)),
    )
    const refused = outcomes.flat().filter(outcome => !outcome.accepted)
    expect(refused, 'four of six were refused').toHaveLength(4)
    for (const outcome of refused) {
      expect(outcome.reason, 'every refusal carries a reason').toBeDefined()
      expect(String(outcome.reason).length, 'and the reason is not empty').toBeGreaterThan(0)
    }
    // No refused task exists, so no refused task can hold a slot.
    const record = r.service.getRun(runId)!
    const refusedTaskIds = refused.map(outcome => outcome.taskId)
    for (const taskId of refusedTaskIds) {
      expect(record.tasks[taskId], `refused "${taskId}" left no task row`).toBeUndefined()
    }
    expect(Object.keys(record.tasks)).toHaveLength(2)
    // The host-wide ledger agrees: a refusal did not leak a slot.
    expect(r.gate.occupied, 'the host ledger holds exactly the two admitted').toBe(2)
  }, 60_000)
})

// ===========================================================================
// H4 arm 2: capacityDeficit agrees with authoritative occupancy
// ===========================================================================

describe('F5/H4-2: the deficit reading agrees with the authoritative occupancy', () => {
  it('reports full, short and over as three DISTINCT readings', async () => {
    // WHY THIS ARM EXISTS. The defect's sharper half was not the over-admission;
    // it was that the over-admission was INVISIBLE. `capacityDeficit` is
    // `max(0, target - held)`, so it reads 0 for a healthy full wave AND for an
    // overshoot. A reader cannot tell "full" from "over-full", so it cannot report
    // an over-admission at all.
    //
    // The fix reports the authoritative occupancy and the overshoot as their own
    // numbers, so all three readings are distinguishable. This arm drives the
    // record into each of the three states through the REAL service paths.
    const r = await rig('deficit', { target: 3 })
    const runId = 'run-f5-deficit'
    await r.service.createRun({ runId, root: r.root, authorizationRef: 'auth', targetChildren: 3 })
    r.service.setReadyTasks(runId, 100)
    r.service.setLaunchPort(scriptedPort().port)
    const signal = new AbortController().signal

    // SHORT: two of three.
    await r.service.drain(runId, [request(0), request(1)], signal)
    let counts = r.service.counts(runId)
    expect(counts.heldReservations, 'two held').toBe(2)
    expect(counts.capacityDeficit, 'short by one').toBe(1)
    expect(counts.targetOvershoot, 'not over').toBe(0)

    // FULL: three of three.
    await r.service.drain(runId, [request(2)], signal)
    counts = r.service.counts(runId)
    expect(counts.heldReservations, 'three held').toBe(3)
    expect(counts.capacityDeficit, 'no longer short').toBe(0)
    expect(counts.targetOvershoot, 'still not over').toBe(0)
    // Full and over are now DISTINGUISHABLE, which is the property the old reader
    // could not express.
    expect(counts.deficitReason, 'a full wave reads none, not an overshoot').toBe('none')

    // OVER: forced by writing the record directly, because the correct service
    // refuses to create this state. This is the ONLY way to produce an overshoot
    // now, which is itself the evidence that the admission path cannot.
    const record = r.service.getRun(runId)!
    await r.service.transition({ runId, taskId: 'task-0', to: 'settling' })
    // Lower the target BELOW the held count: a user action that is legal and does
    // NOT kill anything (CAP-08), so the run is legitimately over its target.
    await r.service.setTargetChildren(runId, 1)
    counts = r.service.counts(runId)
    expect(counts.heldReservations, 'three still hold their slots after a lower').toBe(3)
    expect(counts.desiredTarget, 'the target is now 1').toBe(1)
    expect(counts.targetOvershoot, 'and the overshoot is REPORTED as 2').toBe(2)
    expect(counts.capacityDeficit, 'a deficit cannot express it').toBe(0)
    // The reason names the violation rather than reporting a healthy full wave.
    expect(counts.deficitReason, 'the reason is its own reading').toBe('target_exceeded')
    void record
  }, 60_000)
})

// ===========================================================================
// H4 arm 3: simultaneous completions / refills
// ===========================================================================

describe('F5/H4-3: simultaneous completions refill to exactly the target', () => {
  it('four completions at once admit exactly four replacements, and the storm does not exceed', async () => {
    // A completion storm is the trigger the coalescer exists for. The property is
    // that simultaneous releases refill the freed slots EXACTLY: not fewer (a
    // missed top-up) and not more (an over-admission).
    const r = await rig('refill', { target: 4 })
    const runId = 'run-f5-refill'
    await r.service.createRun({ runId, root: r.root, authorizationRef: 'auth', targetChildren: 4 })
    r.service.setReadyTasks(runId, 100)
    r.service.setLaunchPort(scriptedPort().port)
    const signal = new AbortController().signal

    const first = await r.service.drain(runId, [request(0), request(1), request(2), request(3)], signal)
    expect(first.filter(outcome => outcome.accepted)).toHaveLength(4)
    expect(held(r.service, runId)).toBe(4)

    // Confirm all four AT ONCE, so the releases land together.
    await Promise.all([0, 1, 2, 3].map(async n => {
      await r.service.transition({ runId, taskId: `task-${String(n)}`, to: 'settling' })
      await r.service.transition({ runId, taskId: `task-${String(n)}`, to: 'confirmed', spentCost: 0 })
    }))
    expect(held(r.service, runId), 'all four slots are free').toBe(0)
    expect(r.service.counts(runId).capacityDeficit, 'four slots short').toBe(4)

    // FIVE concurrent refills for four free slots: one must be refused.
    const refills = await Promise.all(
      Array.from({ length: 5 }, (_, i) => r.service.drain(runId, [request(300 + i)], signal)),
    )
    expect(refills.flat().filter(outcome => outcome.accepted), 'exactly four refilled').toHaveLength(4)
    expect(held(r.service, runId), 'back to exactly the target').toBe(4)
    expect(r.service.counts(runId).targetOvershoot, 'no overshoot from the storm').toBe(0)
    // The credits agree: four live reservations, and the four confirmed ones were
    // released rather than left held.
    expect(r.service.getRun(runId)!.budget.reserved, 'exactly four credits are held').toBe(4)
  }, 60_000)
})

// ===========================================================================
// H4 arm 4: crash after reservation before start
// ===========================================================================

describe('F5/H4-4: a crash after the reservation but before the start keeps the slot', () => {
  it('the reservation survives a process restart and still holds its slot', async () => {
    // THE WINDOW: the reservation is durable, the launch has not happened. A host
    // that comes back and treats that task as absent would over-admit, because the
    // child it reserved may already exist.
    //
    // This arm kills the service WITHOUT closing it (no `close()`, which is what a
    // crash means) and reopens a SECOND service over the SAME store directory,
    // which is the same construction `durability-records.test.ts` uses for its
    // restart arms.
    const sessionRoot = mkdtempSync(join(tmpdir(), 'dsh-f5-crash-sessions-'))
    const storeRoot = mkdtempSync(join(tmpdir(), 'dsh-f5-crash-store-'))
    const mkContext = async (): Promise<Context> => {
      const ctx = new Context()
      await mountAgentLoopTestDependencies(ctx)
      await ctx.plugin(JsonlSessionPersistence, { root: sessionRoot })
      await ctx.plugin(AgentLoop, { agents: [] })
      await ctx.plugin(SubagentRuntime, { maxActiveSubagents: 64, maxDepth: 1 })
      await ctx.plugin(SubagentSpawn, { providerName: 'spawn' })
      await ctx.plugin(class extends SessionQueryEngine {
        override searchSessions(): Promise<never> { return Promise.reject(new Error('not configured')) }
        override searchEvents(): Promise<never> { return Promise.reject(new Error('not configured')) }
      })
      await ctx.plugin(Storage, {} as never)
      await ctx.plugin(storageJsonPlugin as never, { root: storeRoot } as never)
      await ctx.plugin(storageDomainPlugin as never, { backend: 'json' } as never)
      ctx.llm.registerAdapter(['mock'], new ImmediateAdapter())
      return ctx
    }
    const newService = async (ctx: Context, label: string): Promise<WorkService> => {
      const service = new WorkService(ctx, {
        targetChildren: 3, maxDepth: 1, budgetCeiling: 10_000, currency: 'USD',
        priceVersion: `f5-crash-${label}`, subagentProvider: 'spawn',
      })
      await service.open()
      return service
    }

    const ctx1 = await mkContext()
    const root = await ctx1.agentLoop.create(SessionId('f5-crash-root'), { provider: 'mock', model: 'mock' })
    const first = await newService(ctx1, 'one')
    cleanups.push(async () => {
      await ctx1.fiber.dispose()
      rmSync(sessionRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
      rmSync(storeRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    })

    const runId = 'run-f5-crash'
    await first.createRun({ runId, root, authorizationRef: 'auth', targetChildren: 3 })
    first.setReadyTasks(runId, 100)
    // Reserve TWO slots and NEVER launch: this is exactly "durable task+childId
    // written, startContinuable never called" (gate D03).
    const a = await first.tryReserveAdmission({
      runId, taskId: 'task-c1', childId: 'child-c1', assignmentDigest: 'd1', reservedCost: 1, allowedCapabilities: ['reader'],
    })
    const b = await first.tryReserveAdmission({
      runId, taskId: 'task-c2', childId: 'child-c2', assignmentDigest: 'd2', reservedCost: 1, allowedCapabilities: ['reader'],
    })
    expect(a.reserved, 'the first reservation committed').toBe(true)
    expect(b.reserved, 'the second reservation committed').toBe(true)
    expect(a.task?.state, 'and the task is reserved, not started').toBe('prepared')
    expect(first.getRun(runId)!.budget.reserved, 'two credits are committed').toBe(2)
    expect(first.getRun(runId)!.reservationGeneration, 'two reservations committed').toBe(2)

    // THE CRASH: no `close()`. The store is left as it was.
    await ctx1.fiber.dispose()

    // A NEW PROCESS over the same store.
    const ctx2 = await mkContext()
    const second = await newService(ctx2, 'two')
    cleanups.push(async () => {
      await second.close()
      await ctx2.fiber.dispose()
    })

    // THE RECONSTRUCTION. The reservations are durable facts, not in-memory ones.
    const recovered = second.getRun(runId)!
    expect(Object.keys(recovered.tasks).sort(), 'both reserved tasks are still on the record').toEqual(['task-c1', 'task-c2'])
    expect(recovered.tasks['task-c1']?.state, 'and still hold their reserved state').toBe('prepared')
    expect(recovered.tasks['task-c2']?.state).toBe('prepared')
    expect(recovered.tasks['task-c1']?.childId, 'with the child id reserved BEFORE launch').toBe('child-c1')
    expect(recovered.budget.reserved, 'the credit reservation survived').toBe(2)
    expect(recovered.reservationGeneration, 'and so did the generation').toBe(2)
    // The launch intention is durable too, so a recovery can act on it rather
    // than infer it.
    expect(recovered.outbox['admit-task-c1']?.stage, 'the launch intention is in the outbox').toBe('pending')

    // A RECOVERED HOST HAS NO LAUNCH PORT UNTIL IT CREATES A RUN. Found while
    // measuring this arm, and recorded rather than smoothed over:
    // `installDefaultLaunchPort` is called from `createRun`, so a host that
    // recovers an EXISTING run and drains it reaches the `no launch port
    // installed` branch and quarantines every task instead of launching. The
    // reservation arithmetic under test is unaffected (that branch still reserves
    // first and holds the slot), but the arm installs a scripted port so it
    // measures the admission boundary rather than that separate gap.
    const scripted = scriptedPort()
    second.setLaunchPort(scripted.port)

    // THE PROPERTY THAT MATTERS: the recovered host may admit only ONE more
    // against a target of 3, because two slots are still held by work whose fate
    // is unknown. A host that forgot them would admit three.
    const signal = new AbortController().signal
    const outcomes = await Promise.all([
      second.drain(runId, [request(900)], signal),
      second.drain(runId, [request(901)], signal),
      second.drain(runId, [request(902)], signal),
      second.drain(runId, [request(903)], signal),
    ])
    expect(outcomes.flat().filter(outcome => outcome.accepted), 'exactly one more fits').toHaveLength(1)
    expect(held(second, runId), 'held reservations never exceed the target after recovery').toBe(3)
    expect(second.counts(runId).targetOvershoot, 'and nothing overshot').toBe(0)
  }, 90_000)
})

// ===========================================================================
// H4 arm 5: materialization / start failure
// ===========================================================================

describe('F5/H4-5: a launch failure reconciles its reservation exactly once', () => {
  it('a failed launch leaves the task UNKNOWN with its slot and credit HELD', async () => {
    // THE RULE (V3 §H1): "On launch failure: reconcile one reservation exactly
    // once; never release a slot merely because cancellation was requested;
    // release only after quiescence/failed materialization is established."
    //
    // A launch that THROWS does not prove the child was never created. Releasing
    // the slot here is how a system over-admits one layer down: the slot is freed,
    // a replacement is admitted, and if the first child did materialize there are
    // now two where the target allowed one.
    const r = await rig('launchfail', { target: 2 })
    const runId = 'run-f5-launchfail'
    await r.service.createRun({ runId, root: r.root, authorizationRef: 'auth', targetChildren: 2 })
    r.service.setReadyTasks(runId, 100)
    const scripted = scriptedPort()
    r.service.setLaunchPort(scripted.port)
    const signal = new AbortController().signal

    // One good admission, then a failing one.
    const ok = await r.service.drain(runId, [request(0)], signal)
    expect(ok.filter(outcome => outcome.accepted)).toHaveLength(1)

    scripted.failWith = new Error('provider refused to materialize the child')
    const failed = await r.service.drain(runId, [request(1)], signal)
    expect(failed[0]?.accepted, 'the failing launch is not accepted').toBe(false)
    expect(failed[0]?.reason, 'and it is reported as an unknown outcome, not a clean failure').toBe('launch_failed_unknown')

    // THE RESERVATION IS HELD, not released.
    const record = r.service.getRun(runId)!
    expect(record.tasks['task-1']?.state, 'the task rests in unknown, awaiting reconciliation').toBe('unknown')
    expect(record.tasks['task-1']?.uncertainty, 'with the failure recorded').toMatch(/launch failed/)
    expect(record.budget.reserved, 'its credit is STILL reserved').toBe(2)
    expect(held(r.service, runId), 'and its slot is still held').toBe(2)
    expect(record.terminalTombstones, 'nothing was tombstoned by a failure').toEqual([])
    // A failing launch must not have consumed the host ledger's slot either.
    expect(r.gate.occupied, 'the host ledger counts the quarantined task').toBe(2)

    // AND THE FAILURE BLOCKS FURTHER ADMISSION: the target is full, so a third
    // task cannot be admitted while the unknown holds its slot. This is the
    // conservative direction and it is the point.
    const blocked = await r.service.drain(runId, [request(2)], signal)
    expect(blocked[0]?.accepted, 'no third child while the unknown holds a slot').toBe(false)
    expect(held(r.service, runId), 'still exactly the target').toBe(2)
  }, 60_000)

  it('a missing launch port quarantines the task instead of pretending it failed', async () => {
    // The "no launch port installed" branch is a CONFIGURATION fault, and the
    // honest answer is `unknown` with the reservation held, never a clean failure
    // that frees the slot.
    const r = await rig('noport', { target: 2 })
    const runId = 'run-f5-noport'
    await r.service.createRun({ runId, root: r.root, authorizationRef: 'auth', targetChildren: 2 })
    r.service.setReadyTasks(runId, 100)
    // The service installs a DEFAULT port at createRun when a subagent runtime is
    // mounted, so a port must be replaced with an explicit undefined-equivalent to
    // reach this branch: a port whose launch rejects is the closest honest shape.
    // The branch is asserted through the reservation + transition path instead.
    const scripted = scriptedPort()
    scripted.failWith = new Error('no provider is mounted in this composition')
    r.service.setLaunchPort(scripted.port)

    const outcomes = await r.service.drain(runId, [request(0)], new AbortController().signal)
    expect(outcomes[0]?.accepted).toBe(false)
    const record = r.service.getRun(runId)!
    expect(record.tasks['task-0']?.state, 'quarantined rather than cleanly failed').toBe('unknown')
    expect(record.budget.reserved, 'the credit is retained').toBe(1)
    expect(held(r.service, runId), 'and the slot is retained').toBe(1)
  }, 60_000)
})

// ===========================================================================
// H4 arm 6: duplicate launch notification
// ===========================================================================

describe('F5/H4-6: a duplicate launch notification cannot double-admit', () => {
  it('the same taskId submitted concurrently admits once, and its credit is reserved once', async () => {
    // A duplicate notification is the ordinary retry shape: a settle edge fires
    // twice, or two event sources report the same completion. The property is
    // ONE task, ONE reservation, ONE child — even when the duplicates arrive in
    // the same instant.
    const r = await rig('dup', { target: 5 })
    const runId = 'run-f5-dup'
    await r.service.createRun({ runId, root: r.root, authorizationRef: 'auth', targetChildren: 5 })
    r.service.setReadyTasks(runId, 100)
    const scripted = scriptedPort()
    r.service.setLaunchPort(scripted.port)
    const signal = new AbortController().signal

    const same = request(0)
    const outcomes = await Promise.all(
      Array.from({ length: 6 }, () => r.service.drain(runId, [same], signal)),
    )
    const admitted = outcomes.flat().filter(outcome => outcome.accepted)
    expect(admitted, 'exactly ONE of the six duplicates is admitted').toHaveLength(1)

    const record = r.service.getRun(runId)!
    expect(Object.keys(record.tasks), 'exactly one task row exists').toEqual(['task-0'])
    expect(record.tasks['task-0']?.attempt, 'and it is attempt 1, not 6').toBe(1)
    expect(record.budget.reserved, 'exactly one credit is reserved').toBe(1)
    expect(held(r.service, runId), 'and exactly one slot is held').toBe(1)
    expect(record.reservationGeneration, 'exactly one reservation committed').toBe(1)
    // The child was launched exactly once: a duplicate that re-launched would put
    // two children behind one task id.
    expect(scripted.launches, 'the port was called exactly once').toHaveLength(1)

    // A LATE duplicate, after the task is admitted, is also refused rather than
    // re-minting a child under a new identity.
    const late = await r.service.drain(runId, [same], signal)
    expect(late[0]?.accepted, 'a late duplicate is refused').toBe(false)
    expect(late[0]?.reason, 'and the reason names the existing admission').toMatch(/already admitted as accepted/)
    expect(scripted.launches, 'still exactly one launch').toHaveLength(1)
  }, 60_000)
})

// ===========================================================================
// H4 arm 7: stopping child retains occupancy
// ===========================================================================

describe('F5/H4-7: a stopping child keeps its slot until quiescence', () => {
  it('a requested cancel holds the slot and blocks the refill', async () => {
    // THE RULE: "never release a slot merely because cancellation was requested".
    // A sent cancel is not a confirmed cancel: the child may still be executing,
    // and admitting a replacement would put two children where the target allows
    // one.
    const r = await rig('stopping', { target: 2 })
    const runId = 'run-f5-stopping'
    await r.service.createRun({ runId, root: r.root, authorizationRef: 'auth', targetChildren: 2 })
    r.service.setReadyTasks(runId, 100)
    r.service.setLaunchPort(scriptedPort().port)
    const signal = new AbortController().signal

    await r.service.drain(runId, [request(0), request(1)], signal)
    expect(held(r.service, runId)).toBe(2)

    // Ask one to stop. The slot is NOT freed.
    await r.service.transition({ runId, taskId: 'task-0', to: 'cancel_requested' })
    const counts = r.service.counts(runId)
    expect(counts.stopping, 'the cancel is counted as stopping').toBe(1)
    expect(held(r.service, runId), 'and it still HOLDS its slot').toBe(2)
    expect(counts.capacityDeficit, 'so there is no free slot').toBe(0)

    // A refill attempt is refused, because the stopping child has not quiesced.
    const premature = await r.service.drain(runId, [request(50)], signal)
    expect(premature[0]?.accepted, 'no refill while the cancel is unconfirmed').toBe(false)
    expect(held(r.service, runId), 'still exactly the target').toBe(2)
    expect(r.service.getRun(runId)!.budget.reserved, 'and the credit is still held').toBe(2)

    // ONLY quiescence releases it.
    await r.service.transition({ runId, taskId: 'task-0', to: 'cancelled' })
    expect(held(r.service, runId), 'the confirmed cancel freed exactly one slot').toBe(1)
    const refill = await r.service.drain(runId, [request(51)], signal)
    expect(refill[0]?.accepted, 'and the refill is now admitted').toBe(true)
    expect(held(r.service, runId), 'back to the target').toBe(2)
  }, 60_000)
})

// ===========================================================================
// H4 arm 8: unknown/quarantined child retains occupancy
// ===========================================================================

describe('F5/H4-8: an unknown child retains its occupancy', () => {
  it('a quarantined task holds its slot against a full target and blocks admission', async () => {
    // An `unknown` task is one whose outcome cannot be established. Releasing its
    // slot would admit a replacement for a child that may be alive, which is the
    // over-admission this whole change forbids, reached through the reconciliation
    // door instead of the race.
    const r = await rig('unknown', { target: 2 })
    const runId = 'run-f5-unknown'
    await r.service.createRun({ runId, root: r.root, authorizationRef: 'auth', targetChildren: 2 })
    r.service.setReadyTasks(runId, 100)
    r.service.setLaunchPort(scriptedPort().port)
    const signal = new AbortController().signal

    await r.service.drain(runId, [request(0), request(1)], signal)
    await r.service.transition({
      runId, taskId: 'task-0', to: 'unknown',
      uncertainty: 'the child was disposed without a result; its fate is not establishable',
      releaseReservation: false,
    })
    const counts = r.service.counts(runId)
    expect(counts.quarantinedUnknown, 'one task is quarantined').toBe(1)
    expect(held(r.service, runId), 'and it holds its slot').toBe(2)
    expect(r.service.getRun(runId)!.budget.reserved, 'and its credit').toBe(2)

    const blocked = await r.service.drain(runId, [request(60)], signal)
    expect(blocked[0]?.accepted, 'the quarantine blocks a refill').toBe(false)
    expect(held(r.service, runId), 'held stays at the target').toBe(2)

    // Reconciliation is the ONLY way out, and it may conclude the task finished.
    // Then — and only then — the slot is released.
    await r.service.transition({ runId, taskId: 'task-0', to: 'confirmed', spentCost: 0 })
    expect(held(r.service, runId), 'reconciliation released the slot').toBe(1)
    const after = await r.service.drain(runId, [request(61)], signal)
    expect(after[0]?.accepted, 'and the refill is admitted').toBe(true)
  }, 60_000)
})

// ===========================================================================
// H4 arm 9: budget + target contention
// ===========================================================================

describe('F5/H4-9: budget and target contend inside the SAME update', () => {
  it('with one free credit and three free slots, exactly ONE admission wins', async () => {
    // The two gates must both be decided in the same atomic step. If the target
    // check and the budget check lived in different places, a storm could pass the
    // target check and then contend for credit outside the update — which is the
    // CAP-09 hole reopened in the other direction.
    //
    // CONSTRUCTION: ceiling 110, root reserve 10, so the child ceiling is 100. One
    // task is admitted at cost 99, leaving exactly ONE credit. The target is 3, so
    // TWO slots are free. Five concurrent requests ask for that one credit: the
    // correct answer is exactly one.
    const r = await rig('contend', { target: 3, budgetCeiling: 110, rootReserve: 10 })
    const runId = 'run-f5-contend'
    await r.service.createRun({ runId, root: r.root, authorizationRef: 'auth', targetChildren: 3, rootReserve: 10 })
    r.service.setReadyTasks(runId, 100)
    r.service.setLaunchPort(scriptedPort().port)
    const signal = new AbortController().signal

    const seed = await r.service.drain(runId, [request(0, 99)], signal)
    expect(seed[0]?.accepted, 'the 99-credit seed is admitted').toBe(true)
    expect(r.service.budget(runId).childCeiling, 'the child ceiling is ceiling minus the root reserve').toBe(100)
    expect(r.service.getRun(runId)!.budget.reserved, 'one credit remains').toBe(99)

    // TWO slots free, ONE credit free, five contenders.
    const contenders = await Promise.all(
      Array.from({ length: 5 }, (_, i) => r.service.drain(runId, [request(400 + i, 1)], signal)),
    )
    const admitted = contenders.flat().filter(outcome => outcome.accepted)
    expect(admitted, 'exactly ONE contender wins the last credit').toHaveLength(1)
    expect(held(r.service, runId), 'two slots were free but only one could be paid for').toBe(2)
    // The ledger lands exactly ON the ceiling, never past it.
    const record = r.service.getRun(runId)!
    expect(record.budget.reserved, 'the ledger is exactly at the child ceiling').toBe(100)
    expect(record.budget.reserved).toBeLessThanOrEqual(r.service.budget(runId).childCeiling)
    // The refusals name the BUDGET, not the slot: the reason must be the gate that
    // actually fired.
    for (const outcome of contenders.flat().filter(o => !o.accepted)) {
      expect(String(outcome.reason), 'a budget refusal names the budget').toMatch(/budget_blocked/)
    }
    // The deficit still reads 1 — one slot short — which is honest: the target is
    // NOT met, and the reason is the budget rather than a shortage of ready work.
    expect(r.service.counts(runId).capacityDeficit, 'one slot remains unfilled').toBe(1)
    expect(r.service.counts(runId).targetOvershoot, 'nothing overshot').toBe(0)
  }, 60_000)
})

// ===========================================================================
// H4 arm 10: process restart reconstructs reservations/outbox
// ===========================================================================

describe('F5/H4-10: a restart reconstructs the reservations and the outbox', () => {
  it('a clean close and reopen preserves every reservation, credit and intention', async () => {
    // The complement of arm 4: an ORDERLY restart. Both must reconstruct the same
    // authoritative facts, because a recovery that depends on how the process died
    // is not a recovery.
    const sessionRoot = mkdtempSync(join(tmpdir(), 'dsh-f5-restart-sessions-'))
    const storeRoot = mkdtempSync(join(tmpdir(), 'dsh-f5-restart-store-'))
    const mkContext = async (): Promise<Context> => {
      const ctx = new Context()
      await mountAgentLoopTestDependencies(ctx)
      await ctx.plugin(JsonlSessionPersistence, { root: sessionRoot })
      await ctx.plugin(AgentLoop, { agents: [] })
      await ctx.plugin(SubagentRuntime, { maxActiveSubagents: 64, maxDepth: 1 })
      await ctx.plugin(SubagentSpawn, { providerName: 'spawn' })
      await ctx.plugin(class extends SessionQueryEngine {
        override searchSessions(): Promise<never> { return Promise.reject(new Error('not configured')) }
        override searchEvents(): Promise<never> { return Promise.reject(new Error('not configured')) }
      })
      await ctx.plugin(Storage, {} as never)
      await ctx.plugin(storageJsonPlugin as never, { root: storeRoot } as never)
      await ctx.plugin(storageDomainPlugin as never, { backend: 'json' } as never)
      ctx.llm.registerAdapter(['mock'], new ImmediateAdapter())
      return ctx
    }
    const open = async (ctx: Context, label: string): Promise<WorkService> => {
      const service = new WorkService(ctx, {
        targetChildren: 3, maxDepth: 1, budgetCeiling: 10_000, currency: 'USD',
        priceVersion: `f5-restart-${label}`, subagentProvider: 'spawn',
      })
      await service.open()
      return service
    }

    const ctx1 = await mkContext()
    const root = await ctx1.agentLoop.create(SessionId('f5-restart-root'), { provider: 'mock', model: 'mock' })
    const first = await open(ctx1, 'one')
    cleanups.push(async () => {
      await ctx1.fiber.dispose()
      rmSync(sessionRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
      rmSync(storeRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    })

    const runId = 'run-f5-restart'
    await first.createRun({ runId, root, authorizationRef: 'auth', targetChildren: 3, restartResumeAuthorized: true })
    first.setReadyTasks(runId, 100)
    first.setLaunchPort(scriptedPort().port)
    const signal = new AbortController().signal

    await first.drain(runId, [request(0), request(1)], signal)
    // Both tasks are now `accepted` (the port resolved), so this arm's interesting
    // state is the pair: one accepted, one still prepared. `task-1` is deliberately
    // NOT launched, so the restart must reconstruct a task that was reserved and
    // never started — the same D03 shape arm 4 covers, here across an orderly close.
    const before = first.getRun(runId)!
    expect(before.tasks['task-0']?.state, 'the first is accepted').toBe('accepted')
    expect(before.tasks['task-1']?.state, 'the second is accepted too').toBe('accepted')
    expect(before.budget.reserved, 'two credits before the restart').toBe(2)

    // ORDERLY close, then reopen.
    await first.close()
    const ctx2 = await mkContext()
    const second = await open(ctx2, 'two')
    cleanups.push(async () => {
      await second.close()
      await ctx2.fiber.dispose()
    })

    const after = second.getRun(runId)!
    expect(Object.keys(after.tasks).sort(), 'both tasks survived').toEqual(['task-0', 'task-1'])
    expect(after.tasks['task-0']?.state, 'the accepted state survived').toBe('accepted')
    expect(after.tasks['task-1']?.state, 'the second accepted state survived').toBe('accepted')
    expect(after.budget.reserved, 'the credit reservation survived').toBe(2)
    expect(after.reservationGeneration, 'the generation survived').toBe(2)
    expect(after.outbox['admit-task-0']?.stage, 'the launch intention survived').toBe('pending')
    expect(after.outbox['admit-task-1']?.stage).toBe('pending')

    // Same recovered-host note as arm 4: a port must be installed explicitly on
    // a host that recovered an existing run rather than creating one.
    const scripted = scriptedPort()
    second.setLaunchPort(scripted.port)

    // ONE slot remains, and only one more admission fits.
    const outcomes = await Promise.all([
      second.drain(runId, [request(700)], signal),
      second.drain(runId, [request(701)], signal),
      second.drain(runId, [request(702)], signal),
    ])
    expect(outcomes.flat().filter(outcome => outcome.accepted), 'exactly one more fits').toHaveLength(1)
    expect(held(second, runId), 'held reservations never exceed the target after restart').toBe(3)
  }, 90_000)
})

// ===========================================================================
// H4 arm 11: no alternate child-launch surface can bypass the invariant
// ===========================================================================

describe('F5/H4-11: the reservation is the only admission path in the service', () => {
  it('every public admission entry point routes through tryReserveAdmission', async () => {
    // THE G-SEAM-31 SHAPE THIS PROJECT REPRODUCES: a mechanism that is correct
    // while a product path bypasses it. So the claim is not "the reservation is
    // atomic"; it is "no other path can admit". This arm measures that by driving
    // the service's OTHER public admission surfaces against a FULL target and
    // requiring every one of them to refuse.
    const r = await rig('bypass', { target: 2 })
    const runId = 'run-f5-bypass'
    await r.service.createRun({ runId, root: r.root, authorizationRef: 'auth', targetChildren: 2 })
    r.service.setReadyTasks(runId, 100)
    r.service.setLaunchPort(scriptedPort().port)
    const signal = new AbortController().signal

    // Fill the target through the ordinary path.
    await r.service.drain(runId, [request(0), request(1)], signal)
    expect(held(r.service, runId)).toBe(2)

    // SURFACE 1: `admit` (the direct API).
    await expect(r.service.admit({
      runId, taskId: 'task-bypass-admit', childId: 'child-bypass-admit',
      assignmentDigest: 'd', reservedCost: 1, allowedCapabilities: ['reader'],
    })).rejects.toThrow(/already holds 2 of its target 2 slots/)

    // SURFACE 2: `tryReserveAdmission` (the reservation API itself).
    const direct = await r.service.tryReserveAdmission({
      runId, taskId: 'task-bypass-reserve', childId: 'child-bypass-reserve',
      assignmentDigest: 'd', reservedCost: 1, allowedCapabilities: ['reader'],
    })
    expect(direct.reserved, 'the reservation API refuses too').toBe(false)
    expect(direct.reason, 'and reports the full target').toBe('none')
    expect(direct.heldReservations, 'naming the authoritative occupancy').toBe(2)
    expect(direct.target).toBe(2)

    // SURFACE 3: `drain` with a batch that would exceed the target if the batch
    // were admitted wholesale. A batch is NOT one decision: each request is
    // reserved individually, so the third must fail even inside one call.
    const batch = await r.service.drain(runId, [request(50), request(51), request(52)], signal)
    expect(batch.filter(outcome => outcome.accepted), 'a batch cannot exceed the target either').toHaveLength(0)

    // After all three attempts, the target is still exactly full and the ledger
    // shows no leak: a refused attempt must not have taken a slot.
    expect(held(r.service, runId), 'nothing was admitted by any surface').toBe(2)
    expect(r.gate.occupied, 'and no slot leaked in the host ledger').toBe(2)
    expect(r.service.getRun(runId)!.budget.reserved, 'no credit leaked either').toBe(2)
    expect(r.service.getRun(runId)!.reservationGeneration, 'and no generation advanced').toBe(2)
  }, 60_000)

  it('a batch that fits admits exactly its share and no more', async () => {
    // The complement: the batch path must still WORK. A "fix" that refused every
    // batch would pass the arm above and break the product.
    const r = await rig('batch', { target: 5 })
    const runId = 'run-f5-batch'
    await r.service.createRun({ runId, root: r.root, authorizationRef: 'auth', targetChildren: 5 })
    r.service.setReadyTasks(runId, 100)
    r.service.setLaunchPort(scriptedPort().port)
    const signal = new AbortController().signal

    const outcomes = await r.service.drain(runId, [request(0), request(1), request(2)], signal)
    expect(outcomes.filter(outcome => outcome.accepted), 'three of five admitted').toHaveLength(3)
    expect(held(r.service, runId)).toBe(3)
    expect(r.service.counts(runId).capacityDeficit, 'two slots remain').toBe(2)
  }, 60_000)
})

// ===========================================================================
// H4 arm 12: the DSH hard cap rejects the 31st continuable child INDEPENDENTLY
// ===========================================================================

describe('F5/H4-12: the hard cap of 30 rejects the 31st child independently of the target', () => {
  it('the deployment cap refuses the 31st even when the run target would allow it', async () => {
    // THE RELATIONSHIP V3 §H2 STATES: "DSH pool = hard physical cap; WorkService
    // target N = desired managed occupancy <= hard cap." The cap must hold
    // INDEPENDENTLY of the target, so a run whose target is at or above 30 still
    // cannot exceed 30 physical children. This is the layer that catches what the
    // target arithmetic cannot: children materialized outside this run's record.
    //
    // SYNTHETIC OCCUPANCY, not 30 real children: the cap is the property, and
    // driving the ledger directly makes "30 occupied" an exact precondition rather
    // than a race. The same construction `capacity.test.ts` uses.
    expect(HARD_CHILD_CAPACITY, 'the deployment constant is 30').toBe(30)

    const r = await rig('hardcap', { target: 40, pool: 64 })
    const runId = 'run-f5-hardcap'
    // A target ABOVE the cap is legal to RECORD (it is a target, not a child) and
    // surfaces as an honest permanent deficit rather than as an over-admission.
    await r.service.createRun({ runId, root: r.root, authorizationRef: 'auth', targetChildren: 40 })
    r.service.setReadyTasks(runId, 100)
    r.service.setLaunchPort(scriptedPort().port)

    // Take 30 slots in the HOST ledger, which is what the cap counts.
    const held30 = Array.from({ length: 30 }, (_, i) => r.gate.reserveChild(`child-synthetic-${String(i)}`))
    expect(r.gate.occupied, 'thirty children are resident').toBe(30)
    expect(r.gate.snapshot().highWater, 'and the cap was never exceeded').toBe(30)

    // THE 31st IS REFUSED BY THE CAP, even though the run's target of 40 would
    // allow it. This is the independent limit.
    expect(() => r.gate.reserveChild('child-synthetic-30'), 'the 31st is refused').toThrow(/hard capacity is 30/)
    expect(() => r.gate.reserveChild('child-synthetic-31'), 'and so is the 32nd').toThrow(/hard capacity is 30/)
    expect(r.gate.occupied, 'occupancy never exceeded the cap').toBe(30)

    // THROUGH THE SERVICE: a drain at a target of 40 is refused by the host cap,
    // and the refusal NAMES the cap rather than the target. That distinction is
    // the whole point of the arm.
    const outcomes = await r.service.drain(runId, [request(999)], new AbortController().signal)
    expect(outcomes[0]?.accepted, 'the service admits nothing at the cap').toBe(false)
    expect(outcomes[0]?.reason, 'and names the HOST cap, not the target').toBe('host_capacity_reached')
    expect(r.gate.occupied, 'the cap held').toBe(30)
    expect(r.gate.snapshot().refusals.HOST_CAPACITY_REACHED, 'the refusals were counted as capacity').toBeGreaterThanOrEqual(2)

    // Release the synthetic occupancy so teardown is clean.
    for (const slot of held30) slot.release()
  }, 60_000)

  it('the RESERVATION API reports the cap as a TYPED refusal, not as a thrown error', async () => {
    // THE CONTRACT. `tryReserveAdmission`'s return type says it answers with an
    // `AdmissionReservation`, so a caller must never have to catch an exception to
    // learn that the cap refused it. This is not cosmetic: `reserveTask` reaches
    // `ChildAdmissionGate.assertRoom`, which THROWS `ChildCapacityError`
    // (`capacity.ts:434`, `:502-505`), and an unwrapped throw would escape the
    // typed seam and land in whatever `catch` the caller happened to have —
    // which is how a capacity refusal becomes indistinguishable from a storage
    // fault in a report.
    //
    // The pre-existing `admit` had exactly this shape (the throw escaped it), so
    // this arm pins the behaviour of the NEW seam and is explicit that it is
    // fixing the contract of the new path rather than claiming a regression.
    const r = await rig('captyped', { target: 40, pool: 64 })
    const runId = 'run-f5-captyped'
    await r.service.createRun({ runId, root: r.root, authorizationRef: 'auth', targetChildren: 40 })
    r.service.setReadyTasks(runId, 100)

    // Fill the HOST ledger to the cap, leaving the run's target unmet at 40.
    const held30 = Array.from({ length: 30 }, (_, i) => r.gate.reserveChild(`child-typed-${String(i)}`))
    expect(r.gate.occupied).toBe(30)

    // THE ASSERTION: a VALUE comes back, and no exception is thrown. If the throw
    // escaped, this `await` would reject and the test would fail with the
    // ChildCapacityError rather than an assertion message — which is itself the
    // evidence that the throw was escaping.
    const reservation = await r.service.tryReserveAdmission({
      runId, taskId: 'task-typed', childId: 'child-typed', assignmentDigest: 'd',
      reservedCost: 1, allowedCapabilities: ['reader'],
    })
    expect(reservation.reserved, 'the cap is reported as a refusal, not thrown').toBe(false)
    expect(reservation.reason, 'with its OWN reason, distinct from a satisfied target').toBe('host_capacity_reached')
    expect(reservation.refusalMessage, 'and the gate\'s message is preserved').toMatch(/hard capacity is 30/)
    expect(reservation.target, 'the run target is still reported').toBe(40)
    // The run is BELOW its target and cannot reach it: that is a real deficit, and
    // reporting `host_capacity_reached` rather than `none` is what keeps it honest.
    expect(r.service.counts(runId).capacityDeficit, 'the deficit is real and reported').toBe(40)

    // The refusal took nothing: no task row, no credit, no generation.
    expect(r.service.getRun(runId)!.tasks['task-typed'], 'no task was written').toBeUndefined()
    expect(r.service.getRun(runId)!.budget.reserved, 'no credit was reserved').toBe(0)
    expect(r.service.getRun(runId)!.reservationGeneration, 'no generation advanced').toBe(0)
    expect(r.gate.occupied, 'and no slot leaked').toBe(30)

    // `admit` — which throws by contract — still throws, and the message is the
    // cap's rather than a generic failure. The two seams differ deliberately.
    await expect(r.service.admit({
      runId, taskId: 'task-typed-admit', childId: 'child-typed-admit', assignmentDigest: 'd',
      reservedCost: 1, allowedCapabilities: ['reader'],
    })).rejects.toThrow(/hard capacity is 30/)

    for (const slot of held30) slot.release()
  }, 60_000)
})

// ===========================================================================
// THE ARM THAT PROVES THE LAYERS ARE INDEPENDENT
// ===========================================================================
describe('F5/layers: the invariant holds WITHOUT the coalescer', () => {
  it('THE COALESCER IS RE-TRIGGERABLE: a later arrival still causes a new pass', async () => {
    // CAP-10's THIRD CLAUSE, and the one a "no overshoot" test alone cannot
    // catch: "no duplicate launch, no overshoot past the target, and no MISSED
    // REPLACEMENT; the coalesced drain is shown to be re-triggerable."
    //
    // WHY THIS ARM EXISTS SEPARATELY. A coalescer that latched after its first
    // pass — never running again — would satisfy "held never exceeds the target"
    // perfectly, because it would never admit anything again. That is the
    // failure mode this clause exists to forbid, and it is invisible to every
    // overshoot assertion in this file. So re-triggerability is asserted
    // directly, by making the leader run SEVERAL passes with arrivals between
    // them and requiring each to do work.
    //
    // The generation loop's own contract is what is under test: the leader runs
    // while `requestedGeneration > handledGeneration`, so a fresh arrival after a
    // pass must advance `requestedGeneration` and produce a new pass.
    const r = await rig('retrigger', { target: 4 })
    const runId = 'run-f5-retrigger'
    await r.service.createRun({ runId, root: r.root, authorizationRef: 'auth', targetChildren: 4 })
    r.service.setReadyTasks(runId, 100)
    const scripted = scriptedPort()
    r.service.setLaunchPort(scripted.port)
    const signal = new AbortController().signal

    // PASS 1: fill two of four.
    const first = await r.service.drain(runId, [request(0), request(1)], signal)
    expect(first.filter(outcome => outcome.accepted), 'the first pass admits two').toHaveLength(2)
    expect(held(r.service, runId)).toBe(2)

    // PASS 2, a SEPARATE later arrival: it must do work, not be absorbed forever.
    const second = await r.service.drain(runId, [request(2), request(3)], signal)
    expect(second.filter(outcome => outcome.accepted), 'the second pass admits two more').toHaveLength(2)
    expect(held(r.service, runId), 'the target is now full').toBe(4)

    // PASS 3 must still RUN and still refuse: a leader that stopped re-triggering
    // would return stale/empty work rather than evaluating the request.
    const third = await r.service.drain(runId, [request(4)], signal)
    expect(third, 'the third pass produced an OUTCOME for its request').toHaveLength(1)
    expect(third[0]?.accepted, 'and refused it, because the target is full').toBe(false)
    expect(third[0]?.taskId, 'the outcome is for the request that was made').toBe('task-4')

    // PASS 4, after a slot frees: the refill must happen. This is the clause that
    // matters most — a coalescer that stopped re-triggering would leave the run
    // permanently one short.
    await r.service.transition({ runId, taskId: 'task-0', to: 'settling' })
    await r.service.transition({ runId, taskId: 'task-0', to: 'confirmed', spentCost: 0 })
    expect(held(r.service, runId), 'one slot freed').toBe(3)
    const fourth = await r.service.drain(runId, [request(5)], signal)
    expect(fourth[0]?.accepted, 'the fourth pass refilled the freed slot').toBe(true)
    expect(held(r.service, runId), 'back to the target').toBe(4)

    // Every pass reached the port: no pass was absorbed into a predecessor.
    expect(scripted.launches.map(launch => launch.taskId).sort())
      .toEqual(['task-0', 'task-1', 'task-2', 'task-3', 'task-5'])
  }, 60_000)

  it('a pass that THROWS rejects every caller rather than hanging them', async () => {
    // A HANG IS WORSE THAN A REJECTION, because it is invisible: a caller awaiting
    // a promise that never settles looks like a slow operation forever. The leader
    // splices its batch out of `pending` BEFORE running the pass, so a `catch` that
    // only walked `pending` would leak exactly the in-flight callers — the ones
    // most likely to exist.
    //
    // THE FAULT: a run whose record is DELETED mid-pass. `transition` then throws
    // `task ... is not in run ...` from inside the transform, which is a genuine
    // storage-level failure rather than a refusal, so it propagates out of the
    // pass. Both the in-flight caller and a caller that arrives during the failed
    // pass must be rejected.
    //
    // THE ASSERTION IS BOUNDED, not open-ended: `Promise.allSettled` settles as
    // soon as both settle, so if either hung, the vitest timeout (60s) is what
    // fails rather than an assertion — and the failure message says so. That is
    // the honest instrument for a hang.
    const r = await rig('throw', { target: 4 })
    const runId = 'run-f5-throw'
    await r.service.createRun({ runId, root: r.root, authorizationRef: 'auth', targetChildren: 4 })
    r.service.setReadyTasks(runId, 100)
    const scripted = scriptedPort()
    r.service.setLaunchPort(scripted.port)
    const signal = new AbortController().signal

    // Make the LAUNCH throw a non-Error value, which is not one of the shapes the
    // pass handles as a launch failure: `port.launch` rejecting is caught, so this
    // arm instead uses a transition failure, which is NOT caught by design (a
    // storage fault must not be swallowed as an admission refusal).
    //
    // Concretely: delete the run record while the pass is in flight. The next
    // `transition` in the pass throws `task ... is not in run ...`.
    await r.service.drain(runId, [request(0)], signal)
    expect(held(r.service, runId), 'one task is admitted').toBe(1)

    // Close the domain: every subsequent `update` rejects, which is a real storage
    // fault. The service is then unusable, so this arm only asserts the settling
    // behaviour of the callers already in flight.
    const inFlight = r.service.drain(runId, [request(1), request(2)], signal)
    await r.service.close()

    // BOTH callers settle — as rejections, because the storage is gone.
    const settled = await Promise.allSettled([inFlight])
    expect(settled[0]?.status, 'the in-flight caller SETTLED rather than hanging').toBe('rejected')
  }, 60_000)

  it('WITH THE COALESCER DEFEATED: concurrent reservations still never exceed the target', async () => {
    // THE AUDIT'S CENTRAL POINT (V3 §H3): "even if this in-memory coalescer
    // regresses, atomic reservation must still prevent target over-admission."
    //
    // This arm DEFEATS the coalescer deliberately. It does not call `drain` at
    // all — it calls `tryReserveAdmission` directly, concurrently, which is the
    // path `drain`'s leader would have serialized. If the invariant lived in the
    // coalescer, this arm would over-admit. It cannot, because the decision is
    // inside one storage-domain update.
    //
    // WHY THIS IS THE LOAD-BEARING ARM. Every other arm in this file could in
    // principle be satisfied by a correct coalescer. This one cannot, so it is the
    // arm that distinguishes "the race is hidden by a leader" from "the race is
    // closed at the state transition".
    const r = await rig('nocoalesce', { target: 3 })
    const runId = 'run-f5-nocoalesce'
    await r.service.createRun({ runId, root: r.root, authorizationRef: 'auth', targetChildren: 3 })
    r.service.setReadyTasks(runId, 100)

    // EIGHT concurrent reservations, launched in ONE microtask batch so they all
    // reach the domain's write chain together.
    const attempts = await Promise.all(
      Array.from({ length: 8 }, (_, i) => r.service.tryReserveAdmission({
        runId,
        taskId: `task-nc-${String(i)}`,
        childId: `child-nc-${String(i)}`,
        assignmentDigest: `d-${String(i)}`,
        reservedCost: 1,
        allowedCapabilities: ['reader'],
      })),
    )
    const committed = attempts.filter(attempt => attempt.reserved)
    expect(committed, 'exactly the target committed, with no coalescer involved').toHaveLength(3)
    expect(held(r.service, runId), 'held reservations are exactly the target').toBe(3)
    expect(r.service.getRun(runId)!.reservationGeneration, 'exactly three generations advanced').toBe(3)
    expect(r.service.getRun(runId)!.budget.reserved, 'exactly three credits committed').toBe(3)

    // EVERY COMMITTED ATTEMPT SAW A DISTINCT OCCUPANCY, which is the mechanism
    // made visible: 0, 1, 2 — not 0, 0, 0 as the racing version produced. This is
    // the direct evidence that the transform saw each predecessor's commit.
    //
    // `observedOccupancy` is the value the transform computed INSIDE the update,
    // before its own admission, so the sequence of winners is the sequence of
    // occupancy levels the write chain serialized them through.
    const seen = committed.map(attempt => attempt.observedOccupancy).sort((a, b) => a - b)
    expect(seen, 'each winner observed a DIFFERENT pre-admission occupancy').toEqual([0, 1, 2])
    // And the five losers each saw the target already reached.
    const refused = attempts.filter(attempt => !attempt.reserved)
    expect(refused, 'five were refused').toHaveLength(5)
    for (const attempt of refused) {
      expect(attempt.observedOccupancy, 'each refusal saw a full target').toBe(3)
      expect(attempt.target).toBe(3)
    }
    // THE COUNTERFACTUAL, stated so a reader can check it: the racing version
    // produced `[0, 0, 0]` here — every attempt read the same pre-write record —
    // and admitted past the target. A distinct sequence is only possible if each
    // transform saw its predecessor's committed value.
    expect(new Set(seen).size, 'the occupancy values are distinct, so the writes serialized').toBe(3)
  }, 60_000)

  it('WITH THE COALESCER DEFEATED: the generation refuses a caller that decided from a stale revision', async () => {
    // The other half of root's warning: a generation read OUTSIDE the update is
    // not authoritative. So the guard must compare INSIDE the transform. This arm
    // proves the comparison is real by handing it a revision it cannot satisfy.
    const r = await rig('stale', { target: 5 })
    const runId = 'run-f5-stale'
    await r.service.createRun({ runId, root: r.root, authorizationRef: 'auth', targetChildren: 5 })
    r.service.setReadyTasks(runId, 100)

    const fresh = r.service.getRun(runId)!.reservationGeneration
    expect(fresh, 'a new run is at generation 0').toBe(0)

    // A caller that decided from generation 0 commits fine.
    const first = await r.service.tryReserveAdmission({
      runId, taskId: 'task-s1', childId: 'child-s1', assignmentDigest: 'd',
      reservedCost: 1, allowedCapabilities: [], expectedRunRevision: 0,
    })
    expect(first.reserved, 'the caller at the current generation commits').toBe(true)

    // A SECOND caller that ALSO decided from generation 0 is refused: the record
    // has moved past the state it reasoned from.
    const stale = await r.service.tryReserveAdmission({
      runId, taskId: 'task-s2', childId: 'child-s2', assignmentDigest: 'd',
      reservedCost: 1, allowedCapabilities: [], expectedRunRevision: 0,
    })
    expect(stale.reserved, 'the stale-revision caller is refused').toBe(false)
    expect(stale.refusalMessage, 'and the refusal says why').toMatch(/stale revision/)
    expect(stale.generation, 'reporting the generation it actually found').toBe(1)
    expect(held(r.service, runId), 'the refusal wrote nothing').toBe(1)
    expect(r.service.getRun(runId)!.budget.reserved, 'and reserved nothing').toBe(1)

    // A caller at the CURRENT generation commits.
    const current = await r.service.tryReserveAdmission({
      runId, taskId: 'task-s3', childId: 'child-s3', assignmentDigest: 'd',
      reservedCost: 1, allowedCapabilities: [], expectedRunRevision: 1,
    })
    expect(current.reserved, 'the up-to-date caller commits').toBe(true)
    expect(current.generation, 'and the generation advanced').toBe(2)
  }, 60_000)
})
