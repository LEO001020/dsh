import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { LlmAdapter, createUserMessage, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId, foldRequestHeader } from '@deepseek-ai/dsh-session'

class Scripted extends LlmAdapter {
  requests: GenerateOptions[] = []
  constructor(private script: StreamChunk[][]) { super() }
  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const entry = this.script.shift()
    if (!entry) throw new Error('script exhausted')
    for (const c of entry) yield c
  }
}
function text(t: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'block-end', index: 0, block: { type: 'text', text: t } },
    { type: 'usage', usage: { inputTokens: 5, outputTokens: 5 } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

describe('probe r07', () => {
  it('dynamic context provider change reaches the wire as a user message only', async () => {
    let marker = 'ALPHA'
    const ctx = new Context()
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(AgentLoop, { agents: [] })
    const adapter = new Scripted([text('one'), text('two'), text('three')])
    ctx.llm.registerAdapter(['mock'], adapter)
    ctx.systemPrompt.context({ name: 'probe:dyn', order: 100, text: () => `marker=${marker}` })
    const agent = await ctx.agentLoop.create(SessionId('r7'), { provider: 'mock', model: 'mock' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'turn1' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    const gen1 = agent.session.surface.contentGeneration
    marker = 'BETA'
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'turn2' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    const gen2 = agent.session.surface.contentGeneration
    const ev = agent.session.snapshotEvents()
    console.log('GEN', gen1, gen2)
    console.log('HEADERS', JSON.stringify(ev.filter(e => e.type === 'request/header').map(e => ({ seq: e.seq, reason: (e.data as {reason: string}).reason }))))
    console.log('REQ1 msgs', JSON.stringify(adapter.requests[0]?.messages.map(m => ({ role: m.role, t: m.content.map(c => (c as {type:string}).type) }))))
    console.log('REQ2 msgs', JSON.stringify(adapter.requests[1]?.messages.map(m => ({ role: m.role, txt: m.content.filter(c => c.type === 'text').map(c => (c as {text:string}).text.slice(0, 60)) }))))
    console.log('TOOLS equal', JSON.stringify(adapter.requests[0]?.tools) === JSON.stringify(adapter.requests[1]?.tools))
    console.log('SYS equal', JSON.stringify(adapter.requests[0]?.messages[0]) === JSON.stringify(adapter.requests[1]?.messages[0]))
    console.log('PROMPT1', JSON.stringify(adapter.requests[0]?.messages[0]?.content))
    expect(ev.length).toBeGreaterThan(0)
    await ctx.fiber.dispose()
  })
})
