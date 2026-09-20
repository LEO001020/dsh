/**
 * The host-level service: `ctx.ipython`.
 *
 * WHAT THIS COVERS THAT `requirements.test.ts` DOES NOT. That file tests the
 * KernelHost, which knows about one kernel. This file tests the REGISTRY: that a
 * kernel is bound to a Session rather than to an Agent object, that two Sessions
 * get two namespaces, that the identity rule refuses a kernel built under a
 * different execution world, and that shutdown is complete.
 *
 * WHY SESSION AND NOT AGENT. The architecture document is explicit that kernel
 * identity is `Session + executionWorld + environmentDigest + kernelEpoch` and
 * that keying by Agent is wrong, because a continuable child's activation can end
 * and release its AgentHandle while its Session remains usable. The test below
 * builds exactly that situation with a minimal Agent stand-in: two DIFFERENT
 * Agent objects sharing one Session id must reach the SAME kernel.
 */
import { Context } from '@deepseek-ai/cordis'
import Subprocess from '@deepseek-ai/dsh-subprocess-local'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { KernelService } from './kernel-plugin.ts'
import { KernelTransportError } from './kernel.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const BROKER = resolve(HERE, 'broker.py')
const PYTHON = process.env['DSH_PYTHON'] ?? 'C:/Users/hzq00/AppData/Local/Programs/Python/Python314/python.exe'

let ctx: Context
let root: string
let service: KernelService | undefined

beforeEach(async () => {
  ctx = new Context()
  await ctx.plugin(Subprocess)
  root = await mkdtemp(join(tmpdir(), 'dsh-ipython-service-'))
})

afterEach(async () => {
  if (service !== undefined) {
    await service.close().catch(() => undefined)
    service = undefined
  }
  await ctx.fiber.dispose()
  await rm(root, { recursive: true, force: true })
})

/**
 * The smallest object the service needs: a Session header with an id.
 *
 * `KernelService` reads `agent.session.header.id` and nothing else, so a full
 * Agent would add no coverage -- it would only require a model loop, which this
 * project forbids building a second of.
 */
function agentFor(sessionId: string): Agent {
  return { session: { header: { id: sessionId } } } as unknown as Agent
}

function makeService(overrides: { executionWorld?: string, environmentDigest?: string } = {}): KernelService {
  service = new KernelService(ctx, {
    pythonExecutable: PYTHON,
    brokerScript: BROKER,
    root,
    // A GENUINE DEVELOPMENT HOST, so the non-durable ledger is opted into
    // EXPLICITLY (V5 §11.1). This file's subject is the registry and kernel
    // identity -- which kernel a Session resolves to, whether a changed
    // execution world is refused -- and it mounts no storage domain. Since the
    // durable ledger became REQUIRED, an unset `durableLedger` here would refuse
    // every kernel, which would test nothing about the registry. The durable
    // path has its own gate (`p10-ledger-durable.test.ts`), including the
    // control arm that proves the durable default still works.
    durableLedger: false,
    ...overrides,
  })
  return service
}

