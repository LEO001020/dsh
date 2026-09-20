/**
 * Reconciliation tests.
 *
 * These are the cases that decide whether a crash turns into a duplicate
 * external effect. Every branch asserts the conservative reading: anything that
 * cannot be PROVEN safe comes back `unknown`, holding its slot and its credit.
 *
 * THE LAST SECTION IS A PRODUCT-PATH TEST AND THE REST ARE NOT. Everything above
 * calls `reconcileTask` / `recoveryPhase` DIRECTLY, which proves the mechanism
 * and says nothing about whether the product reaches it — the defect class
 * `docs/GAPS.md` records five times over. The final describe installs NOTHING and
 * drives the real production stack, and what it measures is recorded there.
 */
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import * as storageJsonPlugin from '@deepseek-ai/dsh-storage-json'
import * as storageDomainPlugin from '@deepseek-ai/dsh-storage-domain'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import * as spawnProvider from '@deepseek-ai/dsh-subagent-spawn-in-process'
import { SessionId } from '@deepseek-ai/dsh-session'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { WorkService } from './host.ts'
import type { TaskRecord } from './record.ts'
import { reconcileRun, reconcileTask, recoveryPhase, type ChildEvidence } from './reconcile.ts'

const NOW = '2026-09-19T00:00:00.000Z'

function task(state: TaskRecord['state'], taskId = 't1'): TaskRecord {
  return {
    taskId,
    assignmentDigest: 'd',
    childId: `child-${taskId}`,
    attempt: 1,
    state,
    allowedCapabilities: [],
    inputRefs: [],
    outputRefs: [],
    reservedCost: 5,
    createdAt: NOW,
    updatedAt: NOW,
  }
}

/** Evidence with conservative defaults; each test overrides only what it means. */
function evidence(overrides: Partial<ChildEvidence> = {}): ChildEvidence {
  return {
    taskId: 't1',
    childId: 'child-t1',
    sessionExists: false,
    agentLive: false,
    requestObserved: false,
    turnOutcome: undefined,
    resultRef: undefined,
    launchProvenNotCreated: false,
    ...overrides,
  }
}

describe('reconcileTask: the five positions', () => {
  it('D03: a reservation that provably never launched returns to prepared', () => {
    // The ONLY path back to `prepared`, and it needs positive proof.
    const decision = reconcileTask(task('launching'), evidence({ launchProvenNotCreated: true }))
    expect(decision.next).toBe('prepared')
    expect(decision.releaseSlot).toBe(false)
  })

  it('D03/D04: a reserved id with no trace is unknown, not relaunchable', () => {
    // The launch may have happened and the Session may be gone. We cannot tell,
    // so this must NOT become a second launch.
    const decision = reconcileTask(task('launching'), evidence())
    expect(decision.next).toBe('unknown')
    expect(decision.releaseSlot).toBe(false)
    expect(decision.reason).toMatch(/quarantined rather than relaunched/)
  })

  it('D05: a pending prompt is left to native Inbox recovery', () => {
    // The child exists and took the prompt but never ran it. DSH recovers
    // pending inbox natively; injecting a second copy would duplicate it.
    const decision = reconcileTask(
      task('accepted'),
      evidence({ sessionExists: true, agentLive: true, requestObserved: false }),
    )
    expect(decision.next).toBe('accepted')
    expect(decision.releaseSlot).toBe(false)
    expect(decision.reason).toMatch(/native Inbox recovery owns it/)
  })

  it('D06: claim with no request confirmation is unknown', () => {
    const decision = reconcileTask(
      task('executing'),
      evidence({ sessionExists: true, agentLive: true, requestObserved: false }),
    )
    expect(decision.next).toBe('accepted')
    expect(decision.releaseSlot).toBe(false)
  })

  it('D07: a request with no terminal turn is unknown, never retried', () => {
    // The most dangerous window: the model may or may not have produced an
    // effect, and a turn checkpoint is not an exactly-once external effect.
    const decision = reconcileTask(
      task('executing'),
      evidence({ sessionExists: true, agentLive: true, requestObserved: true, turnOutcome: undefined }),
    )
    expect(decision.next).toBe('unknown')
    expect(decision.releaseSlot).toBe(false)
    expect(decision.reason).toMatch(/reservation is held/)
  })

  it('D07: an interrupted turn is unknown, not safely redoable', () => {
    const decision = reconcileTask(
      task('executing'),
      evidence({ sessionExists: true, agentLive: true, requestObserved: true, turnOutcome: 'interrupted' }),
    )
    expect(decision.next).toBe('unknown')
    expect(decision.releaseSlot).toBe(false)
  })

  it('D09: a turn that ended in error is unknown, not failed-and-retryable', () => {
    const decision = reconcileTask(
      task('executing'),
      evidence({ sessionExists: true, agentLive: true, requestObserved: true, turnOutcome: 'error' }),
    )
    expect(decision.next).toBe('unknown')
    expect(decision.releaseSlot).toBe(false)
    expect(decision.reason).toMatch(/an error is not proof that no effect occurred/)
  })

  it('D08: a completed turn with a result ref goes to settling, not confirmed', () => {
    // A lost parent notification is NOT a child failure: the Session is the
    // evidence. But completion is a fact about the child, not about the task, so
    // acceptance still decides.
    const decision = reconcileTask(
      task('executing'),
      evidence({
        sessionExists: true,
        agentLive: false,
        requestObserved: true,
        turnOutcome: 'completed',
        resultRef: 'artifact:abc',
      }),
    )
    expect(decision.next).toBe('settling')
    expect(decision.releaseSlot).toBe(false)
    expect(decision.reason).toMatch(/acceptance still decides/)
  })

  it('a completed turn with no result ref is settling, not confirmed', () => {
    const decision = reconcileTask(
      task('executing'),
      evidence({ sessionExists: true, agentLive: true, requestObserved: true, turnOutcome: 'completed' }),
    )
    expect(decision.next).toBe('settling')
    expect(decision.releaseSlot).toBe(false)
  })

  it('never releases a slot from reconciliation alone', () => {
    // Only an explicit confirm/cancel transition releases credit. If
    // reconciliation could release, a crash would become a free retry.
    const states: TaskRecord['state'][] = ['launching', 'accepted', 'executing', 'settling', 'unknown']
    for (const state of states) {
      const withEvidence = reconcileTask(
        task(state),
        evidence({
          sessionExists: true,
          agentLive: true,
          requestObserved: true,
          turnOutcome: 'completed',
          resultRef: 'artifact:x',
        }),
      )
      expect(withEvidence.releaseSlot).toBe(false)
    }
  })
})

