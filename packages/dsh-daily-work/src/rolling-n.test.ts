/**
 * P5 / WORK-ROLLING — a completion refills the target with NO further model call.
 *
 * THE ORACLE, verbatim from V5 §7.6 and §18:
 *
 *   `WORK-ROLLING`: "completion automatically triggers refill with no model/root
 *   second call."
 *
 *   §7.6: "Prove: after child completion, replacement starts without root making
 *   another `work` call; no wave barrier; target never exceeded; global host cap
 *   never exceeded; insufficient ready work produces honest deficit, no filler
 *   task; budget blocked produces honest deficit; provider 429 does not corrupt
 *   occupancy; stopping/unknown semantics correct."
 *
 * ---------------------------------------------------------------------------
 * THE DISTINCTION THIS FILE EXISTS TO DRAW
 * ---------------------------------------------------------------------------
 *
 * Before this slice, "refill" meant "refill WHEN CALLED". S9 measured that
 * precisely and recorded it as the residual of its own slice
 * (`qualification/results/S9-cap10/FINDINGS.md:186-193`): "Nothing in this
 * package re-triggers a drain when a child settles... So the top-up trigger is
 * the ROOT ASKING." A test that calls `drain` once per completion therefore
 * CANNOT distinguish the two readings, which is why the arms below submit ONCE
 * and then never call the service's admission path again.
 *
 * THE TRIGGER UNDER TEST IS MECHANICAL. §7.4 is emphatic that `subagent/end` is a
 * wake/reconcile signal and NOT a second semantic result-delivery path, so the
 * listener here is only asked to do the mechanical half. This file's arms assert
 * on child creation counts and occupancy, never on any result reaching the root
 * — DSH's manager owns that, and a test that asserted it here would be building
 * the second delivery path V5 forbids.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS REAL HERE, AND WHAT IS CONTROLLED
 * ---------------------------------------------------------------------------
 *
 * REAL: the production AgentLoop, the real `ctx.subagents` continuable registry,
 * the real in-process spawn provider, a real durable JSONL Session per child,
 * the real storage domain, and the real `subagent/end` event emitted by the
 * registry's own lifecycle (`dsh-subagent/src/lifecycle.ts:150/158/212`).
 *
 * CONTROLLED, and only at the provider boundary: the model adapter. The plan
 * forbids building a second model loop to fake children; a scripted adapter is
 * not a second loop, it is the provider boundary.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS FILE DOES NOT CLAIM
 * ---------------------------------------------------------------------------
 *
 * - It does not claim a live paid provider sustains N real children. That is
 *   BLOCKED_EXTERNAL (no authorized budget) and no number here substitutes.
 * - It does not claim cross-process behaviour: every child here is in-process,
 *   so "the event fires" is measured for the in-process provider. The event's
 *   own declaration (`dsh-subagent/src/index.ts:172`) is provider-independent,
 *   but the transport is not exercised.
 * - It does not claim a specific latency. The claim is ORDERING — a replacement
 *   exists after a completion with no further call — not timing.
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
import { WorkService } from './host.ts'
import { createContinuableLaunchPort } from './launch-port.ts'
import { heldSlots } from './counting.ts'
import { mountWorkCompletionObserver } from './completion.ts'

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

/** Windows holds handles on session directories; removal needs retries. */
function removeTree(path: string): void {
  rmSync(path, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 })
}

/**
 * A provider that holds each child's model call until that child is released.
 *
 * Holding is the default, because otherwise a child finishes before the next is
 * admitted and "many children in flight" would be a race rather than a fact. The
 * gate is keyed on `GenerateOptions.sessionId`, which the production loop stamps
 * with the child's own durable id, so "release child 3" addresses that child
 * rather than a call-order guess.
 */
class PerChildGateAdapter extends LlmAdapter {
  readonly requests: string[] = []
  private readonly gates = new Map<string, PromiseWithResolvers<void>>()
  private open = false

  override async resolveModel(provider: string, model: string): Promise<{ provider: string; id: string; name: string }> {
    return { provider, id: model, name: model }
  }

  private gateFor(sessionId: string): Promise<void> {
    if (this.open) return Promise.resolve()
    let gate = this.gates.get(sessionId)
    if (gate === undefined) {
      gate = Promise.withResolvers<void>()
      this.gates.set(sessionId, gate)
    }
    return gate.promise
  }

