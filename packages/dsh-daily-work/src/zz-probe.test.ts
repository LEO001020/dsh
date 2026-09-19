import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import Group from '@deepseek-ai/cordis-plugin-group'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import AgentPresets, { SHIPPED_PRESET_ROOT } from '@deepseek-ai/dsh-agent-presets'
import { it, expect } from 'vitest'

it('mounts the REAL shipped standard + minimal presets', async () => {
  const home = await mkdtemp(join(tmpdir(), 'zz4-home-')); process.env.DSH_HOME = home
  const ctx = new Context()
  ctx.baseUrl = pathToFileURL('D:/DSH/src/dsh-src/apps/cli/').href
  await ctx.plugin(Loader); ctx.loader.builtins.include = Include; ctx.loader.builtins.group = Group
  await ctx.plugin(LlmRuntime); await ctx.plugin(SessionStore); await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt, {}); await ctx.plugin(ToolRuntime); await ctx.plugin(TokenMeter)
  await ctx.plugin(AgentRegistry); await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(AgentPresets, { default: 'standard', roots: [], includeShippedRoot: true, includeUserRoot: false })
  const mk = async (id: string, p: string): Promise<Agent> => (await ctx.agents.create({ sessionId: SessionId(id), setup: async (c: Context) => { await ctx.agentPresets.mount(c, p) } })).agent
  let stdTools: string[] = []
  try {
    const s = await mk('ss','standard')
    stdTools = ctx.tools.schemas(s).map(x=>x.name).sort()
    console.log('STANDARD tools', stdTools.length, stdTools)
  } catch (e) { console.log('STANDARD FAILED:', String(e).slice(0, 1500)) }
  try {
    const m = await mk('sm','minimal')
    console.log('MINIMAL tools', ctx.tools.schemas(m).map(x=>x.name).sort())
  } catch (e) { console.log('MINIMAL FAILED:', String(e).slice(0, 1200)) }
  await ctx.fiber.dispose()
  await rm(home, { recursive: true, force: true })
}, 120000)
