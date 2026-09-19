/**
 * Pure-function tests for the state machine and the counting rules.
 *
 * These are T0 tests: no DSH, no I/O. They exist because the invariants they
 * cover (INV-C1, INV-C3, INV-C4) are the ones that decide whether "ten
 * workers" is a fact or a claim, and a claim is easy to get wrong quietly.
 */
import { describe, expect, it } from 'vitest'
import {
  ADMISSION_STATES,
  SLOT_HOLDING_STATES,
  TERMINAL_STATES,
  assertTransition,
  canTransition,
  holdsSlot,
  TransitionError,
} from './states.ts'
import { countRun, mayAdmit, type TaskLiveness } from './counting.ts'
import { initialRunRecord, type RunRecord, type TaskRecord } from './record.ts'

const NOW = '2026-09-19T00:00:00.000Z'

function record(overrides: Partial<RunRecord> = {}): RunRecord {
  const base = initialRunRecord({
    runId: 'run-1',
    rootSessionId: 'session-root',
    authorizationRef: 'auth-1',
    requestedTarget: 10,
    maxDepth: 1,
    policyDigest: 'policy-1',
    budget: { currency: 'USD', priceVersion: 'v1', spent: 0, reserved: 0, unknownReserved: 0, ceiling: 100 },
    restartResumeAuthorized: false,
    now: NOW,
  })
  return { ...base, ...overrides }
}

function task(taskId: string, state: TaskRecord['state']): TaskRecord {
  return {
    taskId,
    assignmentDigest: `digest-${taskId}`,
    attempt: 1,
    state,
    allowedCapabilities: ['reader'],
    inputRefs: [],
    outputRefs: [],
    reservedCost: 0,
    createdAt: NOW,
    updatedAt: NOW,
  }
}

describe('admission state machine', () => {
  it('covers every declared state in the transition table', () => {
    for (const state of ADMISSION_STATES) {
      expect(() => canTransition(state, state)).not.toThrow()
    }
  })

  it('refuses to leave a terminal state', () => {
    for (const terminal of TERMINAL_STATES) {
      for (const target of ADMISSION_STATES) {
        expect(canTransition(terminal, target)).toBe(false)
      }
    }
  })

  it('throws a TransitionError carrying the task id', () => {
    expect(() => assertTransition('confirmed', 'executing', 't-9')).toThrow(TransitionError)
    try {
      assertTransition('confirmed', 'executing', 't-9')
    } catch (error) {
      expect((error as TransitionError).taskId).toBe('t-9')
    }
  })

  it('does not let a requested cancel reach a released slot directly', () => {
    // INV-C4: cancel_requested holds the slot; only a confirmed cancel releases it.
    expect(holdsSlot('cancel_requested')).toBe(true)
    expect(holdsSlot('cancelled')).toBe(false)
  })

  it('treats unknown as slot-holding, never as a free slot', () => {
    expect(holdsSlot('unknown')).toBe(true)
    expect(SLOT_HOLDING_STATES).toContain('unknown')
  })

  it('holds a slot while settling, because the world may still change', () => {
    expect(holdsSlot('settling')).toBe(true)
  })

  it('does not count a confirmed or cancelled task as holding a slot', () => {
    expect(holdsSlot('confirmed')).toBe(false)
    expect(holdsSlot('cancelled')).toBe(false)
  })
})

