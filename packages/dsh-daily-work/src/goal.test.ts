/**
 * C14: exactly one continuation owner per root.
 *
 * DSH's Goal is TWO things: a durable objective, and an independent round driver
 * that auto-continues an idle agent. A managed work run is also a continuation
 * driver, because it wakes the root when a child settles. Two drivers on one root
 * is a double-continuation loop.
 *
 * The resolution this project uses is the mildest one available. From
 * `packages/goal/goal/src/index.ts:282-294`:
 *
 *   "Remove process-local continuation authority without changing durable goal
 *    phase or revision. Lifecycle owners use this before unloading a driver; a
 *    later human-authorized resume records the new activation edge."
 *
 *   disarm(agent) { this.setActivation(agent.session, 'disarmed'); ... }
 *
 * So `disarm` touches ONLY process-local activation. It does not clear the
 * objective, does not bump the revision, and does not fake completion. This file
 * asserts all three, because "we disarmed the goal" is very easy to say and very
 * easy to implement as "we deleted the goal".
 */
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import GoalService from '@deepseek-ai/dsh-goal'
import { SessionId } from '@deepseek-ai/dsh-session'
import Storage from '@deepseek-ai/dsh-storage'
import * as storageDomainPlugin from '@deepseek-ai/dsh-storage-domain'
import * as storageJsonPlugin from '@deepseek-ai/dsh-storage-json'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
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

interface Rig {
  readonly ctx: Context
  readonly service: WorkService
  agent(id: string): Promise<Agent>
}

async function rig(withGoals: boolean): Promise<Rig> {
  const storeRoot = mkdtempSync(join(tmpdir(), 'dsh-daily-work-goal-store-'))
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  if (withGoals) await ctx.plugin(GoalService)
  await ctx.plugin(Storage, {} as never)
  await ctx.plugin(storageJsonPlugin as never, { root: storeRoot } as never)
  await ctx.plugin(storageDomainPlugin as never, { backend: 'json' } as never)

  const service = new WorkService(ctx, {
    targetChildren: 10,
    maxDepth: 1,
    budgetCeiling: 100,
    currency: 'USD',
    priceVersion: 'goal-test',
  })
  await service.open()

  cleanups.push(async () => {
    await service.close()
    await ctx.fiber.dispose()
    rmSync(storeRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  })

  return { ctx, service, agent: id => ctx.agentLoop.create(SessionId(id), {}, {}) }
}

describe('C14: one continuation owner per root', () => {
  it('is a complete, honest no-op when the profile mounts no Goal service', async () => {
    // A missing Goal service is not a failure: there is simply nothing to
    // contend with. Returning a reason rather than throwing keeps this callable
    // from a host that has no goals at all.
    const r = await rig(false)
    const root = await r.agent('root-no-goals')
    const handover = r.service.takeContinuation(root)
    expect(handover.goalPresent).toBe(false)
    expect(handover.disarmed).toBe(false)
    expect(handover.note).toMatch(/no goal service is mounted/)
  })

  it('is a no-op when the root has no current goal', async () => {
    const r = await rig(true)
    const root = await r.agent('root-no-goal')
    const handover = r.service.takeContinuation(root)
    expect(handover.goalPresent).toBe(false)
    expect(handover.note).toMatch(/no current goal/)
  })

  it('preserves the durable objective and the revision while removing continuation', async () => {
    // THE assertion. Disarm must not be deletion in disguise.
    const r = await rig(true)
    const root = await r.agent('root-with-goal')
    const goals = r.ctx.get('goals')!
    const created = goals.create(root, { objective: 'ship the daily harness' })
    expect(created.phase).toBe('active')

    const handover = r.service.takeContinuation(root)

    expect(handover.goalPresent).toBe(true)
    expect(handover.disarmed).toBe(true)
    // The two facts that make this a handover rather than a deletion.
    expect(handover.objectivePreserved).toBe(true)
    expect(handover.revisionUnchanged).toBe(true)

    // And read it back from the service rather than trusting the handover object.
    const after = goals.get(root)!
    expect(after.objective).toBe('ship the daily harness')
    expect(after.revision).toBe(created.revision)
    // The phase is UNCHANGED: still active, not completed and not blocked. A
    // deployment that faked completion here would be lying about the objective.
    expect(after.phase).toBe('active')
    // Only the process-local activation moved.
    expect(after.activation).toBe('disarmed')
  })

  it('leaves the objective readable after the handover', async () => {
    // A disarmed goal must still be visible. If it vanished from `get`, the
    // objective would be effectively lost while the record claimed otherwise.
    const r = await rig(true)
    const root = await r.agent('root-readable')
    const goals = r.ctx.get('goals')!
    goals.create(root, { objective: 'keep this objective visible' })
    r.service.takeContinuation(root)
    expect(goals.get(root)?.objective).toBe('keep this objective visible')
  })

  it('does not disturb another root', async () => {
    // INV-G3: the guard is scoped to the run's own root. Another Session's goal
    // must be untouched, which is what stops this from being a global switch.
    const r = await rig(true)
    const goals = r.ctx.get('goals')!
    const managed = await r.agent('root-managed')
    const other = await r.agent('root-other')
    goals.create(managed, { objective: 'managed objective' })
    goals.create(other, { objective: 'other objective' })

    r.service.takeContinuation(managed)

    expect(goals.get(managed)?.activation).toBe('disarmed')
    // The other root is untouched: still armed, same objective, same revision.
    const otherGoal = goals.get(other)!
    expect(otherGoal.activation).toBe('armed')
    expect(otherGoal.objective).toBe('other objective')
    expect(otherGoal.phase).toBe('active')
  })

  it('is idempotent: taking continuation twice leaves the same state', async () => {
    const r = await rig(true)
    const root = await r.agent('root-twice')
    const goals = r.ctx.get('goals')!
    const created = goals.create(root, { objective: 'idempotent objective' })

    const first = r.service.takeContinuation(root)
    const second = r.service.takeContinuation(root)

    expect(first.disarmed).toBe(true)
    expect(second.disarmed).toBe(true)
    expect(second.revisionUnchanged).toBe(true)
    const after = goals.get(root)!
    expect(after.revision).toBe(created.revision)
    expect(after.objective).toBe('idempotent objective')
  })

  it('a later resume is possible, so the handover is reversible by a human', async () => {
    // The plan requires that re-taking continuation is a NEW authorization edge
    // rather than something this project restores on its own. Asserting that
    // resume still works proves disarm did not destroy the ability to resume.
    const r = await rig(true)
    const root = await r.agent('root-resume')
    const goals = r.ctx.get('goals')!
    const created = goals.create(root, { objective: 'resumable objective' })

    r.service.takeContinuation(root)
    expect(goals.get(root)?.activation).toBe('disarmed')

    const resumed = goals.resume(root, { id: created.id, revision: created.revision })
    expect(resumed.activation).toBe('armed')
    // A resume is a durable mutation, so the revision advances. That is the
    // recorded authorization edge.
    expect(resumed.revision).toBeGreaterThan(created.revision)
    expect(resumed.objective).toBe('resumable objective')
  })
})
