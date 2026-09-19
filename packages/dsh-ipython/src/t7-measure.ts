/**
 * T7 raw measurement: capture the exact values the seam claim rests on.
 *
 * The vitest file asserts; this records. It prints the observed values as JSON
 * so the FINDINGS can cite numbers rather than a green tick, and so a later
 * reader can re-run one command and compare.
 *
 * Every value below is read from a REAL ipykernel through the REAL broker,
 * mounted over the REAL ToolRuntime. Nothing here is simulated except the tools
 * themselves, which are probe tools registered for the measurement.
 */
import { Context } from '@deepseek-ai/cordis'
import Subprocess from '@deepseek-ai/dsh-subprocess-local'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { BridgeServer } from './bridge.ts'
import { createNativeCallHandler, type EnclosingAuthority } from './native-call.ts'
import { KernelService } from './kernel-plugin.ts'
import type { Agent } from '@deepseek-ai/dsh-agent'

const HERE = dirname(fileURLToPath(import.meta.url))
const BROKER = resolve(HERE, 'broker.py')
const PYTHON = process.env['DSH_PYTHON'] ?? 'C:/Users/hzq00/AppData/Local/Programs/Python/Python314/python.exe'

const observed: Record<string, unknown> = {}

function agentFor(sessionId: string, cwd: string): Agent {
  return { session: { header: { id: sessionId, cwd } } } as unknown as Agent
}
function authorityFor(callId: string, agent: Agent, signal: AbortSignal): EnclosingAuthority {
  return {
    callId,
    rootCallId: callId,
    token: Symbol('probe-token') as unknown as EnclosingAuthority['token'],
    agent,
    signal,
  }
}

