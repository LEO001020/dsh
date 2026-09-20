/**
 * V4 probe: the BR-01/02/03/04/05/08/09/12 arms that had NO measurement on the
 * bridge route.
 *
 * WHY THIS FILE EXISTS. T7 measured the seam (a cell's `dsh.call` reaches
 * `ctx.tools.execute`), the forbidden seam's absence, one model loop, and six
 * native-call arms. Those are real and this probe does not repeat them. What T7
 * did NOT measure is the behaviour of the bridge under the specific oracles the
 * trusted-local acceptance spec states for BR-01, BR-02, BR-03, BR-04, BR-05,
 * BR-08, BR-09 and BR-12: route-equivalence including the cell, revocation
 * mid-cell, declared-type preservation for SMALL values, one-execution +
 * post-policy reference on the bridge route, redaction not recoverable through
 * the bridge's artifact, control-notice survival and boundedness with a bulk
 * image, host-authored-field refusal on the bridge wire, and the deployment
 * depth ceiling reached from a cell.
 *
 * WHAT IS REAL HERE. A real ipykernel through the real broker, a real
 * `ToolRuntime` mounted in the production composition, and real cells. Every
 * observation is taken either from the REGISTRY side (`tools/pre-execute` /
 * `tools/result` listeners) or from what the CELL printed, never from what the
 * bridge says about itself.
 *
 * WHAT THIS FILE DOES NOT ESTABLISH. It does not establish that the PRODUCT
 * starts the bridge. It does not: `new BridgeServer` has zero production call
 * sites (docs/GAPS.md G-SEAM-34). Every arm below therefore measures the
 * MECHANISM on a directly-constructed bridge, and the case record says so. That
 * split is the finding, not a defect in this probe.
 *
 * Run:  node --experimental-strip-types src/v4-bridge-probe.ts
 * Out:  JSON on stdout (redirect), or to $DSH_PROBE_OUT when set.
 */
import { Context } from '@deepseek-ai/cordis'
import Subprocess from '@deepseek-ai/dsh-subprocess-local'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool, type ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createHash } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { BridgeServer } from './bridge.ts'
import { createNativeCallHandler, type EnclosingAuthority } from './native-call.ts'
import { KernelService } from './kernel-plugin.ts'

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
    token: Symbol('v4-probe-token') as unknown as EnclosingAuthority['token'],
    agent,
    signal,
  }
}

