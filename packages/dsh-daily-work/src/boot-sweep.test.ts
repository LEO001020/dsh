/**
 * P5 / §7.5 — the boot sweep: enumerate, reconcile, and NEVER auto-replay.
 *
 * THE ORACLE, verbatim from V5 §7.5:
 *
 *   "When WorkService opens: enumerate open/paused/closing runs; reconcile held
 *    task ids with DSH child/session state; do not auto-replay unknown child
 *    work; open runs with READY assignments call `requestDrain`."
 *
 * ---------------------------------------------------------------------------
 * WHY THE NEGATIVE HALF IS THE IMPORTANT HALF
 * ---------------------------------------------------------------------------
 *
 * Three of those four clauses are enumeration. The fourth — "do not auto-replay
 * unknown child work" — is the one that would be violated by a plausible-looking
 * implementation, and it is a STANDING CONSTRAINT of this project rather than a
 * preference: `states.ts` says `unknown` is "deliberately NOT an error state that
 * auto-retries", `reconcile.ts` says "NEVER auto-replay. An interrupted turn, a
 * lost reply and a disposal error are not permissions to retry", and
 * `GAPS.md` G-SEAM-68 records that entering `unknown` is CORRECT while the exit
 * is what is missing.
 *
 * So the arms below assert the ABSENCE of launches as carefully as they assert
 * the presence of a report. A boot sweep that launched things would pass a test
 * that only counted the enumeration.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS REAL HERE
 * ---------------------------------------------------------------------------
 *
 * The real storage domain (JSON backend, serialized writes, zod validation), the
 * real `WorkService`, and a REAL restart: a second service over the same
 * directory after the first is disposed, which is what a restarted host does.
 */
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import * as storageDomainPlugin from '@deepseek-ai/dsh-storage-domain'
import * as storageJsonPlugin from '@deepseek-ai/dsh-storage-json'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { WorkService, type LaunchPort } from './host.ts'

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

function removeTree(path: string): void {
  rmSync(path, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 })
}

/** A service over `root`, with a launch port that RECORDS every call. */
async function hostOver(root: string, options: { port?: boolean } = {}): Promise<{
  readonly service: WorkService
  readonly launches: string[]
  readonly dispose: () => Promise<void>
}> {
  const ctx = new Context()
  await ctx.plugin(Storage, {} as never)
  await ctx.plugin(storageJsonPlugin as never, { root } as never)
  await ctx.plugin(storageDomainPlugin as never, { backend: 'json' } as never)
  const service = new WorkService(ctx, {
    targetChildren: 4,
    maxDepth: 1,
    budgetCeiling: 1_000,
    currency: 'USD',
    priceVersion: 'p5-boot',
  })
  await service.open()
  const launches: string[] = []
  if (options.port !== false) {
    const port: LaunchPort = {
      launch: request => {
        launches.push(request.taskId)
        return Promise.resolve({ childId: request.childId })
      },
    }
    service.setLaunchPort(port)
  }
  return {
    service,
    launches,
    dispose: async () => {
      await service.close()
      await ctx.fiber.dispose()
    },
  }
}