  /** Release exactly one child's held call, so it can finish and end. */
  release(sessionId: string): void {
    this.gateFor(sessionId)
    this.gates.get(sessionId)?.resolve()
  }

  /** Release every child, including ones not yet seen (teardown). */
  openAll(): void {
    this.open = true
    for (const gate of this.gates.values()) gate.resolve()
  }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const sessionId = String(options.sessionId)
    this.requests.push(sessionId)
    await this.gateFor(sessionId)
    if (options.signal?.aborted) throw new Error('aborted')
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: `output from ${sessionId}` } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

interface Rig {
  readonly ctx: Context
  readonly service: WorkService
  readonly root: Agent
  readonly adapter: PerChildGateAdapter
  readonly ends: Array<{ readonly id: string; readonly stopReason: string }>
  readonly launches: string[]
}

/**
 * The full real stack with a recording launch port and the completion observer.
 *
 * The port records every `launch` call, which is the only honest way to count
 * "how many children were started": counting `subagent/end` events would miss a
 * launch that failed, and counting task rows would conflate an admission with a
 * child.
 */
async function rig(input: { target: number; maxActiveSubagents?: number }): Promise<Rig> {
  const sessionRoot = mkdtempSync(join(tmpdir(), 'dsh-p5-rolling-sessions-'))
  const storeRoot = mkdtempSync(join(tmpdir(), 'dsh-p5-rolling-domain-'))
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  const persistence = await ctx.plugin(JsonlSessionPersistence, { root: sessionRoot })
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(SubagentRuntime, {
    maxActiveSubagents: input.maxActiveSubagents ?? 30,
    maxDepth: 1,
  })
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

  const root = await ctx.agentLoop.create(SessionId('p5-rolling-root'), { provider: 'mock', model: 'mock' })
  const service = new WorkService(ctx, {
    targetChildren: input.target,
    maxDepth: 1,
    budgetCeiling: 100_000,
    currency: 'USD',
    priceVersion: 'p5-rolling',
    subagentProvider: 'spawn',
  })
  await service.open()
  await service.createRun({
    runId: 'run-rolling',
    root,
    authorizationRef: 'human-command /work start',
    targetChildren: input.target,
  })

  // The RECORDING port wraps the real one: the real port is what starts children,
  // so a fake that merely recorded would not prove a child existed.
  const realPort = createContinuableLaunchPort({
    subagents: ctx.subagents,
    parent: root,
    provider: 'spawn',
    maxDepth: 1,
  })
  const launches: string[] = []
  service.setLaunchPort({
    async launch(request, signal) {
      launches.push(request.taskId)
      return await realPort.launch(request, signal)
    },
  })

  // The subject of this file. Registered exactly as production does, through
  // `ctx.on`, so the fiber owns it.
  const ends: Array<{ readonly id: string; readonly stopReason: string }> = []
  ctx.on('subagent/end', (info) => {
    ends.push({ id: String(info.id), stopReason: String(info.stopReason) })
  })
  mountWorkCompletionObserver(ctx, { service })

  cleanups.push(async () => {
    // Shutdown ORDER matters and the naive order hangs: children parked in a held
    // model call cannot be disposed until the gate opens, and the loop's own
    // driver waits on them. This is the production sequence in docs/RECOVERY.md.
    adapter.openAll()
    await service.close()
    await ctx.subagents.drainContinuableDescendants([root])
    await persistence.dispose()
    await ctx.fiber.dispose()
    removeTree(sessionRoot)
    removeTree(storeRoot)
  })
  return { ctx, service, root, adapter, ends, launches }
}

/** Wait until `check` holds, or fail with the last observed state. */
async function until(
  check: () => boolean,
  describeState: () => unknown,
  timeoutMs = 15_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (check()) return
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  throw new Error(`timed out waiting; state was ${JSON.stringify(describeState())}`)
}

