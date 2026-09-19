/**
 * C08 / C17 / C18: what a teardown failure does, and does not, prove.
 *
 * The source-level fact this file is built around
 * (`packages/subagent/subagent/src/lifecycle.ts:189-194`):
 *
 *   "Teardown failure overrides the epoch's own outcome and withholds its
 *    output: an answer this harness could not durably release is not a result."
 *
 *   const terminal = (failure: unknown): ActivationTerminal =>
 *     failure === undefined ? captured : { stopReason: 'error' }
 *
 * So a `subagent/end` event can carry `stopReason: 'error'` precisely BECAUSE the
 * disposal failed, not because the child's work failed. The two readings have
 * opposite consequences for a slot:
 *
 *   - work failed      -> the child is gone; the slot may be released
 *   - disposal failed  -> the child may still exist; the slot must be HELD
 *
 * A controller that released a slot on any `end` event would oversubscribe
 * exactly when the system is already unhealthy. This file asserts that this
 * project does not.
 *
 * It also covers the drain distinction the plan is emphatic about:
 * `drainContinuableDescendants` closes admission for that exact parent
 * PERMANENTLY, so it is a final-close operation and never a pause.
 */
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { LlmAdapter, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SubagentRuntime, { type SubagentRunEndInfo } from '@deepseek-ai/dsh-subagent'
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
import { reconcileTask } from './reconcile.ts'

/** An adapter that answers immediately, so children finish without a gate. */
class QuickAdapter extends LlmAdapter {
  override async resolveModel(provider: string, model: string): Promise<{ provider: string; id: string; name: string }> {
    return { provider, id: model, name: model }
  }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    if (options.signal?.aborted) throw new Error('aborted')
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'done' } }
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
  /** Every subagent/end the real registry emitted, in order. */
  readonly ends: SubagentRunEndInfo[]
}

