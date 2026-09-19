/**
 * Boot-time probe: does the DELIVERABLE profile's own composition put `ipython`
 * and `work` in a real Session's model-facing tool catalog?
 *
 * WHY THIS PROBE EXISTS AND WHY THE EARLIER EVIDENCE WAS NOT ENOUGH.
 * `qualification/results/M11-ipython/e2e-tool.json` proves the `ipython` tool
 * reaches a real Session's catalog -- but it got there through
 * `verify-ipython-e2e.patch.yml`, a VERIFICATION OVERLAY that INSERTED the tool
 * row. That proves the tool works when a row is present; it does NOT prove the
 * product carries the row. This project already recorded that exact mistake
 * twice: G-FIX-04 (two gates passed on direct-mount evidence while the package
 * declared no bundle, so the profile never activated a layer) and G-FIX-05 (the
 * `work` tool was never wired into any preset while the extension loaded fine).
 *
 * So this probe adds NO rows. It boots `--profile daily` and asks what the
 * profile's OWN composition produces. If the preset root does not resolve, or
 * the tool rows are missing, the counts below are the evidence.
 *
 * THE SCOPE KEY. The key for a tool view is the AGENT OBJECT, not its context.
 * `AgentLoop` builds the scope with `createScope(loopCtx, this)`
 * (packages/core/agent-loop/src/agent.ts:104) and DSH's own PTC harvests with
 * `registry.schemas(exec.agent)` (packages/core/tools/src/ptc.ts:682). Passing
 * `agent.ctx` yields a key owning no scope layer, so the view collapses to the
 * global layer, which holds zero agent tools. That false negative is G-FIX-06,
 * so BOTH keys are measured here and the contrast is evidence, not folklore.
 */
import { writeFileSync } from 'node:fs'

export const name = 'verify-deliverable-surface'
// The services the DELIVERABLE profile must provide. Both are host-plane and
// come from the two bundles, so naming them here is a real assertion that the
// profile composes them -- `inject` is a readiness gate, so if either were
// absent this probe would never run and would report nothing rather than
// reporting a false absence.
export const inject = ['sessionController', 'ipython']

const OUT = 'D:/DSH/work/dsh-native-daily/qualification/results/M12-deliverable-surface/surface.json'

export async function apply(ctx) {
  const finding = {
    profileBooted: true,
    profileName: 'daily-candidate (installed as "daily")',
    presetDefaultId: null,
    presetRoots: [],
    kernelServicePresent: false,
    workServicePresent: false,
    dataServicePresent: false,
    historyServicePresent: false,
    programmaticScopePresent: false,
    sessionCreated: false,
    sessionId: null,
    toolCountAgentKey: 0,
    toolCountContextKey: 0,
    ipythonToolPresent: false,
    ipythonParameterNames: null,
    ipythonIsOnlyParameter: false,
    workToolPresent: false,
    forbiddenLifecycleTools: [],
    tools: [],
    error: null,
  }
  try {
    // (1) The preset roster's OWN view of its roots and default. This is what
    //     answers "did the shipped preset root resolve", separately from "did a
    //     tool row land".
    const roster = ctx.get('agentPresets')
    if (roster !== undefined) {
      finding.presetDefaultId = roster.defaultId ?? null
      finding.presetRoots = (roster.roots ?? []).map(root => ({ path: String(root.path), trust: String(root.trust) }))
      const listed = await roster.list()
      finding.presetsListed = listed.map(p => ({ id: p.id, trust: p.trust, broken: p.broken ?? null }))
    }

    // (2) The host services, resolved from the bundle layers.
    finding.kernelServicePresent = ctx.get('ipython') !== undefined
    finding.workServicePresent = ctx.get('dailyWork') !== undefined
    finding.dataServicePresent = ctx.get('dailyData') !== undefined
    finding.historyServicePresent = ctx.get('dailyHistory') !== undefined
    finding.programmaticScopePresent = ctx.get('programmaticScope') !== undefined

    // (3) A REAL Session on the profile's own default preset, and its catalog.
    //     The agent is looked up from the registry by session id -- the same
    //     access path the working `verify-ipython-e2e.mjs` probe uses.
    const sc = ctx.get('sessionController')
    const created = await sc.create({ cwd: 'D:/DSH/work/dsh-native-daily' })
    finding.sessionId = created?.sessionId ?? created?.id ?? null
    finding.sessionCreated = finding.sessionId !== null

    const agent = ctx.get('agents')?.get(finding.sessionId)
    if (agent === undefined) {
      finding.error = 'the created session has no live agent in this process'
    } else {
      const tools = ctx.get('tools')
      const schemas = tools.schemas(agent)
      const names = schemas.map(s => s.name).sort()
      finding.toolCountAgentKey = names.length
      finding.tools = names
      finding.ipythonToolPresent = names.includes('ipython')
      finding.workToolPresent = names.includes('work')
      const ipython = schemas.find(s => s.name === 'ipython')
      if (ipython !== undefined) {
        const properties = Object.keys((ipython.parameters ?? {}).properties ?? {})
        finding.ipythonParameterNames = properties
        finding.ipythonIsOnlyParameter = properties.length === 1 && properties[0] === 'code'
      }
      // No kernel LIFECYCLE tool may exist: a model that can open, feed or close
      // a kernel is a model that can leak or destroy one. The kernel stays on
      // the host plane, reachable only through the one `ipython` cell tool.
      const forbidden = [
        'ipython_open', 'ipython_send', 'ipython_read', 'ipython_status', 'ipython_close',
      ]
      finding.forbiddenLifecycleTools = names.filter(n => forbidden.includes(n))
      // The wrong key, measured so the difference is evidence (G-FIX-06).
      finding.toolCountContextKey = tools.schemas(agent.ctx).length
    }
  } catch (error) {
    finding.error = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
  }
  writeFileSync(OUT, JSON.stringify(finding, null, 2))
}
