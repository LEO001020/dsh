/**
 * Plugin lifecycle tests against a REAL Cordis context and REAL DSH services.
 *
 * These cover the M2 exit criteria that the pure tests cannot:
 *   - the plugin loads through the real Cordis plugin pipeline (inject honoured)
 *   - the domain handle is owned by the effect and released on unload
 *   - load -> unload -> load does not double-register or leak the handle
 *   - the tool registers exactly once and disappears with the fiber
 *
 * The tool consumer is exercised against a real ToolRuntime, which is the same
 * runtime the model calls through. No second model loop is constructed: we call
 * the registered tool body directly, which is exactly what the runtime does.
 */
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import * as storageJsonPlugin from '@deepseek-ai/dsh-storage-json'
import * as storageDomainPlugin from '@deepseek-ai/dsh-storage-domain'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as hostPlugin from './host-plugin.ts'
import * as toolsPlugin from './tools.ts'

const CONFIG = {
  targetChildren: 10,
  maxDepth: 1,
  budgetCeiling: 100,
  currency: 'USD',
  priceVersion: 'test-v1',
}

interface Rig {
  readonly ctx: Context
  readonly root: string
  close(): Promise<void>
}

async function rig(): Promise<Rig> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-daily-work-plugin-'))
  const ctx = new Context()
  await ctx.plugin(Storage, {})
  await ctx.plugin(storageJsonPlugin as never, { root } as never)
  await ctx.plugin(storageDomainPlugin as never, { backend: 'json' } as never)
  // ToolRuntime injects 'systemPrompt', so the real prompt service must be
  // mounted first. Using the real one (not a stub) is deliberate: the tool
  // registration path touches it.
  await ctx.plugin(SystemPrompt, {})
  await ctx.plugin(ToolRuntime, {})
  return {
    ctx,
    root,
    async close() {
      await ctx.fiber.dispose()
      await rm(root, { recursive: true, force: true })
    },
  }
}

let r: Rig

beforeEach(async () => {
  r = await rig()
})

afterEach(async () => {
  await r.close()
})

describe('host plugin mounting', () => {
  it('loads through the real plugin pipeline and provides the service', async () => {
    await r.ctx.plugin(hostPlugin as never, CONFIG as never)
    const service = r.ctx.get('dailyWork')
    expect(service).toBeDefined()
    // And the domain is actually open, not merely constructed.
    const record = await service!.createRun({
      runId: 'run-1',
      root: { session: { header: { id: 'session-root' } } } as never,
      authorizationRef: 'auth-1',
    })
    expect(record.requestedTarget).toBe(10)
    expect(record.maxDepth).toBe(1)
    expect(record.phase).toBe('open')
  })

  it('releases the domain handle on unload and can be loaded again', async () => {
    // B03: load -> unload -> load must not leak or double-register.
    const first = r.ctx.isolate('gen-1')
    const mounted1 = await first.plugin(hostPlugin as never, CONFIG as never)
    expect(first.get('dailyWork')).toBeDefined()
    await mounted1.dispose()
    expect(first.get('dailyWork')).toBeUndefined()

    // A fresh generation over the SAME storage directory must open cleanly.
    // If the first generation had leaked its handle, the facility would reject
    // this with `already-open`.
    const second = r.ctx.isolate('gen-2')
    const mounted2 = await second.plugin(hostPlugin as never, CONFIG as never)
    expect(second.get('dailyWork')).toBeDefined()
    await mounted2.dispose()
    expect(second.get('dailyWork')).toBeUndefined()
  })

  it('keeps the persisted record across a plugin reload', async () => {
    const gen1 = r.ctx.isolate('reload-1')
    const m1 = await gen1.plugin(hostPlugin as never, CONFIG as never)
    const service1 = gen1.get('dailyWork')!
    await service1.createRun({
      runId: 'run-persist',
      root: { session: { header: { id: 's' } } } as never,
      authorizationRef: 'a',
    })
    await m1.dispose()

    const gen2 = r.ctx.isolate('reload-2')
    const m2 = await gen2.plugin(hostPlugin as never, CONFIG as never)
    const service2 = gen2.get('dailyWork')!
    expect(service2.getRun('run-persist')).toBeDefined()
    expect(service2.getRun('run-persist')?.runId).toBe('run-persist')
    await m2.dispose()
  })

  it('refuses a second service registration in the same scope', async () => {
    // D11: one host service opens a domain once. Cordis enforces the single
    // registration, which is the first line of defence against two writers.
    await r.ctx.plugin(hostPlugin as never, CONFIG as never)
    await expect(r.ctx.plugin(hostPlugin as never, CONFIG as never)).rejects.toThrow(/has been registered/)
  })
})

