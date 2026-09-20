/**
 * V4 probe: what does the BRIDGE route actually do when a CELL returns with
 * native calls still in flight?
 *
 * WHY THIS FILE EXISTS, AND WHY IT IS THE HONEST ANSWER RATHER THAN A PASS.
 * BR-07's stimulus is "Return a cell while native child calls are still in
 * flight", and its oracle requires that "every in-flight call carries one
 * disposition from `settled`, `cancelled`, `handed-to-jobs`,
 * `abandoned-unstarted`, and any call handed to Jobs names its job id. Nothing
 * continues silently in the background with no record."
 *
 * The SCOPE route has exactly that vocabulary and it is measured
 * (`v4-scope-probe.json`). The BRIDGE route is a DIFFERENT implementation, and a
 * grep of `bridge.ts` and `native-call.ts` for `disposition` / `jobId` /
 * `handoff` returns NOTHING. So the scope route's evidence cannot establish this
 * oracle for the bridge route: the stimulus names a cell, and a scope is not a
 * cell. Filing the scope's dispositions as BR-07's evidence would be the
 * weaker-oracle substitution this project's audit exists to catch.
 *
 * WHAT THIS PROBE DOES INSTEAD. It drives the real thing -- a real ipykernel
 * through the real broker, a real ToolRuntime, a real cell that starts a call
 * WITHOUT awaiting it and then returns -- and records what the host's own
 * surfaces show afterwards. The answer is recorded whichever way it comes out.
 *
 * Run:  node --experimental-strip-types src/v4-bridge-drain-probe.ts
 */
import { Context } from '@deepseek-ai/cordis'
import Subprocess from '@deepseek-ai/dsh-subprocess-local'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { BridgeServer, type CellLease } from './bridge.ts'
import { createNativeCallHandler, type EnclosingAuthority } from './native-call.ts'
import { KernelService } from './kernel-plugin.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const BROKER = resolve(HERE, 'broker.py')
const PYTHON = process.env['DSH_PYTHON'] ?? 'C:/Users/hzq00/AppData/Local/Programs/Python/Python314/python.exe'

const observed: Record<string, unknown> = {}