describe('precise counting', () => {
  it('does not count an idle child as an active assignment', () => {
    // INV-C6: accepted/executing without observed real work is NOT a worker.
    const r = record({ tasks: { a: task('a', 'executing'), b: task('b', 'executing') } })
    const counts = countRun(r, new Map(), 10)
    expect(counts.activeAssignments).toBe(0)
    expect(counts.desiredTarget).toBe(10)
    expect(counts.capacityDeficit).toBe(8)
  })

  it('counts a child as active only after observed real work', () => {
    const r = record({ tasks: { a: task('a', 'executing'), b: task('b', 'executing') } })
    const live = new Map<string, TaskLiveness>([
      ['a', { taskId: 'a', startedRealWork: true, waitingOnOwnedTool: false, providerWaiting: false }],
    ])
    const counts = countRun(r, live, 10)
    expect(counts.activeAssignments).toBe(1)
    expect(counts.durablyAdmitted).toBe(2)
  })

  it('reports provider waiting separately from physical execution', () => {
    const r = record({ tasks: { a: task('a', 'executing') } })
    const live = new Map<string, TaskLiveness>([
      ['a', { taskId: 'a', startedRealWork: true, waitingOnOwnedTool: false, providerWaiting: true }],
    ])
    const counts = countRun(r, live, 1)
    expect(counts.activeAssignments).toBe(1)
    expect(counts.providerWaiting).toBe(1)
  })

  it('reports tool waiting separately and inside active', () => {
    const r = record({ tasks: { a: task('a', 'executing') } })
    const live = new Map<string, TaskLiveness>([
      ['a', { taskId: 'a', startedRealWork: true, waitingOnOwnedTool: true, providerWaiting: false }],
    ])
    const counts = countRun(r, live, 1)
    expect(counts.activeAssignments).toBe(1)
    expect(counts.waitingOwnedTool).toBe(1)
  })

  it('keeps stopping and unknown holding their slots so N is never pierced', () => {
    // INV-C1 / INV-C4 / C07 / C08
    const r = record({
      requestedTarget: 3,
      tasks: {
        a: task('a', 'cancel_requested'),
        b: task('b', 'unknown'),
        c: task('c', 'executing'),
      },
    })
    const live = new Map<string, TaskLiveness>([
      ['c', { taskId: 'c', startedRealWork: true, waitingOnOwnedTool: false, providerWaiting: false }],
    ])
    // Target 3 with three tasks holding slots: exactly filled, no deficit.
    const counts = countRun(r, live, 3)
    expect(counts.stopping).toBe(1)
    expect(counts.quarantinedUnknown).toBe(1)
    expect(counts.activeAssignments).toBe(1)
    expect(counts.capacityDeficit).toBe(0)
    // Nothing new may start: all three slots are accounted for.
    expect(mayAdmit(r, counts, 0)).toBe(false)
  })

  it('keeps a slot reserved by stopping/unknown against a larger target', () => {
    // The same three tasks against target 10 leave seven free, NOT nine: the
    // requested-cancel and the unknown child are still occupying their slots.
    const r = record({
      tasks: {
        a: task('a', 'cancel_requested'),
        b: task('b', 'unknown'),
        c: task('c', 'executing'),
      },
    })
    const live = new Map<string, TaskLiveness>([
      ['c', { taskId: 'c', startedRealWork: true, waitingOnOwnedTool: false, providerWaiting: false }],
    ])
    const counts = countRun(r, live, 20)
    expect(counts.capacityDeficit).toBe(7)
    expect(counts.deficitReason).toBe('slots_held_by_unconfirmed')
  })
  it('never silently lowers the target when fewer tasks are ready', () => {
    // C04: a deficit is reported, not resolved by rewriting the goal.
    const r = record({ tasks: { a: task('a', 'executing') } })
    const live = new Map<string, TaskLiveness>([
      ['a', { taskId: 'a', startedRealWork: true, waitingOnOwnedTool: false, providerWaiting: false }],
    ])
    const counts = countRun(r, live, 3)
    expect(counts.desiredTarget).toBe(10)
    expect(counts.readyTasks).toBe(3)
    expect(counts.capacityDeficit).toBe(9)
    expect(counts.deficitReason).toBe('insufficient_ready_tasks')
  })

  it('names budget as the deficit reason when the ceiling is reached', () => {
    const r = record({
      budget: { currency: 'USD', priceVersion: 'v1', spent: 100, reserved: 0, unknownReserved: 0, ceiling: 100 },
    })
    const counts = countRun(r, new Map(), 10)
    expect(counts.deficitReason).toBe('budget_blocked')
    expect(mayAdmit(r, counts, 0)).toBe(false)
  })

  it('admits up to exactly the ceiling but not past it', () => {
    // The budget boundary is stated once, in `mayAdmit`, and this pins it.
    const r = record({
      budget: { currency: 'USD', priceVersion: 'v1', spent: 0, reserved: 0, unknownReserved: 0, ceiling: 10 },
    })
    const counts = countRun(r, new Map(), 10)
    expect(mayAdmit(r, counts, 10)).toBe(true)
    expect(mayAdmit(r, counts, 10.0001)).toBe(false)
  })

  it('reports budget_blocked and refuses admission from the same predicate', () => {
    // A system whose stated reason for a deficit disagrees with its admission
    // gate would report "blocked" while still admitting. Pin that they agree.
    const r = record({
      budget: { currency: 'USD', priceVersion: 'v1', spent: 5, reserved: 5, unknownReserved: 0, ceiling: 10 },
    })
    const counts = countRun(r, new Map(), 10)
    expect(counts.deficitReason).toBe('budget_blocked')
    expect(mayAdmit(r, counts, 0)).toBe(false)
  })

  it('refuses admission when the run is paused', () => {
    // INV-G4: a user pause outranks top-up.
    const r = record({ phase: 'paused' })
    const counts = countRun(r, new Map(), 10)
    expect(counts.deficitReason).toBe('run_not_open')
    expect(mayAdmit(r, counts, 0)).toBe(false)
  })

  it('reserves before admitting, so the last credit cannot be double-spent', () => {
    // C10: an unknown-cost launch keeps a conservative reservation.
    const r = record({
      budget: { currency: 'USD', priceVersion: 'v1', spent: 0, reserved: 0, unknownReserved: 5, ceiling: 10 },
    })
    const counts = countRun(r, new Map(), 10)
    expect(mayAdmit(r, counts, 6)).toBe(false)
    expect(mayAdmit(r, counts, 5)).toBe(true)
  })

  it('counts confirmed work as done without counting it as a held slot', () => {
    const r = record({ tasks: { a: task('a', 'confirmed'), b: task('b', 'executing') } })
    const live = new Map<string, TaskLiveness>([
      ['b', { taskId: 'b', startedRealWork: true, waitingOnOwnedTool: false, providerWaiting: false }],
    ])
    const counts = countRun(r, live, 10)
    expect(counts.confirmed).toBe(1)
    expect(counts.activeAssignments).toBe(1)
    // Only `b` holds a slot; `a` is confirmed and free.
    expect(counts.capacityDeficit).toBe(9)
  })

  it('reports deficit none when exactly filled', () => {
    const tasks: Record<string, TaskRecord> = {}
    const live = new Map<string, TaskLiveness>()
    for (let i = 0; i < 10; i += 1) {
      tasks[`t${i}`] = task(`t${i}`, 'executing')
      live.set(`t${i}`, { taskId: `t${i}`, startedRealWork: true, waitingOnOwnedTool: false, providerWaiting: false })
    }
    const counts = countRun(record({ tasks }), live, 20)
    expect(counts.activeAssignments).toBe(10)
    expect(counts.capacityDeficit).toBe(0)
    expect(counts.deficitReason).toBe('none')
    expect(mayAdmit(record({ tasks }), counts, 0)).toBe(false)
  })
})
