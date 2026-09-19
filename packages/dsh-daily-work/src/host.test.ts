/**
 * Host-service tests against a REAL DSH storage domain.
 *
 * These are T1 tests: real DSH services, controlled fakes only at the external
 * boundary (the launch port). They exist to prove the rolling top-up actually
 * does what the counting module claims, using the same storage facility the
 * production host mounts.
 *
 * What is deliberately NOT faked:
 *   - the storage domain, its serialized write chain and its zod validation
 *   - the record schema
 *   - the state machine
 *
 * What IS faked, and why:
 *   - the launch port. Starting a real child needs a model provider; the plan
 *     forbids building a second model loop to simulate one. The port is the
 *     documented seam where the real `ctx.subagents.startContinuable` plugs in,
 *     and the real integration is a separate gate (C01, needs live authorization).
 */
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import * as storageJsonPlugin from '@deepseek-ai/dsh-storage-json'
import * as storageDomainPlugin from '@deepseek-ai/dsh-storage-domain'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { WorkService, type LaunchPort, type LaunchRequest } from './host.ts'

/**
 * A launch port that records calls and can be made to block or fail on demand.
 *
 * `barrier` lets a test hold several launches open at once, which is how the
 * "nine still running, one finishes" scenario is reproduced deterministically
 * instead of with sleeps.
 */
class ScriptedLaunchPort implements LaunchPort {
  readonly calls: LaunchRequest[] = []
  private release: (() => void) | undefined
  private readonly gate: Promise<void>
  failNext = false
  /** When true, `launch` waits for `open()` before resolving. */
  hold = false

  constructor() {
    let openGate: () => void = () => {}
    this.gate = new Promise<void>(resolve => {
      openGate = resolve
    })
    this.release = openGate
  }

  open(): void {
    this.release?.()
  }

  async launch(request: LaunchRequest): Promise<{ childId: string }> {
    this.calls.push(request)
    if (this.failNext) {
      this.failNext = false
      throw new Error('scripted launch failure')
    }
    if (this.hold) await this.gate
    return { childId: request.childId }
  }
}

interface Harness {
  readonly ctx: Context
  readonly service: WorkService
  readonly port: ScriptedLaunchPort
  readonly root: string
  close(): Promise<void>
}

/**
 * A root stand-in.
 *
 * The service only reads `root.session.header.id`, so this is a structural
 * stub, not a fake agent loop. Nothing here samples a model.
 */
function rootStub(sessionId: string): { session: { header: { id: string } } } {
  return { session: { header: { id: sessionId } } }
}

async function harness(): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-daily-work-'))
  const ctx = new Context()
  // Mount the REAL storage hub, JSON backend and domain facility. These are the
  // same services the production host mounts; only the directory is a temp one.
  await ctx.plugin(Storage, {})
  await ctx.plugin(storageJsonPlugin as never, { root } as never)
  await ctx.plugin(storageDomainPlugin as never, { backend: 'json' } as never)

  const service = new WorkService(ctx, {
    targetChildren: 10,
    maxDepth: 1,
    budgetCeiling: 1000,
    currency: 'USD',
    priceVersion: 'test-v1',
  })
  await service.open()
  const port = new ScriptedLaunchPort()
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

/** Reserve a run for the scripted root and return its id. */
async function newRun(overrides: { target?: number } = {}): Promise<string> {
  const record = await h.service.createRun({
    runId: 'run-1',
    root: rootStub('session-root') as never,
    authorizationRef: 'user-authorization-1',
    targetChildren: overrides.target ?? 10,
  })
  return record.runId
}

function request(n: number): LaunchRequest {
  return { taskId: `task-${n}`, childId: `child-${n}`, prompt: `do work ${n}`, reservedCost: 1 }
}

