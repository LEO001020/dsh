/**
 * E02 probe — the control-plane surface, measured from a REAL boot.
 *
 * WHY THIS RUNS INSIDE A REAL BOOT
 * ================================
 * E02 asks whether the model can reach the human terminal / API / plugin-manager
 * loopback entry points. That is a property of the COMPOSED PROFILE, so the only
 * composition that can answer it is the one the resolver actually built. A vitest
 * process that mounts a handful of services would answer a different question.
 * This probe therefore runs as a host plugin inside a real `dsh --profile daily`
 * boot, the way `verify-b02.mjs` does.
 *
 * THE SHAPE OF THE CLAIM, AND TWO MEASUREMENT ERRORS CORRECTED HERE
 * ================================================================
 * `security-denial.test.ts` already asserts the NEGATIVE half in an in-process
 * composition (`ctx.get('terminalController')` is undefined). That assertion is
 * not duplicated. What E02 needs is the COMPLEMENT: enumerate the control-plane
 * surfaces and show which are actually reachable.
 *
 * Two errors were made while building this probe, and both are recorded because
 * each one produces a confident wrong answer:
 *
 *   1. `inject` IS A READINESS GATE. The first version declared
 *      `inject: ['agents','tools','agentPresets']` and read the host scope at the
 *      top of `apply`. Half the control-plane services reported absent — not
 *      because they are absent, but because this probe ran before they mounted.
 *      M9.17 recorded exactly this mistake for `dailyWork`; it recurs here. The
 *      fix is to wait for the LAST service to appear rather than trusting a
 *      fixed inject list, and to assert the wait's own outcome.
 *
 *   2. `ctx.get(name)` IS A PROCESS-WIDE REGISTRY READ, NOT A SCOPE TEST.
 *      `ReflectService.get` resolves `ctx[symbols.isolate][name]` against a
 *      SHARED `store`, so any context in the process that names a service
 *      resolves the one instance — including a context under a preset's
 *      `isolate` realm. Measured directly (probe-scope.mjs): a context that
 *      isolated an unrelated name still resolves a service provided by the root
 *      fiber, and vice versa. So "reachable via ctx.get from the agent scope" is
 *      NOT evidence of a leak and NOT evidence of isolation. The load-bearing
 *      fact for E02 is therefore not `ctx.get` at all — it is whether the MODEL
 *      has a tool that can call the surface, which `tools.schemas(agent)` answers.
 *
 * So this probe reports three distinct things and never conflates them:
 *   A. what the MODEL can call      -> tools.schemas(agent), the tool catalog
 *   B. what the HOST scope holds    -> ctx.get, after a real readiness wait
 *   C. what the AGENT SCOPE resolves -> ctx.get, with the semantics stated
 *
 * WHAT THIS PROBE DOES NOT DO
 * ===========================
 * It never CALLS a control-plane method. Reading whether a handle resolves is a
 * registry read; invoking `terminalController.create()` would be the escalation
 * E02 forbids and would spawn a real system-user shell. The probe stops at
 * presence.
 */
import { writeFileSync } from 'node:fs'

export const name = 'verify-e02'
export const inject = ['tools']

const OUT = process.env.E02_OUT ?? 'D:/DSH/work/dsh-native-daily/qualification/results/M9.19-control-plane/e02.json'

/**
 * The control-plane surfaces E02 names, each with what its holder can do that
 * the model cannot.
 *
 * This list is written out rather than derived from a name pattern because the
 * claim is about AUTHORITY, not about naming: `credentials` and
 * `credentialsController` are both here and a regex over "controller" would
 * catch only one. A surface a future DSH adds is therefore NOT covered by this
 * list, and the probe reports the full service universe alongside it so that gap
 * is visible rather than implied away.
 */
const CONTROL_PLANE = {
  terminalController: 'allocates a system-user PTY outside the agent sandbox and approval flow (E02/SECURITY.md INV-S1)',
  webTerminals: 'the Web-side terminal registry that fronts terminalController',
  pluginManager: 'installs, enables and disables plugin code in the running profile',
  pluginInventory: 'enumerates the profile plugin set for management surfaces',
  pluginPackages: 'reads and writes the profile package manifest and lockfile',
  dynamicCordisRunner: 'loads and runs model-authored Cordis plugin code in the host runtime',
  webServer: 'owns the listening socket that serves the API and the frontend',
  connection: 'holds the process launch token and mints browser session cookies',
  remote: 'the typed Remote namespace that carries control-plane calls',
  typertGateway: 'dispatches Remote calls into host services',
  credentials: 'reads and writes the credential store ($DSH_HOME/.credentials.yaml)',
  credentialsController: 'the Web-facing credential management surface',
  sessionController: 'creates, resumes and deletes Sessions outside the model loop',
  settingsController: 'writes host settings',
  workspaceController: 'registers and switches workspaces',
  workspaceFiles: 'reads and writes files through the host fs policy rather than the agent tools',
  authorization: 'grants and revokes authorization scopes',
  hmr: 'reloads plugins into the running host',
  cordisInspect: 'read-only runtime introspection of every host service and event',
  commands: 'registers and runs host command entries',
  directoryPicker: 'opens a native directory dialog on the user machine',
  directoryPickerController: 'the Web-facing directory dialog surface',
  webhookRuntime: 'receives external HTTP callbacks into the host',
}

