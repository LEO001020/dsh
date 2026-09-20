/**
 * P7 / UI-DEFAULT + UI-ACTIVE-RUN: the setting is a default for FUTURE runs, and
 * the active run's target is a DIFFERENT durable value changed only by a command.
 *
 * WHAT THIS FILE MEASURES, and it is the V5 section 13 defect verbatim:
 *
 *   V5 section 13, on `target-setting.ts`: "active run admission uses durable
 *   `record.requestedTarget`. The setting is read when a new run is created
 *   unless a command supplies N. `onChange` is empty. Therefore the setting is a
 *   default for a future run, not the live target of an existing run."
 *
 * The two oracles V5 section 18 names for this slice:
 *
 *   UI-DEFAULT       changing the default only affects later runs.
 *   UI-ACTIVE-RUN    Apply Target changes the selected run's durable
 *                    `requestedTarget` through CommandRuntime.
 *
 * WHY A SEPARATE FILE FROM `target-setting.test.ts`. That file owns the SETTING's
 * own contract (range, fencing, the live read). This file owns the RELATIONSHIP
 * between the setting and a run's durable target, which is the thing that was
 * wrong. Keeping them apart means the existing 33 arms stay the setting's
 * oracle and this file is the split's oracle, and neither can be satisfied by
 * the other.
 *
 * THE COMMAND PATH IS DRIVEN THROUGH THE REAL `CommandRuntime`, not by calling
 * `authorizeSetTarget` directly. That is deliberate and it is the R4 lesson: the
 * defect class this project records most often is "the mechanism works and
 * nothing in the product calls it", so a test that calls the domain method would
 * prove the method and say nothing about whether `/work target N` reaches it.
 * `ctx.commands.execute(agent, '/work target N', [], signal)` is exactly the
 * entry point the browser card reaches through `ctx.remote.commands.execute`.
 *
 * WHAT IS CONTROLLED: the launch port only. No model is sampled.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { SessionId } from '@deepseek-ai/dsh-session'
import FileSettingsProvider from '@deepseek-ai/dsh-settings-file'
import Storage from '@deepseek-ai/dsh-storage'
import * as storageDomainPlugin from '@deepseek-ai/dsh-storage-domain'
import * as storageJsonPlugin from '@deepseek-ai/dsh-storage-json'
import { afterEach, describe, expect, it } from 'vitest'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { WorkService, type LaunchPort, type LaunchRequest } from './host.ts'
import { DAILY_WORK_NS } from './target-setting.ts'
import * as commandWork from './command-work.ts'

const WORK_CONFIG = {
  targetChildren: 6,
  maxDepth: 1,
  subagentProvider: 'spawn',
  budgetCeiling: 50,
  currency: 'USD',
  priceVersion: 'p7-ui-test',
} as const

/** A port that records what it was asked to start and resolves on ACCEPTANCE. */
class ScriptedLaunchPort implements LaunchPort {
  readonly calls: LaunchRequest[] = []

  async launch(request: LaunchRequest): Promise<{ childId: string }> {
    this.calls.push(request)
    return { childId: request.childId }
  }
}

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  const errors: unknown[] = []
  for (const cleanup of cleanups.splice(0).reverse()) {
    try {
      await cleanup()
    } catch (error) {
      errors.push(error)
    }
  }
  if (errors.length > 0) throw new AggregateError(errors, 'cleanup failed')
})

function tempRoot(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  cleanups.push(async () => { rmSync(dir, { recursive: true, force: true, maxRetries: 5 }) })
  return dir
}

interface Rig {
  readonly ctx: Context
  readonly service: WorkService
  readonly port: ScriptedLaunchPort
  readonly agent: Agent
  readonly sessionId: string
  /** The durable JSON store directory, so a case can show a value is ON DISK. */
  readonly storeRoot: string
  /** The settings document path, so a case can show the default is ON DISK. */
  readonly settingsPath: string
}

/**
 * Boot the real stack and mount `/work` the way the preset mounts it.
 *
 * The mount ORDER is the one `authorization-path.test.ts` and
 * `production-port.test.ts` use, and `installTargetSetting` runs BEFORE `open()`
 * for the reason that file documents: the namespace appears on a later
 * activation turn, so a handle read immediately after `installSection` would see
 * "namespace is not registered" — a rig bug that reads like a product bug.
 */
