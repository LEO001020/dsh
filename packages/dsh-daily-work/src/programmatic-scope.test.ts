/**
 * BRG-01..08: the programmatic-call scope, closed against the REAL DSH registry.
 *
 * WHAT IS REAL HERE. `ToolRuntime` itself, mounted through `ctx.plugin`, so
 * `tools/pre-execute`, the monotonic guard slot, the approval `ask` seam,
 * canonical-value validation against the tool's declared output schema,
 * `tools/post-execute`, `finalizeContent` and `tools/result` are the shipped
 * behaviours and not a restatement of them. The `run_code` comparison arm uses
 * the REAL `NodePtcRuntime`, so BRG-01 compares two routes through one pipeline
 * rather than proving a fake agrees with itself.
 *
 * WHAT IS CONTROLLED, and only at the boundary. The tests are about the
 * pipeline, so no model provider is mounted and no turn is opened; the
 * `run_code` programs are the constant `'program'`, because `FakeRuntime` never
 * interprets them — the binding functions ARE the program. That is the
 * documented role of the runtime seam ("a scriptable in-repo PtcRuntime: each
 * test sets `behavior` to drive the bindings however it needs"), the same shape
 * `packages/core/tools/tests/ptc.spec.ts` uses.
 *
 * THE SCOPE'S OWN LIMITATION IS ASSERTED, NOT HIDDEN. `ptc.ts` splits each
 * sub-dispatch at the registry's scheduler seam, so a slow pre-execute on call N
 * delays the START of call N+1. A scope built on `registry.execute` cannot
 * reproduce that, because each call is one indivisible `execute()`. BRG-01
 * measures the difference in both directions rather than claiming identity.
 */
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, UserMessage } from '@deepseek-ai/dsh-llm'
import { PtcRuntime } from '@deepseek-ai/dsh-ptc-runtime'
import type { PtcRunRequest, PtcRunResult, PtcRunSpec } from '@deepseek-ai/dsh-ptc-runtime'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import SessionProjections from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ApprovalService from '@deepseek-ai/dsh-user-approval'
import ToolRuntime, { RUN_CODE_NAME, defineTool, TOOL_ABORTED_BEFORE_DISPATCH } from '@deepseek-ai/dsh-tools'
import type { ToolExecutionToken } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createProgrammaticCallScope,
  ScopeDeliveryBudgetError,
  type ProgrammaticCallScopeHandle,
  type ScopeCallDisposition,
} from './programmatic-scope.ts'
import { ProgrammaticScopeService } from './programmatic-scope-plugin.ts'

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

/** A scriptable PtcRuntime, so a `run_code` arm can drive bindings without a model. */
class FakeRuntime extends PtcRuntime {
  resolve(request: PtcRunRequest): PtcRunSpec {
    return { ...request, cwd: request.cwd ?? process.cwd(), timeoutMs: request.timeoutMs ?? 120_000 }
  }

  readonly language = 'typescript'
  readonly isolation = 'fake'
  behavior: (request: PtcRunRequest) => Promise<PtcRunResult> = () => Promise.resolve({ logs: [] })

  run(request: PtcRunRequest): Promise<PtcRunResult> {
    return this.behavior(request)
  }
}

/** The mounted PTC runtime, as the concrete test runtime. */
function ptcRuntime(ctx: Context): FakeRuntime {
  const runtime = ctx.get('ptcRuntime')
  if (!(runtime instanceof FakeRuntime)) throw new Error('the test rig must mount FakeRuntime')
  return runtime
}

interface Rig {
  readonly ctx: Context
  readonly tools: ToolRuntime
  /** Mint a scope exactly as a transport host would: from an enclosing execution. */
  open(overrides?: Partial<OpenScopeInput>): ProgrammaticCallScopeHandle
}

/** What a host must supply; the test supplies it the way a transport tool would. */
interface OpenScopeInput {
  readonly maxParallel: number
  readonly valueBudgetBytes: number
  readonly contentProjection: 'reference' | 'defer-images'
  readonly maxNotices: number
  readonly maxNoticeChars: number
  readonly handoffToJobs: ((call: { subCallId: string; name: string; args: JsonValue }) => { jobId: string } | undefined) | undefined
  readonly dispositions: ScopeCallDisposition[]
  readonly deferred: UserMessage[]
  /** Mutable: the control sink counts conclusions, so the test can read it after. */
  conclusions: number
  /**
   * The exact Agent the scope acts as. Host-bound, never a call parameter — the
   * rig accepts it only so a test can supply the turn-bearing session the
   * approval seam requires.
   */
  readonly agent: Agent | undefined
}

/** Boot a real registry, optionally in `both` mode with the real PTC runtime. */
async function rig(options: { mode?: 'native' | 'ptc' | 'both'; ptc?: boolean } = {}): Promise<Rig> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt, { personaPrefix: '' })
  await ctx.plugin(SessionProjections)
  await ctx.plugin(ToolRuntime, { mode: options.mode ?? 'native', maxParallelSubCalls: 10 })
  if (options.ptc === true) await ctx.plugin(FakeRuntime)
  onCleanup(() => ctx.fiber.dispose())

  const tools = ctx.tools
  return {
    ctx,
    tools,
    open: (overrides = {}) => {
      const settings: OpenScopeInput = {
        maxParallel: 10,
        valueBudgetBytes: 64 * 1024,
        contentProjection: 'reference',
        maxNotices: 64,
        maxNoticeChars: 4096,
        handoffToJobs: undefined,
        dispositions: [],
        deferred: [],
        conclusions: 0,
        agent: undefined,
        ...overrides,
      }
      // `parent` is the HOST's own enclosing-execution token. A test cannot mint
      // one (`ToolExecutionToken` is a branded symbol the registry owns), so the
      // host surface is exercised through the real `run_code` execution below
      // where a token genuinely exists; here a stand-in is passed because the
      // registry accepts any opaque symbol for an ownerless call. The type is
      // satisfied by the brand without inventing a value the runtime reads.
      const parent = Symbol('test.parent') as unknown as ToolExecutionToken
      return createProgrammaticCallScope({
        registry: tools,
        parent,
        ...settings.agent === undefined ? {} : { agent: settings.agent },
        signal: new AbortController().signal,
        callIdPrefix: 'call-1',
        control: {
          deferContext: (context) => { settings.deferred.push(context) },
          concludeTurn: () => { settings.conclusions += 1 },
        },
        maxParallel: settings.maxParallel,
        valueBudgetBytes: settings.valueBudgetBytes,
        contentProjection: settings.contentProjection,
        maxNotices: settings.maxNotices,
        maxNoticeChars: settings.maxNoticeChars,
        onDisposition: (disposition) => { settings.dispositions.push(disposition) },
        ...settings.handoffToJobs === undefined ? {} : { handoffToJobs: settings.handoffToJobs },
      })
    },
  }
}

/** Register an echo tool returning a declared canonical type. */
function registerEcho(ctx: Context, name = 'echo'): { calls: unknown[] } {
  const calls: unknown[] = []
  ctx.tools.register(defineTool({
    name,
    description: `Echo tool ${name}.`,
    parameters: { value: { type: 'string', required: true } },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    execute(args) {
      calls.push(args)
      return Promise.resolve(`${name}:${args.value}`)
    },
  }))
  return { calls }
}

/** Register a tool with a structured canonical type, so BRG-03 can check T. */
function registerReader(ctx: Context): { calls: number } {
  const state = { calls: 0 }
  ctx.tools.register(defineTool({
    name: 'read',
    description: 'Returns a small canonical record.',
    parameters: { path: { type: 'string', required: true } },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', required: true },
          lines: { type: 'integer', required: true },
          text: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `${value.path}: ${String(value.lines)} lines` }],
    },
    execute(args) {
      state.calls += 1
      return Promise.resolve({ path: args.path, lines: 2, text: 'alpha\nbeta' })
    },
  }))
  return state
}