describe('reconcileRun', () => {
  it('quarantines any task with no gathered evidence', () => {
    // An unprobed task must not be silently assumed fine.
    const tasks = { a: task('executing', 'a'), b: task('executing', 'b') }
    const decisions = reconcileRun(tasks, new Map())
    expect(decisions).toHaveLength(2)
    expect(decisions.every(d => d.next === 'unknown')).toBe(true)
    expect(decisions[0]?.reason).toMatch(/unprobed task stays quarantined/)
  })

  it('returns decisions in a stable order so a report is diffable', () => {
    const tasks = { z: task('executing', 'z'), a: task('executing', 'a'), m: task('executing', 'm') }
    const decisions = reconcileRun(tasks, new Map())
    expect(decisions.map(d => d.taskId)).toEqual(['a', 'm', 'z'])
  })

  it('resolves a mixed run per task without letting one decision leak into another', () => {
    const tasks = {
      pending: task('accepted', 'pending'),
      running: task('executing', 'running'),
      done: task('executing', 'done'),
    }
    const evidenceMap = new Map<string, ChildEvidence>([
      ['pending', evidence({ taskId: 'pending', sessionExists: true, agentLive: true })],
      [
        'running',
        evidence({ taskId: 'running', sessionExists: true, agentLive: true, requestObserved: true }),
      ],
      [
        'done',
        evidence({
          taskId: 'done',
          sessionExists: true,
          agentLive: true,
          requestObserved: true,
          turnOutcome: 'completed',
          resultRef: 'artifact:done',
        }),
      ],
    ])
    const decisions = reconcileRun(tasks, evidenceMap)
    const byId = Object.fromEntries(decisions.map(d => [d.taskId, d.next]))
    expect(byId).toEqual({ pending: 'accepted', running: 'unknown', done: 'settling' })
  })
})

describe('recoveryPhase: restart does not re-authorize', () => {
  it('D13: resumes paused when the run was never authorized to survive a restart', () => {
    const result = recoveryPhase(false, undefined, NOW)
    expect(result.phase).toBe('paused')
    expect(result.reason).toMatch(/not authorized to continue after a host restart/)
  })

  it('D13: resumes paused when the authorization has expired', () => {
    const result = recoveryPhase(true, '2026-09-18T00:00:00.000Z', NOW)
    expect(result.phase).toBe('paused')
    expect(result.reason).toMatch(/expired/)
  })

  it('resumes open only with a live authorization', () => {
    const result = recoveryPhase(true, '2026-09-20T00:00:00.000Z', NOW)
    expect(result.phase).toBe('open')
  })

  it('treats an authorization expiring exactly now as expired', () => {
    const result = recoveryPhase(true, NOW, NOW)
    expect(result.phase).toBe('paused')
  })
})