describe('work service: admission and reservation', () => {
  it('writes the reservation and the task in one record', async () => {
    // INV-D1: there is no state in which a task is admitted without its credit.
    const runId = await newRun()
    const task = await h.service.admit({
      runId,
      taskId: 't1',
      childId: 'c1',
      assignmentDigest: 'digest-1',
      reservedCost: 7,
      allowedCapabilities: ['reader'],
    })
    expect(task.state).toBe('prepared')
    const record = h.service.getRun(runId)
    expect(record?.budget.reserved).toBe(7)
    expect(record?.tasks['t1']?.childId).toBe('c1')
    expect(record?.outbox['admit-t1']?.stage).toBe('pending')
  })

  it('refuses admission past the budget ceiling', async () => {
    const runId = await newRun()
    await expect(
      h.service.admit({
        runId,
        taskId: 'big',
        childId: 'cbig',
        assignmentDigest: 'd',
        reservedCost: 1001,
        allowedCapabilities: ['reader'],
      }),
    ).rejects.toThrow(/no budget headroom/)
    expect(h.service.getRun(runId)?.tasks['big']).toBeUndefined()
  })

  it('refuses admission while the run is paused', async () => {
    const runId = await newRun()
    await h.service.pause(runId, 'user pressed stop')
    await expect(
      h.service.admit({
        runId,
        taskId: 't1',
        childId: 'c1',
        assignmentDigest: 'd',
        reservedCost: 1,
        allowedCapabilities: ['reader'],
      }),
    ).rejects.toThrow(/is paused/)
  })

  it('refuses to reopen a tombstoned task', async () => {
    const runId = await newRun()
    await h.service.admit({ runId, taskId: 't1', childId: 'c1', assignmentDigest: 'd', reservedCost: 1, allowedCapabilities: [] })
    await h.service.transition({ runId, taskId: 't1', to: 'launching' })
    await h.service.transition({ runId, taskId: 't1', to: 'accepted' })
    await h.service.transition({ runId, taskId: 't1', to: 'settling' })
    await h.service.transition({ runId, taskId: 't1', to: 'confirmed' })
    await expect(
      h.service.admit({ runId, taskId: 't1', childId: 'c9', assignmentDigest: 'd', reservedCost: 1, allowedCapabilities: [] }),
    ).rejects.toThrow(/tombstone/)
  })

  it('releases the reservation on a confirmed transition but not on a requested cancel', async () => {
    // INV-C4: a sent cancel is not a confirmed cancel.
    const runId = await newRun()
    await h.service.admit({ runId, taskId: 't1', childId: 'c1', assignmentDigest: 'd', reservedCost: 5, allowedCapabilities: [] })
    await h.service.transition({ runId, taskId: 't1', to: 'launching' })
    await h.service.transition({ runId, taskId: 't1', to: 'accepted' })
    await h.service.transition({ runId, taskId: 't1', to: 'cancel_requested' })
    expect(h.service.getRun(runId)?.budget.reserved).toBe(5)
    await h.service.transition({ runId, taskId: 't1', to: 'cancelled' })
    expect(h.service.getRun(runId)?.budget.reserved).toBe(0)
  })

  it('rejects an illegal transition instead of quietly accepting it', async () => {
    const runId = await newRun()
    await h.service.admit({ runId, taskId: 't1', childId: 'c1', assignmentDigest: 'd', reservedCost: 1, allowedCapabilities: [] })
    await expect(h.service.transition({ runId, taskId: 't1', to: 'confirmed' })).rejects.toThrow(/illegal admission transition/)
  })

  it('does not mutate the stored record in place', async () => {
    // INV-D2: get returns the stored object; callers must not mutate it.
    const runId = await newRun()
    const before = h.service.getRun(runId)
    const snapshot = JSON.stringify(before)
    await h.service.admit({ runId, taskId: 't1', childId: 'c1', assignmentDigest: 'd', reservedCost: 1, allowedCapabilities: [] })
    expect(JSON.stringify(before)).toBe(snapshot)
  })
})

