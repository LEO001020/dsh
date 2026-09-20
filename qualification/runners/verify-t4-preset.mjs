/**
 * T4 boot probe: what does the AGENT PRESET plane actually put in front of the
 * model, now that the model-facing PowerShell row is off?
 *
 * WHY THE PRESET AND NOT THE PROFILE PATCH.
 * `packages/bundle/web-app/cordis.patch.yml` moved the agent plane behind agent
 * presets: it DISABLES the host rows `tool-pwsh`, `tool-bash`, `tool-fs`,
 * `tool-fs-search`, `tool-jobs`, `tool-skill`, `tool-subagent*`,
 * `workflow-ptc`, `tool-workflow`, `tool-todo`, `tool-web`, `plan-mode`,
 * `compaction-*` and `agent-instructions`, and lets each Session mount a preset
 * that composes them instead. `ctx.tools` layers are keyed by the AGENT OBJECT,
 * so a tool row mounted at host level publishes into the root realm where no
 * agent's scope sees it (Trap 7 in `docs/DELIVERY.md`, and the reason
 * `daily-work-tools`/`ipython-tool` live in the preset at all).
 *
 * The consequence is the correction this probe exists to measure: **editing
 * `profiles/daily-candidate/cordis.patch.yml` cannot change the model's tool
 * surface.** The preset is the file that decides it. So this probe boots the
 * real profile, creates a real Session on the profile's OWN default preset, and
 * reports the catalog that Session's agent is offered.
 *
 * WHY A REAL BOOT AND NOT `--dump-config`.
 * `--dump-config` does NOT execute plugins. It prints the composed row list and
 * never runs a probe's `apply`, so it can only report the patch that was
 * written -- never whether a row ACTIVATED. Every question below is a question
 * about activation. (Measured on this deployment by the root agent: a
 * `--dump-config` run produces no probe artifact at all.)
 *
 * WHAT IT REPORTS (the driver asserts; this file measures).
 *   - the full sorted tool list and `toolCountAgentKey`
 *   - `pwsh` present or absent; `ipython` present with exactly one parameter
 *   - the row -> tool mapping, so "27 entries" is separable from "the fs row is
 *     still mounted"
 *   - the preset ROOTS, so a caller can prove the result describes the home it
 *     booted (a probe writing to a fixed path is a SHARED MUTABLE RESOURCE, and
 *     that produced a false PASS earlier in this project -- G-FIX-13)
 *   - the LIVE loader activation state, read from inside the process, so "zero
 *     entries did not activate" is a measurement rather than a log scrape
 *
 * IT ADDS NO ROWS OF ITS OWN. Everything it reports comes from the profile's
 * own composition. A probe that inserted a tool row would prove the tool works
 * when a row is present without proving the product carries one -- the
 * G-FIX-04 / G-FIX-05 / G-FIX-12 defect class.
 *
 * THE SCOPE KEY. The key for a tool view is the AGENT OBJECT, not its context:
 * `AgentLoop` builds the scope with `createScope(loopCtx, this)`
 * (packages/core/agent-loop/src/agent.ts:104). Passing `agent.ctx` yields a key
 * owning no scope layer, so the view collapses to the global layer and holds
 * zero agent tools. That false negative is G-FIX-06, so BOTH keys are measured
 * and the contrast is recorded as evidence rather than folklore.
 */
import { writeFileSync } from 'node:fs'

export const name = 'verify-t4-preset'

// `sessionController` alone, deliberately.
//
// An earlier probe in this project injected a service it wanted to ASSERT was
// present, which is self-defeating: `inject` is a readiness gate, so the row
// never runs and the artifact is never written when the service is missing --
// the failure mode then reports as "no result" instead of "absent". This probe
// injects only the session controller (needed to create the Session it
// measures) and reads everything else through `ctx.get`, so a missing service
// lands in the artifact as `false` rather than as silence.
export const inject = ['sessionController']

import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

/** The repository root of the tree THIS FILE was loaded from. */
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..').replace(/\\/g, '/')

const OUT = process.env.DSH_PROBE_OUT
  ?? join(REPO_ROOT, 'qualification/results/T4-preset/boot.json')

/**
 * The tool names each row in `daily-standard/agent.cordis.yml` registers.
 *
 * Recorded in the artifact so the row -> tool mapping travels with the
 * measurement: "the catalog has 27 entries" is not the claim, "the row that
 * owns `read`/`write`/`edit`/`read_image` is still mounted" is.
 */
