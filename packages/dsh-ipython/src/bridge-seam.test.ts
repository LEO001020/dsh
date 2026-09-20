/**
 * T7 — WHICH SEAM DOES THE MODEL'S PYTHON USE TO REACH DSH TOOLS?
 *
 * THE CLAIM UNDER TEST. `packages/dsh-ipython/src/bridge.ts` and
 * `native-call.ts` describe a native-tool callback bridge: a cell calls
 * `await dsh.call('read', {...})`, the host translates that into exactly one
 * `ctx.tools.execute(...)` call, and the value comes back to the cell. The
 * hard constraint this file exists to falsify is
 *
 *     严禁把 `ctx.terminalController` 用作模型 Python 能力
 *     (it is FORBIDDEN to use ctx.terminalController as the model's Python capability)
 *
 * and the requirement is that the model's Python reaches DSH tools through the
 * NATIVE seam — `ctx.tools.execute` — with exactly ONE model loop.
 *
 * WHY THIS IS A MEASUREMENT AND NOT A READING. Every other test in this package
 * tests the kernel, the protocol, or the service. None of them drives a cell's
 * `dsh.call` into a real `ToolRuntime`. This file mounts the REAL registry
 * (`SystemPrompt` + `ToolRuntime`, the production composition), starts a REAL
 * ipykernel through the REAL broker, runs a REAL cell, and observes WHICH LAYER
 * received the call. The observation is made from the registry side — a
 * `tools/pre-execute` listener and a `tools/result` listener that record the
 * calls they actually saw — so the answer does not depend on anything the
 * bridge says about itself.
 *
 * THE INSTRUMENT IS NEGATIVE-CAPABLE. Three separate decoys are mounted:
 *   1. a `terminalController` service that records any access to it, so if the
 *      Python path ever reached for the forbidden seam the record would show it;
 *   2. a `tools/pre-execute` listener that records every call the registry
 *      pipeline saw, with the sub-call id, so a call that reached the registry
 *      is distinguishable from one that did not;
 *   3. a cell-side assertion that `dsh` in the kernel namespace carries no
 *      terminal/shell handle at all.
 * A test that can only pass is not a measurement, so each arm is also driven in
 * the failing direction where one exists.
 *
 * WHAT THIS FILE DOES NOT CLAIM. It does not claim the bridge is WIRED into the
 * shipped profile. It is not: `createNativeCallHandler` has no production
 * caller. That finding is the headline of
 * `qualification/results/T7-bridge/FINDINGS.md`, and this file is what makes
 * the difference between "the seam is correct" (measured here) and "the product
 * uses it" (measured false, there).
 */
import { Context } from '@deepseek-ai/cordis'
import Subprocess from '@deepseek-ai/dsh-subprocess-local'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool, type ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BridgeServer } from './bridge.ts'
import { createNativeCallHandler, type EnclosingAuthority } from './native-call.ts'
import { KernelService } from './kernel-plugin.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const BROKER = resolve(HERE, 'broker.py')
const PYTHON = process.env['DSH_PYTHON'] ?? 'C:/Users/hzq00/AppData/Local/Programs/Python/Python314/python.exe'

let ctx: Context
let root: string
let service: KernelService | undefined
let bridge: BridgeServer | undefined

beforeEach(async () => {
  ctx = new Context()
  await ctx.plugin(SystemPrompt, { personaPrefix: '' })
  await ctx.plugin(ToolRuntime, { mode: 'native', maxParallelSubCalls: 10 })
  await ctx.plugin(Subprocess)
  root = await mkdtemp(join(tmpdir(), 'dsh-ipython-bridge-'))
})

afterEach(async () => {
  if (bridge !== undefined) {
    await bridge.close().catch(() => undefined)
    bridge = undefined
  }
  if (service !== undefined) {
    await service.close().catch(() => undefined)
    service = undefined
  }
  await ctx.fiber.dispose()
  await rm(root, { recursive: true, force: true })
})

/**
 * The Agent stand-in. `KernelService` reads `agent.session.header.id` and
 * `agent.session.header.cwd`; the registry reads `exec.agent` only to key scope
 * layers, and this file registers nothing agent-scoped, so the global layer is
 * the one that resolves. A full Agent would require a model loop, which this
 * project forbids building a second of.
 */
function agentFor(sessionId: string, cwd: string): Agent {
  return { session: { header: { id: sessionId, cwd } } } as unknown as Agent
}

/** The authority `createNativeCallHandler` needs, as the enclosing call would mint it. */
function authorityFor(callId: string, agent: Agent, signal: AbortSignal): EnclosingAuthority {
  return {
    callId,
    rootCallId: callId,
    // Only the registry can mint a real token. This file never asserts anything
    // about the token's contents -- `parent` is exercised by the live path in
    // `native-call.ts`, and a fabricated symbol is enough for the scheduler.
    token: Symbol('probe-token') as unknown as EnclosingAuthority['token'],
    agent,
    signal,
  }
}

// ---------------------------------------------------------------------------
// The decoy: a terminalController that records every access.
// ---------------------------------------------------------------------------

/**
 * A recording stand-in for the FORBIDDEN seam.
 *
 * It is deliberately NOT a real terminal controller: this file's job is to
 * detect the seam being used, and a real one would start processes. Every
 * METHOD call is recorded, so a single `ctx.terminalController.<method>()` on
 * the Python path would leave a trace here even if the result were discarded.
 *
 * WHAT IS DELIBERATELY NOT RECORDED, and why the control below calls a method
 * rather than reading a field: the recorder excludes `accesses` itself, because
 * reading the log must not write to it. A test that "proved the detector works"
 * by reading `.accesses` would prove nothing at all -- it would observe the one
 * property the trap ignores. This was measured: the first version of this test
 * did exactly that and failed with `expected 0 to be greater than 0`, which is
 * the detector correctly declining to log its own read.
 */
class TerminalControllerDecoy {
  readonly accesses: string[] = []

  /** A real method, so the control has something to call that IS recorded. */
  list(): string[] {
    return []
  }

  constructor() {
    return new Proxy(this, {
      get: (target, property, receiver) => {
        if (typeof property === 'string' && !property.startsWith('_') && property !== 'accesses') {
          target.accesses.push(property)
        }
        return Reflect.get(target, property, receiver) as unknown
      },
    })
  }
}

// ---------------------------------------------------------------------------
// 1. THE SEAM: a real cell's dsh.call reaches ctx.tools.execute
// ---------------------------------------------------------------------------