async function rig(): Promise<Rig> {
  const root = tempRoot('dsh-p7-ui-')
  const storeRoot = join(root, 'store')
  const settingsPath = join(root, 'settings.yaml')
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(CommandRuntime)
  await ctx.plugin(FileSettingsProvider, { path: settingsPath, watch: false })
  await ctx.plugin(JsonlSessionPersistence, { root: join(root, 'sessions') })
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(Storage)
  await ctx.plugin(storageJsonPlugin as never, { root: storeRoot } as never)
  await ctx.plugin(storageDomainPlugin as never, { backend: 'json' } as never)

  const service = new WorkService(ctx, { ...WORK_CONFIG })
  service.installTargetSetting(ctx)
  await service.open()
  const port = new ScriptedLaunchPort()
  service.setLaunchPort(port)
  await ctx.plugin(commandWork)

  const sessionId = `p7-${String(Math.random()).slice(2, 10)}`
  const handle = await ctx.agents.create({ sessionId: SessionId(sessionId) })

  cleanups.push(async () => {
    await handle.dispose()
    await service.close()
    await ctx.fiber.dispose()
  })

  return { ctx, service, port, agent: handle.agent, sessionId, storeRoot, settingsPath }
}

/** Execute one `/work` line through the REAL registry, as a UI adapter does. */
async function runWork(r: Rig, suffix: string): Promise<string> {
  const execution = await r.ctx.commands.execute(
    r.agent, `/work${suffix}`, [], new AbortController().signal,
  )
  if (execution === undefined) throw new Error(`/work${suffix} did not resolve to a registered command`)
  return execution.result.text ?? ''
}

/** The one run this session owns, through the service's own session lookup. */
function activeRun(r: Rig) {
  const found = r.service.findRunForSession(r.sessionId)
  if (found === undefined) throw new Error('expected an active run for this session')
  return found
}

/** The run's DURABLE target, re-read from the record rather than from a count. */
function durableTarget(r: Rig): number {
  return r.service.getRun(activeRun(r).runId)!.requestedTarget
}

// ---------------------------------------------------------------------------
// UI-DEFAULT: the global setting is a default for FUTURE runs only
// ---------------------------------------------------------------------------

describe('P7 UI-DEFAULT: the global setting is a default for FUTURE runs, not the active run', () => {
  it('THE DEFECT: changing the setting does NOT move a live run\'s durable target', async () => {
    // This is the arm that would have caught the mislabelling V5 section 13
    // reports. The setting is described as the live UI target; the honest
    // behaviour is that a live run is governed by its own durable
    // `requestedTarget` and a setting write cannot reach it.
    const r = await rig()
    await runWork(r, ' start 4')

    // The run recorded the CONFIGURED default at creation, because no N was
    // named. `WORK_CONFIG.targetChildren` is the composition entry, which is what
    // the settings section's base layer resolves to while no user write exists.
    expect(durableTarget(r)).toBe(4)

    // Write the GLOBAL setting through the real settings plane, the same write a
    // card's "default" control performs.
    const revision = r.service.targetSettingHandle!.revision()
    const outcome = await r.service.targetSettingHandle!.set(12, revision)
    expect(outcome.ok).toBe(true)
    // The live read follows immediately -- the setting IS live, for new runs.
    expect(r.service.targetActiveChildren()).toBe(12)

    // ...and the ACTIVE RUN is untouched. This is the whole point: a setting
    // change that appeared to affect the active run would be the defect.
    expect(durableTarget(r)).toBe(4)
    // The refusal is not merely invisible in the record: admission still judges
    // against the run's own target.
    expect(r.service.counts(activeRun(r).runId).desiredTarget).toBe(4)
  })

  it('a run created AFTER the write picks up the new default, and only then', async () => {
    const r = await rig()
    await runWork(r, ' start 4')
    await r.service.targetSettingHandle!.set(12, r.service.targetSettingHandle!.revision())

    // A SECOND session's run, so this is genuinely a new run rather than the
    // existing run being re-read.
    const second = await r.ctx.agents.create({ sessionId: SessionId(`p7b-${String(Math.random()).slice(2, 8)}`) })
    cleanups.push(async () => { await second.dispose() })
    const execution = await r.ctx.commands.execute(
      second.agent, '/work start', [], new AbortController().signal,
    )
    expect(execution?.result.kind).toBe('success')
    const created = r.service.findRunForSession(second.agent.session.header.id)
    expect(created).toBeDefined()
    // The new run resolved the LIVE setting, which is what makes the setting a
    // default rather than dead configuration.
    expect(r.service.getRun(created!.runId)!.requestedTarget).toBe(12)

    // The first run still carries its own value: two runs, two targets, one
    // setting. That separation is the split V5 section 13 asks for.
    expect(durableTarget(r)).toBe(4)
  })

  it('an explicit N on the command OVERRIDES the default, in both directions', async () => {
    const r = await rig()
    await r.service.targetSettingHandle!.set(12, r.service.targetSettingHandle!.revision())
    // The setting says 12; the human says 3. The human wins, because the setting
    // is a default and not a ceiling.
    await runWork(r, ' start 3')
    expect(durableTarget(r)).toBe(3)
  })
})

// ---------------------------------------------------------------------------
// UI-ACTIVE-RUN: Apply Target moves the SELECTED run through CommandRuntime
// ---------------------------------------------------------------------------