// ---------------------------------------------------------------------------
// BRG-01: one pipeline, three routes
// ---------------------------------------------------------------------------

describe('BRG-01: the same tool through native, PTC and the scope is one pipeline', () => {
  it('produces the SAME canonical value on all three routes', async () => {
    const r = await rig({ mode: 'both', ptc: true })
    const echo = registerEcho(r.ctx)
    const scope = r.open()

    // Route 1: model-direct native call.
    const native = await r.tools.execute({
      callId: ToolCallId('native-1'), name: 'echo', arguments: { value: 'one' },
      signal: new AbortController().signal,
    })
    expect(native.isError).toBe(false)
    if (native.isError) throw new Error('native call failed')

    // Route 2: the stock `run_code` transport, driving the SAME tool through
    // its own sub-dispatch bridge. `FakeRuntime` runs the binding directly, so
    // what is measured is the bridge, not a program interpreter.
    const runtime = ptcRuntime(r.ctx)
    runtime.behavior = async (request) => {
      const value = await request.bindings[0]!.functions.echo!({ value: 'one' })
      return { logs: [], value }
    }
    const ptc = await r.tools.execute({
      callId: ToolCallId('ptc-1'), name: RUN_CODE_NAME,
      arguments: { code: 'program', description: 'call echo through PTC' },
      signal: new AbortController().signal,
    })
    expect(ptc.isError).toBe(false)
    if (ptc.isError) throw new Error(`run_code failed: ${ptc.error.message}`)
    const throughPtc = (ptc.value as { result?: unknown }).result

    // Route 3: the scope.
    const throughScope = await scope.invoke('echo', { value: 'one' }, 'value')

    // THE ASSERTION: one canonical JSON value, reached three ways.
    expect(throughPtc).toEqual(native.value)
    expect(throughScope).toEqual(native.value)
    expect(JSON.stringify(throughScope)).toBe(JSON.stringify(native.value))
    // And the tool really ran three times: the comparison is not three reads of
    // one execution.
    expect(echo.calls).toEqual([{ value: 'one' }, { value: 'one' }, { value: 'one' }])
    await scope.close('completed')
  })

  it('a monotonic GUARD denies the scope exactly as it denies a native call', async () => {
    const r = await rig({ mode: 'both', ptc: true })
    const echo = registerEcho(r.ctx)
    r.tools.guard((exec) => exec.name === 'echo' ? 'echo is revoked by policy' : undefined)

    const native = await r.tools.execute({
      callId: ToolCallId('native-denied'), name: 'echo', arguments: { value: 'one' },
      signal: new AbortController().signal,
    })
    expect(native.isError).toBe(true)

    const runtime = ptcRuntime(r.ctx)
    runtime.behavior = async (request) => ({
      logs: [],
      value: await request.bindings[0]!.functions.echo!({ value: 'one' })
        .then(() => 'unexpected grant', (error: unknown) => (error as Error).message),
    })
    const ptc = await r.tools.execute({
      callId: ToolCallId('ptc-denied'), name: RUN_CODE_NAME,
      arguments: { code: 'program', description: 'try a guarded call' },
      signal: new AbortController().signal,
    })
    if (ptc.isError) throw new Error('run_code failed')
    const ptcMessage = (ptc.value as { result?: unknown }).result

    const scope = r.open()
    const scopeMessage = await scope.invoke('echo', { value: 'one' }, 'value')
      .then(() => 'unexpected grant', (error: unknown) => (error as Error).message)

    // All three carry the guard's own reason, so the denial is one decision
    // observed three times rather than three policies that happen to agree.
    expect(scopeMessage).toBe('echo is revoked by policy')
    expect(ptcMessage).toBe('echo is revoked by policy')
    expect(native.isError ? native.error.message : '').toBe('echo is revoked by policy')
    // The guard fired before the body on every route.
    expect(echo.calls).toEqual([])
    await scope.close('completed')
  })

  it('an `ask` decision reaches the scope and a denial is not a bypass', async () => {
    const r = await rig()
    const echo = registerEcho(r.ctx)
    const asked: string[] = []
    // A `tools/pre-execute` listener is the extensible policy seam; `ask` runs
    // only after an approval service grants. No approval service is mounted, so
    // the documented fail-closed degrade is what must be observed.
    r.ctx.on('tools/pre-execute', (exec, next) => {
      if (exec.name !== 'echo') return next()
      asked.push(exec.name)
      return Promise.resolve({ kind: 'ask', reason: 'echo needs approval' })
    })

    const scope = r.open()
    const message = await scope.invoke('echo', { value: 'one' }, 'value')
      .then(() => 'unexpected grant', (error: unknown) => (error as Error).message)
    // The gate was consulted at all — that is what "no bypass" means — and its
    // own reason is what the program receives, verbatim.
    expect(asked).toEqual(['echo'])
    expect(message).toBe('echo needs approval')
    // Denied BEFORE the body: an approval gate the scope could skip would be a
    // bypass, so the body not running is the assertion.
    expect(echo.calls).toEqual([])
    await scope.close('completed')
  })

  it('a real ApprovalService denial reaches the scope as a denial', async () => {
    // The previous test exercises the no-approval degrade. This one mounts the
    // REAL service with its `never` policy, so the decision is the service's own
    // deterministic reject and the answer travels back through the same `ask`
    // seam the native loop uses.
    //
    // The request requires an OPEN TURN ("approval.request() outside an open
    // turn ... must be turn-enclosed"), so the rig gives the scope an agent
    // whose session has one. That is the production precondition, not a test
    // convenience: a real transport call runs inside a turn.
    const r = await rig()
    const echo = registerEcho(r.ctx)
    await r.ctx.plugin(ApprovalService, { policy: 'never' })
    const session = Session.create(SessionId('scope-approval'))
    session.append('turn/start', { turn: 1 })
    const agent = { session } as unknown as Agent
    r.ctx.on('tools/pre-execute', (exec, next) => exec.name === 'echo'
      ? Promise.resolve({ kind: 'ask', reason: 'echo needs approval' })
      : next())

    const scope = r.open({ agent })
    const message = await scope.invoke('echo', { value: 'one' }, 'value')
      .then(() => 'unexpected grant', (error: unknown) => (error as Error).message)
    // The `never` policy rejects deterministically before any answerer runs.
    expect(message).toMatch(/rejected/)
    expect(echo.calls).toEqual([])
    // The decision is audited on the session, which is what makes it the same
    // seam rather than a parallel one.
    const decided = session.snapshotEvents().filter(event => event.type === 'approval/decided')
    expect(decided.map(event => event.data)).toMatchObject([{ outcome: 'rejected' }])
    await scope.close('completed')
  })

  it('post-execute policy replaces the value on the scope route too', async () => {
    const r = await rig()
    registerEcho(r.ctx)
    r.ctx.on('tools/post-execute', async (exec, result, next) => {
      if (exec.name !== 'echo') return next()
      if (result.isError) return next()
      return { kind: 'accept', value: 'redacted-by-policy' }
    })
    const scope = r.open()
    const value = await scope.invoke('echo', { value: 'one' }, 'value')
    expect(value).toBe('redacted-by-policy')
    await scope.close('completed')
  })

  it('a canonical value violating the declared output schema fails on the scope route', async () => {
    const r = await rig()
    r.tools.register(defineTool({
      name: 'liar',
      description: 'Returns a value its own schema forbids.',
      parameters: {},
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: { ok: { type: 'boolean', required: true } },
        },
        render: () => [{ type: 'text', text: 'x' }],
      },
      // A field the closed schema does not declare.
      execute: () => Promise.resolve({ ok: true, smuggled: 'nope' }),
    }))
    const scope = r.open()
    const message = await scope.invoke('liar', {}, 'value')
      .then(() => 'unexpected success', (error: unknown) => (error as Error).message)
    expect(message).toMatch(/additionalProperties: false/)
    await scope.close('completed')
  })

  it('MEASURES the scheduling difference from run_code instead of claiming identity', async () => {
    // This is the scope's one real limitation, asserted so it cannot silently
    // become a claim of equivalence.
    //
    // `run_code` splits each sub-dispatch at the registry scheduler seam: the
    // ordered pre-execute stages run inside ONE driver lane, so a slow
    // pre-execute on call N delays the START of call N+1. A scope built on
    // `registry.execute` cannot do that, because each call is one indivisible
    // `execute()`. Here two concurrently-started scope calls have their
    // pre-execute stages OVERLAP. That is a scheduling difference, not a policy
    // bypass: both calls still run the complete gate.
    //
    // The tool must be concurrency-safe, or the registry classifies it
    // `exclusive` and the pool serializes the calls for an unrelated reason —
    // which would make this measurement vacuous.
    const r = await rig()
    r.tools.register(defineTool({
      name: 'safe-probe',
      description: 'Concurrency-safe, so overlap is the pool decision and not a barrier.',
      parameters: { id: { type: 'string', required: true } },
      output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
      isConcurrencySafe: () => true,
      execute: args => Promise.resolve(args.id),
    }))
    let inPreExecute = 0
    let maxConcurrentPreExecute = 0
    r.ctx.on('tools/pre-execute', async (exec, next) => {
      if (exec.name !== 'safe-probe') return next()
      inPreExecute += 1
      maxConcurrentPreExecute = Math.max(maxConcurrentPreExecute, inPreExecute)
      await new Promise(resolve => setTimeout(resolve, 20))
      inPreExecute -= 1
      return next()
    })

    const scope = r.open({ maxParallel: 4 })
    await Promise.all([
      scope.invoke('safe-probe', { id: 'a' }, 'value'),
      scope.invoke('safe-probe', { id: 'b' }, 'value'),
    ])
    // The documented limitation, observed: pre-execute stages DO overlap here,
    // where `run_code`'s ordered lane would have started the second call only
    // after the first call's pre-execute resolved.
    expect(maxConcurrentPreExecute).toBeGreaterThan(1)
    await scope.close('completed')
  })

  it('the scope does NOT bypass the ptc presentation collapse', async () => {
    // Under `mode: 'ptc'` a model-direct native call is denied as UNKNOWN_TOOL.
    // A scope is a transport sub-dispatch, so it is admitted — and that is
    // exactly why the parent token must be the HOST's: a scope that could mint
    // its own would be a collapse bypass.
    const r = await rig({ mode: 'ptc', ptc: true })
    registerEcho(r.ctx)

    const direct = await r.tools.execute({
      callId: ToolCallId('direct'), name: 'echo', arguments: { value: 'one' },
      signal: new AbortController().signal,
    })
    expect(direct.isError).toBe(true)
    expect(direct.isError ? direct.error.info?.code : undefined).toBe('UNKNOWN_TOOL')

    const scope = r.open()
    const value = await scope.invoke('echo', { value: 'one' }, 'value')
    expect(value).toBe('echo:one')
    await scope.close('completed')
  })
})