describe('T7-01 the model Python path reaches ctx.tools.execute (MEASURED)', () => {
  it('a cell calling dsh.call lands in the real ToolRuntime pipeline, and the value comes back', async () => {
    // ---- the registry-side instrument -------------------------------------
    // Records every call the REAL pipeline saw, before any dispatch. This is
    // the layer the claim names, so this is the layer that has to observe it.
    const seenByPipeline: Array<{ name: string, callId: string, parent: boolean }> = []
    ctx.on('tools/pre-execute', (exec, next) => {
      seenByPipeline.push({
        name: exec.name,
        callId: String(exec.callId),
        parent: exec.parent !== undefined,
      })
      return next()
    })

    // A real tool with a real canonical value, so the value that reaches Python
    // is the registry's own materialized `value`, not a bridge-invented object.
    const ECHO_MARKER = 'registry-materialized-value'
    ctx.tools.register(defineTool({
      name: 'probe_echo',
      description: 'Returns a fixed marker object, to prove the value crosses back into the cell.',
      parameters: {
        tag: { type: 'string', required: true, description: 'echoed back' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            marker: { type: 'string', required: true },
            tag: { type: 'string', required: true },
          },
        },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      execute: async args => {
        const tag = (args as { tag: string }).tag
        return { marker: ECHO_MARKER, tag }
      },
    }))

    // ---- the bridge, mounted by hand --------------------------------------
    // NOTE, and it is the point of the whole file: this is the ONLY way the
    // bridge runs. `createNativeCallHandler` has no production caller (see
    // FINDINGS.md, T7-05). What is measured here is that the seam is correct.
    const b = new BridgeServer({ artifactDirectory: join(root, 'artifacts') })
    bridge = b
    const startup = await b.start()

    const agent = agentFor('session-seam', root)
    service = new KernelService(ctx, {
      pythonExecutable: PYTHON,
      brokerScript: BROKER,
      root: join(root, 'kernels'),
    })

    // ---- run a REAL cell whose dsh.call must reach the registry -----------
    // The preamble and the lease are minted exactly as the (unwired) host path
    // would mint them, and the cell body is ordinary model Python.
    const cellId = 'cell-seam-1'
    const epoch = 1
    const lease = b.mintLease({
      sessionId: 'session-seam',
      cellId,
      epoch,
      handler: createNativeCallHandler({
        ctx,
        authority: authorityFor('ipython-call-1', agent, new AbortController().signal),
        bridge: b,
      }),
    })
    expect(lease.live).toBe(true)

    const code = [
      b.preamble(lease),
      'import json',
      "value = await dsh.call('probe_echo', {'tag': 'from-the-cell'})",
      "print('CELL_SAW:' + json.dumps(value, sort_keys=True, separators=(',', ':')))",
      "print('MODULE:' + dsh.__name__)",
    ].join('\n')

    const result = await service.runCell(agent, code)
    // The lease handler runs inside the cell, so the outcome is observed by the
    // registry listener above; `outcome` stays undefined unless a direct call
    // was made. Read the cell's own report instead.
    expect(result.outcome).toBe('ok')
    const stdout = result.stdout.text

    // ---- THE MEASUREMENT --------------------------------------------------
    // (a) the registry pipeline saw the call, named as the cell named it.
    expect(seenByPipeline.map(entry => entry.name)).toEqual(['probe_echo'])
    // (b) it arrived as a SUB-DISPATCH: the bridge stamped `parent`, which is
    //     what `native-call.ts` exists to do and what a model-direct call lacks.
    expect(seenByPipeline[0]?.parent).toBe(true)
    // (c) the sub-call id is derived from the ENCLOSING ipython call id, so the
    //     nested call is correlatable to the execution that authorised it.
    expect(seenByPipeline[0]?.callId).toBe('ipython-call-1:bridge:1')
    // (d) the registry's OWN canonical value reached the cell, byte-for-byte.
    expect(stdout).toContain(`CELL_SAW:{"marker":"${ECHO_MARKER}","tag":"from-the-cell"}`)
    // (e) the module the cell reached is the host-written client, not something
    //     the cell could have fabricated into existence.
    expect(stdout).toContain('MODULE:dsh')

    await lease.revoke('the cell settled')
    b.releaseLease(lease)
  }, 240_000)

  it('the bridge is the ONLY caller: the same cell with no lease gets no tool', async () => {
    // THE FAILING DIRECTION. A cell whose preamble is absent has no `dsh` at
    // all, so it cannot reach a tool. If the assertion below passed, the tool
    // would be reachable through something other than the bridge -- which is
    // exactly the second-seam failure this gate exists to catch.
    const b = new BridgeServer({ artifactDirectory: join(root, 'artifacts-none') })
    bridge = b
    await b.start()

    const agent = agentFor('session-no-lease', root)
    service = new KernelService(ctx, {
      pythonExecutable: PYTHON,
      brokerScript: BROKER,
      root: join(root, 'kernels-none'),
    })

    const result = await service.runCell(agent, [
      'import sys',
      "print('HAS_DSH:' + str('dsh' in dir()))",
      "print('HAS_TERMINAL:' + str(any(n in dir() for n in ('terminal', 'terminalController', 'shell'))))",
    ].join('\n'))

    expect(result.outcome).toBe('ok')
    // The namespace the model's code sees carries no bridge and no terminal.
    expect(result.stdout.text).toContain('HAS_DSH:False')
    expect(result.stdout.text).toContain('HAS_TERMINAL:False')
  }, 240_000)
})

// ---------------------------------------------------------------------------
// 2. THE FORBIDDEN SEAM: does ctx.terminalController appear on the Python path?
// ---------------------------------------------------------------------------