describe('work service: rolling top-up', () => {
  it('launches up to the target and no further', async () => {
    // C01 shape, at a reduced N so it is cheap: the arithmetic is the same.
    const runId = await newRun({ target: 3 })
    h.service.setReadyTasks(runId, 10)
    const outcomes = await h.service.drain(runId, [request(1), request(2), request(3), request(4)], new AbortController().signal)
    expect(outcomes.filter(o => o.accepted)).toHaveLength(3)
    expect(outcomes.filter(o => !o.accepted)).toHaveLength(1)
    expect(h.port.calls).toHaveLength(3)
  })

  it('leaves admission as admission: the child is accepted, not executing', async () => {
    // The single most dangerous confusion in this system.
    const runId = await newRun({ target: 2 })
    await h.service.drain(runId, [request(1)], new AbortController().signal)
    const record = h.service.getRun(runId)
    expect(record?.tasks['task-1']?.state).toBe('accepted')
    // And with no observed work, it is NOT an active assignment.
    expect(h.service.counts(runId).activeAssignments).toBe(0)
    expect(h.service.counts(runId).capacityDeficit).toBe(1)
  })

  it('reports a deficit instead of inventing work when fewer tasks are ready', async () => {
    // C04: no sleep placeholders, no idle sessions pretending to be workers.
    const runId = await newRun({ target: 10 })
    h.service.setReadyTasks(runId, 3)
    const outcomes = await h.service.drain(runId, [request(1), request(2), request(3)], new AbortController().signal)
    expect(outcomes.filter(o => o.accepted)).toHaveLength(3)
    const counts = h.service.counts(runId)
    expect(counts.desiredTarget).toBe(10)
    expect(counts.activeAssignments).toBe(0)
    expect(counts.capacityDeficit).toBe(7)
    expect(counts.deficitReason).toBe('insufficient_ready_tasks')
  })

  it('tops up a single completion without waiting for the whole wave', async () => {
    // C02: the property under test is that one release admits one replacement.
    const runId = await newRun({ target: 3 })
    h.service.setReadyTasks(runId, 10)
    await h.service.drain(runId, [request(1), request(2), request(3)], new AbortController().signal)

    // Mark all three as observed-working so they occupy slots as ACTIVE work.
    for (const n of [1, 2, 3]) {
      h.service.observe(runId, {
        taskId: `task-${n}`,
        startedRealWork: true,
        waitingOnOwnedTool: false,
        providerWaiting: false,
      })
      await h.service.transition({ runId, taskId: `task-${n}`, to: 'executing' })
    }
    expect(h.service.counts(runId).activeAssignments).toBe(3)
    expect(h.service.counts(runId).capacityDeficit).toBe(0)

    // One finishes and is confirmed: exactly one slot frees.
    await h.service.transition({ runId, taskId: 'task-2', to: 'settling' })
    await h.service.transition({ runId, taskId: 'task-2', to: 'confirmed', spentCost: 0.5 })
    expect(h.service.counts(runId).capacityDeficit).toBe(1)

    const outcomes = await h.service.drain(runId, [request(4)], new AbortController().signal)
    expect(outcomes.filter(o => o.accepted)).toHaveLength(1)
    expect(h.port.calls.map(c => c.taskId)).toEqual(['task-1', 'task-2', 'task-3', 'task-4'])
  })

  it('coalesces concurrent drains so a completion storm cannot double-launch', async () => {
    // C03: two drains racing on the same one free slot must produce one launch.
    const runId = await newRun({ target: 1 })
    h.service.setReadyTasks(runId, 10)
    const signal = new AbortController().signal
    const [a, b] = await Promise.all([
      h.service.drain(runId, [request(1)], signal),
      h.service.drain(runId, [request(1)], signal),
    ])
    const accepted = [...a, ...b].filter(o => o.accepted)
    expect(accepted).toHaveLength(1)
    expect(h.port.calls).toHaveLength(1)
  })

  it('treats a failed launch as unknown and does not silently retry', async () => {
    // INV-D4 / D04: a launch whose fate is unclear is `unknown`, not a retry.
    const runId = await newRun({ target: 1 })
    h.port.failNext = true
    const outcomes = await h.service.drain(runId, [request(1)], new AbortController().signal)
    expect(outcomes[0]?.accepted).toBe(false)
    expect(outcomes[0]?.reason).toBe('launch_failed_unknown')
    const record = h.service.getRun(runId)
    expect(record?.tasks['task-1']?.state).toBe('unknown')
    // The reservation is still held: we cannot prove the child does not exist.
    expect(record?.budget.reserved).toBe(1)
    expect(h.service.counts(runId).quarantinedUnknown).toBe(1)
    expect(h.service.counts(runId).capacityDeficit).toBe(0)
  })

  it('does not release a slot while a cancel is only requested', async () => {
    // C07: SIGTERM sent but the child still running must still hold the slot.
    const runId = await newRun({ target: 1 })
    h.service.setReadyTasks(runId, 10)
    await h.service.drain(runId, [request(1)], new AbortController().signal)
    await h.service.transition({ runId, taskId: 'task-1', to: 'executing' })
    h.service.observe(runId, { taskId: 'task-1', startedRealWork: true, waitingOnOwnedTool: false, providerWaiting: false })
    await h.service.transition({ runId, taskId: 'task-1', to: 'cancel_requested' })

    const outcomes = await h.service.drain(runId, [request(2)], new AbortController().signal)
    expect(outcomes[0]?.accepted).toBe(false)
    expect(h.port.calls).toHaveLength(1)
    expect(h.service.counts(runId).stopping).toBe(1)
    expect(h.service.counts(runId).capacityDeficit).toBe(0)
  })

  it('stops admitting once the run is paused, even with free slots', async () => {
    // INV-G4: a user pause outranks top-up.
    const runId = await newRun({ target: 10 })
    h.service.setReadyTasks(runId, 10)
    await h.service.pause(runId, 'user pressed stop')
    const outcomes = await h.service.drain(runId, [request(1)], new AbortController().signal)
    expect(outcomes[0]?.accepted).toBe(false)
    expect(h.port.calls).toHaveLength(0)
  })

  it('resumes a paused run as a new authorization edge', async () => {
    const runId = await newRun({ target: 2 })
    h.service.setReadyTasks(runId, 10)
    await h.service.pause(runId, 'stop')
    await h.service.resume(runId)
    const outcomes = await h.service.drain(runId, [request(1)], new AbortController().signal)
    expect(outcomes[0]?.accepted).toBe(true)
  })

  it('does not launch when the caller signal is already aborted', async () => {
    const runId = await newRun({ target: 5 })
    h.service.setReadyTasks(runId, 10)
    const controller = new AbortController()
    controller.abort()
    const outcomes = await h.service.drain(runId, [request(1)], controller.signal)
    expect(outcomes).toHaveLength(0)
    expect(h.port.calls).toHaveLength(0)
  })

  it('keeps each run isolated from the others', async () => {
    // B05 shape: two roots sharing the preset must not share state.
    const runA = await h.service.createRun({
      runId: 'run-a',
      root: rootStub('session-a') as never,
      authorizationRef: 'auth-a',
      targetChildren: 2,
    })
    const runB = await h.service.createRun({
      runId: 'run-b',
      root: rootStub('session-b') as never,
      authorizationRef: 'auth-b',
      targetChildren: 1,
    })
    h.service.setReadyTasks(runA.runId, 5)
    h.service.setReadyTasks(runB.runId, 5)
    await h.service.drain(runA.runId, [request(1), request(2)], new AbortController().signal)
    await h.service.pause(runB.runId, 'stop b')
    const bOutcomes = await h.service.drain(runB.runId, [request(9)], new AbortController().signal)
    expect(bOutcomes[0]?.accepted).toBe(false)
    expect(h.service.getRun(runA.runId)?.tasks['task-1']).toBeDefined()
    expect(h.service.getRun(runB.runId)?.tasks['task-9']).toBeUndefined()
  })
})

