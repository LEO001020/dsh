/**
 * IPY-13 DELIVERY probe: does the classified-late output ever REACH the model?
 *
 * WHY THIS IS SEPARATE FROM THE CLASSIFICATION GATE. `s5-ipy13.test.ts` and
 * `v3-spec-gates` CLAUSE 2 measure that late output is CLASSIFIED separately.
 * That is half the oracle. The other half is that it is *reported*, and the tool
 * tells the model so in its own description (`ipython-tool.ts:183`):
 *
 *   "Output written by a background thread after the cell returns is NOT part of
 *    the result. It is reported separately as unattributed output."
 *
 * This probe drives the SERVICE and the TOOL -- the layers the product actually
 * uses -- and asks what the MODEL-FACING TEXT contains. It is the difference
 * between "the mechanism exists" and "the product delivers it", which is the
 * defect class this project has recorded more than twelve times.
 *
 * Run: node --experimental-strip-types src/s5-ipy13-delivery-probe.ts
 */
import { Context } from '@deepseek-ai/cordis'
import Subprocess from '@deepseek-ai/dsh-subprocess-local'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { KernelService } from './kernel-plugin.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const BROKER = resolve(HERE, 'broker.py')
const PYTHON = process.env['DSH_PYTHON'] ?? 'C:/Users/hzq00/AppData/Local/Programs/Python/Python314/python.exe'
const OUT = process.env['S5_DELIVERY_OUT']
  ?? resolve(HERE, '..', '..', '..', 'qualification', 'results', 'S5-ipy13', 'delivery-probe.json')

const sleep = (ms: number): Promise<void> => new Promise(resolvePromise => setTimeout(resolvePromise, ms))

async function main(): Promise<void> {
  const ctx = new Context()
  await ctx.plugin(Subprocess)
  const root = await mkdtemp(join(tmpdir(), 's5-ipy13-delivery-'))
  const service = new KernelService(ctx, { pythonExecutable: PYTHON, brokerScript: BROKER, root })
  const agent = {
    session: { header: { id: 's5-ipy13-delivery', cwd: root } },
  } as unknown as Agent

  const observed: Record<string, unknown> = {}
  try {
    // Register the model-facing tool exactly as the product does, so the text is
    // obtained the way the model obtains it.
    const { apply, IPYTHON_TOOL_NAME } = await import('./ipython-tool.ts')
    const registered: Array<{ name: string, definition: unknown }> = []
    const toolCtx = {
      tools: {
        register(definition: { name: string }) {
          registered.push({ name: definition.name, definition })
          return () => undefined
        },
      },
      get: (name: string) => (name === 'ipython' ? service : undefined),
    }
    apply(toolCtx as never)
    observed['toolName'] = IPYTHON_TOOL_NAME
    observed['toolRegistered'] = registered.length

    const definition = registered[0]?.definition as {
      execute: (args: unknown, exec: unknown) => Promise<{ text: string, outcome: string }>
    }

    // ---- the model's turn 1: a cell that leaves a thread writing -----------
    const first = await definition.execute(
      {
        code: [
          'import threading, time',
          'def background():',
          '    time.sleep(0.8)',
          '    print("DELIVERY-LATE-MARKER")',
          'threading.Thread(target=background, daemon=True).start()',
          'print("turn1-settled")',
        ].join('\n'),
      },
      { agent, signal: new AbortController().signal, callId: 'call-1', rootCallId: 'root-1' },
    )
    observed['turn1_outcome'] = first.outcome
    observed['turn1_text'] = first.text
    observed['turn1_text_mentions_late_marker'] = first.text.includes('DELIVERY-LATE-MARKER')

    // The write lands while no cell is running.
    await sleep(2000)

    // ---- the model's turn 2: an ordinary cell ------------------------------
    // The question is whether the unattributed output is delivered here, or
    // anywhere the model can see it.
    const second = await definition.execute(
      { code: 'print("turn2-settled")' },
      { agent, signal: new AbortController().signal, callId: 'call-2', rootCallId: 'root-1' },
    )
    observed['turn2_outcome'] = second.outcome
    observed['turn2_text'] = second.text
    observed['turn2_text_mentions_late_marker'] = second.text.includes('DELIVERY-LATE-MARKER')

    // ---- is it retrievable at all? ----------------------------------------
    // `drainUnattributed` is the only accessor. If the PRODUCT never calls it,
    // the output is classified and then dropped on the floor.
    const drained = service.drainUnattributed(agent)
    observed['drainUnattributed_after_two_turns'] = drained.map(entry => ({
      cellId: entry.cellId, text: entry.text, epoch: entry.epoch,
    }))
    observed['drainUnattributed_count'] = drained.length

    observed['verdict'] = first.text.includes('DELIVERY-LATE-MARKER') || second.text.includes('DELIVERY-LATE-MARKER')
      ? 'DELIVERED: the late output reached the model-facing text'
      : 'NOT DELIVERED: the late output was classified and then reached no model-facing text'
  } finally {
    await service.close().catch(() => undefined)
    await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  }

  const text = JSON.stringify(observed, null, 2)
  if (OUT !== undefined) await writeFile(OUT, text, 'utf8')
  process.stdout.write(text + '\n')
}

await main()
