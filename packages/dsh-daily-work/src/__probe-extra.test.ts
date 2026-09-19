import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import { describe, expect, it } from 'vitest'

const signal = new AbortController().signal

describe('probe extra args', () => {
  it('open object root ignores undeclared params', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt, {})
    await ctx.plugin(ToolRuntime, {})
    const seen: unknown[] = []
    ctx.tools.register(defineTool({
      name: 'work', description: 'w',
      parameters: { action: { type: 'string', required: true, enum: ['status'] } },
      output: {
        schema: { type: 'object', additionalProperties: false, properties: { action: { type: 'string', required: true } } },
        render: (_a, v) => [{ type: 'text', text: JSON.stringify(v) }],
      },
      execute(args) { seen.push(args); return Promise.resolve({ action: args.action }) },
    }))
    const r = await ctx.tools.execute({
      callId: ToolCallId('c'), name: 'work',
      arguments: { action: 'status', targetChildren: 999, budgetCeiling: 1 }, signal,
    })
    console.log('isError', r.isError, 'value', JSON.stringify(r.isError ? null : r.value), 'err', r.isError ? r.error.message : '')
    console.log('seen by body:', JSON.stringify(seen))
    // what does an unknown enum value do?
    const r2 = await ctx.tools.execute({ callId: ToolCallId('c2'), name: 'work', arguments: { action: 'bogus' }, signal })
    console.log('bad enum isError', r2.isError, 'code', r2.isError ? JSON.stringify(r2.error.info) : '', 'msg', r2.isError ? r2.error.message : '')
    const r3 = await ctx.tools.execute({ callId: ToolCallId('c3'), name: 'work', arguments: { nope: 1 }, signal })
    console.log('missing required isError', r3.isError, 'code', r3.isError ? JSON.stringify(r3.error.info) : '', 'msg', r3.isError ? r3.error.message : '')
    await ctx.fiber.dispose()
  }, 60_000)
})