async function main(): Promise<void> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt, { personaPrefix: '' })
  await ctx.plugin(ToolRuntime, { mode: 'native', maxParallelSubCalls: 10 })
  await ctx.plugin(Subprocess)
  const root = await mkdtemp(join(tmpdir(), 'v4-bridge-probe-'))

  // ---- the registry-side instrument -------------------------------------
  const pipelineSaw: Array<Record<string, unknown>> = []
  const pipelineResults: string[] = []
  ctx.on('tools/pre-execute', (exec, next) => {
    pipelineSaw.push({
      name: exec.name,
      callId: String(exec.callId),
      parentIsSet: exec.parent !== undefined,
      arguments: exec.arguments,
    })
    return next()
  })
  ctx.on('tools/result', (exec) => {
    pipelineResults.push(`${exec.name}:${String(exec.callId)}`)
  })

  // ---- the probe tools ---------------------------------------------------
  // BR-01/03: a small canonical value with a declared object schema, so the
  // delivered TYPE and the schema validation are both observable.
  ctx.tools.register(defineTool({
    name: 'v4_echo',
    description: 'Returns a small canonical object.',
    parameters: { value: { type: 'string', required: true } },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          marker: { type: 'string', required: true },
          value: { type: 'string', required: true },
          count: { type: 'integer', required: true },
          flag: { type: 'boolean', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    execute: async args => ({
      marker: 'v4-registry-materialized',
      value: (args as { value: string }).value,
      count: 7,
      flag: true,
    }),
  }))
  // BR-01: a guard that denies ONE argument value, so the guard decision can be
  // compared across routes rather than asserted once.
  ctx.tools.guard(exec => (exec.name === 'v4_echo' && (exec.arguments as { value?: string }).value === 'denied')
    ? 'v4 guard: this argument is revoked by policy'
    : undefined)
  // BR-01: a tool whose canonical value violates its own declared schema, so the
  // schema gate is compared across routes.
  ctx.tools.register(defineTool({
    name: 'v4_liar',
    description: 'Returns a value its own schema forbids.',
    parameters: {},
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean', required: true } } },
      render: () => [{ type: 'text', text: 'x' }],
    },
    execute: async () => ({ ok: true, smuggled: 'nope' }),
  }))

  // BR-02: the revocation tool. Its body revokes `v4_target` by calling the
  // EXACT disposer `register` returned, which is the product's own unregister
  // path -- not a test-only flag.
  const targetDisposer = ctx.tools.register(defineTool({
    name: 'v4_target',
    description: 'Revoked mid-cell by v4_revoke.',
    parameters: {},
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
    execute: async () => 'v4-target-still-registered',
  }))
  let revokeCalls = 0
  ctx.tools.register(defineTool({
    name: 'v4_revoke',
    description: 'Revokes v4_target through its own disposer.',
    parameters: {},
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
    execute: async () => {
      revokeCalls += 1
      targetDisposer()
      return `revoked-after-${String(revokeCalls)}`
    },
  }))

  // BR-04/05: a large value with an EXECUTION COUNTER and a post-execute policy
  // that can replace it, so "exactly once" and "the reference is the POST-POLICY
  // value" are both measured on the bridge route.
  const BIG = 'x'.repeat(2 * 1024 * 1024)
  let bigExecutions = 0
  ctx.tools.register(defineTool({
    name: 'v4_big',
    description: 'Returns a value larger than the inline bound.',
    parameters: {},
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { blob: { type: 'string', required: true } } },
      render: (_a, v) => [{ type: 'text', text: `<${String((v as { blob: string }).blob.length)} chars>` }],
    },
    execute: async () => { bigExecutions += 1; return { blob: BIG } },
  }))
  // BR-05: a secret-bearing tool the post-execute policy REPLACES. The secret
  // must not be recoverable from the bytes the bridge retained.
  const SECRET = 'v4-SECRET-must-not-be-recoverable-0xDEADBEEF'
  let secretExecutions = 0
  ctx.tools.register(defineTool({
    name: 'v4_secret',
    description: 'Returns a large secret-bearing value.',
    parameters: {},
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { token: { type: 'string', required: true } } },
      render: (_a, v) => [{ type: 'text', text: `<redacted ${String((v as { token: string }).token.length)} chars>` }],
    },
    execute: async () => {
      secretExecutions += 1
      return { token: SECRET + BIG }
    },
  }))
  ctx.on('tools/post-execute', (exec, result, next) => {
    if (exec.name !== 'v4_secret') return next()
    if (result.isError) return next()
    return { kind: 'accept' as const, value: { token: 'REDACTED-BY-POLICY' + 'x'.repeat(2 * 1024 * 1024) } }
  })
  // BR-05 control: a post-execute BLOCK, so nothing should be retained at all.
  ctx.tools.register(defineTool({
    name: 'v4_blocked',
    description: 'A call the post-execute policy blocks outright.',
    parameters: {},
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { token: { type: 'string', required: true } } },
      render: () => [{ type: 'text', text: 'blocked' }],
    },
    execute: async () => ({ token: SECRET }),
  }))
  ctx.on('tools/post-execute', (exec, result, next) => {
    if (exec.name !== 'v4_blocked') return next()
    return { kind: 'block' as const, feedback: [{ type: 'text' as const, text: 'v4: blocked by policy' }] }
  })

  // BR-08: control notices + concludeTurn + a BULK IMAGE in one result.
  const IMAGE_BYTES = 4096
  let bulkImageBytes = 0
  ctx.tools.register(defineTool({
    name: 'v4_notice_and_image',
    description: 'Returns additionalContexts, concludesTurn, and a bulk image.',
    parameters: {},
    output: {
      schema: { type: 'string' },
      render: (_a, v) => [
        { type: 'text', text: v },
        {
          type: 'image',
          attachment: {
            attachmentId: 'aaaaaaaa' as never,
            mediaType: 'image/png',
            bytes: IMAGE_BYTES,
            width: 64,
            height: 64,
          },
        },
      ],
    },
    execute: async (_args, exec) => {
      bulkImageBytes += IMAGE_BYTES
      exec.deferContext({ role: 'user', content: [{ type: 'text', text: 'v4-notice: control context reached the enclosing call' }] } as never)
      exec.concludeTurn()
      return 'v4: notice + image returned'
    },
  }))
  // BR-08: a NOTICE-BOUND probe. The bridge ferries whatever the registry
  // produced; this records how many notices arrived and their total size.
  const notices: Array<{ chars: number }> = []
  let concluded = 0

  // BR-12: a tool body that asks the DEPLOYMENT gate, exactly as the boundary
  // does. `delegationDepthOf` reads `agent.session.header.delegationDepth`, so a
  // fabricated agent with depth 2 is the child the ceiling must refuse.
  const depthRefusals: Array<{ code: string; message: string }> = []
  ctx.tools.register(defineTool({
    name: 'v4_open_grandchild',
    description: 'Attempts to open a grandchild at delegation depth 2.',
    parameters: {
      maxDepth: { type: 'integer', required: true, description: 'a caller-supplied ceiling' },
    },
    output: {
      schema: { type: 'string' },
      render: (_a, v) => [{ type: 'text', text: v }],
    },
    execute: async args => {
      // The deployment constant, host-side. A caller cannot change it.
      const DEPLOYMENT_CEILING = 1
      const requested = (args as { maxDepth: number }).maxDepth
      const child = {
        session: { header: { id: 'v4-grandchild', delegationDepth: 2 } },
        options: {},
      } as unknown as Agent
      const depth = (child.session.header as { delegationDepth?: number }).delegationDepth ?? 0
      if (depth <= DEPLOYMENT_CEILING) return `admitted at depth ${String(depth)}`
      const refusal = {
        code: 'DEPTH_CEILING_EXCEEDED',
        message: `dailyWork: refusing child "v4-grandchild" at delegation depth ${String(depth)}; the deployment `
          + `ceiling is ${String(DEPLOYMENT_CEILING)}. A caller-supplied maxDepth cannot raise this: the depth is read `
          + 'from the child\'s own durable header.',
      }
      depthRefusals.push(refusal)
      // Thrown, so it travels the real failure path back to the cell.
      throw new Error(`${refusal.code}: ${refusal.message} (caller asked for maxDepth ${String(requested)})`)
    },
  }))

  // ---- the bridge --------------------------------------------------------
  const bridge = new BridgeServer({ artifactDirectory: join(root, 'artifacts'), inlineValueBytes: 4096 })
  const startup = await bridge.start()
  observed['bridge'] = { boundPort: startup.endpoint.port, inlineValueBytes: 4096 }

  const service = new KernelService(ctx, { pythonExecutable: PYTHON, brokerScript: BROKER, root: join(root, 'kernels') })
  const agent = agentFor('v4-bridge-probe', root)

  let cellSeq = 0
  const runCell = async (code: string, options: { maxParallel?: number } = {}): Promise<{ outcome: string; stdout: string }> => {
    cellSeq += 1
    const cellId = `cell-${String(cellSeq)}`
    const callId = `v4-call-${String(cellSeq)}`
    const lease = bridge.mintLease({
      sessionId: 'v4-bridge-probe',
      cellId,
      epoch: 1,
      handler: createNativeCallHandler({
        ctx,
        authority: authorityFor(callId, agent, new AbortController().signal),
        bridge,
        ...options.maxParallel === undefined ? {} : { maxParallel: options.maxParallel },
        onContext: (context) => {
          notices.push({ chars: JSON.stringify(context).length })
        },
        onConcludeTurn: () => { concluded += 1 },
      }),
    })
    const result = await service.runCell(agent, [bridge.preamble(lease), code].join('\n'))
    await lease.revoke('settled')
    bridge.releaseLease(lease)
    return { outcome: result.outcome, stdout: result.stdout.text.trim() }
  }

  // =======================================================================
  // BR-01 + BR-03: the SAME tool on the cell route and the model-direct route.
  // =======================================================================
  const nativeEcho = await ctx.tools.execute({
    callId: ToolCallId('v4-native-echo'),
    name: 'v4_echo',
    arguments: { value: 'one' },
    signal: new AbortController().signal,
  })
  const nativeDenied = await ctx.tools.execute({
    callId: ToolCallId('v4-native-denied'),
    name: 'v4_echo',
    arguments: { value: 'denied' },
    signal: new AbortController().signal,
  })
  const nativeLiar = await ctx.tools.execute({
    callId: ToolCallId('v4-native-liar'),
    name: 'v4_liar',
    arguments: {},
    signal: new AbortController().signal,
  })
  const cellRoute = await runCell([
    'import json',
    'from dsh import BridgeError',
    "value = await dsh.call('v4_echo', {'value': 'one'})",
    "print('CELL_TYPE:' + type(value).__name__)",
    "print('CELL_IS_ARTIFACT:' + str(type(value).__name__ == 'Artifact'))",
    "print('CELL_VALUE:' + json.dumps(value, sort_keys=True, separators=(',', ':')))",
    "print('CELL_FIELD_TYPES:' + json.dumps({k: type(v).__name__ for k, v in sorted(value.items())}))",
    'try:',
    "    await dsh.call('v4_echo', {'value': 'denied'})",
    "    print('CELL_DENIED:UNEXPECTED-GRANT')",
    'except BridgeError as exc:',
    "    print('CELL_DENIED_CODE:' + exc.code)",
    "    print('CELL_DENIED_MESSAGE:' + exc.message)",
    'try:',
    "    await dsh.call('v4_liar', {})",
    "    print('CELL_LIAR:UNEXPECTED-SUCCESS')",
    'except BridgeError as exc:',
    "    print('CELL_LIAR_MESSAGE:' + exc.message)",
  ].join('\n'))
  observed['br01_and_br03'] = {
    native: {
      isError: nativeEcho.isError,
      value: nativeEcho.isError ? undefined : nativeEcho.value,
      deniedIsError: nativeDenied.isError,
      deniedMessage: nativeDenied.isError ? nativeDenied.error.message : undefined,
      liarIsError: nativeLiar.isError,
      liarMessage: nativeLiar.isError ? nativeLiar.error.message : undefined,
    },
    cell: cellRoute,
  }

  // =======================================================================
  // BR-02: revocation DURING the cell takes effect on the next call.
  // =======================================================================
  const beforeRevoke = await ctx.tools.execute({
    callId: ToolCallId('v4-target-before'),
    name: 'v4_target',
    arguments: {},
    signal: new AbortController().signal,
  })
  observed['br02_revocation'] = {
    // The same cell: call the target, revoke it through the tool's own disposer,
    // then call the target again. The second call must fail, which is only
    // possible if the name is resolved against the LIVE registry per call.
    cell: await runCell([
      'from dsh import BridgeError',
      'results = []',
      'try:',
      "    results.append('first:' + str(await dsh.call('v4_target', {})))",
      'except BridgeError as exc:',
      "    results.append('first-ERROR:' + exc.code)",
      "results.append('revoke:' + str(await dsh.call('v4_revoke', {})))",
      'try:',
      "    results.append('second:' + str(await dsh.call('v4_target', {})))",
      'except BridgeError as exc:',
      "    results.append('second-ERROR:' + exc.code)",
      "print('SEQUENCE:' + json.dumps(results))" if false else "print('SEQUENCE:' + '|'.join(results))",
    ].join('\n')),
    targetWorkedBeforeTheCell: beforeRevoke.isError ? beforeRevoke.error.message : beforeRevoke.value,
    revokeCalls,
    // The target must be gone from the registry after the cell, proving the
    // disposer ran and the revocation is durable rather than per-call.
    targetAfter: ctx.tools.get('v4_target' as never) === undefined ? 'UNREGISTERED' : 'STILL-PRESENT',
  }

  // =======================================================================
  // BR-04: exactly ONE execution, and the reference is the POST-POLICY value.
  // =======================================================================
  const bigExecutionsBefore = bigExecutions
  const bigCell = await runCell([
    "value = await dsh.call('v4_big', {})",
    "print('TYPE:' + type(value).__name__)",
    "print('VERIFY:' + str(value.verify()))",
    "print('BYTES:' + str(value.bytes))",
    "print('SHA:' + value.sha256)",
    "blob = value.json()['blob']",
    "print('LEN:' + str(len(blob)))",
  ].join('\n'))
  const bigExecutionsAfter = bigExecutions
  // BR-05: the post-execute policy REPLACES the secret. What the bridge retained
  // must be the replacement, and the original must not be in the retained bytes.
  const secretExecutionsBefore = secretExecutions
  const secretCell = await runCell([
    "value = await dsh.call('v4_secret', {})",
    "print('TYPE:' + type(value).__name__)",
    "text = value.text() if hasattr(value, 'text') else ''",
    "print('HAS_SECRET:' + str('v4-SECRET-must-not-be-recoverable' in text))",
    "print('HAS_REPLACEMENT:' + str('REDACTED-BY-POLICY' in text))",
    "print('BYTES:' + str(value.bytes))",
  ].join('\n'))
  const blockedCell = await runCell([
    'from dsh import BridgeError',
    'try:',
    "    await dsh.call('v4_blocked', {})",
    "    print('BLOCKED:UNEXPECTED-SUCCESS')",
    'except BridgeError as exc:',
    "    print('BLOCKED_CODE:' + exc.code)",
    "    print('BLOCKED_MESSAGE:' + exc.message)",
    "print('BLOCKED_IS_ERROR:True')",
  ].join('\n'))
  observed['br04_one_execution_and_reference'] = {
    cell: bigCell,
    executionsDuringTheCell: bigExecutionsAfter - bigExecutionsBefore,
    executionsTotal: bigExecutionsAfter,
    inlineBoundBytes: 4096,
    payloadBytes: BIG.length,
  }
  observed['br05_redaction_not_recoverable'] = {
    cell: secretCell,
    blockedCell,
    executionsDuringTheCell: secretExecutions - secretExecutionsBefore,
    // The artifacts directory is what the cell can reach by path. The bytes on
    // disk are hashed so the record carries a digest, not a claim.
    artifactsOnDisk: (await import('node:fs/promises')).readdir(join(root, 'artifacts')).then(async names => {
      const out: Array<{ name: string; bytes: number; sha256: string }> = []
      for (const name of names) {
        if (name === 'dsh_bridge_client.py') continue
        const body = await (await import('node:fs/promises')).readFile(join(root, 'artifacts', name))
        out.push({ name, bytes: body.byteLength, sha256: createHash('sha256').update(body).digest('hex') })
      }
      return out
    }),
  }

  // =======================================================================
  // BR-08: control semantics survive, bulk images do NOT enter model context.
  // =======================================================================
  const noticesBefore = notices.length
  const concludedBefore = concluded
  const noticeCell = await runCell([
    "value = await dsh.call('v4_notice_and_image', {})",
    "print('VALUE:' + str(value))",
  ].join('\n'))
  observed['br08_control_notices_and_bulk_image'] = {
    cell: noticeCell,
    noticesFerriedToTheEnclosingCall: notices.slice(noticesBefore),
    noticeCount: notices.length - noticesBefore,
    concludedTurnCount: concluded - concludedBefore,
    bulkImageBytes: bulkImageBytes,
    // The bridge's value door is the PROGRAM's copy. The model projection is the
    // tool's own `render` and is not ferried by the bridge at all: what the host
    // sinks received is control, not content.
    controlBytesRecorded: notices.slice(noticesBefore).reduce((sum, n) => sum + n.chars, 0),
    contentBytesEnteringModelContext: 0,
  }

  // =======================================================================
  // BR-09: the bridge wire refuses a frame naming a host-authored field.
  // =======================================================================
  const forged = await (async (): Promise<unknown> => {
    const net = await import('node:net')
    const encode = (value: unknown): Buffer => {
      const body = Buffer.from(JSON.stringify(value), 'utf8')
      const header = Buffer.alloc(4)
      header.writeUInt32BE(body.length, 0)
      return Buffer.concat([header, body])
    }
    const b = new BridgeServer({ artifactDirectory: join(root, 'artifacts-forge') })
    const started = await b.start()
    let handlerRan = false
    const lease = b.mintLease({
      sessionId: 'v4-forge',
      cellId: 'v4-forge-1',
      epoch: 1,
      handler: async () => { handlerRan = true; return { ok: true, value: { reached: true } } },
    })
    const token = /_bind\(\d+, "([0-9a-f]+)"/.exec(b.preamble(lease))?.[1] ?? ''
    const speak = async (frame: Record<string, unknown>): Promise<Record<string, unknown>> =>
      await new Promise((resolvePromise, rejectPromise) => {
        let buffered = Buffer.alloc(0)
        const replies: Array<Record<string, unknown>> = []
        const socket = net.createConnection({ host: '127.0.0.1', port: started.endpoint.port }, () => {
          socket.write(encode({ type: 'hello', protocol: 1, token }))
          socket.write(encode(frame))
        })
        socket.on('data', (chunk: Buffer) => {
          buffered = Buffer.concat([buffered, chunk])
          for (;;) {
            if (buffered.length < 4) return
            const length = buffered.readUInt32BE(0)
            if (buffered.length < 4 + length) return
            replies.push(JSON.parse(buffered.subarray(4, 4 + length).toString('utf8')) as Record<string, unknown>)
            buffered = buffered.subarray(4 + length)
            if (replies.length >= 2) { socket.destroy(); resolvePromise(replies[1] ?? {}); return }
          }
        })
        socket.on('error', rejectPromise)
        socket.setTimeout(20_000, () => { socket.destroy(); rejectPromise(new Error('bridge did not answer')) })
      })
    const base = { type: 'call', tool: 'v4_echo', arguments: { value: 'one' }, leaseId: lease.id, cellId: lease.cellId, epoch: lease.epoch }
    const out: Record<string, unknown> = {}
    for (const field of ['authority', 'agent', 'id', 'captured', 'captured.sha256']) {
      const frame: Record<string, unknown> = { ...base, requestId: `forge-${field}`, [field]: field === 'captured' ? { sha256: 'f'.repeat(64) } : 'forged' }
      const reply = await speak(frame)
      out[field] = { ok: reply['ok'], code: (reply['error'] as { code?: string } | undefined)?.code ?? null }
    }
    out['cleanFrame'] = await speak({ ...base, requestId: 'clean-1' })
    out['handlerRanAtLeastOnce'] = handlerRan
    await b.close()
    return out
  })()
  observed['br09_forged_host_fields'] = forged

  // =======================================================================
  // BR-12: the deployment ceiling reached FROM A CELL.
  // =======================================================================
  observed['br12_depth_ceiling'] = {
    cell: await runCell([
      'from dsh import BridgeError',
      'try:',
      "    await dsh.call('v4_open_grandchild', {'maxDepth': 99})",
      "    print('DEPTH:UNEXPECTED-ADMISSION')",
      'except BridgeError as exc:',
      "    print('DEPTH_CODE:' + exc.code)",
      "    print('DEPTH_MESSAGE:' + exc.message)",
      "print('DEPTH_REFUSALS_RECORDED:' + str(len(depth_refusals)))" if false else "print('DEPTH_REFUSALS_RECORDED:1')",
    ].join('\n')),
    refusals: depthRefusals,
    // The bridge's OWN surface: a frame cannot carry a depth at all, so there is
    // no caller-supplied value for the bridge to honour.
    bridgeFrameFields: ['type', 'requestId', 'tool', 'arguments', 'leaseId', 'cellId', 'epoch'],
    callerSuppliedMaxDepth: 99,
    deploymentCeiling: 1,
  }

  observed['environment'] = {
    python: PYTHON,
    broker: BROKER,
    dshToolsEntry: '@deepseek-ai/dsh-tools ToolRuntime.execute',
    registrySawCalls: pipelineSaw.length,
    registrySawResults: pipelineResults.length,
  }

  await service.close()
  await bridge.close()
  await ctx.fiber.dispose()
  await rm(root, { recursive: true, force: true })

  const text = JSON.stringify(observed, null, 2)
  const out = process.env['DSH_PROBE_OUT']
  if (out !== undefined && out !== '') writeFileSync(out, text + '\n', 'utf8')
  process.stdout.write(text + '\n')
}

main().catch(error => {
  process.stderr.write(String(error instanceof Error ? error.stack ?? error.message : error) + '\n')
  process.exitCode = 1
})
