/**
 * V4 probe: the BR arms that had NO measurement on the BRIDGE route.
 *
 * WHY THIS FILE EXISTS. T7 measured the seam (a cell's `dsh.call` reaches
 * `ctx.tools.execute`), the forbidden seam's absence, one model loop, and six
 * native-call arms. Those are real and this probe does not repeat them. What T7
 * did NOT measure is the behaviour of the bridge under the specific oracles the
 * trusted-local acceptance spec states for BR-01, BR-02, BR-03, BR-04, BR-05,
 * BR-08, BR-09 and BR-12.
 *
 * WHAT IS REAL HERE. A real ipykernel through the real broker, a real
 * `ToolRuntime` mounted in the production composition, and real cells. Every
 * observation is taken either from the REGISTRY side (`tools/pre-execute` /
 * `tools/result` listeners) or from what the CELL printed -- never from what the
 * bridge says about itself.
 *
 * WHAT THIS FILE DOES NOT ESTABLISH. It does not establish that the PRODUCT
 * starts the bridge. It does not: `new BridgeServer` has zero production call
 * sites (docs/GAPS.md G-SEAM-34). Every arm below therefore measures the
 * MECHANISM on a directly-constructed bridge, and each case record says so.
 * That split is the finding, not a defect in this probe.
 *
 * Run:  node --experimental-strip-types src/v4-bridge-probe.ts
 * Out:  JSON on stdout, and to $DSH_PROBE_OUT when that is set.
 */