describe('P5 §7.5: the boot sweep', () => {
  it('enumerates the non-closed runs and reports each held task, with its child liveness', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-p5-boot-'))
    cleanups.push(async () => removeTree(root))
    const first = await hostOver(root)
    await first.service.createRun({
      runId: 'run-boot',
      root: { session: { header: { id: 'root-boot' } } } as never,
      authorizationRef: 'human-command /work start',
      targetChildren: 4,
    })
    await first.service.admit({
      runId: 'run-boot',
      taskId: 'held-1',
      childId: 'child-held-1',
      assignmentDigest: 'digest',
      reservedCost: 2,
      allowedCapabilities: ['reader'],
    })
    await first.service.submitReady({
      runId: 'run-boot', taskId: 'pending-1', prompt: 'waiting work', reservedCost: 1,
    })
    await first.dispose()

    // A SECOND host generation over the SAME directory: the restart.
    const second = await hostOver(root, { port: false })
    cleanups.push(async () => second.dispose())
    const report = await second.service.sweepOpenRuns()

    const entry = report.runs.find(r => r.runId === 'run-boot')
    expect(entry, 'the non-closed run is enumerated').toBeDefined()
    expect(entry?.phase).toBe('open')
    expect(entry?.heldTasks.map(t => t.taskId)).toEqual(['held-1'])
    expect(entry?.heldTasks[0]?.state).toBe('prepared')
    expect(entry?.heldTasks[0]?.childId).toBe('child-held-1')
    // No live Agent in THIS process backs it, which is the honest reading after
    // a restart: the durable Session may exist, the live Agent does not.
    expect(entry?.heldTasks[0]?.childLive).toBe(false)
    expect(entry?.readyCount, 'the durable ready assignment survived the restart').toBe(1)
  })

  it('NEVER auto-replays unknown child work, and never launches on a sweep', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-p5-boot-unknown-'))
    cleanups.push(async () => removeTree(root))
    const first = await hostOver(root)
    await first.service.createRun({
      runId: 'run-unknown',
      root: { session: { header: { id: 'root-unknown' } } } as never,
      authorizationRef: 'a',
      targetChildren: 4,
    })
    await first.service.admit({
      runId: 'run-unknown',
      taskId: 'maybe-exists',
      childId: 'child-maybe',
      assignmentDigest: 'd',
      reservedCost: 3,
      allowedCapabilities: [],
    })
    await first.service.transition({ runId: 'run-unknown', taskId: 'maybe-exists', to: 'launching' })
    await first.service.transition({
      runId: 'run-unknown',
      taskId: 'maybe-exists',
      to: 'unknown',
      uncertainty: 'the launch failed and the child may exist',
    })
    await first.dispose()

    // The second generation HAS a port, and it still must not launch. This is
    // the arm that distinguishes "did not launch because it could not" from
    // "did not launch because the rule forbids it".
    const second = await hostOver(root, { port: true })
    cleanups.push(async () => second.dispose())
    const report = await second.service.sweepOpenRuns()

    expect(second.launches, 'a sweep launches NOTHING, even with a port installed').toEqual([])
    const entry = report.runs.find(r => r.runId === 'run-unknown')
    expect(entry?.heldTasks.map(t => t.state)).toEqual(['unknown'])
    // The task is still unknown and still holds its reservation: the sweep
    // reported it rather than resolving it, because resolving is a
    // reconciliation decision and this method does not make one.
    expect(second.service.getRun('run-unknown')?.tasks['maybe-exists']?.state).toBe('unknown')
    expect(second.service.counts('run-unknown').quarantinedUnknown).toBe(1)
  })

  it('a run with READY assignments is woken, and its pending work survives a portless boot', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-p5-boot-ready-'))
    cleanups.push(async () => removeTree(root))
    const first = await hostOver(root)
    await first.service.createRun({
      runId: 'run-ready',
      root: { session: { header: { id: 'root-ready' } } } as never,
      authorizationRef: 'a',
      targetChildren: 3,
    })
    for (const id of ['r1', 'r2', 'r3']) {
      await first.service.submitReady({ runId: 'run-ready', taskId: id, prompt: `goal ${id}`, reservedCost: 1 })
    }
    await first.dispose()

    // The portless boot: the sweep wakes the run, and the wake must be HARMLESS.
    // A ready-driven pass with no port refuses and leaves the table intact, so
    // the pending intent is not converted into `unknown` tasks that would hold
    // slots and commit credit.
    const second = await hostOver(root, { port: false })
    cleanups.push(async () => second.dispose())
    await second.service.sweepOpenRuns()
    expect(
      second.service.readyAssignments('run-ready').map(a => a.taskId),
      'the pending assignments are still pending after a portless boot',
    ).toEqual(['r1', 'r2', 'r3'])
    expect(second.service.counts('run-ready').quarantinedUnknown).toBe(0)
    expect(second.service.counts('run-ready').heldReservations).toBe(0)
  })

  it('a CLOSING run is still enumerated: §7.5 names open/paused/closing', async () => {
    // The arm was going to assert that a `closed` run is skipped, and that was
    // WRONG for a reason worth recording: nothing in production writes the
    // `closed` phase. `beginClosing` is the only phase-moving production method
    // (`host.ts`, and it moves `open -> closing`), so a test asserting on a
    // `closed` record would have had to write one through a private path — an
    // oracle measuring a state the product cannot produce. §7.5 asks for
    // "open/paused/closing", which IS producible, so that is what is asserted.
    const root = mkdtempSync(join(tmpdir(), 'dsh-p5-boot-closing-'))
    cleanups.push(async () => removeTree(root))
    const first = await hostOver(root)
    await first.service.createRun({
      runId: 'run-closing',
      root: { session: { header: { id: 'root-closing' } } } as never,
      authorizationRef: 'a',
      targetChildren: 2,
    })
    await first.service.submitReady({
      runId: 'run-closing', taskId: 'late', prompt: 'still pending', reservedCost: 1,
    })
    await first.service.beginClosing('run-closing')
    await first.dispose()

    const second = await hostOver(root, { port: false })
    cleanups.push(async () => second.dispose())
    const report = await second.service.sweepOpenRuns()
    const entry = report.runs.find(r => r.runId === 'run-closing')
    expect(entry, 'a closing run is enumerated rather than assumed finished').toBeDefined()
    expect(entry?.phase).toBe('closing')
    expect(entry?.readyCount, 'its pending assignment is still visible').toBe(1)
    // And the wake it triggers admits NOTHING: the run is not open, so the
    // reservation refuses with `run_not_open`. That is the honest reading of a
    // closing run with work left in it.
    expect(second.service.counts('run-closing').heldReservations).toBe(0)
  })
})