describe('T7-02 ctx.terminalController is NOT on the model Python path (MEASURED)', () => {
  it('a mounted terminalController is never touched while a cell calls a tool', async () => {
    // The decoy is mounted as `ctx.terminalController`, which is the name the
    // constraint forbids. If any code on the Python path resolved it, the
    // proxy would record the property read. The instrument is NEGATIVE-CAPABLE:
    // the control below reads the decoy directly and shows the recorder works,
    // so an empty record is a measurement rather than a dead detector.
    const decoy = new TerminalControllerDecoy()
    ctx.provide('terminalController', decoy)
    const seen: string[] = []
    ctx.on('tools/pre-execute', (exec, next) => {
      seen.push(exec.name)
      return next()
    })
    ctx.tools.register(defineTool({
      name: 'probe_ping',
      description: 'Returns pong.',
      parameters: {},
      output: {
        schema: { type: 'object', additionalProperties: false, properties: { pong: { type: 'boolean', required: true } } },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      execute: async () => ({ pong: true }),
    }))

    // CONTROL: the detector is alive. Without this, an empty `accesses` could
    // mean "never touched" or "never recorded", and the two are not the same.
    // The control calls a METHOD, because the recorder ignores its own log
    // property -- see the class docstring.
    const viaCtx = ctx.get('terminalController') as TerminalControllerDecoy | undefined
    expect(viaCtx).toBeDefined()
    viaCtx?.list()
    expect(decoy.accesses).toEqual(['list'])
    decoy.accesses.length = 0

    const b = new BridgeServer({ artifactDirectory: join(root, 'artifacts-tc') })
    bridge = b
    await b.start()
    const agent = agentFor('session-tc', root)
    service = new KernelService(ctx, {
      pythonExecutable: PYTHON,
      brokerScript: BROKER,
      root: join(root, 'kernels-tc'),
    })
    const lease = b.mintLease({
      sessionId: 'session-tc',
      cellId: 'cell-tc-1',
      epoch: 1,
      handler: createNativeCallHandler({
        ctx,
        authority: authorityFor('ipython-call-tc', agent, new AbortController().signal),
        bridge: b,
      }),
    })

    const result = await service.runCell(agent, [
      b.preamble(lease),
      "value = await dsh.call('probe_ping', {})",
      "print('PING:' + str(value))",
    ].join('\n'))

    expect(result.outcome).toBe('ok')
    expect(result.stdout.text).toContain("PING:{'pong': True}")
    // The call reached the native registry ...
    expect(seen).toEqual(['probe_ping'])
    // ... and the FORBIDDEN seam was never read, not even once.
    expect(decoy.accesses).toEqual([])

    await lease.revoke('the cell settled')
    b.releaseLease(lease)
  }, 240_000)
})

// ---------------------------------------------------------------------------
// 3. ONE MODEL LOOP: the bridge dispatches, it does not loop
// ---------------------------------------------------------------------------

describe('T7-03 exactly one model loop (MEASURED)', () => {
  it('N nested calls produce N dispatches and N results, with no turn taken by the bridge', async () => {
    // A second model loop would show up as the bridge calling something
    // turn-shaped: an extra dispatch, a session append, a conclusion. The
    // instrument counts dispatches against cell-side calls, so a bridge that
    // ran a loop would produce a mismatch, not a pass.
    const dispatches: string[] = []
    const results: string[] = []
    ctx.on('tools/pre-execute', (exec, next) => {
      dispatches.push(String(exec.callId))
      return next()
    })
    ctx.on('tools/result', (exec) => {
      results.push(String(exec.callId))
    })
    ctx.tools.register(defineTool({
      name: 'probe_count',
      description: 'Returns its own input, so the call count is observable from both sides.',
      parameters: { n: { type: 'integer', required: true, description: 'the value to echo' } },
      output: {
        schema: { type: 'object', additionalProperties: false, properties: { n: { type: 'integer', required: true } } },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      execute: async args => ({ n: (args as { n: number }).n }),
    }))

    const b = new BridgeServer({ artifactDirectory: join(root, 'artifacts-loop') })
    bridge = b
    await b.start()
    const agent = agentFor('session-loop', root)
    service = new KernelService(ctx, {
      pythonExecutable: PYTHON,
      brokerScript: BROKER,
      root: join(root, 'kernels-loop'),
    })
    const lease = b.mintLease({
      sessionId: 'session-loop',
      cellId: 'cell-loop-1',
      epoch: 1,
      handler: createNativeCallHandler({
        ctx,
        authority: authorityFor('ipython-call-loop', agent, new AbortController().signal),
        bridge: b,
      }),
    })

    const result = await service.runCell(agent, [
      b.preamble(lease),
      'total = 0',
      'for i in range(3):',
      "    v = await dsh.call('probe_count', {'n': i})",
      '    total += v["n"]',
      "print('TOTAL:' + str(total))",
    ].join('\n'))

    expect(result.outcome).toBe('ok')
    expect(result.stdout.text).toContain('TOTAL:3')
    // Three cell-side calls, three pipeline dispatches, three results. A bridge
    // that re-ran anything, or a second loop that mirrored the call, would show
    // here as a count that is not 3.
    expect(dispatches).toHaveLength(3)
    expect(results).toHaveLength(3)
    // And the sub-call ids are the bridge's own ordinal, derived from the ONE
    // enclosing call id: a second loop would mint a second enclosing id.
    expect(dispatches).toEqual([
      'ipython-call-loop:bridge:1',
      'ipython-call-loop:bridge:2',
      'ipython-call-loop:bridge:3',
    ])

    await lease.revoke('the cell settled')
    b.releaseLease(lease)
  }, 240_000)

  it('the bridge has NO turn-taking surface: no LLM client, no agent loop, no session append', async () => {
    // A "second model loop" would need a way to reach a model. The bridge's two
    // modules are the whole of the Python-tool path, so their import closure is
    // the place to look. This is a SOURCE fact, and it is labelled as one: it is
    // not a substitute for the runtime count above, it is the other half of the
    // argument. The test above runs the count; this pins the reason it can only
    // ever be one.
    const fs = await import('node:fs/promises')
    const combined = [
      await fs.readFile(new URL('./bridge.ts', import.meta.url), 'utf8'),
      await fs.readFile(new URL('./native-call.ts', import.meta.url), 'utf8'),
    ].join('\n')
    // `ToolCallId` is the ONE thing the bridge takes from dsh-llm, and it is a
    // branded string constructor -- an identity type, not a model client.
    const llmImports = [...combined.matchAll(/import\s+(?:type\s+)?\{([^}]+)\}\s+from\s+'@deepseek-ai\/dsh-llm'/g)]
      .flatMap(match => (match[1] ?? '').split(',').map(part => part.trim()).filter(Boolean))
    expect(llmImports).toEqual(['ToolCallId'])
    // No agent-loop import, no completion call, no session append: the three
    // ways a module could take a turn.
    expect(combined).not.toMatch(/from\s+'@deepseek-ai\/dsh-agent-loop'/)
    expect(combined).not.toMatch(/\.(chat|complete|completion|generate)\s*\(/)
    expect(combined).not.toMatch(/session\.(append|add|write)/)
    // And no second registry: the bridge composes over the ONE it is handed.
    expect(combined).not.toMatch(/new\s+ToolRuntime\s*\(/)
  })
})

// ---------------------------------------------------------------------------
// 4. THE NATIVE-CALL CONTRACT: error, denial, timeout, value
// ---------------------------------------------------------------------------

describe('T7-04 the native-call contract (MEASURED)', () => {
  it('a tool that throws reaches the cell as a structured BridgeError, not a crash', async () => {
    ctx.tools.register(defineTool({
      name: 'probe_throws',
      description: 'Always throws.',
      parameters: {},
      output: {
        schema: { type: 'object', additionalProperties: false, properties: { never: { type: 'boolean', required: true } } },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      execute: async () => { throw new Error('the tool body failed on purpose') },
    }))

    const b = new BridgeServer({ artifactDirectory: join(root, 'artifacts-err') })
    bridge = b
    await b.start()
    const agent = agentFor('session-err', root)
    service = new KernelService(ctx, { pythonExecutable: PYTHON, brokerScript: BROKER, root: join(root, 'kernels-err') })
    const lease = b.mintLease({
      sessionId: 'session-err',
      cellId: 'cell-err-1',
      epoch: 1,
      handler: createNativeCallHandler({
        ctx,
        authority: authorityFor('ipython-call-err', agent, new AbortController().signal),
        bridge: b,
      }),
    })

    const result = await service.runCell(agent, [
      b.preamble(lease),
      'from dsh import BridgeError',
      'try:',
      "    await dsh.call('probe_throws', {})",
      "    print('UNEXPECTED:no-error')",
      'except BridgeError as exc:',
      "    print('CODE:' + exc.code)",
      "    print('MESSAGE:' + exc.message)",
      "print('CELL_SURVIVED:True')",
    ].join('\n'))

    expect(result.outcome).toBe('ok')
    // The registry's fallback code for a tool's own throw: `TOOL_FAILED`.
    expect(result.stdout.text).toContain('CODE:TOOL_FAILED')
    expect(result.stdout.text).toContain('the tool body failed on purpose')
    // The cell kept running: a tool failure is a value, not a kernel fault.
    expect(result.stdout.text).toContain('CELL_SURVIVED:True')

    await lease.revoke('the cell settled')
    b.releaseLease(lease)
  }, 240_000)

  it('an UNKNOWN tool reaches the cell as UNKNOWN_TOOL', async () => {
    const b = new BridgeServer({ artifactDirectory: join(root, 'artifacts-unknown') })
    bridge = b
    await b.start()
    const agent = agentFor('session-unknown', root)
    service = new KernelService(ctx, { pythonExecutable: PYTHON, brokerScript: BROKER, root: join(root, 'kernels-unknown') })
    const lease = b.mintLease({
      sessionId: 'session-unknown',
      cellId: 'cell-unknown-1',
      epoch: 1,
      handler: createNativeCallHandler({
        ctx,
        authority: authorityFor('ipython-call-unknown', agent, new AbortController().signal),
        bridge: b,
      }),
    })

    const result = await service.runCell(agent, [
      b.preamble(lease),
      'from dsh import BridgeError',
      'try:',
      "    await dsh.call('probe_does_not_exist', {})",
      "    print('UNEXPECTED:no-error')",
      'except BridgeError as exc:',
      "    print('CODE:' + exc.code)",
    ].join('\n'))

    expect(result.outcome).toBe('ok')
    // The registry materializes an invisible tool as `UNKNOWN_TOOL`, and the
    // bridge passes the registry's OWN code through rather than flattening it.
    expect(result.stdout.text).toContain('CODE:UNKNOWN_TOOL')

    await lease.revoke('the cell settled')
    b.releaseLease(lease)
  }, 240_000)

  it('a tool DENIED by a monotonic guard reaches the cell as a structured refusal', async () => {
    ctx.tools.register(defineTool({
      name: 'probe_denied',
      description: 'Registered but guarded off.',
      parameters: {},
      output: {
        schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean', required: true } } },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      execute: async () => ({ ok: true }),
    }))
    // A REAL registry guard, which is the same seam an approval policy uses.
    // The denial is not simulated: the pipeline takes the deny branch.
    ctx.tools.guard(exec => exec.name === 'probe_denied' ? 'the probe tool is not permitted here' : undefined)

    const b = new BridgeServer({ artifactDirectory: join(root, 'artifacts-deny') })
    bridge = b
    await b.start()
    const agent = agentFor('session-deny', root)
    service = new KernelService(ctx, { pythonExecutable: PYTHON, brokerScript: BROKER, root: join(root, 'kernels-deny') })
    const lease = b.mintLease({
      sessionId: 'session-deny',
      cellId: 'cell-deny-1',
      epoch: 1,
      handler: createNativeCallHandler({
        ctx,
        authority: authorityFor('ipython-call-deny', agent, new AbortController().signal),
        bridge: b,
      }),
    })

    const result = await service.runCell(agent, [
      b.preamble(lease),
      'from dsh import BridgeError',
      'try:',
      "    await dsh.call('probe_denied', {})",
      "    print('UNEXPECTED:no-error')",
      'except BridgeError as exc:',
      "    print('CODE:' + exc.code)",
      "    print('MESSAGE:' + exc.message)",
    ].join('\n'))

    expect(result.outcome).toBe('ok')
    // The policy's OWN words arrive, so a denial reads as a denial rather than
    // as a transport failure. This is the property the bridge's `message` field
    // exists for.
    expect(result.stdout.text).toContain('the probe tool is not permitted here')
    // THE CODE IS MEASURED, NOT ASSUMED, and the measurement is narrower than a
    // reader would guess: a monotonic GUARD denies by returning a reason string
    // with no `info`, so `native-call.ts` falls back to `TOOL_FAILED`. The
    // registry only supplies a machine-readable code when the denying seam
    // attached one (`pre-execute`'s `info`). Both are asserted so the difference
    // cannot be quietly dropped: the refusal is structured and carries the
    // policy's message in both cases, and the CODE is only as specific as the
    // denying seam made it.
    expect(result.stdout.text).toContain('CODE:TOOL_FAILED')

    await lease.revoke('the cell settled')
    b.releaseLease(lease)
  }, 240_000)

  it('a pre-execute denial that supplies a code keeps it through the bridge', async () => {
    // The contrast arm for the test above. The registry's `info` field IS
    // preserved by the bridge when the denying seam set it, which is what makes
    // the bridge a pass-through rather than a re-classifier. Without this arm a
    // reader could conclude the bridge flattens every code to `TOOL_FAILED`,
    // which is a stronger and wrong claim.
    ctx.tools.register(defineTool({
      name: 'probe_denied_by_policy',
      description: 'Registered but denied by a pre-execute policy.',
      parameters: {},
      output: {
        schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean', required: true } } },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      execute: async () => ({ ok: true }),
    }))
    ctx.on('tools/pre-execute', (exec, next) => {
      if (exec.name === 'probe_denied_by_policy') {
        return Promise.resolve({
          kind: 'deny' as const,
          reason: 'denied by the pre-execute policy',
          info: { name: 'PolicyDenial', code: 'POLICY_DENIED' },
        })
      }
      return next()
    })

    const b = new BridgeServer({ artifactDirectory: join(root, 'artifacts-deny2') })
    bridge = b
    await b.start()
    const agent = agentFor('session-deny2', root)
    service = new KernelService(ctx, { pythonExecutable: PYTHON, brokerScript: BROKER, root: join(root, 'kernels-deny2') })
    const lease = b.mintLease({
      sessionId: 'session-deny2',
      cellId: 'cell-deny2-1',
      epoch: 1,
      handler: createNativeCallHandler({
        ctx,
        authority: authorityFor('ipython-call-deny2', agent, new AbortController().signal),
        bridge: b,
      }),
    })

    const result = await service.runCell(agent, [
      b.preamble(lease),
      'from dsh import BridgeError',
      'try:',
      "    await dsh.call('probe_denied_by_policy', {})",
      "    print('UNEXPECTED:no-error')",
      'except BridgeError as exc:',
      "    print('CODE:' + exc.code)",
      "    print('MESSAGE:' + exc.message)",
    ].join('\n'))

    expect(result.outcome).toBe('ok')
    // The registry's own code, preserved rather than replaced.
    expect(result.stdout.text).toContain('CODE:POLICY_DENIED')
    expect(result.stdout.text).toContain('denied by the pre-execute policy')

    await lease.revoke('the cell settled')
    b.releaseLease(lease)
  }, 240_000)

  it('a call that TIMES OUT fails in the cell with TIMEOUT, and the kernel stays usable', async () => {
    // The timeout is the CLIENT's, not the registry's: the bridge's own
    // `_DEFAULT_TIMEOUT` bounds how long Python waits for the host's reply. A
    // tool that sleeps past it must produce `TIMEOUT` in the cell, and the
    // kernel must remain usable afterwards -- a hung bridge would take the
    // whole execution surface with it.
    let hostSawCall = false
    ctx.tools.register(defineTool({
      name: 'probe_slow',
      description: 'Sleeps longer than the client timeout.',
      parameters: {},
      output: {
        schema: { type: 'object', additionalProperties: false, properties: { done: { type: 'boolean', required: true } } },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      execute: async () => {
        hostSawCall = true
        await new Promise(resolvePromise => setTimeout(resolvePromise, 4_000))
        return { done: true }
      },
    }))

    const b = new BridgeServer({ artifactDirectory: join(root, 'artifacts-slow') })
    bridge = b
    await b.start()
    const agent = agentFor('session-slow', root)
    service = new KernelService(ctx, { pythonExecutable: PYTHON, brokerScript: BROKER, root: join(root, 'kernels-slow') })
    const lease = b.mintLease({
      sessionId: 'session-slow',
      cellId: 'cell-slow-1',
      epoch: 1,
      handler: createNativeCallHandler({
        ctx,
        authority: authorityFor('ipython-call-slow', agent, new AbortController().signal),
        bridge: b,
      }),
    })

    const result = await service.runCell(agent, [
      b.preamble(lease),
      'from dsh import BridgeError',
      'try:',
      "    await dsh.call('probe_slow', {}, timeout=1.0)",
      "    print('UNEXPECTED:no-error')",
      'except BridgeError as exc:',
      "    print('CODE:' + exc.code)",
      "print('CELL_SURVIVED_TIMEOUT:True')",
      // And the same kernel is still usable: the timeout did not wedge it.
      'import math',
      "print('KERNEL_STILL_USABLE:' + str(math.sqrt(16)))",
    ].join('\n'))

    expect(result.outcome).toBe('ok')
    expect(result.stdout.text).toContain('CODE:TIMEOUT')
    expect(result.stdout.text).toContain('CELL_SURVIVED_TIMEOUT:True')
    expect(result.stdout.text).toContain('KERNEL_STILL_USABLE:4.0')
    // The host DID receive the call; the timeout is the client giving up on a
    // reply, not the call never being made. Stated because the two are
    // different facts and only one of them is a bridge defect.
    expect(hostSawCall).toBe(true)

    await lease.revoke('the cell settled')
    b.releaseLease(lease)
  }, 240_000)

  it('a value too large to inline comes back as an Artifact whose bytes verify', async () => {
    // The second delivery door. The host writes the canonical bytes ONCE, from
    // the same execution that produced them, and Python reads them back. This
    // is what keeps a bounded model projection and a lossless data plane from
    // contradicting each other.
    const PAYLOAD = 'x'.repeat(2 * 1024 * 1024)
    ctx.tools.register(defineTool({
      name: 'probe_big',
      description: 'Returns a value larger than the inline bound.',
      parameters: {},
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: { blob: { type: 'string', required: true } },
        },
        render: (_args, value) => [{ type: 'text', text: `<${String((value as { blob: string }).blob.length)} chars>` }],
      },
      execute: async () => ({ blob: PAYLOAD }),
    }))

    // A 4 KiB inline bound, so the artifact door is reached without a 1 MiB
    // allocation crossing the wire.
    const b = new BridgeServer({
      artifactDirectory: join(root, 'artifacts-big'),
      inlineValueBytes: 4096,
    })
    bridge = b
    await b.start()
    const agent = agentFor('session-big', root)
    service = new KernelService(ctx, { pythonExecutable: PYTHON, brokerScript: BROKER, root: join(root, 'kernels-big') })
    const lease = b.mintLease({
      sessionId: 'session-big',
      cellId: 'cell-big-1',
      epoch: 1,
      handler: createNativeCallHandler({
        ctx,
        authority: authorityFor('ipython-call-big', agent, new AbortController().signal),
        bridge: b,
      }),
    })

    const result = await service.runCell(agent, [
      b.preamble(lease),
      "value = await dsh.call('probe_big', {})",
      "print('TYPE:' + type(value).__name__)",
      "print('VERIFY:' + str(value.verify()))",
      "print('LEN:' + str(len(value.json()['blob'])))",
      "print('HASH_OK:' + str(value.sha256 == __import__('hashlib').sha256(value.load()).hexdigest()))",
    ].join('\n'))

    expect(result.outcome).toBe('ok')
    expect(result.stdout.text).toContain('TYPE:Artifact')
    // The digest the host reported matches the bytes on disk, and the decoded
    // value is the tool's own payload -- so this is not a re-run and not a
    // truncation.
    expect(result.stdout.text).toContain('VERIFY:True')
    expect(result.stdout.text).toContain('HASH_OK:True')
    expect(result.stdout.text).toContain(`LEN:${String(PAYLOAD.length)}`)

    await lease.revoke('the cell settled')
    b.releaseLease(lease)
  }, 240_000)
})

// ---------------------------------------------------------------------------
// 5. THE AUTHORITY RULE: a program cannot name its own authority
// ---------------------------------------------------------------------------

describe('T7-05 forged authority is refused, not ignored (MEASURED)', () => {
  /**
   * Send frames over a REAL socket and collect the host's replies.
   *
   * Hand-made frames are what a rewritten client, a hand-crafted peer, or a
   * cell that dug the token out of its own namespace would send. `dsh.call` has
   * no parameter for the authority fields, so the refusal can only be exercised
   * at the frame level -- through `dsh.call` it would be a claim about a code
   * path nothing reaches.
   */
  async function speak(
    port: number,
    token: string,
    frames: Array<Record<string, unknown>>,
    expectedReplies: number,
  ): Promise<Array<Record<string, unknown>>> {
    const net = await import('node:net')
    const encode = (value: unknown): Buffer => {
      const body = Buffer.from(JSON.stringify(value), 'utf8')
      const header = Buffer.alloc(4)
      header.writeUInt32BE(body.length, 0)
      return Buffer.concat([header, body])
    }
    const replies: Array<Record<string, unknown>> = []
    await new Promise<void>((resolvePromise, rejectPromise) => {
      let buffered = Buffer.alloc(0)
      const socket = net.createConnection({ host: '127.0.0.1', port }, () => {
        socket.write(encode({ type: 'hello', protocol: 1, token }))
        for (const frame of frames) socket.write(encode(frame))
      })
      socket.on('data', chunk => {
        buffered = Buffer.concat([buffered, chunk])
        for (;;) {
          if (buffered.length < 4) return
          const length = buffered.readUInt32BE(0)
          if (buffered.length < 4 + length) return
          replies.push(JSON.parse(buffered.subarray(4, 4 + length).toString('utf8')) as Record<string, unknown>)
          buffered = buffered.subarray(4 + length)
          if (replies.length >= expectedReplies) {
            socket.destroy()
            resolvePromise()
            return
          }
        }
      })
      socket.on('error', rejectPromise)
      socket.setTimeout(20_000, () => { socket.destroy(); rejectPromise(new Error(`the bridge answered ${String(replies.length)} of ${String(expectedReplies)} frames`)) })
    })
    return replies
  }

  it('a frame naming agent is refused FORGED_AUTHORITY and the tool is never dispatched', async () => {
    // The forgery check runs BEFORE any lease lookup, so a frame carrying an
    // authority field is refused on its own terms rather than being answered by
    // a lease that happened to be live. That ordering is the property; a check
    // that ran after the lookup would be reachable only by a live lease.
    const b = new BridgeServer({ artifactDirectory: join(root, 'artifacts-forge') })
    bridge = b
    const startup = await b.start()
    let handlerRan = false
    const lease = b.mintLease({
      sessionId: 'session-forge',
      cellId: 'cell-forge-1',
      epoch: 1,
      handler: async () => {
        handlerRan = true
        return { ok: true, value: { shouldNotBeReached: true } }
      },
    })
    // The token is a host secret handed to the kernel in the preamble. Reading
    // it back here is exactly the position a cell is in: it HOLDS the token, so
    // the token cannot be what stops it. What stops it is the host-side check
    // this test measures.
    const token = /_bind\(\d+, "([0-9a-f]+)"/.exec(b.preamble(lease))?.[1]
    expect(token).toBeDefined()

    const replies = await speak(startup.endpoint.port, token ?? '', [
      // The forged frame: a live lease id, a real cell id, a real epoch, and an
      // `agent` the program chose. Everything except the forged field is valid,
      // so a check that ignored unknown fields would serve it.
      {
        type: 'call',
        requestId: 'forge-1',
        tool: 'anything',
        arguments: {},
        leaseId: lease.id,
        cellId: lease.cellId,
        epoch: lease.epoch,
        agent: 'some-other-agent',
      },
    ], 2)

    expect(replies[0]?.['type']).toBe('hello_ack')
    const refusal = replies[1]?.['error'] as Record<string, unknown> | undefined
    expect(refusal?.['code']).toBe('FORGED_AUTHORITY')
    expect(String(refusal?.['message'])).toContain('agent')
    // THE NEGATIVE CONTROL: the refusal is real, not cosmetic. The handler was
    // never invoked, so nothing was dispatched under forged authority.
    expect(handlerRan).toBe(false)
  }, 120_000)

  it('the same frame WITHOUT the forged field IS served, so the refusal is targeted', async () => {
    // The positive control for the test above. Without it, a bridge that
    // refused every frame would pass the forgery check and the test would
    // report a security property that is really an outage.
    const b = new BridgeServer({ artifactDirectory: join(root, 'artifacts-forge-ok') })
    bridge = b
    const startup = await b.start()
    let handlerRan = false
    const lease = b.mintLease({
      sessionId: 'session-forge-ok',
      cellId: 'cell-forge-ok-1',
      epoch: 1,
      handler: async () => {
        handlerRan = true
        return { ok: true, value: { reached: true } }
      },
    })
    const token = /_bind\(\d+, "([0-9a-f]+)"/.exec(b.preamble(lease))?.[1]

    const replies = await speak(startup.endpoint.port, token ?? '', [
      {
        type: 'call',
        requestId: 'clean-1',
        tool: 'anything',
        arguments: {},
        leaseId: lease.id,
        cellId: lease.cellId,
        epoch: lease.epoch,
      },
    ], 2)

    expect(replies[0]?.['type']).toBe('hello_ack')
    expect(replies[1]?.['ok']).toBe(true)
    expect(replies[1]?.['value']).toEqual({ reached: true })
    expect(handlerRan).toBe(true)
  }, 120_000)
})

// ---------------------------------------------------------------------------
// 7. THE WIRING: does the PRODUCT use the bridge? (the answer is NO)
// ---------------------------------------------------------------------------

describe('T7-07 the bridge is UNWIRED from the product (MEASURED — this is a FAIL)', () => {
  /**
   * WHY THESE ASSERT THE ABSENCE RATHER THAN FAILING ON IT.
   *
   * The verdict of this gate is FAIL, and it is reported as FAIL in
   * `qualification/results/T7-bridge/FINDINGS.md`. The tests below assert the
   * absence so that the absence is PINNED: the day someone wires the bridge,
   * these turn red, and the gate table's FAIL has to be revisited rather than
   * left to rot. A test that simply failed here would be indistinguishable from
   * a broken instrument, and the next reader could not tell "the defect is still
   * present" from "the probe stopped working".
   *
   * The distinction this gate exists to draw is the one the audit names: a
   * working mechanism must not stand in for a wired product.
   */
  it('the package entry points do not reach bridge.ts or native-call.ts', async () => {
    // QUESTION 2, and it is a different question from every test above. Those
    // measure whether the MECHANISM is correct; this measures whether anything
    // in the product constructs one. A green mechanism must not stand in for a
    // wired product -- that substitution is the weaker-oracle mistake this
    // project's audit exists to catch.
    //
    // The measurement walks the REAL import closure from the package's own
    // `exports` roots, resolving relative specifiers as written on disk. It is
    // done here, in the package under test, rather than by reading a report, so
    // the result moves with the code.
    const fs = await import('node:fs/promises')
    const path = await import('node:path')
    const dir = path.dirname(fileURLToPath(import.meta.url))
    const pkg = JSON.parse(await fs.readFile(path.join(dir, '..', 'package.json'), 'utf8')) as {
      exports: Record<string, string | { default: string }>
    }

    // Entry roots, from the manifest rather than a hand-written list: a root
    // that is not declared cannot be loaded by a profile, so a module reached
    // only from an undeclared file is not reachable in the product either.
    // The `./package.json` export is a plain string and names no module, so the
    // two shapes are normalized here rather than assumed.
    const roots = Object.values(pkg.exports)
      .map(entry => typeof entry === 'string' ? entry : entry.default)
      .filter(value => value.endsWith('.js'))
      .map(value => value.replace(/^[.]\/lib\//, 'src/').replace(/[.]js$/, '.ts'))

    const seen = new Set<string>()
    const queue = [...roots]
    while (queue.length > 0) {
      const current = queue.pop()
      if (current === undefined || seen.has(current)) continue
      seen.add(current)
      let text: string
      try {
        text = await fs.readFile(path.join(dir, '..', current), 'utf8')
      } catch {
        continue
      }
      for (const match of text.matchAll(/from\s+'([^']+)'/g)) {
        const specifier = match[1] ?? ''
        if (!specifier.startsWith('.')) continue
        // Relative specifiers in this package are written with a `.ts`
        // extension (`allowImportingTsExtensions`), so they resolve directly.
        const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(current), specifier))
        queue.push(resolved)
      }
    }

    // THE MEASUREMENT: neither bridge module is in the closure of any entry.
    expect([...seen].some(file => file.endsWith('/bridge.ts'))).toBe(false)
    expect([...seen].some(file => file.endsWith('/native-call.ts'))).toBe(false)
    // And the closure is not empty, so the absence is not an artefact of the
    // walk failing to start.
    expect(seen.size).toBeGreaterThanOrEqual(5)
  })

  it('nothing outside this package names the bridge symbols', async () => {
    // The second half of the wiring question. Even a module that IS reachable
    // would be unwired if no composition ever constructs it, so the symbols are
    // searched for across the whole repository, with the entry-root closure
    // above as the other instrument.
    //
    // SCOPE, stated because it bounds the claim: this walks `packages/` and
    // `profiles/` to a capped depth, which is where a composition would live on
    // this deployment. It is not a proof about a file outside those trees.
    const fs = await import('node:fs/promises')
    const path = await import('node:path')
    const repo = path.resolve(fileURLToPath(import.meta.url), '..', '..', '..', '..')
    const searchRoots = [path.join(repo, 'packages'), path.join(repo, 'profiles')]
    const skip = new Set(['node_modules', 'lib', 'dist', '.git', '.ipython-kernels', '.probe'])

    const files: string[] = []
    const walk = async (dir: string, depth: number): Promise<void> => {
      if (depth > 6) return
      let entries
      try { entries = await fs.readdir(dir, { withFileTypes: true }) } catch { return }
      for (const entry of entries) {
        if (skip.has(entry.name)) continue
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) await walk(full, depth + 1)
        else if (/\.(ts|mjs|js|yml|yaml|json)$/.test(entry.name)) files.push(full)
      }
    }
    for (const searchRoot of searchRoots) await walk(searchRoot, 0)

    const isTest = (file: string): boolean => /\.test\.ts$/.test(file)
    // A PROBE is not a production caller, and the distinction is load-bearing
    // rather than convenient. `t7-measure.ts` drives the bridge to produce the
    // raw numbers in `qualification/results/T7-bridge/measurement.json`; it is
    // run by hand, is not in any entry point, and is not imported by anything.
    // Counting it as a caller would turn this arm red for a probe and hide the
    // fact it exists to report.
    //
    // AN EXPLICIT LIST, NOT A PATTERN, and this changed for a MEASURED reason.
    // The rule was `/[\\/]t\d+-measure\.ts$/`: narrow, but widening in the wrong
    // direction, because a later probe with a different name is classified as a
    // production caller. That is not hypothetical. V4's probe
    // (`v4-bridge-probe.ts`) made this arm fail with `new BridgeServer` at
    // `packages/dsh-ipython/src/v4-bridge-probe.ts` -- a hand-run driver with no
    // importer, not a wiring. The fix is NOT to loosen the pattern (that would
    // let a real caller through) and NOT to rename the probe to fit a detector
    // (that is making a detector quiet by moving the subject). It is to name
    // every probe exactly, so the exclusion set is auditable by reading it. A new
    // probe must be ADDED here, which is a deliberate act a reviewer sees.
    const PROBE_FILES = new Set([
      'packages/dsh-ipython/src/t7-measure.ts',
      'packages/dsh-ipython/src/v4-bridge-probe.ts',
    ])
    // `file` arrives ABSOLUTE (the walk joins from `repo`), so it is reduced to
    // the repo-relative form the set is keyed by. A first version compared the
    // absolute path against repo-relative keys, which matched nothing and made
    // this arm report BOTH probes as production callers -- caught by running it,
    // which is why the arm is exercised rather than reasoned about.
    const isProbe = (file: string): boolean =>
      PROBE_FILES.has(path.relative(repo, file).replace(/\\/g, '/'))
    const productionHits: Array<{ file: string, symbol: string }> = []
    for (const file of files) {
      if (isTest(file) || isProbe(file)) continue
      let text: string
      try { text = await fs.readFile(file, 'utf8') } catch { continue }
      for (const symbol of ['createNativeCallHandler', 'new BridgeServer', 'mintLease', 'renderBridgePreamble']) {
        if (text.includes(symbol)) {
          productionHits.push({ file: path.relative(repo, file).replace(/\\/g, '/'), symbol })
        }
      }
    }

    // THE MEASUREMENT. The expected hits are the two bridge modules naming
    // their own symbols; anything else would be a real caller. `new BridgeServer`
    // is expected to be ABSENT ENTIRELY: it is the constructor, so a hit would
    // mean a bridge is actually started somewhere.
    const starters = productionHits.filter(hit => hit.symbol === 'new BridgeServer')
    expect(starters).toEqual([])

    // And no composition file names the package's bridge path at all.
    const compositionHits = productionHits.filter(hit =>
      !hit.file.startsWith('packages/dsh-ipython/src/bridge.ts')
      && !hit.file.startsWith('packages/dsh-ipython/src/native-call.ts'))
    expect(compositionHits).toEqual([])
  }, 120_000)
})

// ---------------------------------------------------------------------------
// 8. THE HARD CONSTRAINT, stated as a negative: terminalController is absent
// ---------------------------------------------------------------------------

describe('T7-08 the forbidden seam is ABSENT from this package (MEASURED)', () => {
  it('no source file in the package names terminalController, and the composition never mounts one', async () => {
    // The constraint is 严禁把 `ctx.terminalController` 用作模型 Python 能力 --
    // it is FORBIDDEN to use ctx.terminalController as the model's Python
    // capability. The strongest honest form of that claim is a NEGATIVE: the
    // name does not appear, and no instance is ever mounted for a cell to
    // reach. Both halves are measured here rather than one being inferred from
    // the other.
    const fs = await import('node:fs/promises')
    const dir = new URL('./', import.meta.url)
    const entries = await fs.readdir(dir)
    const sources = entries.filter(name => name.endsWith('.ts') && !name.endsWith('.test.ts'))
    expect(sources.length).toBeGreaterThan(0)

    const offenders: string[] = []
    for (const name of sources) {
      const text = await fs.readFile(new URL(name, dir), 'utf8')
      // The `protocol.ts` frame field `cellId` and the bridge's own comments are
      // not a seam. The check is for the SERVICE NAME, which is what a capability
      // would have to be resolved through.
      if (/\bterminalController\b/.test(text)) offenders.push(name)
    }
    // Empty means the forbidden seam is named nowhere in the model's Python path.
    expect(offenders).toEqual([])

    // And the composition this package builds mounts none: `ctx.get` on a
    // never-provided name is `undefined`, which is the same negative check the
    // security gates in `dsh-daily-work` use.
    const ctxAfterMount = ctx
    expect(ctxAfterMount.get('terminalController' as never)).toBeUndefined()
  })

  it('the kernel namespace a cell sees carries no terminal handle either', async () => {
    // The JS side is only half the surface. The cell runs in a separate process
    // with its own namespace, so the absence has to hold THERE too: a cell that
    // could name a terminal handle would have the forbidden capability no matter
    // what the host composed.
    //
    // THE MEASUREMENT IS SCOPED TO MODULES THE HOST ADDED, and that scoping is
    // the whole point. A bare `'terminal' in module_name` check is worthless
    // here: MEASURED, a real IPython kernel has 16 such modules --
    // `IPython.terminal.*`, `IPython.utils.terminal`, `pygments.formatters.
    // terminal256` -- all of which are IPython's OWN console machinery and
    // predate this package entirely. A test asserting their absence would fail
    // on a healthy kernel and, if "fixed" by loosening the pattern, would stop
    // detecting anything. So what is measured is the host's contribution: the
    // modules loaded from the host-owned scratch directory, which is where the
    // bridge client is written. A DSH terminal seam would have to appear there,
    // and it does not.
    const b = new BridgeServer({ artifactDirectory: join(root, 'artifacts-tc2') })
    bridge = b
    await b.start()
    const agent = agentFor('session-tc2', root)
    service = new KernelService(ctx, { pythonExecutable: PYTHON, brokerScript: BROKER, root: join(root, 'kernels-tc2') })

    // The lease and preamble are minted as the host path would mint them, so the
    // cell really does hold the capability -- otherwise `dsh` would be absent for
    // the trivial reason that nothing injected it, and the measurement would be
    // about the wrong thing.
    const lease = b.mintLease({
      sessionId: 'session-tc2',
      cellId: 'cell-tc2-1',
      epoch: 1,
      handler: async () => ({ ok: true, value: { reached: true } }),
    })

    // The host's own directory, passed to the cell so the check is against a
    // real path rather than a guess.
    const hostDir = join(root, 'artifacts-tc2').replace(/\\/g, '/')
    const result = await service.runCell(agent, [
      b.preamble(lease),
      'import sys',
      `HOST_DIR = ${JSON.stringify(hostDir)}`,
      'def _under(mod):',
      "    f = getattr(mod, '__file__', None) or ''",
      "    return f.replace(chr(92), '/').startswith(HOST_DIR)",
      // Every loaded module whose file lies under the host's directory. This is
      // the host's contribution to the namespace, and the only place a DSH
      // terminal seam could hide.
      'host_modules = sorted(n for n, m in list(sys.modules.items()) if _under(m))',
      "print('HOST_MODULES:' + repr(host_modules))",
      // None of them is a terminal: the host injects the bridge client and
      // nothing else.
      "print('HOST_TERMINAL_MODULES:' + repr([m for m in host_modules if 'terminal' in m.lower()]))",
      // And the client's own public surface has no terminal affordance.
      'import dsh as _dsh',
      "print('CLIENT_SURFACE:' + repr(sorted(n for n in dir(_dsh) if not n.startswith('_'))))",
      "print('CLIENT_HAS_TERMINAL:' + str(any('terminal' in n.lower() for n in dir(_dsh))))",
      "print('CLIENT_HAS_SHELL:' + str(any(n.lower() in ('shell', 'terminal', 'spawn') for n in dir(_dsh))))",
    ].join('\n'))

    expect(result.outcome).toBe('ok')
    const stdout = result.stdout.text
    // The host added exactly the bridge client, from its own directory.
    expect(stdout).toContain("HOST_MODULES:['dsh']")
    // And nothing it added is a terminal.
    expect(stdout).toContain('HOST_TERMINAL_MODULES:[]')
    // The client's surface is the documented one and no wider. `call`,
    // `call_sync`, `tools`, `BridgeError`, `Artifact` -- a tool-call client.
    expect(stdout).toContain('CLIENT_HAS_TERMINAL:False')
    expect(stdout).toContain('CLIENT_HAS_SHELL:False')
    expect(stdout).toContain('CLIENT_SURFACE:[')
    expect(stdout).toContain("'call'")
    expect(stdout).toContain("'tools'")

    await lease.revoke('the cell settled')
    b.releaseLease(lease)
  }, 240_000)
})
