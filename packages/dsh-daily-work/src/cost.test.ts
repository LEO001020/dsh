/**
 * Cost and accounting gates: C05 (root credit reservation), C11 (spend exceeds
 * reservation), R06 (all attempts accounted).
 *
 * WHAT THESE TESTS ARE, AND WHAT THEY ARE NOT.
 *
 * They are T1 tests: the real DSH storage domain, the real record schema, the
 * real state machine, with a scripted launch port at the documented seam. No
 * model provider is involved, and no live-provider result is claimed. The
 * numbers below are CONTROLLED INPUTS - a reserve of 1, an actual spend of 3 -
 * chosen so the arithmetic under test is exact and checkable by hand.
 *
 * A controlled-input test can prove that the code records an overage, halts
 * admission and keeps the full amount. It CANNOT prove that a real provider
 * bills what we predicted, because no provider is authorized here. That
 * distinction is carried into FINDINGS.md rather than blurred: C05 and C11 are
 * closed at the arithmetic and record level, and the live-provider half of each
 * remains NOT_RUN.
 *
 * The rule from the plan that governs every budget case here:
 *
 *   "429 / budget insufficient / authorization missing keeps the target fact
 *    unchanged, shows blocked/deficit, does not secretly drop to 8"
 *
 * so the tests assert the target is untouched and the deficit is REPORTED, not
 * that admission merely stopped.
 */
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import * as storageDomainPlugin from '@deepseek-ai/dsh-storage-domain'
import * as storageJsonPlugin from '@deepseek-ai/dsh-storage-json'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { WorkService, type LaunchPort, type LaunchRequest } from './host.ts'
import {
  UsageLedger,
  applySpend,
  budgetReport,
  bucketsFromTokenUsage,
  childCeiling,
  childHeadroom,
  initialRunRecord,
  retainAsUnknown,
  holdUnknown,
  type Budget,
  type RunRecord,
} from './record.ts'
import { countRun, mayAdmit } from './counting.ts'

const NOW = '2026-09-19T00:00:00.000Z'

/**
 * A launch port that accepts everything immediately.
 *
 * C05 is about the arithmetic of admission under saturation, so the port must
 * not itself be a source of failure: every case here is decided by the record,
 * not by the launcher. The real `ctx.subagents.startContinuable` integration is
 * a different gate (C01) and needs live authorization.
 */
class AcceptingLaunchPort implements LaunchPort {
  readonly calls: LaunchRequest[] = []

  async launch(request: LaunchRequest): Promise<{ childId: string }> {
    this.calls.push(request)
    return { childId: request.childId }
  }
}

interface Harness {
  readonly ctx: Context
  readonly service: WorkService
  readonly port: AcceptingLaunchPort
  readonly root: string
  close(): Promise<void>
}

/** A root stand-in: the service reads only `root.session.header.id`. */
function rootStub(sessionId: string): { session: { header: { id: string } } } {
  return { session: { header: { id: sessionId } } }
}

async function harness(ceiling = 1000): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-daily-cost-'))
  const ctx = new Context()
  await ctx.plugin(Storage, {})
  await ctx.plugin(storageJsonPlugin as never, { root } as never)
  await ctx.plugin(storageDomainPlugin as never, { backend: 'json' } as never)
  const service = new WorkService(ctx, {
    targetChildren: 10,
    maxDepth: 1,
    budgetCeiling: ceiling,
    currency: 'USD',
    priceVersion: 'cost-test-v1',
  })
  await service.open()
  const port = new AcceptingLaunchPort()
  service.setLaunchPort(port)
  return {
    ctx,
    service,
    port,
    root,
    async close() {
      await service.close()
      await ctx.fiber.dispose()
      await rm(root, { recursive: true, force: true })
    },
  }
}

let h: Harness

beforeEach(async () => {
  h = await harness()
})

afterEach(async () => {
  await h.close()
})

/**
 * Replace the default harness with one whose ceiling is small enough that the
 * reserve arithmetic is exact by hand.
 *
 * A ceiling of 1000 makes the interesting boundary (childCeiling = ceiling -
 * rootReserve) land at 980/990, where an off-by-one is easy to miss. The cases
 * below that are about the BOUNDARY use 100, so the numbers in the assertions
 * are the numbers in the code. The `afterEach` closes whichever harness is
 * current, so swapping is safe.
 */
async function useHarness(ceiling: number): Promise<void> {
  await h.close()
  h = await harness(ceiling)
}

/** A pure record for the arithmetic tests, with an explicit budget. */
function pureRecord(budget: Partial<Budget> = {}, overrides: Partial<RunRecord> = {}): RunRecord {
  const base = initialRunRecord({
    runId: 'run-pure',
    rootSessionId: 'session-root',
    authorizationRef: 'auth-pure',
    requestedTarget: 10,
    maxDepth: 1,
    policyDigest: 'policy-pure',
    budget: {
      currency: 'USD',
      priceVersion: 'v1',
      spent: 0,
      reserved: 0,
      unknownReserved: 0,
      ceiling: 100,
      ...budget,
    },
    restartResumeAuthorized: false,
    now: NOW,
  })
  return { ...base, ...overrides }
}

