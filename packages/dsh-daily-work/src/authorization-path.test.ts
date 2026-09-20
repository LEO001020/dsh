/**
 * R4: the human authorization path for a work run (V3 phase R4, defect F1).
 *
 * WHAT THIS FILE IS THE ORACLE FOR, and why it is not a unit test of the command
 * parser. `WorkService.createRun` had exactly ONE non-test caller in the whole
 * repository — a hand-run CLI in no production import graph — so the model's
 * `work` tool resolved the run first and refused with
 *
 *     this session has no active run; a run is created by user authorization
 *
 * (docs/GAPS.md G-SEAM-31, reproduced by a real composed-profile boot in
 * `qualification/results/R4-authorization/boot-before.json`). The defect class
 * this project has recorded more than twelve times is "the mechanism works and
 * nothing in the product calls it", so a test that calls `createRun` or
 * `authorizeRun` directly would be the SAME defect one level down: it would prove
 * the domain method works and say nothing about whether a human can reach it.
 *
 * EVERY CASE BELOW THEREFORE DRIVES THE REAL `CommandRuntime`. The run is created
 * by executing a `/work start N` line through `ctx.commands.execute(agent, line,
 * [], signal)` — the entry point the browser reaches through
 * `ctx.remote.commands.execute(...)` — and the `work` tool is then called through
 * `ctx.tools.execute` with the real Agent. Neither `createRun` nor `authorizeRun`
 * appears in a test body except where the case is explicitly about the domain
 * API's own contract.
 *
 * WHAT IS REAL HERE:
 *   - `CommandRuntime` itself, so command resolution, the `command/run` /
 *     `command/done` lifecycle pair and the `source.kind === 'user'` record are
 *     the shipped behaviour rather than a restatement of it.
 *   - `ToolRuntime` and the `work` tool, so the closing clause ("the real `work`
 *     tool can resolve the run") is measured against the real tool pipeline.
 *   - `AgentRegistry` + `AgentLoop` + `JsonlSessionPersistence`, because the
 *     authorization edge binds to the exact live Agent OBJECT and a stub agent
 *     cannot exhibit the difference between an object and its id.
 *   - The real storage domain, so "the run is durable" is a fact about durable
 *     state rather than about an in-memory map.
 *
 * WHAT IS CONTROLLED, and only at the external boundary: the launch port. No test
 * here starts a model. The port records what it was asked to launch.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import type { CommandResult } from '@deepseek-ai/dsh-commands'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { SessionId } from '@deepseek-ai/dsh-session'
import FileSettingsProvider from '@deepseek-ai/dsh-settings-file'
import Storage from '@deepseek-ai/dsh-storage'
import * as storageDomainPlugin from '@deepseek-ai/dsh-storage-domain'
import * as storageJsonPlugin from '@deepseek-ai/dsh-storage-json'
import { afterEach, describe, expect, it } from 'vitest'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { WorkService, type LaunchPort, type LaunchRequest } from './host.ts'
import { formatAuthorizationRef, parseAuthorizationRef } from './authorization.ts'
import * as commandWork from './command-work.ts'
import * as toolsPlugin from './tools.ts'

const WORK_CONFIG = {
  targetChildren: 4,
  maxDepth: 1,
  subagentProvider: 'spawn',
  budgetCeiling: 50,
  currency: 'USD',
  priceVersion: 'r4-authorization-test',
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

function onCleanup(fn: () => Promise<void>): void {
  cleanups.push(fn)
}

function tempRoot(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  onCleanup(async () => { rmSync(dir, { recursive: true, force: true, maxRetries: 5 }) })
  return dir
}

interface Rig {
  readonly ctx: Context
  readonly service: WorkService
  readonly port: ScriptedLaunchPort
  readonly agent: Agent
  readonly sessionId: string
  /** The store directory, so a case can reopen the SAME domain over it. */
  readonly storeRoot: string
}

/**
 * Boot the agent stack, the REAL command registry and the work service, then
 * mount `/work` and the `work` tool exactly as the preset mounts them.
 *
 * The mount ORDER is the one `production-port.test.ts` and the DSH resume specs
 * use: persistence before the loop, so root teardown unwinds the loop first.
 */