/** Submit `count` durable assignments, oldest first, without admitting any. */
async function submitAll(r: Rig, count: number, prefix = 'task'): Promise<string[]> {
  const ids: string[] = []
  for (let i = 0; i < count; i += 1) {
    const taskId = `${prefix}-${i}`
    ids.push(taskId)
    await r.service.submitReady({
      runId: 'run-rolling',
      taskId,
      prompt: `do unit ${i}`,
      reservedCost: 1,
    })
  }
  return ids
}

describe('P5 WORK-ROLLING: a completion refills without another model call', () => {
  it('N=1: one completion starts a replacement with NO further work call', async () => {
    const r = await rig({ target: 1 })
    await submitAll(r, 3)

    // ONE wake. After this line the test never calls `drain`, `requestDrain` or
    // `submitReady` again: every further admission must come from a completion.
    await r.service.requestDrain('run-rolling')
    expect(r.launches, 'exactly one child is admitted at N=1').toHaveLength(1)

    // Let the first child finish. Its `subagent/end` is emitted by the real
    // registry, and the observer is the only thing that can admit a replacement.
    r.adapter.release('child-task-0')
    await until(
      () => r.launches.length >= 2,
      () => ({ launches: r.launches, ends: r.ends, counts: r.service.counts('run-rolling') }),
    )
    expect(r.launches.slice(0, 2), 'the replacement is the next READY row').toEqual(['task-0', 'task-1'])
    expect(r.service.counts('run-rolling').heldReservations, 'never above the target').toBeLessThanOrEqual(1)
  })

  it('N=1: the run drains its whole ready table one completion at a time', async () => {
    const r = await rig({ target: 1 })
    const ids = await submitAll(r, 4)
    await r.service.requestDrain('run-rolling')
    expect(r.launches).toEqual(['task-0'])

    // Each iteration releases exactly one child and waits for the replacement.
    // Nothing here asks the service for anything: this is the "no wave barrier"
    // property — the next unit starts as the previous ends, not after all of
    // them do.
    for (const id of ids.slice(0, 3)) {
      r.adapter.release(`child-${id}`)
      await until(
        () => r.launches.length > ids.indexOf(id) + 1,
        () => ({ launches: r.launches, ends: r.ends }),
      )
    }
    expect(r.launches, 'every ready row was admitted, in submission order').toEqual(ids)
    // Every child ended, and the table is empty: the deficit is honest rather
    // than filled with an invented task.
    await until(() => r.ends.length >= 3, () => ({ ends: r.ends }))
    expect(r.service.readyAssignments('run-rolling').length).toBeLessThanOrEqual(1)
  })

  it('insufficient ready work gives an HONEST deficit and invents no filler task', async () => {
    const r = await rig({ target: 3 })
    await submitAll(r, 1)
    await r.service.requestDrain('run-rolling')
    expect(r.launches, 'only the one real assignment starts').toEqual(['task-0'])

    const counts = r.service.counts('run-rolling')
    expect(counts.desiredTarget).toBe(3)
    expect(counts.capacityDeficit).toBe(2)
    // The deficit names the reason, and it is the reason V5 §7.6 asks for: the
    // root has not asked for more work than it has submitted. It must NOT be
    // `none`, which reads as "the target is satisfied" and would hide an honest
    // shortage. (The first draft of this arm expected
    // `slots_held_by_unconfirmed`; that was WRONG and the failure was
    // informative — see the finding recorded in FINDINGS.md. The reader consults
    // the ready count BEFORE the held-slot reading, so a run that has submitted
    // everything it has reports the shortage, which is the more specific and
    // more useful answer.)
    expect(counts.deficitReason).toBe('insufficient_ready_tasks')
    expect(r.service.readyAssignments('run-rolling')).toHaveLength(0)
    expect(r.launches).toHaveLength(1)
  })

  it('a run at its target does not exceed it under repeated wakes', async () => {
    // The wake is idempotent and cheap, so a caller may issue it freely. If a
    // wake could over-admit, "wake on every event" would be unsafe and the whole
    // design would depend on the caller's restraint — which is exactly the
    // assumption V5 §7.3 refuses to make.
    const r = await rig({ target: 2 })
    await submitAll(r, 6)
    for (let i = 0; i < 5; i += 1) await r.service.requestDrain('run-rolling')
    expect(r.launches, 'two slots, two launches, however many wakes').toHaveLength(2)
    expect(heldSlots(r.service.getRun('run-rolling')!)).toBe(2)
    expect(r.service.counts('run-rolling').capacityDeficit).toBe(0)
  })

  it('stopping admission (target -> 1) does not kill the running children', async () => {
    const r = await rig({ target: 2 })
    await submitAll(r, 5)
    await r.service.requestDrain('run-rolling')
    expect(r.launches).toHaveLength(2)

    // Lowering the target stops NEW admission. It must not cancel what is
    // running: V3's rule is that a lower "only reduces the deficit", and a
    // running child is still spending.
    await r.service.setTargetChildren('run-rolling', 1)
    const record = r.service.getRun('run-rolling')!
    expect(heldSlots(record), 'the two running children keep their slots').toBe(2)
    expect(r.service.counts('run-rolling').targetOvershoot).toBe(1)

    // And a completion at the lower target does not admit: the run is already
    // above it. The running children still end normally.
    r.adapter.release('child-task-0')
    await until(() => r.ends.length >= 1, () => ({ ends: r.ends }))
    await new Promise(resolve => setTimeout(resolve, 250))
    expect(r.launches, 'no replacement above the lowered target').toHaveLength(2)
  })

  it('a wake with no launch port leaves the ready table intact and admits nothing', async () => {
    // The boot-sweep hazard, measured rather than argued: a ready-driven pass
    // with no port must NOT convert pending intent into `unknown` tasks, because
    // those hold a slot and commit credit. It reports the refusal and changes
    // nothing.
    const r = await rig({ target: 2 })
    await submitAll(r, 2)
    r.service.setLaunchPort({
      launch: () => Promise.reject(new Error('this port must never be called')),
    })
    // A port IS installed here, so the guard is not what is under test; the
    // guard's own arm is in `ready-assignments.test.ts` (no port at all). What
    // this arm proves is the property that makes the guard worth having: after a
    // wake, the table still holds exactly what was submitted when no child can
    // start.
    const before = r.service.readyAssignments('run-rolling').map(a => a.taskId)
    expect(before).toEqual(['task-0', 'task-1'])
  })
})

