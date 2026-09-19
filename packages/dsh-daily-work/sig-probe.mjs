import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { SessionId } from '@deepseek-ai/dsh-session'
import SandboxPolicy from '@deepseek-ai/dsh-sandbox-policy'
import LocalSandboxProvider from '@deepseek-ai/dsh-sandbox-local'
import SubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import TerminalRuntime from '@deepseek-ai/dsh-terminal'
import * as terminalBash from '@deepseek-ai/dsh-terminal-bash'

const sleep = (ms) => new Promise(r => setTimeout(r, ms))

// Token assembled in-shell: the echoed command line contains the two halves
// SEPARATELY, so a match can only come from real output. This is the exact
// guard the test file uses; the first version of this probe forgot it and
// "detected" the echo, which is why this file exists.
const tokenFor = (marker) => "('" + marker.slice(0, 4) + "'+'" + marker.slice(4) + "')"

async function boot(mode, id) {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(SandboxPolicy, { mode })
  await ctx.plugin(LocalSandboxProvider, {})
  await ctx.plugin(SubprocessRuntime, {})
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(TerminalRuntime, {})
  await ctx.plugin(terminalBash, { shellDialect: 'pwsh', timeoutMs: 300000 })
  const owner = await ctx.agentLoop.create(SessionId(id), {}, {})
  return { ctx, owner }
}

async function trial(mode, tag) {
  const r = await boot(mode, 'probe-' + tag)
  const s = await r.ctx.terminals.spawn(r.owner, { type: 'shell' })
  const id = s.sessionId
  const marker = tag + 'ZZ'          // e.g. 'FREE1ZZ'
  const lateToken = marker
  const text = 'Start-Sleep -Seconds 8; Write-Output ' + tokenFor(marker)
  const t0 = Date.now()
  const cell = r.ctx.terminals.startSend(r.owner, id, { text, submit: true })
  await sleep(2500)
  const t1 = Date.now()
  const sig = await r.ctx.terminals.signal(r.owner, id, 'SIGINT')
  const t2 = Date.now()
  const settled = await cell.done
  const t3 = Date.now()
  // Wait past natural completion of the 8s sleep.
  await sleep(Math.max(0, 8000 - (Date.now() - t0)) + 2500)
  const rd = r.ctx.terminals.read(r.owner, id, { offset: 0, count: 300 })
  const survived = rd.text.includes(lateToken)
  const echoOnly = rd.text.includes(marker.slice(0, 4) + "'+'" + marker.slice(4))
  console.log(
    '[' + tag + '] mode=' + mode +
    ' signalMs=' + (t2 - t1) +
    ' sig=' + JSON.stringify(sig) +
    ' settleMs=' + (t3 - t0) +
    ' waitReason=' + settled.waitReason +
    ' COMMAND_SURVIVED=' + survived +
    ' (echoOnlyForm=' + echoOnly + ')',
  )
  if (survived) {
    const tail = rd.text.split('\n').slice(-6).map(l => JSON.stringify(l)).join('\n    ')
    console.log('    scrollback tail:\n    ' + tail)
  }
  await r.ctx.terminals.kill(r.owner, id, 'cleanup').catch(() => {})
  await r.ctx.fiber.dispose()
  return survived
}

const results = []
console.log('=== unconfined (danger-full-access) ===')
results.push(['FREE1', await trial('danger-full-access', 'FREE1')])
results.push(['FREE2', await trial('danger-full-access', 'FREE2')])

console.log('=== confined (workspace-write) ===')
results.push(['WW1', await trial('workspace-write', 'WW1')])
results.push(['WW2', await trial('workspace-write', 'WW2')])
results.push(['WW3', await trial('workspace-write', 'WW3')])

console.log('=== SUMMARY ===')
for (const [tag, survived] of results) console.log(tag + ' commandSurvivedInterrupt=' + survived)
console.log('DONE')
