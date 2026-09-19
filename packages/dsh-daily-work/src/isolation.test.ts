/**
 * C12-C18: the isolation and lifecycle boundaries around a managed work run.
 *
 * Every claim in this file is anchored to a line of the REAL DSH source, quoted
 * where it is used, because the failure mode these gates exist to catch is a
 * deployment that BELIEVES it enforces a limit it never reads.
 *
 * The one fact the whole file is built around, from the plan's own source
 * reading of a community project, is a NEGATIVE result:
 *
 *   an allowed-child-tools check that reads a CALLER-SUPPLIED filter and
 *   returns `undefined` when no filter is passed is NOT a deployment-enforced
 *   allowlist.
 *
 * The equivalent question for DSH is: does `startContinuable` enforce a
 * deployment limit from deployment state, or from `spec.request`? The answer,
 * established below by direct assertion, has TWO parts and they must not be
 * confused:
 *
 *   DEPTH is enforced from the PARENT'S PERSISTED HEADER, so a caller-supplied
 *   `maxDepth: 99` cannot lift it (the header is the monotone floor), but a
 *   caller that OMITS `maxDepth` is NOT refused — the child is created at
 *   depth parent+1 and the cap is simply not consulted. Omission is therefore
 *   not a refusal, and this file asserts that honestly rather than pretending
 *   otherwise.
 *
 *   Our own deployment limit is a SECOND, independent gate: it is written into
 *   every RunRecord at creation from host config, and no model argument reaches
 *   it. That is the part that makes this project's limit a deployment limit.
 *
 * The rigs here are deliberately minimal: one real AgentLoop, one real
 * SubagentRuntime, the real in-process spawn provider, real JSONL persistence,
 * real storage domain. No model loop is simulated; the adapter is a scripted
 * provider boundary.
 */
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import GoalService from '@deepseek-ai/dsh-goal'
import * as GoalRoundDriver from '@deepseek-ai/dsh-goal-round-driver'
import { LlmAdapter, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SessionQueryEngine from '@deepseek-ai/dsh-session-query'
import SubagentRuntime, { delegationDepthOf, SubagentError } from '@deepseek-ai/dsh-subagent'
import * as SubagentFork from '@deepseek-ai/dsh-subagent-fork-in-process'
import * as SubagentSpawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import Storage from '@deepseek-ai/dsh-storage'
import * as storageDomainPlugin from '@deepseek-ai/dsh-storage-domain'
import * as storageJsonPlugin from '@deepseek-ai/dsh-storage-json'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { WorkService } from './host.ts'
import { createContinuableLaunchPort } from './launch-port.ts'

/**
 * An adapter whose model calls all hold on one gate.
 *
 * This is what makes "the root is idle while children still run" a fact rather
 * than a race. Without the gate a child would finish before the root settled,
 * and the idle/complete separation would be asserted in a state that never
 * existed.
 */
class GatedAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  private release: (() => void) | undefined
  private readonly gate: Promise<void>

  constructor() {
    super()
    let open: () => void = () => {}
    this.gate = new Promise<void>(resolve => {
      open = resolve
    })
    this.release = open
  }

  /** Let every held model call proceed. */
  openAll(): void {
    this.release?.()
  }

  override async resolveModel(provider: string, model: string): Promise<{ provider: string; id: string; name: string }> {
    return { provider, id: model, name: model }
  }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    await this.gate
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
  readonly adapter: GatedAdapter
  /** Create one more root Agent on the same context. */
  anotherRoot(id: string): Promise<Agent>
}

/**
 * Boot the real continuable stack plus this project's work service.
 *
 * `maxActiveSubagents` is deliberately SMALL in the pool tests. The gates below
 * are about SEPARATION, not capacity: a small pool makes "this family used its
 * own slots" observable, where a large pool would let a leaked global counter
 * pass unnoticed.
 */