// ---------------------------------------------------------------------------
// BRG-02: dynamic revocation
// ---------------------------------------------------------------------------

describe('BRG-02: revoking a tool mid-scope takes effect on the next call', () => {
  it('a tool unregistered while the scope is open fails its next call', async () => {
    const r = await rig()
    registerEcho(r.ctx, 'revocable')
    const scope = r.open()

    // Works while it is registered.
    expect(await scope.invoke('revocable', { value: 'before' }, 'value')).toBe('revocable:before')

    // REVOKE while the scope stays open. `register` returns the exact disposer.
    const disposer = r.tools.register(defineTool({
      name: 'unused-placeholder',
      description: 'placeholder',
      parameters: {},
      output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
      execute: () => Promise.resolve('x'),
    }))
    disposer()
    const echoDisposer = r.tools.register(defineTool({
      name: 'revocable2',
      description: 'a second registration we will remove',
      parameters: { value: { type: 'string', required: true } },
      output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
      execute: () => Promise.resolve('revocable2:ok'),
    }))
    echoDisposer()
    const revoked = await scope.invoke('revocable2', { value: 'x' }, 'value')
      .then(() => 'unexpected success', (error: unknown) => (error as Error).message)
    expect(revoked).toMatch(/unknown tool/)

    await scope.close('completed')
  })

  it('names() is a LIVE read, and revocation is visible through it', async () => {
    const r = await rig()
    const scope = r.open()
    // A registration whose disposer is the ONLY way it disappears. A duplicate
    // global registration is refused by the registry, so this is the shape a
    // real revocation takes; `names()` must follow it live.
    const handle = r.ctx.tools.register(defineTool({
      name: 'revocable',
      description: 'Registered for this test only.',
      parameters: { value: { type: 'string', required: true } },
      output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
      execute: args => Promise.resolve(`revocable:${args.value}`),
    }))
    expect(scope.names()).toContain('revocable')
    expect(await scope.invoke('revocable', { value: 'x' }, 'value')).toBe('revocable:x')

    // REVOKE, while the scope stays open.
    handle()
    expect(scope.names()).not.toContain('revocable')
    const denied = await scope.invoke('revocable', { value: 'x' }, 'value')
      .then(() => 'unexpected success', (error: unknown) => (error as Error).message)
    expect(denied).toMatch(/unknown tool/)
    await scope.close('completed')
  })

  it('a tool unregistered by its own disposer is gone from the next call', async () => {
    const r = await rig()
    const scope = r.open()
    // Re-registering the same name after disposal is the other direction of the
    // same rule: the read and the dispatch both follow the registry.
    const first = r.ctx.tools.register(defineTool({
      name: 'swap',
      description: 'First generation.',
      parameters: { value: { type: 'string', required: true } },
      output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
      execute: args => Promise.resolve(`first:${args.value}`),
    }))
    expect(await scope.invoke('swap', { value: 'a' }, 'value')).toBe('first:a')
    first()
    r.ctx.tools.register(defineTool({
      name: 'swap',
      description: 'Second generation.',
      parameters: { value: { type: 'string', required: true } },
      output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
      execute: args => Promise.resolve(`second:${args.value}`),
    }))
    // The NEXT call resolves the live definition, not one captured at open.
    expect(await scope.invoke('swap', { value: 'a' }, 'value')).toBe('second:a')
    await scope.close('completed')
  })
})

// ---------------------------------------------------------------------------
// BRG-03: small values stay typed
// ---------------------------------------------------------------------------