async function rig(): Promise<Rig> {
  const sessionRoot = mkdtempSync(join(tmpdir(), 'dsh-daily-work-disposal-sessions-'))
  const storeRoot = mkdtempSync(join(tmpdir(), 'dsh-daily-work-disposal-store-'))
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  const persistence = await ctx.plugin(JsonlSessionPersistence, { root: sessionRoot })
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(SubagentRuntime, { maxActiveSubagents: 4, maxDepth: 1 })
  await ctx.plugin(SubagentSpawn, { providerName: 'spawn' })
  await ctx.plugin(Storage, {} as never)
  await ctx.plugin(storageJsonPlugin as never, { root: storeRoot } as never)
  await ctx.plugin(storageDomainPlugin as never, { backend: 'json' } as never)
  ctx.llm.registerAdapter(['mock'], new QuickAdapter())

  const ends: SubagentRunEndInfo[] = []
  // Observe the REAL lifecycle events. This is the notification a naive
  // controller would act on, so it is exactly what we must not over-trust.
  ctx.on('subagent/end', (info: SubagentRunEndInfo) => {
    ends.push(info)
  })

  const root = await ctx.agentLoop.create(SessionId('root-disposal'), { provider: 'mock', model: 'mock' })
  const service = new WorkService(ctx, {
    targetChildren: 4,
    maxDepth: 1,
    budgetCeiling: 1000,
    currency: 'USD',
    priceVersion: 'disposal-test',
  })
  await service.open()

  cleanups.push(async () => {
    await service.close()
    await ctx.subagents.drainContinuableDescendants([root])
    await persistence.dispose()
    await ctx.fiber.dispose()
    rmSync(sessionRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    rmSync(storeRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  })

  return { ctx, root, service, ends }
}

function launchPort(r: Rig) {
  return createContinuableLaunchPort({
    subagents: r.ctx.subagents,
    parent: r.root,
    provider: 'spawn',
    maxDepth: 1,
  })
}

describe('C08: a teardown failure must not look like a clean finish', () => {
  it('records a stopReason on every real end event, and never a diagnostic', async () => {
    // Establish the VOCABULARY first, from the real registry, because everything
    // else in this file depends on it. `SubagentRunEndInfo` carries no `error`
    // field and no `diagnostic` (packages/subagent/subagent/src/types.ts:100),
    // so `stopReason` is the ONLY signal available about how a child ended.
    const r = await rig()
    await r.service.createRun({ runId: 'run-c08', root: r.root, authorizationRef: 'auth' })
    r.service.setReadyTasks('run-c08', 8)
    r.service.setLaunchPort(launchPort(r))
    await r.service.drain(
      'run-c08',
      [{ taskId: 't1', childId: 'child-t1', prompt: 'work', reservedCost: 1 }],
      new AbortController().signal,
    )

    // Let the child run and settle.
    await new Promise(resolve => setTimeout(resolve, 200))
    await r.ctx.subagents.drainContinuableDescendants([r.root])
    await new Promise(resolve => setTimeout(resolve, 100))

    expect(r.ends.length).toBeGreaterThan(0)
    const end = r.ends[0]!
    expect(['completed', 'aborted', 'error', 'max-tokens', 'refusal']).toContain(end.stopReason)
    // The absence of an error field is the reason a controller must key off
    // stopReason AND its own record, not off the event alone.
    expect('error' in end).toBe(false)
    expect('diagnostic' in end).toBe(false)
  })

  it('does not release a slot on the strength of an end event alone', async () => {
    // THE invariant. The work service is driven by explicit transitions, so an
    // end event cannot free a slot by itself. This asserts that property
    // directly: after the child ends, the task still holds its slot until an
    // explicit confirm or cancel transition.
    const r = await rig()
    await r.service.createRun({ runId: 'run-hold', root: r.root, authorizationRef: 'auth' })
    r.service.setReadyTasks('run-hold', 8)
    r.service.setLaunchPort(launchPort(r))
    await r.service.drain(
      'run-hold',
      [{ taskId: 't1', childId: 'child-t1', prompt: 'work', reservedCost: 1 }],
      new AbortController().signal,
    )
    expect(r.service.counts('run-hold').capacityDeficit).toBe(3)

    // Let the child actually end.
    await r.ctx.subagents.drainContinuableDescendants([r.root])
    await new Promise(resolve => setTimeout(resolve, 50))

    // The slot is STILL held, because nothing confirmed anything.
    const after = r.service.getRun('run-hold')
    expect(after?.tasks['t1']?.state).toBe('accepted')
    expect(after?.budget.reserved).toBe(1)
    expect(r.service.counts('run-hold').capacityDeficit).toBe(3)
  })

  it('routes a teardown failure to unknown, holding the reservation', async () => {
    // The reconciliation rule for this window: a child that entered a request
    // with no clean terminal outcome is `unknown`, NOT failed-and-retryable.
    const r = await rig()
    await r.service.createRun({ runId: 'run-unknown', root: r.root, authorizationRef: 'auth' })
    r.service.setReadyTasks('run-unknown', 8)
    r.service.setLaunchPort(launchPort(r))
    await r.service.drain(
      'run-unknown',
      [{ taskId: 't1', childId: 'child-t1', prompt: 'work', reservedCost: 5 }],
      new AbortController().signal,
    )
    await r.service.transition({ runId: 'run-unknown', taskId: 't1', to: 'executing' })

    // Evidence shaped like a disposal failure: the Session exists and a request
    // was observed, but there is no terminal turn.
    const decision = reconcileTask(r.service.getRun('run-unknown')!.tasks['t1']!, {
      taskId: 't1',
      childId: 'child-t1',
      sessionExists: true,
      agentLive: true,
      requestObserved: true,
      turnOutcome: 'error',
      resultRef: undefined,
      launchProvenNotCreated: false,
    })
    expect(decision.next).toBe('unknown')
    expect(decision.releaseSlot).toBe(false)
    expect(decision.reason).toMatch(/an error is not proof that no effect occurred/)
  })

  it('holds the slot when a cancel is requested but the child may still be alive', async () => {
    // C07 restated at the service level: `cancel_requested` is not `cancelled`.
    const r = await rig()
    await r.service.createRun({ runId: 'run-cancel', root: r.root, authorizationRef: 'auth' })
    r.service.setReadyTasks('run-cancel', 8)
    r.service.setLaunchPort(launchPort(r))
    await r.service.drain(
      'run-cancel',
      [{ taskId: 't1', childId: 'child-t1', prompt: 'work', reservedCost: 3 }],
      new AbortController().signal,
    )
    await r.service.transition({ runId: 'run-cancel', taskId: 't1', to: 'executing' })
    await r.service.transition({ runId: 'run-cancel', taskId: 't1', to: 'cancel_requested' })

    expect(r.service.getRun('run-cancel')?.budget.reserved).toBe(3)
    expect(r.service.counts('run-cancel').stopping).toBe(1)
    const refused = await r.service.drain(
      'run-cancel',
      [{ taskId: 't2', childId: 'child-t2', prompt: 'more', reservedCost: 1 }],
      new AbortController().signal,
    )
    // t2 IS admitted because the target is 4 and only one slot is held, which is
    // correct; what must NOT happen is the stopping task being counted as free.
    expect(r.service.counts('run-cancel').stopping).toBe(1)
    expect(r.service.counts('run-cancel').capacityDeficit).toBe(2)
    void refused
  })
})

describe('C17/C18: pause is resumable, drain is final', () => {
  it('a pause keeps admission closed but does NOT close the parent', async () => {
    // The distinction the plan is emphatic about: using drain for a pause would
    // permanently close admission for that exact parent and make resume
    // impossible. So pause must be a record change plus a refusal, nothing more.
    const r = await rig()
    await r.service.createRun({ runId: 'run-pause-resume', root: r.root, authorizationRef: 'auth' })
    r.service.setReadyTasks('run-pause-resume', 8)
    r.service.setLaunchPort(launchPort(r))
    await r.service.drain(
      'run-pause-resume',
      [{ taskId: 't1', childId: 'child-t1', prompt: 'work', reservedCost: 1 }],
      new AbortController().signal,
    )

    await r.service.pause('run-pause-resume', 'user pressed stop')
    const whilePaused = await r.service.drain(
      'run-pause-resume',
      [{ taskId: 't2', childId: 'child-t2', prompt: 'more', reservedCost: 1 }],
      new AbortController().signal,
    )
    expect(whilePaused[0]?.accepted).toBe(false)

    // RESUME MUST WORK. If pause had used drain, this would fail forever.
    await r.service.resume('run-pause-resume')
    const afterResume = await r.service.drain(
      'run-pause-resume',
      [{ taskId: 't3', childId: 'child-t3', prompt: 'more', reservedCost: 1 }],
      new AbortController().signal,
    )
    expect(afterResume[0]?.accepted).toBe(true)
  })

  it('a real drain closes admission for that exact parent, permanently', async () => {
    // C18, asserted against the REAL seam rather than described. This is why
    // drain is reserved for final close.
    const r = await rig()
    await r.ctx.subagents.drainContinuableDescendants([r.root])

    await expect(
      r.ctx.subagents.startContinuable({
        provider: 'spawn',
        label: 'after drain',
        childId: SessionId('child-after-drain'),
        request: { parent: r.root, prompt: [{ type: 'text', text: 'x' }], maxDepth: 1 },
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow()
  })

  it('closing a run stops new admissions without draining the family', async () => {
    // The model's `finish` action moves the run to `closing`. That must stop new
    // work while leaving the family open, because acceptance may still fail and
    // the run may need to continue.
    const r = await rig()
    await r.service.createRun({ runId: 'run-closing', root: r.root, authorizationRef: 'auth' })
    r.service.setReadyTasks('run-closing', 8)
    r.service.setLaunchPort(launchPort(r))
    await r.service.beginClosing('run-closing')

    const refused = await r.service.drain(
      'run-closing',
      [{ taskId: 't1', childId: 'child-t1', prompt: 'work', reservedCost: 1 }],
      new AbortController().signal,
    )
    expect(refused[0]?.accepted).toBe(false)
    expect(refused[0]?.reason).toBe('run_not_open')

    // And the family is still open: a child can still be established directly.
    // That is the property that makes a failed acceptance recoverable.
    const started = await r.ctx.subagents.startContinuable({
      provider: 'spawn',
      label: 'still admissible',
      childId: SessionId('child-still-open'),
      request: { parent: r.root, prompt: [{ type: 'text', text: 'x' }], maxDepth: 1 },
      signal: new AbortController().signal,
    })
    expect(String(started.childId)).toBe('child-still-open')
  })
})