describe('ctx.ipython: the kernel registry', () => {
  it('the service registers as ctx.ipython through the plugin path', async () => {
    // Uses the real plugin entry point rather than constructing the class, so the
    // registration name is exercised as the host would exercise it.
    const plugin = await import('./kernel-plugin.ts')
    expect(plugin.KernelService).toBeDefined()
    makeService()
    expect(ctx.get('ipython')).toBeDefined()
  })

  it('two Sessions get two namespaces, and neither sees the other', async () => {
    const s = makeService()
    const first = agentFor('session-a')
    const second = agentFor('session-b')

    await s.runCell(first, 'private_value = "only-in-a"')
    await s.runCell(second, 'print("b sees private_value:", "private_value" in dir())')

    // The assertion is on the OTHER session's output, so a shared kernel would
    // fail here rather than passing by accident.
    const bResult = await s.runCell(second, 'print("b check:", "private_value" in dir())')
    expect(bResult.stdout.text).toContain('b check: False')

    const aResult = await s.runCell(first, 'print("a check:", private_value)')
    expect(aResult.stdout.text).toContain('a check: only-in-a')
  }, 240_000)

  it('a NEW Agent object on the SAME Session reaches the SAME kernel', async () => {
    // This is the continuable-child case: the AgentHandle is released and a new
    // Agent incarnation is created for the same Session. Keying the kernel by the
    // Agent object would silently give it an empty namespace.
    const s = makeService()
    await s.runCell(agentFor('session-continuable'), 'carried_over = "from the first incarnation"')

    const newIncarnation = agentFor('session-continuable')
    const result = await s.runCell(newIncarnation, 'print("carried:", carried_over)')
    expect(result.outcome).toBe('ok')
    expect(result.stdout.text).toContain('carried: from the first incarnation')
  }, 180_000)

  it('a changed execution world is refused rather than served by the old kernel', async () => {
    // The identity rule is enforced in `KernelService.entryFor`, which compares
    // the identity the kernel was built with against the one the current
    // configuration produces. Changing the world under a live kernel must be
    // refused: a namespace built under one authority must not serve another.
    const s = makeService({ executionWorld: 'world-one' })
    const agent = agentFor('session-world')
    await s.runCell(agent, 'x = 1')
    expect(s.hasKernel(agent)).toBe(true)

    // The host reconfigures the execution world while the kernel is live.
    s.reconfigure({
      pythonExecutable: PYTHON,
      brokerScript: BROKER,
      root,
      executionWorld: 'world-two',
    })
    await expect(s.runCell(agent, 'x = 2')).rejects.toBeInstanceOf(KernelTransportError)
    // And the kernel is still the OLD one: the refusal did not quietly replace it.
    expect(s.hasKernel(agent)).toBe(true)
  }, 180_000)

  it('a second service registration on one context is refused, preventing split-brain', async () => {
    // Two registries over the same kernels would mean two things could each
    // believe they own a Session's kernel. Cordis refuses the duplicate, and this
    // test pins that the refusal is what protects the single-registry invariant.
    makeService()
    expect(() => new KernelService(ctx, {
      pythonExecutable: PYTHON,
      brokerScript: BROKER,
      root,
    })).toThrow()
  })

  it('evict removes the kernel and reports whether one existed', async () => {
    const s = makeService()
    const agent = agentFor('session-evict')
    expect(s.hasKernel(agent)).toBe(false)
    await s.runCell(agent, 'x = 1')
    expect(s.hasKernel(agent)).toBe(true)
    expect(await s.evict(agent)).toBe(true)
    expect(s.hasKernel(agent)).toBe(false)
    // A second evict has nothing to do and says so rather than throwing.
    expect(await s.evict(agent)).toBe(false)
  }, 180_000)

  it('currentEpoch does not start a kernel, so a status read has no side effect', async () => {
    const s = makeService()
    const agent = agentFor('session-epoch')
    expect(s.currentEpoch(agent)).toBe(0)
    expect(s.hasKernel(agent)).toBe(false)
    // Still zero and still absent: reading the epoch must not be what creates the
    // kernel, or a mere status check would consume a kernel slot.
    expect(s.currentEpoch(agent)).toBe(0)
    expect(s.hasKernel(agent)).toBe(false)
  })

  it('close shuts down every kernel it owns', async () => {
    const s = makeService()
    await s.runCell(agentFor('session-close-a'), 'x = 1')
    await s.runCell(agentFor('session-close-b'), 'y = 2')
    expect(s.listSessions()).toHaveLength(2)
    await s.close()
    expect(s.listSessions()).toHaveLength(0)
    service = undefined
  }, 240_000)

  it('a cancelled cell is refused before it is sent, not abandoned mid-flight', async () => {
    const s = makeService()
    const agent = agentFor('session-cancel')
    const controller = new AbortController()
    controller.abort()
    // Abandoning a dispatched cell would leave the kernel running it while the
    // model believed it had stopped, so the refusal has to happen up front.
    await expect(s.runCell(agent, 'import time; time.sleep(5)', controller.signal))
      .rejects.toBeInstanceOf(KernelTransportError)
  }, 120_000)
})
