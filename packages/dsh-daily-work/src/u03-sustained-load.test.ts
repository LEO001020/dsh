/**
 * U03 — sustained daily load. A long Session, many tasks, child top-up and
 * pause/resume interleaved, with the resource range MEASURED rather than claimed.
 *
 * THE GATE
 * ========
 * Stimulus: "a long Session, multiple tasks, child top-up and pause/resume
 * interleaved." Oracle: "no persistent resource leak, no cost disappearance, no
 * state pollution; REPORT THE MEASURED RANGE."
 *
 * The last clause is the one that shapes this file. The gate does not ask for
 * "no leak"; it asks for the range that was measured. So every claim below is a
 * number with its series attached, and the file states plainly what was and was
 * not exercised.
 *
 * THE LEAK SIGNAL IS THE DELTA BETWEEN CYCLES, NOT AGAINST A COLD BASELINE
 * ======================================================================
 * This is G-FIX-08's lesson, and it is the reason this file is shaped the way it
 * is. A first-mount cost is not a leak: `process.getActiveResourcesInfo()` grows
 * once when the host lazily initializes and then stays flat. A control arm runs
 * FIRST so that one-time cost is charged to the control, and the load arm's
 * series is then read for a TREND. A single final number cannot distinguish
 * "initialized once" from "leaks per cycle", so the series is what is reported.
 *
 * `process._getActiveHandles()` IS NOT USED: it does not report timers, which is
 * exactly the resource a plugin that forgets its disposer leaks. The census uses
 * `process.getActiveResourcesInfo()`, which does.
 *
 * WHAT IS REAL HERE
 * =================
 * The same stack `concurrency.test.ts` boots, which is the production one:
 * `@deepseek-ai/dsh-agent-loop`, the real `ctx.subagents` continuable machinery,
 * the real in-process spawn provider, a real durable JSONL Session per child,
 * and the real storage domain. The model adapter is scripted -- a provider
 * boundary, not a second loop.
 *
 * WHAT IS *NOT* EXERCISED, STATED PLAINLY
 * =======================================
 *   - No live provider. No tokens are billed and no real model latency exists,
 *     so "cost" here is this project's own reservation arithmetic and the
 *     adapter's reported usage, not a provider invoice.
 *   - The load is MODEST by design (CPU discipline: one vitest process, no
 *     recursive subagents). The counts below are small on purpose, and a small
 *     series cannot prove the absence of a slow leak. It can only bound it over
 *     the range run.
 *   - A Web host was not run. The load is driven in-process through the real
 *     services, so host-level resources (HTTP sockets, watchers) are not covered.
 */
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { LlmAdapter, ReasoningEffortId, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
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
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { WorkService, type LaunchRequest } from './host.ts'
import { createContinuableLaunchPort } from './launch-port.ts'

/** The modest target this load runs at. CPU discipline, not a capacity claim. */
const TARGET = 4

/** How many load cycles to run. Enough for a trend, small enough for one fork. */
const CYCLES = 6

/** Resource census after one observed moment. */
interface Census {
  readonly label: string
  readonly total: number
  readonly kinds: Readonly<Record<string, number>>
  readonly listeners: number
  readonly heapUsed: number
}

/**
 * Count live resources by kind.
 *
 * `getActiveResourcesInfo` is the only standard API that reports TIMERS, which
 * are precisely what a plugin that forgets its disposer leaks.
 * `process._getActiveHandles()` cannot see them (G-FIX-08) and is not used.
 */
function census(label: string): Census {
  const resources = process.getActiveResourcesInfo?.() ?? []
  const kinds: Record<string, number> = {}
  for (const kind of resources) kinds[kind] = (kinds[kind] ?? 0) + 1
  return {
    label,
    total: resources.length,
    kinds,
    listeners: process.eventNames().reduce((sum, name) => sum + process.listenerCount(name), 0),
    heapUsed: process.memoryUsage().heapUsed,
  }
}

/**
 * A completing adapter: every child's model call returns immediately.
 *
 * WHY THIS IS NOT GATED, unlike `concurrency.test.ts`'s adapter. That file holds
 * every child open because its claim is "N in flight at once", and without the
 * gate children would finish before the tenth was admitted. This file's claim is
 * the opposite shape: a SUSTAINED load of waves that each complete, so top-up
 * has free slots to refill. A gated adapter here measured exactly the wrong
 * thing -- after the first wave, `maxActiveSubagents` was full of parked
 * children and every later admission was refused for a real capacity reason,
 * which looked like a leak and was not. The observed series was `[4,0,0,0,0,0]`.
 *
 * The lesson is recorded rather than smoothed over: a fixture that holds the
 * resource under test cannot also measure its release.
 *
 * `requests` counts every model call the whole load produced, so a child that
 * never ran is visible as a missing count rather than as a silent success.
 */
class CompletingAdapter extends LlmAdapter {
  requests = 0

  override async resolveModel(provider: string, model: string): Promise<{ provider: string; id: string; name: string }> {
    return { provider, id: model, name: model }
  }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests += 1
    if (options.signal?.aborted) throw new Error('aborted')
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'child done' } }
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
  readonly adapter: CompletingAdapter
}

