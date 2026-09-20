/**
 * P6 probe: what child-creation surface does the MODEL actually have on the
 * composed daily profile, and is the Work target bypassable from it?
 *
 * WHY THIS EXISTS. V5 §8 (P0) requires the daily preset to expose no
 * model-facing child creation outside the `WorkService` queue, and V5 §18
 * states the acceptance as WORK-NO-BYPASS: "final model tool catalog has no
 * alternate child-creation route". The oracle is therefore the CATALOG — the
 * exact set of tool names the model is offered — and not a count, not a grep of
 * the YAML, and not the presence of a `disabled: true` line.
 *
 * THE DEFECT CLASS THIS AVOIDS. "The mechanism exists, is unit-tested, is
 * correct, and nothing in the product calls it" — recorded in this repository
 * more than twelve times. A YAML edit is a claim about a FILE. Only a boot
 * answers what the composed product offers. So this probe boots the real
 * profile and reads the real registry, and the driver compares before/after.
 *
 * WHY `disabled` AND NOT DELETION, MEASURED HERE. `mountPreset` is
 * all-or-nothing: `inactiveRows` lists every enabled row whose `inject` is
 * unresolved and the mount THROWS when that list is non-empty
 * (agent-presets/src/mount.ts:394-396). So the probe records `toolCount` and
 * `toolCountContextKey` — a NON-ZERO count is what separates "the row is gone"
 * from "the whole preset died", which is the failure direction this project has
 * already measured once as `toolCount: 0` with every tool absent.
 *
 * WHAT IT MEASURES, and why each field is load-bearing:
 *   - `tools`: the agent-keyed catalog, sorted, VERBATIM. This is the artifact
 *     V5 §18's WORK-NO-BYPASS is judged on.
 *   - `creationRoutes`: each name in the catalog that is a known child-creation
 *     route, tested by RESOLUTION (`ctx.tools.get(name, agent)`) rather than by
 *     string comparison, so a tool that is visible under another name is still
 *     caught.
 *   - `unknownToolRefusals`: THE NEGATIVE ARM, direct. For every creation tool
 *     the model must NOT have, the probe calls it through the REAL tool runtime
 *     and records the result. A tool that is absent from the catalog must be
 *     refused with `UNKNOWN_TOOL`; if any of them EXECUTES, the surface is
 *     still open and this artifact says so.
 *   - `bridgeArm`: THE NEGATIVE ARM, hidden. The deployment's `ipython` tool is
 *     a SECOND model-facing door into the same registry: a cell's `dsh.call(...)`
 *     is translated by `packages/dsh-ipython/src/native-call.ts:148` into
 *     `ctx.tools.execute` with the host-bound authority. A direct-call-only
 *     probe would leave "the model reaches it from Python instead" untested, so
 *     the probe drives that path too and records what Python got back.
 *   - `rowEnablement`: the live composition rows with `enabled` as the Loader
 *     evaluated it, so "disabled in the file" is separated from "enabled in the
 *     mounted tree".
 *   - `subagentRowConfig`: `maxActiveSubagents`/`maxDepth` from the LIVE loader
 *     entries, not from the patch file.
 *
 * WHAT IT DOES NOT DO. It does not call `createRun` and it does not create a
 * run: the Work queue's own accounting is a different slice's subject, and
 * installing the entry point under test would be the weaker-oracle failure
 * (G-FIX-04). It creates no child at all.
 *
 * WHY IT INJECTS ONLY `sessionController`. `inject` is a readiness gate, so a
 * probe injecting `dailyWork` would not run when the service is missing and the
 * artifact would be ABSENT rather than reporting `false`. Every other service
 * is read through `ctx.get`, so a missing one lands in the artifact as a
 * measured absence.
 *
 * THE OUTPUT PATH IS NOT DEFAULTED, deliberately. A probe writing to a fixed
 * path is a SHARED MUTABLE RESOURCE, and this repository has already produced a
 * false PASS that way (G-FIX-13). `r5-bridge-product.mjs` refuses to run when
 * `DSH_PROBE_OUT` is unset; this probe copies that discipline rather than
 * inventing a default, because a default would make the two boots below
 * indistinguishable if a caller ran them concurrently.
 *
 * THE ARTIFACT IS WRITTEN TO TWO PATHS, AND THE SECOND ONE IS LOAD-BEARING.
 *
 * `DSH_PROBE_OUT` is the COMPLETION SIGNAL: `boot-harness.mjs` waits for that
 * file to EXIST and then SIGKILLs the host (boot-harness.mjs:135-149). So a
 * probe that flushes its main artifact early would have its host killed while
 * the rest of the measurement was still running -- the negative arm would be
 * truncated, and the artifact would look complete. Measured by reading the
 * harness, not assumed.
 *
 * `DSH_PROBE_PARTIAL_OUT` is the CRASH INSURANCE: the same finding object,
 * rewritten after every step that can hang. The catalog is the deliverable, and
 * the BEFORE boot is expected to DISPATCH creation calls that reach a provider
 * with no model route -- so the probe can wait. Writing the partial file after
 * each step means a hang costs at most the steps after it, while the main file
 * still means exactly what the harness thinks it means.
 *
 * The driver reads the partial file only when the main one is missing, and
 * records which one it used.
 */
