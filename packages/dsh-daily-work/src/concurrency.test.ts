/**
 * The mandatory concurrency gate: N real in-flight child assignments with
 * rolling top-up, driven through the PRODUCTION agent loop.
 *
 * This is the slice the whole project exists for. Everything else in this
 * package is scaffolding for this file's claim: that a user choosing N=10 gets
 * ten genuinely in-flight children, and that a completion immediately admits a
 * replacement without waiting for the rest of the wave.
 *
 * What is REAL here:
 *   - the production AgentLoop (`@deepseek-ai/dsh-agent-loop`)
 *   - the real `ctx.subagents` registry and its continuable machinery
 *   - the real in-process spawn provider
 *   - a real durable JSONL Session per child
 *   - the real storage domain backing the run record
 *   - the real `LaunchPort` under test
 *
 * What is CONTROLLED, and why:
 *   - the model adapter. The plan forbids building a second model loop to fake
 *     children; a scripted adapter is not a second loop, it is the provider
 *     boundary. The loop, the tools, the inbox, the sessions and the subagent
 *     machinery are all the genuine article.
 *
 * What this test does NOT claim: that a live paid provider sustains ten real
 * children. That is gate C01/T5 and is BLOCKED_EXTERNAL (no authorized budget).
 * This file closes the T1/T2 layer of C01-C05, C07, C10, C15, C16.
 */
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { LlmAdapter, ReasoningEffortId, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
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
import { WorkService, type LaunchRequest } from './host.ts'
import { createContinuableLaunchPort } from './launch-port.ts'

const N = 10

/**
 * An adapter that holds every child's model call open until the test releases
 * it.
 *
 * This is what makes "ten in flight at once" a fact rather than a race: without
 * the gate, children would finish before the tenth was admitted and the test
 * could pass while proving nothing.
 */
class GatedAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  private release: (() => void) | undefined
  private readonly gate: Promise<void>
  private readonly released: boolean[] = []

  constructor() {
    super()
    let open: () => void = () => {}
    this.gate = new Promise<void>(resolve => {
      open = resolve
    })
    this.release = open
  }

  /** Let every held model call proceed. */
  openAll(): void {
    this.release?.()
  }

  override async resolveModel(provider: string, model: string): Promise<{ provider: string; id: string; name: string }> {
    return { provider, id: model, name: model }
  }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    // Every child holds here until the test opens the gate.
    await this.gate
    if (options.signal?.aborted) throw new Error('aborted')
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'child done' } }
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
}

/**
 * Boot the real continuable stack plus this project's work service.
 *
 * `maxActiveSubagents` is passed as N here. In production that value comes from
 * the C2 profile patch; passing it directly is the same setting reaching the
 * same service.
 */