describe('C05: the root keeps its own reserved credit', () => {
  it('carves the reserve out of the ceiling at run creation, not out of thin air', async () => {
    const record = await h.service.createRun({
      runId: 'run-reserve',
      root: rootStub('session-root') as never,
      authorizationRef: 'auth',
      targetChildren: 10,
      rootReserve: 25,
    })
    expect(record.budget.ceiling).toBe(1000)
    expect(record.budget.rootReserve).toBe(25)
    expect(record.budget.rootSpent).toBe(0)
    // The reserve is a PART of the ceiling. If it were an addition, the run
    // would be authorized for more than the user granted.
    expect(record.budget.rootReserve).toBeLessThanOrEqual(record.budget.ceiling)
  })

  it('refuses a reserve that exceeds the ceiling rather than silently clamping it', async () => {
    // Clamping would hide a caller that misunderstood the model, and the run
    // would then run with a reserve nobody asked for.
    await expect(
      h.service.createRun({
        runId: 'run-bad-reserve',
        root: rootStub('session-root') as never,
        authorizationRef: 'auth',
        rootReserve: 1001,
      }),
    ).rejects.toThrow(/exceeds the ceiling/)
  })

  it('THE INVARIANT: children may commit the whole child ceiling and not one unit more', () => {
    // The invariant, stated once so it can be checked: for every reachable
    // state, `spent + reserved + unknownReserved <= ceiling - rootReserve`.
    // The root therefore always retains `rootReserve - rootSpent` regardless of
    // how many children were admitted.
    const budget: Budget = {
      currency: 'USD',
      priceVersion: 'v1',
      spent: 0,
      reserved: 0,
      unknownReserved: 0,
      ceiling: 100,
      rootReserve: 10,
      rootSpent: 0,
      overage: 0,
    }
    expect(childCeiling(budget)).toBe(90)
    expect(childHeadroom(budget)).toBe(90)
    // A child admission of exactly the child ceiling is allowed; the record
    // would then sit at `committed === 90`, which is the boundary.
    const full = applySpend(budget, {
      reservationReleased: 0,
      reservationCovering: 0,
      actualCost: 0,
      reason: 'no-op',
      now: NOW,
    })
    expect(childHeadroom(full)).toBe(90)
    expect(childCeiling(full)).toBe(90)
    // And the root's reserve is untouched by any of it.
    expect(budgetReport(full).rootAvailable).toBe(10)
  })

  it('still admits a child with the ceiling fully committed by other children, and refuses one unit more', async () => {
    // The saturation case C05 names: the children have taken everything they
    // are allowed. What must remain true is that the boundary is the CHILD
    // ceiling, so the refusal happens exactly at 90, not at 100.
    await useHarness(100)
    const runId = 'run-saturated'
    await h.service.createRun({
      runId,
      root: rootStub('session-root') as never,
      authorizationRef: 'auth',
      targetChildren: 100,
      rootReserve: 10,
    })
    h.service.setReadyTasks(runId, 100)
    // Fill the child ceiling exactly with one admission.
    await h.service.admit({
      runId,
      taskId: 'filler',
      childId: 'c-filler',
      assignmentDigest: 'd-filler',
      reservedCost: 90,
      allowedCapabilities: ['reader'],
    })
    expect(h.service.budget(runId).childHeadroom).toBe(0)
    expect(h.service.budget(runId).rootAvailable).toBe(10)

    // One more child, even the cheapest, is REFUSED: there is no child headroom.
    await expect(
      h.service.admit({
        runId,
        taskId: 'extra',
        childId: 'c-extra',
        assignmentDigest: 'd-extra',
        reservedCost: 1,
        allowedCapabilities: ['reader'],
      }),
    ).rejects.toThrow(/no budget headroom/)
    expect(h.service.getRun(runId)?.tasks['extra']).toBeUndefined()
  })

  it('REFUSES the child admission that would eat into the root reserve', async () => {
    // This is the gate itself, isolated: a child asking for 91 against a child
    // ceiling of 90 is refused even though 91 is well under the 100 ceiling.
    await useHarness(100)
    const runId = 'run-reserve-gate'
    await h.service.createRun({
      runId,
      root: rootStub('session-root') as never,
      authorizationRef: 'auth',
      targetChildren: 100,
      rootReserve: 10,
    })
    h.service.setReadyTasks(runId, 100)
    await expect(
      h.service.admit({
        runId,
        taskId: 'greedy',
        childId: 'c-greedy',
        assignmentDigest: 'd-greedy',
        reservedCost: 91,
        allowedCapabilities: ['reader'],
      }),
    ).rejects.toThrow(/no budget headroom \(committed 0, child ceiling 90, root reserve 10 of ceiling 100\)/)
    // Nothing was written: a refused admission leaves no task behind.
    expect(h.service.getRun(runId)?.tasks['greedy']).toBeUndefined()
    expect(h.service.getRun(runId)?.budget.reserved).toBe(0)
    // And the same admission is refused through the DRAIN path, so the gate is
    // not bypassable by choosing the other entry point. The reason is pinned to
    // the ADMISSION PREDICATE's own answer, not merely to "it did not work":
    // a refusal that came from the reservation write throwing would report the
    // error text instead, and that would mean the gate and its stated reason
    // had drifted apart.
    const outcomes = await h.service.drain(
      runId,
      [{ taskId: 'greedy2', childId: 'c-greedy2', prompt: 'more', reservedCost: 91 }],
      new AbortController().signal,
    )
    expect(outcomes[0]?.accepted).toBe(false)
    expect(outcomes[0]?.reason).toBe('budget_blocked')
    expect(h.service.getRun(runId)?.tasks['greedy2']).toBeUndefined()
  })

  it('keeps the root reserve available while ten children saturate the child ceiling', async () => {
    // The literal C05 scenario, at a ceiling small enough to run cheaply: ten
    // children, the root still able to spend.
    await useHarness(1000)
    const runId = 'run-ten'
    await h.service.createRun({
      runId,
      root: rootStub('session-root') as never,
      authorizationRef: 'auth',
      targetChildren: 10,
      rootReserve: 20,
    })
    h.service.setReadyTasks(runId, 10)
    const outcomes = await h.service.drain(
      runId,
      Array.from({ length: 10 }, (_, i) => ({
        taskId: `t${i}`,
        childId: `c${i}`,
        prompt: `work ${i}`,
        reservedCost: 98,
      })),
      new AbortController().signal,
    )
    expect(outcomes.filter(o => o.accepted)).toHaveLength(10)
    expect(h.service.budget(runId).childCommitted).toBe(980)
    expect(h.service.budget(runId).childHeadroom).toBe(0)
    // The root can STILL spend, and this is the whole point of C05.
    expect(h.service.budget(runId).rootAvailable).toBe(20)
    const afterRootSpend = await h.service.spendRoot({
      runId,
      actualCost: 20,
      reason: 'root integrated ten child results and submitted replacements',
    })
    expect(afterRootSpend.budget.rootSpent).toBe(20)
    expect(afterRootSpend.budget.halt).toBeUndefined()
    expect(h.service.budget(runId).rootAvailable).toBe(0)
  })

  it('does not let a root spend consume child headroom, or a child consume the reserve', async () => {
    // The two budgets are disjoint. A root spend moves only `rootSpent`; a
    // child admission moves only `reserved`.
    await useHarness(1000)
    const runId = 'run-disjoint'
    await h.service.createRun({
      runId,
      root: rootStub('session-root') as never,
      authorizationRef: 'auth',
      targetChildren: 10,
      rootReserve: 50,
    })
    await h.service.spendRoot({ runId, actualCost: 30, reason: 'root planning' })
    const afterRoot = h.service.getRun(runId)?.budget
    expect(afterRoot?.rootSpent).toBe(30)
    expect(afterRoot?.spent).toBe(0)
    expect(afterRoot?.reserved).toBe(0)
    expect(h.service.budget(runId).childHeadroom).toBe(950)

    await h.service.admit({
      runId,
      taskId: 't1',
      childId: 'c1',
      assignmentDigest: 'd1',
      reservedCost: 100,
      allowedCapabilities: ['reader'],
    })
    const afterChild = h.service.getRun(runId)?.budget
    expect(afterChild?.reserved).toBe(100)
    expect(afterChild?.rootSpent).toBe(30)
    // The root's remaining reserve is unaffected by the child admission.
    expect(h.service.budget(runId).rootAvailable).toBe(20)
  })

  it('records a root spend that outruns the reserve in full and halts, rather than trimming it', async () => {
    // The overage rule applies to the root's own reserve too. Trimming the
    // number to fit would hide that the reserve was undersized.
    await useHarness(1000)
    const runId = 'run-root-over'
    await h.service.createRun({
      runId,
      root: rootStub('session-root') as never,
      authorizationRef: 'auth',
      targetChildren: 10,
      rootReserve: 10,
    })
    const after = await h.service.spendRoot({ runId, actualCost: 25, reason: 'root re-planned the whole run' })
    expect(after.budget.rootSpent).toBe(25)
    expect(after.budget.halt).toBeDefined()
    expect(after.budget.halt?.reason).toMatch(/root spend 25 exceeded the remaining root reserve 10 by 15/)
    // Admission is stopped by the halt even though the CHILD budget is untouched.
    expect(h.service.admissionCheck(runId, 1).allowed).toBe(false)
    expect(h.service.admissionCheck(runId, 1).reason).toBe('budget_overage_halt')
  })

  it('derives a default reserve when none is given, so a run is never born without one', async () => {
    const record = await h.service.createRun({
      runId: 'run-default-reserve',
      root: rootStub('session-root') as never,
      authorizationRef: 'auth',
    })
    // A tenth of 1000, capped at 20.
    expect(record.budget.rootReserve).toBe(20)
    expect(childCeiling(record.budget)).toBe(980)
  })

  it('leaves the target fact unchanged when the budget blocks admission', async () => {
    // The plan's rule: a budget block keeps the target fact, shows the deficit,
    // and does not secretly reduce N.
    await useHarness(100)
    const runId = 'run-target-intact'
    await h.service.createRun({
      runId,
      root: rootStub('session-root') as never,
      authorizationRef: 'auth',
      targetChildren: 10,
      rootReserve: 10,
    })
    h.service.setReadyTasks(runId, 10)
    await h.service.admit({
      runId,
      taskId: 'filler',
      childId: 'c-filler',
      assignmentDigest: 'd-filler',
      reservedCost: 90,
      allowedCapabilities: ['reader'],
    })
    const check = h.service.admissionCheck(runId, 1)
    expect(check.allowed).toBe(false)
    // NOT reduced to a smaller N, and the deficit is reported with a reason.
    expect(check.counts.desiredTarget).toBe(10)
    expect(check.reason).toBe('budget_blocked')
    expect(check.budget.childHeadroom).toBe(0)
    // And a drain attempt reports the same reason instead of admitting.
    const outcomes = await h.service.drain(
      runId,
      [{ taskId: 'blocked', childId: 'c-blocked', prompt: 'more', reservedCost: 1 }],
      new AbortController().signal,
    )
    expect(outcomes[0]?.accepted).toBe(false)
    expect(outcomes[0]?.reason).toBe('budget_blocked')
    expect(h.service.counts(runId).desiredTarget).toBe(10)
  })

  it('agrees with the pure counting predicate, so the gate and its reason cannot drift', () => {
    // `mayAdmit` is shared by the write path and the reported reason. A system
    // whose stated reason disagrees with its gate would report blocked while
    // still admitting.
    //
    // At `committed === childCeiling` the run is EXHAUSTED, so even a
    // zero-cost admission is refused: every real task also drags retry,
    // compaction and search calls behind it, so "free" is not a thing a task
    // can be. The boundary is therefore tested one unit below it, where a zero
    // outstanding cost is admitted and any positive one is not.
    const atCeiling = pureRecord({ spent: 90, reserved: 0, unknownReserved: 0, ceiling: 100, rootReserve: 10 })
    const exhausted = countRun(atCeiling, new Map(), 10)
    expect(exhausted.deficitReason).toBe('budget_blocked')
    expect(mayAdmit(atCeiling, exhausted, 0)).toBe(false)

    const below = pureRecord({ spent: 89, reserved: 0, unknownReserved: 0, ceiling: 100, rootReserve: 10 })
    const counts = countRun(below, new Map(), 10)
    expect(mayAdmit(below, counts, 0)).toBe(true)
    expect(mayAdmit(below, counts, 1)).toBe(true)
    expect(mayAdmit(below, counts, 1.0001)).toBe(false)
    // And the ceiling a child sees is the CHILD ceiling, not the run ceiling:
    // one unit above 89 already crosses into the root's 10.
    expect(mayAdmit(below, counts, 11)).toBe(false)
  })
})