const ROW_TOOLS = {
  'tool-fs': ['read', 'write', 'edit', 'read_image'],
  'tool-fs-search': ['grep', 'glob'],
  'tool-web': ['web_search', 'web_fetch'],
  'tool-jobs': ['job_list', 'job_output', 'job_kill'],
  'tool-skill': ['skill'],
  'tool-goal': ['create_goal', 'get_goal', 'update_goal'],
  'plan-mode': ['exit_plan_mode'],
  'tool-subagent-control': ['list_agents', 'interrupt_agent'],
  'tool-subagent': ['subagent'],
  'tool-subagent-fork': ['subagent_fork'],
  'tool-workflow': ['workflow'],
  'tool-ask-user': ['ask_user_question'],
  'tool-todo': ['todo_write'],
  present: ['present'],
  'daily-work-tools': ['work'],
  'ipython-tool': ['ipython'],
}

/**
 * Whether an entry is in a state where the model can rely on it.
 *
 * A Cordis fiber is `ACTIVE` only when its callback completed and its services
 * are published. The other states are the failure modes this project has
 * actually hit: `PENDING` is a row waiting on a service that never arrived
 * (the all-or-nothing preset mount), `FAILED` is a row whose callback threw,
 * and a missing fiber is a module that never imported at all.
 *
 * The state is read from `entry.fiber.state` as a NUMBER, matching the
 * `FiberState` enum in `vendor/cordis/src/fiber.ts:147-155`
 * (PENDING=0, LOADING=1, ACTIVE=2, FAILED=3, DISPOSED=4, UNLOADING=5). Reading
 * it as a number avoids importing a vendor package from a file that has no
 * `node_modules` of its own -- an earlier probe in this project did that and
 * produced a warning that looked like a product defect when it was a property
 * of the probe.
 */
const FIBER_ACTIVE = 2

/**
 * Host-plane rows whose state makes the "which plane is the lever" claim
 * checkable from the artifact rather than from a source read.
 *
 * `tool-pwsh`, `tool-fs`, `tool-fs-search`, `tool-jobs`, `tool-subagent` and
 * `tool-workflow` are all DISABLED at host level by the Web bundle's patch
 * (`packages/bundle/web-app/cordis.patch.yml`) — yet the model still saw `pwsh`
 * before this task's edit, because the preset is what publishes the catalog.
 * Recording both halves in one artifact is what makes that a measurement.
 */
const HOST_ROWS_OF_INTEREST = [
  'tool-pwsh', 'tool-bash', 'tool-fs', 'tool-fs-search', 'tool-jobs',
  'tool-subagent', 'tool-workflow', 'tool-web', 'tool-todo', 'agent-presets',
]