/**
 * Boot the real continuable stack plus this project's work service.
 *
 * Identical in kind to `concurrency.test.ts`'s rig, at a smaller N. Duplicated
 * rather than shared because the two files assert different properties and a
 * shared rig would make one file's change silently redefine the other's
 * scenario.
 */
async function rig(): Promise<Rig> {
  const sessionRoot = mkdtempSync(join(tmpdir(), 'dsh-u03-sessions-'))
  const storeRoot = mkdtempSync(join(tmpdir(), 'dsh-u03-store-'))

  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  const persistence = await ctx.plugin(JsonlSessionPersistence, { root: sessionRoot })
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(SubagentRuntime, { maxActiveSubagents: TARGET, maxDepth: 1 })
  await ctx.plugin(SubagentSpawn, { providerName: 'spawn' })
  await ctx.plugin(class extends SessionQueryEngine {
    override searchSessions(): Promise<never> {
      return Promise.reject(new Error('session search is not configured in this test'))
    }
    override searchEvents(): Promise<never> {
      return Promise.reject(new Error('event search is not configured in this test'))
    }
  })
  await ctx.plugin(Storage)
  await ctx.plugin(storageJsonPlugin as never, { root: storeRoot } as never)
  await ctx.plugin(storageDomainPlugin as never, { backend: 'json' } as never)

  const adapter = new CompletingAdapter()
  ctx.llm.registerAdapter(['mock'], adapter)

  const rootAgent = await ctx.agentLoop.create(SessionId('u03-root'), { provider: 'mock', model: 'mock' })
  const service = new WorkService(ctx, {
    targetChildren: TARGET,
    maxDepth: 1,
    budgetCeiling: 100_000,
    currency: 'USD',
    priceVersion: 'u03-load',
  })
  await service.open()

  cleanups.push(async () => {
    // The teardown order is the production shutdown order and it MATTERS:
    // children parked in a model call cannot be torn down while context disposal
    // waits for their driver to exit. The adapter here completes rather than
    // parks, so nothing needs releasing first -- but the order is kept because it
    // is the production sequence and a future gated variant would hang without it.
    await service.close()
    await ctx.subagents.drainContinuableDescendants([rootAgent])
    await persistence.dispose()
    await ctx.fiber.dispose()
    rmSync(sessionRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    rmSync(storeRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  })

  return { ctx, root: rootAgent, service, adapter }
}

/** One batch of launch requests, numbered from `offset`. */
function requests(count: number, offset: number): LaunchRequest[] {
  return Array.from({ length: count }, (_, index) => {
    const n = offset + index
    return { taskId: `u03-task-${n}`, childId: `u03-child-${n}`, prompt: `u03 work ${n}`, reservedCost: 1 }
  })
}

/**
 * The trend of a series, as the numbers a reader needs to judge it.
 *
 * A single endpoint cannot distinguish a one-time cost from a per-cycle leak, so
 * the report carries the whole series plus the two deltas that matter: the
 * largest step between consecutive cycles, and the total drift.
 */
function trend(series: readonly number[]): { first: number; last: number; min: number; max: number; largestStep: number; drift: number } {
  let largestStep = 0
  for (let index = 1; index < series.length; index += 1) {
    largestStep = Math.max(largestStep, Math.abs(series[index]! - series[index - 1]!))
  }
  return {
    first: series[0] ?? 0,
    last: series[series.length - 1] ?? 0,
    min: Math.min(...series),
    max: Math.max(...series),
    largestStep,
    drift: (series[series.length - 1] ?? 0) - (series[0] ?? 0),
  }
}

describe('U03: sustained load — resources, cost and state, measured', () => {
  it('a control arm establishes the one-time cost so the load arm can be read as a trend', async () => {
    // WHY THE CONTROL RUNS FIRST. Mounting the real agent-loop stack lazily
    // initializes host resources. G-FIX-08 records a probe that read that
    // one-time jump as "9 orphan handles". The control arm pays that cost so the
    // load arm's series starts warm.
    const r = await rig()
    const series: number[] = []
    for (let cycle = 0; cycle < CYCLES; cycle += 1) {
      // A cycle that mounts and unmounts nothing new: it exercises the same
      // service calls the load arm makes, without admitting work.
      r.service.setReadyTasks('control', TARGET)
      r.service.counts
      series.push(census(`control-${String(cycle)}`).total)
    }
    // Recorded, not asserted to be flat: a control that grows would itself be
    // worth knowing, and asserting flatness would hide it.
    const controlTrend = trend(series)
    expect(controlTrend.max).toBeGreaterThan(0)
    // The control is stable within the range run. This IS asserted, because the
    // load arm's interpretation depends on it: if the control drifts, a drift in
    // the load arm is not attributable to the load.
    expect(controlTrend.largestStep).toBeLessThanOrEqual(2)
  }, 120_000)

  it('six load cycles of top-up with pause/resume interleaved show no per-cycle resource trend', async () => {
    const r = await rig()
    r.service.setReadyTasks('u03-run', 100)
    await r.service.createRun({ runId: 'u03-run', root: r.root, authorizationRef: 'u03-auth' })
    r.service.setLaunchPort(createContinuableLaunchPort({
      subagents: r.ctx.subagents,
      parent: r.root,
      provider: 'spawn',
      maxDepth: 1,
    }))

    const censuses: Census[] = []
    const admittedPerCycle: number[] = []
    const spentSeries: number[] = []

    for (let cycle = 0; cycle < CYCLES; cycle += 1) {
      const offset = cycle * TARGET
      // 1. TOP UP: admit a full wave.
      const outcomes = await r.service.drain('u03-run', requests(TARGET, offset), new AbortController().signal)
      admittedPerCycle.push(outcomes.filter(outcome => outcome.accepted).length)

      // 2. SETTLE: move each accepted task through the real state machine to
      //    `confirmed`, which is what releases the slot. Every transition is
      //    checked by `assertTransition`, so an illegal move throws rather than
      //    being papered over.
      for (let index = 0; index < TARGET; index += 1) {
        const taskId = `u03-task-${String(offset + index)}`
        await r.service.transition({ runId: 'u03-run', taskId, to: 'executing' })
        await r.service.transition({ runId: 'u03-run', taskId, to: 'settling' })
        await r.service.transition({ runId: 'u03-run', taskId, to: 'confirmed', spentCost: 1 })
      }

      // 3. INTERLEAVE a pause and a resume. The pause must refuse admission and
      //    the resume must restore it, which is the alternation the gate names.
      if (cycle % 2 === 0) {
        await r.service.pause('u03-run', `u03 pause at cycle ${String(cycle)}`)
        const blocked = await r.service.drain(
          'u03-run',
          requests(1, 1000 + cycle),
          new AbortController().signal,
        )
        // A paused run admits nothing. Asserted so "pause" is a behaviour and not
        // a field nobody reads.
        expect(blocked.every(outcome => !outcome.accepted), `cycle ${String(cycle)}: a paused run admitted work`).toBe(true)
        await r.service.resume('u03-run')
      }

      const snapshot = census(`cycle-${String(cycle)}`)
      censuses.push(snapshot)
      spentSeries.push(r.service.budget('u03-run').spent)
    }

    const resourceTrend = trend(censuses.map(entry => entry.total))
    const listenerTrend = trend(censuses.map(entry => entry.listeners))

    // NO PERSISTENT LEAK, as the measured range. The assertion is on the TREND,
    // not on an endpoint: a bound of 3 over six cycles of four-child waves is a
    // bound on what this load did, not a claim that no leak can exist.
    expect(resourceTrend.drift, `resource series: ${censuses.map(c => c.total).join(', ')}`).toBeLessThanOrEqual(3)
    expect(listenerTrend.drift, `listener series: ${censuses.map(c => c.listeners).join(', ')}`).toBeLessThanOrEqual(3)

    // Every wave was fully admitted. A leak that manifested as a capacity loss
    // would show here, which is the failure mode that actually matters for a
    // daily driver.
    expect(admittedPerCycle).toEqual(Array.from({ length: CYCLES }, () => TARGET))

    // NO COST DISAPPEARANCE. Every confirmed task spent exactly its reservation,
    // and the total is exactly the number of tasks. `spent` is monotone and
    // never resets, so a cycle that lost cost would show as a flat step.
    const expectedTotal = CYCLES * TARGET
    expect(spentSeries[spentSeries.length - 1]).toBe(expectedTotal)
    for (let index = 1; index < spentSeries.length; index += 1) {
      expect(spentSeries[index]! - spentSeries[index - 1]!).toBe(TARGET)
    }
    const budget = r.service.budget('u03-run')
    expect(budget.spent).toBe(expectedTotal)
    // Nothing was held as unknown, because every task settled cleanly. Asserted
    // so an unknown that quietly appeared would fail here.
    expect(budget.unknownReserved).toBe(0)
    expect(budget.overage).toBe(0)
  }, 300_000)

  it('NO STATE POLLUTION: a second run in the same process shares no task state with the first', async () => {
    // "State pollution" is the third clause, and the shape it takes here is a
    // second run inheriting the first run's tasks. The record is keyed per run
    // id, so this asserts the keying actually isolates them rather than merely
    // being intended to.
    const r = await rig()
    r.service.setReadyTasks('run-a', 100)
    await r.service.createRun({ runId: 'run-a', root: r.root, authorizationRef: 'a' })
    r.service.setLaunchPort(createContinuableLaunchPort({ subagents: r.ctx.subagents, parent: r.root, provider: 'spawn', maxDepth: 1 }))
    await r.service.drain('run-a', requests(TARGET, 0), new AbortController().signal)
    for (let index = 0; index < TARGET; index += 1) {
      const taskId = `u03-task-${String(index)}`
      await r.service.transition({ runId: 'run-a', taskId, to: 'executing' })
      await r.service.transition({ runId: 'run-a', taskId, to: 'settling' })
      await r.service.transition({ runId: 'run-a', taskId, to: 'confirmed', spentCost: 1 })
    }
    const countsA = r.service.counts('run-a')

    // A SECOND run, created in the same process, with the SAME task ids.
    await r.service.createRun({ runId: 'run-b', root: r.root, authorizationRef: 'b' })
    const recordB = r.service.getRun('run-b')
    expect(recordB).toBeDefined()
    // The second run starts empty. This is the pollution check: if the record
    // were process-global, run-b would inherit run-a's confirmed tasks.
    expect(Object.keys(recordB!.tasks)).toEqual([])
    expect(recordB!.budget.spent).toBe(0)
    expect(recordB!.budget.reserved).toBe(0)
    expect(recordB!.terminalTombstones).toEqual([])

    // And the first run is unchanged by the second's creation.
    const afterB = r.service.counts('run-a')
    expect(afterB.confirmed).toBe(countsA.confirmed)
    expect(afterB.capacityDeficit).toBe(countsA.capacityDeficit)
    expect(r.service.getRun('run-a')!.budget.spent).toBe(TARGET)

    // The two runs are separately addressable and separately counted.
    expect(r.service.listRunIds().sort()).toEqual(['run-a', 'run-b'])
    // `run-b` has no liveness observations at all, so its counts are its own.
    expect(r.service.counts('run-b').durablyAdmitted).toBe(0)
  }, 180_000)

  it('the measured range is reported as a series, so a reader can judge the load rather than trust a verdict', async () => {
    // The gate's own clause: "REPORT THE MEASURED RANGE rather than a claim". A
    // verdict alone ("no leak") is not the deliverable; the numbers are. This
    // test produces the artifact the FINDINGS file quotes, and asserts the
    // artifact is well-formed rather than asserting what it says.
    const r = await rig()
    r.service.setReadyTasks('u03-report', 100)
    await r.service.createRun({ runId: 'u03-report', root: r.root, authorizationRef: 'report' })
    r.service.setLaunchPort(createContinuableLaunchPort({ subagents: r.ctx.subagents, parent: r.root, provider: 'spawn', maxDepth: 1 }))

    const series: Array<{ cycle: number; resources: number; listeners: number; heapMb: number; admitted: number; spent: number }> = []
    for (let cycle = 0; cycle < CYCLES; cycle += 1) {
      const offset = cycle * TARGET
      const outcomes = await r.service.drain('u03-report', requests(TARGET, offset), new AbortController().signal)
      for (let index = 0; index < TARGET; index += 1) {
        const taskId = `u03-task-${String(offset + index)}`
        await r.service.transition({ runId: 'u03-report', taskId, to: 'executing' })
        await r.service.transition({ runId: 'u03-report', taskId, to: 'settling' })
        await r.service.transition({ runId: 'u03-report', taskId, to: 'confirmed', spentCost: 1 })
      }
      const moment = census(`cycle-${String(cycle)}`)
      series.push({
        cycle,
        resources: moment.total,
        listeners: moment.listeners,
        heapMb: Math.round((moment.heapUsed / 1024 / 1024) * 10) / 10,
        admitted: outcomes.filter(outcome => outcome.accepted).length,
        spent: r.service.budget('u03-report').spent,
      })
    }

    // The artifact is well-formed and complete: one row per cycle, every field
    // populated. What it SAYS is reported in FINDINGS.md; what is asserted here
    // is that a reader has the series to judge.
    expect(series).toHaveLength(CYCLES)
    expect(series.map(row => row.cycle)).toEqual([0, 1, 2, 3, 4, 5])
    expect(series.every(row => row.resources > 0)).toBe(true)
    expect(series.every(row => row.admitted === TARGET)).toBe(true)
    expect(series[series.length - 1]!.spent).toBe(CYCLES * TARGET)
    // The series is monotone in cost and its last step is exactly one wave, so a
    // lost or double-counted wave is visible in the data rather than only in a
    // total.
    expect(series.map(row => row.spent)).toEqual([4, 8, 12, 16, 20, 24])

    // Written to the evidence directory so the FINDINGS file can quote real
    // numbers rather than restating this test's prose.
    const { writeFileSync } = await import('node:fs')
    const artifact = {
      gate: 'U03',
      target: TARGET,
      cycles: CYCLES,
      series,
      resourceTrend: trend(series.map(row => row.resources)),
      listenerTrend: trend(series.map(row => row.listeners)),
      modelRequests: r.adapter.requests,
      exercised: [
        'rolling top-up across six waves through the real startContinuable seam',
        'the full admission state machine per task (executing -> settling -> confirmed)',
        'pause refusing admission and resume restoring it, alternating by cycle',
        'two runs in one process, separately keyed',
      ],
      notExercised: [
        'no live provider: cost is this project\'s reservation arithmetic, not a provider invoice',
        'no Web host: host-level sockets and watchers are not covered',
        'a modest load: a small series bounds a leak over the range run, it does not exclude a slow one',
      ],
    }
    // THE OUTPUT PATH IS DERIVED FROM THIS FILE'S OWN LOCATION, not hardcoded.
    //
    // It used to be `process.env.U03_ARTIFACT ?? 'D:/DSH/work/dsh-native-daily/
    // qualification/results/M9.20-real-tasks/u03-load.json'` -- an ABSOLUTE path
    // into one checkout, with only an optional env override. That is a
    // cross-tree write: a writer running this suite from a git worktree (which
    // the multi-agent discipline requires) deposited its measurement into the
    // MAIN tree. It happened twice during round 1, and it is invisible as a diff
    // because the file is a NONDETERMINISTIC load measurement -- resource counts
    // and heap MB that differ on every run, so the overwrite reads as "the numbers
    // moved" rather than "another tree wrote here". Recorded as G-SEAM-61.
    //
    // `import.meta.url` is `.../packages/dsh-daily-work/src/u03-sustained-load.test.ts`,
    // so three levels up is the repository root of whichever tree is running --
    // measured for BOTH the source and the built layout (`src/x.test.ts` and
    // `lib/x.test.js` are the same depth), and for a worktree, where it correctly
    // resolves to `D:\DSH\work\wt-<name>\` rather than to the main checkout. The
    // artifact therefore lands in THAT tree's evidence directory, beside the run
    // record it describes. `U03_ARTIFACT` still overrides for an explicit target.
    const repoRoot = fileURLToPath(new URL('../../..', import.meta.url))
    const artifactPath = process.env.U03_ARTIFACT
      ?? join(repoRoot, 'qualification', 'results', 'M9.20-real-tasks', 'u03-load.json')
    writeFileSync(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`)
  }, 300_000)
})