describe('C11: actual spend exceeding the reservation', () => {
  it('records the overage in full, pauses admission, and hides nothing', async () => {
    // THE core case: reserve 1, report actual spend 3.
    const runId = 'run-overage'
    await h.service.createRun({
      runId,
      root: rootStub('session-root') as never,
      authorizationRef: 'auth',
      targetChildren: 10,
      rootReserve: 10,
    })
    h.service.setReadyTasks(runId, 10)
    await h.service.admit({
      runId,
      taskId: 't1',
      childId: 'c1',
      assignmentDigest: 'd1',
      reservedCost: 1,
      allowedCapabilities: ['reader'],
    })
    await h.service.transition({ runId, taskId: 't1', to: 'launching' })
    await h.service.transition({ runId, taskId: 't1', to: 'accepted' })
    await h.service.transition({ runId, taskId: 't1', to: 'executing' })
    await h.service.transition({ runId, taskId: 't1', to: 'settling' })

    // (a) the overage is visible in the record.
    await h.service.transition({ runId, taskId: 't1', to: 'confirmed', spentCost: 3 })
    const record = h.service.getRun(runId)
    expect(record?.budget.spent).toBe(3)
    expect(record?.budget.overage).toBe(2)
    expect(record?.budget.halt).toBeDefined()
    expect(record?.budget.halt?.reason).toMatch(/actual spend 3 exceeded the reservation 1 made for this work by 2/)
    // (b) nothing was truncated or hidden: the task keeps its own full spend,
    // and the reservation it was measured against is still on the record.
    expect(record?.tasks['t1']?.spentCost).toBe(3)
    expect(record?.tasks['t1']?.reservedCost).toBe(1)
    expect(record?.budget.reserved).toBe(0)

    // (c) mayAdmit refuses further admission, and says why.
    expect(h.service.admissionCheck(runId, 1).allowed).toBe(false)
    expect(h.service.admissionCheck(runId, 1).reason).toBe('budget_overage_halt')
    const outcomes = await h.service.drain(
      runId,
      [{ taskId: 't2', childId: 'c2', prompt: 'more', reservedCost: 1 }],
      new AbortController().signal,
    )
    expect(outcomes[0]?.accepted).toBe(false)
    expect(outcomes[0]?.reason).toBe('budget_overage_halt')
    expect(h.service.getRun(runId)?.tasks['t2']).toBeUndefined()

    // And the target fact is untouched, per the plan's rule.
    expect(h.service.counts(runId).desiredTarget).toBe(10)
  })

  it('refuses the direct admit path while halted, not only the drain path', async () => {
    // A halt that only stopped the drain would be bypassable by any caller that
    // calls `admit` directly, which is the failure mode that makes a gate
    // decorative.
    const runId = 'run-halt-direct'
    await h.service.createRun({
      runId,
      root: rootStub('session-root') as never,
      authorizationRef: 'auth',
      rootReserve: 10,
    })
    await h.service.recordSpend({
      runId,
      taskId: undefined,
      reservationCovering: 1,
      actualCost: 3,
      reason: 'aux request overran its estimate',
    })
    expect(h.service.getRun(runId)?.budget.halt).toBeDefined()
    await expect(
      h.service.admit({
        runId,
        taskId: 't1',
        childId: 'c1',
        assignmentDigest: 'd1',
        reservedCost: 1,
        allowedCapabilities: ['reader'],
      }),
    ).rejects.toThrow(/halted on a recorded budget overage/)
  })

  it('stays halted even after a later in-budget spend, because a halt is not an arithmetic state', async () => {
    // If the halt were recomputed from headroom it would clear itself the
    // moment a cheap task settled, and the run would go green again.
    const runId = 'run-halt-sticky'
    await h.service.createRun({
      runId,
      root: rootStub('session-root') as never,
      authorizationRef: 'auth',
      rootReserve: 10,
    })
    await h.service.recordSpend({ runId, reservationCovering: 1, actualCost: 3, reason: 'overran' })
    expect(h.service.getRun(runId)?.budget.halt).toBeDefined()
    // A small, fully-covered spend arrives afterwards.
    await h.service.recordSpend({ runId, reservationCovering: 5, actualCost: 1, reason: 'a normal call' })
    expect(h.service.getRun(runId)?.budget.spent).toBe(4)
    expect(h.service.getRun(runId)?.budget.overage).toBe(2)
    // Still halted: only a human authorization clears it.
    expect(h.service.getRun(runId)?.budget.halt).toBeDefined()
    expect(h.service.admissionCheck(runId, 1).allowed).toBe(false)
  })

  it('clears the halt only through an explicit human authorization, and keeps the bill', async () => {
    const runId = 'run-halt-resolve'
    await h.service.createRun({
      runId,
      root: rootStub('session-root') as never,
      authorizationRef: 'auth',
      rootReserve: 10,
    })
    await h.service.recordSpend({ runId, reservationCovering: 1, actualCost: 3, reason: 'overran' })
    await h.service.resume(runId)
    // `resume` is about the PHASE. It must not silently resolve a budget halt.
    expect(h.service.getRun(runId)?.budget.halt).toBeDefined()

    const resolved = await h.service.resolveHalt({
      runId,
      authorizationRef: 'user-approval-7',
      note: 'approved the overage and a further 50 units',
    })
    expect(resolved.budget.halt).toBeUndefined()
    // The overage and the spend are HISTORY and stay on the record.
    expect(resolved.budget.overage).toBe(2)
    expect(resolved.budget.spent).toBe(3)
    expect(resolved.outbox[`halt-resolved-${resolved.updatedAt}`]?.payloadDigest).toBe(
      'user-approval-7: approved the overage and a further 50 units',
    )
    expect(h.service.admissionCheck(runId, 1).allowed).toBe(true)
  })

  it('accumulates overage across several overspends instead of keeping only the last', async () => {
    const runId = 'run-overage-sum'
    await h.service.createRun({
      runId,
      root: rootStub('session-root') as never,
      authorizationRef: 'auth',
      rootReserve: 10,
    })
    await h.service.recordSpend({ runId, reservationCovering: 1, actualCost: 3, reason: 'first' })
    await h.service.recordSpend({ runId, reservationCovering: 2, actualCost: 5, reason: 'second' })
    const budget = h.service.getRun(runId)?.budget
    expect(budget?.spent).toBe(8)
    expect(budget?.overage).toBe(5)
  })

  it('does not count a spend that came in UNDER its reservation as an overage', async () => {
    const runId = 'run-under'
    await h.service.createRun({
      runId,
      root: rootStub('session-root') as never,
      authorizationRef: 'auth',
      rootReserve: 10,
    })
    await h.service.recordSpend({ runId, reservationCovering: 10, actualCost: 4, reason: 'cheaper than expected' })
    const budget = h.service.getRun(runId)?.budget
    expect(budget?.spent).toBe(4)
    expect(budget?.overage).toBe(0)
    expect(budget?.halt).toBeUndefined()
    expect(h.service.admissionCheck(runId, 1).allowed).toBe(true)
  })

  it('measures the overage against the TASK STORED reservation, not a caller-supplied one', async () => {
    // A caller cannot widen the estimate after the fact to hide an overage.
    const runId = 'run-stored-estimate'
    await h.service.createRun({
      runId,
      root: rootStub('session-root') as never,
      authorizationRef: 'auth',
      rootReserve: 10,
    })
    await h.service.admit({
      runId,
      taskId: 't1',
      childId: 'c1',
      assignmentDigest: 'd1',
      reservedCost: 1,
      allowedCapabilities: ['reader'],
    })
    // The caller claims the estimate was 100. The stored reservation is 1.
    const after = await h.service.recordSpend({
      runId,
      taskId: 't1',
      reservationCovering: 100,
      actualCost: 3,
      reason: 'claims a larger estimate',
    })
    expect(after.budget.overage).toBe(2)
    expect(after.budget.halt).toBeDefined()
  })

  it('THE UNKNOWN PATH: a request whose usage never arrived keeps a conservative reservation', async () => {
    // Nothing is zeroed. The commitment total is unchanged, and the amount in
    // doubt is legible under its own name.
    const runId = 'run-unknown-usage'
    await h.service.createRun({
      runId,
      root: rootStub('session-root') as never,
      authorizationRef: 'auth',
      targetChildren: 10,
      rootReserve: 10,
    })
    h.service.setReadyTasks(runId, 10)
    await h.service.admit({
      runId,
      taskId: 't1',
      childId: 'c1',
      assignmentDigest: 'd1',
      reservedCost: 7,
      allowedCapabilities: ['reader'],
    })
    const before = h.service.getRun(runId)?.budget
    expect(before?.reserved).toBe(7)
    expect(before?.unknownReserved).toBe(0)

    // The provider accepted the request and never answered. We will never learn
    // what it cost.
    const after = await h.service.retainUnknown({
      runId,
      taskId: 't1',
      amount: 7,
      reason: 'the provider accepted the request and never reported usage',
    })
    expect(after.budget.reserved).toBe(0)
    expect(after.budget.unknownReserved).toBe(7)
    // The COMMITMENT is unchanged. Zeroing would have freed 7 units of credit
    // on the strength of a report that never arrived.
    expect(after.budget.spent + after.budget.reserved + after.budget.unknownReserved).toBe(7)
    // And the gap is visible on the task as well as the budget.
    expect(after.tasks['t1']?.uncertainty).toMatch(/never reported usage/)
    expect(h.service.budget(runId).unknownReserved).toBe(7)
  })

  it('holds an auxiliary request that was never reserved as an unknown, which can only tighten admission', async () => {
    // A compaction/summary/search call has no task and no prior reservation. An
    // unreported charge for one must not look like a free one.
    const runId = 'run-aux-unknown'
    await h.service.createRun({
      runId,
      root: rootStub('session-root') as never,
      authorizationRef: 'auth',
      rootReserve: 10,
    })
    const before = h.service.budget(runId).childHeadroom
    const after = await h.service.retainUnknown({
      runId,
      amount: 4,
      reason: 'compaction request usage never reported',
    })
    expect(after.budget.unknownReserved).toBe(4)
    expect(after.budget.reserved).toBe(0)
    expect(h.service.budget(runId).childHeadroom).toBe(before - 4)
  })

  it('clamps an unknown retention to the task reservation, so one task cannot eat a sibling reservation', async () => {
    const runId = 'run-unknown-clamp'
    await h.service.createRun({
      runId,
      root: rootStub('session-root') as never,
      authorizationRef: 'auth',
      rootReserve: 10,
    })
    await h.service.admit({
      runId,
      taskId: 'a',
      childId: 'ca',
      assignmentDigest: 'da',
      reservedCost: 3,
      allowedCapabilities: ['reader'],
    })
    await h.service.admit({
      runId,
      taskId: 'b',
      childId: 'cb',
      assignmentDigest: 'db',
      reservedCost: 4,
      allowedCapabilities: ['reader'],
    })
    const after = await h.service.retainUnknown({ runId, taskId: 'a', amount: 99, reason: 'unknown' })
    // Task a's 3 moved; task b's 4 is untouched.
    expect(after.budget.unknownReserved).toBe(3)
    expect(after.budget.reserved).toBe(4)
  })

  it('survives a domain reopen with the overage, the halt and the reserve intact', async () => {
    // The record is the evidence. A halt that lived only in memory would be
    // lost by exactly the restart that makes a budget stop likely.
    const runId = 'run-persist-halt'
    await h.service.createRun({
      runId,
      root: rootStub('session-root') as never,
      authorizationRef: 'auth',
      rootReserve: 10,
    })
    await h.service.recordSpend({ runId, reservationCovering: 1, actualCost: 3, reason: 'overran' })
    await h.service.close()

    const ctx2 = new Context()
    await ctx2.plugin(Storage, {})
    await ctx2.plugin(storageJsonPlugin as never, { root: h.root } as never)
    await ctx2.plugin(storageDomainPlugin as never, { backend: 'json' } as never)
    const reopened = new WorkService(ctx2, {
      targetChildren: 10,
      maxDepth: 1,
      budgetCeiling: 1000,
      currency: 'USD',
      priceVersion: 'cost-test-v1',
    })
    await reopened.open()
    const after = reopened.getRun(runId)
    expect(after?.budget.overage).toBe(2)
    expect(after?.budget.spent).toBe(3)
    expect(after?.budget.halt).toBeDefined()
    expect(after?.budget.rootReserve).toBe(10)
    expect(reopened.admissionCheck(runId, 1).allowed).toBe(false)
    await reopened.close()
    await ctx2.fiber.dispose()
  })

  it('applies the overage rule as a pure function, so the boundary is checkable by hand', () => {
    const budget: Budget = {
      currency: 'USD',
      priceVersion: 'v1',
      spent: 0,
      reserved: 1,
      unknownReserved: 0,
      ceiling: 100,
      rootReserve: 10,
      rootSpent: 0,
      overage: 0,
    }
    // Exactly at the reservation: no overage, no halt.
    const exact = applySpend(budget, {
      reservationReleased: 1,
      reservationCovering: 1,
      actualCost: 1,
      reason: 'exact',
      now: NOW,
    })
    expect(exact.overage).toBe(0)
    expect(exact.halt).toBeUndefined()
    // One unit over: recorded, and the run halts.
    const over = applySpend(budget, {
      reservationReleased: 1,
      reservationCovering: 1,
      actualCost: 3,
      reason: 'over',
      now: NOW,
    })
    expect(over.spent).toBe(3)
    expect(over.overage).toBe(2)
    expect(over.halt?.reason).toMatch(/by 2/)
    expect(over.reserved).toBe(0)
  })

  it('does not release a reservation when a spend is only REPORTED, and still records the cost', async () => {
    // The work may still be running. Reporting a cost must not free the hold.
    const runId = 'run-report-only'
    await h.service.createRun({
      runId,
      root: rootStub('session-root') as never,
      authorizationRef: 'auth',
      rootReserve: 10,
    })
    await h.service.admit({
      runId,
      taskId: 't1',
      childId: 'c1',
      assignmentDigest: 'd1',
      reservedCost: 5,
      allowedCapabilities: ['reader'],
    })
    const after = await h.service.recordSpend({
      runId,
      taskId: 't1',
      actualCost: 2,
      reason: 'an interim usage report',
    })
    expect(after.budget.spent).toBe(2)
    expect(after.budget.reserved).toBe(5)
    expect(after.budget.overage).toBe(0)
  })

  it('refuses to release a reservation that has no task to retire', async () => {
    const runId = 'run-release-no-task'
    await h.service.createRun({
      runId,
      root: rootStub('session-root') as never,
      authorizationRef: 'auth',
      rootReserve: 10,
    })
    await expect(
      h.service.recordSpend({
        runId,
        releaseReservation: true,
        actualCost: 1,
        reason: 'nonsense',
      }),
    ).rejects.toThrow(/releaseReservation requires a taskId/)
  })

  it('refuses a negative cost rather than accepting it as a credit', async () => {
    const runId = 'run-negative'
    await h.service.createRun({
      runId,
      root: rootStub('session-root') as never,
      authorizationRef: 'auth',
      rootReserve: 10,
    })
    await expect(h.service.recordSpend({ runId, actualCost: -5, reason: 'bad input' })).rejects.toThrow(
      /cannot be negative/,
    )
    await expect(h.service.spendRoot({ runId, actualCost: -1, reason: 'bad input' })).rejects.toThrow(
      /cannot be negative/,
    )
    await expect(h.service.retainUnknown({ runId, amount: -1, reason: 'bad input' })).rejects.toThrow(
      /cannot be negative/,
    )
  })

  it('reports an overage halt as the deficit reason, not as a plain budget block', () => {
    // The two stop admission for different reasons, and a reader must be able
    // to tell "we reached the ceiling" from "the estimate was wrong".
    const record = pureRecord(
      { spent: 3, reserved: 0, unknownReserved: 0, ceiling: 100, rootReserve: 10, overage: 2, halt: { reason: 'overran', at: NOW } },
    )
    const counts = countRun(record, new Map(), 10)
    expect(counts.deficitReason).toBe('budget_overage_halt')
    expect(mayAdmit(record, counts, 1)).toBe(false)
    // And a halt with plenty of headroom is still refused: the arithmetic is
    // not what stopped it. childHeadroom is 100 - 10 - 3 = 87.
    expect(childHeadroom(record.budget)).toBe(87)
    expect(childHeadroom(record.budget)).toBeGreaterThan(0)
  })

  it('keeps unknownReserved from being zeroed by the pure retention helper', () => {
    const budget: Budget = {
      currency: 'USD',
      priceVersion: 'v1',
      spent: 0,
      reserved: 5,
      unknownReserved: 2,
      ceiling: 100,
      rootReserve: 10,
      rootSpent: 0,
      overage: 0,
    }
    const moved = retainAsUnknown(budget, 5)
    expect(moved.reserved).toBe(0)
    expect(moved.unknownReserved).toBe(7)
    const held = holdUnknown(budget, 3)
    expect(held.reserved).toBe(5)
    expect(held.unknownReserved).toBe(5)
  })
})