export async function apply(ctx) {
  const finding = {
    probe: 'T4-preset',
    ranAt: new Date().toISOString(),
    profileName: 'daily-candidate (installed as "daily")',
    presetDefaultId: null,
    presetRoots: [],
    presetsListed: [],
    // The live loader audit, read from INSIDE the process rather than scraped
    // from the boot log.
    loaderEntryCount: 0,
    inactiveEntries: [],
    // Host-plane services, so "the preset lost a row" and "the bundle never
    // mounted" are separable facts in the artifact.
    kernelServicePresent: false,
    workServicePresent: false,
    dataServicePresent: false,
    historyServicePresent: false,
    programmaticScopePresent: false,
    writersServicePresent: false,
    // The measurement.
    sessionCreated: false,
    sessionId: null,
    // `SessionCreateValue` is `{ sessionId, agentPreset? }`
    // (packages/api/session-controller/src/commands.ts:121). Recorded because
    // "the deployment default is daily-standard" and "the Session I measured
    // actually mounted daily-standard" are different facts, and only the second
    // makes the tool list below evidence about THIS preset.
    agentPreset: null,
    toolCountAgentKey: 0,
    toolCountContextKey: 0,
    tools: [],
    rowTools: ROW_TOOLS,
    pwshToolPresent: null,
    ipythonToolPresent: false,
    ipythonParameterNames: null,
    ipythonIsOnlyParameter: false,
    forbiddenLifecycleTools: [],
    // The sandbox ESCALATION fields (`sandbox_permissions` + `justification`)
    // that each model-visible schema advertises, and the backend capability
    // that gates them.
    //
    // RECORDED HERE BECAUSE THE ATTRIBUTION IS EASY TO GET WRONG. Both gates
    // read the mounted BACKEND's capability, not the preset:
    //   - `tool-pwsh` reads `ctx.shell.sandboxMode`
    //     (packages/shell/tool-pwsh/src/index.ts:196); the sandboxing executor
    //     `pwsh-sandbox` overrides it (packages/shell/pwsh-sandbox/src/index.ts:83).
    //   - `tool-fs` reads `ctx.fs.sandboxMode` through `FsSandboxController`
    //     (packages/fs/tool-fs/src/sandbox.ts:45); the base class reports
    //     `undefined` and only a confining backend overrides it
    //     (packages/fs/fs/src/index.ts:104).
    // So a preset change that removes the `pwsh` TOOL row removes ONE tool that
    // carried these fields, and cannot remove them from `write`/`edit`, whose
    // gate is the fs BACKEND. Recording both facts in one artifact is what
    // makes the two changes separable by a reader instead of conflated.
    escalationFieldsByTool: {},
    toolsWithEscalationFields: [],
    shellSandboxMode: null,
    fsSandboxMode: null,
    error: null,
  }
  try {
    // (1) The roster's OWN view of its roots and default. This answers "did the
    //     deployment-added preset root resolve", separately from "did a tool
    //     row land".
    const roster = ctx.get('agentPresets')
    if (roster !== undefined) {
      finding.presetDefaultId = roster.defaultId ?? null
      finding.presetRoots = (roster.roots ?? []).map(root => ({
        path: String(root.path), trust: String(root.trust),
      }))
      const listed = await roster.list()
      finding.presetsListed = listed.map(p => ({ id: p.id, trust: p.trust, broken: p.broken ?? null }))
    } else {
      finding.error = 'ctx.agentPresets is absent: the roster row did not activate'
    }

    // (2) The host-plane services the two bundles provide.
    finding.kernelServicePresent = ctx.get('ipython') !== undefined
    finding.workServicePresent = ctx.get('dailyWork') !== undefined
    finding.dataServicePresent = ctx.get('dailyData') !== undefined
    finding.historyServicePresent = ctx.get('dailyHistory') !== undefined
    finding.programmaticScopePresent = ctx.get('programmaticScope') !== undefined
    finding.writersServicePresent = ctx.get('dailyWriters') !== undefined

    // (3) The live loader audit. This is the same predicate
    //     `app-boot`'s `inactiveEntries()` uses for its "N entries did not
    //     activate" warning (packages/boot/app-boot/src/index.ts:766-805), read
    //     here so the artifact carries the fact itself rather than a log line
    //     whose absence could mean "healthy" or "never printed".
    const loader = ctx.get('loader')
    if (loader !== undefined) {
      const inactive = []
      // The HOST-plane rows for the ids this deployment cares about, with their
      // `disabled` flag. This is the measurement behind the correction the task
      // is built on: `packages/bundle/web-app/cordis.patch.yml` sets
      // `disabled: true` on the HOST `tool-pwsh` row, and if that were the
      // lever the model would never have seen `pwsh`. Recording the host row's
      // state beside the model's catalog turns "the host plane is not the
      // lever" into two facts from one boot instead of an inference from a
      // source read.
      const hostRows = []
      let total = 0
      for (const entry of loader.entries()) {
        total += 1
        // THIS PROBE'S OWN ROW is skipped, and the reason is mechanical rather
        // than convenient: `apply` is running right now, so its fiber is in
        // `LOADING` (state 1) by construction. Counting it would make the audit
        // report one permanently-inactive entry in every run, which is a
        // property of the instrument and not of the composition. It is skipped
        // BY ID, so no other row can hide behind this exemption.
        if (entry.options.id === name) continue
        if (HOST_ROWS_OF_INTEREST.includes(entry.options.id)) {
          let disabled = null
          let disabledError = null
          try {
            disabled = entry.disabled === true
          } catch (error) {
            // A throwing `disabled` expression is an entry failure, not a
            // disabled entry (app-boot's own distinction), so it is recorded
            // as such rather than as `false`.
            disabledError = String(error)
          }
          hostRows.push({
            id: entry.options.id,
            name: entry.options.name,
            disabled,
            disabledError,
            fiberState: entry.fiber?.state ?? null,
          })
        }
        try {
          if (entry.disabled) continue
        } catch (error) {
          inactive.push({ id: entry.options.id, state: 'disabled-expression-threw', detail: String(error) })
          continue
        }
        const fiber = entry.fiber
        if (fiber === undefined) {
          inactive.push({ id: entry.options.id, state: 'never-started', detail: entry.options.name })
          continue
        }
        if (fiber.state === FIBER_ACTIVE) continue
        // A row can still be legitimately in flight while the probe runs; the
        // state is recorded either way and the driver decides. What must NOT
        // happen is a silent omission.
        inactive.push({ id: entry.options.id, state: `fiber-state-${String(fiber.state)}`, detail: entry.options.name })
      }
      finding.loaderEntryCount = total
      finding.skippedSelfRowId = name
      finding.hostRowsOfInterest = hostRows
      finding.inactiveEntries = inactive
    } else {
      finding.error = 'ctx.loader is absent: the probe cannot audit activation'
    }

    // (4) A REAL Session on the profile's OWN default preset, and its catalog.
    //     The agent is looked up from the registry by session id -- the same
    //     access path the working `verify-ipython-e2e.mjs` probe uses.
    const sc = ctx.get('sessionController')
    if (sc === undefined) {
      finding.error = 'ctx.sessionController is absent: the probe cannot create the Session it measures'
    } else {
      const created = await sc.create({ cwd: REPO_ROOT })
      finding.sessionId = created?.sessionId ?? created?.id ?? null
      finding.sessionCreated = finding.sessionId !== null
      finding.agentPreset = created?.agentPreset ?? null

      const agent = ctx.get('agents')?.get(finding.sessionId)
      if (agent === undefined) {
        finding.error = 'the created session has no live agent in this process'
      } else {
        const tools = ctx.get('tools')
        const schemas = tools.schemas(agent)
        const names = schemas.map(s => s.name).sort()
        finding.toolCountAgentKey = names.length
        finding.tools = names
        finding.pwshToolPresent = names.includes('pwsh')
        finding.ipythonToolPresent = names.includes('ipython')
        const ipython = schemas.find(s => s.name === 'ipython')
        if (ipython !== undefined) {
          const properties = Object.keys((ipython.parameters ?? {}).properties ?? {})
          finding.ipythonParameterNames = properties
          finding.ipythonIsOnlyParameter = properties.length === 1 && properties[0] === 'code'
        }
        // No kernel LIFECYCLE tool may exist: a model that can open, feed or
        // close a kernel is a model that can leak or destroy one. The kernel
        // stays on the host plane, reachable only through the one `ipython`
        // cell tool.
        const forbidden = [
          'ipython_open', 'ipython_send', 'ipython_read', 'ipython_status', 'ipython_close',
        ]
        finding.forbiddenLifecycleTools = names.filter(n => forbidden.includes(n))

        // Which schemas actually ADVERTISE the escalation fields. Measured from
        // the model-visible parameters rather than inferred from the row list,
        // because the advertisement is what the model sees.
        const ESCALATION = ['sandbox_permissions', 'justification']
        const byTool = {}
        for (const schema of schemas) {
          const properties = Object.keys((schema.parameters ?? {}).properties ?? {})
          const found = ESCALATION.filter(field => properties.includes(field))
          if (found.length > 0) byTool[schema.name] = found
        }
        finding.escalationFieldsByTool = byTool
        finding.toolsWithEscalationFields = Object.keys(byTool).sort()

        // The BACKEND capabilities those gates read. Recorded so a reader can
        // attribute each tool's fields to the plane that owns it.
        const shell = ctx.get('shell')
        finding.shellSandboxMode = shell === undefined ? null : (shell.sandboxMode ?? null)
        const fs = ctx.get('fs')
        finding.fsSandboxMode = fs === undefined ? null : (fs.sandboxMode ?? null)

        // The wrong key, measured so the difference is evidence (G-FIX-06).
        finding.toolCountContextKey = tools.schemas(agent.ctx).length
      }
    }
  } catch (error) {
    finding.error = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
  }
  writeFileSync(OUT, `${JSON.stringify(finding, null, 2)}\n`, 'utf8')
}