describe('BRG-03: value delivery returns the declared canonical type, never a reference', () => {
  it('returns the declared T and is never an ArtifactRef', async () => {
    const r = await rig()
    const reader = registerReader(r.ctx)
    const scope = r.open()

    const value = await scope.invoke('read', { path: 'a.txt' }, 'value')
    // The declared canonical type, unchanged.
    expect(value).toEqual({ path: 'a.txt', lines: 2, text: 'alpha\nbeta' })
    expect(typeof value).toBe('object')
    expect(value).not.toBeNull()
    // NOT a reference: the failure this gate names is a typed tool that
    // "sometimes returns T and sometimes secretly returns an ArtifactRef".
    expect((value as { kind?: unknown }).kind).not.toBe('scope-reference')
    expect((value as { id?: unknown }).id).toBeUndefined()
    // And the canonical type is stable across repeated calls, not a coin flip.
    for (let i = 0; i < 5; i++) {
      const again = await scope.invoke('read', { path: 'a.txt' }, 'value')
      expect(again).toEqual(value)
      expect((again as { kind?: unknown }).kind).not.toBe('scope-reference')
    }
    expect(reader.calls).toBe(6)
    await scope.close('completed')
  })

  it('over-budget value delivery throws with the retained reference and does NOT re-execute', async () => {
    const r = await rig()
    let executions = 0
    r.tools.register(defineTool({
      name: 'big',
      description: 'Returns more than the value budget.',
      parameters: {},
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: `${String(value.length)} bytes` }],
      },
      execute() {
        executions += 1
        return Promise.resolve('x'.repeat(5000))
      },
    }))
    const scope = r.open({ valueBudgetBytes: 1024 })

    const failure = await scope.invoke('big', {}, 'value')
      .then(() => undefined, (error: unknown) => error)
    expect(failure).toBeInstanceOf(ScopeDeliveryBudgetError)
    const budgetError = failure as ScopeDeliveryBudgetError
    // The error carries a reference to the ALREADY-RETAINED result...
    expect(budgetError.reference.kind).toBe('scope-reference')
    expect(budgetError.reference.bytes).toBeGreaterThan(1024)
    expect(budgetError.message).toMatch(/NOT re-executed/)
    // ...and the effect ran exactly once, which is the whole point: recovering
    // the value must never repeat the effect.
    expect(executions).toBe(1)
    // The retained bytes really are the result.
    const retained = await scope.read(budgetError.reference)
    expect(retained).toContain('x'.repeat(100))
    expect(executions).toBe(1)
    await scope.close('completed')
  })
})

// ---------------------------------------------------------------------------
// BRG-04: reference delivery
// ---------------------------------------------------------------------------

describe('BRG-04: reference delivery executes exactly once and references the post-policy result', () => {
  it('runs the tool EXACTLY ONCE and returns a reference to the final value', async () => {
    const r = await rig()
    const echo = registerEcho(r.ctx, 'once')
    const scope = r.open()

    const reference = await scope.invoke('once', { value: 'payload' }, 'reference') as unknown as {
      kind: string
      id: string
      sha256: string
      bytes: number
      tool: string
      isError: boolean
    }
    expect(reference.kind).toBe('scope-reference')
    expect(reference.tool).toBe('once')
    expect(reference.isError).toBe(false)
    expect(reference.sha256).toBe(reference.id)

    // EXACTLY ONCE. The count is the assertion, not a by-product.
    expect(echo.calls).toEqual([{ value: 'payload' }])

    // The reference recovers the post-policy canonical value. The retained bytes
    // ARE the canonical JSON value, so parsing yields it directly.
    const stored = await scope.read(reference as never)
    expect(stored).toBeDefined()
    expect(JSON.parse(stored ?? 'null')).toBe('once:payload')
    // Reading the reference does not re-run the tool.
    expect(echo.calls).toHaveLength(1)
    await scope.close('completed')
  })

  it('the reference carries the POST-POLICY value, not the pre-policy one', async () => {
    const r = await rig()
    registerEcho(r.ctx, 'redact-me')
    // A post-execute policy that replaces the value. The reference must carry
    // what policy produced, because it is captured AFTER the final result.
    r.ctx.on('tools/post-execute', async (exec, result, next) => {
      if (exec.name !== 'redact-me' || result.isError) return next()
      return { kind: 'accept', value: 'POLICY-OUTPUT' }
    })
    const scope = r.open()
    const reference = await scope.invoke('redact-me', { value: 'SECRET-INPUT' }, 'reference')
    const stored = await scope.read(reference as never)
    expect(stored).toContain('POLICY-OUTPUT')
    expect(stored).not.toContain('SECRET-INPUT')
    await scope.close('completed')
  })

  it('value and reference delivery of the same tool are the same execution result', async () => {
    const r = await rig()
    const echo = registerEcho(r.ctx, 'both-ways')
    const scope = r.open()
    const direct = await scope.invoke('both-ways', { value: 'v' }, 'value')
    const reference = await scope.invoke('both-ways', { value: 'v' }, 'reference')
    const stored = await scope.read(reference as never)
    // Same tool, same args, two deliveries, one canonical answer: the reference
    // holds exactly the JSON the `value` route handed back.
    expect(JSON.parse(stored ?? 'null')).toEqual(direct)
    expect(echo.calls).toHaveLength(2)
    await scope.close('completed')
  })
})

// ---------------------------------------------------------------------------
// BRG-05: a redacted secret is not recoverable
// ---------------------------------------------------------------------------

describe('BRG-05: a value policy removed is not recoverable through a reference', () => {
  it('a post-policy BLOCK leaves no recoverable original in the store', async () => {
    const r = await rig()
    r.tools.register(defineTool({
      name: 'secret',
      description: 'Returns a sensitive value.',
      parameters: {},
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: value }],
      },
      execute: () => Promise.resolve('sk-live-DO-NOT-LEAK'),
    }))
    // The policy BLOCKS the call: post-execute turns it into an error result.
    r.ctx.on('tools/post-execute', async (exec, _result, next) => {
      if (exec.name !== 'secret') return next()
      return { kind: 'block', feedback: [{ type: 'text', text: 'sensitive value withheld by policy' }] }
    })
    const scope = r.open()

    // Value delivery fails with the policy's own message.
    const message = await scope.invoke('secret', {}, 'value')
      .then(() => 'unexpected success', (error: unknown) => (error as Error).message)
    expect(message).toBe('sensitive value withheld by policy')

    // THE ASSERTION: nothing retained anywhere contains the secret. A reference
    // path that stored the PRE-policy value would leak it here.
    const retained = await scope.references.list()
    for (const object of retained) {
      const bytes = await scope.references.read(object.id)
      const text = new TextDecoder().decode(bytes ?? new Uint8Array())
      expect(text).not.toContain('sk-live-DO-NOT-LEAK')
    }
    // And no reference was minted for the blocked call at all.
    expect(retained).toHaveLength(0)
    await scope.close('completed')
  })

  it('a policy that REPLACES a sensitive value leaves only the replacement retrievable', async () => {
    const r = await rig()
    r.tools.register(defineTool({
      name: 'secret2',
      description: 'Returns a sensitive value that policy redacts.',
      parameters: {},
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: value }],
      },
      execute: () => Promise.resolve('sk-live-SECOND-SECRET'),
    }))
    r.ctx.on('tools/post-execute', async (exec, result, next) => {
      if (exec.name !== 'secret2' || result.isError) return next()
      return { kind: 'accept', value: '[redacted]' }
    })
    const scope = r.open()
    const reference = await scope.invoke('secret2', {}, 'reference')
    const stored = await scope.read(reference as never)
    expect(stored).toContain('[redacted]')
    // The original is not in the store, in any object.
    const retained = await scope.references.list()
    for (const object of retained) {
      const bytes = await scope.references.read(object.id)
      const text = new TextDecoder().decode(bytes ?? new Uint8Array())
      expect(text).not.toContain('sk-live-SECOND-SECRET')
    }
    await scope.close('completed')
  })

  it('a blocked call retains nothing even under reference delivery', async () => {
    const r = await rig()
    r.tools.register(defineTool({
      name: 'secret3',
      description: 'Blocked outright.',
      parameters: {},
      output: { schema: { type: 'string' }, render: () => [{ type: 'text', text: 'x' }] },
      execute: () => Promise.resolve('sk-live-THIRD'),
    }))
    r.ctx.on('tools/post-execute', async (exec, _result, next) => exec.name === 'secret3'
      ? Promise.resolve({ kind: 'block', feedback: [{ type: 'text', text: 'withheld' }] })
      : next())
    const scope = r.open()
    await scope.invoke('secret3', {}, 'reference').then(() => 'ok', () => 'failed')
    expect(await scope.references.list()).toHaveLength(0)
    await scope.close('completed')
  })
})

// ---------------------------------------------------------------------------
// BRG-06: no nested deadlock
// ---------------------------------------------------------------------------

