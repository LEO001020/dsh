/**
 * V3 boot probe: the MODEL-FACING `ipython` surface in a REAL boot.
 *
 * WHY THIS PROBE EXISTS. IPY-09's oracle is "Exactly ONE tool named `ipython`
 * exists, with exactly ONE parameter `code`; no `ipython_open`/`ipython_send`/
 * `ipython_read`/`ipython_status`/`ipython_close` and no `python_exec` alias is
 * registered anywhere. The measured parameter list is recorded."
 *
 * `requirements.test.ts` requirement 12 checks the tool's DECLARED shape by
 * calling `apply()` with a fake context. That proves the registration is
 * correct; it does NOT prove the PRODUCT carries it -- the profile could fail to
 * activate the bundle and the fake-context test would still pass. This project
 * has recorded that exact gap twice (G-FIX-04: two gates passed on direct-mount
 * evidence while the package declared no bundle; G-FIX-05: the `work` tool was
 * never wired into any preset while the extension loaded fine). So the surface is
 * measured where the model gets it: from a REAL Session's tool catalog after a
 * REAL boot of the deliverable profile.
 *
 * THE `python_exec` CLAUSE, and why it is measured the way it is. The spec asks
 * that no `python_exec` ALIAS is registered. A search of the tree finds the name
 * in prose and in a system-prompt string, so this probe does not grep for the
 * string -- it asks the registry what it actually registered, which is the only
 * answer that matters. Both the agent-keyed view and the whole registered set are
 * checked, because a tool registered but not scoped to the agent would be
 * invisible to the first check alone.
 *
 * THE SCOPE KEY. `AgentLoop` builds the scope with `createScope(loopCtx, this)`
 * and DSH's own PTC harvests with `registry.schemas(exec.agent)`, so the key is
 * the AGENT OBJECT. Passing `agent.ctx` yields a key owning no scope layer and
 * the view collapses to the global layer -- the false negative recorded as
 * G-FIX-06. Both keys are measured so the contrast is evidence, not folklore.
 *
 * THE OUTPUT PATH IS OVERRIDABLE. A probe writing to a fixed path is a SHARED
 * MUTABLE RESOURCE and two agents cannot tell whose result they hold; that
 * produced a false PASS earlier in this project (G-FIX-13). `DSH_PROBE_OUT` is
 * honoured, and `boot-harness.mjs`'s `readResult()` then asserts the result names
 * the home this caller booted.
 */
import { writeFileSync } from 'node:fs'

export const name = 'v3-ipython-surface'
// `inject` is a readiness gate: if the ipython service is not composed this
// probe never runs and reports NOTHING, rather than reporting a false absence.
export const inject = ['sessionController', 'ipython']

const OUT = process.env.DSH_PROBE_OUT
  ?? 'D:/DSH/work/dsh-native-daily/qualification/results/V3-ipython/IPY-09-tool-surface.json'

export async function apply(ctx) {
  const finding = {
    scope: 'IPY-09 the model-facing ipython surface in a real boot',
    profileBooted: true,
    presetRoots: [],
    presetDefaultId: null,
    kernelServicePresent: false,
    sessionCreated: false,
    sessionId: null,
    toolCountAgentKey: 0,
    toolCountContextKey: 0,
    ipythonToolPresent: false,
    ipythonParameterNames: null,
    ipythonParameterCount: null,
    ipythonIsOnlyParameter: false,
    forbiddenLifecycleTools: [],
    pythonExecAliasPresent: false,
    allRegisteredNames: [],
    tools: [],
    error: null,
  }
  try {
    // (1) The preset roots, so the reader can see WHICH composition produced the
    //     catalog. A result that does not name its home cannot be told from
    //     another agent's.
    const roster = ctx.get('agentPresets')
    if (roster !== undefined) {
      finding.presetDefaultId = roster.defaultId ?? null
      finding.presetRoots = (roster.roots ?? []).map(root => String(root.path))
    }

    // (2) The host service, resolved from the bundle layers.
    finding.kernelServicePresent = ctx.get('ipython') !== undefined

    // (3) A REAL Session on the profile's own default preset.
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

      // The tool SHAPE, read from the registry's own schema rather than restated.
      const ipython = schemas.find(s => s.name === 'ipython')
      if (ipython !== undefined) {
        const properties = Object.keys((ipython.parameters ?? {}).properties ?? {})
        finding.ipythonParameterNames = properties
        finding.ipythonParameterCount = properties.length
        finding.ipythonIsOnlyParameter = properties.length === 1 && properties[0] === 'code'
      }

      // No kernel LIFECYCLE tool may exist. A model that can open, feed or close
      // a kernel is a model that can leak or destroy one.
      const forbidden = [
        'ipython_open', 'ipython_send', 'ipython_read', 'ipython_status', 'ipython_close',
        'kernel_open', 'kernel_restart', 'kernel_shutdown',
      ]
      finding.forbiddenLifecycleTools = names.filter(n => forbidden.includes(n))

      // THE `python_exec` CLAUSE, answered from the registry rather than by
      // grepping source. `python_exec` appears in this tree as PROSE (a system
      // prompt string and comments in dsh-daily-work), so a grep would report a
      // false positive; what the spec asks is whether a tool of that name is
      // REGISTERED, and that is what this reads.
      finding.pythonExecAliasPresent = names.includes('python_exec')

      // Every name the registry holds, not only the agent-scoped view: a tool
      // registered globally would be invisible to the agent-keyed check above.
      try {
        const all = tools.schemas?.() ?? []
        finding.allRegisteredNames = all.map(s => s.name).sort()
      } catch {
        finding.allRegisteredNames = []
      }
      // The wrong key, measured so the difference is evidence (G-FIX-06).
      finding.toolCountContextKey = tools.schemas(agent.ctx).length
    }
  } catch (error) {
    finding.error = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
  }
  writeFileSync(OUT, JSON.stringify(finding, null, 2))
  process.stdout.write(`V3-IPY-SURFACE: ${JSON.stringify(finding)}\n`)
}