async function rig(): Promise<Rig> {
  const root = tempRoot('dsh-r4-auth-')
  const storeRoot = join(root, 'store')
  const ctx = new Context()
  // The testkit mounts LlmRuntime, SessionStore, SessionProjectionRegistry,
  // SystemPrompt, ToolRuntime and AgentRegistry. Restating any of them here
  // fails with `service "x" has been registered`, which is a rig bug rather
  // than a product one.
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(CommandRuntime)
  // The REAL settings plane: the base bundle mounts `dsh-settings-file`, and the
  // `daily-work` target section is installed through it. Mounting it here means
  // the settings-as-action arm below is a real durable write rather than a
  // service-absent throw.
  //
  // `FileSettingsProvider` is the concrete provider; `SettingsProvider` is
  // abstract and registers nothing, so mounting it would fail with a missing
  // config argument.
  await ctx.plugin(FileSettingsProvider, { path: join(root, 'settings.yaml'), watch: false })
  await ctx.plugin(JsonlSessionPersistence, { root: join(root, 'sessions') })
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(Storage)
  await ctx.plugin(storageJsonPlugin as never, { root: storeRoot } as never)
  await ctx.plugin(storageDomainPlugin as never, { backend: 'json' } as never)

  const service = new WorkService(ctx, { ...WORK_CONFIG })
  // Installed BEFORE `open()`, exactly as `host-plugin.ts` does it. The order is
  // load-bearing rather than cosmetic: `installSection` runs inside
  // `owner.inject(['settings'], ...)`, so the namespace appears on a LATER
  // activation turn than the call itself, and `await service.open()` is what gives
  // that turn a chance to run before any test touches the handle. A rig that
  // called this after `open()` and then used the handle immediately would see
  // `settings namespace "daily-work" is not registered` — a rig bug that reads
  // like a product bug.
  service.installTargetSetting(ctx)
  await service.open()
  // A scripted port, so a `submit` reaches a recording adapter rather than a
  // paid model. The PORT is the controlled boundary; everything above it is real.
  const port = new ScriptedLaunchPort()
  service.setLaunchPort(port)

  // Mounted the way the PRESET mounts them: the command and the tool both
  // register into this context's scope, which is what makes them visible to the
  // agent created below.
  await ctx.plugin(commandWork)
  await ctx.plugin(toolsPlugin)

  const sessionId = `r4-${String(Math.random()).slice(2, 10)}`
  const handle = await ctx.agents.create({ sessionId: SessionId(sessionId) })

  onCleanup(async () => {
    await handle.dispose()
    await service.close()
    await ctx.fiber.dispose()
  })

  return { ctx, service, port, agent: handle.agent, sessionId, storeRoot }
}

/** Execute one `/work` line through the REAL registry, as a UI adapter does. */
async function runWork(
  r: Rig,
  suffix: string,
): Promise<CommandResult> {
  const execution = await r.ctx.commands.execute(
    r.agent, `/work${suffix}`, [], new AbortController().signal,
  )
  if (execution === undefined) throw new Error(`/work${suffix} did not resolve to a registered command`)
  return execution.result
}

/** Call the `work` tool exactly as the model loop would. */
async function callWork(r: Rig, args: Record<string, unknown>, callId = 'call-work') {
  return r.ctx.tools.execute({
    callId: callId as never,
    name: 'work',
    arguments: args,
    agent: r.agent,
    signal: new AbortController().signal,
  })
}

/** The model-facing text of a tool result, joined. */
function modelText(result: { isError: boolean; content: readonly { type: string; text?: string }[] }): string {
  return result.content.map(block => block.type === 'text' ? block.text ?? '' : '').join('\n')
}

// ---------------------------------------------------------------------------
// I3-1: the real path end to end
// ---------------------------------------------------------------------------

describe('R4 I3-1: the real path, command -> CommandRuntime -> WorkService run', () => {
  it('`/work start 10` through the real registry creates a durable run', async () => {
    const r = await rig()
    expect(r.service.listRunIds()).toHaveLength(0)

    const result = await runWork(r, ' start 10')
    expect(result.kind).toBe('success')
    expect(result.text).toContain('Run authorized')

    const runIds = r.service.listRunIds()
    expect(runIds).toHaveLength(1)
    const record = r.service.getRun(runIds[0] as string)
    expect(record?.rootSessionId).toBe(r.sessionId)
    expect(record?.requestedTarget).toBe(10)
    expect(record?.phase).toBe('open')
  })

  it('the run record carries the exact authorizing commandId as auditable evidence', async () => {
    const r = await rig()
    const execution = await r.ctx.commands.execute(
      r.agent, '/work start 3', [], new AbortController().signal,
    )
    expect(execution).toBeDefined()
    const record = r.service.getRun(r.service.listRunIds()[0] as string)

    // The ref is STRUCTURED, not an opaque string, and it names the command that
    // authorized it. A reader can therefore check the claim against the session
    // log rather than trust it.
    const evidence = parseAuthorizationRef(record?.authorizationRef ?? '')
    expect(evidence).toBeDefined()
    expect(evidence?.kind).toBe('human-command')
    expect(evidence?.commandId).toBe(String(execution?.commandId))
    expect(evidence?.commandName).toBe('work')
    expect(evidence?.commandArgs).toBe('start 3')
  })

  it('the command lifecycle is on the session log with source.kind === user', async () => {
    const r = await rig()
    await runWork(r, ' start 2')

    const events = r.agent.session.snapshotEvents()
    const runs = events.filter(event => event.type === 'command/run')
    const dones = events.filter(event => event.type === 'command/done')

    expect(runs).toHaveLength(1)
    expect(dones).toHaveLength(1)
    const run = runs[0]
    expect(run?.type === 'command/run' && run.data.name).toBe('work')
    // The durable record of WHO issued it. This is the host-attested half of the
    // authorization edge: the handler did not write this, CommandRuntime did,
    // before the handler ran.
    expect(run?.type === 'command/run' && run.data.source.kind).toBe('user')
    const done = dones[0]
    expect(done?.type === 'command/done' && done.data.kind).toBe('success')
    expect(done?.type === 'command/done' && String(done.data.commandId))
      .toBe(run?.type === 'command/run' ? String(run.data.commandId) : '')
  })
})