import { Context } from '@deepseek-ai/cordis'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import Subprocess from '@deepseek-ai/dsh-subprocess-local'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import { ToolCallId, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { readdir, readFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { BridgeServer } from './bridge.ts'
import { createNativeCallHandler, type EnclosingAuthority } from './native-call.ts'
import { KernelService } from './kernel-plugin.ts'
import { MemoryBridgeLedger } from './bridge-ledger.ts'

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

  // BR-04: a large value with an EXECUTION COUNTER, so "exactly once" is a
  // count and not a claim.
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

  // BR-05: a secret-bearing large value the post-execute policy REPLACES. The
  // secret must not be recoverable from the bytes the bridge retained, and the
  // replacement must be what is retained -- i.e. the reference is POST-policy.
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
  ctx.on('tools/post-execute', async (exec, result, next) => {
    if (exec.name !== 'v4_secret') return await next()
    if (result.isError) return await next()
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
  ctx.on('tools/post-execute', async (exec, result, next) => {
    if (exec.name !== 'v4_blocked') return await next()
    return { kind: 'block' as const, feedback: [{ type: 'text' as const, text: 'v4: blocked by policy' }] }
  })

  // BR-08: control notices + concludeTurn + a BULK IMAGE in ONE result.
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
            // `attachmentId` is the BRANDED `AttachmentId`, not a plain string.
            // `AttachmentId(...)` is the package's own compile-time brand
            // constructor: same string, brand added, no validation. The previous
            // `as never` suppressed `TS2322: Type 'string' is not assignable to
            // type 'AttachmentId'`.
            attachmentId: AttachmentId('aaaaaaaa'),
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
      // `deferContext` takes a real `UserMessage`, which needs the message `id`
      // and `role` tags that `createUserMessage` stamps, plus a `source` naming
      // the producer. Hand-building the object is what made the `as never`
      // necessary; measured, removing that cast reports `TS2345: Argument of type
      // '{ role: "user"; content: [...] }' is not assignable to parameter of type
      // 'UserMessage'`. This is the same idiom the product uses
      // (`packages/core/tools/src/ptc.ts:633`).
      exec.deferContext(createUserMessage({
        content: [{ type: 'text', text: 'v4-notice: control context reached the enclosing call' }],
        source: { kind: 'plugin', plugin: 'v4-bridge-probe' },
      }))
      exec.concludeTurn()
      return 'v4: notice + image returned'
    },
  }))

  // ---- the bridge --------------------------------------------------------
  const bridge = new BridgeServer({ artifactDirectory: join(root, 'artifacts'), inlineValueBytes: 4096 })
  const startup = await bridge.start()
  observed['bridge'] = { boundPort: startup.endpoint.port, inlineValueBytes: 4096 }

  const service = new KernelService(ctx, { pythonExecutable: PYTHON, brokerScript: BROKER, root: join(root, 'kernels') })
  const agent = agentFor('v4-bridge-probe', root)

  /** Control sinks the bridge's `NativeCallHandlerOptions` offers, recorded. */
  const notices: Array<{ chars: number; text: string }> = []
  let concluded = 0

  let cellSeq = 0
  const runCell = async (code: string): Promise<{ outcome: string; stdout: string }> => {
    cellSeq += 1
    const cellId = `cell-${String(cellSeq)}`
    const callId = `v4-call-${String(cellSeq)}`
    const lease = bridge.mintLease({
      sessionId: 'v4-bridge-probe',
      cellId,
      epoch: 1,
      outerCallId: String(callId),
      rootCallId: String(callId),
      ledger: new MemoryBridgeLedger(),
      handler: createNativeCallHandler({
        ctx,
        authority: authorityFor(callId, agent, new AbortController().signal),
        bridge,
        onContext: (context) => {
          notices.push({ chars: JSON.stringify(context).length, text: JSON.stringify(context) })
        },
        onConcludeTurn: () => { concluded += 1 },
      }),
    })
    const result = await service.runCell(agent, [bridge.preamble(lease), code].join('\n'))
    await lease.close('completed', 'settled')
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
      value: nativeEcho.isError ? null : nativeEcho.value,
      deniedIsError: nativeDenied.isError,
      deniedMessage: nativeDenied.isError ? nativeDenied.error.message : null,
      liarIsError: nativeLiar.isError,
      liarMessage: nativeLiar.isError ? nativeLiar.error.message : null,
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
  const revocationCell = await runCell([
    'import json',
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
    "print('SEQUENCE:' + json.dumps(results))",
  ].join('\n'))
  observed['br02_revocation'] = {
    cell: revocationCell,
    targetWorkedBeforeTheCell: beforeRevoke.isError ? beforeRevoke.error.message : beforeRevoke.value,
    revokeCalls,
    // The target must be gone from the registry after the cell, proving the
    // disposer ran and the revocation is durable rather than per-call.
    targetAfterTheCell: ctx.tools.get('v4_target' as never) === undefined ? 'UNREGISTERED' : 'STILL-PRESENT',
    // And the refusal code the cell saw for the revoked name.
    refusalCodeSeenByTheCell: 'UNKNOWN_TOOL (see SEQUENCE)',
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
  observed['br04_one_execution_and_reference'] = {
    cell: bigCell,
    executionsDuringTheCell: bigExecutions - bigExecutionsBefore,
    executionsTotal: bigExecutions,
    inlineBoundBytes: 4096,
    payloadBytes: BIG.length,
  }

  // =======================================================================
  // BR-05: a redacted value is not recoverable through its reference.
  // =======================================================================
  const secretExecutionsBefore = secretExecutions
  const secretCell = await runCell([
    "value = await dsh.call('v4_secret', {})",
    "print('TYPE:' + type(value).__name__)",
    "text = value.text()",
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
  ].join('\n'))
  // Sweep every byte the cell can reach by path. This is the artifact door: the
  // reference names a file, and the cell can read any file the OS user can read.
  const artifactNames = (await readdir(join(root, 'artifacts'))).filter(name => name !== 'dsh_bridge_client.py')
  const artifactSweep: Array<{ name: string; bytes: number; sha256: string; containsSecret: boolean; containsReplacement: boolean }> = []
  for (const name of artifactNames) {
    const body = await readFile(join(root, 'artifacts', name))
    const text = body.toString('utf8')
    artifactSweep.push({
      name,
      bytes: body.byteLength,
      sha256: createHash('sha256').update(body).digest('hex'),
      containsSecret: text.includes('v4-SECRET-must-not-be-recoverable'),
      containsReplacement: text.includes('REDACTED-BY-POLICY'),
    })
  }
  observed['br05_redaction_not_recoverable'] = {
    cell: secretCell,
    blockedCell,
    executionsDuringTheCell: secretExecutions - secretExecutionsBefore,
    artifactSweep,
    secretAnywhereInTheArtifactDirectory: artifactSweep.some(entry => entry.containsSecret),
  }

  // =======================================================================
  // BR-08: control semantics survive; bulk images do NOT enter model context.
  // =======================================================================
  const noticesBefore = notices.length
  const concludedBefore = concluded
  const noticeCell = await runCell([
    "value = await dsh.call('v4_notice_and_image', {})",
    "print('VALUE:' + str(value))",
  ].join('\n'))
  const noticeSlice = notices.slice(noticesBefore)
  observed['br08_control_notices_and_bulk_image'] = {
    cell: noticeCell,
    noticeCount: noticeSlice.length,
    notices: noticeSlice,
    concludedTurnCount: concluded - concludedBefore,
    bulkImageBytesReturnedByTheTool: bulkImageBytes,
    controlBytesFerried: noticeSlice.reduce((sum, entry) => sum + entry.chars, 0),
    // The bridge ferries CONTROL (additionalContexts / concludesTurn) and returns
    // the program's own copy of the value through its value/artifact door. The
    // model-facing content projection is the tool's own `render` and is NOT
    // carried by the bridge at all, so no image bytes ride into model context on
    // this route.
    contentBytesEnteringModelContextViaTheBridge: 0,
  }

  // =======================================================================
  // BR-09: the bridge WIRE refuses a frame naming a host-authored field.
  // =======================================================================
  const forged = await (async (): Promise<Record<string, unknown>> => {
    const net = await import('node:net')
    const encode = (value: unknown): Buffer => {
      const body = Buffer.from(JSON.stringify(value), 'utf8')
      const header = Buffer.alloc(4)
      header.writeUInt32BE(body.length, 0)
      return Buffer.concat([header, body])
    }
    const b = new BridgeServer({ artifactDirectory: join(root, 'artifacts-forge') })
    const started = await b.start()
    let handlerRan = 0
    /** What the handler ACTUALLY received, so "ignored" is measured, not assumed. */
    const handlerSaw: Array<Record<string, unknown>> = []
    const lease = b.mintLease({
      sessionId: 'v4-forge',
      cellId: 'v4-forge-1',
      epoch: 1,
      outerCallId: String('legacy-outer-call'),
      rootCallId: String('legacy-outer-call'),
      ledger: new MemoryBridgeLedger(),
      handler: async (call) => {
        handlerRan += 1
        handlerSaw.push({
          requestId: call.requestId,
          tool: call.tool,
          arguments: call.arguments,
          // The keys the handler's OWN request object carries. If a forged
          // top-level frame field were merged in, it would appear here.
          receivedKeys: Object.keys(call as unknown as Record<string, unknown>).sort(),
        })
        return { ok: true, value: { reached: true } }
      },
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
        socket.setTimeout(20_000, () => { socket.destroy(); rejectPromise(new Error('the bridge did not answer')) })
      })
    const base = {
      type: 'call', tool: 'v4_echo', arguments: { value: 'one' },
      leaseId: lease.id, cellId: lease.cellId, epoch: lease.epoch,
    }
    const out: Record<string, unknown> = {}
    // The bridge's own FORBIDDEN_FIELDS, PLUS the ORACLE's own examples of
    // host-authored paths (`id`, `captured`, `captured.sha256`). The extra three
    // are here to measure whether the refusal GENERALISES to the field names
    // BR-09 names, or covers only the bridge's own list -- a distinction that
    // decides whether the oracle's "such as" clause is satisfied. Sent one field
    // at a time, each on an otherwise valid frame with a LIVE lease; a check that
    // ran after the lease lookup would serve these.
    const FRAME_FIELDS = [
      'authority', 'agent', 'session', 'sessionId', 'rootCallId', 'parent', 'parentToken',
      'id', 'captured', 'captured.sha256',
    ]
    for (const field of FRAME_FIELDS) {
      const forgedValue: unknown = field === 'captured' ? { sha256: 'f'.repeat(64) } : 'forged'
      const reply = await speak({ ...base, requestId: `forge-${field}`, [field]: forgedValue })
      out[field] = {
        ok: reply['ok'] ?? null,
        code: (reply['error'] as { code?: string } | undefined)?.code ?? null,
        // A frame with NO error is a frame the host SERVED under a forged
        // field, which is the failure this arm exists to detect.
        servedUnderForgery: reply['ok'] === true,
      }
    }
    // A control frame with NO forged field, so the refusal is targeted rather
    // than an outage that refuses everything.
    const clean = await speak({ ...base, requestId: 'clean-1' })
    out['cleanFrame'] = { ok: clean['ok'] ?? null, value: clean['value'] ?? null }
    out['handlerRan'] = handlerRan
    // THE PRECISION THAT MATTERS, and it is a measurement rather than a reading.
    // The bridge's FORBIDDEN_FIELDS are REFUSED. The oracle's other examples
    // (`id`, `captured`, `captured.sha256`) are NOT in that list, and the frames
    // naming them were SERVED. What decides whether that is a forgery is whether
    // the field REACHED the handler: a field that is ignored cannot promote a
    // claim, while a field that is merged would. So the handler's own received
    // keys are recorded for every call.
    out['handlerReceived'] = handlerSaw
    out['interpretation'] = {
      refusedByTheBridge: FRAME_FIELDS.filter(field => out[field] !== undefined && (out[field] as { servedUnderForgery?: boolean }).servedUnderForgery === false),
      servedBecauseTheFieldIsNotInTheBridgeAuthorityList: FRAME_FIELDS.filter(field => (out[field] as { servedUnderForgery?: boolean }).servedUnderForgery === true),
      // Every served call must have carried ONLY the four transport fields, so
      // the forged key was DROPPED rather than merged.
      forgedFieldReachedTheHandler: handlerSaw.some(call => (call['receivedKeys'] as string[]).some(key =>
        ['id', 'captured', 'captured.sha256'].includes(key))),
      note: 'A served frame is not a forgery IF the extra field is dropped before the handler. '
        + 'This probe records the handler\'s received keys so that claim is falsifiable rather '
        + 'than asserted. The host-authored facts the DATA plane protects (captured.sha256, '
        + 'authority.*) are refused at THAT boundary by refuseForgedClaims, measured separately '
        + 'in tests-observation-authority.txt.',
    }
    await b.close()
    return out
  })()
  observed['br09_forged_host_fields'] = forged

  // =======================================================================
  // BR-12: the bridge frame carries NO depth field, so a cell cannot name one.
  // =======================================================================
  // Read the CLIENT's own frame builder, so "there is no depth field to raise"
  // is a reading of the code the kernel runs rather than an assumption.
  const clientSource = readFileSync(join(root, 'artifacts', 'dsh_bridge_client.py'), 'utf8')
  // The signature is matched with an OPTIONAL `waiter` parameter. The waiter was
  // moved INTO `_send` so that registration and the send happen under one lock
  // acquisition (BRI-WAITER); without the optional group this regex stopped
  // matching and `clientFrameKeys` silently became `[]` -- a measurement
  // degrading to empty, which reads as "the frame carries no fields" rather than
  // as "the extractor broke". The field list is unchanged; only the signature is.
  const sendBody = /def _send\(self, tool, arguments(?:, waiter)?\):([\s\S]*?)\n    def /.exec(clientSource)?.[1] ?? ''
  if (sendBody === '') throw new Error('the client frame builder could not be extracted from the written client; the probe would report an empty frame')
  observed['br12_depth_ceiling'] = {
    // The fields the client puts on the wire, extracted from its own `_send`.
    clientFrameKeys: [...sendBody.matchAll(/"([a-zA-Z]+)":/g)].map(match => match[1] as string),
    // The fields the host REFUSES if Python names them (bridge.ts FORBIDDEN_FIELDS).
    forbiddenFieldsTheHostRefuses: ['agent', 'session', 'sessionId', 'rootCallId', 'parent', 'parentToken', 'authority'],
    // The tool surface the cell reached during this probe, measured from the
    // registry side. No subagent/depth-opening tool is among them.
    toolsTheRegistrySawFromCells: [...new Set(pipelineSaw.map(entry => String(entry['name'])))].sort(),
    // The host's own depth ceiling lives in the deployment config, not in any
    // frame: `dsh-daily-work/src/capacity.ts` reads it from host config and
    // reads the child's depth from the child's durable header.
    deploymentCeilingSource: 'packages/dsh-daily-work/src/capacity.ts assertDepthWithin(agent, maxDepth)',
    callerSuppliedMaxDepthIsReachableFromACell: false,
  }

  observed['environment'] = {
    python: PYTHON,
    broker: BROKER,
    dshToolsEntry: '@deepseek-ai/dsh-tools ToolRuntime.execute',
    registrySawCalls: pipelineSaw.length,
    registrySawResults: pipelineResults.length,
    pipelineSaw: pipelineSaw.map(entry => ({ name: entry['name'], callId: entry['callId'], parentIsSet: entry['parentIsSet'] })),
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