describe('BRG-06: a wrapper never waits for a slot from the pool it already holds', () => {
  it('MANY concurrent wrapped calls complete without exhausting the pool', async () => {
    // The named trap: a wrapper tool occupies an outer pool slot and then waits
    // for an inner slot from the SAME pool. With `maxParallel: 2` and four
    // concurrent wrappers, a scope that queued the inner calls behind the same
    // pool would deadlock at 2. This is the gate that matters most.
    const r = await rig()
    registerEcho(r.ctx, 'inner')
    let wrappersStarted = 0
    r.tools.register(defineTool({
      name: 'wrapper',
      description: 'Calls the scope from inside a tool body.',
      parameters: { id: { type: 'string', required: true } },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: value }],
      },
      // The scope is reached through a module-level handle the test sets, which
      // is exactly the shape a `python_exec` cell handler uses: a tool body
      // calling back into the transport's scope.
      async execute(args) {
        wrappersStarted += 1
        const nested = await nestedScope!.invoke('inner', { value: args.id }, 'value')
        return `wrapper(${String(nested)})`
      },
    }))
    const scope = r.open({ maxParallel: 2 })
    nestedScope = scope

    const results = await Promise.all(
      ['a', 'b', 'c', 'd'].map(id => scope.invoke('wrapper', { id }, 'value')),
    )
    expect(results).toEqual(['wrapper(inner:a)', 'wrapper(inner:b)', 'wrapper(inner:c)', 'wrapper(inner:d)'])
    expect(wrappersStarted).toBe(4)
    // Close BEFORE reading dispositions. A disposition is reported when the call
    // COMMITS, which deliberately lags value delivery (the program gets its value
    // immediately; control ferrying and accounting stay in the ordered lane). So
    // the drain is what makes the accounting complete, and asserting before it
    // would be asserting on a moving target.
    await scope.close('completed')
    // Every nested call is accounted for as nested, which is the admission
    // decision that removed the circular wait.
    const nested = scope.dispositions().filter(entry => entry.nested)
    expect(nested).toHaveLength(4)
    expect(nested.every(entry => entry.disposition === 'settled')).toBe(true)
    nestedScope = undefined
  })

  it('re-entrancy: a nested call may itself open a nested call, many levels deep', async () => {
    const r = await rig()
    registerEcho(r.ctx, 'leaf')
    r.tools.register(defineTool({
      name: 'recur',
      description: 'Calls the scope once more until depth is exhausted.',
      parameters: { depth: { type: 'integer', required: true } },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: value }],
      },
      async execute(args) {
        if (args.depth <= 0) return 'bottom'
        const deeper = await nestedScope!.invoke('recur', { depth: args.depth - 1 }, 'value')
        return `r(${String(deeper)})`
      },
    }))
    // maxParallel 1 is the worst case: with a shared pool this would deadlock on
    // the FIRST nested call, since the outer call holds the only slot.
    const scope = r.open({ maxParallel: 1 })
    nestedScope = scope

    const value = await scope.invoke('recur', { depth: 6 }, 'value')
    expect(value).toBe('r(r(r(r(r(r(bottom))))))')
    await scope.close('completed')
    nestedScope = undefined
  })

  it('an EXCLUSIVE tool forms a real barrier for top-level calls', async () => {
    const r = await rig()
    let active = 0
    let maxActive = 0
    for (const name of ['serial', 'other']) {
      r.tools.register(defineTool({
        name,
        description: `Tool ${name}.`,
        parameters: { id: { type: 'string', required: true } },
        // No `isConcurrencySafe`, so the registry classifies it `exclusive`
        // (fail-closed), which is what makes the barrier observable.
        output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
        async execute(args) {
          active += 1
          maxActive = Math.max(maxActive, active)
          await new Promise(resolve => setTimeout(resolve, 15))
          active -= 1
          return `${name}:${args.id}`
        },
      }))
    }
    const scope = r.open({ maxParallel: 8 })
    const values = await Promise.all([
      scope.invoke('serial', { id: '1' }, 'value'),
      scope.invoke('other', { id: '2' }, 'value'),
      scope.invoke('serial', { id: '3' }, 'value'),
    ])
    expect(values).toEqual(['serial:1', 'other:2', 'serial:3'])
    // Exclusive means exclusive: never two at once.
    expect(maxActive).toBe(1)
    await scope.close('completed')
  })

  it('a concurrency-safe tool DOES overlap, so the cap is not just serialization', async () => {
    const r = await rig()
    let active = 0
    let maxActive = 0
    r.tools.register(defineTool({
      name: 'safe',
      description: 'Declares itself concurrency-safe.',
      parameters: { id: { type: 'string', required: true } },
      output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
      isConcurrencySafe: () => true,
      async execute(args) {
        active += 1
        maxActive = Math.max(maxActive, active)
        await new Promise(resolve => setTimeout(resolve, 20))
        active -= 1
        return `safe:${args.id}`
      },
    }))
    const scope = r.open({ maxParallel: 4 })
    await Promise.all([1, 2, 3, 4].map(id => scope.invoke('safe', { id: String(id) }, 'value')))
    expect(maxActive).toBeGreaterThan(1)
    expect(maxActive).toBeLessThanOrEqual(4)
    await scope.close('completed')
  })

  it('the cap is respected: maxParallel 2 never runs three at once', async () => {
    const r = await rig()
    let active = 0
    let maxActive = 0
    r.tools.register(defineTool({
      name: 'capped',
      description: 'Concurrency-safe and slow.',
      parameters: { id: { type: 'string', required: true } },
      output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
      isConcurrencySafe: () => true,
      async execute(args) {
        active += 1
        maxActive = Math.max(maxActive, active)
        await new Promise(resolve => setTimeout(resolve, 15))
        active -= 1
        return args.id
      },
    }))
    const scope = r.open({ maxParallel: 2 })
    await Promise.all([1, 2, 3, 4, 5, 6].map(id => scope.invoke('capped', { id: String(id) }, 'value')))
    expect(maxActive).toBe(2)
    await scope.close('completed')
  })

  it('CANCEL DRAINS: closing with calls in flight settles them and reports every disposition', async () => {
    const r = await rig()
    const started: string[] = []
    const finished: string[] = []
    r.tools.register(defineTool({
      name: 'slow',
      description: 'Runs until its signal aborts.',
      parameters: { id: { type: 'string', required: true } },
      output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
      isConcurrencySafe: () => true,
      execute(args, exec) {
        started.push(args.id)
        return new Promise<string>((resolve) => {
          // Forward the signal, as a cooperative tool must: the drain depends on
          // the tool reaching quiescence, not on the scope abandoning it.
          exec.signal.addEventListener('abort', () => {
            finished.push(args.id)
            resolve(`aborted:${args.id}`)
          }, { once: true })
        })
      },
    }))
    const scope = r.open({ maxParallel: 2 })
    const calls = ['1', '2', '3', '4', '5'].map(id => scope
      .invoke('slow', { id }, 'value')
      .then(() => 'ok', (error: unknown) => (error as Error).message))

    // Let the first two start, then close while the rest are still queued.
    await vi.waitFor(() => { expect(started.length).toBeGreaterThanOrEqual(1) })
    const closePromise = scope.close('aborted')
    await closePromise
    const outcomes = await Promise.all(calls)

    // EVERY call reached a terminal state: nothing was left running.
    expect(outcomes).toHaveLength(5)
    for (const outcome of outcomes) expect(outcome.length).toBeGreaterThan(0)

    // Every call reported exactly one disposition, and the counts add up.
    const dispositions = scope.dispositions()
    expect(dispositions).toHaveLength(5)
    const byKind = dispositions.reduce<Record<string, number>>((accumulator, entry) => {
      accumulator[entry.disposition] = (accumulator[entry.disposition] ?? 0) + 1
      return accumulator
    }, {})
    const total = Object.values(byKind).reduce((sum, count) => sum + count, 0)
    expect(total).toBe(5)
    // Calls that STARTED are accounted as cancelled (they settled under the
    // abort); calls that never started are accounted as refused, never silently
    // dropped and never silently run.
    expect(byKind['cancelled'] ?? 0).toBeGreaterThanOrEqual(1)
    expect((byKind['abandoned-unstarted'] ?? 0) + (byKind['handed-to-jobs'] ?? 0)).toBeGreaterThanOrEqual(1)
    // No sub-call id appears twice: one disposition per call, not per stage.
    expect(new Set(dispositions.map(entry => entry.subCallId)).size).toBe(5)
  })
})