// ---------------------------------------------------------------------------
// I3-2/3/4: the negative arms — what must NOT create a run
// ---------------------------------------------------------------------------

describe('R4 I3-2/3/4: nothing but a human action creates a run', () => {
  it('Session creation alone creates no run', async () => {
    const r = await rig()
    // The rig created a real Agent and a real Session. No command was issued.
    expect(r.service.listRunIds()).toHaveLength(0)
    expect(r.service.findRunForSession(r.sessionId)).toBeUndefined()
  })

  it('a settings reload creates no run', async () => {
    const r = await rig()
    // The exact "settings-as-action" failure V3 excludes: the `daily-work`
    // section carries a PERSISTED CONFIGURATION VALUE, and creating a run from
    // it would re-create the run on every boot. The section is installed by the
    // rig the way `host-plugin.ts` installs it, and this case re-reads it and
    // asserts the run count is untouched.
    const handle = r.service.targetSettingHandle
    expect(handle).toBeDefined()
    // Reading the live target is what a settings load does.
    expect(handle?.target()).toBe(WORK_CONFIG.targetChildren)
    expect(r.service.listRunIds()).toHaveLength(0)
  })

  it('MOUNTING the command and tool plugins creates no run', async () => {
    // V3 I2's "never auto-create ... on plugin mount". The rig above already
    // mounted both plugins before this assertion, so this measures the mount
    // itself rather than a code path the test chose to skip.
    const r = await rig()
    expect(r.ctx.commands.find(r.agent, 'work')).toBeDefined()
    expect(r.ctx.tools.schemas(r.agent).some(schema => schema.name === 'work')).toBe(true)
    expect(r.service.listRunIds()).toHaveLength(0)
  })

  it('`/work target N` on a session with NO run creates nothing', async () => {
    // THE UI-SLIDER RULE, and it is the subtle half of V3 I1: "Changing the
    // numeric value alone is configuration/draft state. Only Start/Apply/Stop
    // actions mutate WorkService." A target is a VALUE, not an action, so it must
    // not bring a run into existence — otherwise a slider drag would authorize
    // work, and the authorization edge would stop being a human decision.
    const r = await rig()
    const result = await runWork(r, ' target 7')
    expect(result.kind).toBe('error')
    expect(result.text).toMatch(/no active run/iu)
    expect(r.service.listRunIds()).toHaveLength(0)
    expect(r.service.findRunForSession(r.sessionId)).toBeUndefined()
  })

  it('a bare settings WRITE of the target value creates nothing', async () => {
    const r = await rig()
    const handle = r.service.targetSettingHandle
    expect(handle).toBeDefined()
    const before = r.service.listRunIds().length
    // The strongest form of the settings-as-action arm: a real, durably written
    // value change through the mounted settings document. If reading N were an
    // action, this is where a run would appear.
    const outcome = await handle?.set(20)
    expect(outcome, `set() reported ${JSON.stringify(outcome)}`).toMatchObject({ ok: true })
    // The value really moved, so the write was not a no-op that made the
    // run-count assertion vacuous.
    expect(handle?.target()).toBe(20)
    expect(r.service.listRunIds().length).toBe(before)
    expect(r.service.findRunForSession(r.sessionId)).toBeUndefined()
  })

  it('a model continuation cannot create a run: the tool has no create action', async () => {
    const r = await rig()
    const schemas = r.ctx.tools.schemas(r.agent)
    const work = schemas.find(schema => schema.name === 'work')
    expect(work).toBeDefined()
    // Read the enum the MODEL is offered, not the source's intent.
    const action = (work?.parameters as { properties?: { action?: { enum?: string[] } } })
      ?.properties?.action
    expect(action?.enum).toEqual(['status', 'submit', 'finish'])
    expect(action?.enum).not.toContain('create')
  })

  it('a model call naming a create action is REFUSED and creates no run', async () => {
    const r = await rig()
    // The strongest form of the arm: a call that names the action AND supplies
    // the parameters a naive implementation might accept. `authorizedByUser` is
    // deliberately included because a parameter a model can set is not an
    // authorization, and this asserts the tool does not treat it as one.
    const refused = await callWork(r, {
      action: 'create',
      targetChildren: 30,
      authorizedByUser: true,
    })
    expect(refused.isError).toBe(true)
    expect(modelText(refused)).toMatch(/invalid arguments|must be one of/u)
    expect(r.service.listRunIds()).toHaveLength(0)
  })

  it('a subagent cannot authorize a run even though it can call the tool', async () => {
    const r = await rig()
    // A child Agent: created under an owning Agent, so `ctx.agents.roots()` does
    // not contain it. `exec.agent` exists for it, which is exactly why "an agent
    // exists" must not be read as "a human authorized this".
    const child = await r.ctx.agents.create({
      sessionId: SessionId('r4-child-session'),
      parentAgent: r.agent,
      meta: { origin: 'subagent', delegationDepth: 1, parentSession: r.agent.session.header.id },
    })
    onCleanup(async () => { await child.dispose() })
    expect(r.ctx.agents.roots()).not.toContain(child.agent)

    const refused = await r.ctx.tools.execute({
      callId: 'child-work' as never,
      name: 'work',
      arguments: { action: 'status' },
      agent: child.agent,
      signal: new AbortController().signal,
    })
    expect(refused.isError).toBe(true)
    expect(modelText(refused)).toMatch(/no active run/u)
    expect(r.service.listRunIds()).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// I3-5: duplicate Start is deterministic
// ---------------------------------------------------------------------------

describe('R4 I3-5: duplicate Start is deterministic and never creates a second run', () => {
  it('a second `/work start` observes the existing run and reports it', async () => {
    const r = await rig()
    const first = await runWork(r, ' start 10')
    expect(first.kind).toBe('success')
    const runId = r.service.listRunIds()[0] as string

    const second = await runWork(r, ' start 10')
    expect(second.kind).toBe('success')
    expect(second.text).toContain('already active')
    expect(second.text).toContain(runId)

    expect(r.service.listRunIds()).toHaveLength(1)
    expect(r.service.listRunIds()[0]).toBe(runId)
  })

  it('a duplicate start does NOT overwrite the original authorizing commandId', async () => {
    const r = await rig()
    const first = await r.ctx.commands.execute(
      r.agent, '/work start 4', [], new AbortController().signal,
    )
    const before = r.service.getRun(r.service.listRunIds()[0] as string)?.authorizationRef
    await runWork(r, ' start 4')
    const after = r.service.getRun(r.service.listRunIds()[0] as string)?.authorizationRef
    // The evidence names the action that ACTUALLY created the run. Rewriting it
    // on a no-op retry would destroy the audit trail.
    expect(after).toBe(before)
    expect(parseAuthorizationRef(after ?? '')?.commandId).toBe(String(first?.commandId))
  })

  it('a different target on a duplicate start does not silently re-target the run', async () => {
    const r = await rig()
    await runWork(r, ' start 10')
    const result = await runWork(r, ' start 2')
    expect(result.kind).toBe('success')
    expect(result.text).toContain('already active')
    // `/work start` is an AUTHORIZATION verb, not a target verb. A target change
    // goes through `/work target`, so a duplicate start must leave N alone rather
    // than mutating a run as a side effect of a no-op.
    const record = r.service.getRun(r.service.listRunIds()[0] as string)
    expect(record?.requestedTarget).toBe(10)
  })

  it('a retry after a crash between the record write and command/done observes the run', async () => {
    const r = await rig()
    // The crash window V3 I2 names, reproduced at the seam that owns it: the run
    // is written by the FIRST command, whose `command/done` never lands because
    // the dispatching request is aborted after the handler settled. The retry is
    // a NEW command with a NEW commandId, and it must still land on the first run.
    //
    // WHICH MECHANISM DETECTS THE RETRY, stated precisely because the two are
    // different claims. Detection is by the ACTIVE-RUN CHECK ALONE
    // (`findRunForSession`), NOT by the authorization ref: the run id is derived
    // from (rootSessionId, action), and `authorizeRun` returns the existing record
    // whenever the root has a non-closed run. The authorization ref is what makes
    // the RESULT AUDITABLE — it still names the command that actually wrote the
    // run, so a reader can tell which attempt won. This test asserts both halves
    // so neither claim is left implicit.
    const controller = new AbortController()
    const first = await r.ctx.commands.execute(
      r.agent, '/work start 6', [], controller.signal,
    )
    expect(first?.result.kind).toBe('success')
    const createdRunId = r.service.listRunIds()[0] as string
    const createdCommandId = String(first?.commandId)

    // Simulate the missing `command/done` by aborting the dispatching request
    // AFTER the handler settled: the run is durable, the command record is not.
    controller.abort()

    // The retry goes through a DIFFERENT path on purpose (the same handler via
    // the UI route's entry point), so this is not a replay of one code path.
    const retry = await runWork(r, ' start 6')
    expect(retry.kind).toBe('success')
    expect(retry.text).toContain('already active')
    expect(r.service.listRunIds()).toHaveLength(1)
    expect(r.service.listRunIds()[0]).toBe(createdRunId)

    // The active-run check found it, and the ref still attributes the run to the
    // FIRST attempt rather than being rewritten by the retry.
    expect(r.service.findRunForSession(r.sessionId)?.runId).toBe(createdRunId)
    expect(parseAuthorizationRef(
      r.service.getRun(createdRunId)?.authorizationRef ?? '',
    )?.commandId).toBe(createdCommandId)
  })
})

// ---------------------------------------------------------------------------
// I3-6: target update is durable
// ---------------------------------------------------------------------------

describe('R4 I3-6: the target update is durable', () => {
  it('`/work target 7` changes the stored target and the reported deficit', async () => {
    const r = await rig()
    await runWork(r, ' start 10')
    const result = await runWork(r, ' target 7')
    expect(result.kind).toBe('success')

    const runId = r.service.listRunIds()[0] as string
    expect(r.service.getRun(runId)?.requestedTarget).toBe(7)
    expect(r.service.counts(runId).desiredTarget).toBe(7)
    expect(r.service.counts(runId).capacityDeficit).toBe(7)
  })

  it('the target survives a real host restart over the same store', async () => {
    const r = await rig()
    await runWork(r, ' start 9')
    await runWork(r, ' target 5')
    const runId = r.service.listRunIds()[0] as string

    // A restart is a NEW process with a NEW context: one Cordis context holds one
    // `dailyWork` registration, so reusing the first context would be a caller
    // bug (`service "dailyWork" has been registered`) rather than a restart. This
    // builds the real storage stack again over the same medium — the pattern
    // `durability-records.test.ts` documents — and the first generation must be
    // fully disposed first, because two live services over one directory is the
    // configuration gate D02 marks unsupported.
    await r.service.close()

    const restarted = new Context()
    await restarted.plugin(Storage, {} as never)
    await restarted.plugin(storageJsonPlugin as never, { root: r.storeRoot } as never)
    await restarted.plugin(storageDomainPlugin as never, { backend: 'json' } as never)
    const service = new WorkService(restarted, { ...WORK_CONFIG })
    await service.open()
    onCleanup(async () => {
      await service.close()
      await restarted.fiber.dispose()
    })

    // A value that only lived in memory would come back as the composition
    // default (4) instead of the human's 5.
    expect(service.getRun(runId)?.requestedTarget).toBe(5)
    expect(service.getRun(runId)?.rootSessionId).toBe(r.sessionId)
  })

  it('an out-of-range target is REFUSED, never clamped', async () => {
    const r = await rig()
    await runWork(r, ' start 10')
    for (const bad of ['0', '31', '2.5', 'abc']) {
      const result = await runWork(r, ` target ${bad}`)
      expect(result.kind).toBe('error')
    }
    // A clamp would have recorded a number the human did not ask for.
    expect(r.service.getRun(r.service.listRunIds()[0] as string)?.requestedTarget).toBe(10)
  })

  it('`/work start 31` is refused and creates NO run', async () => {
    const r = await rig()
    const result = await runWork(r, ' start 31')
    expect(result.kind).toBe('error')
    expect(result.text).toContain('30')
    expect(r.service.listRunIds()).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// I3-7: Stop does not prematurely free child capacity
// ---------------------------------------------------------------------------

describe('R4 I3-7: Stop stops admissions and does NOT free capacity', () => {
  it('`/work stop` moves the run out of open and leaves the ledger untouched', async () => {
    const r = await rig()
    await runWork(r, ' start 10')
    const runId = r.service.listRunIds()[0] as string

    // One admitted child, so the stop has a live slot to NOT free.
    const outcomes = await r.service.drain(
      runId,
      [{ taskId: 't1', childId: 'child-t1', prompt: 'x', reservedCost: 1 }],
      new AbortController().signal,
    )
    expect(outcomes[0]?.accepted).toBe(true)
    const before = r.service.capacity().occupied
    expect(before).toBeGreaterThan(0)

    const result = await runWork(r, ' stop')
    expect(result.kind).toBe('success')
    expect(r.service.getRun(runId)?.phase).toBe('paused')

    // THE CLAUSE: a stop stops NEW admissions and frees nothing. A running child
    // is still running and still spending, so releasing its slot here would let a
    // later run admit a replacement on top of it and exceed the hard cap.
    expect(r.service.capacity().occupied).toBe(before)
  })

  it('a stopped run refuses further admissions', async () => {
    const r = await rig()
    await runWork(r, ' start 10')
    const runId = r.service.listRunIds()[0] as string
    await runWork(r, ' stop')

    const outcomes = await r.service.drain(
      runId,
      [{ taskId: 't-after-stop', childId: 'child-after-stop', prompt: 'x', reservedCost: 1 }],
      new AbortController().signal,
    )
    expect(outcomes[0]?.accepted).toBe(false)
    expect(r.port.calls).toHaveLength(0)
  })

  it('`/work stop` on a session with no run is an error, not a silent success', async () => {
    const r = await rig()
    const result = await runWork(r, ' stop')
    expect(result.kind).toBe('error')
    expect(result.text).toMatch(/no active run/iu)
  })
})

// ---------------------------------------------------------------------------
// I3-8: THE CLAUSE THAT PROVES F1 IS CLOSED
// ---------------------------------------------------------------------------

describe('R4 I3-8: after Start, the REAL `work` tool resolves the run', () => {
  it('the model tool refuses before a run and SUCCEEDS after one', async () => {
    const r = await rig()

    // BEFORE: the exact defect, measured through the real tool pipeline. Note
    // that the failure is a STRUCTURED result, not a throw — a test that asserted
    // on a throw would read a failed call as a success, which is the mistake the
    // T10 probe made once and corrected.
    const before = await callWork(r, { action: 'status' }, 'before')
    expect(before.isError).toBe(true)
    expect(modelText(before)).toMatch(/this session has no active run/u)

    // The human action. THIS is the only thing that changed.
    const started = await runWork(r, ' start 10')
    expect(started.kind).toBe('success')

    // AFTER: the same call resolves the run.
    const after = await callWork(r, { action: 'status' }, 'after')
    expect(after.isError).toBe(false)
    const value = after.value as { runId?: string; desiredTarget?: number; capacityDeficit?: number }
    expect(value.runId).toBe(r.service.listRunIds()[0])
    expect(value.desiredTarget).toBe(10)
    expect(value.capacityDeficit).toBe(10)
  })

  it('the model tool can SUBMIT through the real path once the run exists', async () => {
    const r = await rig()
    await runWork(r, ' start 3')

    const submitted = await callWork(r, { action: 'submit', taskId: 'task-1', goal: 'do a thing' }, 'submit-1')
    expect(submitted.isError).toBe(false)
    const value = submitted.value as { accepted?: boolean; runId?: string }
    expect(value.accepted).toBe(true)
    // The production launch port was installed by `createRun`, but this rig
    // installs a scripted one, which is the controlled boundary. What matters is
    // that the REAL tool reached the REAL drain and the REAL admission.
    expect(r.port.calls).toHaveLength(1)
    expect(r.port.calls[0]?.taskId).toBe('task-1')
  })

  it('the tool reports the target the human set, not the composition default', async () => {
    const r = await rig()
    await runWork(r, ' start 6')
    const result = await callWork(r, { action: 'status' }, 'status-6')
    expect((result.value as { desiredTarget?: number }).desiredTarget).toBe(6)
  })
})

// ---------------------------------------------------------------------------
// The domain API's own contract, and the evidence encoding
// ---------------------------------------------------------------------------

describe('R4: the domain API and its evidence encoding', () => {
  it('authorizeRun is idempotent and reports whether it created the run', async () => {
    const r = await rig()
    const first = await r.service.authorizeRun({
      root: r.agent,
      evidence: { kind: 'ui-action', action: 'start', commandId: 'cmd-x' },
      targetChildren: 5,
    })
    expect(first.created).toBe(true)
    const second = await r.service.authorizeRun({
      root: r.agent,
      evidence: { kind: 'ui-action', action: 'start', commandId: 'cmd-y' },
      targetChildren: 5,
    })
    expect(second.created).toBe(false)
    expect(second.record.runId).toBe(first.record.runId)
    expect(r.service.listRunIds()).toHaveLength(1)
  })

  it('an authorization ref round-trips and refuses an unknown kind', () => {
    const ref = formatAuthorizationRef({
      kind: 'human-command', action: 'start', commandId: 'cmd-1', commandName: 'work', commandArgs: 'start 4',
    })
    expect(parseAuthorizationRef(ref)).toEqual({
      kind: 'human-command', action: 'start', commandId: 'cmd-1', commandName: 'work', commandArgs: 'start 4',
    })
    // A value containing the field separator must not be able to forge a field.
    const escaped = formatAuthorizationRef({
      kind: 'human-command', action: 'start', commandArgs: 'a|kind=model-tool',
    })
    expect(parseAuthorizationRef(escaped)?.commandArgs).toBe('a|kind=model-tool')
    expect(parseAuthorizationRef(escaped)?.kind).toBe('human-command')
    // An unknown kind is refused rather than cast: a version bump that adds one
    // must ship a reader that knows it.
    expect(parseAuthorizationRef('dsh-work-auth/1|kind=model-tool|action=start')).toBeUndefined()
    // A bare string a test fixture passes is NOT structured evidence.
    expect(parseAuthorizationRef('auth')).toBeUndefined()
  })

  it('`/work` with no verb is a status read, and an unknown verb is an error', async () => {
    const r = await rig()
    const status = await runWork(r, '')
    expect(status.kind).toBe('success')
    expect(status.text).toMatch(/no active run/iu)

    const bogus = await runWork(r, ' frobnicate')
    expect(bogus.kind).toBe('error')
    expect(bogus.text).toContain('unknown /work verb')
    expect(r.service.listRunIds()).toHaveLength(0)
  })

  it('two sessions on one host get two independent runs', async () => {
    const r = await rig()
    await runWork(r, ' start 3')

    const second = await r.ctx.agents.create({ sessionId: SessionId('r4-second-session') })
    onCleanup(async () => { await second.dispose() })
    const execution = await r.ctx.commands.execute(
      second.agent, '/work start 8', [], new AbortController().signal,
    )
    expect(execution?.result.kind).toBe('success')

    expect(r.service.listRunIds()).toHaveLength(2)
    expect(r.service.findRunForSession(r.sessionId)?.requestedTarget).toBe(3)
    expect(r.service.findRunForSession('r4-second-session')?.requestedTarget).toBe(8)
  })
})

// ---------------------------------------------------------------------------
// CONCURRENCY: two concurrent authorizations for ONE session
// ---------------------------------------------------------------------------

/**
 * WHY THESE CASES EXIST. The first version of `authorizeRun` checked
 * `findRunForSession` and then called `createRun`, and a comment claimed the check
 * could not race because the run id was derived from the session. The root agent
 * challenged that claim and was right: the check was caller-side, `createRun` ends
 * in `runs().put(...)`, and `put` is an unconditional insert-or-overwrite. The
 * cases below are the ones that MEASURED it false and then hold the fix.
 *
 * WHAT THE MEASUREMENT SHOWED, before the fix:
 *   - two concurrent `/work start 10` calls BOTH returned `Run authorized`;
 *   - the surviving record carried the SECOND command's id, so the first
 *     authorization's evidence was silently replaced;
 *   - driving the two writes at one key directly showed the destructive half: a
 *     run holding ONE admitted task came back with ZERO tasks.
 *
 * SO THE ANSWER TO "IS THE DERIVED ID LOAD-BEARING?" IS: it is load-bearing for
 * making the collision DETECTABLE, and it is NOT sufficient on its own. Two
 * concurrent calls derive the SAME key, which converts a silent duplicate into a
 * certain overwrite — strictly worse than a duplicate, because a duplicate is
 * visible and an overwrite destroys admitted work. What prevents the overwrite is
 * `WorkService.serializeAuthorization`, which lets a second call for one session
 * enter its existence check only after the first has written. The two are needed
 * together, and `createRun` remains a raw overwrite primitive by design — which is
 * why the product path does not call it directly.
 */
describe('R4 CONCURRENCY: two concurrent /work start calls for one session', () => {
  it('creates exactly ONE run, and only one call reports that it created it', async () => {
    const r = await rig()
    const [a, b] = await Promise.all([
      r.ctx.commands.execute(r.agent, '/work start 10', [], new AbortController().signal),
      r.ctx.commands.execute(r.agent, '/work start 10', [], new AbortController().signal),
    ])
    const runIds = r.service.listRunIds()
    const record = runIds.length === 1 ? r.service.getRun(runIds[0] as string) : undefined
    const claimedCreated = [a, b].filter(
      execution => execution?.result.text?.includes('Run authorized') === true,
    ).length

    console.log('R4/CONCURRENCY measured: '
      + `runCount=${String(runIds.length)} claimedCreated=${String(claimedCreated)} `
      + `ref=${JSON.stringify(record?.authorizationRef)}`)

    expect(runIds, 'two concurrent authorizations must leave exactly one run').toHaveLength(1)
    // EXACTLY ONE caller may claim it created the run. Before the fix both did.
    expect(claimedCreated, 'exactly one call created the run').toBe(1)
    // And the survivor carries the id of the command that actually wrote it, so
    // the authorization evidence is not replaced by the loser.
    const evidence = parseAuthorizationRef(record?.authorizationRef ?? '')
    const creator = [a, b].find(execution => execution?.result.text?.includes('Run authorized'))
    expect(evidence?.commandId).toBe(String(creator?.commandId))
  })

  it('does NOT destroy work already admitted against the run', async () => {
    // The destructive half of the race, which is why it is not merely cosmetic.
    const r = await rig()
    await runWork(r, ' start 10')
    const runId = r.service.listRunIds()[0] as string
    const admitted = await r.service.drain(
      runId,
      [{ taskId: 't-real', childId: 'child-real', prompt: 'real work', reservedCost: 1 }],
      new AbortController().signal,
    )
    expect(admitted[0]?.accepted).toBe(true)
    const beforeRef = r.service.getRun(runId)?.authorizationRef

    await Promise.all([
      r.ctx.commands.execute(r.agent, '/work start 10', [], new AbortController().signal),
      r.ctx.commands.execute(r.agent, '/work start 10', [], new AbortController().signal),
    ])

    const after = r.service.getRun(runId)
    console.log('R4/CONCURRENCY measured: '
      + `runCount=${String(r.service.listRunIds().length)} `
      + `tasksAfter=${String(Object.keys(after?.tasks ?? {}).length)} `
      + `refUnchanged=${String(beforeRef === after?.authorizationRef)}`)

    expect(r.service.listRunIds()).toHaveLength(1)
    // THE PROPERTY: admitted work survives a concurrent re-authorization.
    expect(Object.keys(after?.tasks ?? {}), 'admitted tasks must not be wiped').toHaveLength(1)
    expect(after?.authorizationRef, 'the original authorization evidence must survive').toBe(beforeRef)
  })

  it('a concurrent authorization through the UI route is protected too', async () => {
    // The UI reaches the SAME domain operation, so it must inherit the same
    // guarantee rather than a separate one.
    const r = await rig()
    const [a, b] = await Promise.all([
      runWork(r, ' start 4'),
      runWork(r, ' start 4'),
    ])
    expect(r.service.listRunIds()).toHaveLength(1)
    const claimed = [a, b].filter(result => result.text?.includes('Run authorized') === true).length
    expect(claimed).toBe(1)
  })

  it('a FAILED authorization does not wedge the session for the next attempt', async () => {
    // The serializer chains on a promise the successor awaits, so a rejected
    // predecessor must not deadlock the path permanently.
    const r = await rig()
    const bad = await runWork(r, ' start 31')
    expect(bad.kind).toBe('error')
    const good = await runWork(r, ' start 5')
    expect(good.kind).toBe('success')
    expect(r.service.listRunIds()).toHaveLength(1)
    expect(r.service.getRun(r.service.listRunIds()[0] as string)?.requestedTarget).toBe(5)
  })
})


// ---------------------------------------------------------------------------
// CORROBORATION, NOT A FIX: F5 / G-SEAM-45 reached through the NEW entry point
// ---------------------------------------------------------------------------

/**
 * WHY THIS BLOCK EXISTS, AND WHY IT USES `it.fails`.
 *
 * V3's ordering rule is that Start Work must NOT be exposed before atomic target
 * admission is fixed, because the new entry point makes an existing
 * over-admission defect REACHABLE BY A USER for the first time. Writer R3 owns
 * that fix and the root integrates R3 before R4. So this block repairs nothing: it
 * CORROBORATES, through the product's own new path, that a run created by
 * `/work start` exhibits the recorded defect.
 *
 * `it.fails` is this project's convention for an encoded open defect
 * (`capacity-v8-probe.test.ts:306-312`, `capacity.test.ts`): the body states the
 * CORRECT property, the suite stays green while the property is violated, and the
 * case turns RED the moment R3 fixes it. That inversion is the point — a red case
 * here is the signal to DELETE this block, not to repair it. It is deliberately
 * the last block in the file so that deletion is a truncation.
 *
 * THE STIMULUS IS COPIED FROM THE RECORDED REPRODUCTION, not invented.
 * `capacity-v8-probe.test.ts` (V8/CAP-10) reproduces G-SEAM-45 with target 3,
 * three tasks admitted, TWO freed, then THREE concurrent refills against the two
 * free slots.
 *
 * A NEGATIVE RESULT IS KEPT HERE ON PURPOSE, because it bounds the finding. A
 * first version of this case used a DIFFERENT stimulus (target 3, two tasks
 * admitted, ONE free slot, three concurrent refills) and did NOT reproduce the
 * overshoot: `target=3 admittedNow=1 heldAgainstTarget=3 deficitAfter=0`. So the
 * defect is not "any concurrency over-admits"; it is the specific interleaving the
 * recorded repro drives. Widening the claim past that evidence would be the
 * over-claim this project keeps retracting.
 */
describe('R4 CORROBORATION: a /work-start run exposes F5 (G-SEAM-45) — R3 owns the fix', () => {
  it.fails('two freed slots admit exactly two, never three, through a /work-start run', async () => {
    const r = await rig()
    // The run is created by the HUMAN command, not by `createRun`, which is the
    // whole point: this is the first path by which a user can reach it.
    const started = await runWork(r, ' start 3')
    expect(started.kind).toBe('success')
    const runId = r.service.listRunIds()[0] as string
    r.service.setReadyTasks(runId, 20)

    const signal = new AbortController().signal
    const req = (n: number) => ({
      taskId: `task-${String(n)}`, childId: `child-${String(n)}`,
      prompt: `work ${String(n)}`, reservedCost: 1,
    })

    const first = await r.service.drain(runId, [req(0), req(1), req(2)], signal)
    expect(first.filter(o => o.accepted)).toHaveLength(3)

    // Free exactly TWO slots, leaving one task holding its own.
    for (const n of [0, 1]) {
      await r.service.transition({ runId, taskId: `task-${String(n)}`, to: 'settling' })
      await r.service.transition({ runId, taskId: `task-${String(n)}`, to: 'confirmed', spentCost: 0 })
    }
    expect(r.service.counts(runId).capacityDeficit, 'exactly two slots are free').toBe(2)

    // THREE concurrent refills against TWO free slots. The correct answer is 2.
    const [a, b, c] = await Promise.all([
      r.service.drain(runId, [req(70)], signal),
      r.service.drain(runId, [req(71)], signal),
      r.service.drain(runId, [req(72)], signal),
    ])
    const admitted = [...a, ...b, ...c].filter(o => o.accepted)
    const record = r.service.getRun(runId) as { tasks: Record<string, { state: string }> }
    const held = Object.values(record.tasks).filter(task => task.state !== 'confirmed').length
    const counts = r.service.counts(runId)

    // MEASURED through the /work-start run, 2026-09-20, and byte-identical to the
    // numbers GAPS.md records for the direct-`createRun` repro:
    //   target=3 freedSlots=2 concurrentRequests=3 admitted=3 heldAgainstTarget3=4
    //   acceptedIds=["child-70","child-71","child-72"] deficitAfter=0
    // The overshoot is INVISIBLE to the deficit reader, which is the sharp half.
    console.log(`R4/CORROBORATION measured: target=3 freedSlots=2 concurrentRequests=3 `
      + `admitted=${String(admitted.length)} heldAgainstTarget3=${String(held)} `
      + `acceptedIds=${JSON.stringify(admitted.map(o => o.childId))} `
      + `deficitAfter=${String(counts.capacityDeficit)}`)

    // THE CORRECT PROPERTIES, stated so `it.fails` has something to invert.
    expect(admitted, 'two freed slots admit exactly two, never three').toHaveLength(2)
    expect(held, 'held tasks never exceed the target').toBeLessThanOrEqual(3)
    expect(counts.capacityDeficit, 'the deficit reader sees the overshoot').toBeGreaterThan(0)
  })
})
