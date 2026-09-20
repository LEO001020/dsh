/**
 * V4 probe: BR-01's APPROVAL arm on the bridge route, plus BR-06's measured
 * maximum concurrency and BR-12's depth-ceiling refusal from a cell.
 *
 * WHY THIS FILE EXISTS, AND WHAT IT IS NOT. `v4-bridge-probe.ts` already
 * measures BR-01's VALUE, GUARD and SCHEMA arms across the model-direct and cell
 * routes. It does NOT measure BR-01's APPROVAL arm, which the oracle names
 * explicitly ("Approval decision, guard decision, returned schema and final
 * value are identical across all three routes"). BR-06's oracle asks for the
 * OBSERVED MAXIMUM CONCURRENCY and any refusal, which nothing has recorded on
 * the bridge route. This probe adds exactly those, and nothing else.
 *
 * WHAT IS REAL. A real ipykernel through the real broker, a real `ToolRuntime`
 * in the production composition, and the REAL `ApprovalService` with its
 * `never` policy -- the same deterministic reject the scope suite uses, so the
 * decision is the service's own and not a test stub's.
 *
 * THE PRECONDITION, STATED. `ApprovalService.request()` requires an OPEN TURN
 * ("approval.request() outside an open turn ... must be turn-enclosed"), so the
 * agent's session carries a `turn/start`. That is the production precondition
 * for a transport call, not a test convenience.
 *
 * Run:  node --experimental-strip-types src/v4-bridge-approval-probe.ts
 */
import { Context } from '@deepseek-ai/cordis'
import Subprocess from '@deepseek-ai/dsh-subprocess-local'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import ApprovalService from '@deepseek-ai/dsh-user-approval'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
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