describe('P7 UI-ACTIVE-RUN: `/work target N` moves the selected run and nothing else', () => {
  it('changes the durable requestedTarget of the active run through the real registry', async () => {
    const r = await rig()
    await runWork(r, ' start 4')
    expect(durableTarget(r)).toBe(4)

    const text = await runWork(r, ' target 9')
    expect(text).toContain('Target updated')
    expect(durableTarget(r)).toBe(9)
    // The durable value is what admission judges against, so the counts follow.
    expect(r.service.counts(activeRun(r).runId).desiredTarget).toBe(9)
  })

  it('does NOT write the global setting, so other runs keep their own targets', async () => {
    // The mirror of the UI-DEFAULT arm. A `/work target` that also wrote the
    // global setting would make one run's target silently become every future
    // run's default, which is the same conflation from the other side.
    const r = await rig()
    await runWork(r, ' start 4')
    const before = r.service.targetSettingHandle!.target()
    await runWork(r, ' target 9')
    expect(r.service.targetSettingHandle!.target()).toBe(before)
    // And the namespace was not written either -- the durable document is the
    // evidence, not the live read.
    const descriptor = r.ctx.get('settings')!.describe({ redactSecrets: true })
      .find(candidate => candidate.ns === DAILY_WORK_NS)
    expect(descriptor?.user).toBeUndefined()
  })

  it('is a REFUSAL, not a clamp, for an out-of-range N', async () => {
    // `command-work.ts` documents why: a clamped target records a number the
    // human did not ask for. Asserted here through the command so the UI's
    // behaviour is the command's behaviour.
    const r = await rig()
    await runWork(r, ' start 4')
    for (const bad of ['0', '31', '2.5', 'twelve', '-1']) {
      const text = await runWork(r, ` target ${bad}`)
      expect(text, `target ${bad} must be refused`).not.toContain('Target updated')
      expect(durableTarget(r), `target ${bad} must not move the run`).toBe(4)
    }
  })

  it('refuses when the session has no run, rather than creating one', async () => {
    // The authority edge must not be a back door to run creation: `/work target`
    // requires an existing run, and only `/work start` may create one.
    const r = await rig()
    const text = await runWork(r, ' target 9')
    expect(text).toContain('No active run for this session')
    expect(r.service.listRunIds()).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// The two are independently addressable, which is what the split buys
// ---------------------------------------------------------------------------

describe('P7 split: the default and the active target are independently addressable', () => {
  it('a setting write and a target command move DIFFERENT stored values', async () => {
    const r = await rig()
    await runWork(r, ' start 4')
    const runId = activeRun(r).runId

    // Move the default.
    await r.service.targetSettingHandle!.set(20, r.service.targetSettingHandle!.revision())
    // Move the run.
    await runWork(r, ' target 7')

    // Both moved, independently: the setting is 20, the run is 7. A single
    // conflated value could not hold both.
    expect(r.service.targetSettingHandle!.target()).toBe(20)
    expect(r.service.getRun(runId)!.requestedTarget).toBe(7)
  })

  it('the setting survives a restart and the run keeps its own durable target', async () => {
    // Durability is the reason these are two values rather than one: the setting
    // is a document entry, the run target is a Work record field. A reader who
    // conflated them would have to explain which one a restart restores.
    const r = await rig()
    await runWork(r, ' start 4')
    await runWork(r, ' target 7')
    await r.service.targetSettingHandle!.set(20, r.service.targetSettingHandle!.revision())

    // Both are on disk, in TWO different files, which is the structural reason
    // they cannot be one value. The setting is the settings document; the run
    // target is the Work store.
    const { readFileSync, readdirSync } = await import('node:fs')
    expect(readFileSync(r.settingsPath, 'utf8')).toContain('defaultTargetActiveChildren: 20')
    const runId = activeRun(r).runId
    const stored = readdirSync(r.storeRoot)
      .filter(name => name.endsWith('.json'))
      .map(name => readFileSync(join(r.storeRoot, name), 'utf8'))
      .join('\n')
    expect(stored).toContain('"requestedTarget": 7')
    expect(stored).not.toContain('"requestedTarget": 20')

    // A second host generation is a NEW root context over the SAME storage
    // directory. Registering a second service of the same name on one context is
    // a caller bug and Cordis rejects it, so the reopen must not try.
    const ctx2 = new Context()
    await ctx2.plugin(Storage)
    await ctx2.plugin(storageJsonPlugin as never, { root: r.storeRoot } as never)
    await ctx2.plugin(storageDomainPlugin as never, { backend: 'json' } as never)
    const reopened = new WorkService(ctx2, { ...WORK_CONFIG })
    await reopened.open()
    cleanups.push(async () => {
      await reopened.close()
      await ctx2.fiber.dispose()
    })
    // The RUN survived the restart with its own target. The setting is the
    // provider's document and is deliberately not re-read here: this service's
    // handle was never installed on `ctx2`, and asserting a value it cannot read
    // would be measuring the fixture.
    expect(reopened.getRun(runId)?.requestedTarget).toBe(7)
  })
})
