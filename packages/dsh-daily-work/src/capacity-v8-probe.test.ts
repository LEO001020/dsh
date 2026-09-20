/**
 * V8 probe: the two admission-path gaps the CAP family's existing evidence does
 * NOT cover, measured rather than inferred.
 *
 * WHY THIS FILE EXISTS. `capacity.test.ts` covers the continuable, one-shot,
 * direct-factory and workflow/PTC creation paths, and covers the deficit/lower/
 * root-headroom arithmetic. Two things in the CAP oracles were not measured
 * anywhere:
 *
 *   1. CAP-02 names FIVE admission paths and the fifth is a COLD RESUME. The
 *      four measured paths all funnel through `AgentRegistry.create`. A resume
 *      reaches `AgentRegistry.resume` -> `setupAndPublish(..., 'resume', ...)`
 *      -> `publish('resume')` instead (`core/agent-loop/src/index.ts:859-935`),
 *      so whether the `agent/created` guard sees it is a question about
 *      DSH's own publication path, not something this project can assume. If a
 *      resumed child were NOT counted, a host at the cap could be grown past 30
 *      by resuming children, which is exactly the property CAP-01 claims.
 *
 *   2. CAP-09's oracle is about CONTENTION: "have many launches contend for the
 *      last available cost credit in the same instant. Exactly one reservation
 *      succeeds." No test fires concurrent admissions at a nearly-exhausted
 *      budget. The neighbouring defect that IS measured (`capacity.test.ts`,
 *      the `it.fails` case) is about TASK SLOTS over-admitting when K
 *      concurrent drains exceed the free slots — so the credit question is
 *      genuinely open, because the budget check lives INSIDE the single record
 *      update while the deficit check lives outside it.
 *
 * COST. One real child for arm 1 and none for arm 2 (arm 2 uses a scripted
 * launch port, exactly as `capacity.test.ts` does for its arithmetic arms). The
 * user's constraint forbids spawning children at scale, so nothing here is at
 * scale and nothing here is a load loop.
 *
 * WHAT THIS FILE DOES NOT CLAIM. It does not claim product reachability: both
 * arms reach the service through test-installed entry points, which is the
 * G-SEAM-31 limit stated in `capacity.test.ts`'s own header.
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
import { ChildAdmissionGate, ChildCapacityError, isSessionBackedChild, mountChildAdmissionGuard } from './capacity.ts'
import { WorkService } from './host.ts'

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

/** A model boundary that answers immediately. Nothing is held open. */
class ImmediateAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  override async resolveModel(provider: string, model: string): Promise<{ provider: string; id: string; name: string }> {
    return { provider, id: model, name: model }
  }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    if (options.signal?.aborted) throw new Error('aborted')
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'ok' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

/**
 * A model boundary that HOLDS every call open until released.
 *
 * WHY THE CAP-13 ARM NEEDS THIS. With an immediately-answering adapter a child
 * finishes its turn and leaves the registry before the next one is created, so
 * "two children resident" is a race rather than a fact and the occupancy
 * assertion measures the race instead of the limit. This adapter makes residency
 * deterministic, which is the same instrument `capacity.test.ts` uses for its
 * own occupancy arms.
 */