import { writeFileSync } from 'node:fs'

export const name = 'p6-surface-probe'
export const inject = ['sessionController']

import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

/** The repository root of the tree THIS FILE was loaded from. */
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..').replace(/\\/g, '/')

const OUT = process.env.DSH_PROBE_OUT
if (OUT === undefined || OUT === '') {
  throw new Error('p6-surface-probe: DSH_PROBE_OUT must name this caller\'s own result path; '
    + 'a shared fixed path cannot be attributed to a caller (G-FIX-13)')
}

/** Where the in-progress artifact goes. See the module header. */
const PARTIAL_OUT = process.env.DSH_PROBE_PARTIAL_OUT ?? ''

/** The bound on one creation-route call. See the negative arm's comment. */
const ROUTE_BOUND_MS = 25_000
/** The value the race resolves with when the route did not settle in time. */
const TIMEOUT_SENTINEL = Symbol('p6-surface-route-timeout')

/**
 * Every tool name that creates a child, on the upstream pin.
 *
 * Each is paired with the row that would publish it and the source that shows
 * it creates. This list is the ORACLE of the negative arm, so it is written
 * out rather than derived from the preset: a list derived from the file under
 * test could not fail.
 */
const CREATION_ROUTES = [
  { tool: 'subagent', row: 'tool-subagent', why: 'ctx.subagents.startContinuable via @deepseek-ai/dsh-tool-subagent (provider spawn)' },
  { tool: 'subagent_fork', row: 'tool-subagent-fork', why: 'ctx.subagents.startContinuable via @deepseek-ai/dsh-tool-subagent (provider fork)' },
  { tool: 'subagent_codex', row: 'tool-subagent-codex', why: 'provider-bound one-shot child (@deepseek-ai/dsh-tool-subagent, provider codex)' },
  { tool: 'subagent_claude_code', row: 'tool-subagent-claude-code', why: 'provider-bound one-shot child (@deepseek-ai/dsh-tool-subagent, provider claude-code)' },
  { tool: 'workflow', row: 'tool-workflow', why: 'ctx.workflowEngine.start -> workflow-ptc startChild -> ctx.subagents.start()' },
  { tool: 'ralph', row: 'tool-ralph', why: 'ctx.workflowEngine.start -> subagents (tool-ralph, disabled by default)' },
]

/**
 * The management surface V5 §8 says to KEEP, plus the queue itself.
 *
 * Each is asserted PRESENT. A slice that removed these would leave the model
 * unable to steer or even see its WorkService-created children, which is a
 * different failure from the one this change is about — so it is measured
 * rather than assumed.
 */
