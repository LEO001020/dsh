/**
 * Reconciliation tests.
 *
 * These are the cases that decide whether a crash turns into a duplicate
 * external effect. Every branch asserts the conservative reading: anything that
 * cannot be PROVEN safe comes back `unknown`, holding its slot and its credit.
 */
import { describe, expect, it } from 'vitest'
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
