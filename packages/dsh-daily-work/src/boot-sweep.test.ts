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
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { LlmAdapter, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
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
import { WorkService, type LaunchPort } from './host.ts'

/** An adapter that answers immediately, so a launched child can finish a turn. */
class QuickAdapter extends LlmAdapter {
  override async resolveModel(provider: string, model: string): Promise<{ provider: string; id: string; name: string }> {
    return { provider, id: model, name: model }
  }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    if (options.signal?.aborted) throw new Error('aborted')
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'child output' } }
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

/**
 * The same rig, but with a REAL `subagents` service mounted.
 *
 * WHY A SECOND RIG EXISTS. `installDefaultLaunchPort` returns early when
 * `ctx.get('subagents')` is undefined, and that early return is CORRECT — it
 * refuses to invent a port. So a rig without `subagents` cannot exercise the
 * production port path at all, and an arm that used it would be asserting against
 * a rig the production composition never resembles. This rig mounts the real
 * `SubagentRuntime` plus the real in-process spawn provider, so
 * `installDefaultLaunchPort` takes its real branch and the launch is a genuine
 * `startContinuable` call.
 */
async function hostWithSubagents(root: string, rootSessionId: string): Promise<{
  readonly service: WorkService
  readonly rootAgent: Agent
  readonly ctx: Context
  readonly dispose: () => Promise<void>
}> {
  const sessionRoot = mkdtempSync(join(tmpdir(), 'dsh-p5-boot-sessions-'))
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  const persistence = await ctx.plugin(JsonlSessionPersistence, { root: sessionRoot })
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(SubagentRuntime, { maxActiveSubagents: 30, maxDepth: 1 })
  await ctx.plugin(SubagentSpawn, { providerName: 'spawn' })
  await ctx.plugin(class extends SessionQueryEngine {
    override searchSessions(): Promise<never> {
      return Promise.reject(new Error('session search is not configured in this test'))
    }
    override searchEvents(): Promise<never> {
      return Promise.reject(new Error('event search is not configured in this test'))
    }
  })
  await ctx.plugin(Storage, {} as never)
  await ctx.plugin(storageJsonPlugin as never, { root } as never)
  await ctx.plugin(storageDomainPlugin as never, { backend: 'json' } as never)
  ctx.llm.registerAdapter(['mock'], new QuickAdapter())

  const service = new WorkService(ctx, {
    targetChildren: 4,
    maxDepth: 1,
    budgetCeiling: 10_000,
    currency: 'USD',
    priceVersion: 'p5-boot-subagents',
    subagentProvider: 'spawn',
  })
  await service.open()
  // A REAL root Agent, created through the production loop. The launch port is
  // bound to this exact object, and `port.launch` passes it as the child's
  // `parent` -- so a fake object would make the provider call fail and the arm
  // would measure the fake rather than the port.
  const rootAgent = await ctx.agentLoop.create(SessionId(rootSessionId), { provider: 'mock', model: 'mock' })
  // NO PORT IS SET HERE, and that is the point of this rig: the production path
  // (`installDefaultLaunchPort`, called from `createRun`/`authorizeRun`) is what
  // must install one. A rig that set its own port could not observe the hole this
  // arm exists for, because the hole IS "the production path did not install one".
  return {
    service,
    rootAgent,
    ctx,
    dispose: async () => {
      await service.close()
      await ctx.subagents.drainContinuableDescendants([rootAgent])
      await persistence.dispose()
      await ctx.fiber.dispose()
      removeTree(sessionRoot)
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

  it('a RESUMED run gets its port and its wake at re-authorization (§7.5, closed hole)', async () => {
    // THE HOLE THIS ARM EXISTS FOR, and it was found by reading the recovery path
    // rather than by a failing test. `authorizeRun` returns EARLY when the root
    // already has a run, and that branch used to do nothing else. Since
    // `installDefaultLaunchPort` is called from `createRun` — the branch NOT taken
    // — a restarted host that found an existing run held pending work with NO
    // launch port. A wake in that state correctly refuses and changes nothing, so
    // the pending work could never start no matter how many completions arrived.
    //
    // The arm drives the real recovery sequence: submit durable work, restart,
    // then RE-AUTHORIZE (which is what a human `/work start` does on a host that
    // already has the run) and require a real launch.
    const root = mkdtempSync(join(tmpdir(), 'dsh-p5-resume-'))
    cleanups.push(async () => removeTree(root))
    const first = await hostWithSubagents(root, 'root-resume')
    await first.service.createRun({
      runId: 'run-resume',
      // The FIRST generation's live root. The port is bound to this object, and
      // `port.launch` passes it as the child's parent -- so a fake object would
      // make the provider call fail and the arm would measure the fake.
      root: first.rootAgent,
      authorizationRef: 'a',
      targetChildren: 2,
    })
    for (const id of ['p1', 'p2']) {
      await first.service.submitReady({ runId: 'run-resume', taskId: id, prompt: `goal ${id}`, reservedCost: 1 })
    }
    await first.service.requestDrain('run-resume')
    // THE FIRST GENERATION REALLY LAUNCHED. Observed through the RECORD, which is
    // the product's own statement, rather than through a launch counter: a task
    // that reached `accepted` is one the production port started, and
    // `accepted` is written only after `port.launch` resolved.
    const afterFirst = first.service.getRun('run-resume')
    expect(
      Object.values(afterFirst?.tasks ?? {}).map(t => t.state),
      'the first generation started its work through the production port',
    ).toEqual(['accepted', 'accepted'])
    await first.dispose()

    const second = await hostWithSubagents(root, 'root-resume')
    cleanups.push(async () => second.dispose())
    await second.service.sweepOpenRuns()
    // The restart found the two admitted tasks, and they are still `accepted`:
    // nothing resolved them, which is the residual G-SEAM-68 records and this
    // slice narrows but does not close.
    expect(
      Object.values(second.service.getRun('run-resume')?.tasks ?? {}).map(t => t.state),
    ).toEqual(['accepted', 'accepted'])

    // ---- THE HOLE: a RESUMED run must still be able to launch ---------------
    //
    // Re-authorize with the live root, which is what `/work start` does when the
    // run already exists. Before the fix this branch returned early WITHOUT
    // installing a port, so the process held a run it could never launch for.
    const resumed = await second.service.authorizeRun({
      // THE SECOND GENERATION'S OWN LIVE ROOT. Passing the first generation's
      // Agent here was a mistake I made and the arm caught: the port binds to the
      // object, so a foreign object makes the provider call fail and the task
      // lands in `unknown` -- which is exactly what the first run of this arm
      // showed. Authority follows the object, never an id.
      root: second.rootAgent,
      evidence: {
        kind: 'human-command',
        action: 'start',
        commandId: 'cmd-resume',
        commandName: 'work',
        commandArgs: 'start 2',
      },
    })
    expect(resumed.created, 'the run already existed, so nothing was created').toBe(false)

    // Free a slot, then submit new work and re-authorize. The launch must reach
    // the REAL provider, which is the only thing a working port can do.
    await second.service.transition({ runId: 'run-resume', taskId: 'p1', to: 'completed' })
    await second.service.submitReady({
      runId: 'run-resume', taskId: 'p3', prompt: 'work after the restart', reservedCost: 1,
    })
    await second.service.authorizeRun({
      root: second.rootAgent,
      evidence: {
        kind: 'human-command',
        action: 'start',
        commandId: 'cmd-resume-2',
        commandName: 'work',
        commandArgs: 'start 2',
      },
    })

    const afterResume = second.service.getRun('run-resume')
    expect(
      afterResume?.tasks['p3']?.state,
      'the resumed run admitted the waiting work through a port it only has because of the fix',
    ).toBe('accepted')
    // And it is a REAL child: the provider admitted the reserved id, which is the
    // assertion that distinguishes "a port ran" from "a port object existed".
    expect(second.service.counts('run-resume').heldReservations).toBe(2)
  })
})