const MANAGEMENT_TOOLS = ['send_message', 'interrupt_agent', 'list_agents', 'work']

/** The arguments each creation route needs to get as far as the registry. */
function creationArgs(tool) {
  return tool === 'workflow' || tool === 'ralph'
    ? { name: 'p6-surface-probe', script: 'export default 1' }
    : { description: 'p6 surface probe', prompt: 'p6 surface probe: must be refused' }
}

/**
 * Read a tool's presence the way the MODEL's scope sees it.
 *
 * `ctx.tools.get(name, agent)` resolves through the same scope chain
 * `schemas(agent)` does, so a name that is visible is visible here and a name
 * that is not resolves `undefined`. This is deliberately a RESOLUTION rather
 * than a string search of the catalog: a name present in the catalog under a
 * different provider id would still be caught by resolution.
 */
function routePresence(tools, agent, toolName) {
  const definition = tools.get?.(toolName, agent)
  return {
    tool: toolName,
    visibleToModel: definition !== undefined,
    // `undefined` here is the honest answer for an absent tool: the registry
    // has no definition to describe, which is exactly the claim.
    definitionName: definition?.name ?? null,
  }
}

/**
 * Turn one `ToolExecutionResult` into the fields the negative arm asserts on.
 *
 * THE ORACLE IS THE RESULT, NOT AN EXCEPTION. Measured and recorded in this
 * project (T10): a tool failure does NOT throw out of `execute` — it returns a
 * structured result with `isError: true`. A probe asserting on a throw would
 * read a refusal as a success.
 *
 * THE CODE LIVES AT `error.info.code`, NOT `error.code`. Read from source:
 * `toolErrorResult` builds `{ error: { message, ...info ? { info } : {} } }`
 * where `info = { name, code }` from the `HarnessError`
 * (packages/core/tools/src/index.ts:644-650, 1879-1887). A probe reading
 * `error.code` would report `null` for every refusal and could not distinguish
 * `UNKNOWN_TOOL` from a tool body's own failure.
 */
function refusalOf(json) {
  return {
    isError: json?.isError ?? null,
    errorCode: json?.error?.info?.code ?? null,
    errorName: json?.error?.info?.name ?? null,
    message: String(json?.error?.message ?? '').slice(0, 300),
    contentText: String(json?.content?.[0]?.text ?? '').slice(0, 300),
    executed: json?.isError !== true,
  }
}