class HoldingAdapter extends LlmAdapter {
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
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'ok' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

interface ProbeRig {
  readonly ctx: Context
  readonly root: Agent
  readonly adapter: ImmediateAdapter
}

/** Boot the real loop, the real spawn provider, real persistence and storage. */
async function probeRig(label: string): Promise<ProbeRig> {
  const sessionRoot = mkdtempSync(join(tmpdir(), `dsh-v8-${label}-sessions-`))
  const storeRoot = mkdtempSync(join(tmpdir(), `dsh-v8-${label}-store-`))
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  const persistence = await ctx.plugin(JsonlSessionPersistence, { root: sessionRoot })
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(SubagentRuntime, { maxActiveSubagents: 8, maxDepth: 1 })
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
  const adapter = new ImmediateAdapter()
  ctx.llm.registerAdapter(['mock'], adapter)
  const root = await ctx.agentLoop.create(SessionId(`v8-${label}-root`), { provider: 'mock', model: 'mock' })
  cleanups.push(async () => {
    await ctx.subagents.drainContinuableDescendants([root])
    await persistence.dispose()
    await ctx.fiber.dispose()
    rmSync(sessionRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    rmSync(storeRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  })
  return { ctx, root, adapter }
}

describe('V8/CAP-02: the COLD RESUME path draws on the same host quota', () => {
  it('a resumed child is classified as a child and TAKES a host slot', async () => {
    // THE QUESTION. The four paths `capacity.test.ts` measures all reach
    // `AgentRegistry.create`. A resume reaches `AgentRegistry.resume` and
    // publishes with source `'resume'`, so the guard's listener fires only if
    // DSH's resume path also dispatches `agent/created`. If it does not, a
    // resumed child is invisible to the ledger and the host can be grown past
    // the cap by resuming children.
    //
    // MEASURED IN BOTH DIRECTIONS, because either answer is a result:
    //   - the ledger MOVES on resume -> the path is covered;
    //   - the ledger does NOT move -> a real hole in CAP-01/CAP-02, recorded as
    //     such rather than smoothed over.
    const r = await probeRig('resume')
    const gate = new ChildAdmissionGate(3)
    mountChildAdmissionGuard(r.ctx, { gate, maxDepth: 1 })

    // A REAL continuable child, so the thing being resumed is a genuine child
    // with DSH's own child header (`origin: 'subagent'`, `delegationDepth: 1`).
    await r.ctx.subagents.startContinuable({
      provider: 'spawn',
      label: 'v8-resume-child',
      childId: SessionId('v8-resume-child'),
      request: { parent: r.root, prompt: [{ type: 'text', text: 'first turn' }], maxDepth: 1 },
      signal: new AbortController().signal,
    })
    const first = r.ctx.agents.get(SessionId('v8-resume-child'))
    expect(first, 'the child materialized').toBeDefined()
    expect(isSessionBackedChild(first!), 'and is classified as a child').toBe(true)
    expect(gate.hasChild('v8-resume-child'), 'it took a slot').toBe(true)
    expect(gate.occupied).toBe(1)

    // Dispose it so the id is free for a cold resume (write ownership is
    // exclusive), and confirm the slot was given back on disposal.
    await r.ctx.subagents.drainContinuableDescendants([r.root])
    expect(r.ctx.agents.get(SessionId('v8-resume-child')), 'the child is gone').toBeUndefined()
    expect(gate.hasChild('v8-resume-child'), 'its slot was released').toBe(false)
    expect(gate.occupied).toBe(0)

    const persistence = r.ctx.get('sessionPersistence')
    await persistence?.flush()

    // THE COLD RESUME, through the real loop.
    const resumed = await r.ctx.agentLoop.resume(r.ctx, { resumeSessionId: SessionId('v8-resume-child') })
    const agent = resumed.agent
    expect(r.ctx.agents.get(SessionId('v8-resume-child')), 'the resumed agent is live').toBeDefined()

    // THE MEASUREMENT.
    expect(isSessionBackedChild(agent), 'a resumed child is still classified as a child').toBe(true)
    expect(gate.hasChild('v8-resume-child'), 'THE LEDGER MOVED ON RESUME: it took a host slot').toBe(true)
    expect(gate.snapshot().liveChildren, 'exactly one executor').toBe(1)
    expect(gate.occupied).toBe(1)
    // And the durable header is the authority, not a runtime field: the resumed
    // agent carries DSH's own child metadata read back from persistence.
    expect(agent.session.header.origin, 'origin is persisted, not runtime-only').toBe('subagent')
  }, 60_000)
})

describe('V8/CAP-09: the last cost credit is reserved atomically under contention', () => {
  it('three concurrent launches against ONE free credit admit exactly one', async () => {
    // THE QUESTION. The budget check (`committed + reservedCost > limit`) lives
    // INSIDE the single record `update`; the TARGET/deficit check lives OUTSIDE
    // it, in `runDrain`, and the `it.fails` case in `capacity.test.ts` measures
    // that the outside check over-admits when K concurrent drains exceed the
    // free slots. Whether the INSIDE check has the same hole is a different
    // question about a different check, and it is the one CAP-09 asks.
    //
    // CONSTRUCTION: childCeiling is 100 (ceiling 110 minus a 10 root reserve).
    // One task is admitted at reservedCost 99, leaving exactly ONE credit. Three
    // drains then contend for it in the same instant, each asking for 1.
    // Correct answer: exactly ONE accepted, and `budget.reserved` at 100.
    const r = await probeRig('credit')
    const service = new WorkService(r.ctx, {
      targetChildren: 3,
      maxDepth: 1,
      budgetCeiling: 110,
      currency: 'USD',
      priceVersion: 'v8-credit',
      subagentProvider: 'spawn',
    })
    await service.open()
    cleanups.push(async () => { await service.close() })

    const runId = 'run-v8-credit'
    await service.createRun({ runId, root: r.root, authorizationRef: 'auth', targetChildren: 3, rootReserve: 10 })
    service.setReadyTasks(runId, 10)
    // A scripted port: the credit arithmetic is under test, not the launch, and
    // this keeps the arm at ZERO real children.
    service.setLaunchPort({ async launch(request): Promise<{ childId: string }> { return { childId: request.childId } } })

    const report = service.budget(runId)
    expect(report.childCeiling, 'the child ceiling is ceiling minus the root reserve').toBe(100)

    // Take all but ONE credit.
    const seed = await service.drain(
      runId,
      [{ taskId: 'task-seed', childId: 'child-seed', prompt: 'seed', reservedCost: 99 }],
      new AbortController().signal,
    )
    expect(seed[0]?.accepted, 'the 99-credit seed is admitted').toBe(true)
    expect(service.budget(runId).childCommitted ?? service.getRun(runId)!.budget.reserved).toBe(99)

    // THREE concurrent launches, ONE free credit.
    const signal = new AbortController().signal
    const contenders = [70, 71, 72].map(n => ({
      taskId: `task-${String(n)}`, childId: `child-${String(n)}`, prompt: `contend ${String(n)}`, reservedCost: 1,
    }))
    const [a, b, c] = await Promise.all([
      service.drain(runId, [contenders[0]!], signal),
      service.drain(runId, [contenders[1]!], signal),
      service.drain(runId, [contenders[2]!], signal),
    ])
    const admitted = [...a, ...b, ...c].filter(outcome => outcome.accepted)
    const refused = [...a, ...b, ...c].filter(outcome => !outcome.accepted)

    // THE ORACLE. Exactly one reservation succeeds.
    expect(admitted, 'exactly ONE of the three contenders gets the last credit').toHaveLength(1)

    // THE LEDGER DID NOT OVERSPEND.
    const record = service.getRun(runId)!
    expect(record.budget.reserved, 'the ledger is exactly at the child ceiling, not past it').toBe(100)
    expect(record.budget.reserved, 'never above the ceiling').toBeLessThanOrEqual(record.budget.ceiling)
    // A refusal must not have left a task or a slot behind.
    const held = Object.values(record.tasks).length
    expect(held, 'two contenders left no task behind').toBe(2)
    // The refusals carry a reason a reader can act on, and it names the budget.
    for (const outcome of refused) {
      expect(String(outcome.reason), 'the refusal names the budget, not a slot').toMatch(/budget headroom|budget/i)
    }

    // Recorded verbatim so a reader can see the numbers rather than the verdict.
    console.log(`V8/CAP-09 measured: accepted=${String(admitted.length)} refused=${String(refused.length)} `
      + `reserved=${String(record.budget.reserved)} childCeiling=${String(report.childCeiling)} `
      + `reasons=${JSON.stringify(refused.map(o => o.reason))}`)
  }, 60_000)
})

describe('V8/CAP-10: a completion storm must not overshoot the target', () => {
  // FIXED, and the marker was turned RED first. This case was an `it.fails` when
  // it was written, because the property below is the one CAP-10's oracle states
  // ("no overshoot past the target") and the product did not satisfy it. The fix
  // (`host.ts`: `tryReserveAdmission`) made it fail the `it.fails` contract —
  // "Expect test to fail" — which is the project's own signal that a marker
  // cannot be left behind silently. It is now a plain assertion of the correct
  // property, and the BEFORE numbers are archived under
  // `qualification/results/R3-f5-admission/`.
  it('three concurrent drains against TWO free slots admit exactly two', async () => {
    // THE PROPERTY. Two freed slots admit exactly two, never three, and held
    // reservations never exceed the target.
    //
    // WHY IT IS HERE AS WELL AS IN capacity.test.ts. That file's version drives
    // the same defect through THREE REAL CHILDREN. This one reproduces the
    // arithmetic with a scripted launch port and ZERO children, so the property
    // is measurable without spending the machine on agents, and so a reader can
    // see that the behaviour is the service's own rather than anything the
    // provider or the subagent runtime does.
    //
    // THE DEFECT THIS MEASURED, and where the fix now lives. `drain` used to be:
    //     const inFlight = this.pendingDrain.get(runId)
    //     if (inFlight !== undefined) await inFlight
    //     const task = this.runDrain(runId, requests, signal)   // <-- no re-check
    // K concurrent callers awaited the SAME in-flight drain; when it settled they
    // all resumed in one microtask batch and each started its OWN `runDrain`. The
    // target check was OUTSIDE the record update and read a record none of them
    // had written yet, so all K observed the same deficit and all K admitted.
    //
    // The fix is NOT in the coalescer. It is that the target check now lives
    // INSIDE one storage-domain `update` (`tryReserveAdmission`), where the
    // domain's per-domain write chain serializes it against every other write to
    // this run. That is the same place the BUDGET check already was, which is why
    // CAP-09 never had this hole. See `f5-admission.test.ts` for the arm that
    // proves the invariant holds even with the coalescer defeated.
    const r = await probeRig('storm')
    const service = new WorkService(r.ctx, {
      targetChildren: 3,
      maxDepth: 1,
      budgetCeiling: 10_000,
      currency: 'USD',
      priceVersion: 'v8-storm',
      subagentProvider: 'spawn',
    })
    await service.open()
    cleanups.push(async () => { await service.close() })

    const runId = 'run-v8-storm'
    await service.createRun({ runId, root: r.root, authorizationRef: 'auth', targetChildren: 3 })
    service.setReadyTasks(runId, 20)
    // ZERO real children: the port is the seam the real port plugs into, and the
    // behaviour under test is the service's arithmetic, above the port.
    service.setLaunchPort({ async launch(request): Promise<{ childId: string }> { return { childId: request.childId } } })

    const signal = new AbortController().signal
    const req = (n: number): { taskId: string; childId: string; prompt: string; reservedCost: number } =>
      ({ taskId: `task-${String(n)}`, childId: `child-${String(n)}`, prompt: `work ${String(n)}`, reservedCost: 1 })

    const first = await service.drain(runId, [req(0), req(1), req(2)], signal)
    expect(first.filter(o => o.accepted)).toHaveLength(3)

    // Free exactly TWO slots, leaving one task holding its own.
    for (const n of [0, 1]) {
      await service.transition({ runId, taskId: `task-${String(n)}`, to: 'settling' })
      await service.transition({ runId, taskId: `task-${String(n)}`, to: 'confirmed', spentCost: 0 })
    }
    expect(service.counts(runId).capacityDeficit, 'exactly two slots are free').toBe(2)
    expect(service.counts(runId).heldReservations, 'one task still holds its slot').toBe(1)

    // THREE concurrent refills against TWO free slots. The correct answer is 2.
    const [a, b, c] = await Promise.all([
      service.drain(runId, [req(70)], signal),
      service.drain(runId, [req(71)], signal),
      service.drain(runId, [req(72)], signal),
    ])
    const admitted = [...a, ...b, ...c].filter(o => o.accepted)
    const record = service.getRun(runId)!
    const held = Object.values(record.tasks).filter(t => t.state !== 'confirmed').length

    console.log(`V8/CAP-10 measured: freedSlots=2 concurrentRequests=3 `
      + `admitted=${String(admitted.length)} heldAgainstTarget3=${String(held)} `
      + `acceptedIds=${JSON.stringify(admitted.map(o => o.childId))} `
      + `deficitAfter=${String(service.counts(runId).capacityDeficit)}`)

    // THE PROPERTY THE ORACLE STATES.
    expect(admitted, 'two freed slots admit exactly two, never three').toHaveLength(2)
    expect(held, 'held tasks never exceed the target').toBeLessThanOrEqual(3)
    // The authoritative occupancy AGREES with the target check that refused the
    // third, rather than reporting a healthy full wave.
    const counts = service.counts(runId)
    expect(counts.heldReservations, 'authoritative occupancy is exactly the target').toBe(3)
    expect(counts.targetOvershoot, 'and nothing was over-admitted').toBe(0)
    expect(counts.capacityDeficit, 'the target is full, not short').toBe(0)
    // The refused request is reported with a reason, and the refusal consumed no
    // slot and no credit: three reservations of 1 are outstanding for three tasks.
    expect(record.budget.reserved, 'the ledger holds exactly the three live reservations').toBe(3)
  }, 60_000)
})

describe('V8/CAP-13: the depth ceiling and the host cap name themselves separately', () => {
  it('a depth refusal and a capacity refusal are DISTINGUISHABLE, and the family pool is a third thing', async () => {
    // CAP-13's oracle: "the depth ceiling and the per-run/global provider limits
    // each take effect independently, and a family-scoped pool is not reported
    // as the global limit. Each refusal names which limit fired."
    //
    // THE THREE LIMITS, and why conflating them is the failure mode:
    //   1. the DEPTH ceiling  -> `ChildCapacityError` code `DEPTH_CEILING_EXCEEDED`
    //   2. the HOST cap of 30 -> `ChildCapacityError` code `HOST_CAPACITY_REACHED`
    //   3. the upstream PER-FAMILY pool -> `SubagentError` `ACTIVATION_LIMIT_REACHED`,
    //      which is NOT this project's cap and is keyed by ROOT
    //      (`continuation-activation.ts:180`), so two roots get two pools.
    //
    // LIMIT 3 IS THE ONE THAT MUST NOT BE READ AS THE GLOBAL LIMIT. In the
    // composed profile both are 10, so a refusal at 11 there is over-determined
    // and cannot tell a reader which one fired. This arm separates them by
    // setting the pool to 2 and the host gate to 30: a refusal at the 3rd child
    // can then only be the pool, and its message is recorded verbatim.
    const r = await probeRig('limits')
    // The pool is the runtime's, and it is the one this rig sets LOW -- but not
    // so low that it masks the depth check. MEASURED: with the pool at 2 and two
    // children resident, a grandchild attempt is refused by the POOL before the
    // depth check is ever reached, so the depth limit cannot be observed at all.
    // The pool is therefore 4 here: two resident children leave room for the
    // grandchild, so a refusal at that point can only be the DEPTH ceiling. That
    // ordering fact is itself part of CAP-13's answer, because it shows the two
    // limits are applied at different stages rather than one standing in for the
    // other.
    const poolLimited = new Context()
    await mountAgentLoopTestDependencies(poolLimited)
    const sessionRoot = mkdtempSync(join(tmpdir(), 'dsh-v8-limits-sessions-'))
    const persistence = await poolLimited.plugin(JsonlSessionPersistence, { root: sessionRoot })
    await poolLimited.plugin(AgentLoop, { agents: [] })
    await poolLimited.plugin(SubagentRuntime, { maxActiveSubagents: 4, maxDepth: 1 })
    await poolLimited.plugin(SubagentSpawn, { providerName: 'spawn' })
    await poolLimited.plugin(class extends SessionQueryEngine {
      override searchSessions(): Promise<never> { return Promise.reject(new Error('not configured')) }
      override searchEvents(): Promise<never> { return Promise.reject(new Error('not configured')) }
    })
    const adapter = new HoldingAdapter()
    poolLimited.llm.registerAdapter(['mock'], adapter)
    const poolRoot = await poolLimited.agentLoop.create(SessionId('v8-limits-root'), { provider: 'mock', model: 'mock' })
    cleanups.push(async () => {
      adapter.openAll()
      await poolLimited.subagents.drainContinuableDescendants([poolRoot])
      await persistence.dispose()
      await poolLimited.fiber.dispose()
      rmSync(sessionRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    })

    // The host gate is at the DEPLOYMENT constant, deliberately far above the pool.
    const hostGate = new ChildAdmissionGate(30)
    mountChildAdmissionGuard(poolLimited, { gate: hostGate, maxDepth: 1 })

    const start = (id: string, depth: number, parent: Agent): Promise<unknown> =>
      poolLimited.subagents.startContinuable({
        provider: 'spawn',
        label: id,
        childId: SessionId(id),
        request: { parent, prompt: [{ type: 'text', text: id }], maxDepth: depth },
        signal: new AbortController().signal,
      })

    // TWO children resident. The host gate is at 2 of 30; the pool is at 2 of 4.
    await start('v8-limit-a', 1, poolRoot)
    await start('v8-limit-b', 1, poolRoot)
    expect(hostGate.occupied, 'the host gate saw two of its thirty').toBe(2)
    expect(hostGate.snapshot().refusals.HOST_CAPACITY_REACHED, 'and has refused nothing').toBe(0)

    // ---- THE DEPTH REFUSAL, taken FIRST while the pool still has room. -------
    // A grandchild at depth 2 against the ceiling of 1 is refused by THIS
    // project's gate. The order matters: with the pool full, the pool refuses
    // first and the depth check is never reached (MEASURED, and recorded below).
    const childA = poolLimited.agents.get(SessionId('v8-limit-a'))
    expect(childA, 'the first child is live').toBeDefined()
    let depthError: unknown
    try {
      await start('v8-grandchild', 99, childA!)
    } catch (error) {
      depthError = error
    }
    expect(depthError, 'the grandchild is refused').toBeDefined()
    const depthMessage = depthError instanceof Error ? depthError.message : String(depthError)
    const depthCause = depthError instanceof Error
      ? (depthError as { cause?: unknown }).cause
      : undefined
    // RECORDED RATHER THAN ASSUMED. This arm first asserted that the error
    // reaching the caller would be WRAPPED by the subagent runtime, so the
    // `instanceof` test was written to fail and reveal the wrapping. MEASURED:
    // it is NOT wrapped — `ChildCapacityError` arrives at the caller intact,
    // with its own `name` and message. The wrapping hypothesis was wrong and is
    // recorded here rather than deleted, because the assertion below is written
    // against the measured shape and a reader should see which shape that is.
    console.log(`V8/CAP-13 depth refusal: errorName=${String(depthError instanceof Error ? depthError.name : typeof depthError)} `
      + `wrappedByRuntime=${String(!(depthError instanceof ChildCapacityError))} `
      + `causeName=${String(depthCause instanceof Error ? depthCause.name : typeof depthCause)} `
      + `causeCode=${String((depthCause as { code?: string } | undefined)?.code ?? 'none')} `
      + `message=${JSON.stringify(depthMessage)}`)
    expect(depthError instanceof ChildCapacityError, 'the gate\'s own type reaches the caller UNWRAPPED').toBe(true)
    expect((depthError as ChildCapacityError).code, 'with the DEPTH code, not the capacity code')
      .toBe('DEPTH_CEILING_EXCEEDED')
    expect(depthMessage, 'the refusal names the DEPLOYMENT CEILING, which is the limit that fired')
      .toMatch(/deployment ceiling is 1|depth 2 exceeds/)
    expect(depthMessage, 'and it does NOT claim the host hard capacity').not.toMatch(/hard capacity is 30/i)
    expect(hostGate.snapshot().refusals.DEPTH_CEILING_EXCEEDED, 'the depth refusal was counted as depth').toBe(1)
    expect(hostGate.snapshot().refusals.HOST_CAPACITY_REACHED, 'and NOT as a capacity refusal').toBe(0)
    // A depth refusal costs no slot: a refused grandchild must not permanently
    // consume capacity.
    expect(hostGate.occupied, 'the depth refusal left the ledger at two').toBe(2)

    // ---- THE FAMILY POOL REFUSAL, taken LAST so the pool is the binding one. --
    await start('v8-limit-c', 1, poolRoot)
    await start('v8-limit-d', 1, poolRoot)
    expect(hostGate.occupied, 'four resident children, all counted by the host gate').toBe(4)
    expect(hostGate.snapshot().refusals.HOST_CAPACITY_REACHED, 'still nowhere near the host cap of 30').toBe(0)

    // THE FIFTH CHILD is refused by the POOL, not by the host cap.
    let poolError: string | null = null
    try {
      await start('v8-limit-e', 1, poolRoot)
    } catch (error) {
      poolError = error instanceof Error ? error.message : String(error)
    }
    expect(poolError, 'the family pool refused the fifth child').not.toBeNull()
    // THE ORACLE: the refusal must NOT read as the global limit, and the host
    // ledger must still show room. Both halves are asserted, because a message
    // test alone would pass on a host that had also refused.
    expect(poolError!, 'the pool refusal names the ACTIVE CHILD LIMIT, not the host cap')
      .toMatch(/active child limit/i)
    expect(poolError!, 'and it does NOT claim the host hard capacity').not.toMatch(/hard capacity is 30/i)
    expect(hostGate.occupied, 'the host gate never refused: it holds 4 of 30').toBe(4)
    expect(hostGate.snapshot().refusals.HOST_CAPACITY_REACHED, 'the host gate has still refused nothing').toBe(0)

    console.log(`V8/CAP-13 measured: poolRefusal=${JSON.stringify(poolError)} `
      + `hostRefusals=${JSON.stringify(hostGate.snapshot().refusals)} hostOccupied=${String(hostGate.occupied)} `
      + `poolLimit=4 hostLimit=${String(hostGate.limit)}`)
    void r
  }, 60_000)
})