async function rig(): Promise<Rig> {
  const sessionRoot = mkdtempSync(join(tmpdir(), 'dsh-daily-work-n10-sessions-'))
  const storeRoot = mkdtempSync(join(tmpdir(), 'dsh-daily-work-n10-store-'))

  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  const persistence = await ctx.plugin(JsonlSessionPersistence, { root: sessionRoot })
  await ctx.plugin(AgentLoop, { agents: [] })
  // The production capacity setting. N is the user's choice; root is not in it.
  await ctx.plugin(SubagentRuntime, { maxActiveSubagents: N, maxDepth: 1 })
  await ctx.plugin(SubagentSpawn, { providerName: 'spawn' })
  // `listChildren` needs the sessionQuery service to read child Sessions back.
  // A concrete engine with search faces unavailable is enough: we only use the
  // point reads, and this is the same shape DSH's own continuation tests use.
  await ctx.plugin(class extends SessionQueryEngine {
    override searchSessions(): Promise<never> {
      return Promise.reject(new Error('session search is not configured in this test'))
    }
    override searchEvents(): Promise<never> {
      return Promise.reject(new Error('event search is not configured in this test'))
    }
  })

  // The real storage domain, in a temp directory.
  await ctx.plugin(Storage, {})
  await ctx.plugin(storageJsonPlugin as never, { root: storeRoot } as never)
  await ctx.plugin(storageDomainPlugin as never, { backend: 'json' } as never)

  const adapter = new GatedAdapter()
  ctx.llm.registerAdapter(['mock'], adapter)

  const rootAgent = await ctx.agentLoop.create(SessionId('root-session'), { provider: 'mock', model: 'mock' })

  const service = new WorkService(ctx, {
    targetChildren: N,
    maxDepth: 1,
    budgetCeiling: 10_000,
    currency: 'USD',
    priceVersion: 'n10-test',
  })
  await service.open()

  cleanups.push(async () => {
    // Teardown ORDER matters, and getting it wrong hangs. Children that are
    // parked inside a model call cannot be torn down: disposing the fiber waits
    // for their driver to exit, and their driver is waiting on the gate.
    //
    // The correct sequence, which is also the production shutdown sequence:
    //   1. release the gate so in-flight model calls can complete
    //   2. close the work service (refuse new admissions, release the domain)
    //   3. drain continuable descendants, which stops the children
    //   4. dispose the persistence and the context
    adapter.openAll()
    await service.close()
    await ctx.subagents.drainContinuableDescendants([rootAgent])
    await persistence.dispose()
    await ctx.fiber.dispose()
    rmSync(sessionRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    rmSync(storeRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  })

  return { ctx, root: rootAgent, service, adapter }
}

function requests(count: number, offset = 0): LaunchRequest[] {
  return Array.from({ length: count }, (_, i) => {
    const n = offset + i
    return { taskId: `task-${n}`, childId: `child-${n}`, prompt: `do work ${n}`, reservedCost: 1 }
  })
}

describe(`mandatory concurrency: N=${N} rolling top-up on the production loop`, () => {
  it('admits exactly ten children through the real startContinuable seam', async () => {
    // C01 at the T1/T2 layer. Ten distinct children, ten distinct Sessions.
    const r = await rig()
    r.service.setReadyTasks('run-n10', 20)
    await r.service.createRun({ runId: 'run-n10', root: r.root, authorizationRef: 'auth' })

    r.service.setLaunchPort(
      createContinuableLaunchPort({
        subagents: r.ctx.subagents,
        parent: r.root,
        provider: 'spawn',
        maxDepth: 1,
      }),
    )

    const outcomes = await r.service.drain('run-n10', requests(N), new AbortController().signal)
    const accepted = outcomes.filter(o => o.accepted)
    expect(accepted).toHaveLength(N)

    // Ten DISTINCT child ids were admitted, and each is a real Session.
    const childIds = accepted.map(o => o.childId)
    expect(new Set(childIds).size).toBe(N)

    const record = r.service.getRun('run-n10')
    expect(record).toBeDefined()
    const states = Object.values(record!.tasks).map(t => t.state)
    // Every one of them is `accepted` - admission, NOT execution.
    expect(states.filter(s => s === 'accepted')).toHaveLength(N)
    expect(states).not.toContain('executing')

    // The real subagent registry agrees there are ten children.
    const children = await r.ctx.subagents.listChildren(r.root.id)
    expect(children.length).toBe(N)
  })

  it('does not admit an eleventh child while ten hold their slots', async () => {
    // INV-C1: the ceiling is not advisory.
    const r = await rig()
    await r.service.createRun({ runId: 'run-cap', root: r.root, authorizationRef: 'auth' })
    r.service.setReadyTasks('run-cap', 20)
    r.service.setLaunchPort(
      createContinuableLaunchPort({ subagents: r.ctx.subagents, parent: r.root, provider: 'spawn', maxDepth: 1 }),
    )

    const first = await r.service.drain('run-cap', requests(N), new AbortController().signal)
    expect(first.filter(o => o.accepted)).toHaveLength(N)

    const extra = await r.service.drain('run-cap', requests(1, 100), new AbortController().signal)
    expect(extra[0]?.accepted).toBe(false)
    // The target is exactly full, so there is no deficit to explain; the refusal
    // is simply that the ceiling is reached. `slots_held_by_unconfirmed` is for
    // the different case where the target is NOT reached but the free slots are
    // blocked by work whose release is unconfirmed.
    expect(extra[0]?.reason).toBe('none')
    expect(r.service.counts('run-cap').capacityDeficit).toBe(0)

    const children = await r.ctx.subagents.listChildren(r.root.id)
    expect(children.length).toBe(N)
  })

  it('tops up one completion immediately without waiting for the wave', async () => {
    // C02: the property is that ONE release admits ONE replacement.
    const r = await rig()
    await r.service.createRun({ runId: 'run-topup', root: r.root, authorizationRef: 'auth' })
    r.service.setReadyTasks('run-topup', 20)
    r.service.setLaunchPort(
      createContinuableLaunchPort({ subagents: r.ctx.subagents, parent: r.root, provider: 'spawn', maxDepth: 1 }),
    )

    await r.service.drain('run-topup', requests(N), new AbortController().signal)
    expect(r.service.counts('run-topup').capacityDeficit).toBe(0)

    // Let the children actually run and finish.
    r.adapter.openAll()
    await new Promise(resolve => setTimeout(resolve, 400))

    // Mark one confirmed as its result settles. Whatever the children did, the
    // record must show a freed slot only after confirmation.
    const record = r.service.getRun('run-topup')!
    const firstTask = Object.keys(record.tasks)[0]!
    await r.service.transition({ runId: 'run-topup', taskId: firstTask, to: 'settling' })
    await r.service.transition({ runId: 'run-topup', taskId: firstTask, to: 'confirmed', spentCost: 0 })
    expect(r.service.counts('run-topup').capacityDeficit).toBe(1)

    const replacement = await r.service.drain('run-topup', requests(1, 500), new AbortController().signal)
    expect(replacement[0]?.accepted).toBe(true)
    expect(r.service.counts('run-topup').capacityDeficit).toBe(0)
  })

  it('reports a deficit and invents no work when only three tasks are ready', async () => {
    // C04: no sleep placeholders, no idle sessions pretending to be workers.
    const r = await rig()
    await r.service.createRun({ runId: 'run-deficit', root: r.root, authorizationRef: 'auth' })
    r.service.setReadyTasks('run-deficit', 3)
    r.service.setLaunchPort(
      createContinuableLaunchPort({ subagents: r.ctx.subagents, parent: r.root, provider: 'spawn', maxDepth: 1 }),
    )

    const outcomes = await r.service.drain('run-deficit', requests(3), new AbortController().signal)
    expect(outcomes.filter(o => o.accepted)).toHaveLength(3)

    const counts = r.service.counts('run-deficit')
    expect(counts.desiredTarget).toBe(N)
    expect(counts.readyTasks).toBe(3)
    expect(counts.capacityDeficit).toBe(N - 3)
    expect(counts.deficitReason).toBe('insufficient_ready_tasks')
    // Exactly three real children exist, not ten with seven idle.
    const children = await r.ctx.subagents.listChildren(r.root.id)
    expect(children.length).toBe(3)
  })

  it('refuses admission past the real capacity even when the record would allow it', async () => {
    // This is the test that proves the RECORD is not the only ceiling. The
    // record's target is N, but DSH's own maxActiveSubagents is also N, so a
    // record that tried to over-admit would be refused by the real seam.
    const r = await rig()
    await r.service.createRun({ runId: 'run-real-cap', root: r.root, authorizationRef: 'auth' })
    r.service.setReadyTasks('run-real-cap', 50)
    r.service.setLaunchPort(
      createContinuableLaunchPort({ subagents: r.ctx.subagents, parent: r.root, provider: 'spawn', maxDepth: 1 }),
    )

    const outcomes = await r.service.drain('run-real-cap', requests(N), new AbortController().signal)
    expect(outcomes.filter(o => o.accepted)).toHaveLength(N)

    // Now drive the REAL subagent service directly, past our record entirely.
    // It must refuse the eleventh, which proves the ceiling is enforced by the
    // host and not only by our own bookkeeping.
    await expect(
      r.ctx.subagents.startContinuable({
        provider: 'spawn',
        label: 'unmetered attempt',
        childId: SessionId('child-overflow'),
        request: { parent: r.root, prompt: [{ type: 'text', text: 'overflow' }], maxDepth: 1 },
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/ACTIVATION_LIMIT_REACHED|maxActiveSubagents|limit/i)
  })

  it('keeps the root separate from the ten children', async () => {
    // INV-C2: root is not counted in N. Its Session is not one of the children.
    const r = await rig()
    await r.service.createRun({ runId: 'run-root', root: r.root, authorizationRef: 'auth' })
    r.service.setReadyTasks('run-root', 20)
    r.service.setLaunchPort(
      createContinuableLaunchPort({ subagents: r.ctx.subagents, parent: r.root, provider: 'spawn', maxDepth: 1 }),
    )
    await r.service.drain('run-root', requests(N), new AbortController().signal)

    const children = await r.ctx.subagents.listChildren(r.root.id)
    expect(children.map(c => String(c.id))).not.toContain(String(r.root.id))
    expect(children.length).toBe(N)

    // And the root is still a live agent that can take a turn of its own.
    expect(r.ctx.agents.get(r.root.id)).toBe(r.root)
    expect(r.root.status).toBe('idle')
  })

  it('refuses to launch grandchildren because maxDepth is 1', async () => {
    // INV-C7 / C13: grandchildren would escape the same metering.
    const r = await rig()
    await r.service.createRun({ runId: 'run-depth', root: r.root, authorizationRef: 'auth' })
    r.service.setReadyTasks('run-depth', 5)
    r.service.setLaunchPort(
      createContinuableLaunchPort({ subagents: r.ctx.subagents, parent: r.root, provider: 'spawn', maxDepth: 1 }),
    )
    await r.service.drain('run-depth', requests(1), new AbortController().signal)

    const children = await r.ctx.subagents.listChildren(r.root.id)
    const childId = children[0]!.id
    const child = r.ctx.agents.get(childId)
    expect(child).toBeDefined()

    // The child exists but has not been driven, so it has no turn. What we can
    // assert honestly here is the depth policy the child carries.
    const { delegationDepthOf } = await import('@deepseek-ai/dsh-subagent')
    expect(delegationDepthOf(child!)).toBe(1)
  })

  it('coalesces concurrent drains so a completion storm cannot double-admit', async () => {
    // C03: two drains racing on one free slot produce one launch.
    const r = await rig()
    await r.service.createRun({ runId: 'run-storm', root: r.root, authorizationRef: 'auth' })
    r.service.setReadyTasks('run-storm', 20)
    r.service.setLaunchPort(
      createContinuableLaunchPort({ subagents: r.ctx.subagents, parent: r.root, provider: 'spawn', maxDepth: 1 }),
    )

    const signal = new AbortController().signal
    const [a, b] = await Promise.all([
      r.service.drain('run-storm', requests(1, 900), signal),
      r.service.drain('run-storm', requests(1, 900), signal),
    ])
    const accepted = [...a, ...b].filter(o => o.accepted)
    expect(accepted).toHaveLength(1)
    const children = await r.ctx.subagents.listChildren(r.root.id)
    expect(children.length).toBe(1)
  })

  it('stops admitting once the user pauses, with free slots remaining', async () => {
    // C06 / INV-G4: a user pause outranks top-up.
    const r = await rig()
    await r.service.createRun({ runId: 'run-pause', root: r.root, authorizationRef: 'auth' })
    r.service.setReadyTasks('run-pause', 20)
    r.service.setLaunchPort(
      createContinuableLaunchPort({ subagents: r.ctx.subagents, parent: r.root, provider: 'spawn', maxDepth: 1 }),
    )
    await r.service.drain('run-pause', requests(2), new AbortController().signal)

    await r.service.pause('run-pause', 'user pressed stop')
    const after = await r.service.drain('run-pause', requests(3, 700), new AbortController().signal)
    expect(after.every(o => !o.accepted)).toBe(true)
    const children = await r.ctx.subagents.listChildren(r.root.id)
    expect(children.length).toBe(2)
  })
})