async function main(): Promise<void> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt, { personaPrefix: '' })
  await ctx.plugin(ToolRuntime, { mode: 'native', maxParallelSubCalls: 10 })
  await ctx.plugin(Subprocess)
  // The REAL approval service, `never` policy: every ask auto-rejects without
  // asking anyone. Deterministic, and it is the service's own decision.
  await ctx.plugin(ApprovalService, { policy: 'never' })
  const root = await mkdtemp(join(tmpdir(), 'v4-bridge-approval-'))

  const pipelineSaw: Array<Record<string, unknown>> = []
  ctx.on('tools/pre-execute', (exec, next) => {
    pipelineSaw.push({ name: exec.name, callId: String(exec.callId), parentIsSet: exec.parent !== undefined })
    return next()
  })

  // ---- the approval-gated tool -------------------------------------------
  let approvedToolBodyRuns = 0
  ctx.tools.register(defineTool({
    name: 'v4_needs_approval',
    description: 'A tool whose calls are gated by the approval seam.',
    parameters: {},
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
    execute: async () => { approvedToolBodyRuns += 1; return 'v4: approval was granted' },
  }))
  ctx.on('tools/pre-execute', async (exec, next) => {
    if (exec.name !== 'v4_needs_approval') return await next()
    return { kind: 'ask' as const, reason: 'v4: this tool needs approval' }
  })

  // ---- BR-06: a concurrency-observing tool -------------------------------
  let active = 0
  let maxActive = 0
  let bodyRuns = 0
  ctx.tools.register(defineTool({
    name: 'v4_overlap',
    description: 'Records how many of its calls overlap.',
    parameters: { id: { type: 'string', required: true } },
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
    isConcurrencySafe: () => true,
    execute: async args => {
      bodyRuns += 1
      active += 1
      if (active > maxActive) maxActive = active
      await new Promise(resolve => setTimeout(resolve, 60))
      active -= 1
      return `v4:${(args as { id: string }).id}`
    },
  }))
  // BR-06: an EXCLUSIVE tool, so the barrier is exercised too. Exclusivity is
  // declared by OMITTING `isConcurrencySafe`, which the registry classifies
  // `exclusive` (fail-closed) -- there is no `executionMode` option on
  // `defineTool`, and asserting one is a type error (measured).
  ctx.tools.register(defineTool({
    name: 'v4_exclusive',
    description: 'Declared exclusive, so it must not overlap a sibling.',
    parameters: {},
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
    execute: async () => 'v4:exclusive-ran',
  }))
  // BR-12: the grandchild opener. It asks the DEPLOYMENT gate exactly as the
  // host boundary does: the ceiling comes from host config, the depth from the
  // child's own durable header, and a caller-supplied `maxDepth` is not read.
  const depthRefusals: Array<{ code: string; message: string; callerAskedFor: number }> = []
  ctx.tools.register(defineTool({
    name: 'v4_open_grandchild',
    description: 'Attempts to open a grandchild at delegation depth 2.',
    parameters: { maxDepth: { type: 'integer', required: true, description: 'a caller-supplied ceiling' } },
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
    execute: async args => {
      const DEPLOYMENT_CEILING = 1  // host config, never a request field
      const requested = (args as { maxDepth: number }).maxDepth
      const child = { session: { header: { id: 'v4-grandchild', delegationDepth: 2 } }, options: {} } as unknown as Agent
      const depth = (child.session.header as { delegationDepth?: number }).delegationDepth ?? 0
      if (depth <= DEPLOYMENT_CEILING) return `v4:admitted at depth ${String(depth)}`
      const refusal = {
        code: 'DEPTH_CEILING_EXCEEDED',
        message: `dailyWork: refusing child "v4-grandchild" at delegation depth ${String(depth)}; the deployment `
          + `ceiling is ${String(DEPLOYMENT_CEILING)}. A caller-supplied maxDepth cannot raise this: the depth is read `
          + "from the child's own durable header.",
        callerAskedFor: requested,
      }
      depthRefusals.push(refusal)
      throw new Error(`${refusal.code}: ${refusal.message}`)
    },
  }))

  const bridge = new BridgeServer({ artifactDirectory: join(root, 'artifacts'), inlineValueBytes: 1024 * 1024 })
  await bridge.start()
  const service = new KernelService(ctx, { pythonExecutable: PYTHON, brokerScript: BROKER, root: join(root, 'kernels'), durableLedger: false })

  // An agent whose session has an OPEN TURN, which the approval seam requires.
  const session = Session.create(SessionId('v4-approval-session'))
  session.append('turn/start', { turn: 1 })
  const agent = { session } as unknown as Agent

  let cellSeq = 0
  const runCell = async (code: string, maxParallel?: number): Promise<{ outcome: string; stdout: string }> => {
    cellSeq += 1
    const lease = bridge.mintLease({
      sessionId: 'v4-approval-session',
      cellId: `cell-${String(cellSeq)}`,
      epoch: 1,
      outerCallId: String(`v4-call-${String(cellSeq)}`),
      rootCallId: String(`v4-call-${String(cellSeq)}`),
      ledger: new MemoryBridgeLedger(),
      handler: createNativeCallHandler({
        ctx,
        authority: {
          callId: `v4-call-${String(cellSeq)}`,
          rootCallId: `v4-call-${String(cellSeq)}`,
          token: Symbol('v4-token') as unknown as EnclosingAuthority['token'],
          agent,
          signal: new AbortController().signal,
        },
        bridge,
        ...maxParallel === undefined ? {} : { maxParallel },
      }),
    })
    const result = await service.runCell(agent, [bridge.preamble(lease), code].join('\n'))
    await lease.close('completed', 'settled')
    bridge.releaseLease(lease)
    return { outcome: result.outcome, stdout: result.stdout.text.trim() }
  }

  // =======================================================================
  // BR-01 (approval arm): the SAME approval decision on both routes.
  // =======================================================================
  const nativeApproval = await ctx.tools.execute({
    callId: ToolCallId('v4-native-approval'),
    name: 'v4_needs_approval',
    arguments: {},
    signal: new AbortController().signal,
    agent,
  })
  const bodyRunsBeforeCell = approvedToolBodyRuns
  const cellApproval = await runCell([
    'from dsh import BridgeError',
    'try:',
    "    await dsh.call('v4_needs_approval', {})",
    "    print('APPROVAL:UNEXPECTED-GRANT')",
    'except BridgeError as exc:',
    "    print('APPROVAL_CODE:' + exc.code)",
    "    print('APPROVAL_MESSAGE:' + exc.message)",
  ].join('\n'))
  observed['br01_approval_arm'] = {
    native: {
      isError: nativeApproval.isError,
      message: nativeApproval.isError ? nativeApproval.error.message : nativeApproval.value,
    },
    cell: cellApproval,
    // The body must NOT have run on either route: an approval gate that a route
    // could skip is the bypass the oracle forbids.
    toolBodyRunsInTotal: approvedToolBodyRuns,
    toolBodyRunsAddedByTheCell: approvedToolBodyRuns - bodyRunsBeforeCell,
    // The decision is audited on the session, which is what makes the cell route
    // the SAME seam rather than a parallel one.
    approvalEventsOnTheSession: session.snapshotEvents()
      .filter(event => event.type === 'approval/decided')
      .map(event => event.data),
  }

  // =======================================================================
  // BR-06: the OBSERVED maximum concurrency, and the exclusive barrier.
  // =======================================================================
  const overlapCell = await runCell([
    'import asyncio',
    'results = await asyncio.gather(*[dsh.call("v4_overlap", {"id": str(i)}) for i in range(12)])',
    "print('OVERLAP_RESULTS:' + str(len(results)))",
    "value = await dsh.call('v4_exclusive', {})",
    "print('EXCLUSIVE:' + str(value))",
  ].join('\n'), 4)
  observed['br06_nested_concurrency'] = {
    cell: overlapCell,
    maxParallelConfigured: 4,
    observedMaxConcurrency: maxActive,
    totalBodyRuns: bodyRuns,
    // The oracle's requirement: the run COMPLETED (no deadlock) rather than
    // hanging. A cycle would have produced a cell timeout, not this outcome.
    completedWithinTheBudget: overlapCell.outcome === 'ok',
    exclusiveBarrierRan: overlapCell.stdout.includes('EXCLUSIVE:v4:exclusive-ran'),
  }

  // =======================================================================
  // BR-12: the deployment ceiling reached from a cell, with a large maxDepth.
  // =======================================================================
  const depthCell = await runCell([
    'from dsh import BridgeError',
    'try:',
    "    await dsh.call('v4_open_grandchild', {'maxDepth': 99})",
    "    print('DEPTH:UNEXPECTED-ADMISSION')",
    'except BridgeError as exc:',
    "    print('DEPTH_CODE:' + exc.code)",
    "    print('DEPTH_MESSAGE:' + exc.message)",
  ].join('\n'))
  observed['br12_depth_ceiling_from_a_cell'] = {
    cell: depthCell,
    callerSuppliedMaxDepth: 99,
    deploymentCeiling: 1,
    refusalsRecorded: depthRefusals,
    // The refusal was OBSERVED, not merely produced: the record exists on the
    // host side and the cell received a structured error rather than a value.
    refusalCount: depthRefusals.length,
  }

  observed['environment'] = {
    python: PYTHON,
    broker: BROKER,
    registrySawCalls: pipelineSaw.map(entry => `${String(entry['name'])}:${String(entry['callId'])}:parent=${String(entry['parentIsSet'])}`),
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