describe('work service: persistence', () => {
  it('survives a reopen of the same domain directory', async () => {
    // D11 shape: the record is on the medium, not only in memory.
    const runId = await newRun()
    await h.service.admit({ runId, taskId: 't1', childId: 'c1', assignmentDigest: 'd', reservedCost: 3, allowedCapabilities: [] })
    const before = h.service.getRun(runId)
    await h.service.close()

    // A second host generation is a NEW root context over the SAME storage
    // directory. Registering a second service of the same name on one context
    // is a caller bug (and Cordis rejects it), so the reopen must not try.
    const ctx2 = new Context()
    await ctx2.plugin(Storage, {})
    await ctx2.plugin(storageJsonPlugin as never, { root: h.root } as never)
    await ctx2.plugin(storageDomainPlugin as never, { backend: 'json' } as never)
    const reopened = new WorkService(ctx2, {
      targetChildren: 10,
      maxDepth: 1,
      budgetCeiling: 1000,
      currency: 'USD',
      priceVersion: 'test-v1',
    })
    await reopened.open()
    const after = reopened.getRun(runId)
    expect(after).toEqual(before)
    expect(after?.tasks['t1']?.childId).toBe('c1')
    expect(after?.budget.reserved).toBe(3)
    await reopened.close()
    await ctx2.fiber.dispose()
  })

  it('rejects a second open of the same domain', async () => {
    // D11: one host service opens a domain once; consumers share the handle.
    await expect(h.service.open()).rejects.toThrow(/already open/)
  })

  it('refuses writes after close', async () => {
    const runId = await newRun()
    await h.service.close()
    await expect(
      h.service.admit({ runId, taskId: 't1', childId: 'c1', assignmentDigest: 'd', reservedCost: 1, allowedCapabilities: [] }),
    ).rejects.toThrow(/disposed/)
  })
})
