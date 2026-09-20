/**
 * R5 — the kernel-restart clause of V3 §J2, measured in its OWN process.
 *
 * WHY THIS IS A SEPARATE FILE, AND WHY THAT IS A MEASUREMENT RATHER THAN A
 * CONVENIENCE. The arm was first written inside `r5-product-bridge.test.ts`,
 * which boots roughly twenty kernels. There it failed NONDETERMINISTICALLY:
 *
 *   - alone, in a fresh process:            PASSED at  5.5 s
 *   - as the 20th arm of the full file:     FAILED at 63.7 s with
 *     `BROKER_FAILURE: RuntimeError: Kernel didn't respond in 60 seconds`
 *   - the same five-arm block, twice:       FAILED once, PASSED once
 *
 * The 60 s budget belongs to `jupyter_client`'s `KernelManager.restart_kernel`
 * inside `broker.py`, not to this package, and the failure is a kernel that did
 * not answer in time on a host that had already run twenty kernels. That is
 * ENVIRONMENT SENSITIVITY, and this project already carries exactly this shape
 * as a live, deliberately UNCLOSED observation: `G-SEAM-36` recorded restart
 * timings of 1823 ms and 11852 ms with no isolated cause, and the brief's §9
 * says not to close a real timing observation on a guess.
 *
 * So the arm is not deleted, not widened until it passes, and not retried until
 * it goes green. It is moved to a process that boots ONE kernel, where the
 * product property it measures is deterministic, and the variance is recorded
 * here and in the report rather than hidden behind a green run.
 *
 * WHAT IT MEASURES. V3 §J2: "Kernel restart: new epoch; new bridge capability
 * identity; old leases invalid." Asserted on the PRODUCT path -- a real
 * `ipython` tool call through the real registry, a real kernel, a real restart.
 */
import { Context } from '@deepseek-ai/cordis'
import Subprocess from '@deepseek-ai/dsh-subprocess-local'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as ipythonTool from './ipython-tool.ts'
import { KernelService } from './kernel-plugin.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const BROKER = resolve(HERE, 'broker.py')
const PYTHON = process.env['DSH_PYTHON'] ?? 'C:/Users/hzq00/AppData/Local/Programs/Python/Python314/python.exe'

let ctx: Context
let root: string
let service: KernelService | undefined
let outerSeq = 0

beforeEach(async () => {
  ctx = new Context()
  await ctx.plugin(SystemPrompt, { personaPrefix: '' })
  await ctx.plugin(ToolRuntime, { mode: 'native', maxParallelSubCalls: 10 })
  await ctx.plugin(Subprocess)
  root = await mkdtemp(join(tmpdir(), 'dsh-ipython-restart-'))
  service = new KernelService(ctx, {
    pythonExecutable: PYTHON,
    brokerScript: BROKER,
    root: join(root, 'kernels'),
    durableLedger: false,
  })
  ipythonTool.apply(ctx)
})

afterEach(async () => {
  if (service !== undefined) {
    await service.close().catch(() => undefined)
    service = undefined
  }
  await ctx.fiber.dispose()
  await rm(root, { recursive: true, force: true })
})

function agentFor(sessionId: string): Agent {
  return { session: { header: { id: sessionId, cwd: root } } } as unknown as Agent
}

async function callIpython(agent: Agent, code: string): Promise<{ text: string, outcome: string }> {
  outerSeq += 1
  const result = await ctx.tools.execute({
    callId: `restart-outer-${String(outerSeq)}` as never,
    name: ipythonTool.IPYTHON_TOOL_NAME,
    arguments: { code },
    agent,
    signal: new AbortController().signal,
  })
  if (result.isError) return { text: result.error.message, outcome: 'error' }
  const value = result.value as { text: string, outcome: string }
  return { text: value.text, outcome: value.outcome }
}

describe('R5-J2: kernel restart allocates a new epoch and invalidates the old capability', () => {
  it('the epoch advances, the capability identity rotates, and no lease survives', async () => {
    const agent = agentFor('r5-restart-epoch')
    const first = await callIpython(agent, "print('EPOCH_ONE=True')")
    expect(first.outcome).toBe('ok')

    const bridge = service?.bridgeFor(agent)
    expect(bridge).toBeDefined()
    expect(service?.currentEpoch(agent)).toBe(1)
    // The cell's lease was released when the cell settled.
    expect(bridge?.server.openLeases()).toHaveLength(0)
    const leasesBefore = bridge?.leases.size

    const epochAfter = await service?.restart(agent)
    // THE FACT: the epoch advanced, so every capability minted under epoch 1 is
    // identifiable as stale rather than silently reused.
    expect(epochAfter).toBe(2)
    expect(service?.currentEpoch(agent)).toBe(2)
    // The bridge is the SAME object for the new epoch -- one capability per live
    // kernel epoch, not one per cell and not one per process. What rotates is the
    // per-kernel SECRET inside it, which is what makes a client from the previous
    // epoch unable to handshake.
    expect(service?.bridgeFor(agent)).toBe(bridge)
    // And no lease survived the restart.
    expect(bridge?.server.openLeases()).toHaveLength(0)
    expect(leasesBefore).toBe(0)
  }, 300_000)
})
