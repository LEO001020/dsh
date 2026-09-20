/**
 * B04-B08: the tool protocol gates, closed against the REAL DSH runtime.
 *
 * These five gates are all about the same pipeline — the one
 * `packages/core/tools/src/index.ts` documents as
 * "pre-policy, guards, around-dispatch, post-policy, definition-owned content
 * finalization, and final notification" — and about what a consumer is entitled
 * to believe when a call passes through it.
 *
 * WHAT IS REAL HERE, and why each is not optional:
 *   - `ToolRuntime` itself, so guards, the waterfall order, canonical-value
 *     validation and `tools/result` containment are the shipped behaviour and
 *     not a restatement of it.
 *   - `AgentRegistry` + `AgentLoop` + `JsonlSessionPersistence`, because B04 is
 *     about object identity surviving a resume and a stub agent cannot exhibit
 *     that (an earlier attempt in this project used a stub and learned it the
 *     hard way; see the note in terminal.test.ts).
 *   - `AgentPresets` with a real standing mount, because B05 is about a closure
 *     shared across Sessions and only the real roster shares one.
 *   - `NodePtcRuntime` (the released TypeScript backend), because B06 asks
 *     whether the PTC path and the native path produce the same canonical value
 *     and a fake runtime would only prove that a fake agrees with itself.
 *   - The real storage domain, so B08's "the record is the authority" is a fact
 *     about durable state rather than about an in-memory map.
 *
 * WHAT IS CONTROLLED, and only at the external boundary:
 *   - the launch port (`LaunchPort`), which in production calls
 *     `ctx.subagents.startContinuable`. Starting a real child needs a model
 *     provider, and the plan forbids building a second model loop to simulate
 *     one. B05 and B08 assert admission and record state, neither of which
 *     depends on a model.
 *   - the model adapter is never needed at all: no test here opens a turn.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import AgentPresets from '@deepseek-ai/dsh-agent-presets'
import LlmRuntime, { ToolCallId } from '@deepseek-ai/dsh-llm'
import FileSystem from '@deepseek-ai/dsh-fs-local'
import NodePtcRuntime from '@deepseek-ai/dsh-ptc-runtime-node'
import Sandbox from '@deepseek-ai/dsh-sandbox-local'
import SandboxPolicy from '@deepseek-ai/dsh-sandbox-policy'
import SessionStore, { SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import Storage from '@deepseek-ai/dsh-storage'
import * as storageDomainPlugin from '@deepseek-ai/dsh-storage-domain'
import * as storageJsonPlugin from '@deepseek-ai/dsh-storage-json'
import Subprocess from '@deepseek-ai/dsh-subprocess-local'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { RUN_CODE_NAME, defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolExecution, ToolGuard } from '@deepseek-ai/dsh-tools'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import Group from '@deepseek-ai/cordis-plugin-group'
import { PluginPackages } from '@deepseek-ai/dsh-app-boot'
import { afterEach, describe, expect, it } from 'vitest'
import { WorkService, type LaunchPort, type LaunchRequest } from './host.ts'
import { reconcileTask } from './reconcile.ts'
import { exactOwnerDenialReason, isExactLiveOwner } from './tool-protocol-guards.ts'
import * as toolsPlugin from './tools.ts'
import * as guardPlugin from './tool-protocol-guards.ts'

/** The work-service configuration every rig uses. */
const WORK_CONFIG = {
  targetChildren: 4,
  maxDepth: 1,
  budgetCeiling: 50,
  currency: 'USD',
  priceVersion: 'tool-protocol-test',
} as const

/**
 * A launch port that records what it was asked to start and resolves.
 *
 * It resolves on ACCEPTANCE, which is the port's documented contract
 * (`LaunchPort` in host.ts: "It must NOT resolve on completion"). Nothing in
 * this file waits for a child to do anything.
 */
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

/** Register one teardown that must run even when a test body throws. */
function onCleanup(fn: () => Promise<void>): void {
  cleanups.push(fn)
}

/** A temporary directory removed at teardown, retrying the Windows delete races. */
async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  onCleanup(() => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }))
  return dir
}

// ---------------------------------------------------------------------------
// B04 rig: a real Agent registry with real persistence, so a resume is possible
// ---------------------------------------------------------------------------

/**
 * One owned agent plus the capability that tears it down.
 *
 * `AgentHandle.dispose` is documented as "a CAPABILITY: among consumers, only
 * the holder can tear this agent down", and `ctx.agents.get(id)` returns a bare
 * Agent with no disposer. A resume therefore needs its handle retained: the
 * persistence backend refuses a second write claim on a session whose previous
 * handle is still open (`SessionAlreadyOwnedError`), which is the same
 * single-writer rule the run record relies on.
 */
interface OwnedAgent {
  readonly agent: Agent
  dispose(): Promise<void>
}

interface OwnerRig {
  readonly ctx: Context
  readonly service: WorkService
  readonly port: ScriptedLaunchPort
  /** Create (or resume) an agent under one exact session id. */
  create(sessionId: string): Promise<OwnedAgent>
  resume(sessionId: string): Promise<OwnedAgent>
}

/**
 * Boot the agent stack with persistence and this project's work service.
 *
 * The mount order is the one `resume.spec.ts` uses in the DSH source: the
 * persistence backend mounts BEFORE the loop, so root teardown unwinds the loop
 * first and live agents drain their writers into still-open handles.
 */
async function ownerRig(): Promise<OwnerRig> {
  const sessions = await tempDir('dsh-tp-b04-sessions-')
  const store = await tempDir('dsh-tp-b04-store-')
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(JsonlSessionPersistence, { root: sessions })
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(Storage, {} as never)
  await ctx.plugin(storageJsonPlugin as never, { root: store } as never)
  await ctx.plugin(storageDomainPlugin as never, { backend: 'json' } as never)

  const service = new WorkService(ctx, { ...WORK_CONFIG })
  await service.open()
  const port = new ScriptedLaunchPort()
  service.setLaunchPort(port)

  onCleanup(async () => {
    await service.close()
    await ctx.fiber.dispose()
  })

  return {
    ctx,
    service,
    port,
    create: async (sessionId: string) => {
      const handle = await ctx.agents.create({ sessionId: SessionId(sessionId) })
      return { agent: handle.agent, dispose: () => handle.dispose() }
    },
    resume: async (sessionId: string) => {
      const handle = await ctx.agents.resume({ resumeSessionId: SessionId(sessionId) })
      return { agent: handle.agent, dispose: () => handle.dispose() }
    },
  }
}

/**
 * Seed a persisted session with the smallest RESUMABLE log.
 *
 * Persistence deliberately writes no artifact for a truly empty session, and
 * `resume` requires a stored log. A balanced completed turn is the smallest one
 * that satisfies the durable validator (the same fixture `resume.spec.ts` uses).
 */