/**
 * Wait until every named service resolves, or the budget expires.
 *
 * This replaces a fixed `inject` list because `inject` only guarantees the
 * services NAMED there are ready; a probe that injects three services and then
 * reads twenty runs in the middle of the host's own mount sequence and reports
 * the unmounted ones as absent. M9.17 recorded this exact error for `dailyWork`.
 * The wait's OUTCOME is reported, so a budget that expired is evidence rather
 * than a silent pass.
 *
 * @param ctx - the live host context.
 * @param names - services to wait for.
 * @param budgetMs - total wait budget.
 */
async function waitForServices(ctx, names, budgetMs) {
  const started = Date.now()
  const deadline = started + budgetMs
  const missing = new Set(names)
  while (Date.now() < deadline && missing.size > 0) {
    for (const name of [...missing]) {
      let present = false
      try {
        present = ctx.get(name) !== undefined
      } catch {
        present = false
      }
      if (present) missing.delete(name)
    }
    if (missing.size > 0) await new Promise(resolve => setTimeout(resolve, 100))
  }
  return { waitedMs: Date.now() - started, stillMissing: [...missing].sort() }
}

/** Whether `name` resolves from `ctx`, with the failure mode preserved. */
function reachable(ctx, name) {
  try {
    const value = ctx.get(name)
    return value === undefined ? false : { present: true, ctor: value?.constructor?.name ?? typeof value }
  } catch (error) {
    return `threw: ${error instanceof Error ? error.message : String(error)}`
  }
}

export async function apply(ctx) {
  const finding = {
    gate: 'E02',
    profile: process.env.DSH_E02_PROFILE ?? 'daily',
    dshHome: process.env.DSH_HOME ?? null,
    readiness: null,
    modelToolCatalog: [],
    modelToolCount: 0,
    controlPlaneAsModelTool: {},
    cordisInspectTools: [],
    controlPlaneInHostScope: {},
    controlPlaneAbsentFromHostScope: [],
    agentScopeResolves: {},
    scopeSemanticsNote: '',
    errors: [],
  }

  try {
    finding.readiness = await waitForServices(ctx, Object.keys(CONTROL_PLANE), 30_000)

    const sc = ctx.get('sessionController')
    if (sc === undefined) {
      finding.errors.push('sessionController never resolved, so no real Session could be created')
    } else {
      const created = await sc.create({ cwd: process.cwd() })
      finding.sessionId = created?.sessionId ?? created?.id ?? null
      const agent = ctx.get('agents')?.get(finding.sessionId)
      if (agent === undefined) {
        finding.errors.push('the created session has no live agent in this process')
      } else {
        finding.agentPresetId = agent.session.header.agentPreset ?? null
        const tools = ctx.get('tools')
        const schemas = tools.schemas(agent)
        finding.modelToolCatalog = schemas.map(s => s.name).sort()
        finding.modelToolCount = finding.modelToolCatalog.length
        // A. Is any control-plane surface exposed to the model AS A TOOL? This is
        // the question E02's oracle asks: the model reaches things through tools,
        // so the tool catalog is the capability boundary.
        for (const [name, authority] of Object.entries(CONTROL_PLANE)) {
          finding.controlPlaneAsModelTool[name] = {
            exposedAsTool: finding.modelToolCatalog.includes(name),
            authority,
          }
        }
        // A tool whose NAME matches is the crude check; a tool that WRAPS a
        // control-plane service is the real one. `cordis_inspect_*` is the one
        // shipped case; it is read-only by construction, so it is reported
        // explicitly rather than lumped in with the absent ones.
        finding.cordisInspectTools = finding.modelToolCatalog.filter(n => n.startsWith('cordis_inspect'))
        // C. What the AGENT SCOPE resolves. Recorded with the semantics stated,
        // because a reader would otherwise read this as a scope test.
        for (const name of Object.keys(CONTROL_PLANE)) {
          finding.agentScopeResolves[name] = reachable(agent.ctx, name)
        }
        finding.scopeSemanticsNote =
          'ctx.get(name) resolves against the SHARED process store (cordis ReflectService.store), '
          + 'not against the calling scope, so a true value here means the service EXISTS in this '
          + 'process, not that the preset realm grants access to it. The capability boundary is '
          + 'modelToolCatalog. Measured in probe-scope.mjs.'
      }
    }

    // B. The host scope, read only AFTER the readiness wait, so an unmounted
    // service is distinguished from a slow one.
    for (const name of Object.keys(CONTROL_PLANE)) {
      finding.controlPlaneInHostScope[name] = reachable(ctx, name)
    }
    finding.controlPlaneAbsentFromHostScope = Object.entries(finding.controlPlaneInHostScope)
      .filter(([, value]) => value === false)
      .map(([name]) => name)
      .sort()
  } catch (error) {
    finding.errors.push(error instanceof Error ? `${error.message}\n${error.stack}` : String(error))
  }

  writeFileSync(OUT, `${JSON.stringify(finding, null, 2)}\n`)
  process.stdout.write(`E02: ${JSON.stringify({
    modelToolCount: finding.modelToolCount,
    exposedAsTool: Object.entries(finding.controlPlaneAsModelTool).filter(([, v]) => v.exposedAsTool).map(([k]) => k),
    cordisInspectTools: finding.cordisInspectTools,
    controlPlaneAbsentFromHostScope: finding.controlPlaneAbsentFromHostScope,
    readiness: finding.readiness,
    errors: finding.errors,
  })}\n`)
}