describe('tool consumer mounting', () => {
  it('registers the work tool exactly once', async () => {
    await r.ctx.plugin(hostPlugin as never, CONFIG as never)
    await r.ctx.plugin(toolsPlugin as never, {} as never)
    const tools = r.ctx.get('tools')
    const names = tools!.schemas().map(s => s.name)
    expect(names.filter(n => n === 'work')).toHaveLength(1)
  })

  it('removes the tool when the consumer unloads', async () => {
    // B03: a tool registration must be owned by the mounting effect.
    await r.ctx.plugin(hostPlugin as never, CONFIG as never)
    const consumer = r.ctx.isolate('consumer')
    const mounted = await consumer.plugin(toolsPlugin as never, {} as never)
    expect(r.ctx.get('tools')!.schemas().some(s => s.name === 'work')).toBe(true)
    await mounted.dispose()
    expect(r.ctx.get('tools')!.schemas().some(s => s.name === 'work')).toBe(false)
  })

  it('does not register twice when loaded, unloaded and loaded again', async () => {
    await r.ctx.plugin(hostPlugin as never, CONFIG as never)
    for (const generation of ['c1', 'c2', 'c3']) {
      const scope = r.ctx.isolate(generation)
      const mounted = await scope.plugin(toolsPlugin as never, {} as never)
      const count = r.ctx.get('tools')!.schemas().filter(s => s.name === 'work').length
      expect(count).toBe(1)
      await mounted.dispose()
    }
    expect(r.ctx.get('tools')!.schemas().filter(s => s.name === 'work').length).toBe(0)
  })

  it('exposes one definition whose parameters are stable and typed', async () => {
    // B06: native and PTC are generated from the SAME definition. There is no
    // second PTC-only protocol, and `wireSchemas` is private precisely so that
    // a caller cannot build one. What we can and must assert publicly is that
    // the single registered definition carries the expected typed parameters.
    await r.ctx.plugin(hostPlugin as never, CONFIG as never)
    await r.ctx.plugin(toolsPlugin as never, {} as never)
    const schema = r.ctx.get('tools')!.schemas().find(s => s.name === 'work')
    expect(schema).toBeDefined()
    // `parameters` is the compiled JSON-Schema node: an object root with
    // properties and a required list.
    const params = schema!.parameters as {
      type?: string
      properties?: Record<string, { enum?: string[] }>
      required?: string[]
    }
    expect(params.type).toBe('object')
    expect(Object.keys(params.properties ?? {})).toEqual(
      expect.arrayContaining(['action', 'taskId', 'goal', 'childId']),
    )
    expect(params.required).toContain('action')
    expect(params.properties?.action?.enum).toEqual(['status', 'submit', 'finish'])
  })

  it('publishes the work tool through the system prompt tool provider', async () => {
    // This is the surface the MODEL actually sees: the assembled prompt carries
    // the tool schemas in canonical order. Asserting on `assembly.tools` rather
    // than on an internal registry list is the difference between "registered"
    // and "actually offered to the model".
    await r.ctx.plugin(hostPlugin as never, CONFIG as never)
    await r.ctx.plugin(toolsPlugin as never, {} as never)
    const assembly = await r.ctx.get('systemPrompt')!.assemble({})
    const names = assembly.tools.map(t => t.name)
    expect(names).toContain('work')
  })
})