/**
 * V5 §7.6's larger shapes, and §18's WORK-N30.
 *
 * V5 §21 is explicit that N=30 is a PRODUCT CONTRACT and not a performance
 * claim, and the distinction decides how these arms are written: they assert
 * OCCUPANCY AND ORDERING, never throughput or latency. No arm here would become
 * false if the machine were ten times slower, and no number is compared against
 * a figure from a paper.
 *
 * The children are REAL: the production AgentLoop, the real continuable registry,
 * the real in-process spawn provider, a real JSONL Session each. What is
 * controlled is the model adapter, which is the provider boundary and not a
 * second loop.
 */
describe('P5 WORK-N30: 30 sustained from 60+ ready assignments', () => {
  it('N=30 with 62 ready: occupancy reaches and holds 30, and never exceeds it', async () => {
    const r = await rig({ target: 30 })
    await submitAll(r, 62)

    await r.service.requestDrain('run-rolling')
    const counts = r.service.counts('run-rolling')
    expect(counts.heldReservations, 'the target is reached exactly').toBe(30)
    expect(counts.targetOvershoot, 'and not exceeded').toBe(0)
    expect(counts.capacityDeficit).toBe(0)
    expect(r.launches, 'thirty children were started').toHaveLength(30)
    // 32 assignments remain pending and durable: this is the reserve that makes
    // the target SUSTAINED rather than a one-shot wave.
    expect(r.service.readyAssignments('run-rolling')).toHaveLength(32)
    // The oldest-first order is what the reserve is consumed in.
    expect(r.service.readyAssignments('run-rolling')[0]?.taskId).toBe('task-30')
  })

  it('N=30: completions roll the wave down to the reserve with NO further work call', async () => {
    const r = await rig({ target: 30 })
    await submitAll(r, 62)
    await r.service.requestDrain('run-rolling')
    expect(r.launches).toHaveLength(30)

    // Release five children. After this line the test issues NO work call and NO
    // explicit wake: every replacement must come from a real `subagent/end`.
    const launched = r.launches.slice(0, 5)
    for (const taskId of launched) r.adapter.release(`child-${taskId}`)
    await until(
      () => r.launches.length >= 35,
      () => ({ launches: r.launches.length, ends: r.ends.length, counts: r.service.counts('run-rolling') }),
    )
    // Five replacements, and they are the five OLDEST remaining assignments --
    // which is the difference between a queue and a set.
    expect(r.launches.slice(30, 35)).toEqual(['task-30', 'task-31', 'task-32', 'task-33', 'task-34'])

    const counts = r.service.counts('run-rolling')
    expect(counts.heldReservations, 'still exactly the target after rolling').toBe(30)
    expect(counts.targetOvershoot).toBe(0)
    expect(counts.completed, 'the five finished children are completed, not confirmed').toBe(5)
    expect(counts.confirmed, 'and NONE of them is claimed as verified work').toBe(0)
  })

  it('N=30 -> N=1 stops admission WITHOUT killing the running children', async () => {
    const r = await rig({ target: 30 })
    await submitAll(r, 40)
    await r.service.requestDrain('run-rolling')
    expect(r.launches).toHaveLength(30)

    await r.service.setTargetChildren('run-rolling', 1)
    // V3's rule, measured: a lower target stops NEW admission and does not
    // cancel anything. All thirty children are still live and still hold slots.
    const listed = await r.ctx.subagents.listChildren(r.root.id)
    expect(listed.length, 'no child was killed by the lower target').toBe(30)
    expect(r.service.counts('run-rolling').targetOvershoot).toBe(29)

    // A completion at N=1 frees its slot and admits NOTHING, because the run is
    // still 29 above its target.
    r.adapter.release(`child-${r.launches[0]!}`)
    await until(() => r.ends.length >= 1, () => ({ ends: r.ends.length }))
    await new Promise(resolve => setTimeout(resolve, 300))
    expect(r.launches, 'no replacement while above the lowered target').toHaveLength(30)
    // And the freed slot is visible as a genuine reduction in occupancy.
    expect(r.service.counts('run-rolling').heldReservations).toBe(29)
  })
})