export async function apply(ctx) {
  const finding = {
    probe: 'p6-surface',
    ranAt: new Date().toISOString(),
    profileName: ctx.get('profileContext')?.profile?.name ?? 'unknown',

    // (1) THE DELIVERABLE: the agent-keyed catalog, verbatim.
    agentPreset: null,
    sessionId: null,
    tools: [],
    toolCountAgentKey: 0,
    toolCountContextKey: null,

    // (2) The negative arm's input: is each known creation route visible?
    creationRoutes: [],

    // (3) THE NEGATIVE ARM, direct: call each route, record the refusal.
    unknownToolRefusals: [],
    anyCreationRouteExecuted: null,

    // (3b) THE NEGATIVE ARM, hidden: the ipython bridge into the same registry.
    bridgeArm: null,

    // (4) The live row enablement, so "disabled" is measured, not read.
    rowEnablement: [],

    // (5) The composed numbers, from the LIVE loader entries.
    subagentRowConfig: null,

    // (6) The management surface that MUST survive.
    managementSurface: {},

    presetRoots: [],
    error: null,
    errorPhase: null,
  }

  /**
   * Write the in-progress artifact.
   *
   * Deliberately NOT the main output path: see the module header. The main file
   * is the harness's completion signal, and writing it early would have the host
   * killed mid-measurement.
   */
  const flush = () => {
    if (PARTIAL_OUT !== '') writeFileSync(PARTIAL_OUT, JSON.stringify(finding, null, 2))
  }

  /**
   * Write the FINAL artifact. Called on every exit path, including the early
   * ones, so an aborted probe still produces a file the harness can see -- and
   * so the driver gets a probe that says WHY it stopped rather than a timeout.
   */
  const finish = () => {
    flush()
    writeFileSync(OUT, JSON.stringify(finding, null, 2))
  }

  try {
    // ---- the roster roots, recorded FIRST ---------------------------------
    // `readResult()` in the shared harness asserts the artifact names the home
    // this caller booted. A probe that failed before recording them would write
    // an artifact the driver cannot attribute, so they go in before anything
    // that can throw.
    const roster = ctx.get('agentPresets')
    if (roster !== undefined) {
      finding.presetRoots = (roster.roots ?? []).map(root => String(root.path))
    }

    // ---- the live loader entries ------------------------------------------
    const loader = ctx.get('loader')
    if (loader !== undefined) {
      for (const entry of loader.entries()) {
        if (entry.options.id === 'subagent' || entry.options.name === '@deepseek-ai/dsh-subagent') {
          finding.subagentRowConfig = {
            id: entry.options.id,
            name: entry.options.name,
            config: entry.options.config ?? null,
            fiberState: entry.fiber?.state ?? null,
          }
        }
      }
    }

    // ---- the live composition rows, as the Loader evaluated them ----------
    // `compositionInventory()` reads the STANDING MOUNT's entry tree
    // (`mountedCompositionRows`), so `enabled` is the Loader's own verdict for
    // the mounted preset — not a re-parse of the YAML. A `disabled: true` line
    // that the mount ignored would show up here as `enabled: true`.
    const readRows = async presetId => {
      if (roster === undefined || typeof roster.compositionInventory !== 'function') return
      const inventory = await roster.compositionInventory()
      const own = inventory.find(preset => preset.id === presetId)
        ?? inventory.find(preset => preset.id === 'daily-standard')
      if (own !== undefined) {
        finding.rowEnablement = own.rows.map(row => ({
          entryId: row.entryId,
          moduleName: row.moduleName,
          enabled: row.enabled,
          ...row.condition === undefined ? {} : { condition: row.condition },
          ...row.fiberState === undefined ? {} : { fiberState: row.fiberState },
        }))
      }
    }
    await readRows(finding.agentPreset ?? 'daily-standard')

    // ---- a REAL Session on the deployment's default preset ----------------
    // `cwd` is passed explicitly: the controller creates the project directory
    // for a new Session, and a boot from a drive root would try `mkdir C:\`.
    const sessions = ctx.get('sessionController')
    if (sessions === undefined) {
      finding.error = 'sessionController is absent, so no catalog could be measured'
      finish()
      return
    }
    const created = await sessions.create({ cwd: REPO_ROOT })
    finding.sessionId = String(created.sessionId)
    finding.agentPreset = created.agentPreset ?? null

    // Re-read the inventory now that the preset is known to be mounted.
    await readRows(finding.agentPreset)

    const agent = ctx.get('agents')?.get(finding.sessionId)
    if (agent === undefined) {
      finding.error = 'the created session has no live agent in this process'
      finish()
      return
    }

    const tools = ctx.get('tools')
    if (tools === undefined) {
      finding.error = 'the tools registry is absent from this composition'
      finish()
      return
    }

    // ---- (1) THE CATALOG, VERBATIM ---------------------------------------
    // `schemas(agent)` is the AGENT-KEYED view. `ctx.tools` layers are keyed by
    // the AGENT OBJECT (AgentLoop builds the scope with
    // `createScope(loopCtx, this)`, agent-loop/src/agent.ts:104), so passing
    // `agent.ctx` would collapse to the global layer with zero tools — the
    // false negative recorded as G-FIX-06.
    const schemas = tools.schemas?.(agent) ?? []
    const names = schemas.map(s => s?.name ?? s?.function?.name).filter(n => typeof n === 'string')
    finding.tools = [...names].sort()
    finding.toolCountAgentKey = names.length
    // The CONTROL: the same read with NO scope. It must differ, and a context
    // count of 0 beside a non-zero agent count is the measured proof that the
    // catalog above is the agent-keyed one rather than a global view that
    // happens to be non-empty.
    finding.toolCountContextKey = (tools.schemas?.() ?? []).length

    // ---- (2) is each creation route visible? -----------------------------
    finding.creationRoutes = CREATION_ROUTES.map(route => ({
      ...route,
      ...routePresence(tools, agent, route.tool),
    }))

    // ---- (3) THE NEGATIVE ARM: call each route, record the refusal -------
    // This is V5 §8's "try direct hidden/provider path as an internal negative
    // test: Work target may not be bypassed from normal model surface". The call
    // goes through the REAL `ToolRuntime.execute`, with the REAL calling agent,
    // so it exercises the same resolution the model's call would.
    //
    // EACH CALL IS BOUNDED BY AN EXPLICIT RACE, AND THE ARTIFACT IS FLUSHED
    // AFTER EACH ONE. The BEFORE boot is expected to DISPATCH these calls --
    // that is the positive control -- and a dispatched creation call reaches a
    // provider whose model route does not exist in this deployment, so it can
    // wait. An unbounded await would take the whole artifact down with it, and
    // the catalog is the deliverable.
    //
    // WHY A RACE AND NOT `AbortSignal.timeout`. The signal is cooperative: the
    // registry checks it between stages and the TOOL BODY is free to ignore it,
    // so a hung body would still hang the probe. A race bounds the AWAIT, which
    // is the only thing this probe controls. The signal is still passed, because
    // a well-behaved body should see the cancellation.
    //
    // A ROUTE THAT TIMES OUT IS NOT A REFUSAL, and is recorded separately
    // (`settled: false`): it means the call reached DISPATCH, which is the
    // opposite of the claim the negative arm makes. A reader must not read the
    // timeout as the registry refusing it.
    for (const route of CREATION_ROUTES) {
      const record = {
        tool: route.tool, row: route.row, executed: null, isError: null,
        errorCode: null, errorName: null, message: null, contentText: null,
        settled: false, dispatchedButUnsettled: false,
      }
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), ROUTE_BOUND_MS)
      try {
        const result = await Promise.race([
          tools.execute({
            callId: `p6-surface-${route.tool}`,
            name: route.tool,
            arguments: creationArgs(route.tool),
            agent,
            signal: controller.signal,
          }),
          new Promise(resolve => {
            setTimeout(() => resolve(TIMEOUT_SENTINEL), ROUTE_BOUND_MS)
          }),
        ])
        if (result === TIMEOUT_SENTINEL) {
          record.dispatchedButUnsettled = true
          record.executed = null
        } else {
          record.settled = true
          Object.assign(record, refusalOf(result === undefined ? null : JSON.parse(JSON.stringify(result))))
        }
      } catch (error) {
        // A throw is a refusal too, and is recorded as such rather than as an
        // execution. The code is read from the error when it carries one.
        record.settled = true
        record.isError = true
        record.errorCode = error?.code ?? null
        record.errorName = error?.name ?? null
        record.message = String(error instanceof Error ? error.message : error).slice(0, 300)
        record.executed = false
      } finally {
        clearTimeout(timer)
      }
      finding.unknownToolRefusals.push(record)
      flush()
    }
    finding.anyCreationRouteExecuted = finding.unknownToolRefusals.some(r => r.executed === true)

    // ---- (6) the management surface that MUST survive --------------------
    // V5 §8: "Keep only what is actually needed to communicate with/list
    // WorkService-created children". Each of these must be VISIBLE, or the
    // model cannot steer or see its managed children.
    for (const toolName of MANAGEMENT_TOOLS) {
      const definition = tools.get?.(toolName, agent)
      finding.managementSurface[toolName] = {
        visibleToModel: definition !== undefined,
        // The ARGUMENT NAMES, not the JSON-schema keywords: "present" must not
        // be mistaken for "usable". `parameters` on a registered definition is
        // the compiled schema, so its argument names live under `properties`.
        parameters: definition?.parameters === undefined
          ? null
          : Object.keys(definition.parameters?.properties ?? {}),
      }
    }

    // FLUSH THE PARTIAL FILE BEFORE THE BRIDGE ARM. The catalog and the direct
    // refusals are the deliverable; a kernel that hangs must not cost them.
    // (The partial path, not `OUT`: see the module header.)
    flush()

    // ---- (3b) THE HIDDEN ARM: the ipython bridge ------------------------
    // A SECOND model-facing door into the same registry. `dsh.call` is
    // translated into `ctx.tools.execute` by the host with host-bound
    // authority (packages/dsh-ipython/src/native-call.ts:148), so if a creation
    // tool were still registered, Python would reach it without ever naming it
    // in the catalog. Best-effort: the arm records its own failure rather than
    // taking the artifact down with it.
    finding.bridgeArm = { available: false, reason: null, refusals: [], error: null }
    try {
      const ipython = ctx.get('ipython')
      if (ipython === undefined) {
        finding.bridgeArm.reason = 'the ipython service is not composed in this profile'
      } else if (!finding.tools.includes('ipython')) {
        finding.bridgeArm.reason = 'the ipython TOOL is absent from the agent-keyed catalog'
      } else {
        const wanted = CREATION_ROUTES.map(r => r.tool)
        const code = [
          'import json',
          'out = []',
          'for name in ' + JSON.stringify(wanted) + ':',
          '    try:',
          "        value = await dsh.call(name, {'description': 'p6 bridge probe', 'prompt': 'must be refused'})",
          "        out.append({'tool': name, 'outcome': 'EXECUTED', 'value': str(value)[:200]})",
          '    except Exception as error:',
          "        out.append({'tool': name, 'outcome': 'REFUSED', 'error': str(error)[:300]})",
          "print('P6_BRIDGE=' + json.dumps(out, sort_keys=True))",
        ].join('\n')
        const result = await tools.execute({
          callId: 'p6-surface-bridge-arm',
          name: 'ipython',
          arguments: { code },
          agent,
          signal: new AbortController().signal,
        })
        const json = result === undefined ? null : JSON.parse(JSON.stringify(result))
        const text = String(json?.value?.text ?? json?.content?.[0]?.text ?? '')
        const line = /P6_BRIDGE=(.*)$/mu.exec(text)?.[1]
        finding.bridgeArm.available = true
        finding.bridgeArm.isError = json?.isError ?? null
        finding.bridgeArm.errorCode = json?.error?.info?.code ?? null
        finding.bridgeArm.cellText = text.slice(0, 4000)
        finding.bridgeArm.refusals = line === undefined ? null : JSON.parse(line)
        finding.bridgeArm.anyExecuted = Array.isArray(finding.bridgeArm.refusals)
          ? finding.bridgeArm.refusals.some(entry => entry.outcome === 'EXECUTED')
          : null
        await ipython.close?.().catch(() => undefined)
      }
    } catch (error) {
      finding.bridgeArm.error = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
    }
  } catch (error) {
    finding.error = error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error)
    finding.errorPhase = finding.errorPhase ?? 'outer'
  }

  finish()
  process.stdout.write(`P6-SURFACE: ${JSON.stringify({
    toolCountAgentKey: finding.toolCountAgentKey,
    tools: finding.tools,
    anyCreationRouteExecuted: finding.anyCreationRouteExecuted,
    bridgeArmAnyExecuted: finding.bridgeArm?.anyExecuted ?? null,
    error: finding.error,
  })}\n`)
}