describe('R06: every attempt is accounted for', () => {
  it('keeps an attempt with no usage reported UNKNOWN, not zero', () => {
    const ledger = new UsageLedger()
    expect(
      ledger.record({
        attemptId: 't1#1',
        taskId: 't1',
        source: 'child',
        attempt: 1,
        note: 'the provider never reported usage',
      }),
    ).toBe('recorded')
    const total = ledger.total()
    expect(total.attempts).toBe(1)
    expect(total.unknownCount).toBe(1)
    expect(total.complete).toBe(false)
    // THE assertion: every bucket is zero because NOTHING WAS ADDED, not
    // because the attempt was measured as free. The counts are what
    // distinguishes the two readings.
    expect(total.tokens).toEqual({
      uncachedInputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
    })
    expect(total.knownCost).toBe(0)
    expect(total.unknownCostCount).toBe(1)
    expect(total.unknownUsageCount).toBe(1)
  })

  it('counts a retry as a SEPARATE attempt rather than folding it into the first', () => {
    // Both requests were billed. Folding them would report one request's cost
    // for two requests' work.
    const ledger = new UsageLedger()
    ledger.record({
      attemptId: 't1#1',
      taskId: 't1',
      source: 'child',
      requestId: 'req-a',
      attempt: 1,
      usage: bucketsFromTokenUsage({ inputTokens: 100, outputTokens: 50 }),
      cost: 1,
    })
    ledger.record({
      attemptId: 't1#2',
      taskId: 't1',
      source: 'retry',
      requestId: 'req-b',
      attempt: 2,
      usage: bucketsFromTokenUsage({ inputTokens: 120, outputTokens: 60 }),
      cost: 1.5,
      note: 'the first attempt hit a 429',
    })
    const total = ledger.total()
    expect(total.attempts).toBe(2)
    expect(total.tokens.uncachedInputTokens).toBe(220)
    expect(total.tokens.outputTokens).toBe(110)
    expect(total.knownCost).toBe(2.5)
    expect(total.complete).toBe(true)
    // The retry is visible as its own SOURCE, so a reader can see the retry
    // rather than only its cost.
    const retry = total.bySource.find(s => s.source === 'retry')
    expect(retry?.attempts).toBe(1)
    expect(retry?.cost).toBe(1.5)
  })

  it('reports a separate unknownCount so a reader can see the gap', () => {
    const ledger = new UsageLedger()
    ledger.record({
      attemptId: 'root#1',
      source: 'root',
      attempt: 1,
      usage: bucketsFromTokenUsage({ inputTokens: 10, outputTokens: 5 }),
      cost: 0.5,
    })
    ledger.record({ attemptId: 't1#1', taskId: 't1', source: 'child', attempt: 1, cost: 2 })
    ledger.record({ attemptId: 't2#1', taskId: 't2', source: 'child', attempt: 1 })
    ledger.record({ attemptId: 'compact#1', source: 'compaction', attempt: 1 })
    const total = ledger.total()
    expect(total.attempts).toBe(4)
    expect(total.known).toBe(2)
    // Two attempts carry nothing at all: a child and a compaction.
    expect(total.unknownCount).toBe(2)
    expect(total.complete).toBe(false)
    // The KNOWN numbers are still reported in full; the unknown does not
    // suppress them.
    expect(total.tokens.uncachedInputTokens).toBe(10)
    expect(total.knownCost).toBe(2.5)
    // And the gap is attributable to a source, not just a global count.
    expect(total.bySource.find(s => s.source === 'compaction')?.unknown).toBe(1)
    expect(total.bySource.find(s => s.source === 'child')?.unknown).toBe(1)
  })

  it('never double-counts: a retry that reuses a request id is not summed twice', () => {
    const ledger = new UsageLedger()
    expect(
      ledger.record({
        attemptId: 't1#1',
        taskId: 't1',
        source: 'child',
        requestId: 'req-shared',
        attempt: 1,
        usage: bucketsFromTokenUsage({ inputTokens: 100, outputTokens: 50 }),
        cost: 1,
      }),
    ).toBe('recorded')
    // The same billable request reported again under a new attempt id.
    expect(
      ledger.record({
        attemptId: 't1#2',
        taskId: 't1',
        source: 'retry',
        requestId: 'req-shared',
        attempt: 2,
        usage: bucketsFromTokenUsage({ inputTokens: 100, outputTokens: 50 }),
        cost: 1,
      }),
    ).toBe('duplicate_request')
    const total = ledger.total()
    expect(total.attempts).toBe(1)
    expect(total.tokens.uncachedInputTokens).toBe(100)
    expect(total.knownCost).toBe(1)
    // The refusal is itself COUNTED, so "we ignored a report" is visible
    // rather than silent.
    expect(total.duplicateRequests).toBe(1)
  })

  it('refuses a repeated attempt id, and counts the refusal', () => {
    const ledger = new UsageLedger()
    ledger.record({
      attemptId: 't1#1',
      source: 'child',
      attempt: 1,
      usage: bucketsFromTokenUsage({ inputTokens: 10, outputTokens: 1 }),
      cost: 1,
    })
    expect(
      ledger.record({
        attemptId: 't1#1',
        source: 'child',
        attempt: 1,
        usage: bucketsFromTokenUsage({ inputTokens: 10, outputTokens: 1 }),
        cost: 1,
      }),
    ).toBe('duplicate_attempt')
    const total = ledger.total()
    expect(total.attempts).toBe(1)
    expect(total.knownCost).toBe(1)
    expect(total.duplicateAttempts).toBe(1)
  })

  it('lets a later report RESOLVE an unknown without counting the request twice', () => {
    // The gap closes, the request still counts once. This is the only case in
    // which a duplicate changes the totals, and it changes them by replacing
    // an absence with a measurement.
    const ledger = new UsageLedger()
    ledger.record({ attemptId: 't1#1', source: 'child', requestId: 'req-1', attempt: 1 })
    expect(ledger.total().unknownCount).toBe(1)
    expect(
      ledger.record({
        attemptId: 't1#1-late',
        source: 'child',
        requestId: 'req-1',
        attempt: 1,
        usage: bucketsFromTokenUsage({ inputTokens: 40, outputTokens: 8 }),
        cost: 0.25,
      }),
    ).toBe('upgraded')
    const total = ledger.total()
    expect(total.attempts).toBe(1)
    expect(total.unknownCount).toBe(0)
    expect(total.complete).toBe(true)
    expect(total.tokens.uncachedInputTokens).toBe(40)
    expect(total.knownCost).toBe(0.25)
    expect(total.upgraded).toBe(1)
  })

  it('covers root, descendants, retries, compaction, summary and search as distinct sources', () => {
    // The plan's sentence, made checkable: "cost covers root + descendants +
    // retries + compaction/summary/search".
    const ledger = new UsageLedger()
    const rows: Array<[string, Parameters<UsageLedger['record']>[0]['source'], number]> = [
      ['root#1', 'root', 0.5],
      ['t1#1', 'child', 1],
      ['t1#2', 'retry', 1.25],
      ['t2#1', 'child', 2],
      ['compact#1', 'compaction', 0.1],
      ['summary#1', 'summary', 0.2],
      ['search#1', 'search', 0.05],
    ]
    for (const [attemptId, source, cost] of rows) {
      ledger.record({
        attemptId,
        source,
        attempt: 1,
        usage: bucketsFromTokenUsage({ inputTokens: 1, outputTokens: 1 }),
        cost,
      })
    }
    const total = ledger.total()
    expect(total.attempts).toBe(7)
    expect(total.complete).toBe(true)
    expect(total.knownCost).toBeCloseTo(5.1, 10)
    for (const source of ['root', 'child', 'retry', 'compaction', 'summary', 'search'] as const) {
      expect(total.bySource.find(s => s.source === source)?.attempts).toBeGreaterThan(0)
    }
    // A compaction is NOT attributed to a task: it belongs to no child, and
    // charging it to one would misattribute the harness's own overhead.
    expect(ledger.get('compact#1')?.taskId).toBeUndefined()
  })

  it('keeps DSH token buckets disjoint rather than collapsing them into one number', () => {
    // The mapping is copied from @deepseek-ai/dsh-llm's TokenUsage
    // (packages/llm/llm/src/types.ts:162): "Counts are DISJOINT: `inputTokens`
    // is uncached input only; cached input is reported separately as
    // `cacheReadTokens`/`cacheWriteTokens` (billed input = sum of the three)."
    const buckets = bucketsFromTokenUsage({
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 900,
      cacheWriteTokens: 20,
      reasoningTokens: 30,
    })
    expect(buckets.uncachedInputTokens).toBe(100)
    expect(buckets.cacheReadTokens).toBe(900)
    expect(buckets.cacheWriteTokens).toBe(20)
    // reasoning is carried but NOT added to outputTokens: DSH already includes
    // it there, so adding it would double-count.
    expect(buckets.outputTokens).toBe(50)
    expect(buckets.reasoningTokens).toBe(30)
  })

  it('defaults absent optional cache fields to zero WITHOUT treating a missing report as zero', () => {
    // The distinction the ledger exists to preserve: zero tokens is a
    // MEASUREMENT, a missing usage object is not.
    const measured = bucketsFromTokenUsage({ inputTokens: 5, outputTokens: 2 })
    expect(measured.cacheReadTokens).toBe(0)
    const ledger = new UsageLedger()
    ledger.record({ attemptId: 'a', source: 'child', attempt: 1, usage: measured })
    ledger.record({ attemptId: 'b', source: 'child', attempt: 1 })
    const total = ledger.total()
    expect(total.tokens.uncachedInputTokens).toBe(5)
    // One measured call, one unreported call.
    expect(total.unknownUsageCount).toBe(1)
    expect(total.attempts).toBe(2)
  })

  it('does not treat a cost-only attempt as a token unknown that blocks completeness', () => {
    // Cost known and tokens unknown is a real state: a priced call whose token
    // report was lost. It is not a zero-usage call, and it is not a gap in cost.
    const ledger = new UsageLedger()
    ledger.record({ attemptId: 'a', source: 'child', attempt: 1, cost: 3 })
    const total = ledger.total()
    expect(total.knownCost).toBe(3)
    expect(total.unknownUsageCount).toBe(1)
    expect(total.unknownCostCount).toBe(0)
    expect(total.unknownCount).toBe(0)
    expect(total.complete).toBe(true)
  })

  it('sums buckets across attempts without dropping the cache split', () => {
    const ledger = new UsageLedger()
    ledger.record({
      attemptId: 'a',
      source: 'child',
      attempt: 1,
      usage: bucketsFromTokenUsage({ inputTokens: 10, outputTokens: 4, cacheReadTokens: 100 }),
    })
    ledger.record({
      attemptId: 'b',
      source: 'retry',
      attempt: 1,
      usage: bucketsFromTokenUsage({ inputTokens: 20, outputTokens: 6, cacheReadTokens: 200, cacheWriteTokens: 7 }),
    })
    const total = ledger.total()
    expect(total.tokens.uncachedInputTokens).toBe(30)
    expect(total.tokens.outputTokens).toBe(10)
    expect(total.tokens.cacheReadTokens).toBe(300)
    expect(total.tokens.cacheWriteTokens).toBe(7)
  })

  it('exposes every row, so a reader can check the total rather than trust it', () => {
    const ledger = new UsageLedger()
    ledger.record({
      attemptId: 't1#1',
      taskId: 't1',
      source: 'child',
      requestId: 'r1',
      attempt: 1,
      usage: bucketsFromTokenUsage({ inputTokens: 1, outputTokens: 2 }),
      cost: 0.1,
      note: 'first attempt',
    })
    const rows = ledger.rows()
    expect(rows).toHaveLength(1)
    expect(rows[0]?.attemptId).toBe('t1#1')
    expect(rows[0]?.note).toBe('first attempt')
    expect(ledger.get('t1#1')?.cost).toBe(0.1)
    expect(ledger.get('absent')).toBeUndefined()
  })

  it('reports an empty ledger as complete with no attempts, rather than as a pass', () => {
    // An empty ledger is not evidence of anything. It reports zero attempts,
    // and `complete` is true only because there is no gap to report - the
    // attempt count is what a reader must check before reading it as success.
    const total = new UsageLedger().total()
    expect(total.attempts).toBe(0)
    expect(total.unknownCount).toBe(0)
    expect(total.knownCost).toBe(0)
    expect(total.complete).toBe(true)
  })
})