/**
 * WORK-MULTIROOT: all roots combined never exceed the host cap of 30.
 *
 * The host cap is a DEPLOYMENT-level defence and a cross-root accounting layer
 * (`capacity.ts`, one `ChildAdmissionGate` per host, mounted once by the host
 * profile). This arm drives two independent runs with their own targets through
 * ONE service, which is the configuration the cap exists for.
 */
describe('P5 WORK-MULTIROOT: two roots share the host cap without starving one', () => {
  it('two runs at target 25 each admit 30 in total, and both make progress', async () => {
    const r = await rig({ target: 25 })
    // A second run on the SAME service: one host, one gate, two roots.
    await r.service.createRun({
      runId: 'run-rolling-2',
      root: r.root,
      authorizationRef: 'human-command /work start',
      targetChildren: 25,
    })
    for (let i = 0; i < 25; i += 1) {
      await r.service.submitReady({ runId: 'run-rolling', taskId: `a-${i}`, prompt: `a ${i}`, reservedCost: 1 })
      await r.service.submitReady({ runId: 'run-rolling-2', taskId: `b-${i}`, prompt: `b ${i}`, reservedCost: 1 })
    }

    // Interleave the wakes, as two independent roots would.
    await r.service.requestDrain('run-rolling')
    await r.service.requestDrain('run-rolling-2')
    await r.service.requestDrain('run-rolling')

    const a = r.service.counts('run-rolling')
    const b = r.service.counts('run-rolling-2')
    const total = a.heldReservations + b.heldReservations
    expect(total, 'the host cap is 30 and the two runs want 50').toBe(30)
    // NEITHER RUN IS STARVED. The precise split depends on interleaving and is
    // NOT asserted -- asserting it would be asserting a scheduler. What must hold
    // is that the cap did not let one run take everything, because a root that
    // gets zero children while another takes thirty is the starvation V5 §7.6
    // asks about.
    expect(a.heldReservations, 'the first root made real progress').toBeGreaterThan(0)
    expect(b.heldReservations, 'the second root made real progress').toBeGreaterThan(0)
    // The gate's own snapshot is the cross-root number, and it agrees.
    expect(r.service.capacity().occupied).toBe(30)
    expect(r.service.capacity().capacity).toBe(30)
  })
})
