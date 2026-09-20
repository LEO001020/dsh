/**
 * P9 AFTER probe: the SAME measurement S5 took, re-taken through the delivered path.
 *
 * WHY THIS IS A SEPARATE PROBE FROM THE GATE. The gate (`p9-late-notice.test.ts`)
 * asserts. This probe OBSERVES and writes the raw text to disk, so a reader can
 * compare it byte-for-byte against S5's BEFORE
 * (`qualification/results/S5-ipy13/delivery-probe.json`), which measured:
 *
 *   "verdict": "NOT DELIVERED: the late output was classified and then reached no
 *               model-facing text"
 *
 * It drives the same layers S5 drove -- the tool's own `apply`, the tool's own
 * `execute` -- and reports what the MODEL-VISIBLE BOUNDARY now contains. It also
 * reports `drainUnattributed`, unchanged, so the two accessors' different jobs
 * are visible in one artifact.
 *
 * WHAT "MODEL-VISIBLE BOUNDARY" MEANS HERE, EXACTLY. The probe cannot run an
 * agent loop (no provider is authorized), so it takes the boundary at
 * `result.additionalContexts`, which is the value the registry hands the loop and
 * which `packages/core/agent-loop/src/tool-calls.ts:157` commits into the
 * next-step inbox. That is the last hop this repository controls. A notice
 * present there is delivered; whether a model then READ it is not measured by
 * anything in this file.
 *
 * Run: node --experimental-strip-types src/p9-late-after-probe.ts
 */
import { Context } from '@deepseek-ai/cordis'
import Subprocess from '@deepseek-ai/dsh-subprocess-local'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { KernelService } from './kernel-plugin.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const BROKER = resolve(HERE, 'broker.py')
const PYTHON = process.env['DSH_PYTHON'] ?? 'C:/Users/hzq00/AppData/Local/Programs/Python/Python314/python.exe'
const OUT = process.env['P9_AFTER_OUT']
  ?? resolve(HERE, '..', '..', '..', 'qualification', 'results', 'P9-late', 'after-probe.json')

const sleep = (ms: number): Promise<void> => new Promise(resolvePromise => setTimeout(resolvePromise, ms))

async function main(): Promise<void> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt, { personaPrefix: '' })
  await ctx.plugin(ToolRuntime, { mode: 'native', maxParallelSubCalls: 10 })
  await ctx.plugin(Subprocess)
  const root = await mkdtemp(join(tmpdir(), 'p9-late-after-'))
  const service = new KernelService(ctx, {
    pythonExecutable: PYTHON,
    brokerScript: BROKER,
    root: join(root, 'kernels'),
    durableLedger: false,
    lateNoticeBounds: { records: 4, textBytes: 256, totalBytes: 1024, spillBytes: 4096 },
  })
  const agent = {
    session: { header: { id: 'p9-late-after', cwd: root } },
  } as unknown as Agent

  const observed: Record<string, unknown> = {}
  try {
    // The tool registered the way the profile's preset row registers it.
    const { apply, IPYTHON_TOOL_NAME } = await import('./ipython-tool.ts')
    apply(ctx)
    observed['toolName'] = IPYTHON_TOOL_NAME

    const agentFor = agent
    const call = async (code: string, seq: number): Promise<{
      text: string
      outcome: string
      contexts: string[]
    }> => {
      const result = await ctx.tools.execute({
        callId: ToolCallId(`p9-after-${String(seq)}`),
        name: IPYTHON_TOOL_NAME,
        arguments: { code },
        agent: agentFor,
        signal: new AbortController().signal,
      })
      if (result.isError) return { text: result.error.message, outcome: 'error', contexts: [] }
      const value = result.value as { text: string, outcome: string }
      const contexts = (result.additionalContexts ?? []).flatMap(context =>
        context.content.flatMap(block => block.type === 'text' ? [block.text] : []))
      return { text: value.text, outcome: value.outcome, contexts }
    }

    // ---- turn 1: a cell that leaves a thread writing (S5's exact stimulus) ---
    const first = await call([
      'import threading, time',
      'def background():',
      '    time.sleep(6)',
      '    print("DELIVERY-LATE-MARKER")',
      'threading.Thread(target=background, daemon=True).start()',
      'print("turn1-settled")',
    ].join('\n'), 1)
    observed['turn1_outcome'] = first.outcome
    observed['turn1_text'] = first.text
    observed['turn1_text_mentions_late_marker'] = first.text.includes('DELIVERY-LATE-MARKER')
    observed['turn1_contexts'] = first.contexts
    observed['turn1_context_mentions_late_marker'] = first.contexts.join('\n').includes('DELIVERY-LATE-MARKER')

    // ---- turn 2: an ordinary cell, run BEFORE the thread prints -------------
    const second = await call('print("turn2-settled")', 2)
    observed['turn2_outcome'] = second.outcome
    observed['turn2_text'] = second.text
    observed['turn2_text_mentions_late_marker'] = second.text.includes('DELIVERY-LATE-MARKER')
    observed['turn2_contexts'] = second.contexts

    // The write lands while no cell is running.
    await sleep(8000)

    // ---- turn 3: THE DELIVERY TURN -----------------------------------------
    const third = await call('print("turn3-settled")', 3)
    observed['turn3_outcome'] = third.outcome
    observed['turn3_text'] = third.text
    observed['turn3_text_mentions_late_marker'] = third.text.includes('DELIVERY-LATE-MARKER')
    observed['turn3_contexts'] = third.contexts
    observed['turn3_context_mentions_late_marker'] = third.contexts.join('\n').includes('DELIVERY-LATE-MARKER')

    // ---- the classification accessor, unchanged ----------------------------
    const drained = service.drainUnattributed(agent)
    observed['drainUnattributed_count'] = drained.length
    observed['drainUnattributed_entries'] = drained.map(entry => ({
      cellId: entry.cellId, text: entry.text, epoch: entry.epoch, stream: entry.stream,
    }))

    // ---- the account, after the notice was taken ---------------------------
    observed['lateNoticeAccount'] = service.lateNoticeAccount(agent)

    observed['verdict'] = third.text.includes('DELIVERY-LATE-MARKER')
      ? 'STILL NOT SEPARATE: the late output rode the cell stdout'
      : third.contexts.join('\n').includes('DELIVERY-LATE-MARKER')
        ? 'DELIVERED SEPARATELY: the notice reached the model-visible boundary and the cell stdout excluded it'
        : 'NOT DELIVERED: the late output reached no model-facing text'
  } finally {
    await service.close().catch(() => undefined)
    await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  }

  const text = JSON.stringify(observed, null, 2)
  await writeFile(OUT, text, 'utf8')
  process.stdout.write(text + '\n')
}

await main()