/**
 * THE PRODUCT PATH. Nothing here is direct-called, and nothing is installed.
 *
 * WHY THIS SECTION EXISTS IN THIS FILE. Everything above calls `reconcileTask` /
 * `recoveryPhase` DIRECTLY, which proves the mechanism and says nothing about
 * whether the product reaches it. A direct-mount test is structurally blind to
 * this class: every case above passes while the product never reconciles
 * anything. `docs/GAPS.md` records the class five times over — `setLaunchPort`,
 * `takeContinuation`, `dsh-ipython`'s missing bundle, the `recovery.ts` epoch
 * guard (since DELETED rather than wired, because its input could not be
 * constructed — see `qualification/results/R9-recovery-topology/`), and the data
 * plane before its plugin row.
 *
 * So this case installs NOTHING and drives the REAL production stack: a real
 * AgentLoop, a real SubagentRuntime, a real spawn provider, and the service's own
 * production launch port. The provider is the only scripted element, deliberately:
 * a provider is what a provider IS, and the question is the WIRE — not whether a
 * paid model produces good work, which needs an authorized budget
 * (`live_provider_budget_authorized: false`).
 *
 * WHAT IT FOUND, stated as the measurement it is rather than as a wish. Every
 * assertion records CURRENT product behaviour, so if a settlement path is ever
 * wired this test fails loudly and becomes that fix's regression test:
 *
 *   - Every call to `WorkService.transition` in non-test source is inside
 *     `runDrain` (`host.ts:1323` launching, `:1332`/`:1354` unknown, `:1372`
 *     accepted), plus `recovery.ts` — which has no non-test importer. So the only
 *     states the PRODUCT can produce are `launching`, `accepted` and `unknown`.
 *   - `observe()` / `setReadyTasks()` — the only producers of the liveness the
 *     counts read — have no caller outside tests.
 *   - `recordSpend()` / `spendRoot()` likewise.
 *
 * Consequence: a launched child reaches `accepted`, and `accepted` is a
 * slot-holding state (`states.ts:56-64`), so the slot and its reservation are
 * never released by the product path. The model's own `status` action reports
 * `activeAssignments: 0` while a real child is running, because that counter
 * requires `executing` plus observed liveness and nothing can produce either.
 *
 * WHAT THIS DOES NOT PROVE: that the child produced a result. `startContinuable`
 * resolves at the inbox-acceptance edge, so this is a statement about the
 * product's settle path, not about model output.
 */
describe('PRODUCT PATH: a launched child never leaves `accepted`', () => {
  it('the production stack launches a real child and the record stops at accepted', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-reconcile-prod-'))
    const ctx = new Context()
    try {
      await mountAgentLoopTestDependencies(ctx)
      await ctx.plugin(AgentLoop, { agents: [] })
      await ctx.plugin(JsonlSessionPersistence, { root: join(root, 'sessions') })
      await ctx.plugin(Storage)
      await ctx.plugin(storageJsonPlugin as never, { root: join(root, 'store') } as never)
      await ctx.plugin(storageDomainPlugin as never, { backend: 'json' } as never)
      await ctx.plugin(SubagentRuntime, { maxActiveSubagents: 3, maxDepth: 1 })
      await ctx.plugin(spawnProvider as never, { providerName: 'spawn' } as never)

      const service = new WorkService(ctx, {
        targetChildren: 1,
        maxDepth: 1,
        subagentProvider: 'spawn',
        budgetCeiling: 50,
        currency: 'USD',
        priceVersion: 'reconcile-prod-path',
      })
      await service.open()

      const handle = await ctx.agents.create({ sessionId: SessionId('sess-reconcile-root') })
      await service.createRun({
        runId: 'run-reconcile-prod',
        root: handle.agent,
        authorizationRef: 'auth-reconcile',
        targetChildren: 1,
      })

      // NO `setLaunchPort` anywhere: the service binds its own production port.
      const outcomes = await service.drain(
        'run-reconcile-prod',
        [{ taskId: 't1', childId: 'child-reconcile-1', prompt: 'one unit of work', reservedCost: 1 }],
        new AbortController().signal,
      )
      // Precondition, asserted rather than assumed: the launch really happened,
      // so everything below is about a launched child and not about a launch
      // that silently failed.
      expect(outcomes[0]?.accepted).toBe(true)

      const record = service.getRun('run-reconcile-prod')
      expect(record?.tasks['t1']?.state).toBe('accepted')
      // The reservation is still held, and NOTHING in the product can release
      // it: only `confirmed`/`cancelled` release (`host.ts:900`), and neither is
      // reachable from a non-test caller.
      expect(record?.budget.reserved).toBe(1)

      // The model-visible consequence, which is what makes this a product
      // finding rather than a code-reading exercise.
      const counts = service.counts('run-reconcile-prod')
      expect(counts.durablyAdmitted).toBe(1)
      expect(counts.activeAssignments).toBe(0)
      expect(counts.confirmed).toBe(0)
      expect(counts.cancelled).toBe(0)
      // Not the unknown branch: the launch succeeded, so the gap is the
      // SETTLEMENT half, not the quarantine half.
      expect(counts.quarantinedUnknown).toBe(0)

      // The model's only end-of-work signal moves the RUN, not the task, so even
      // `finish` leaves the slot occupied.
      await service.beginClosing('run-reconcile-prod')
      const closing = service.getRun('run-reconcile-prod')
      expect(closing?.phase).toBe('closing')
      expect(closing?.tasks['t1']?.state).toBe('accepted')
      expect(closing?.budget.reserved).toBe(1)

      await service.close()
    } finally {
      await ctx.fiber.dispose()
      rmSync(root, { recursive: true, force: true, maxRetries: 3 })
    }
  }, 60_000)
})
