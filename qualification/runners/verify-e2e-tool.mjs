/**
 * End-to-end probe: create a REAL session on the composed preset and ask what
 * tools it actually carries. This is the surface the model is offered, so it is
 * the only honest answer to "is the work tool wired up".
 *
 * The scope key for a tool view is the AGENT OBJECT, not its context. `AgentLoop`
 * builds the scope with `createScope(loopCtx, this)` where `this` is the agent
 * (packages/core/agent-loop/src/agent.ts:104), and DSH's own PTC harvests with
 * `registry.schemas(exec.agent)` (packages/core/tools/src/ptc.ts:682).
 *
 * Passing `agent.ctx` instead yields a context that owns no scope layer, so the
 * view collapses to the global layer -- which holds zero agent tools. An earlier
 * run of this probe made exactly that mistake and reported a false "toolCount: 0".
 * Both keys are measured here so the contrast is visible in the evidence rather
 * than asserted in a comment.
 */
import { writeFileSync } from 'node:fs'

export const name = 'verify-e2e-tool'
export const inject = ['sessionController']

const OUT = 'D:/DSH/work/dsh-native-daily/qualification/results/M8.5-c2-real-boot/e2e-tool.json'

export async function apply(ctx) {
  const finding = {
    created: false,
    sessionId: null,
    toolCountAgentKey: 0,
    toolCountContextKey: 0,
    workToolPresent: false,
    sample: [],
    error: null,
  }
  try {
    const sc = ctx.get('sessionController')
    const created = await sc.create({ cwd: process.cwd() })
    finding.sessionId = created?.sessionId ?? created?.id ?? null
    finding.created = finding.sessionId !== null

    const agents = ctx.get('agents')
    const agent = agents?.get(finding.sessionId)
    if (agent === undefined) {
      finding.error = 'the created session has no live agent in this process'
    } else {
      const tools = ctx.get('tools')
      // The correct key: the agent object, as DSH's own PTC code uses it.
      const names = tools.schemas(agent).map(s => s.name).sort()
      finding.toolCountAgentKey = names.length
      finding.workToolPresent = names.includes('work')
      // The full list, so the evidence shows the tool rather than asking a
      // reader to trust a boolean. `work` sorts last, so a head-slice would
      // hide exactly the entry this probe exists to prove.
      finding.tools = names
      // The wrong key, measured so the difference is evidence and not folklore.
      finding.toolCountContextKey = tools.schemas(agent.ctx).length
    }
  } catch (e) {
    finding.error = e instanceof Error ? e.message : String(e)
  }
  writeFileSync(OUT, JSON.stringify(finding, null, 2))
  process.stdout.write(`E2E-TOOL: ${JSON.stringify(finding)}\n`)
}