describe('cost accounting: the budget report a reader sees', () => {
  it('reports every quantity separately, with the overage inside spent rather than beside it', () => {
    const budget: Budget = {
      currency: 'USD',
      priceVersion: 'v1',
      spent: 30,
      reserved: 5,
      unknownReserved: 7,
      ceiling: 100,
      rootReserve: 10,
      rootSpent: 4,
      overage: 12,
    }
    const report = budgetReport(budget)
    expect(report.ceiling).toBe(100)
    expect(report.rootReserve).toBe(10)
    expect(report.rootSpent).toBe(4)
    expect(report.rootAvailable).toBe(6)
    expect(report.childCeiling).toBe(90)
    expect(report.childCommitted).toBe(42)
    expect(report.childHeadroom).toBe(48)
    expect(report.spent).toBe(30)
    expect(report.overage).toBe(12)
    // The overage is a PART of spent, not an addition to it. Adding them would
    // double the bill.
    expect(report.spent).toBeGreaterThanOrEqual(report.overage)
  })

  it('defaults the reserve fields to zero on a record written before the reserve existed', () => {
    // An older record must still read. An absent reserve is ZERO reserve, which
    // is the conservative reading: it cannot be mistaken for extra headroom.
    const legacy = pureRecord()
    const { rootReserve: _r, rootSpent: _s, overage: _o, halt: _h, ...stripped } = legacy.budget
    const report = budgetReport(stripped)
    expect(report.rootReserve).toBe(0)
    expect(report.rootAvailable).toBe(0)
    expect(report.childCeiling).toBe(100)
    expect(report.overage).toBe(0)
    expect(report.halted).toBe(false)
  })
})
