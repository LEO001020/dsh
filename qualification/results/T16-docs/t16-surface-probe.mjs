/**
 * T16 boot probe: what does the DELIVERABLE profile's own composition put in a
 * real Session's model-facing tool catalog, on the tree as it stands?
 *
 * This is a T16-owned copy of the R9 deliverable-surface probe. It exists so the
 * T16 delivery documentation cites a measurement taken on the tree it describes,
 * rather than inheriting a number from an earlier revision. It adds NO tool row:
 * everything it reports comes from the profile's own composition.
 *
 * It writes to a T16-owned path (NOT the R9 path), because a probe that writes to
 * a fixed shared path is a shared mutable resource -- the failure G-FIX-13 records.
 * `presetRoots` is reported so a reader can confirm the home that was booted.
 */
import { writeFileSync } from 'node:fs'

export const name = 't16-deliverable-surface'
export const inject = ['sessionController', 'ipython']

const OUT = 'D:/DSH/work/dsh-native-daily/qualification/results/T16-docs/surface-t16.json'

export async function apply(ctx) {
  const finding = {
    probe: 't16-deliverable-surface',
    profileBooted: true,
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
    pwshToolPresent: false,
    forbiddenLifecycleTools: [],
    tools: [],
    error: null,
    // Sandbox state as RESOLVED at boot, not as written in a file. The
    // architecture decision says the mode is danger-full-access; a reader must be
    // able to check that against the running composition rather than a diff.
    sandboxPolicyServicePresent: false,
    sandboxDefaultMode: null,
    sandboxResolvedMode: null,
    sandboxResolvedWorkspaceRoot: null,
    sandboxResolveError: null,
    envPermissionMode: process.env.DSH_PERMISSION_MODE ?? null,
  }
  try {
    const policy = ctx.get('sandboxPolicy')
    finding.sandboxPolicyServicePresent = policy !== undefined
    if (policy !== undefined) {
      finding.sandboxDefaultMode = policy.defaultMode ?? null
      try {
        const resolved = policy.resolve({})
        finding.sandboxResolvedMode = resolved?.mode ?? null
        finding.sandboxResolvedWorkspaceRoot = resolved?.workspaceRoot ?? null
      } catch (error) {
        finding.sandboxResolveError = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
      }
    }

    const roster = ctx.get('agentPresets')
    if (roster !== undefined) {
      finding.presetDefaultId = roster.defaultId ?? null
      finding.presetRoots = (roster.roots ?? []).map(root => ({ path: String(root.path), trust: String(root.trust) }))
      const listed = await roster.list()
      finding.presetsListed = listed.map(p => ({ id: p.id, trust: p.trust, broken: p.broken ?? null }))
    }

    finding.kernelServicePresent = ctx.get('ipython') !== undefined
    finding.workServicePresent = ctx.get('dailyWork') !== undefined
    finding.dataServicePresent = ctx.get('dailyData') !== undefined
    finding.historyServicePresent = ctx.get('dailyHistory') !== undefined
    finding.programmaticScopePresent = ctx.get('programmaticScope') !== undefined

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
      finding.pwshToolPresent = names.includes('pwsh')
      const ipython = schemas.find(s => s.name === 'ipython')
      if (ipython !== undefined) {
        const properties = Object.keys((ipython.parameters ?? {}).properties ?? {})
        finding.ipythonParameterNames = properties
        finding.ipythonIsOnlyParameter = properties.length === 1 && properties[0] === 'code'
      }
      const forbidden = [
        'ipython_open', 'ipython_send', 'ipython_read', 'ipython_status', 'ipython_close',
      ]
      finding.forbiddenLifecycleTools = names.filter(n => forbidden.includes(n))
      finding.toolCountContextKey = tools.schemas(agent.ctx).length
    }
  } catch (error) {
    finding.error = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
  }
  writeFileSync(OUT, JSON.stringify(finding, null, 2))
}