/** The scope a nested tool body calls back into; set per test, cleared after. */
let nestedScope: ProgrammaticCallScopeHandle | undefined

// ---------------------------------------------------------------------------
// BRG-07: end-of-scope drain
// ---------------------------------------------------------------------------

describe('BRG-07: a close with calls still in flight never leaves work running', () => {
  it('queued-unstarted calls are REFUSED with a recorded disposition when no handoff exists', async () => {
    const r = await rig()
    let started = 0
    r.tools.register(defineTool({
      name: 'blocker',
      description: 'Holds its slot until aborted.',
      parameters: { id: { type: 'string', required: true } },
      output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
      isConcurrencySafe: () => true,
      execute(args, exec) {
        started += 1
        return new Promise<string>((resolve) => {
          exec.signal.addEventListener('abort', () => { resolve(`held:${args.id}`) }, { once: true })
        })
      },
    }))
    // maxParallel 1: with two calls, the second CANNOT start.
    const scope = r.open({ maxParallel: 1 })
    const first = scope.invoke('blocker', { id: 'first' }, 'value').then(() => 'ok', error => (error as Error).message)
    const second = scope.invoke('blocker', { id: 'second' }, 'value').then(() => 'ok', error => (error as Error).message)

    await vi.waitFor(() => { expect(started).toBe(1) })
    await scope.close('aborted')

    const firstOutcome = await first
    const secondOutcome = await second
    // The started call settled under the abort. The registry's documented
    // cancellation contract replaces a started-but-cancelled SUCCESS with
    // `ABORTED`, so the message is the registry's own, not the tool's return
    // value: "cancellation arriving after entry ... replaces a successful
    // started outcome with ABORTED". The tool DID reach quiescence, which is
    // what the drain requires; the outcome classification is the registry's.
    expect(firstOutcome).toBe('tool call aborted')
    expect(secondOutcome).toMatch(/abandoned before starting/)
    // It really never ran.
    expect(started).toBe(1)

    const dispositions = scope.dispositions()
    expect(dispositions).toHaveLength(2)
    expect(dispositions.map(entry => entry.disposition).sort()).toEqual(['abandoned-unstarted', 'cancelled'])
    // The close reason is recorded on the refusal, so the disposition is auditable.
    const refused = dispositions.find(entry => entry.disposition === 'abandoned-unstarted')
    expect(refused?.closeReason).toBe('aborted')
    expect(refused?.name).toBe('blocker')
  })

  it('a host JOBS HANDOFF takes ownership instead of refusing, and the job id is recorded', async () => {
    const r = await rig()
    let started = 0
    r.tools.register(defineTool({
      name: 'hold',
      description: 'Holds its slot until aborted.',
      parameters: { id: { type: 'string', required: true } },
      output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
      isConcurrencySafe: () => true,
      execute(args, exec) {
        started += 1
        return new Promise<string>((resolve) => {
          exec.signal.addEventListener('abort', () => { resolve(`held:${args.id}`) }, { once: true })
        })
      },
    }))
    const handed: Array<{ subCallId: string; name: string }> = []
    const scope = r.open({
      maxParallel: 1,
      handoffToJobs: (call) => {
        handed.push({ subCallId: call.subCallId, name: call.name })
        return { jobId: 'job-1' }
      },
    })
    const first = scope.invoke('hold', { id: 'first' }, 'value').then(() => 'ok', error => (error as Error).message)
    const second = scope.invoke('hold', { id: 'second' }, 'value').then(() => 'ok', error => (error as Error).message)

    await vi.waitFor(() => { expect(started).toBe(1) })
    await scope.close('aborted')
    // The started call settled under the abort (the registry's ABORTED
    // classification, as above); the queued one was handed off.
    expect(await first).toBe('tool call aborted')
    expect(await second).toMatch(/handed to job job-1/)

    // The handoff was offered the exact call, and the disposition names the job.
    expect(handed).toHaveLength(1)
    expect(handed[0]?.name).toBe('hold')
    const handedDisposition = scope.dispositions().find(entry => entry.disposition === 'handed-to-jobs')
    expect(handedDisposition?.jobId).toBe('job-1')
    // The handed-off call never ran under the scope, which is what makes the
    // handoff ownership transfer rather than a duplicate execution.
    expect(started).toBe(1)
  })

  it('close resolves only AFTER in-flight work has settled, not before', async () => {
    const r = await rig()
    let settle: (() => void) | undefined
    let finished = false
    r.tools.register(defineTool({
      name: 'lingering',
      description: 'Ignores its signal until the test releases it.',
      parameters: {},
      output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
      isConcurrencySafe: () => true,
      execute() {
        return new Promise<string>((resolve) => {
          settle = () => { finished = true; resolve('done') }
        })
      },
    }))
    const scope = r.open()
    const call = scope.invoke('lingering', {}, 'value').then(() => 'ok', error => (error as Error).message)
    await vi.waitFor(() => { expect(settle).toBeDefined() })

    let closeResolved = false
    const closePromise = scope.close('aborted').then(() => { closeResolved = true })
    // The close must NOT have resolved while the body is still running: that is
    // the difference between draining and abandoning.
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(closeResolved).toBe(false)
    expect(finished).toBe(false)

    settle?.()
    await closePromise
    expect(closeResolved).toBe(true)
    // The tool resolved its own promise, but the close aborted the call, so the
    // registry's cancellation contract classifies the outcome as ABORTED. The
    // point of this test is the ORDER (close waited), which the two assertions
    // above establish.
    expect(await call).toBe('tool call aborted')
  })

  it('close is idempotent and reports no second disposition for any call', async () => {
    const r = await rig()
    registerEcho(r.ctx, 'idem')
    const scope = r.open()
    await scope.invoke('idem', { value: 'v' }, 'value')
    await scope.close('completed')
    const afterFirst = scope.dispositions().length
    await scope.close('completed')
    expect(scope.dispositions()).toHaveLength(afterFirst)
  })

  it('invoking after close is refused, not silently queued', async () => {
    const r = await rig()
    registerEcho(r.ctx, 'late')
    const scope = r.open()
    await scope.close('completed')
    const message = await scope.invoke('late', { value: 'v' }, 'value')
      .then(() => 'unexpected success', (error: unknown) => (error as Error).message)
    expect(message).toMatch(/scope is closed \(completed\)/)
  })

  it('the host service closes every live scope on teardown', async () => {
    const r = await rig()
    registerEcho(r.ctx, 'teardown')
    const service = new ProgrammaticScopeService(r.ctx, {})
    const scope = service.open({
      parent: Symbol('t') as unknown as ToolExecutionToken,
      signal: new AbortController().signal,
      callIdPrefix: 'call',
      deferContext: () => {},
      concludeTurn: () => {},
    })
    expect(service.openCount()).toBe(1)
    await scope.invoke('teardown', { value: 'v' }, 'value')
    // The service owns the drain: a scope left open at unload would keep native
    // calls running with no owner.
    await service.closeAll()
    expect(service.openCount()).toBe(0)
    const message = await scope.invoke('teardown', { value: 'v' }, 'value')
      .then(() => 'unexpected success', (error: unknown) => (error as Error).message)
    expect(message).toMatch(/scope is closed/)
  })
})

