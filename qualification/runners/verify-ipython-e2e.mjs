/**
 * Boot-time probe: does `ipython` reach a REAL Session's model-facing tool
 * catalog, through the REAL profile resolver?
 *
 * WHY THIS PROBE EXISTS AND WHY THE VITEST SUITE IS NOT ENOUGH.
 * `packages/dsh-ipython/src/requirements.test.ts` mounts the plugin directly with
 * `ctx.plugin(...)`. That proves the plugin works; it does NOT prove the product
 * loads it. This project already recorded that exact gap as G-FIX-04: two gates
 * passed on direct-mount evidence while the package declared no bundle, so the
 * profile never activated a layer and the plugin was never loaded at all. The
 * lesson recorded in docs/GAPS.md is that a gate whose oracle is weaker than its
 * scenario will pass while the product is broken.
 *
 * So this runs INSIDE a real `dsh --profile daily-candidate` boot, creates a real
 * Session, and asks what tools that Session actually carries.
 *
 * THE SCOPE KEY. The key for a tool view is the AGENT OBJECT, not its context.
 * `AgentLoop` builds the scope with `createScope(loopCtx, this)`
 * (packages/core/agent-loop/src/agent.ts:104) and DSH's own PTC harvests with
 * `registry.schemas(exec.agent)` (packages/core/tools/src/ptc.ts:682). Passing
 * `agent.ctx` yields a key owning no scope layer, so the view collapses to the
 * global layer -- which holds zero agent tools. That false negative is recorded
 * as G-FIX-06, so BOTH keys are measured here and the contrast is evidence rather
 * than folklore.
 */
import { writeFileSync } from 'node:fs'

export const name = 'verify-ipython-e2e'
export const inject = ['sessionController', 'ipython']

const OUT = 'D:/DSH/work/dsh-native-daily/qualification/results/M11-ipython/e2e-tool.json'

export async function apply(ctx) {
  const finding = {
    profileBooted: true,
    kernelServicePresent: false,
    kernelServiceExports: [],
    sessionCreated: false,
    sessionId: null,
    toolCountAgentKey: 0,
    toolCountContextKey: 0,
    ipythonToolPresent: false,
    ipythonParameterNames: null,
    ipythonIsOnlyParameter: false,
    forbiddenLifecycleTools: [],
    tools: [],
    error: null,
  }
  try {
    // (1) The SERVICE, resolved from the host bundle layer.
    const service = ctx.get('ipython')
    finding.kernelServicePresent = service !== undefined
    if (service !== undefined) {
      finding.kernelServiceExports = Object.getOwnPropertyNames(
        Object.getPrototypeOf(service),
      ).filter(n => n !== 'constructor').sort()
    }

    // (2) A REAL Session on the composed preset.
    const sc = ctx.get('sessionController')
    const created = await sc.create({ cwd: process.cwd() })
    finding.sessionId = created?.sessionId ?? created?.id ?? null
    finding.sessionCreated = finding.sessionId !== null

    const agent = ctx.get('agents')?.get(finding.sessionId)
    if (agent === undefined) {
      finding.error = 'the created session has no live agent in this process'
    } else {
      const tools = ctx.get('tools')
      // The correct key: the agent object, exactly as DSH's own PTC code uses it.
      const schemas = tools.schemas(agent)
      const names = schemas.map(s => s.name).sort()
      finding.toolCountAgentKey = names.length
      finding.tools = names
      finding.ipythonToolPresent = names.includes('ipython')

      // The TOOL SHAPE, asserted rather than assumed: one parameter, named code.
      const ipython = schemas.find(s => s.name === 'ipython')
      if (ipython !== undefined) {
        const parameters = ipython.parameters ?? {}
        const properties = Object.keys(parameters.properties ?? {})
        finding.ipythonParameterNames = properties
        finding.ipythonIsOnlyParameter = properties.length === 1 && properties[0] === 'code'
      }

      // No lifecycle tool may exist. A model that can open/close a kernel is a
      // model that can leak or destroy one.
      const forbidden = [
        'ipython_open', 'ipython_send', 'ipython_read', 'ipython_status', 'ipython_close',
      ]
      finding.forbiddenLifecycleTools = names.filter(n => forbidden.includes(n))

      // The wrong key, measured so the difference is evidence.
      finding.toolCountContextKey = tools.schemas(agent.ctx).length
    }
  } catch (e) {
    finding.error = e instanceof Error ? `${e.name}: ${e.message}` : String(e)
  }
  writeFileSync(OUT, JSON.stringify(finding, null, 2))
  process.stdout.write(`IPYTHON-E2E: ${JSON.stringify(finding)}\n`)
}