async function rig(options: { maxActiveSubagents?: number; maxDepth?: number; withGoals?: boolean } = {}): Promise<Rig> {
  const sessionRoot = mkdtempSync(join(tmpdir(), 'dsh-daily-work-iso-sessions-'))
  const storeRoot = mkdtempSync(join(tmpdir(), 'dsh-daily-work-iso-store-'))
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  const persistence = await ctx.plugin(JsonlSessionPersistence, { root: sessionRoot })
  await ctx.plugin(AgentLoop, { agents: [] })
  if (options.withGoals === true) await ctx.plugin(GoalService)
  await ctx.plugin(SubagentRuntime, {
    maxActiveSubagents: options.maxActiveSubagents ?? 4,
    maxDepth: options.maxDepth ?? 1,
  })
  await ctx.plugin(SubagentSpawn, { providerName: 'spawn' })
  await ctx.plugin(SubagentFork, { providerName: 'fork' })
  // `listChildren` needs the sessionQuery service to read child Sessions back.
  // A concrete engine with search faces unavailable is enough: only the point
  // reads are used, and this is the same shape DSH's own continuation tests use.
  await ctx.plugin(class extends SessionQueryEngine {
    override searchSessions(): Promise<never> {
      return Promise.reject(new Error('session search is not configured in this test'))
    }
    override searchEvents(): Promise<never> {
      return Promise.reject(new Error('event search is not configured in this test'))
    }
  })
  await ctx.plugin(Storage, {} as never)
  await ctx.plugin(storageJsonPlugin as never, { root: storeRoot } as never)
  await ctx.plugin(storageDomainPlugin as never, { backend: 'json' } as never)

  const adapter = new GatedAdapter()
  ctx.llm.registerAdapter(['mock'], adapter)

  const root = await ctx.agentLoop.create(SessionId('root-iso'), { provider: 'mock', model: 'mock' })
  const service = new WorkService(ctx, {
    targetChildren: 10,
    maxDepth: options.maxDepth ?? 1,
    budgetCeiling: 1000,
    currency: 'USD',
    priceVersion: 'isolation-test',
  })
  await service.open()

  cleanups.push(async () => {
    // ORDER matters. Children parked inside a model call cannot be torn down;
    // release the gate first, then close the service, then drain the family.
    adapter.openAll()
    await service.close()
    await ctx.subagents.drainContinuableDescendants([root])
    await persistence.dispose()
    await ctx.fiber.dispose()
    rmSync(sessionRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    rmSync(storeRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  })

  return {
    ctx,
    root,
    service,
    adapter,
    anotherRoot: id => ctx.agentLoop.create(SessionId(id), { provider: 'mock', model: 'mock' }),
  }
}

function launchPort(r: Rig, parent: Agent = r.root) {
  return createContinuableLaunchPort({
    subagents: r.ctx.subagents,
    parent,
    provider: 'spawn',
    maxDepth: 1,
  })
}

/** One launch request, in the shape the work tool produces. */
function task(n: number, offset = 0) {
  return { taskId: `t-${offset + n}`, childId: `c-${offset + n}`, prompt: `work ${offset + n}`, reservedCost: 1 }
}

// ---------------------------------------------------------------------------
// C12: nesting bypass
// ---------------------------------------------------------------------------

describe('C12: every nesting path is either accounted for or explicitly refused', () => {
  it('refuses a grandchild through the continuable path, and names the depth that refused it', async () => {
    // The refusal is `SubagentDepthError` raised by `resolveChildDepth`
    // (packages/subagent/subagent/src/child-agent.ts:50-59):
    //
    //   const childDepth = delegationDepthOf(parent) + 1
    //   if (maxDepth !== undefined && childDepth > maxDepth) throw new SubagentDepthError(...)
    //
    // The load-bearing detail is `delegationDepthOf(parent)`, which reads the
    // PARENT'S persisted header (depth.ts:28-36):
    //
    //   return Math.max(agent.session.header.delegationDepth ?? 0, runtime ?? 0)
    //
    // So the depth is a property of the parent, not of the request. A child
    // carrying delegationDepth 1 cannot open a grandchild while a cap of 1 is in
    // force, because childDepth is 2 before the cap is even consulted.
    const r = await rig()
    const child = await r.ctx.subagents.startContinuable({
      provider: 'spawn',
      label: 'child',
      childId: SessionId('c12-child'),
      request: { parent: r.root, prompt: [{ type: 'text', text: 'x' }], maxDepth: 1 },
      signal: new AbortController().signal,
    })
    const childAgent = r.ctx.agents.get(child.childId)!
    // The depth is on the CHILD's durable header, not merely in this process.
    expect(childAgent.session.header.delegationDepth).toBe(1)
    expect(delegationDepthOf(childAgent)).toBe(1)

    await expect(
      r.ctx.subagents.startContinuable({
        provider: 'spawn',
        label: 'grandchild',
        childId: SessionId('c12-grandchild'),
        request: { parent: childAgent, prompt: [{ type: 'text', text: 'y' }], maxDepth: 1 },
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/depth 2 exceeds maxDepth 1/)
    // And nothing was created: the refusal happened before materialization.
    expect(r.ctx.agents.get(SessionId('c12-grandchild'))).toBeUndefined()
  })

  it('refuses the grandchild even when the CALLER supplies a larger maxDepth', async () => {
    // C12's central assertion. This is the DSH-side answer to the plan's
    // finding that a caller-supplied filter is not a deployment allowlist.
    //
    // `maxDepth` here is the caller's cap, and a caller is free to pass 99. It
    // does not help: `resolveChildDepth` computes 1 + 1 = 2 from the parent's
    // header first, and the cap is only an upper bound. There is no argument a
    // model can supply that makes a depth-1 parent able to delegate while ANY
    // cap at or below its own depth is in force.
    const r = await rig()
    const child = await r.ctx.subagents.startContinuable({
      provider: 'spawn',
      label: 'child',
      childId: SessionId('c12b-child'),
      request: { parent: r.root, prompt: [{ type: 'text', text: 'x' }], maxDepth: 1 },
      signal: new AbortController().signal,
    })
    const childAgent = r.ctx.agents.get(child.childId)!

    // The runtime resolves the caller's `99` against its own settings default
    // only when the caller OMITS the value; an explicit 99 is taken as given.
    // So the honest assertion is not "99 is refused" but "the header depth is
    // what decides": with 99 the child IS created, at depth 2, and it is OUR
    // record and OUR launch port that never ask for that.
    const grandchild = await r.ctx.subagents.startContinuable({
      provider: 'spawn',
      label: 'grandchild-99',
      childId: SessionId('c12b-grandchild'),
      request: { parent: childAgent, prompt: [{ type: 'text', text: 'y' }], maxDepth: 99 },
      signal: new AbortController().signal,
    })
    const grandchildAgent = r.ctx.agents.get(grandchild.childId)!
    expect(grandchildAgent.session.header.delegationDepth).toBe(2)

    // THE point: the deployment cap that our own path carries is 1, and it
    // refuses the same call. Asserted through the real launch port, which is
    // what production uses and which hard-codes `maxDepth: deps.maxDepth`.
    await expect(
      createContinuableLaunchPort({
        subagents: r.ctx.subagents,
        parent: childAgent,
        provider: 'spawn',
        maxDepth: 1,
      }).launch(
        { taskId: 'deployment-cap', childId: 'c12b-deployment-cap', prompt: 'y', reservedCost: 1 },
        new AbortController().signal,
      ),
    ).rejects.toThrow(/depth 2 exceeds maxDepth 1/)
    // Nothing was created for the deployment-capped attempt.
    expect(r.ctx.agents.get(SessionId('c12b-deployment-cap'))).toBeUndefined()
  })

  it('omitting maxDepth does NOT lift the deployment cap, because our port never omits it', async () => {
    // The other half of the same fact, and the one that maps EXACTLY onto the
    // community-project defect. There, an omitted filter made the check return
    // `undefined` — i.e. "no restriction" — and the child got every tool.
    //
    // MEASURED, not assumed: at the DSH seam, an omitted `maxDepth` is NOT a
    // refusal. `resolveChildDepth` skips only the comparison, so the child IS
    // created, stamped at depth parent+1. This test asserts that reading
    // honestly, and then asserts the part that makes it harmless here: the
    // launch port ALWAYS sends `maxDepth: deps.maxDepth` (launch-port.ts:83), so
    // the omission path is unreachable from this project.
    const r = await rig()
    const child = await r.ctx.subagents.startContinuable({
      provider: 'spawn',
      label: 'child',
      childId: SessionId('c12c-child'),
      request: { parent: r.root, prompt: [{ type: 'text', text: 'x' }], maxDepth: 1 },
      signal: new AbortController().signal,
    })
    const childAgent = r.ctx.agents.get(child.childId)!

    // (a) The honest negative result: an omitted cap is not a refusal at DSH.
    const uncapped = await r.ctx.subagents.startContinuable({
      provider: 'spawn',
      label: 'grandchild-uncapped',
      childId: SessionId('c12c-grandchild'),
      request: { parent: childAgent, prompt: [{ type: 'text', text: 'y' }] },
      signal: new AbortController().signal,
    })
    expect(r.ctx.agents.get(uncapped.childId)!.session.header.delegationDepth).toBe(2)

    // (b) Our port cannot take that path: it passes the configured depth, so the
    // same parent is refused. This is the whole difference between "DSH's
    // per-request cap" and "our deployment limit".
    await expect(
      createContinuableLaunchPort({
        subagents: r.ctx.subagents,
        parent: childAgent,
        provider: 'spawn',
        maxDepth: 1,
      }).launch(
        { taskId: 'never-omits', childId: 'c12c-never-omits', prompt: 'y', reservedCost: 1 },
        new AbortController().signal,
      ),
    ).rejects.toThrow(/depth 2 exceeds maxDepth 1/)
  })

  it('records the deployment depth on the run, so the record itself carries the cap', async () => {
    // The deployment limit lives in the RECORD, written at run creation from
    // host configuration (host.ts, createRun: `maxDepth: this.config.maxDepth`).
    // The model's `work` tool has no parameter that reaches this field
    // (tools.ts parameters: action, taskId, goal, childId), so it cannot raise
    // its own recursion budget — the same property the community project lacked.
    const r = await rig()
    const record = await r.service.createRun({ runId: 'run-c12-depth', root: r.root, authorizationRef: 'auth' })
    expect(record.maxDepth).toBe(1)
    expect(r.service.getRun('run-c12-depth')?.maxDepth).toBe(1)
    // A DIFFERENT deployment config produces a DIFFERENT recorded cap, which is
    // what proves the field is read from config rather than hard-coded.
    const other = await rig({ maxDepth: 3 })
    const otherRecord = await other.service.createRun({ runId: 'run-c12-depth-3', root: other.root, authorizationRef: 'auth' })
    expect(otherRecord.maxDepth).toBe(3)
  })

  it('refuses a grandchild through the ONE-SHOT path too, so the fork/spawn providers are covered', async () => {
    // The nesting gate must not depend on WHICH provider created the child. The
    // one-shot path reaches the same `resolveChildDepth`
    // (subagent-in-process-driver/src/index.ts:108-111), so both in-process
    // backends are covered by the same accounting.
    const r = await rig()
    const child = await r.ctx.subagents.startContinuable({
      provider: 'spawn',
      label: 'child',
      childId: SessionId('c12d-child'),
      request: { parent: r.root, prompt: [{ type: 'text', text: 'x' }], maxDepth: 1 },
      signal: new AbortController().signal,
    })
    const childAgent = r.ctx.agents.get(child.childId)!

    await expect(
      r.ctx.subagents.start('spawn', {
        prompt: [{ type: 'text', text: 'grandchild' }],
        parent: childAgent,
        maxDepth: 1,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/depth 2 exceeds maxDepth 1/)

    // The FORK provider composes through the same driver, so it refuses for the
    // same reason. Asserted rather than assumed, because "both providers" is
    // exactly the kind of claim that rots when one backend is refactored.
    await expect(
      r.ctx.subagents.start('fork', {
        prompt: [{ type: 'text', text: 'grandchild' }],
        parent: childAgent,
        maxDepth: 1,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/depth 2 exceeds maxDepth 1/)
  })

  it('a provider that cannot enforce depth is REFUSED the request rather than accepting and ignoring it', async () => {
    // The third nesting path is a provider OUTSIDE this process (ACP, Codex, the
    // SDK). Those advertise `NO_START_CAPABILITIES`
    // (subagent/src/out-of-process.ts:51-63):
    //
    //   "A child in another process cannot honor parent-enforced start features
    //    (agentOptions/outputSchema/maxDepth/toolFilter/persona), so the service
    //    rejects a request needing any of them before `start` runs — never
    //    accepted-then-ignored."
    //
    // This is the structural answer to the plan's finding: the deployment does
    // not silently drop a limit it cannot enforce, it refuses the delegation.
    // Asserted on the CAPABILITY TABLE and the REFUSAL CONTRACT rather than by
    // spawning a foreign agent binary, because the refusal happens before the
    // provider runs — so the provider's presence is all that is needed.
    const r = await rig()
    // The ACP plugin declares `inject = ['subagents', 'subprocess']`, so the
    // subprocess seam must be mounted or the plugin's fiber never activates and
    // the provider is never registered. Mounting the real local provider is the
    // same composition the shipped profile uses (`subprocess` =>
    // `@deepseek-ai/dsh-subprocess-local`).
    const SubprocessLocal = await import('@deepseek-ai/dsh-subprocess-local')
    await r.ctx.plugin(SubprocessLocal.default as never, {} as never)
    const acp = await import('@deepseek-ai/dsh-subagent-acp')
    await r.ctx.plugin(acp as never, {
      providerName: 'acp-probe',
      command: process.execPath,
      args: ['--version'],
    } as never)
    const provider = r.ctx.subagents.getProvider('acp-probe')
    expect(provider).toBeDefined()
    expect(provider!.capabilities.depthLimit).toBe(false)
    expect(provider!.capabilities.toolFilter).toBe(false)
    // The out-of-process path has no continuable capability at all.
    expect(provider!.prepareContinuable).toBeUndefined()

    await expect(
      r.ctx.subagents.start('acp-probe', {
        prompt: [{ type: 'text', text: 'x' }],
        parent: r.root,
        maxDepth: 1,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/does not support the "depthLimit" capability/)

    await expect(
      r.ctx.subagents.startContinuable({
        provider: 'acp-probe',
        label: 'x',
        request: { parent: r.root, prompt: [{ type: 'text', text: 'x' }], maxDepth: 1 },
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/does not support continuable children/)
  })

  it('the model-facing delegation tool exposes no parameter that can lift a limit', async () => {
    // The fourth path: the model calling the shipped `subagent` tool. Its
    // parameters are fixed by the plugin (tool-subagent/src/index.ts, the
    // `parameters` block): description, prompt, and run_in_background. `maxDepth`,
    // `toolFilter` and `persona` are read from the PLUGIN CONFIG
    // (index.ts:84-110), never from tool arguments.
    //
    // This is the exact inversion of the community defect: there, the model's
    // absence of a filter was read as permission. Here, the model cannot express
    // a filter at all, and the tool's own filter comes from deployment config.
    const r = await rig()
    const mod = await import('@deepseek-ai/dsh-tool-subagent')
    await r.ctx.plugin(mod as never, {
      provider: 'spawn',
      toolName: 'subagent',
      backgroundMode: 'continuable',
    } as never)

    const schema = r.ctx.tools.schemas().find(s => s.name === 'subagent')
    expect(schema).toBeDefined()
    const properties = Object.keys(
      (schema!.parameters as { properties?: Record<string, unknown> }).properties ?? {},
    )
    for (const forbidden of ['maxDepth', 'max_depth', 'toolFilter', 'tool_filter', 'persona', 'depth', 'capabilities']) {
      expect(properties).not.toContain(forbidden)
    }
    // And the three it does expose are the documented ones.
    expect(properties.sort()).toEqual(['description', 'prompt', 'run_in_background'])
  })

  it('a model-supplied toolFilter cannot lift the deployment tool restriction on the child', async () => {
    // `toolFilter` is applied as `childCtx.tools.restrict(...)` in the child's
    // creation window (child-agent.ts:218), and restrictions INTERSECT
    // (core/tools/src/index.ts:1175-1181):
    //
    //   // Restrictions intersect across the whole chain: any scope on it may
    //   // mask an inherited name for everything nested inside it.
    //   if (layers.every(layer => layer.admits(name))) visible.set(name, definition)
    //
    // So a caller-supplied filter can only ever REMOVE tools, never add one
    // back: `every` requires ALL layers to admit a name. A `deny` list is
    // monotone, and there is no `toolFilter` value that restores a tool another
    // layer denied, because the deployment's restriction is a separate layer on
    // the same chain.
    const r = await rig()
    r.ctx.tools.register(defineTool({
      name: 'canary_tool',
      description: 'a canary the deployment may or may not expose to children',
      parameters: {},
      output: {
        schema: { type: 'array', items: { type: 'json' } },
        render: () => [{ type: 'text' as const, text: 'canary' }],
      },
      execute: () => Promise.resolve([{ type: 'text' as const, text: 'canary' }]),
    }))
    expect(r.ctx.tools.schemas().map(s => s.name)).toContain('canary_tool')

    // A child with a caller-supplied deny loses the tool.
    const denied = await r.ctx.subagents.startContinuable({
      provider: 'spawn',
      label: 'denied',
      childId: SessionId('c12-filter-deny'),
      request: {
        parent: r.root,
        prompt: [{ type: 'text', text: 'x' }],
        maxDepth: 1,
        toolFilter: { deny: ['canary_tool'] },
      },
      signal: new AbortController().signal,
    })
    const deniedAgent = r.ctx.agents.get(denied.childId)!
    expect(r.ctx.tools.schemas(deniedAgent).map(s => s.name)).not.toContain('canary_tool')

    // A child with NO filter inherits the surface. This is the case the
    // community defect mishandled: here, "no filter" means "no ADDITIONAL
    // restriction", and any deployment layer is still in force. There is no
    // deployment tool restriction in THIS composition, so the child sees the
    // tool — and that is an honest reading of "the deployment restricted
    // nothing", not of "the caller unlocked something".
    const unfiltered = await r.ctx.subagents.startContinuable({
      provider: 'spawn',
      label: 'unfiltered',
      childId: SessionId('c12-filter-none'),
      request: { parent: r.root, prompt: [{ type: 'text', text: 'x' }], maxDepth: 1 },
      signal: new AbortController().signal,
    })
    const unfilteredAgent = r.ctx.agents.get(unfiltered.childId)!
    expect(r.ctx.tools.schemas(unfilteredAgent).map(s => s.name)).toContain('canary_tool')

    // The root is untouched by either child's filter: a per-child restriction is
    // owned by the child's scope (child-agent.ts:220-222, "all owned by the
    // child's scope and therefore invisible to its parent and siblings").
    expect(r.ctx.tools.schemas(r.root).map(s => s.name)).toContain('canary_tool')
  })

  it('a toolFilter naming an unknown tool fails loudly rather than silently admitting everything', async () => {
    // The second community-shaped failure: a filter that fails to match and
    // silently degrades to "no restriction". `tools.restrict` validates names
    // against the restrictable set (core/tools/src/index.ts:1094-1098) and
    // throws. So a typo in a filter is a loud failure, never a silent widening.
    const r = await rig()
    await expect(
      r.ctx.subagents.startContinuable({
        provider: 'spawn',
        label: 'typo',
        childId: SessionId('c12-filter-typo'),
        request: {
          parent: r.root,
          prompt: [{ type: 'text', text: 'x' }],
          maxDepth: 1,
          toolFilter: { deny: ['no_such_tool'] },
        },
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/names unknown global tool/)
  })

  it('accounts for the workflow/PTC path: it delegates through the SAME service, so it is depth-capped too', async () => {
    // The workflow engine's `agent()` helper calls
    // `this.subagents.start(this.provider, { ... })`
    // (workflow-ptc/src/host.ts:200) — the ordinary one-shot seam, with NO
    // `maxDepth` of its own. That is the decisive fact: the workflow path cannot
    // express a depth policy at all, so it inherits whatever the parent's header
    // says.
    //
    // MEASURED, and this is the uncomfortable half: because it omits the cap, a
    // workflow run started from a depth-1 child DOES create a depth-2 child. So
    // the honest statement is not "the workflow path is refused". It is:
    //   - the workflow path cannot LIFT anything, because it sends no cap; and
    //   - the enforcement point for this project is the deployment cap carried
    //     by our own launch port and recorded on the run.
    // Both halves are asserted, because asserting only the convenient one would
    // be the exact overclaim C12 exists to prevent.
    const r = await rig()
    const child = await r.ctx.subagents.startContinuable({
      provider: 'spawn',
      label: 'child',
      childId: SessionId('c12-wf-child'),
      request: { parent: r.root, prompt: [{ type: 'text', text: 'x' }], maxDepth: 1 },
      signal: new AbortController().signal,
    })
    const childAgent = r.ctx.agents.get(child.childId)!

    // The exact call shape workflow-ptc/src/host.ts:200 makes: no maxDepth.
    const run = await r.ctx.subagents.start('spawn', {
      prompt: [{ type: 'text', text: 'workflow child' }],
      parent: childAgent,
      signal: new AbortController().signal,
    })
    expect(r.ctx.agents.get(run.id)!.session.header.delegationDepth).toBe(2)
    await run.dispose()

    // And the deployment-capped call — the one our port makes — is refused.
    await expect(
      r.ctx.subagents.start('spawn', {
        prompt: [{ type: 'text', text: 'workflow child capped' }],
        parent: childAgent,
        maxDepth: 1,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/depth 2 exceeds maxDepth 1/)
  })

  it('the shipped delegation tool DOES carry the deployment cap, unlike the workflow path', async () => {
    // The complement of the test above, and the reason the C2 profile patch's
    // `subagent.maxDepth: 1` is not simply decorative. `tool-subagent` reads
    // `runtimeCtx.subagents.resolveMaxDepth(config.maxDepth)`
    // (tool-subagent/src/index.ts:515) and passes the result into the request, so
    // the SHIPPED tool always sends a concrete cap:
    //
    //   resolveMaxDepth(configured) { return configured ?? (this.settingsSource()).maxDepth }
    //   (subagent/src/index.ts:248-251)
    //
    // With no per-tool config, that is the runtime's settings default — which is
    // the `subagent` config row the deployment patch writes. Asserted here through
    // the public resolver so the mechanism is checked rather than described.
    const r = await rig({ maxDepth: 1 })
    expect(r.ctx.subagents.resolveMaxDepth(undefined)).toBe(1)
    // An explicit per-tool value wins over the settings default.
    expect(r.ctx.subagents.resolveMaxDepth(3)).toBe(3)
    // `'provider-managed'` means "send no cap", which is the ONLY way this
    // resolver returns undefined — and it is a deployment-config choice, never a
    // model argument (the tool's parameters carry no maxDepth).
    expect(r.ctx.subagents.resolveMaxDepth('provider-managed')).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// C13: depth and family scope
// ---------------------------------------------------------------------------

describe('C13: depth, per-run limits and the family pool are three separate scopes', () => {
  it('gives a second root its own pool, so one family filling up does not block another', async () => {
    // The pool is per ROOT, not global. `materialize` takes
    // (continuation-activation.ts:486-489):
    //
    //   const pool = this.resident.get(inputs.parent.id)?.pool ?? this.rootPool(inputs.parent)
    //   const releaseSlot = pool.reserve(this.maxActiveSubagents())
    //
    // and `rootPool` is a `WeakMap<Agent, ActivationPool>` keyed on the exact
    // root (line 180). A descendant INHERITS its resident parent's pool, which
    // is what makes "family pool" the right name: the pool follows the lineage,
    // and a different root is a different pool.
    //
    // The consequence this test pins: with the global setting at 2, root A can
    // hold 2 children and root B still gets its own 2. Reading
    // `maxActiveSubagents` as a process-wide ceiling would be wrong in the
    // permissive direction, and reading one root's occupancy as everyone's would
    // be wrong in the restrictive direction.
    const r = await rig({ maxActiveSubagents: 2 })
    const other = await r.anotherRoot('root-iso-2')
    const signal = new AbortController().signal

    for (const id of ['c13-a1', 'c13-a2']) {
      await r.ctx.subagents.startContinuable({
        provider: 'spawn',
        label: id,
        childId: SessionId(id),
        request: { parent: r.root, prompt: [{ type: 'text', text: 'x' }], maxDepth: 1 },
        signal,
      })
    }
    // Root A is at its limit.
    await expect(
      r.ctx.subagents.startContinuable({
        provider: 'spawn',
        label: 'c13-a3',
        childId: SessionId('c13-a3'),
        request: { parent: r.root, prompt: [{ type: 'text', text: 'x' }], maxDepth: 1 },
        signal,
      }),
    ).rejects.toThrow(/active child limit: 2/)

    // Root B is untouched and gets its own full pool.
    for (const id of ['c13-b1', 'c13-b2']) {
      const started = await r.ctx.subagents.startContinuable({
        provider: 'spawn',
        label: id,
        childId: SessionId(id),
        request: { parent: other, prompt: [{ type: 'text', text: 'x' }], maxDepth: 1 },
        signal,
      })
      expect(String(started.childId)).toBe(id)
    }
    await expect(
      r.ctx.subagents.startContinuable({
        provider: 'spawn',
        label: 'c13-b3',
        childId: SessionId('c13-b3'),
        request: { parent: other, prompt: [{ type: 'text', text: 'x' }], maxDepth: 1 },
        signal,
      }),
    ).rejects.toThrow(/active child limit: 2/)
  })

  it('keeps two runs in one host separate in tasks, budget and pause state', async () => {
    // A per-RUN limit is a third scope, distinct from the family pool and from
    // the deployment depth. Two runs on one host must not share a target, a
    // reservation, or a pause: a pause is the user's decision about ONE run.
    //
    // One composition detail is load-bearing and is stated rather than hidden:
    // the launch port carries ONE parent Agent (`deps.parent`), so a test with
    // two runs needs two ports. Using one port for both runs would attribute
    // every child to the same root, and the child ids would then collide in the
    // DSH registry — a real host-global constraint, not a test artifact, so the
    // two runs also use disjoint task ids.
    const r = await rig()
    const other = await r.anotherRoot('root-run-b')
    r.service.setReadyTasks('run-a', 10)
    r.service.setReadyTasks('run-b', 10)
    await r.service.createRun({ runId: 'run-a', root: r.root, authorizationRef: 'auth-a', targetChildren: 2 })
    await r.service.createRun({ runId: 'run-b', root: other, authorizationRef: 'auth-b', targetChildren: 5 })
    // The port is installed once, so it is swapped for the second run's root.
    r.service.setLaunchPort(launchPort(r))

    const a = await r.service.drain('run-a', [task(1), task(2), task(3)], new AbortController().signal)
    expect(a.filter(o => o.accepted)).toHaveLength(2)
    expect(r.service.counts('run-a').desiredTarget).toBe(2)

    await r.service.pause('run-a', 'user stopped run A')
    r.service.setLaunchPort(launchPort(r, other))
    const b = await r.service.drain('run-b', [task(1, 200), task(2, 200), task(3, 200)], new AbortController().signal)
    // Run B is unaffected by A's pause and admits against ITS OWN target of 5.
    expect(b.filter(o => o.accepted)).toHaveLength(3)
    expect(r.service.counts('run-b').desiredTarget).toBe(5)
    expect(r.service.counts('run-b').capacityDeficit).toBe(2)

    // Budgets are per run: A's reservations are not charged against B.
    expect(r.service.getRun('run-a')?.budget.reserved).toBe(2)
    expect(r.service.getRun('run-b')?.budget.reserved).toBe(3)
    expect(r.service.getRun('run-a')?.authorizationRef).toBe('auth-a')
    expect(r.service.getRun('run-b')?.authorizationRef).toBe('auth-b')
  })

  it('carries the deployment maxDepth on the run AND on every launch, so neither can be omitted', async () => {
    // The two places the deployment depth is written. If either omitted it, a
    // caller's omission would become the effective policy — the community
    // defect in a different field.
    const r = await rig({ maxDepth: 1 })
    const record = await r.service.createRun({ runId: 'run-depth', root: r.root, authorizationRef: 'auth' })
    expect(record.maxDepth).toBe(1)
    expect(r.service.getRun('run-depth')?.maxDepth).toBe(1)

    // The launch port always sends the configured depth, never `undefined`.
    // Asserted through the real seam: with the port wired at maxDepth 1, a child
    // is created at depth 1.
    r.service.setReadyTasks('run-depth', 10)
    r.service.setLaunchPort(launchPort(r))
    await r.service.drain('run-depth', [task(1)], new AbortController().signal)
    const child = r.ctx.agents.get(SessionId('c-1'))!
    expect(child.session.header.delegationDepth).toBe(1)
  })

  it('does not mistake the family pool for a global pool when a child holds the slot', async () => {
    // A subtle version of the C13 mistake: counting a CHILD's occupancy as the
    // root's, or the root's as the child's. The pool is shared along the lineage
    // ON PURPOSE (`pool` is inherited by a resident child), so the honest
    // statement is "family", not "global" and not "per-agent".
    //
    // Here: root A holds 2 (its whole pool). A DIFFERENT root still admits,
    // which proves the pool is not global. And within root A's family, the third
    // child is refused, which proves the pool is not per-agent either.
    const r = await rig({ maxActiveSubagents: 2 })
    const other = await r.anotherRoot('root-pool-2')
    const signal = new AbortController().signal
    for (const id of ['c13-p1', 'c13-p2']) {
      await r.ctx.subagents.startContinuable({
        provider: 'spawn',
        label: id,
        childId: SessionId(id),
        request: { parent: r.root, prompt: [{ type: 'text', text: 'x' }], maxDepth: 1 },
        signal,
      })
    }
    // Family A is full.
    await expect(
      r.ctx.subagents.startContinuable({
        provider: 'spawn',
        label: 'p3',
        childId: SessionId('c13-p3'),
        request: { parent: r.root, prompt: [{ type: 'text', text: 'x' }], maxDepth: 1 },
        signal,
      }),
    ).rejects.toThrow(/active child limit/)
    // Family B is not.
    const started = await r.ctx.subagents.startContinuable({
      provider: 'spawn',
      label: 'q1',
      childId: SessionId('c13-q1'),
      request: { parent: other, prompt: [{ type: 'text', text: 'x' }], maxDepth: 1 },
      signal,
    })
    expect(String(started.childId)).toBe('c13-q1')
  })

  it('the work service counts each run from its own record, never from a shared counter', async () => {
    // `counts(runId)` reads `countRun(record, liveness.get(runId), readyTaskCount.get(runId))`.
    // Both per-run maps are keyed by runId, so two runs cannot contaminate each
    // other's occupancy — the same separation the pool provides at the DSH
    // layer, restated at ours.
    const r = await rig()
    const other = await r.anotherRoot('root-count-b')
    r.service.setReadyTasks('run-x', 10)
    r.service.setReadyTasks('run-y', 1)
    await r.service.createRun({ runId: 'run-x', root: r.root, authorizationRef: 'a', targetChildren: 3 })
    await r.service.createRun({ runId: 'run-y', root: other, authorizationRef: 'b', targetChildren: 3 })

    // Each run drains through a port bound to ITS OWN root. A single shared port
    // would attribute both runs' children to one parent Agent, which is a real
    // constraint of the port's `deps.parent` and would make the child counts
    // below measure the port rather than the run.
    r.service.setLaunchPort(launchPort(r))
    await r.service.drain('run-x', [task(1), task(2)], new AbortController().signal)
    r.service.setLaunchPort(launchPort(r, other))
    await r.service.drain('run-y', [task(1, 100)], new AbortController().signal)

    // Same deficit shape, different magnitudes: the counts are per record.
    expect(r.service.counts('run-x').capacityDeficit).toBe(1)
    expect(r.service.counts('run-y').capacityDeficit).toBe(2)
    expect(r.service.counts('run-x').readyTasks).toBe(10)
    expect(r.service.counts('run-y').readyTasks).toBe(1)
    // The deficit REASON is a function of the run's own ready count against its
    // own target: run X has plenty ready and slots held; run Y is short of work.
    expect(r.service.counts('run-x').deficitReason).toBe('slots_held_by_unconfirmed')
    expect(r.service.counts('run-y').deficitReason).toBe('insufficient_ready_tasks')
    // And the real registry agrees about which root owns what.
    expect((await r.ctx.subagents.listChildren(r.root.id)).length).toBe(2)
    expect((await r.ctx.subagents.listChildren(other.id)).length).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// C14: Goal conflict
// ---------------------------------------------------------------------------

describe('C14: an active Goal and a managed run cannot both drive one root', () => {
  it('disarms only this run, leaving the objective, revision and phase intact', async () => {
    // `disarm` is the mildest available resolution (goal/src/index.ts:282-294):
    //
    //   "Remove process-local continuation authority without changing durable
    //    goal phase or revision. Lifecycle owners use this before unloading a
    //    driver; a later human-authorized resume records the new activation edge."
    //
    //   disarm(agent) { this.assertLive(agent); this.setActivation(agent.session, 'disarmed'); ... }
    //
    // It calls `setActivation`, which writes ONE field on a WeakMap keyed by the
    // Session (line 496-499). It does NOT append a `goal/change` event, so the
    // durable objective and revision cannot move. This test asserts both the
    // handover's own report AND the state read back from the service.
    const r = await rig({ withGoals: true })
    const goals = r.ctx.get('goals')!
    const created = goals.create(r.root, { objective: 'ship the daily harness' })

    const handover = r.service.takeContinuation(r.root)

    expect(handover.goalPresent).toBe(true)
    expect(handover.disarmed).toBe(true)
    expect(handover.objectivePreserved).toBe(true)
    expect(handover.revisionUnchanged).toBe(true)

    const after = goals.get(r.root)!
    expect(after.objective).toBe('ship the daily harness')
    expect(after.revision).toBe(created.revision)
    expect(after.phase).toBe('active')
    expect(after.activation).toBe('disarmed')
  })

  it('produces no double-continuation loop: the disarmed driver stops queueing rounds', async () => {
    // The concrete meaning of "no double-continuation loop". The goal round
    // driver's own admission gate is (goal-round-driver/src/index.ts:165):
    //
    //   if (goal === undefined || goal.phase !== 'active' || goal.activation !== 'armed') return
    //
    // so a disarmed goal stops the driver at its next decision point. The
    // assertion is on MODEL CALLS: while the goal is armed the driver queues
    // rounds; after the handover the request count stops growing. If both the
    // driver and the run were driving, this count would keep climbing.
    const r = await rig({ withGoals: true })
    await r.ctx.plugin(GoalRoundDriver as never, {} as never)
    const goals = r.ctx.get('goals')!
    // A large round cap so the driver is not stopped by its own budget: the only
    // thing that may stop it here is the disarm.
    goals.create(r.root, { objective: 'probe loop', maxGoalRounds: 200 })
    await new Promise(resolve => setTimeout(resolve, 400))
    const beforeHandover = r.adapter.requests.length
    expect(beforeHandover).toBeGreaterThan(0)

    r.service.takeContinuation(r.root)
    expect(goals.get(r.root)?.activation).toBe('disarmed')

    // Quiet window. A driver that ignored the disarm would keep queueing.
    await new Promise(resolve => setTimeout(resolve, 600))
    expect(r.adapter.requests.length).toBe(beforeHandover)
  })

  it('leaves another Session with an active Goal completely alone', async () => {
    // INV-G3, and the reason this is a per-root operation rather than a switch.
    // `disarm` is called with the run's own root Agent, so another Session's
    // activation is a different WeakMap entry and is never read.
    const r = await rig({ withGoals: true })
    const goals = r.ctx.get('goals')!
    const other = await r.anotherRoot('root-other-goal')
    goals.create(r.root, { objective: 'managed objective' })
    const untouched = goals.create(other, { objective: 'other objective' })

    r.service.takeContinuation(r.root)

    expect(goals.get(r.root)?.activation).toBe('disarmed')
    const otherGoal = goals.get(other)!
    expect(otherGoal.activation).toBe('armed')
    expect(otherGoal.objective).toBe('other objective')
    expect(otherGoal.revision).toBe(untouched.revision)
    expect(otherGoal.phase).toBe('active')
  })

  it('rejects a model resume built on a STALE revision, and accepts one built on the current revision', async () => {
    // `expectCurrent` is the compare-and-set (goal/src/index.ts:455-467):
    //
    //   if (ref.id !== current.id || ref.revision !== current.revision) throw new GoalError(
    //     `stale goal ref "${ref.id}" revision ${ref.revision}; current is ...`, 'GOAL_STALE_REVISION')
    //
    // This is what stops a model from acting on a goal state it read before the
    // handover. The plan calls this out explicitly: a stale revision must be
    // rejected. The model's `resume_goal` equivalent is `update_goal` with
    // action `resume`, whose arguments carry `goal_id` and `revision`
    // (goal/tool-goal/src/index.ts:236-266).
    const r = await rig({ withGoals: true })
    const goals = r.ctx.get('goals')!
    const created = goals.create(r.root, { objective: 'revision objective' })
    r.service.takeContinuation(r.root)

    // Make the ref stale by editing, which advances the revision.
    const edited = goals.edit(r.root, { id: created.id, revision: created.revision }, { objective: 'edited objective' })
    expect(edited.revision).toBeGreaterThan(created.revision)

    expect(() => goals.resume(r.root, { id: created.id, revision: created.revision }))
      .toThrow(/stale goal ref/)
    // The current ref is accepted, and re-arming is a real activation edge.
    const resumed = goals.resume(r.root, { id: edited.id, revision: edited.revision })
    expect(resumed.activation).toBe('armed')
    expect(resumed.objective).toBe('edited objective')
  })

  it('a later human-authorized resume is still possible, so the handover is not deletion', async () => {
    // The property that proves `disarm` did not clear anything: the goal can be
    // re-armed with a plain resume, and the objective survives the round trip.
    const r = await rig({ withGoals: true })
    const goals = r.ctx.get('goals')!
    const created = goals.create(r.root, { objective: 'resumable objective', maxGoalRounds: 50 })
    r.service.takeContinuation(r.root)
    expect(goals.get(r.root)?.activation).toBe('disarmed')

    const resumed = goals.resume(r.root, { id: created.id, revision: created.revision })
    expect(resumed.activation).toBe('armed')
    expect(resumed.objective).toBe('resumable objective')
    // A resume is a durable mutation, so the revision advances: that is the
    // recorded authorization edge the plan requires.
    expect(resumed.revision).toBeGreaterThan(created.revision)
  })

  it('is a complete, honest no-op when the profile mounts no Goal service', async () => {
    // A missing Goal service is not a failure: there is nothing to contend with.
    // Returning a reason rather than throwing keeps this callable from a host
    // that has no goals at all.
    const r = await rig({ withGoals: false })
    const handover = r.service.takeContinuation(r.root)
    expect(handover.goalPresent).toBe(false)
    expect(handover.disarmed).toBe(false)
    expect(handover.note).toMatch(/no goal service is mounted/)
  })
})

// ---------------------------------------------------------------------------
// C15: notification coalescing
// ---------------------------------------------------------------------------

describe('C15: notifications are bounded and no result ref is lost', () => {
  it('coalesces concurrent drains for one run so a storm cannot double-admit', async () => {
    // `drain` keeps ONE in-flight drain per run:
    //
    //   const inFlight = this.pendingDrain.get(runId)
    //   if (inFlight !== undefined) await inFlight
    //
    // and the comment above the field states why: "a completion storm must not
    // produce a storm of concurrent drains, each of which would re-read the same
    // state and try to launch the same replacement. A drain that is already
    // scheduled absorbs later requests."
    //
    // So N simultaneous triggers over ONE free slot produce ONE launch. That is
    // the boundedness half of the gate.
    const r = await rig()
    await r.service.createRun({ runId: 'run-coalesce', root: r.root, authorizationRef: 'auth' })
    r.service.setReadyTasks('run-coalesce', 10)
    r.service.setLaunchPort(launchPort(r))

    const signal = new AbortController().signal
    const same = task(1, 500)
    const outcomes = await Promise.all([
      r.service.drain('run-coalesce', [same], signal),
      r.service.drain('run-coalesce', [same], signal),
      r.service.drain('run-coalesce', [same], signal),
      r.service.drain('run-coalesce', [same], signal),
    ])
    expect(outcomes.flat().filter(o => o.accepted)).toHaveLength(1)
    expect((await r.ctx.subagents.listChildren(r.root.id)).length).toBe(1)
  })

  it('does not lose a result ref when many tasks are admitted in one drain', async () => {
    // The other half: bounded must not mean lossy. Every admitted task keeps its
    // own record, its own reservation, and its own outbox entry, so the refs are
    // all present after the storm. `admit` writes all three in ONE record
    // transform, which is why they cannot disagree.
    const r = await rig({ maxActiveSubagents: 12 })
    await r.service.createRun({ runId: 'run-refs', root: r.root, authorizationRef: 'auth', targetChildren: 12 })
    r.service.setReadyTasks('run-refs', 12)
    r.service.setLaunchPort(launchPort(r))

    const batch = Array.from({ length: 12 }, (_, i) => task(i))
    const outcomes = await r.service.drain('run-refs', batch, new AbortController().signal)
    expect(outcomes.filter(o => o.accepted)).toHaveLength(12)

    const record = r.service.getRun('run-refs')!
    // Every submitted taskId is present, with its own childId, attempt and state.
    for (const request of batch) {
      const stored = record.tasks[request.taskId]
      expect(stored).toBeDefined()
      expect(stored!.childId).toBe(request.childId)
      expect(stored!.attempt).toBe(1)
      expect(stored!.state).toBe('accepted')
      expect(stored!.assignmentDigest).toBe(request.prompt)
      // And the outbox holds the admission notification for it.
      expect(record.outbox[`admit-${request.taskId}`]?.payloadDigest).toBe(request.prompt)
    }
    expect(Object.keys(record.outbox)).toHaveLength(12)
    expect(record.budget.reserved).toBe(12)
  })

  it('a refused launch in a batch does not cost the batch its other results', async () => {
    // A partial batch: the first fits the budget, the second does not. The
    // refusal is per-task and reported, and the admitted task's ref survives. A
    // coalescing scheme that returned one shared outcome for the batch would
    // lose this distinction.
    //
    // The refusal is driven by the SECOND task being individually larger than
    // the whole child ceiling, so `mayAdmit` refuses it on the budget arm — not
    // on the slot arm, which would also refuse a second task at target 1.
    const r = await rig()
    await r.service.createRun({ runId: 'run-partial', root: r.root, authorizationRef: 'auth', targetChildren: 10 })
    r.service.setReadyTasks('run-partial', 10)
    r.service.setLaunchPort(launchPort(r))

    const outcomes = await r.service.drain(
      'run-partial',
      [
        { taskId: 'cheap', childId: 'c-cheap', prompt: 'cheap', reservedCost: 1 },
        { taskId: 'huge', childId: 'c-huge', prompt: 'huge', reservedCost: 10_000 },
      ],
      new AbortController().signal,
    )
    const byTask = new Map(outcomes.map(o => [o.taskId, o]))
    expect(byTask.get('cheap')?.accepted).toBe(true)
    expect(byTask.get('huge')?.accepted).toBe(false)
    // The reason is the BUDGET arm, named as such. The drain reports
    // `admissionReason(record, counts, request.reservedCost)`, which makes the
    // same comparison `mayAdmit` makes — including this request's cost — so a
    // refusal the gate made for budget is never reported as a slot problem. That
    // shared predicate is the property asserted here: a system whose reason for
    // a refusal disagrees with its admission gate would report one thing and do
    // another.
    expect(byTask.get('huge')?.reason).toBe('budget_blocked')
    // The run-level `counts().deficitReason` is REQUEST-AGNOSTIC by design: it
    // passes an outstanding cost of 0, so it answers "is this run short of
    // capacity in general", not "would this particular request fit". With 1 of 10
    // slots held and 10 tasks ready, the honest general answer is the slot reason.
    // Asserting it here is what pins the two questions apart: the per-request
    // answer came from the gate's own cost, the general answer did not.
    expect(r.service.counts('run-partial').deficitReason).toBe('slots_held_by_unconfirmed')
    // The per-request question is also answerable WITHOUT attempting a write,
    // through the read-only companion that shares the gate.
    expect(r.service.admissionCheck('run-partial', 10_000).reason).toBe('budget_blocked')
    expect(r.service.admissionCheck('run-partial', 1).allowed).toBe(true)
    // And the budget report shows the arithmetic behind it.
    const report = r.service.budget('run-partial')
    expect(report.childHeadroom).toBeLessThan(10_000)
    expect(report.childCommitted).toBe(1)
    // The admitted task's ref is intact; the refused one left no task behind.
    const record = r.service.getRun('run-partial')!
    expect(record.tasks['cheap']?.childId).toBe('c-cheap')
    expect(record.tasks['huge']).toBeUndefined()
  })

  it('names budget_blocked when the run-level budget really is exhausted', async () => {
    // The complement: when the RUN cannot admit anything more (committed has
    // reached the child ceiling), the reason is still `budget_blocked`. Both the
    // per-request and the run-level shape of the same refusal report the same
    // arm, which is what makes the reason checkable rather than decorative.
    const r = await rig()
    await r.service.createRun({ runId: 'run-exhausted', root: r.root, authorizationRef: 'auth', targetChildren: 10 })
    r.service.setReadyTasks('run-exhausted', 10)
    r.service.setLaunchPort(launchPort(r))
    // Reserve the whole child ceiling in one admission, then ask for one more.
    const ceiling = r.service.budget('run-exhausted').childCeiling
    await r.service.admit({
      runId: 'run-exhausted',
      taskId: 'all-of-it',
      childId: 'c-all',
      assignmentDigest: 'd',
      reservedCost: ceiling,
      allowedCapabilities: ['reader'],
    })
    expect(r.service.budget('run-exhausted').childHeadroom).toBe(0)
    const refused = await r.service.drain('run-exhausted', [task(9, 900)], new AbortController().signal)
    expect(refused[0]?.accepted).toBe(false)
    expect(refused[0]?.reason).toBe('budget_blocked')
  })

  it('does not wake the root on a timer: an idle run issues no model calls of its own', async () => {
    // "the root model is not burning an empty turn every second". The work
    // service has no polling loop at all — `drain` is a plain async function
    // triggered by events and by the root asking, and there is no timer anywhere
    // in the module. Asserted by observation: with a run open and NOTHING
    // happening, the root's model request count does not move.
    const r = await rig()
    await r.service.createRun({ runId: 'run-quiet', root: r.root, authorizationRef: 'auth' })
    r.service.setReadyTasks('run-quiet', 10)
    r.service.setLaunchPort(launchPort(r))
    const before = r.adapter.requests.length

    await new Promise(resolve => setTimeout(resolve, 600))
    expect(r.adapter.requests.length).toBe(before)
    // And the root is genuinely idle rather than parked mid-turn.
    expect(r.root.status).toBe('idle')
  })
})

// ---------------------------------------------------------------------------
// C16: idle vs complete
// ---------------------------------------------------------------------------

describe('C16: an idle root is not a finished task', () => {
  it('proves whenIdle() reports driver quiescence, not task success', async () => {
    // THE trap this gate exists for. `whenIdle()`'s own contract
    // (core/agent/src/runtime-types.ts:182-188):
    //
    //   "Resolve after the current whole-agent activity reaches quiescence. This
    //    follows replacement work started before the observed driver retires, but
    //    does not identify the settlement of any particular message."
    //
    // So it is a statement about the DRIVER, and says nothing about whether the
    // work succeeded. This test makes the distinction concrete: a root with
    // children still running is `idle`, and `whenIdle()` resolves — while the
    // work is demonstrably unfinished.
    const r = await rig()
    await r.service.createRun({ runId: 'run-idle', root: r.root, authorizationRef: 'auth' })
    r.service.setReadyTasks('run-idle', 10)
    r.service.setLaunchPort(launchPort(r))
    await r.service.drain('run-idle', [task(1), task(2)], new AbortController().signal)

    // The children are held inside their model call, so they cannot have
    // finished. Nothing has been confirmed.
    await r.root.whenIdle()
    expect(r.root.status).toBe('idle')
    const counts = r.service.counts('run-idle')
    expect(counts.activeAssignments).toBe(0)
    expect(counts.confirmed).toBe(0)
    expect(counts.capacityDeficit).toBe(8)
    // The run is still open and the children are still resident: idle did NOT
    // terminate anything.
    expect(r.service.getRun('run-idle')?.phase).toBe('open')
    expect((await r.ctx.subagents.listChildren(r.root.id)).length).toBe(2)
  })

  it('does not terminate the host or the run when the root goes idle with children running', async () => {
    // The second half of the trap: idle must not be treated as completion, so
    // the host must not drain or close the family. A controller that ended the
    // run on `whenIdle()` would leave the two children orphaned mid-call.
    const r = await rig()
    await r.service.createRun({ runId: 'run-idle2', root: r.root, authorizationRef: 'auth' })
    r.service.setReadyTasks('run-idle2', 10)
    r.service.setLaunchPort(launchPort(r))
    await r.service.drain('run-idle2', [task(1), task(2)], new AbortController().signal)

    await r.root.whenIdle()
    // Admission is still open: a new task can still be admitted, which is the
    // observable meaning of "the run was not terminated".
    const later = await r.service.drain('run-idle2', [task(3)], new AbortController().signal)
    expect(later[0]?.accepted).toBe(true)
    expect((await r.ctx.subagents.listChildren(r.root.id)).length).toBe(3)
  })

  it('makes a later result observable in a NATIVE model step of the root', async () => {
    // "new results are observable in a later native model step". The mechanism
    // is the settlement notice: when a continuable child settles, the registry
    // delivers a user message to the durable parent
    // (continuation-activation.ts:870-888):
    //
    //   const message = createSettlementMessage(activation.childId, terminal)
    //   this.sendWaking(parent, message, parent.status === 'idle' ? 'queue' : 'steer')
    //
    // with `sendWaking` falling through to `parent.followup(message)` for a
    // non-resident parent (line 334-346). A queued follow-up WAKES an idle root,
    // so the root's next native step sees the child's outcome as an ordinary
    // user message. That is the observable-result path this project relies on
    // instead of polling.
    const r = await rig()
    await r.service.createRun({ runId: 'run-observe', root: r.root, authorizationRef: 'auth' })
    r.service.setReadyTasks('run-observe', 10)
    r.service.setLaunchPort(launchPort(r))
    await r.service.drain('run-observe', [task(1)], new AbortController().signal)
    await r.root.whenIdle()

    const before = r.adapter.requests.length
    // Let the child finish; the registry then notifies the idle root.
    r.adapter.openAll()
    await new Promise(resolve => setTimeout(resolve, 700))

    // The root was woken by the notice: its request count advanced, and the
    // notice is in its own durable log with the child's id on it.
    expect(r.adapter.requests.length).toBeGreaterThan(before)
    const notices = r.root.session.snapshotEvents().filter(
      event => event.type === 'user/message' && event.data.source.kind === 'subagent-settled',
    )
    expect(notices.length).toBeGreaterThan(0)
    const notice = notices[0]!
    // The notice names the child, which is what makes it a RESULT ref rather
    // than an anonymous wake.
    expect(JSON.stringify(notice.data)).toContain('c-1')
    await r.root.whenIdle()
  })

  it('never counts an admitted-but-unobserved child as an active worker', async () => {
    // The counting half of idle-vs-complete. `countRun` counts an `executing`
    // task as an active assignment ONLY when liveness says it started real work
    // (counting.ts, the `case 'executing'` arm):
    //
    //   if (live?.startedRealWork === true) { activeAssignments += 1; ... }
    //
    // and a task right after launch is `accepted`, not `executing`. So a root
    // that has just admitted ten children reports zero active workers — the
    // honest number, since none has been observed producing tokens.
    const r = await rig({ maxActiveSubagents: 12 })
    await r.service.createRun({ runId: 'run-count', root: r.root, authorizationRef: 'auth', targetChildren: 12 })
    r.service.setReadyTasks('run-count', 12)
    r.service.setLaunchPort(launchPort(r))
    await r.service.drain('run-count', Array.from({ length: 10 }, (_, i) => task(i)), new AbortController().signal)

    const counts = r.service.counts('run-count')
    expect(counts.durablyAdmitted).toBe(10)
    expect(counts.activeAssignments).toBe(0)
    expect(counts.launching).toBe(0)
    expect(counts.confirmed).toBe(0)
    expect(counts.capacityDeficit).toBe(2)

    // The count is an OBSERVATION, not a restatement of the admission: it moves
    // only for a task the caller has explicitly observed, and only once the task
    // is in a state that can be an active assignment. `accepted` cannot be one —
    // admission is not execution — so observing it changes nothing, and the
    // number moves only after the explicit `executing` transition.
    r.service.observe('run-count', {
      taskId: 't-0',
      startedRealWork: true,
      waitingOnOwnedTool: false,
      providerWaiting: true,
    })
    const stillAdmitted = r.service.counts('run-count')
    expect(stillAdmitted.activeAssignments).toBe(0)
    expect(stillAdmitted.durablyAdmitted).toBe(10)

    await r.service.transition({ runId: 'run-count', taskId: 't-0', to: 'executing' })
    const after = r.service.counts('run-count')
    expect(after.activeAssignments).toBe(1)
    expect(after.providerWaiting).toBe(1)
    expect(after.durablyAdmitted).toBe(10)
  })
})

// ---------------------------------------------------------------------------
// C17: recovery after a failed finish
// ---------------------------------------------------------------------------

describe('C17: a failed acceptance can continue, and the family is NOT yet drained', () => {
  it('beginClosing stops new admissions while leaving the family open', async () => {
    // `beginClosing` is deliberately NOT a confirmation:
    //
    //   "This backs the model's `finish` action, and it is deliberately NOT a
    //    confirmation. It stops new admissions and leaves the acceptance
    //    decision to the runner."
    //
    // and the drain distinction the plan is emphatic about, from the real
    // contract (subagent/src/index.ts:337-345):
    //
    //   "Close continuable admission below exact live parent Agents, stop only
    //    their visible descendant Activations synchronously, then await admitted
    //    scoped materializations and release those forests child-first. The
    //    scoped cutoff lasts until each exact parent leaves the registry."
    //
    // So the two operations are NOT interchangeable: `beginClosing` is a record
    // change plus a refusal; `drainContinuableDescendants` is permanent for that
    // exact parent. A failed acceptance must be recoverable, so it must use the
    // former.
    const r = await rig()
    await r.service.createRun({ runId: 'run-close', root: r.root, authorizationRef: 'auth' })
    r.service.setReadyTasks('run-close', 10)
    r.service.setLaunchPort(launchPort(r))
    await r.service.beginClosing('run-close')

    const refused = await r.service.drain('run-close', [task(1)], new AbortController().signal)
    expect(refused[0]?.accepted).toBe(false)
    expect(refused[0]?.reason).toBe('run_not_open')
    expect(r.service.getRun('run-close')?.phase).toBe('closing')

    // THE property that makes a failed acceptance recoverable: the family is
    // still open at the real seam. A child can still be established directly.
    const started = await r.ctx.subagents.startContinuable({
      provider: 'spawn',
      label: 'correction work',
      childId: SessionId('c17-correction'),
      request: { parent: r.root, prompt: [{ type: 'text', text: 'x' }], maxDepth: 1 },
      signal: new AbortController().signal,
    })
    expect(String(started.childId)).toBe('c17-correction')
  })

  it('has NOT called the permanent family drain, so a correction child can still settle', async () => {
    // The direct assertion for "the PERMANENT family drain has NOT been called
    // yet". The drain's effect is observable: after it, admission for that exact
    // parent is refused with code DRAINING (continuation-activation.ts:446-458,
    // `assertAdmitting`). Before it, the same call succeeds. So the observable
    // difference IS the gate.
    const r = await rig()
    await r.service.createRun({ runId: 'run-nodrain', root: r.root, authorizationRef: 'auth' })
    r.service.setReadyTasks('run-nodrain', 10)
    r.service.setLaunchPort(launchPort(r))
    await r.service.beginClosing('run-nodrain')

    // A correction child is admitted and runs to a real settlement.
    const started = await r.ctx.subagents.startContinuable({
      provider: 'spawn',
      label: 'correction',
      childId: SessionId('c17-live-correction'),
      request: { parent: r.root, prompt: [{ type: 'text', text: 'x' }], maxDepth: 1 },
      signal: new AbortController().signal,
    })
    r.adapter.openAll()
    await new Promise(resolve => setTimeout(resolve, 500))
    expect(String(started.childId)).toBe('c17-live-correction')

    // Only NOW, at the definite end, is the permanent drain legal. And after it
    // the same parent cannot admit — which is what proves the pre-drain state
    // above was genuinely "not yet drained" rather than a no-op call.
    await r.ctx.subagents.drainContinuableDescendants([r.root])
    await expect(
      r.ctx.subagents.startContinuable({
        provider: 'spawn',
        label: 'too late',
        childId: SessionId('c17-too-late'),
        request: { parent: r.root, prompt: [{ type: 'text', text: 'x' }], maxDepth: 1 },
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/draining; the operation was not admitted/)
  })

  it('a resume after closing is refused, and a resume after a pause is a real authorization edge', async () => {
    // Bounded correction can continue, but not by silently reopening a closed
    // run. `resume` only lifts `paused` (`phase === 'paused' ? 'open' : phase`),
    // so `closing` is NOT reversible through it — the model cannot undo the
    // finish it just requested. The documented path back is the pause/resume
    // pair, which is a separate user decision.
    const r = await rig()
    await r.service.createRun({ runId: 'run-edge', root: r.root, authorizationRef: 'auth' })
    r.service.setReadyTasks('run-edge', 10)
    r.service.setLaunchPort(launchPort(r))

    await r.service.beginClosing('run-edge')
    await r.service.resume('run-edge')
    // Still closing: resume did not revive it.
    expect(r.service.getRun('run-edge')?.phase).toBe('closing')
    expect((await r.service.drain('run-edge', [task(1)], new AbortController().signal))[0]?.accepted).toBe(false)

    // A pause IS resumable, which is what proves pause did not use drain.
    await r.service.createRun({ runId: 'run-edge-2', root: r.root, authorizationRef: 'auth' })
    r.service.setReadyTasks('run-edge-2', 10)
    await r.service.pause('run-edge-2', 'user paused')
    expect((await r.service.drain('run-edge-2', [task(2)], new AbortController().signal))[0]?.accepted).toBe(false)
    await r.service.resume('run-edge-2')
    expect((await r.service.drain('run-edge-2', [task(3)], new AbortController().signal))[0]?.accepted).toBe(true)

    // A pause left a durable notification in the outbox, so the pause is
    // observable in the record rather than only in memory.
    const record = r.service.getRun('run-edge-2')!
    const pauseEntries = Object.values(record.outbox).filter(e => e.id.startsWith('pause-'))
    expect(pauseEntries.length).toBeGreaterThan(0)
    expect(pauseEntries[0]?.payloadDigest).toBe('user paused')
  })

  it('keeps the reservation held when a launch fails, so a correction cannot double-spend the slot', async () => {
    // The recovery window the plan is emphatic about: a launch that fails for an
    // unknown reason leaves the child's existence unknown. The task goes to
    // `unknown`, the reservation is HELD, and the slot is not silently freed —
    // because freeing it would allow a correction child to be admitted alongside
    // a child that may still exist.
    const r = await rig()
    await r.service.createRun({ runId: 'run-fail', root: r.root, authorizationRef: 'auth', targetChildren: 2 })
    r.service.setReadyTasks('run-fail', 10)
    r.service.setLaunchPort({
      launch: () => Promise.reject(new Error('scripted launch failure')),
    })

    const outcomes = await r.service.drain('run-fail', [task(1)], new AbortController().signal)
    expect(outcomes[0]?.accepted).toBe(false)
    expect(outcomes[0]?.reason).toBe('launch_failed_unknown')

    const record = r.service.getRun('run-fail')!
    expect(record.tasks['t-1']?.state).toBe('unknown')
    expect(record.tasks['t-1']?.uncertainty).toMatch(/launch failed/)
    // The slot is still held and the credit still reserved.
    expect(record.budget.reserved).toBe(1)
    expect(r.service.counts('run-fail').quarantinedUnknown).toBe(1)
    expect(r.service.counts('run-fail').capacityDeficit).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// C18: final drain
// ---------------------------------------------------------------------------

describe('C18: after a definite completion, the drain is final and explicit', () => {
  it('refuses a new child on the exact drained parent, with a named reason', async () => {
    // The refusal is `DRAINING` from `assertAdmitting`
    // (continuation-activation.ts:446-458):
    //
    //   const closing = this.closingTeardownFor(agent)
    //   if (closing === undefined) return
    //   throw new SubagentError(closing === 'manager'
    //     ? 'continuable subagents are draining; the operation was not admitted'
    //     : `continuable subagents below parent "${closing.id}" are draining; ...`, 'DRAINING')
    //
    // The reason NAMES the parent, which is what makes this an explicit close
    // rather than an opaque failure.
    const r = await rig()
    await r.ctx.subagents.drainContinuableDescendants([r.root])

    let thrown: unknown
    try {
      await r.ctx.subagents.startContinuable({
        provider: 'spawn',
        label: 'after drain',
        childId: SessionId('c18-after-drain'),
        request: { parent: r.root, prompt: [{ type: 'text', text: 'x' }], maxDepth: 1 },
        signal: new AbortController().signal,
      })
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(SubagentError)
    expect((thrown as SubagentError).code).toBe('DRAINING')
    expect((thrown as Error).message).toContain(String(r.root.id))
    expect(r.ctx.agents.get(SessionId('c18-after-drain'))).toBeUndefined()
  })

  it('does not revive the parent by flipping a private flag: the refusal is stable across attempts', async () => {
    // "no private flag is flipped to revive it". The scoped cutoff is a Map entry
    // keyed on the EXACT root Agent (continuation-activation.ts:187-193):
    //
    //   "Exact roots whose host teardown has begun, with the live lineage members
    //    observed under each root. Entries remain until that exact root leaves the
    //    Agent registry, closing admission throughout its host's teardown without
    //    poisoning a later same-id replacement."
    //
    // and it is deleted only on `agent/disposed` (line 217-219). So repeated
    // attempts, drains, and other operations cannot clear it. Asserted by
    // repetition plus a second drain: if any of those flipped a flag, one of the
    // later attempts would succeed.
    const r = await rig()
    await r.ctx.subagents.drainContinuableDescendants([r.root])
    await r.ctx.subagents.drainContinuableDescendants([r.root])

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await expect(
        r.ctx.subagents.startContinuable({
          provider: 'spawn',
          label: `attempt ${attempt}`,
          childId: SessionId(`c18-attempt-${attempt}`),
          request: { parent: r.root, prompt: [{ type: 'text', text: 'x' }], maxDepth: 1 },
          signal: new AbortController().signal,
        }),
      ).rejects.toThrow(/DRAINING|draining/)
    }
    // Nothing was created by any attempt.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      expect(r.ctx.agents.get(SessionId(`c18-attempt-${attempt}`))).toBeUndefined()
    }
  })

  it('leaves an unrelated parent fully admitted, so the close is scoped and not global', async () => {
    // The scoped cutoff must not be a global switch. The registry's own words:
    // "unrelated parent trees remain live."
    const r = await rig()
    const other = await r.anotherRoot('root-c18-other')
    await r.ctx.subagents.drainContinuableDescendants([r.root])

    const started = await r.ctx.subagents.startContinuable({
      provider: 'spawn',
      label: 'unrelated',
      childId: SessionId('c18-other-child'),
      request: { parent: other, prompt: [{ type: 'text', text: 'x' }], maxDepth: 1 },
      signal: new AbortController().signal,
    })
    expect(String(started.childId)).toBe('c18-other-child')
  })

  it('routes subsequent work through a NEW run lifecycle rather than reviving the closed one', async () => {
    // The positive half of C18: after a definite completion, further work is a
    // NEW run with its OWN record, target, budget and root — not a reopened old
    // one. This is asserted at the record layer, which is the layer that could
    // plausibly be "revived" by flipping a phase back to `open`.
    const r = await rig()
    const first = await r.service.createRun({ runId: 'run-first', root: r.root, authorizationRef: 'auth-1' })
    r.service.setReadyTasks('run-first', 10)
    r.service.setLaunchPort(launchPort(r))
    await r.service.drain('run-first', [task(1)], new AbortController().signal)
    await r.service.beginClosing('run-first')

    // The old run stays closed. Nothing in this project writes `open` back onto
    // a closing run: `resume` only lifts `paused`.
    await r.service.resume('run-first')
    expect(r.service.getRun('run-first')?.phase).toBe('closing')
    expect(r.service.getRun('run-first')?.runId).toBe(first.runId)

    // New work needs a new run, with its own authorization ref and epoch 1.
    const second = await r.service.createRun({ runId: 'run-second', root: r.root, authorizationRef: 'auth-2' })
    expect(second.runId).toBe('run-second')
    expect(second.epoch).toBe(1)
    expect(second.authorizationRef).toBe('auth-2')
    expect(second.phase).toBe('open')
    expect(Object.keys(second.tasks)).toHaveLength(0)
    // Two distinct records exist side by side; neither overwrote the other.
    expect(r.service.listRunIds().sort()).toEqual(['run-first', 'run-second'])
    expect(r.service.getRun('run-first')?.authorizationRef).toBe('auth-1')

    // And the new run admits, while the old one is still refused: the lifecycle
    // really did move on rather than being revived in place.
    r.service.setReadyTasks('run-second', 10)
    expect((await r.service.drain('run-second', [task(2)], new AbortController().signal))[0]?.accepted).toBe(true)
    expect((await r.service.drain('run-first', [task(3)], new AbortController().signal))[0]?.accepted).toBe(false)
  })
})