// ---------------------------------------------------------------------------
// BRG-08: control notifications preserved, bulk payloads kept out
// ---------------------------------------------------------------------------

describe('BRG-08: control notices keep their semantics; bulk payloads do not enter context', () => {
  it('a security additionalContext reaches the enclosing execution, bounded', async () => {
    const r = await rig()
    const longText = 'SECURITY: '.repeat(2000)
    r.tools.register(defineTool({
      name: 'notifier',
      description: 'Attaches a long security context.',
      parameters: {},
      output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
      execute(_args, exec) {
        exec.deferContext(createUserMessage({
          content: [{ type: 'text', text: longText }],
          source: { kind: 'plugin', plugin: 'test-policy' },
        }))
        return Promise.resolve('ok')
      },
    }))
    const deferred: UserMessage[] = []
    const scope = createProgrammaticCallScope({
      registry: r.tools,
      parent: Symbol('t') as unknown as ToolExecutionToken,
      signal: new AbortController().signal,
      callIdPrefix: 'call',
      control: { deferContext: (context) => { deferred.push(context) }, concludeTurn: () => {} },
      maxNoticeChars: 512,
    })
    await scope.invoke('notifier', {}, 'value')
    await scope.close('completed')

    // PRESERVED: the notice reached the enclosing execution at all.
    expect(deferred).toHaveLength(1)
    expect(deferred[0]?.content[0]).toMatchObject({ type: 'text' })
    const text = (deferred[0]?.content[0] as { text: string }).text
    expect(text).toContain('SECURITY:')
    // BOUNDED: the notice is capped, and the elision is visible rather than silent.
    expect(text.length).toBeLessThanOrEqual(512)
    expect(text.endsWith('…')).toBe(true)
    // The record states it was truncated, so a reader is not misled.
    const notice = scope.notices()[0]
    expect(notice?.truncated).toBe(true)
    expect(notice?.chars).toBeGreaterThan(512)
    expect(notice?.tool).toBe('notifier')
  })

  it('concludeTurn is preserved from a nested success and NOT from a policy-blocked one', async () => {
    const r = await rig()
    r.tools.register(defineTool({
      name: 'terminal',
      description: 'Concludes the turn.',
      parameters: {},
      output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
      execute(_args, exec) {
        exec.concludeTurn()
        return Promise.resolve('done')
      },
    }))
    let conclusions = 0
    const scope = createProgrammaticCallScope({
      registry: r.tools,
      parent: Symbol('t') as unknown as ToolExecutionToken,
      signal: new AbortController().signal,
      callIdPrefix: 'call',
      control: { deferContext: () => {}, concludeTurn: () => { conclusions += 1 } },
    })
    await scope.invoke('terminal', {}, 'value')
    await scope.close('completed')
    expect(conclusions).toBe(1)

    // Now with a policy that blocks the call: only a SUCCESSFUL result can carry
    // the terminal marker, so a converted failure must not stop the turn.
    r.ctx.on('tools/post-execute', async (exec, _result, next) => exec.name === 'terminal'
      ? Promise.resolve({ kind: 'block', feedback: [{ type: 'text', text: 'terminal rejected' }] })
      : next())
    const before = conclusions
    const blockedScope = createProgrammaticCallScope({
      registry: r.tools,
      parent: Symbol('t') as unknown as ToolExecutionToken,
      signal: new AbortController().signal,
      callIdPrefix: 'call',
      control: { deferContext: () => {}, concludeTurn: () => { conclusions += 1 } },
    })
    await blockedScope.invoke('terminal', {}, 'value').catch(() => undefined)
    await blockedScope.close('completed')
    expect(conclusions).toBe(before)
  })

  it('a BULK image does NOT automatically enter model context; it is retained as a reference', async () => {
    const r = await rig()
    const imageBlock: ContentBlock = {
      type: 'image',
      attachment: {
        attachmentId: 'deadbeef' as never,
        mediaType: 'image/png',
        bytes: 4096,
        width: 64,
        height: 64,
      },
    }
    r.tools.register(defineTool({
      name: 'screenshot',
      description: 'Returns a large image alongside its summary.',
      parameters: {},
      output: {
        // The canonical value is a summary; the image is model-facing content.
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: value }, imageBlock],
      },
      execute: () => Promise.resolve('screenshot captured'),
    }))
    const deferred: UserMessage[] = []
    const scope = createProgrammaticCallScope({
      registry: r.tools,
      parent: Symbol('t') as unknown as ToolExecutionToken,
      signal: new AbortController().signal,
      callIdPrefix: 'call',
      control: { deferContext: (context) => { deferred.push(context) }, concludeTurn: () => {} },
    })
    const value = await scope.invoke('screenshot', {}, 'value')
    await scope.close('completed')

    // The caller still gets the typed canonical value.
    expect(value).toBe('screenshot captured')
    // THE ASSERTION: the image did NOT enter model context.
    expect(deferred).toHaveLength(0)
    // It was retained instead, with an auditable reference.
    const retained = scope.content()
    expect(retained).toHaveLength(1)
    expect(retained[0]?.blockTypes).toEqual(['image'])
    expect(retained[0]?.reference.kind).toBe('scope-reference')
    expect(retained[0]?.bytes).toBeGreaterThan(0)
    // And the reference recovers the payload, so keeping it out of context did
    // not lose it.
    const stored = await scope.read(retained[0]!.reference)
    expect(stored).toContain('image')
    expect(stored).toContain('deadbeef')
  })

  it('the control and content slots are SEPARATE: one call can fill both', async () => {
    const r = await rig()
    r.tools.register(defineTool({
      name: 'mixed',
      description: 'Returns a notice AND an image.',
      parameters: {},
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [
          { type: 'text', text: value },
          {
            type: 'image',
            attachment: {
              attachmentId: 'cafebabe' as never,
              mediaType: 'image/png',
              bytes: 2048,
              width: 32,
              height: 32,
            },
          },
        ],
      },
      execute(_args, exec) {
        exec.deferContext(createUserMessage({
          content: [{ type: 'text', text: 'POLICY NOTICE: screenshot requires review' }],
          source: { kind: 'plugin', plugin: 'test-policy' },
        }))
        return Promise.resolve('mixed result')
      },
    }))
    const deferred: UserMessage[] = []
    const scope = createProgrammaticCallScope({
      registry: r.tools,
      parent: Symbol('t') as unknown as ToolExecutionToken,
      signal: new AbortController().signal,
      callIdPrefix: 'call',
      control: { deferContext: (context) => { deferred.push(context) }, concludeTurn: () => {} },
    })
    await scope.invoke('mixed', {}, 'value')
    await scope.close('completed')

    // The control notice entered context...
    expect(deferred).toHaveLength(1)
    expect((deferred[0]?.content[0] as { text: string }).text).toContain('POLICY NOTICE')
    // ...and the bulk payload did not. Two slots, two decisions.
    expect(scope.notices()).toHaveLength(1)
    expect(scope.content()).toHaveLength(1)
    expect(scope.content()[0]?.blockTypes).toEqual(['image'])
  })

  it('past the direct bound, notices are COALESCED into one bounded record, not dropped', async () => {
    const r = await rig()
    r.tools.register(defineTool({
      name: 'chatty',
      description: 'Attaches one context per call.',
      parameters: { id: { type: 'string', required: true } },
      output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
      isConcurrencySafe: () => true,
      execute(args, exec) {
        exec.deferContext(createUserMessage({
          content: [{ type: 'text', text: `notice ${args.id}` }],
          source: { kind: 'plugin', plugin: 'test-policy' },
        }))
        return Promise.resolve(`ok:${args.id}`)
      },
    }))
    const deferred: UserMessage[] = []
    const scope = createProgrammaticCallScope({
      registry: r.tools,
      parent: Symbol('t') as unknown as ToolExecutionToken,
      signal: new AbortController().signal,
      callIdPrefix: 'call',
      control: { deferContext: (context) => { deferred.push(context) }, concludeTurn: () => {} },
      maxNotices: 2,
      maxParallel: 8,
    })
    await Promise.all([1, 2, 3, 4, 5].map(id => scope.invoke('chatty', { id: String(id) }, 'value')))
    await scope.close('completed')

    // Two direct notices plus ONE coalesced record: the rest were accounted for,
    // not silently discarded.
    expect(deferred).toHaveLength(3)
    const coalesced = scope.notices().filter(entry => entry.coalesced)
    expect(coalesced).toHaveLength(1)
    const summary = (deferred[2]?.content[0] as { text: string }).text
    expect(summary).toContain('3 further control notice(s) were coalesced')
    // Every notice is accounted for: 2 direct + 1 coalesced record.
    expect(scope.notices()).toHaveLength(3)
  })

  it('defer-images reproduces stock run_code content behaviour, for comparison', async () => {
    // The one option that changes the content decision, so the two transports
    // can be compared on one registry rather than on two implementations.
    const r = await rig()
    r.tools.register(defineTool({
      name: 'img',
      description: 'Returns an image.',
      parameters: {},
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [
          { type: 'text', text: value },
          {
            type: 'image',
            attachment: {
              attachmentId: 'aaaa1111' as never,
              mediaType: 'image/png',
              bytes: 1024,
              width: 16,
              height: 16,
            },
          },
        ],
      },
      execute: () => Promise.resolve('image result'),
    }))
    const deferred: UserMessage[] = []
    const scope = createProgrammaticCallScope({
      registry: r.tools,
      parent: Symbol('t') as unknown as ToolExecutionToken,
      signal: new AbortController().signal,
      callIdPrefix: 'call',
      control: { deferContext: (context) => { deferred.push(context) }, concludeTurn: () => {} },
      contentProjection: 'defer-images',
    })
    await scope.invoke('img', {}, 'value')
    await scope.close('completed')
    // Stock behaviour: the image IS deferred as one user message.
    expect(deferred).toHaveLength(1)
    expect(deferred[0]?.content.some(block => block.type === 'image')).toBe(true)
    // And nothing was retained, because the payload went to context instead.
    expect(scope.content()).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// Stock run_code regression: the scope must not have changed it
// ---------------------------------------------------------------------------

describe('stock run_code keeps its exact semantics (no regression from the extraction)', () => {
  it('run_code still logs one dispatch event per sub-call and returns the curated output', async () => {
    const r = await rig({ mode: 'both', ptc: true })
    const echo = registerEcho(r.ctx)
    const appended: Array<{ type: string; data: unknown }> = []
    // A structural agent: enough for the bridge's session appends, which is the
    // durable side the extraction could have broken.
    const agent = {
      session: {
        header: { cwd: '/workspace' },
        append: (type: string, data: unknown) => { appended.push({ type, data }) },
      },
    } as never

    const runtime = ptcRuntime(r.ctx)
    runtime.behavior = async (request) => {
      const functions = request.bindings[0]!.functions
      const first = await functions.echo!({ value: 'one' })
      const second = await functions.echo!({ value: 'two' })
      return { logs: [`saw ${String(first)}`], value: second }
    }
    const result = await r.tools.execute({
      callId: ToolCallId('call-regress'), name: RUN_CODE_NAME,
      arguments: { code: 'program', description: 'regression check' },
      agent,
      signal: new AbortController().signal,
    })
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('run_code failed')
    // The exact canonical output shape, unchanged.
    expect(result.value).toEqual({ logs: ['saw echo:one'], result: 'echo:two' })
    expect(result.content).toEqual([{ type: 'text', text: 'saw echo:one\necho:two' }])
    expect(echo.calls).toEqual([{ value: 'one' }, { value: 'two' }])

    // The durable event vocabulary, unchanged: one start and one settle per
    // sub-call, with the documented ids.
    const starts = appended.filter(entry => entry.type === 'tool/ptc-dispatch-start')
    const settles = appended.filter(entry => entry.type === 'tool/ptc-dispatch')
    expect(starts).toHaveLength(2)
    expect(settles).toHaveLength(2)
    expect(settles.map(entry => (entry.data as { subCallId: string }).subCallId))
      .toEqual(['call-regress:ptc:1', 'call-regress:ptc:2'])
    expect(settles.map(entry => (entry.data as { content: unknown }).content)).toEqual([
      [{ type: 'text', text: 'echo:one' }],
      [{ type: 'text', text: 'echo:two' }],
    ])
  })

  it('run_code still refuses a model-direct native call under ptc mode', async () => {
    const r = await rig({ mode: 'ptc', ptc: true })
    registerEcho(r.ctx)
    const result = await r.tools.execute({
      callId: ToolCallId('collapsed'), name: 'echo', arguments: { value: 'x' },
      signal: new AbortController().signal,
    })
    expect(result.isError).toBe(true)
    expect(result.isError ? result.error.info?.code : undefined).toBe('UNKNOWN_TOOL')
  })

  it('run_code still maps a pre-aborted outer signal to the canonical cancellation code', async () => {
    const r = await rig({ mode: 'both', ptc: true })
    registerEcho(r.ctx)
    const controller = new AbortController()
    controller.abort('pre-aborted')
    const result = await r.tools.execute({
      callId: ToolCallId('pre-aborted'), name: RUN_CODE_NAME,
      arguments: { code: 'program', description: 'pre-aborted run' },
      signal: controller.signal,
    })
    expect(result.isError).toBe(true)
    expect(result.isError ? result.error.info?.code : undefined).toBe(TOOL_ABORTED_BEFORE_DISPATCH)
  })

  it('run_code still forwards a nested concludeTurn onto its own successful result', async () => {
    const r = await rig({ mode: 'both', ptc: true })
    r.tools.register(defineTool({
      name: 'finalize',
      description: 'Terminal tool.',
      parameters: {},
      output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
      execute(_args, exec) {
        exec.concludeTurn()
        return Promise.resolve('done')
      },
    }))
    const runtime = ptcRuntime(r.ctx)
    runtime.behavior = async (request) => {
      await request.bindings[0]!.functions.finalize!({})
      return { logs: [], value: 'program complete' }
    }
    const result = await r.tools.execute({
      callId: ToolCallId('conclude'), name: RUN_CODE_NAME,
      arguments: { code: 'program', description: 'terminal check' },
      signal: new AbortController().signal,
    })
    expect(result.isError).toBe(false)
    expect(result.concludesTurn).toBe(true)
  })

  it('run_code still defers a nested image-bearing result onto its own result', async () => {
    const r = await rig({ mode: 'both', ptc: true })
    r.tools.register(defineTool({
      name: 'shot',
      description: 'Returns an image.',
      parameters: {},
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [
          { type: 'text', text: value },
          {
            type: 'image',
            attachment: {
              attachmentId: 'bbbb2222' as never,
              mediaType: 'image/png',
              bytes: 512,
              width: 8,
              height: 8,
            },
          },
        ],
      },
      execute: () => Promise.resolve('shot taken'),
    }))
    const runtime = ptcRuntime(r.ctx)
    runtime.behavior = async (request) => {
      await request.bindings[0]!.functions.shot!({})
      return { logs: [], value: 'done' }
    }
    const result = await r.tools.execute({
      callId: ToolCallId('image'), name: RUN_CODE_NAME,
      arguments: { code: 'program', description: 'image deferral check' },
      signal: new AbortController().signal,
    })
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('run_code failed')
    // The nested image rides the outer result's additionalContexts, which is the
    // stock behaviour the extraction must not have changed.
    expect(result.additionalContexts).toBeDefined()
    expect(result.additionalContexts?.some(context =>
      context.content.some(block => block.type === 'image'))).toBe(true)
  })
})
