/**
 * C6 probe: the model-visible catalog, measured from the profile's OWN
 * composition, plus the SAME catalog under alternative scope keys.
 *
 * WHY THE ALTERNATIVE KEYS ARE HERE. The assignment asks whether CMP-04's
 * oracle ("toolCountAgentKey is 28") is satisfiable by a DIFFERENT measurement.
 * The only way to answer that is to take the other measurements and record
 * them, rather than to argue about them. So this probe records the agent-key
 * view (the oracle's key), the agent-context view (the known-wrong key,
 * G-FIX-06), and the unscoped/global view. If any of them is 28 with pwsh
 * absent, the contradiction is a measurement artifact. If all are 27 (or 28
 * only when pwsh is present), it is about the catalog.
 */
import { writeFileSync } from 'node:fs'

export const name = 'c6-surface-probe'
export const inject = ['sessionController', 'ipython']

const OUT = process.env.DSH_PROBE_OUT
if (OUT === undefined) throw new Error('DSH_PROBE_OUT must be set')

// The CLI PROCESS runs from a foreign cwd (C:/) -- that is the harness's job
// and it is what CMP-05 is about. A SESSION's cwd must be a directory the host
// can use as a project dir, and C:/ is not writable (EPERM on mkdir 'C:\'),
// so the session gets a writable directory that is still unrelated to the
// profile: not under the DSH home, not under the repo.
const SESSION_CWD = 'D:/DSH/work/c6-foreign-cwd'

// The repository root of the tree THIS FILE was loaded from -- the same cwd the
// original CMP-04 probe used for its session.
const REPO_ROOT = 'D:/DSH/work/wt-c6'

export async function apply(ctx) {
  const finding = {
    probeAddsToolRow: false,
    presetDefaultId: null,
    presetRoots: [],
    sessionCreated: false,
    sessionId: null,
    toolCountAgentKey: 0,
    toolCountContextKey: 0,
    toolCountGlobalKey: 0,
    tools: [],
    globalTools: [],
    ipythonToolPresent: false,
    workToolPresent: false,
    error: null,
  }
  try {
    const roster = ctx.get('agentPresets')
    if (roster !== undefined) {
      finding.presetDefaultId = roster.defaultId ?? null
      finding.presetRoots = (roster.roots ?? []).map(r => ({ path: String(r.path), trust: String(r.trust) }))
    }
    const sc = ctx.get('sessionController')
    const tools = ctx.get('tools')

    // TWO sessions, differing ONLY in cwd, because a cwd-dependent catalog is
    // exactly the kind of measurement artifact this case has to rule out. The
    // original CMP-04 probe created its session with cwd = the REPO ROOT; if
    // the catalog differs by cwd, then a count taken from another directory is
    // not the same measurement and the comparison would be spurious.
    for (const [label, cwd] of [['nonRepo', SESSION_CWD], ['repoRoot', REPO_ROOT]]) {
      const created = await sc.create({ cwd })
      const sessionId = created?.sessionId ?? created?.id ?? null
      const agent = ctx.get('agents')?.get(sessionId)
      const arm = {
        sessionId,
        cwd,
        toolCountAgentKey: null,
        tools: [],
        ipythonToolPresent: false,
        workToolPresent: false,
        toolCountContextKey: null,
        error: null,
      }
      if (agent === undefined) {
        arm.error = 'the created session has no live agent in this process'
      } else {
        const names = tools.schemas(agent).map(s => s.name).sort()
        arm.toolCountAgentKey = names.length
        arm.tools = names
        arm.ipythonToolPresent = names.includes('ipython')
        arm.workToolPresent = names.includes('work')
        arm.toolCountContextKey = tools.schemas(agent.ctx).length
        if (label === 'nonRepo') {
          finding.sessionId = sessionId
          finding.sessionCreated = sessionId !== null
          finding.toolCountAgentKey = names.length
          finding.tools = names
          finding.ipythonToolPresent = arm.ipythonToolPresent
          finding.workToolPresent = arm.workToolPresent
          finding.toolCountContextKey = arm.toolCountContextKey
        }
      }
      finding.arms = { ...(finding.arms ?? {}), [label]: arm }
    }
    // The unscoped view: no scope at all.
    const globalNames = tools.schemas().map(s => s.name).sort()
    finding.toolCountGlobalKey = globalNames.length
    finding.globalTools = globalNames
  } catch (error) {
    finding.error = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
  }
  writeFileSync(OUT, JSON.stringify(finding, null, 2))
}
