import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import Group from '@deepseek-ai/cordis-plugin-group'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import AgentPresets from '@deepseek-ai/dsh-agent-presets'
import { createUserMessage, LlmAdapter, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

class A extends LlmAdapter {
  calls = 0
  override async resolveModel(p: string, m: string) { return { provider: p, id: m, name: m } }
  async * stream(_o: GenerateOptions): AsyncIterable<StreamChunk> {
    this.calls += 1
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'x' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

describe('dbg u04', () => {
  it('drive turn', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dbgu04-'))
    writeFileSync(join(root, 'row.mjs'), `
export const name='r'
export const inject=['tools']
export function apply(ctx,cfg){ ctx.effect(()=>ctx.tools.register({name:cfg.tool,description:'d',parameters:{type:'object',properties:{},additionalProperties:false},output:{schema:{type:'string'},render:(_a,v)=>[{type:'text',text:String(v)}]},execute:()=>Promise.resolve(cfg.tool)})) }
`)
    const c0 = join(root, 'c0'); mkdirSync(c0)
    writeFileSync(join(c0, 'agent.cordis.yml'), "- id: base-tool\n  name: '../row.mjs'\n  config:\n    tool: base_read\n")
    const ctx = new Context()
    ctx.baseUrl = new URL('file:///D:/DSH/src/dsh-src/')
    await ctx.plugin(Loader)
    ctx.loader.builtins.include = Include
    ctx.loader.builtins.group = Group
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(AgentPresets, { default: 'c0', roots: [{ path: root, trust: 'user' }], includeShippedRoot: false, includeUserRoot: false })
    const adapter = new A()
    ctx.llm.registerAdapter(['scripted'], adapter)
    const h = await ctx.agents.create({
      sessionId: SessionId('dbg'),
      setup: async (c: Context) => void await ctx.agentPresets.mount(c, 'c0'),
    })
    const a = h.agent
    console.log('tools:', JSON.stringify(ctx.tools.schemas(a).map(s => s.name)))
    a.followup(createUserMessage({ content: [{ type: 'text', text: 'task' }], source: { kind: 'plugin', plugin: 'dbg', form: 'prompt' } }))
    await a.whenIdle()
    console.log('CALLS:', adapter.calls)
    console.log('status:', a.status)
    console.log('events:', a.session.events?.length ?? 'n/a')
    const evs = []
    for (const e of a.session.events ?? []) evs.push(e.type)
    console.log('event types:', JSON.stringify(evs.slice(-15)))
    await ctx.fiber.dispose()
    expect(true).toBe(true)
  }, 120000)
})