async function seedResumableSession(ctx: Context, sessionId: string): Promise<void> {
  const seed: SessionEvent[] = [
    { type: 'turn/start', seq: SessionSeq(0), time: 1, data: { turn: 1 } },
    { type: 'turn/end', seq: SessionSeq(1), time: 2, data: { turn: 1, reason: { kind: 'completed' } } },
  ]
  const detached = ctx.sessions.prepare(SessionId(sessionId))
  const handle = await ctx.sessionPersistence.create(detached.header)
  await handle.append(seed)
  await handle.close()
}

/** Call the `work` tool exactly as the loop would, on behalf of one exact agent. */
async function callWork(
  ctx: Context,
  agent: Agent | undefined,
  args: Record<string, unknown>,
  callId = 'call-work',
) {
  return ctx.tools.execute({
    callId: ToolCallId(callId),
    name: 'work',
    arguments: args,
    ...agent === undefined ? {} : { agent },
    signal: new AbortController().signal,
  })
}

/** The model-facing text of a result, joined; empty for a value-only outcome. */
function modelText(result: { isError: boolean; content: readonly { type: string; text?: string }[] }): string {
  return result.content.map(block => block.type === 'text' ? block.text ?? '' : '').join('\n')
}

describe('B04: the same SessionId resumed as a new Agent must not let the old object write', () => {
  it('a resume publishes a DIFFERENT object under the SAME id, which is the whole hazard', async () => {
    // This is the measured premise of B04, asserted rather than assumed. If a
    // resume ever returned the identical object, every other test in this block
    // would be vacuous.
    const r = await ownerRig()
    await seedResumableSession(r.ctx, 'owner-session')

    const first = await r.resume('owner-session')
    expect(r.ctx.agents.get(SessionId('owner-session'))).toBe(first.agent)
    // Disposing the handle is what a session end does. The next resume on the
    // same id must be able to claim the write handle again.
    await first.dispose()
    expect(r.ctx.agents.get(SessionId('owner-session'))).toBeUndefined()

    const second = await r.resume('owner-session')
    expect(second.agent).not.toBe(first.agent)
    // The identity a string comparison would use is IDENTICAL.
    expect(String(second.agent.id)).toBe(String(first.agent.id))
    expect(String(second.agent.session.header.id)).toBe(String(first.agent.session.header.id))
    // The identity the registry actually holds is the new object.
    expect(r.ctx.agents.get(SessionId('owner-session'))).toBe(second.agent)
    expect(r.ctx.agents.get(SessionId('owner-session'))).not.toBe(first.agent)
  })

  it('refuses a stale owner at the guard, and the live owner still works', async () => {
    const r = await ownerRig()
    await seedResumableSession(r.ctx, 'owner-session')
    // Mount the exact-owner guard the way a host profile would: at the host
    // plane, so it covers every agent in the process.
    await r.ctx.plugin(guardPlugin as never, {} as never)
    await r.ctx.plugin(toolsPlugin as never, {} as never)

    const first = await r.resume('owner-session')
    const oldAgent = first.agent
    await r.service.createRun({ runId: 'run-1', root: oldAgent, authorizationRef: 'auth-1' })
    const before = JSON.stringify(r.service.getRun('run-1'))

    // A NEW lifecycle takes the same session id. The run record still names the
    // session, so both objects map to it by the string test in tools.ts.
    await first.dispose()
    const second = await r.resume('owner-session')
    const newAgent = second.agent
    expect(r.ctx.agents.get(SessionId('owner-session'))).toBe(newAgent)

    // The OLD object tries to move the run to `closing`.
    const stale = await callWork(r.ctx, oldAgent, { action: 'finish' }, 'stale-finish')
    expect(stale.isError).toBe(true)
    expect(modelText(stale)).toMatch(/is not the registered agent instance/)
    expect(modelText(stale)).toMatch(/stale owner/)

    // It could not pollute the new run: the record is byte-identical.
    expect(JSON.stringify(r.service.getRun('run-1'))).toBe(before)
    expect(r.service.getRun('run-1')?.phase).toBe('open')

    // The live owner is unaffected and can still drive its own run.
    const live = await callWork(r.ctx, newAgent, { action: 'status' }, 'live-status')
    expect(live.isError).toBe(false)
    expect(live.isError ? undefined : live.value).toMatchObject({ action: 'status', runId: 'run-1', desiredTarget: 4 })
  })

  it('the guard is load-bearing: without it the stale object IS accepted', async () => {
    // Recording the gap is the point of this test. `findRunFor` in tools.ts
    // compares `record.rootSessionId === agent.session.header.id`, both strings,
    // so a superseded Agent object resolves to the run the NEW lifecycle owns.
    // This is what the guard exists to stop; asserting it keeps the guard from
    // being removed as redundant.
    const r = await ownerRig()
    await seedResumableSession(r.ctx, 'owner-session')
    await r.ctx.plugin(toolsPlugin as never, {} as never)

    const first = await r.resume('owner-session')
    await r.service.createRun({ runId: 'run-1', root: first.agent, authorizationRef: 'auth-1' })
    await first.dispose()
    await r.resume('owner-session')

    const stale = await callWork(r.ctx, first.agent, { action: 'finish' }, 'stale-finish')
    expect(stale.isError).toBe(false)
    expect(r.service.getRun('run-1')?.phase).toBe('closing')
  })

  it('the registry identity test is the discipline the terminal and jobs services use', () => {
    // Quoted from the real sources, because this project must mirror DSH rather
    // than invent a parallel rule.
    //
    // packages/terminal/terminal/src/index.ts:
    //     private isLiveOwner(owner: Agent): boolean {
    //       return !this.disposedOwners.has(owner) && this.ctx.get('agents')?.get(owner.id) === owner
    //     }
    //     private ensureOwnerCleanup(owner: Agent): void {
    //       if (!this.isLiveOwner(owner)) {
    //         throw new TerminalError(`agent "${owner.id}" is not the registered PTY owner`, 'OWNER_NOT_LIVE')
    //
    // packages/jobs/jobs-local/src/index.ts:
    //     if (agents.get(ownerId) !== owner) {
    //       throw new Error(`agent "${ownerId}" is not the registered agent instance ...`)
    //
    // Both compare OBJECT IDENTITY. The guard must refuse without a registry at
    // all, which is the fail-closed direction: absence of the registry is not
    // evidence that an owner is live.
    const bare = new Context()
    const lookalike = { id: SessionId('x'), session: { header: { id: 'x' } } } as unknown as Agent
    expect(isExactLiveOwner(bare, lookalike)).toBe(false)
    expect(exactOwnerDenialReason(bare, { name: 'work', agent: lookalike } as unknown as Readonly<ToolExecution>))
      .toMatch(/not the registered agent instance/)
    // Another tool is left alone: the guard is not a blanket refusal.
    expect(exactOwnerDenialReason(bare, { name: 'other', agent: lookalike } as unknown as Readonly<ToolExecution>))
      .toBeUndefined()
    // An agentless call is left to the tool body's own, more specific refusal.
    expect(exactOwnerDenialReason(bare, { name: 'work' } as unknown as Readonly<ToolExecution>)).toBeUndefined()
  })

  it('the run record carries no epoch, so identity is the only enforceable check', async () => {
    // HONEST RECORD, not a passing claim. The record used to carry an `epoch`
    // documented as "bumped when a run is re-adopted by a new host generation",
    // but nothing read or wrote it after `initialRunRecord` set 1, and no call
    // site accepted an epoch to compare. A "stale epoch is refused" assertion
    // would therefore have been testing a field that cannot be presented. The
    // field and the guard that would have read it are now DELETED
    // (qualification/results/R9-recovery-topology/). What IS asserted here is the
    // thing that survives: object identity is the enforceable check, and the
    // events B04 describes do not resurrect any generation-fencing claim.
    const r = await ownerRig()
    await seedResumableSession(r.ctx, 'owner-session')
    await r.ctx.plugin(guardPlugin as never, {} as never)
    await r.ctx.plugin(toolsPlugin as never, {} as never)

    const oldAgent = await r.resume('owner-session')
    await r.service.createRun({ runId: 'run-1', root: oldAgent.agent, authorizationRef: 'auth-1' })
    expect(Object.hasOwn(r.service.getRun('run-1')!, 'epoch'), 'no epoch field may exist').toBe(false)

    await oldAgent.dispose()
    await r.resume('owner-session')
    await callWork(r.ctx, oldAgent.agent, { action: 'finish' }, 'stale-finish')
    // The stale object's `finish` was refused by the object-identity guard, so the
    // run never left `open` — that is the property, and it is measured rather than
    // assumed.
    expect(r.service.getRun('run-1')?.phase).toBe('open')
    expect(Object.hasOwn(r.service.getRun('run-1')!, 'epoch')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// B05 rig: two Sessions on the SAME preset, which is one shared closure
// ---------------------------------------------------------------------------

interface PresetRig {
  readonly ctx: Context
  readonly service: WorkService
  readonly port: ScriptedLaunchPort
  agent(sessionId: string): Promise<Agent>
}

/**
 * Boot a preset roster whose one row is the REAL `tools.ts`, then compose two
 * agents from it.
 *
 * The row names the plugin by ABSOLUTE PATH, which
 * `classifyRowSpecifier` classifies as `kind: 'file'` and turns into a file URL.
 * That is the same route a locally authored preset takes for a plugin it ships,
 * and it keeps this test pointed at the production consumer rather than a copy.
 */
async function presetRig(): Promise<PresetRig> {
  const root = await tempDir('dsh-tp-b05-preset-')
  const presetDir = join(root, 'standard')
  await mkdir(presetDir, { recursive: true })
  const pluginPath = resolve(import.meta.dirname, 'tools.ts')
  await writeFile(join(presetDir, 'agent.cordis.yml'), `- id: daily-work-tools\n  name: ${pluginPath}\n`)
  const store = await tempDir('dsh-tp-b05-store-')

  const ctx = new Context()
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  await ctx.plugin(PluginPackages)
  ctx.loader.builtins.include = Include
  ctx.loader.builtins.group = Group
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt, { personaPrefix: '' })
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(AgentPresets, {
    default: 'standard',
    roots: [{ path: root, trust: 'user' }],
    includeShippedRoot: false,
    includeUserRoot: false,
  })
  await ctx.plugin(Storage, {} as never)
  await ctx.plugin(storageJsonPlugin as never, { root: store } as never)
  await ctx.plugin(storageDomainPlugin as never, { backend: 'json' } as never)

  const service = new WorkService(ctx, { ...WORK_CONFIG })
  await service.open()
  const port = new ScriptedLaunchPort()
  service.setLaunchPort(port)
  onCleanup(async () => {
    await service.close()
    await ctx.fiber.dispose()
  })

  return {
    ctx,
    service,
    port,
    agent: async (sessionId: string) => (await ctx.agents.create({
      sessionId: SessionId(sessionId),
      setup: async (agentCtx: Context) => void await ctx.agentPresets.mount(agentCtx, 'standard'),
    })).agent,
  }
}

describe('B05: two roots on the same preset must be fully isolated', () => {
  it('the preset is ONE standing mount, so the tool definition object is shared', async () => {
    // This is the trap B05 names. `mount.ts` on the standing mount: "its plugin
    // instances, tool registrations, prompt sections, and projection units exist
    // exactly once, keyed per session inside the plugins themselves". So the
    // `apply(ctx)` closure in tools.ts runs ONCE and every Session of that
    // generation reaches the same ToolDefinition object. Any mutable per-agent
    // field in that closure would be a cross-session bug, which is why tools.ts
    // holds none and resolves the run from the service on every call.
    const r = await presetRig()
    const { livePresetMounts, standingMountFor } = await import('@deepseek-ai/dsh-agent-presets')

    const a = await r.agent('sess-a')
    const b = await r.agent('sess-b')

    // One mount, joined by both agents — not two compositions that happen to agree.
    expect(livePresetMounts()).toHaveLength(1)
    const mountA = standingMountFor(a.ctx)
    const mountB = standingMountFor(b.ctx)
    expect(mountA).toBeDefined()
    expect(mountA).toBe(mountB)
    expect(mountA?.presetId).toBe('standard')

    // And the tool the model would call is literally the same object for both.
    expect(r.ctx.tools.get('work', a)).toBe(r.ctx.tools.get('work', b))
    expect(r.ctx.tools.schemas(a).map(s => s.name)).toEqual(['work'])
    expect(r.ctx.tools.schemas(b).map(s => s.name)).toEqual(['work'])
    // The host scope itself carries no agent tool, which is the point of the
    // preset plane: the consumer is an ancestor contribution, not a global one.
    expect(r.ctx.tools.schemas().map(s => s.name)).toEqual([])
  })

  it('interleaved calls keep tasks, budget and cancellation per run', async () => {
    const r = await presetRig()
    const a = await r.agent('sess-a')
    const b = await r.agent('sess-b')

    // Different targets and different ready counts, so a leaked counter would
    // show up as a wrong number rather than as an ambiguous one.
    await r.service.createRun({ runId: 'run-a', root: a, authorizationRef: 'auth-a', targetChildren: 2 })
    await r.service.createRun({ runId: 'run-b', root: b, authorizationRef: 'auth-b', targetChildren: 3 })
    r.service.setReadyTasks('run-a', 5)
    r.service.setReadyTasks('run-b', 9)

    // --- interleaved, strictly alternating -----------------------------------
    const a1 = await callWork(r.ctx, a, { action: 'status' }, 'a1')
    expect(a1.isError ? undefined : a1.value).toMatchObject({ runId: 'run-a', desiredTarget: 2, readyTasks: 5 })

    const b1 = await callWork(r.ctx, b, { action: 'status' }, 'b1')
    expect(b1.isError ? undefined : b1.value).toMatchObject({ runId: 'run-b', desiredTarget: 3, readyTasks: 9 })

    // A submits. Its task and its credit land in A's record only.
    const a2 = await callWork(r.ctx, a, { action: 'submit', taskId: 't1', goal: 'work for A' }, 'a2')
    expect(a2.isError ? undefined : a2.value).toMatchObject({ runId: 'run-a', accepted: true, taskState: 'accepted' })
    expect(r.service.getRun('run-a')?.tasks['t1']?.state).toBe('accepted')
    expect(r.service.getRun('run-a')?.budget.reserved).toBe(1)
    expect(r.service.getRun('run-b')?.tasks).toEqual({})
    expect(r.service.getRun('run-b')?.budget.reserved).toBe(0)

    // B submits the SAME taskId. Task ids are per-run, so this must be admitted
    // in B and must not disturb A.
    const b2 = await callWork(r.ctx, b, { action: 'submit', taskId: 't1', goal: 'work for B' }, 'b2')
    expect(b2.isError ? undefined : b2.value).toMatchObject({ runId: 'run-b', accepted: true, taskState: 'accepted' })
    expect(r.service.getRun('run-b')?.budget.reserved).toBe(1)
    expect(r.service.getRun('run-a')?.budget.reserved).toBe(1)

    const b3 = await callWork(r.ctx, b, { action: 'submit', taskId: 't2', goal: 'more for B' }, 'b3')
    expect(b3.isError ? undefined : b3.value).toMatchObject({ runId: 'run-b', accepted: true })
    expect(r.service.getRun('run-b')?.budget.reserved).toBe(2)
    expect(r.service.getRun('run-a')?.budget.reserved).toBe(1)

    // --- cancellation isolation ---------------------------------------------
    // A user pauses run-a. B must be untouched: a pause is a per-run record
    // change plus a refusal to admit, never a shared flag.
    await r.service.pause('run-a', 'user paused A')
    const a3 = await callWork(r.ctx, a, { action: 'submit', taskId: 't2', goal: 'should be refused' }, 'a3')
    expect(a3.isError ? undefined : a3.value).toMatchObject({ accepted: false, reason: 'run_not_open' })
    expect(r.service.getRun('run-a')?.tasks['t2']).toBeUndefined()

    const b4 = await callWork(r.ctx, b, { action: 'submit', taskId: 't3', goal: 'still allowed for B' }, 'b4')
    expect(b4.isError ? undefined : b4.value).toMatchObject({ runId: 'run-b', accepted: true })
    expect(r.service.getRun('run-b')?.phase).toBe('open')

    // --- closure: no per-run state leaked into the tool ---------------------
    const a4 = await callWork(r.ctx, a, { action: 'status' }, 'a4')
    const b5 = await callWork(r.ctx, b, { action: 'status' }, 'b5')
    expect(a4.isError ? undefined : a4.value).toMatchObject({
      runId: 'run-a', desiredTarget: 2, durablyAdmitted: 1, cancelled: 0,
    })
    expect(b5.isError ? undefined : b5.value).toMatchObject({
      runId: 'run-b', desiredTarget: 3, durablyAdmitted: 3, cancelled: 0,
    })
    // The launches went to the two runs and nowhere else.
    expect(r.port.calls.map(c => c.taskId).sort()).toEqual(['t1', 't1', 't2', 't3'])
  })

  it('a run is found by the calling agent, not by whichever run was touched last', async () => {
    // The failure this excludes is a `currentRun`-style field: after B acts, A
    // must still resolve A. Reading it in the opposite order from the writes is
    // what makes that a real check.
    const r = await presetRig()
    const a = await r.agent('sess-a')
    const b = await r.agent('sess-b')
    await r.service.createRun({ runId: 'run-a', root: a, authorizationRef: 'auth-a', targetChildren: 1 })
    await r.service.createRun({ runId: 'run-b', root: b, authorizationRef: 'auth-b', targetChildren: 7 })

    await callWork(r.ctx, b, { action: 'status' }, 'b1')
    const afterB = await callWork(r.ctx, a, { action: 'status' }, 'a1')
    expect(afterB.isError ? undefined : afterB.value).toMatchObject({ runId: 'run-a', desiredTarget: 1 })

    await callWork(r.ctx, a, { action: 'status' }, 'a2')
    const afterA = await callWork(r.ctx, b, { action: 'status' }, 'b2')
    expect(afterA.isError ? undefined : afterA.value).toMatchObject({ runId: 'run-b', desiredTarget: 7 })
  })

  it('a session with no run is refused rather than handed another session run', async () => {
    const r = await presetRig()
    const a = await r.agent('sess-a')
    const stranger = await r.agent('sess-stranger')
    await r.service.createRun({ runId: 'run-a', root: a, authorizationRef: 'auth-a' })

    const refused = await callWork(r.ctx, stranger, { action: 'status' }, 's1')
    expect(refused.isError).toBe(true)
    expect(modelText(refused)).toMatch(/has no active run/)
  })
})

// ---------------------------------------------------------------------------
// B06: the canonical value is one thing, the model text is another
// ---------------------------------------------------------------------------

interface PtcRig {
  readonly ctx: Context
  readonly service: WorkService
  readonly port: ScriptedLaunchPort
}

/**
 * Boot the work service plus the RELEASED TypeScript PTC runtime.
 *
 * The runtime is real (`NodePtcRuntime`), mounted with its real dependencies
 * (`fs-local`, `subprocess-local`, `sandbox-local`, `sandbox-policy`). It spawns
 * a Node subprocess per program, which costs a few hundred milliseconds and is
 * the only way to prove the two paths agree rather than to prove a fake agrees
 * with itself. `mode: 'both'` is used so ONE registry exposes both `work` and
 * the reserved `run_code` transport: that is what makes the comparison a
 * comparison of two routes through one pipeline.
 *
 * The consumer is mounted GLOBALLY here rather than through a preset. That is
 * the other supported composition and it keeps this rig about the protocol
 * rather than about the preset plane, which B05 already covers.
 */
async function ptcRig(): Promise<PtcRig> {
  const store = await tempDir('dsh-tp-b06-store-')
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt, { personaPrefix: '' })
  await ctx.plugin(ToolRuntime, { mode: 'both' })
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(Storage, {} as never)
  await ctx.plugin(storageJsonPlugin as never, { root: store } as never)
  await ctx.plugin(storageDomainPlugin as never, { backend: 'json' } as never)
  await ctx.plugin(FileSystem)
  await ctx.plugin(Subprocess)
  await ctx.plugin(Sandbox)
  await ctx.plugin(SandboxPolicy, { mode: 'danger-full-access' })
  await ctx.plugin(NodePtcRuntime)

  const service = new WorkService(ctx, { ...WORK_CONFIG })
  await service.open()
  const port = new ScriptedLaunchPort()
  service.setLaunchPort(port)
  onCleanup(async () => {
    await service.close()
    await ctx.fiber.dispose()
  })
  await ctx.plugin(toolsPlugin as never, {} as never)
  return { ctx, service, port }
}

/** Call `work` through the PTC `run_code` transport and return the canonical value. */
async function callWorkThroughPtc(ctx: Context, agent: Agent, callId: string) {
  const result = await ctx.tools.execute({
    callId: ToolCallId(callId),
    name: RUN_CODE_NAME,
    arguments: {
      code: 'const v = await tools.work({ action: "status" }); return v',
      description: 'read the work status through PTC',
    },
    agent,
    signal: new AbortController().signal,
  })
  return result
}

describe('B06: native and PTC must produce the SAME canonical value', () => {
  it('both routes return one identical canonical JSON value for the same call', async () => {
    const r = await ptcRig()
    const agent = await r.ctx.agents.create({ sessionId: SessionId('sess-b06') }).then(h => h.agent)
    await r.service.createRun({ runId: 'run-b06', root: agent, authorizationRef: 'auth-b06', targetChildren: 3 })
    r.service.setReadyTasks('run-b06', 4)

    const native = await callWork(r.ctx, agent, { action: 'status' }, 'native-1')
    expect(native.isError).toBe(false)
    if (native.isError) throw new Error('native call failed')
    // The canonical value is execution-local and deliberately absent from
    // durable events (ToolExecutionSuccess: "Execution-local canonical value").
    expect(native.value).toMatchObject({ action: 'status', runId: 'run-b06', desiredTarget: 3, readyTasks: 4 })

    const ptc = await callWorkThroughPtc(r.ctx, agent, 'ptc-1')
    expect(ptc.isError).toBe(false)
    if (ptc.isError) throw new Error(`PTC call failed: ${ptc.error.message}`)
    // `run_code`'s own canonical output is `{ logs, result, sandbox? }`; the
    // program's completion value rides in `result`, and that is the value the
    // program actually received from the binding.
    const throughPtc = (ptc.value as { result?: unknown }).result
    expect(throughPtc).toBeDefined()

    // THE ASSERTION: one canonical JSON value, reached two ways.
    expect(throughPtc).toEqual(native.value)
    // And it is a real structured value, not prose the caller must parse.
    expect(typeof throughPtc).toBe('object')
    expect(JSON.stringify(throughPtc)).toBe(JSON.stringify(native.value))
  })

  it('the model text is a projection of the value, not a second source of truth', async () => {
    // `ToolOutputDefinition.render` is documented as "Pure projection from
    // validated arguments and value to Native/model content", and the canonical
    // value is a SEPARATE field. Conflating them is what would make a caller
    // parse prose to learn an id, so the distinction is asserted directly.
    const r = await ptcRig()
    const agent = await r.ctx.agents.create({ sessionId: SessionId('sess-b06b') }).then(h => h.agent)
    await r.service.createRun({ runId: 'run-b06', root: agent, authorizationRef: 'auth-b06' })

    const native = await callWork(r.ctx, agent, { action: 'status' }, 'native-1')
    if (native.isError) throw new Error('native call failed')

    // `content` is ContentBlock[]; `value` is JSON. Different fields, different
    // types, and the value is the frozen authority.
    expect(Array.isArray(native.content)).toBe(true)
    expect(native.content[0]).toMatchObject({ type: 'text' })
    expect(native.value).not.toBe(native.content)
    expect(Object.isFrozen(native.value)).toBe(true)
    // The rendering is `JSON.stringify(value, null, 2)` (tools.ts), so parsing it
    // back yields the value exactly. That is what makes the text a PROJECTION:
    // nothing in it is absent from the value, and the model can read it while a
    // program gets the structure.
    const rendered = native.content[0] as { type: 'text'; text: string }
    expect(JSON.parse(rendered.text)).toEqual(native.value)

    // The PTC route carries the SAME value under `run_code`'s own canonical
    // shape `{ logs, result, sandbox? }`. The program receives `result` — the
    // structure — not the rendered text, which is the point: a caller never has
    // to parse the model's view to get at the data.
    const ptc = await callWorkThroughPtc(r.ctx, agent, 'ptc-1')
    if (ptc.isError) throw new Error('PTC call failed')
    const ptcValue = ptc.value as { result?: unknown; logs?: unknown }
    expect(ptcValue.logs).toEqual([])
    expect(ptcValue.result).toEqual(native.value)
    // `run_code`'s own schema is closed too, so the wrapper cannot smuggle a
    // field past the caller either.
    const ptcSchema = r.ctx.tools.get(RUN_CODE_NAME, agent)!.output.schema as { additionalProperties?: boolean }
    expect(ptcSchema.additionalProperties).toBe(false)
  })

  it('rejects a value that is not lossless JSON, rather than coercing it', async () => {
    // "no BigInt / circular value": the canonical-value boundary is
    // `snapshotToolValue` -> `snapshotJsonValue`, which returns `undefined` for a
    // lossy value and becomes `ToolOutputError` with code INVALID_TOOL_OUTPUT.
    // The fixture tool declares the SAME shape as `work`'s output schema
    // (`additionalProperties: false`), so the contract under test is the one the
    // work tool is subject to.
    const r = await ptcRig()
    // These cases are deliberately values the declared output schema CANNOT
    // represent: a bigint, a cycle, an undefined field and a function. Refusing
    // to emit them is the behaviour under test. The cast is confined to this
    // boundary because `execute` is typed to return the declared shape, and the
    // entire premise here is returning something else -- typing the map as the
    // output type would make the file fail to compile for the right reason but
    // for the wrong test.
    type Declared = { action: string }
    const cases: Record<string, () => Declared> = {
      bigint: () => ({ action: 'status', count: 1n }) as unknown as Declared,
      circular: () => {
        const value: Record<string, unknown> = { action: 'status' }
        value.self = value
        return value as unknown as Declared
      },
      undefinedField: () => ({ action: 'status', note: undefined }) as unknown as Declared,
      functionField: () => ({ action: 'status', fn: () => 1 }) as unknown as Declared,
    }
    for (const [label, body] of Object.entries(cases)) {
      r.ctx.tools.register(defineTool({
        name: `lossy_${label}`,
        description: `returns a lossy value (${label})`,
        parameters: {},
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: { action: { type: 'string', required: true } },
          },
          render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
        },
        execute: () => Promise.resolve(body()),
      }))
      const result = await r.ctx.tools.execute({
        callId: ToolCallId(`lossy-${label}`),
        name: `lossy_${label}`,
        arguments: {},
        signal: new AbortController().signal,
      })
      expect(result.isError, `${label} must be refused`).toBe(true)
      expect(result.isError ? result.error.info?.code : undefined).toBe('INVALID_TOOL_OUTPUT')
    }
  })

  it('rejects an undeclared field, so no unvalidated field can reach a caller', async () => {
    const r = await ptcRig()
    const agent = await r.ctx.agents.create({ sessionId: SessionId('sess-b06c') }).then(h => h.agent)
    await r.service.createRun({ runId: 'run-b06', root: agent, authorizationRef: 'auth-b06' })

    // The REAL work tool, widened by a post-execute listener. This is the
    // strongest form of the assertion: the smuggled field is one a compromised
    // or careless listener tries to add, and the tool's own declared schema
    // refuses it after the listener ran.
    r.ctx.on('tools/post-execute', async () => ({
      kind: 'accept',
      value: { action: 'status', runId: 'run-b06', smuggled: 'widened by a listener' },
    }))
    const widened = await callWork(r.ctx, agent, { action: 'status' }, 'widened')
    expect(widened.isError).toBe(true)
    expect(widened.isError ? widened.error.info?.code : undefined).toBe('INVALID_TOOL_OUTPUT')
    expect(widened.isError ? widened.error.message : '').toMatch(/additionalProperties: false/)
  })

  it('declares a closed output schema, which is what makes the field list enforceable', async () => {
    const r = await ptcRig()
    const agent = await r.ctx.agents.create({ sessionId: SessionId('sess-b06d') }).then(h => h.agent)
    const definition = r.ctx.tools.get('work', agent)
    expect(definition).toBeDefined()
    const schema = definition!.output.schema as {
      type?: string
      additionalProperties?: boolean
      properties?: Record<string, unknown>
    }
    expect(schema.type).toBe('object')
    expect(schema.additionalProperties).toBe(false)
    // Every count is declared individually: there is no single merged "workers"
    // number that could hide a disagreement (the counting module's premise).
    expect(Object.keys(schema.properties ?? {})).toEqual(expect.arrayContaining([
      'desiredTarget', 'readyTasks', 'durablyAdmitted', 'launching', 'activeAssignments',
      'waitingOwnedTool', 'providerWaiting', 'stopping', 'quarantinedUnknown',
      'confirmed', 'cancelled', 'capacityDeficit', 'deficitReason',
    ]))
  })
})

// ---------------------------------------------------------------------------
// B07: the guard stage is synchronous and monotonic
// ---------------------------------------------------------------------------

describe('B07: a guard cannot be widened by a later listener, and async is not a guard', () => {
  it('a later pre-execute listener cannot turn the guard denial into an allow', async () => {
    // Quoted contract (packages/core/tools/src/index.ts):
    //
    //   "A monotonic execution guard evaluated after every `tools/pre-execute`
    //    listener and before the tool body. Returning a reason denies the call;
    //    returning `undefined` leaves it unchanged. Because guards have no allow
    //    result, listener ordering cannot turn a denial back into permission."
    //
    //   export type ToolGuard = (execution: Readonly<ToolExecution>) => string | undefined
    //
    // and the guard stage runs after the whole waterfall:
    //
    //   const gate = await this.ctx.waterfall(carrier, 'tools/pre-execute', exec, () => allow)
    //   const denialReason = decision.kind === 'allow' ? this.guardReason(exec) : decision.reason
    const r = await ptcRig()
    const agent = await r.ctx.agents.create({ sessionId: SessionId('sess-b07') }).then(h => h.agent)
    await r.service.createRun({ runId: 'run-b07', root: agent, authorizationRef: 'auth-b07' })
    const before = JSON.stringify(r.service.getRun('run-b07'))

    let bodyRuns = 0
    r.ctx.tools.guard(() => 'the monotonic guard denies')
    // Registered AFTER the guard, and it does the one thing that must not work:
    // it returns allow without consulting `next`.
    r.ctx.on('tools/pre-execute', () => Promise.resolve({ kind: 'allow' as const }))
    // And again with `prepend: true`, so it runs BEFORE every other listener —
    // the ordering that would win if the guard were a listener.
    r.ctx.on('tools/pre-execute', () => Promise.resolve({ kind: 'allow' as const }), { prepend: true })
    // A counting listener proves the waterfall really ran and really said allow.
    r.ctx.on('tools/pre-execute', async (_exec, next) => {
      const decision = await next()
      expect(decision.kind).toBe('allow')
      return decision
    })

    const denied = await callWork(r.ctx, agent, { action: 'finish' }, 'denied')
    expect(denied.isError).toBe(true)
    expect(modelText(denied)).toMatch(/the monotonic guard denies/)
    expect(bodyRuns).toBe(0)
    // The denial is final: the run did not move.
    expect(JSON.stringify(r.service.getRun('run-b07'))).toBe(before)
  })

  it('an async function is NOT accepted as a guard return value', async () => {
    // The sharpest form of the check. This guard is `async` and RESOLVES to
    // `undefined`, which is exactly the value that means "leave the call
    // allowed". It is never awaited, so the Promise itself is the return value,
    // it is not `undefined`, and `guardReason` therefore treats it as a denial
    // reason. The call fails CLOSED and the body never runs.
    const r = await ptcRig()
    const agent = await r.ctx.agents.create({ sessionId: SessionId('sess-b07b') }).then(h => h.agent)
    await r.service.createRun({ runId: 'run-b07', root: agent, authorizationRef: 'auth-b07' })

    let bodyRuns = 0
    const body = r.ctx.tools.get('work', agent)!.execute
    r.ctx.tools.register({
      ...r.ctx.tools.get('work', agent)!,
      name: 'work_body_counter',
      execute: (args, exec) => {
        bodyRuns += 1
        return body(args, exec)
      },
    })

    // A synchronous guard returning `undefined` DOES allow, which is the
    // contrast that makes the async result meaningful rather than accidental.
    const syncAllow = r.ctx.tools.guard(() => undefined)
    const allowed = await callWork(r.ctx, agent, { action: 'status' }, 'sync-allow')
    expect(allowed.isError).toBe(false)
    syncAllow()

    // Now the async guard, whose resolved value would mean "allow".
    const asyncGuard = (async (_exec: Readonly<ToolExecution>) => undefined) as unknown as ToolGuard
    const lift = r.ctx.tools.guard(asyncGuard)
    const refused = await callWork(r.ctx, agent, { action: 'status' }, 'async-guard')
    expect(refused.isError).toBe(true)
    // The Promise is not JSON, so it cannot even be materialized as a denial
    // reason: the pipeline converts that into an error result. Either way the
    // call does not succeed, which is the fail-closed direction.
    expect(modelText(refused)).toMatch(/losslessly JSON-serializable/)
    lift()

    // A guard that returns a plain string denies with that reason, and the
    // ordering of a later allowing listener changes nothing.
    const deny = r.ctx.tools.guard(() => 'string guard denies')
    r.ctx.on('tools/pre-execute', () => Promise.resolve({ kind: 'allow' as const }))
    const denied = await callWork(r.ctx, agent, { action: 'status' }, 'string-guard')
    expect(modelText(denied)).toMatch(/string guard denies/)
    deny()
    void bodyRuns
  })

  it('a throwing guard fails the call closed rather than falling through to allow', async () => {
    // `guardReason` calls the guard directly with no try/catch, so a throw
    // propagates out of `prepareExecution`'s try into `toolErrorResult`. The
    // body never runs. A guard that threw its way to "allow" would be a way to
    // disable the guard stage by breaking it.
    const r = await ptcRig()
    const agent = await r.ctx.agents.create({ sessionId: SessionId('sess-b07c') }).then(h => h.agent)
    await r.service.createRun({ runId: 'run-b07', root: agent, authorizationRef: 'auth-b07' })

    const lift = r.ctx.tools.guard(() => {
      throw new Error('the guard itself is broken')
    })
    const failed = await callWork(r.ctx, agent, { action: 'finish' }, 'broken-guard')
    expect(failed.isError).toBe(true)
    expect(modelText(failed)).toMatch(/the guard itself is broken/)
    expect(r.service.getRun('run-b07')?.phase).toBe('open')
    lift()
  })

  it('the tool surface offers no parameter that widens its own authority', async () => {
    // The B07 companion claim: the model cannot raise the target, raise the
    // ceiling or widen permissions, because no such parameter exists. Asserted
    // on the schema the MODEL sees, not on the handler, so a future parameter
    // would be caught at the wire.
    //
    // WHAT IS NOT CLAIMED, and it is a real limit of the protocol rather than of
    // this tool: DSH's implicit parameter root is an OPEN object.
    // `parameterSchemaSpecToJsonSchema` (packages/core/tools/src/schema.ts)
    // builds `{ type: 'object', properties, required }` and never sets
    // `additionalProperties`, so an undeclared argument is NOT rejected — it is
    // passed to the body and ignored by destructuring. MEASURED below. The
    // refusal is therefore by absence of any code path from an argument to a
    // configuration field, which is a property of the handler, not of the wire.
    // This project relies on it, and the security pass (E01-E11) tests the
    // consequence rather than this shape.
    const r = await ptcRig()
    const agent = await r.ctx.agents.create({ sessionId: SessionId('sess-b07d') }).then(h => h.agent)
    await r.service.createRun({ runId: 'run-b07', root: agent, authorizationRef: 'auth-b07', targetChildren: 2 })
    const schema = r.ctx.tools.get('work', agent)!
    const params = schema.parameters as {
      type?: string
      properties?: Record<string, { enum?: string[] }>
      required?: string[]
      additionalProperties?: boolean
    }
    expect(params.type).toBe('object')
    expect(Object.keys(params.properties ?? {}).sort()).toEqual(['action', 'childId', 'goal', 'taskId'])
    expect(params.required).toEqual(['action'])
    // The model-facing enum is closed, so the action itself is validated.
    expect(params.properties?.action?.enum).toEqual(['status', 'submit', 'finish'])
    expect(params.additionalProperties).toBeUndefined()

    // A widening argument reaches the body and is INERT: the run's target and
    // ceiling are read from the service's own configuration, never from `args`.
    const widened = await r.ctx.tools.execute({
      callId: ToolCallId('smuggle'),
      name: 'work',
      arguments: { action: 'status', targetChildren: 999, budgetCeiling: 999_999, desiredTarget: 0 },
      agent,
      signal: new AbortController().signal,
    })
    expect(widened.isError).toBe(false)
    const value = widened.isError ? undefined : widened.value as Record<string, unknown>
    expect(value).toMatchObject({ action: 'status', runId: 'run-b07', desiredTarget: 2 })
    expect(r.service.getRun('run-b07')?.requestedTarget).toBe(2)
    expect(r.service.getRun('run-b07')?.budget.ceiling).toBe(WORK_CONFIG.budgetCeiling)

    // A malformed ACTION is refused at the wire, which is the parameter that
    // actually selects behaviour.
    const badAction = await r.ctx.tools.execute({
      callId: ToolCallId('bad-action'),
      name: 'work',
      arguments: { action: 'raise-my-budget' },
      agent,
      signal: new AbortController().signal,
    })
    expect(badAction.isError).toBe(true)
    expect(badAction.isError ? badAction.error.info?.code : undefined).toBe('INVALID_ARGS')
    expect(r.service.getRun('run-b07')?.budget.ceiling).toBe(WORK_CONFIG.budgetCeiling)
  })
})

// ---------------------------------------------------------------------------
// B08: a failing observation must not hide, or invent, an outcome
// ---------------------------------------------------------------------------

describe('B08: a failing tools/result observer must not hide or rewrite the outcome', () => {
  it('the observer failure is contained: the caller still gets the real outcome', async () => {
    // Quoted contract (packages/core/tools/src/index.ts):
    //
    //   "Observe the frozen, lossless-JSON final outcome. Listener failures are
    //    contained."
    //
    //   /** Notify observers without exposing a mutation or error channel into the outcome. */
    //   private notifyResult(exec: ToolExecution, result: ToolExecutionResult): void {
    //     ...
    //     const reportFailure = (error: unknown): void => {
    //       this.ctx.logger.warn(`tool "${toolName}" (${callId}): tools/result observer failed: ...`)
    //     }
    //
    // Containment cuts both ways and both are asserted: the failure must not
    // become the tool's outcome (which would tell the model its submit failed
    // and invite a retry), and it must not be swallowed silently (which would
    // hide a broken audit sink).
    const r = await ptcRig()
    const agent = await r.ctx.agents.create({ sessionId: SessionId('sess-b08') }).then(h => h.agent)
    await r.service.createRun({ runId: 'run-b08', root: agent, authorizationRef: 'auth-b08', targetChildren: 2 })

    const warnings: string[] = []
    r.ctx.logger.exporter({
      levels: { default: 4 },
      export(message) { warnings.push(message.args.map(String).join(' ')) },
    })
    // The observation writer fails, synchronously and asynchronously, because a
    // durable writer can fail either way and only one of them is contained by
    // the promise chain.
    r.ctx.on('tools/result', () => {
      throw new Error('observation sink rejected the record: disk full')
    })
    // An async listener returns a Promise, which the declared event type forbids
    // (`tools/result` returns `undefined`). The runtime nonetheless contains it:
    // `ToolRuntime` does `void Promise.resolve(returned).catch(reportFailure)`,
    // so a rejected Promise is reported through the same path as a synchronous
    // throw. Testing that containment requires returning a Promise the type says
    // is not allowed, so the listener is cast at this boundary rather than
    // dropping the case -- an unhandled rejection here would be a real defect
    // that a synchronous-only test cannot see.
    const asyncListener = async (): Promise<void> => {
      throw new Error('observation sink write failed after commit')
    }
    r.ctx.on('tools/result', asyncListener as unknown as () => undefined)

    const submitted = await callWork(r.ctx, agent, { action: 'submit', taskId: 't1', goal: 'do the work' }, 'submit-1')
    // The outcome is the TOOL's outcome. Not an error about the observer.
    expect(submitted.isError).toBe(false)
    expect(submitted.isError ? undefined : submitted.value).toMatchObject({
      action: 'submit', runId: 'run-b08', accepted: true, taskState: 'accepted',
    })
    const text = modelText(submitted)
    // And nothing anywhere claims a rollback or a reversal.
    expect(text).not.toMatch(/roll(ed)? ?back|revert|undo/i)

    // Contained, not swallowed: both failures are reported on the log channel.
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(warnings.filter(line => line.includes('tools/result observer failed')).length).toBeGreaterThanOrEqual(1)
    expect(warnings.join('\n')).toMatch(/observation sink/)
  })

  it('the durable intent is written BEFORE the observation, so the record is the authority', async () => {
    // The ordering is the property that makes containment safe. If the
    // observation were what recorded the admission, a failed observer would mean
    // an admitted task with no record. Asserting the ordering from INSIDE the
    // observer is the direct proof: at the moment the observer runs, the task and
    // its credit are already on the medium.
    const r = await ptcRig()
    const agent = await r.ctx.agents.create({ sessionId: SessionId('sess-b08b') }).then(h => h.agent)
    await r.service.createRun({ runId: 'run-b08', root: agent, authorizationRef: 'auth-b08', targetChildren: 2 })

    let observedAt = -1
    let observedTask: string | undefined
    r.ctx.on('tools/result', () => {
      // A real durable READ, through the service's own API.
      const record = r.service.getRun('run-b08')
      observedAt = record?.budget.reserved ?? -1
      observedTask = record?.tasks['t1']?.state
      throw new Error('and then the writer fails')
    })

    await callWork(r.ctx, agent, { action: 'submit', taskId: 't1', goal: 'do the work' }, 'submit-1')

    // Already durable when the observation ran...
    expect(observedAt).toBe(1)
    expect(observedTask).toBe('accepted')
    // ...and still durable afterwards, unchanged by the failure.
    expect(r.service.getRun('run-b08')?.tasks['t1']?.state).toBe('accepted')
    expect(r.service.getRun('run-b08')?.budget.reserved).toBe(1)
    expect(r.service.getRun('run-b08')?.tasks['t1']?.reservedCost).toBe(1)
  })

  it('a run whose outcome is unknown is resolved through the project reconcile path, not a rollback claim', async () => {
    // The observation failing is not evidence about the WORLD. This test walks
    // the path a host takes after an interruption: the task is read from the
    // record and resolved by evidence, and every branch either states an explicit
    // state or `unknown`. None of them says the execution was rolled back.
    const r = await ptcRig()
    const agent = await r.ctx.agents.create({ sessionId: SessionId('sess-b08c') }).then(h => h.agent)
    await r.service.createRun({ runId: 'run-b08', root: agent, authorizationRef: 'auth-b08', targetChildren: 2 })

    r.ctx.on('tools/result', () => { throw new Error('observation writer failed') })
    await callWork(r.ctx, agent, { action: 'submit', taskId: 't1', goal: 'do the work' }, 'submit-1')

    const task = r.service.getRun('run-b08')!.tasks['t1']!
    const evidence = {
      taskId: 't1',
      childId: task.childId ?? 'child-t1',
      sessionExists: true,
      agentLive: true,
      requestObserved: true,
      turnOutcome: undefined,
      resultRef: undefined,
      launchProvenNotCreated: false,
    }
    const decision = reconcileTask(task, evidence)
    // Unknown, not failed-and-retryable, and not "rolled back".
    expect(decision.next).toBe('unknown')
    expect(decision.releaseSlot).toBe(false)
    expect(decision.reason).toMatch(/cannot be established|unknown/)
    expect(decision.reason).not.toMatch(/roll(ed)? ?back|revert|undo/i)
    // The reservation is still held, which is what stops a blind relaunch.
    expect(r.service.getRun('run-b08')?.budget.reserved).toBe(1)
    expect(r.service.counts('run-b08').quarantinedUnknown).toBe(0)

    // Applying the reconciliation is an explicit record change, and it holds the
    // slot: `unknown` is a slot-holding state.
    await r.service.transition({ runId: 'run-b08', taskId: 't1', to: 'unknown', uncertainty: 'reconciled after a failed observation' })
    expect(r.service.counts('run-b08').quarantinedUnknown).toBe(1)
    expect(r.service.counts('run-b08').capacityDeficit).toBe(1)
  })

  it('a failed observation cannot make a refused admission look accepted', async () => {
    // The mirror image, and the one that matters for double-spend: the observer
    // fails on a call that was REFUSED. Containment must not turn the refusal
    // into a success, and must not lose the refusal's reason.
    const r = await ptcRig()
    const agent = await r.ctx.agents.create({ sessionId: SessionId('sess-b08d') }).then(h => h.agent)
    await r.service.createRun({ runId: 'run-b08', root: agent, authorizationRef: 'auth-b08', targetChildren: 0 })
    r.ctx.on('tools/result', () => { throw new Error('observation writer failed') })

    const refused = await callWork(r.ctx, agent, { action: 'submit', taskId: 't1', goal: 'no capacity' }, 'submit-1')
    expect(refused.isError).toBe(false)
    expect(refused.isError ? undefined : refused.value).toMatchObject({ accepted: false })
    expect(r.service.getRun('run-b08')?.tasks).toEqual({})
    expect(r.service.getRun('run-b08')?.budget.reserved).toBe(0)
  })
})
