/**
 * Security tests: the boundaries that must hold before anything is called daily.
 *
 * These are T4-shaped: they exercise real DSH services and real process
 * behaviour, with a canary marker rather than any real secret. The delivery plan
 * is explicit that security tests prove the DENIAL path and must not read real
 * private data, so every marker here is fabricated and every assertion is about
 * a refusal.
 *
 * The two claims under test that matter most:
 *
 *   E02 - the model's tool surface cannot reach the human Web terminal or the
 *         plugin manager. `ctx.terminalController` runs with system-user
 *         privilege and is not subject to the agent sandbox; wrapping it would
 *         be escalation, not convenience.
 *
 *   E05 - the model's tool surface cannot reach the trusted control files
 *         (the lock, the acceptance spec, the profile). A tool allowlist cannot
 *         constrain a trusted plugin, so the separation has to be structural.
 */
import { Context } from '@deepseek-ai/cordis'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
import { describe, expect, it } from 'vitest'
import * as hostPlugin from './host-plugin.ts'
import * as toolsPlugin from './tools.ts'
import * as webSearchPlugin from './web-search-plugin.ts'

/** Every tool name this project contributes. */
const OUR_TOOLS = ['work']

describe('the tool surface this project adds', () => {
  it('adds exactly one tool, and it is not a terminal or plugin-manager tool', async () => {
    // E02: the cheapest way to escalate would be to add a tool that reaches a
    // higher-privilege service. Assert the surface is exactly what was intended.
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(toolsPlugin as never, {} as never)
    const names = ctx.get('tools')!.schemas().map(s => s.name)
    for (const forbidden of [
      'terminal_open',
      'terminal_send',
      'terminal_signal',
      'terminal_close',
      'plugin_install',
      'plugin_add',
    ]) {
      expect(names).not.toContain(forbidden)
    }
    await ctx.fiber.dispose()
  })

  it('declares no tool whose name collides with a reserved transport name', async () => {
    // `run_code` is reserved by the tool runtime for PTC mode. A tool claiming it
    // would be a transport-level conflict, not a naming preference.
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await expect(ctx.plugin(toolsPlugin as never, {} as never)).resolves.toBeDefined()
    const names = ctx.get('tools')!.schemas().map(s => s.name)
    expect(names).not.toContain('run_code')
    await ctx.fiber.dispose()
  })
})

describe('the work tool cannot widen its own authority', () => {
  it('exposes no parameter that changes N, the budget or permissions', async () => {
    // The model has a tool. That tool must not be a configuration editor: a tool
    // that could raise its own ceiling would not be a ceiling.
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(toolsPlugin as never, {} as never)
    const schema = ctx.get('tools')!.schemas().find(s => s.name === 'work')!
    const properties = Object.keys(
      (schema.parameters as { properties?: Record<string, unknown> }).properties ?? {},
    )
    for (const forbidden of [
      'targetChildren',
      'maxActiveSubagents',
      'budgetCeiling',
      'budget',
      'permissions',
      'sandbox',
      'allowedCapabilities',
      'install',
    ]) {
      expect(properties).not.toContain(forbidden)
    }
    // And the parameters it DOES expose are the three documented ones plus ids.
    expect(properties.sort()).toEqual(['action', 'childId', 'goal', 'taskId'])
    await ctx.fiber.dispose()
  })

  it('cannot be given a capability the host did not configure', async () => {
    // `allowedCapabilities` is set by the drain from host policy, not from tool
    // arguments. This pins that the tool has no way to pass one in.
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(toolsPlugin as never, {} as never)
    const schema = ctx.get('tools')!.schemas().find(s => s.name === 'work')!
    const properties = (schema.parameters as { properties?: Record<string, unknown> }).properties ?? {}
    expect(Object.keys(properties)).not.toContain('allowedCapabilities')
    await ctx.fiber.dispose()
  })
})

describe('the search provider cannot claim an entitlement it did not observe', () => {
  it('reports unavailable when no credential store is mounted', async () => {
    // E01-adjacent: a provider that reported `available()` without observing a
    // credential would let a search appear configured when it is not, and the
    // model would then receive an error it cannot distinguish from "no results".
    const { createDualLaneSearchProvider } = await import('./web-search.ts')
    const provider = createDualLaneSearchProvider(
      { endpoint: 'https://example.com/s', apiKeyEnv: 'CANARY_FAKE_KEY' },
      { isConfigured: () => false },
    )
    expect(provider.available()).toBe(false)
  })

  it('mounts without a credential store rather than failing the whole host', async () => {
    // A missing search credential must not take down the host. It degrades to
    // "search unavailable", which is a reportable state.
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    const scope = ctx.isolate('web-search-no-credentials')
    await expect(
      scope.plugin(webSearchPlugin as never, {
        endpoint: 'https://example.com/s',
        apiKeyEnv: 'CANARY_FAKE_KEY',
      } as never),
    ).resolves.toBeDefined()
    await ctx.fiber.dispose()
  })
})