async function main(): Promise<void> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt, { personaPrefix: '' })
  await ctx.plugin(ToolRuntime, { mode: 'native', maxParallelSubCalls: 10 })
  await ctx.plugin(Subprocess)
  const root = await mkdtemp(join(tmpdir(), 't7-measure-'))

  // The registry-side instrument: every call the REAL pipeline saw, with the
  // sub-dispatch marker and the id the bridge minted.
  const pipelineSaw: Array<Record<string, unknown>> = []
  const pipelineResults: string[] = []
  ctx.on('tools/pre-execute', (exec, next) => {
    pipelineSaw.push({
      name: exec.name,
      callId: String(exec.callId),
      rootCallId: String(exec.rootCallId),
      parentIsSet: exec.parent !== undefined,
      agentIsSet: exec.agent !== undefined,
      arguments: exec.arguments,
    })
    return next()
  })
  ctx.on('tools/result', (exec) => {
    pipelineResults.push(`${exec.name}:${String(exec.callId)}`)
  })

  ctx.tools.register(defineTool({
    name: 'probe_echo',
    description: 'Echoes its argument, to prove a value crosses back into the cell.',
    parameters: { tag: { type: 'string', required: true, description: 'echoed back' } },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { marker: { type: 'string', required: true }, tag: { type: 'string', required: true } },
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    execute: async args => ({ marker: 'registry-materialized-value', tag: (args as { tag: string }).tag }),
  }))
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
  ctx.tools.register(defineTool({
    name: 'probe_denied_by_guard',
    description: 'Registered but guarded off by a monotonic guard.',
    parameters: {},
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean', required: true } } },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    execute: async () => ({ ok: true }),
  }))
  // A MONOTONIC GUARD. The registry takes its deny branch with `info` UNSET for
  // this path, which is why the arm below reports `TOOL_FAILED` rather than a
  // denial code -- measured, not assumed.
  ctx.tools.guard(exec => exec.name === 'probe_denied_by_guard' ? 'the probe tool is not permitted here' : undefined)
  ctx.tools.register(defineTool({
    name: 'probe_denied_by_policy',
    description: 'Registered but denied by a pre-execute policy that supplies a code.',
    parameters: {},
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean', required: true } } },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    execute: async () => ({ ok: true }),
  }))
  // A PRE-EXECUTE LISTENER that denies WITH an `info.code`. The registry
  // preserves `info` on this path, so the code reaches Python. The two arms
  // together are what make the contract statement precise: the bridge passes
  // through whatever the registry produced, and the registry produces a code
  // for one denial seam and not the other.
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
  let slowCallReceived = false
  ctx.tools.register(defineTool({
    name: 'probe_slow',
    description: 'Sleeps past the client timeout.',
    parameters: {},
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { done: { type: 'boolean', required: true } } },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    execute: async () => {
      slowCallReceived = true
      await new Promise(r => setTimeout(r, 4_000))
      return { done: true }
    },
  }))
  const PAYLOAD = 'x'.repeat(2 * 1024 * 1024)
  ctx.tools.register(defineTool({
    name: 'probe_big',
    description: 'Returns a value larger than the inline bound.',
    parameters: {},
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { blob: { type: 'string', required: true } } },
      render: (_args, value) => [{ type: 'text', text: `<${String((value as { blob: string }).blob.length)} chars>` }],
    },
    execute: async () => ({ blob: PAYLOAD }),
  }))

  const bridge = new BridgeServer({ artifactDirectory: join(root, 'artifacts'), inlineValueBytes: 4096 })
  const startup = await bridge.start()
  observed['bridge'] = { boundPort: startup.endpoint.port, clientPath: startup.clientPath }

  const service = new KernelService(ctx, { pythonExecutable: PYTHON, brokerScript: BROKER, root: join(root, 'kernels') })
  const agent = agentFor('t7-measure', root)

  const leaseFor = (cellId: string, callId: string) => bridge.mintLease({
    sessionId: 't7-measure',
    cellId,
    epoch: 1,
    handler: createNativeCallHandler({
      ctx,
      authority: authorityFor(callId, agent, new AbortController().signal),
      bridge,
    }),
  })

  // ---- 1. the seam -------------------------------------------------------
  const lease1 = leaseFor('cell-1', 'ipython-call-1')
  const r1 = await service.runCell(agent, [
    bridge.preamble(lease1),
    'import json',
    "value = await dsh.call('probe_echo', {'tag': 'from-the-cell'})",
    "print('CELL_SAW:' + json.dumps(value, sort_keys=True, separators=(',', ':')))",
  ].join('\n'))
  observed['seam'] = {
    cellOutcome: r1.outcome,
    cellStdout: r1.stdout.text.trim(),
    pipelineSaw: pipelineSaw.splice(0, pipelineSaw.length),
    pipelineResults: pipelineResults.splice(0, pipelineResults.length),
  }
  await lease1.revoke('settled')
  bridge.releaseLease(lease1)

  // ---- 2. one model loop -------------------------------------------------
  const lease2 = leaseFor('cell-2', 'ipython-call-loop')
  const r2 = await service.runCell(agent, [
    bridge.preamble(lease2),
    'total = 0',
    'for i in range(3):',
    "    v = await dsh.call('probe_echo', {'tag': str(i)})",
    '    total += int(v["tag"])',
    "print('TOTAL:' + str(total))",
  ].join('\n'))
  observed['oneModelLoop'] = {
    cellOutcome: r2.outcome,
    cellStdout: r2.stdout.text.trim(),
    dispatches: pipelineSaw.splice(0, pipelineSaw.length).map(e => e['callId']),
    results: pipelineResults.splice(0, pipelineResults.length),
    dispatchCount: 3,
  }
  await lease2.revoke('settled')
  bridge.releaseLease(lease2)

  // ---- 3. the contract ---------------------------------------------------
  const contract: Record<string, unknown> = {}

  const lease3 = leaseFor('cell-3', 'ipython-call-err')
  const r3 = await service.runCell(agent, [
    bridge.preamble(lease3),
    'from dsh import BridgeError',
    'try:',
    "    await dsh.call('probe_throws', {})",
    "    print('UNEXPECTED:no-error')",
    'except BridgeError as exc:',
    "    print('CODE:' + exc.code)",
    "    print('MESSAGE:' + exc.message)",
    "print('CELL_SURVIVED:True')",
  ].join('\n'))
  contract['toolError'] = { outcome: r3.outcome, stdout: r3.stdout.text.trim() }
  await lease3.revoke('settled')
  bridge.releaseLease(lease3)

  const lease4 = leaseFor('cell-4', 'ipython-call-unknown')
  const r4 = await service.runCell(agent, [
    bridge.preamble(lease4),
    'from dsh import BridgeError',
    'try:',
    "    await dsh.call('probe_does_not_exist', {})",
    "    print('UNEXPECTED:no-error')",
    'except BridgeError as exc:',
    "    print('CODE:' + exc.code)",
  ].join('\n'))
  contract['unknownTool'] = { outcome: r4.outcome, stdout: r4.stdout.text.trim() }
  await lease4.revoke('settled')
  bridge.releaseLease(lease4)

  const lease5 = leaseFor('cell-5', 'ipython-call-deny')
  const r5 = await service.runCell(agent, [
    bridge.preamble(lease5),
    'from dsh import BridgeError',
    'try:',
    "    await dsh.call('probe_denied_by_guard', {})",
    "    print('UNEXPECTED:no-error')",
    'except BridgeError as exc:',
    "    print('CODE:' + exc.code)",
    "    print('MESSAGE:' + exc.message)",
  ].join('\n'))
  contract['guardDenial'] = {
    outcome: r5.outcome,
    stdout: r5.stdout.text.trim(),
    note: 'a monotonic guard denies without info, so the registry reports TOOL_FAILED',
  }
  await lease5.revoke('settled')
  bridge.releaseLease(lease5)

  const lease5b = leaseFor('cell-5b', 'ipython-call-deny-policy')
  const r5b = await service.runCell(agent, [
    bridge.preamble(lease5b),
    'from dsh import BridgeError',
    'try:',
    "    await dsh.call('probe_denied_by_policy', {})",
    "    print('UNEXPECTED:no-error')",
    'except BridgeError as exc:',
    "    print('CODE:' + exc.code)",
    "    print('MESSAGE:' + exc.message)",
  ].join('\n'))
  contract['policyDenialWithCode'] = {
    outcome: r5b.outcome,
    stdout: r5b.stdout.text.trim(),
    note: 'a pre-execute denial that supplies info.code keeps it through the bridge',
  }
  await lease5b.revoke('settled')
  bridge.releaseLease(lease5b)

  const lease6 = leaseFor('cell-6', 'ipython-call-slow')
  const r6 = await service.runCell(agent, [
    bridge.preamble(lease6),
    'from dsh import BridgeError',
    'try:',
    "    await dsh.call('probe_slow', {}, timeout=1.0)",
    "    print('UNEXPECTED:no-error')",
    'except BridgeError as exc:',
    "    print('CODE:' + exc.code)",
    "print('CELL_SURVIVED_TIMEOUT:True')",
    'import math',
    "print('KERNEL_STILL_USABLE:' + str(math.sqrt(16)))",
  ].join('\n'))
  contract['timeout'] = {
    outcome: r6.outcome,
    stdout: r6.stdout.text.trim(),
    hostReceivedTheCall: slowCallReceived,
  }
  await lease6.revoke('settled')
  bridge.releaseLease(lease6)

  const lease7 = leaseFor('cell-7', 'ipython-call-big')
  const r7 = await service.runCell(agent, [
    bridge.preamble(lease7),
    "value = await dsh.call('probe_big', {})",
    "print('TYPE:' + type(value).__name__)",
    "print('VERIFY:' + str(value.verify()))",
    "print('LEN:' + str(len(value.json()['blob'])))",
  ].join('\n'))
  contract['artifact'] = { outcome: r7.outcome, stdout: r7.stdout.text.trim(), payloadLength: PAYLOAD.length }
  await lease7.revoke('settled')
  bridge.releaseLease(lease7)

  observed['nativeCallContract'] = contract

  // ---- 4. what the cell's namespace actually holds -----------------------
  const lease8 = leaseFor('cell-8', 'ipython-call-surface')
  const hostDir = join(root, 'artifacts').replace(/\\/g, '/')
  const r8 = await service.runCell(agent, [
    bridge.preamble(lease8),
    'import sys',
    `HOST_DIR = ${JSON.stringify(hostDir)}`,
    'def _under(mod):',
    "    f = getattr(mod, '__file__', None) or ''",
    "    return f.replace(chr(92), '/').startswith(HOST_DIR)",
    'host_modules = sorted(n for n, m in list(sys.modules.items()) if _under(m))',
    "print('HOST_MODULES:' + repr(host_modules))",
    "print('HOST_TERMINAL_MODULES:' + repr([m for m in host_modules if 'terminal' in m.lower()]))",
    'import dsh as _dsh',
    "print('CLIENT_SURFACE:' + repr(sorted(n for n in dir(_dsh) if not n.startswith('_'))))",
    "print('CLIENT_HAS_TERMINAL:' + str(any('terminal' in n.lower() for n in dir(_dsh))))",
    // The terminal modules that DO exist, named so a reader can see they are
    // IPython's own machinery and not a DSH seam.
    "print('IPYTHON_TERMINAL_MODULES:' + repr(sorted(m for m in sys.modules if m.startswith('IPython.terminal') or m.startswith('IPython.utils.terminal'))))",
  ].join('\n'))
  observed['cellNamespace'] = { outcome: r8.outcome, stdout: r8.stdout.text.trim() }
  await lease8.revoke('settled')
  bridge.releaseLease(lease8)

  observed['environment'] = {
    python: PYTHON,
    broker: BROKER,
    toolchain: 'node /d/DSH/src/dsh-src/node_modules/vitest/vitest.mjs',
    dshToolsEntry: '@deepseek-ai/dsh-tools ToolRuntime.execute (packages/core/tools/src/index.ts:1348)',
  }

  await service.close()
  await bridge.close()
  await ctx.fiber.dispose()
  await rm(root, { recursive: true, force: true })

  process.stdout.write(JSON.stringify(observed, null, 2) + '\n')
}

main().catch(error => {
  process.stderr.write(String(error instanceof Error ? error.stack ?? error.message : error) + '\n')
  process.exitCode = 1
})