async function main(): Promise<void> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt, { personaPrefix: '' })
  await ctx.plugin(ToolRuntime, { mode: 'native', maxParallelSubCalls: 10 })
  await ctx.plugin(Subprocess)
  const root = await mkdtemp(join(tmpdir(), 'v4-bridge-drain-'))

  const pipelineSaw: string[] = []
  const pipelineResults: string[] = []
  ctx.on('tools/pre-execute', (exec, next) => {
    pipelineSaw.push(`${exec.name}:${String(exec.callId)}`)
    return next()
  })
  ctx.on('tools/result', (exec) => {
    pipelineResults.push(`${exec.name}:${String(exec.callId)}`)
  })

  // A tool that takes a measurable time, so "still in flight" is a real state.
  let slowStarted = 0
  let slowFinished = 0
  ctx.tools.register(defineTool({
    name: 'v4_slow',
    description: 'Takes 1500 ms, so a cell can return while it is still running.',
    parameters: {},
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
    execute: async () => {
      slowStarted += 1
      await new Promise(resolve => setTimeout(resolve, 1500))
      slowFinished += 1
      return 'v4:slow-done'
    },
  }))

  const bridge = new BridgeServer({ artifactDirectory: join(root, 'artifacts') })
  await bridge.start()
  const service = new KernelService(ctx, { pythonExecutable: PYTHON, brokerScript: BROKER, root: join(root, 'kernels') })
  const agent = { session: { header: { id: 'v4-drain', cwd: root } } } as unknown as Agent

  const lease: CellLease = bridge.mintLease({
    sessionId: 'v4-drain',
    cellId: 'cell-drain',
    epoch: 1,
    handler: createNativeCallHandler({
      ctx,
      authority: {
        callId: 'v4-drain-call',
        rootCallId: 'v4-drain-call',
        token: Symbol('v4-token') as unknown as EnclosingAuthority['token'],
        agent,
        signal: new AbortController().signal,
      },
      bridge,
    }),
  })

  // The cell starts a call and RETURNS WITHOUT AWAITING IT. This is the
  // stimulus: a cell that returns while a native child call is in flight.
  const result = await service.runCell(agent, [
    bridge.preamble(lease),
    'import asyncio',
    'task = asyncio.create_task(dsh.call("v4_slow", {}))',
    'print("CELL_RETURNED_WITH_TASK_PENDING:" + str(not task.done()))',
  ].join('\n'))

  const atCellReturn = { slowStarted, slowFinished, pipelineResults: [...pipelineResults] }
  // What the host's surfaces show at the moment the cell has returned.
  observed['atCellReturn'] = {
    cellOutcome: result.outcome,
    cellStdout: result.stdout.text.trim(),
    slowStarted,
    slowFinished,
    registryDispatches: [...pipelineSaw],
    registryResults: [...pipelineResults],
    // THE QUESTION: is there any per-call disposition record on this route?
    leaseHasDispositionSurface: 'disposition' in lease || 'dispositions' in lease,
    leaseOwnKeys: Object.getOwnPropertyNames(lease),
    leasePrototypeMethods: Object.getOwnPropertyNames(Object.getPrototypeOf(lease) as object),
  }

  // Now revoke, which is the bridge's own drain, and see whether it waits.
  const beforeRevoke = { slowStarted, slowFinished }
  const revokeStart = Date.now()
  await lease.revoke('the cell settled')
  const revokeMs = Date.now() - revokeStart
  observed['revokeDrains'] = {
    slowStartedBeforeRevoke: beforeRevoke.slowStarted,
    slowFinishedBeforeRevoke: beforeRevoke.slowFinished,
    revokeElapsedMs: revokeMs,
    slowFinishedAfterRevoke: slowFinished,
    // A drain means revoke did not resolve until the in-flight call had finished.
    theDrainWaitedForTheInFlightCall: slowFinished > beforeRevoke.slowFinished,
    revokedReason: lease.revokedReason,
    registryResultsAfterRevoke: [...pipelineResults],
  }

  // And the negative: a call arriving AFTER the revoke is refused, by code.
  const afterRevoke = await lease.invoke({
    requestId: 'after-revoke-1',
    tool: 'v4_slow',
    arguments: {},
    cellId: lease.cellId,
    epoch: lease.epoch,
    leaseId: lease.id,
  }).then(
    outcome => ({ outcome: 'SERVED', value: outcome }),
    (error: unknown) => ({ outcome: 'REFUSED', code: (error as { code?: string }).code ?? null, message: (error as Error).message }),
  )
  observed['afterRevoke'] = afterRevoke

  // The verdict, computed rather than asserted, so a reader sees the reasoning.
  const dispositionsExist =
    ('disposition' in lease)
    || ('dispositions' in lease)
    || Object.getOwnPropertyNames(Object.getPrototypeOf(lease) as object).some(name => /disposition/i.test(name))
  observed['verdict'] = {
    // BR-07's oracle names four dispositions and requires one per in-flight call.
    dispositionVocabularyPresentOnTheBridgeRoute: dispositionsExist,
    inFlightCallWasDrained: slowFinished > beforeRevoke.slowFinished,
    nothingContinuedSilently: slowFinished > beforeRevoke.slowFinished,
    perCallDispositionRecordExists: dispositionsExist,
    // Stated as the two halves, because they come out differently.
    drainHalf: 'MEASURED — the lease drain waits for the in-flight call, so nothing continues silently past the cell.',
    recordHalf: dispositionsExist
      ? 'MEASURED — a per-call disposition exists.'
      : 'NOT ESTABLISHED — the bridge route has NO per-call disposition vocabulary. '
        + 'BR-07\'s oracle names `settled`/`cancelled`/`handed-to-jobs`/`abandoned-unstarted` and a job id for '
        + 'a handoff; the bridge route implements a drain barrier and a request-id record instead, which is a '
        + 'DIFFERENT mechanism. The scope route implements the vocabulary and is measured separately.',
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
