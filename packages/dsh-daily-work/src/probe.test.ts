import { afterEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import WebRuntime from '@deepseek-ai/dsh-web'
import * as ToolWeb from '@deepseek-ai/dsh-tool-web'
import { createDualLaneSearchProvider } from './web-search.ts'

const servers: Server[] = []
afterEach(async () => {
  for (const s of servers.splice(0)) await new Promise<void>(r => s.close(() => r()))
})

describe('probe r01 search', () => {
  it('drives a real search over loopback through the real tool', async () => {
    const seen: unknown[] = []
    let mode = 'ok'
    const server = createServer((req, res) => {
      let body = ''
      req.on('data', (c: Buffer) => { body += c.toString() })
      req.on('end', () => {
        seen.push(JSON.parse(body))
        if (mode === 'error') { res.writeHead(500, { 'content-type': 'application/json' }); res.end('{"error":"boom"}'); return }
        if (mode === 'empty') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ results: [] })); return }
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ results: [{ url: `https://example.test/${JSON.parse(body).query}`, title: 'T', snippet: 'S' }] }))
      })
    })
    servers.push(server)
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
    const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}/search`

    const ctx = new Context()
    await ctx.plugin(SystemPrompt, {})
    await ctx.plugin(ToolRuntime, {})
    await ctx.plugin(WebRuntime, { searchProvider: 'probe-lane' } as never)
    await ctx.plugin(ToolWeb as never, {} as never)
    ctx.web.registerSearchProvider(createDualLaneSearchProvider(
      { id: 'probe-lane', endpoint, apiKeyEnv: 'SEARCH_KEY' },
      { isConfigured: () => true },
    ))

    const call = (name: string, args: unknown, id: string) => ctx.tools.execute({
      signal: new AbortController().signal, callId: ToolCallId(id), name, arguments: args,
    })
    const two = await call('web_search', { queries: ['alpha', 'beta'] }, 'c1')
    console.log('TWO-QUERY', JSON.stringify(two).slice(0, 900))
    console.log('SEEN', JSON.stringify(seen))
    mode = 'empty'
    const empty = await call('web_search', { queries: ['gamma'] }, 'c2')
    console.log('EMPTY', JSON.stringify(empty).slice(0, 500))
    mode = 'error'
    const err = await call('web_search', { queries: ['delta'] }, 'c3')
    console.log('ERROR', JSON.stringify(err).slice(0, 500))
    await ctx.fiber.dispose()
    expect(true).toBe(true)
  })
})
