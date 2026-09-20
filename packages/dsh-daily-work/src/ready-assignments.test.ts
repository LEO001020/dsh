/**
 * P5 / WORK-READY — the durable assignment table, and the rules V5 §7.2 states.
 *
 * THE ORACLE, verbatim from V5 §7.2 and §18:
 *
 *   "It should: 1. durably insert/update a READY semantic assignment
 *    2. call `requestDrain(runId)` 3. return status. It must not discard useful
 *    work because target is currently full. Duplicate taskId: exact same
 *    semantic assignment -> idempotent; changed assignment under same taskId ->
 *    explicit conflict unless the task is in a state where replacement is
 *    defined."
 *
 *   `WORK-READY`: "assignment submitted while full remains durable READY."
 *
 * ---------------------------------------------------------------------------
 * WHAT IS REAL HERE, AND WHAT IS CONTROLLED
 * ---------------------------------------------------------------------------
 *
 * REAL: the production `WorkService`, the real storage domain (JSON backend,
 * serialized write chain, zod validation of every record). The `WORK-READY`
 * oracle is about DURABILITY, so the assertions read the store back through
 * `getRun` rather than through a returned value.
 *
 * CONTROLLED: there is no child machinery at all in this file, and that is
 * deliberate rather than a shortcut. §7.1 says a READY record consumes no child
 * slot and no committed budget, and the cleanest way to prove "consumes
 * nothing" is to run with NO launch port installed: if a READY submission took a
 * slot or a credit, the absence of any child machinery would make it visible as
 * arithmetic rather than hidden by a successful launch. The rolling arms that DO
 * launch real children are in `rolling-n.test.ts`.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS FILE DOES NOT CLAIM
 * ---------------------------------------------------------------------------
 *
 * - It does not claim the submission wakes a drain. `requestDrain` is exercised
 *   in `rolling-n.test.ts`; here the submission is measured on its own, because
 *   a test that both submits and drains cannot tell which half moved a count.
 * - It does not claim anything about a second host sharing the store. The
 *   single-writer configuration is a documented gate (`docs/RECOVERY.md`), and
 *   nothing here relaxes it.
 */
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import * as storageDomainPlugin from '@deepseek-ai/dsh-storage-domain'
import * as storageJsonPlugin from '@deepseek-ai/dsh-storage-json'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { WorkService } from './host.ts'
import { heldSlots } from './counting.ts'
import type { RunRecord } from './record.ts'

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

/** Windows holds handles on the store directory; removal needs retries. */
function removeTree(path: string): void {
  rmSync(path, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 })
}

interface Rig {
  readonly service: WorkService
  readonly runId: string
}

/**
 * A real domain and a real run, with NO launch port and NO agent machinery.
 *
 * The absent launch port is load-bearing, not incidental: see the file header.
 */
async function rig(target = 2): Promise<Rig> {
  const root = mkdtempSync(join(tmpdir(), 'dsh-p5-ready-'))
  const ctx = new Context()
  await ctx.plugin(Storage, {} as never)
  await ctx.plugin(storageJsonPlugin as never, { root } as never)
  await ctx.plugin(storageDomainPlugin as never, { backend: 'json' } as never)
  const service = new WorkService(ctx, {
    targetChildren: target,
    maxDepth: 1,
    budgetCeiling: 1_000,
    currency: 'USD',
    priceVersion: 'p5-ready',
  })
  await service.open()
  cleanups.push(async () => {
    await service.close()
    await ctx.fiber.dispose()
    removeTree(root)
  })
  const record = await service.createRun({
    runId: 'run-ready',
    // A fake root is honest here and is the same shape `durability-records.test.ts`
    // uses (`:378`, `:430`, `:451`): no launch port is installed, so nothing in
    // this file can reach a real Agent, and the root object is only stored.
    root: { session: { header: { id: 'root-ready' } } } as never,
    authorizationRef: 'human-command /work start 2',
    targetChildren: target,
  })
  return { service, runId: record.runId }
}

describe('P5 WORK-READY: a durable assignment table', () => {
  it('stores a submitted assignment durably, with the §7.1 field list', async () => {
    const r = await rig()
    const submitted = await r.service.submitReady({
      runId: r.runId,
      taskId: 'task-1',
      prompt: 'summarize the build log',
      reservedCost: 3,
      allowedCapabilities: ['reader', 'web'],
      sourceCallId: 'call-77',
    })
    expect(submitted.created).toBe(true)

    // Read back through the STORE, not the return value: the oracle is
    // durability, and a return value can be right while the write is not.
    const stored = r.service.getRun(r.runId)?.readyAssignments?.['task-1']
    expect(stored, 'the assignment is in the durable record').toBeDefined()
    expect(stored).toMatchObject({
      taskId: 'task-1',
      childId: 'child-task-1',
      prompt: 'summarize the build log',
      reservedCost: 3,
      allowedCapabilities: ['reader', 'web'],
      sequence: 1,
      sourceCallId: 'call-77',
    })
    expect(stored?.assignmentDigest).toMatch(/^sha256:[0-9a-f]{64}$/u)
    expect(stored?.createdAt).toEqual(stored?.updatedAt)
  })

  it('consumes NO child slot and NO committed credit while ready', async () => {
    const r = await rig(2)
    await r.service.submitReady({ runId: r.runId, taskId: 'a', prompt: 'work a', reservedCost: 7 })
    await r.service.submitReady({ runId: r.runId, taskId: 'b', prompt: 'work b', reservedCost: 7 })

    const record = r.service.getRun(r.runId) as RunRecord
    // The task table is untouched: a READY assignment is not an admission.
    expect(Object.keys(record.tasks)).toHaveLength(0)
    expect(heldSlots(record), 'no slot is held by a ready assignment').toBe(0)
    expect(record.budget.reserved, 'no credit is committed by a ready assignment').toBe(0)
    // And the counts a reader sees agree, which is the half that matters: a
    // record that is right while the deficit reader disagrees is the CAP-10
    // shape this project already measured once.
    const counts = r.service.counts(r.runId)
    expect(counts.heldReservations).toBe(0)
    expect(counts.capacityDeficit).toBe(2)
  })

  it('is IDEMPOTENT for an identical assignment under the same taskId', async () => {
    const r = await rig()
    const first = await r.service.submitReady({
      runId: r.runId, taskId: 'task-1', prompt: 'same goal', reservedCost: 1,
    })
    const second = await r.service.submitReady({
      runId: r.runId, taskId: 'task-1', prompt: 'same goal', reservedCost: 1,
    })
    expect(first.created).toBe(true)
    expect(second.created, 'a retry does not create a second record').toBe(false)
    expect(second.assignment).toEqual(first.assignment)
    // Exactly one row, and it did not move in the queue.
    expect(Object.keys(r.service.getRun(r.runId)?.readyAssignments ?? {})).toEqual(['task-1'])
    expect(second.assignment.sequence).toBe(1)
  })

  it('a retry does not RE-ORDER the assignment behind newer work', async () => {
    // The idempotent arm's real consequence, and the reason the sequence is
    // taken from the stored record rather than recomputed: if a retry advanced
    // the sequence, a retried submission would jump the queue and starve the
    // assignments that were submitted while it was in flight.
    const r = await rig()
    await r.service.submitReady({ runId: r.runId, taskId: 'first', prompt: 'g1', reservedCost: 1 })
    await r.service.submitReady({ runId: r.runId, taskId: 'second', prompt: 'g2', reservedCost: 1 })
    await r.service.submitReady({ runId: r.runId, taskId: 'first', prompt: 'g1', reservedCost: 1 })

    expect(r.service.readyAssignments(r.runId).map(a => a.taskId)).toEqual(['first', 'second'])
  })

  it('REFUSES a changed assignment under the same taskId, naming both digests', async () => {
    const r = await rig()
    const first = await r.service.submitReady({
      runId: r.runId, taskId: 'task-1', prompt: 'the original goal', reservedCost: 1,
    })
    await expect(
      r.service.submitReady({ runId: r.runId, taskId: 'task-1', prompt: 'a DIFFERENT goal', reservedCost: 1 }),
    ).rejects.toThrow(/explicit conflict/u)

    // The conflict is refused, so the stored assignment is UNCHANGED. This is
    // the half that a "replace and report success" implementation would fail
    // while still throwing: the caller would have a new goal in the store.
    const stored = r.service.getRun(r.runId)?.readyAssignments?.['task-1']
    expect(stored?.prompt).toBe('the original goal')
    expect(stored?.assignmentDigest).toBe(first.assignment.assignmentDigest)
  })

  it('the conflict error carries both digests so a report can name them', async () => {
    const r = await rig()
    const first = await r.service.submitReady({
      runId: r.runId, taskId: 'task-1', prompt: 'one', reservedCost: 1,
    })
    const failure = await r.service
      .submitReady({ runId: r.runId, taskId: 'task-1', prompt: 'two', reservedCost: 1 })
      .then(() => undefined, (error: unknown) => error as Error & { existingDigest?: string; submittedDigest?: string })
    expect(failure?.name).toBe('ReadyConflictError')
    expect(failure?.existingDigest).toBe(first.assignment.assignmentDigest)
    expect(failure?.submittedDigest).toMatch(/^sha256:/u)
    expect(failure?.existingDigest).not.toBe(failure?.submittedDigest)
  })

  it('orders ready assignments by durable sequence, oldest first', async () => {
    const r = await rig()
    // Same `now` for every call, so this cannot pass by accident on a clock
    // with millisecond resolution. The order must come from the sequence.
    const sameInstant = '2026-09-20T00:00:00.000Z'
    for (const id of ['c', 'a', 'b']) {
      await r.service.submitReady({
        runId: r.runId, taskId: id, prompt: `goal ${id}`, reservedCost: 1, now: sameInstant,
      })
    }
    expect(r.service.readyAssignments(r.runId).map(a => a.taskId)).toEqual(['c', 'a', 'b'])
    expect(r.service.readyAssignments(r.runId).map(a => a.sequence)).toEqual([1, 2, 3])
  })

  it('clears one assignment without touching its siblings', async () => {
    const r = await rig()
    await r.service.submitReady({ runId: r.runId, taskId: 'a', prompt: 'ga', reservedCost: 1 })
    await r.service.submitReady({ runId: r.runId, taskId: 'b', prompt: 'gb', reservedCost: 1 })
    expect(await r.service.clearReadyAssignment(r.runId, 'a')).toBe(true)
    expect(r.service.readyAssignments(r.runId).map(a => a.taskId)).toEqual(['b'])
    // Clearing a row that is not there is a no-op, not an error: a recovery
    // sweep may run twice over the same record.
    expect(await r.service.clearReadyAssignment(r.runId, 'a')).toBe(false)
    expect(r.service.readyAssignments(r.runId).map(a => a.taskId)).toEqual(['b'])
  })

  it('refuses a malformed submission rather than storing it', async () => {
    const r = await rig()
    await expect(
      r.service.submitReady({ runId: r.runId, taskId: '', prompt: 'g', reservedCost: 1 }),
    ).rejects.toThrow(/requires a taskId/u)
    await expect(
      r.service.submitReady({ runId: r.runId, taskId: 't', prompt: '', reservedCost: 1 }),
    ).rejects.toThrow(/non-empty prompt/u)
    await expect(
      r.service.submitReady({ runId: r.runId, taskId: 't', prompt: 'g', reservedCost: -1 }),
    ).rejects.toThrow(/non-negative finite/u)
    expect(r.service.readyAssignments(r.runId)).toHaveLength(0)
  })

  it('a run written before this table existed still reads, as no pending intent', async () => {
    // The read-compatibility claim in `runRecordSchema`: `readyAssignments` is
    // optional, so a stored record without the key parses and means "none".
    // Written by hand here because the alternative — a real store written by a
    // pre-change build — is not reproducible inside one test process.
    const r = await rig()
    const record = r.service.getRun(r.runId) as RunRecord
    const withoutTable: Record<string, unknown> = { ...record }
    delete withoutTable.readyAssignments
    const parsed = (await import('./record.ts')).runRecordSchema.parse(withoutTable)
    expect(parsed.readyAssignments).toBeUndefined()
    expect(Object.values(parsed.readyAssignments ?? {})).toHaveLength(0)
  })
})
