/**
 * R4 boot probe: does a REAL human-control path on the composed profile create
 * a durable run, and can the model's own `work` tool then resolve it?
 *
 * WHY A BOOT PROBE AND NOT A UNIT TEST. `createRun` has exactly one non-test
 * caller in the repository and it is a hand-run CLI in no production import
 * graph (G-SEAM-31). A unit test that calls `createRun` therefore proves the
 * MECHANISM and says nothing about the product — the defect class this project
 * has recorded more than twelve times. So this probe boots the REAL daily
 * profile through the REAL resolver and drives the REAL seam:
 *
 *   1. It creates a real Session on the deployment's own preset.
 *   2. It executes `/work start N` through `ctx.commands.execute(agent, line,
 *      [], signal)` — the SAME `CommandRuntime` entry point the browser's
 *      `ctx.remote.commands.execute(...)` reaches. That is the human-control
 *      seam; execution does not send the command to the model.
 *   3. It calls the model-facing `work` tool through `ctx.tools.execute` with
 *      the real agent, and records whether the tool can now FIND the run.
 *
 * WHAT IT REFUSES TO DO. It does NOT call `WorkService.createRun` and it does
 * NOT call `WorkService.authorizeRun` directly. Either would install the very
 * entry point whose existence is the question. It also does not insert a
 * product row: it measures what the profile's OWN composition mounts.
 *
 * NEGATIVE ARMS, which is where the value is. Every "must NOT happen" clause of
 * V3 section I2 is measured on this same live boot, not argued:
 *   - Session creation ALONE leaves no run (the probe records the run count
 *     immediately after `sessions.create`, before any command);
 *   - a settings reload does not create a run;
 *   - a model continuation cannot create one (the tool's `action` enum is
 *     checked for an absent create action AND the raw model call is made);
 *   - a duplicate `/work start` is deterministic and yields ONE run;
 *   - `/work target N` is durable across a real host restart.
 *
 * WHY IT INJECTS ONLY `sessionController`. `inject` is a readiness gate, so a
 * probe that injected `dailyWork` would not run at all when the service is
 * missing and the artifact would be ABSENT instead of reporting `false`. Every
 * other service is read through `ctx.get`, so a missing one lands in the
 * artifact as a measured absence.
 */
import { writeFileSync } from 'node:fs'

export const name = 'verify-r4-authorization'
export const inject = ['sessionController']

const OUT = process.env.DSH_PROBE_OUT
  ?? 'D:/DSH/work/wt-r4/qualification/results/R4-authorization/boot.json'

/**
 * Read the run counts and the run this host holds for one session id.
 *
 * Read from the SERVICE, which is the authority on which runs exist. Nothing
 * here is inferred from a log or a cache.
 *
 * TWO COUNTS, and the distinction is not pedantic. `runCount` is every run the
 * HOST knows about, and the store is DURABLE: a second boot over the same
 * DSH_HOME still holds the runs a previous boot created, whose `rootSessionId`
 * belongs to a session that no longer exists. `runsForSession` is what every
 * "must not create a run" arm actually asks about, so that is the number those
 * checks use. Reporting only the host-wide count would make a correct second boot
 * look like it had auto-created a run.
 */
function runView(service, sessionId) {
  if (service === undefined) {
    return { runCount: null, runsForSession: null, runIds: null, sessionRunIds: null, run: null }
  }
  const runIds = service.listRunIds()
  const sessionRunIds = []
  let run = null
  for (const runId of runIds) {
    const record = service.getRun(runId)
    if (record?.rootSessionId !== sessionId) continue
    sessionRunIds.push(String(runId))
    run = record
  }
  return {
    runCount: runIds.length,
    runsForSession: sessionRunIds.length,
    runIds: runIds.map(String),
    sessionRunIds,
    run: run === null ? null : {
      runId: String(run.runId),
      rootSessionId: String(run.rootSessionId),
      authorizationRef: String(run.authorizationRef),
      phase: String(run.phase),
      requestedTarget: run.requestedTarget,
      epoch: run.epoch,
      createdAt: run.createdAt,
    },
  }
}

/** The model-facing text of a tool result, joined; empty for a value-only outcome. */
function modelText(result) {
  const content = result?.content
  if (!Array.isArray(content)) return ''
  return content.map(block => (block?.type === 'text' ? String(block.text ?? '') : '')).join('\n')
}

export async function apply(ctx) {
  const finding = {
    probe: 'R4-authorization',
    ranAt: new Date().toISOString(),
    profileName: ctx.get('profileContext')?.profile?.name ?? 'unknown',

    // The preset the Session actually mounted, so the tool/command face below
    // is provably this preset's.
    agentPreset: null,
    sessionId: null,
    concurrentSessionId: null,
    presetRoots: [],

    // (0) The service exists at all.
    workServicePresent: false,

    // (1) NEGATIVE ARM: Session creation alone must not create a run.
    runCountAfterSessionCreate: null,
    hostRunCountAfterSessionCreate: null,
    runAfterSessionCreate: null,

    // (2) Is the `/work` command registered in this agent's effective view?
    workCommandRegistered: false,
    workCommandNames: [],
    workCommandDescriptor: null,

    // (2b) The UI arm: the exact client -> Remote `commands/execute` route.
    uiRouteAvailable: false,
    uiStatusInvoke: null,
    uiStatusUnresolved: null,
    uiStatusInvokeError: null,
    uiStartInvoke: null,
    uiStartUnresolved: null,
    uiStartInvokeError: null,
    runCountAfterUiStart: null,
    runCountAfterUiStatus: null,

    // (2c) The FULL-TRANSPORT arm: `POST /api/commands/execute` over real HTTP
    // with the process launch-token cookie, exactly as the browser does.
    httpArmAvailable: false,
    httpArmOrigin: null,
    httpArmError: null,
    httpStatusStatus: null,
    httpStatusBody: null,
    httpStartStatus: null,
    httpStartBody: null,
    runCountAfterHttpStatus: null,
    runCountAfterHttpStart: null,

    // (2d) CONCURRENCY: two simultaneous authorizations for one session.
    concurrentStartTexts: [],
    runCountAfterConcurrentStart: null,
    concurrentClaimedCreated: null,

    // (3) THE POSITIVE ARM: `/work start N` through CommandRuntime.
    startResultKind: null,
    startResultText: null,
    startCommandId: null,
    startError: null,
    runCountAfterStart: null,
    hostRunCountAfterStart: null,
    runAfterStart: null,

    // (4) DUPLICATE START: must be deterministic and must not create a second run.
    duplicateStartKind: null,
    duplicateStartText: null,
    runCountAfterDuplicateStart: null,
    hostRunCountAfterDuplicateStart: null,
    duplicateRunId: null,

    // (5) TARGET UPDATE is durable on the record.
    targetUpdateKind: null,
    targetUpdateText: null,
    targetAfterUpdate: null,

    // (6) STOP must not prematurely free child capacity.
    stopKind: null,
    stopText: null,
    phaseAfterStop: null,
    gateAfterStop: null,

    // (7) THE CLAUSE THAT PROVES F1 IS CLOSED: the real `work` tool resolves
    // the run, and real refill becomes reachable.
    workToolPresent: false,
    toolCountAgentKey: 0,
    workToolIsError: null,
    workToolErrorText: null,
    workToolValue: null,
    workToolResolvedRun: null,
    workToolRunIdMatches: null,

    // (8) NEGATIVE ARM: the model cannot create a run.
    modelCanCreateRun: null,
    modelCreateErrorText: null,
    runCountBeforeModelCreateAttempt: null,
    runCountAfterModelCreateAttempt: null,
    workToolActions: [],

    // (9) NEGATIVE ARM: settings reload must not create a run.
    settingsReloadRan: false,
    settingsReloadError: null,
    runCountBeforeSettingsReload: null,
    runCountAfterSettingsReload: null,

    // (10) The durable evidence a reader needs: the command lifecycle the
    // human command wrote on the session log.
    commandRunEvents: [],
    commandDoneEvents: [],

    error: null,
    errorPhase: null,
  }

  const service = ctx.get('dailyWork')
  finding.workServicePresent = service !== undefined

  let agent
  try {
    // ---- (1) Session creation ALONE ------------------------------------
    const sessions = ctx.get('sessionController')
    const created = await sessions.create({ cwd: 'D:/DSH/work/wt-r4' })
    finding.sessionId = String(created.sessionId)
    finding.agentPreset = created.agentPreset ?? null
    const roster = ctx.get('agentPresets')
    if (roster !== undefined) {
      finding.presetRoots = (roster.roots ?? []).map(root => String(root.path))
    }
    agent = ctx.get('agents')?.get(created.sessionId)

    const afterCreate = runView(service, finding.sessionId)
    finding.runCountAfterSessionCreate = afterCreate.runsForSession
    finding.hostRunCountAfterSessionCreate = afterCreate.runCount
    finding.runAfterSessionCreate = afterCreate.run

    // ---- (2) the `/work` command in this agent's effective view --------
    const commands = ctx.get('commands')
    if (commands !== undefined && agent !== undefined) {
      const listed = commands.list(agent)
      finding.workCommandNames = listed.map(entry => String(entry.name))
      const descriptor = listed.find(entry => entry.name === 'work')
      finding.workCommandRegistered = descriptor !== undefined
      finding.workCommandDescriptor = descriptor === undefined ? null : {
        name: descriptor.name,
        description: descriptor.description,
        hint: descriptor.input?.hint ?? null,
      }
    }

    // ---- (2b) THE UI ARM: the exact client -> Remote route ---------------
    // `packages/client/ui-commands/src/client/service.ts:387` calls
    // `this.ctx.remote.commands.execute(sessionId, line, attachments)`, which the
    // gateway serves by dispatching endpoint `commands/execute` with wire args
    // `{ agentId, line, submittedAttachments }` (the `agentId` lookup resolves a
    // SessionId to the exact live Agent through `ctx.typert.lookups`, configured
    // by the session controller at agent.ts:148). This probe drives THAT route
    // directly, so the UI path is measured rather than argued. It is a SECOND
    // adapter on the same handler: the slash-command arm and this one must reach
    // ONE domain operation, which is the property V3 section I1 requires.
    const gateway = ctx.get('typertGateway')
    finding.uiRouteAvailable = gateway !== undefined
    const uiInvoke = async (line) => {
      if (gateway === undefined) return { value: null, error: 'no typertGateway mounted' }
      try {
        const value = await gateway.invoke({
          namespace: 'commands',
          method: 'execute',
          args: {
            agentId: String(finding.sessionId),
            line,
            submittedAttachments: [],
          },
          signal: new AbortController().signal,
        })
        // `execute` returns `undefined` when the line does not resolve to a
        // registered command (syntax miss or unknown name), and JSON has no
        // `undefined`. That is a MEASUREMENT, not an error, so it is recorded
        // as its own value rather than thrown by a JSON round trip.
        if (value === undefined) return { value: null, unresolved: true, error: null }
        return { value: JSON.parse(JSON.stringify(value)), unresolved: false, error: null }
      } catch (error) {
        return { value: null, unresolved: false, error: error instanceof Error ? error.message : String(error) }
      }
    }

    if (commands === undefined || agent === undefined) {
      finding.error = 'the command registry or the agent is unavailable; the human seam cannot be measured'
      finding.errorPhase = 'preconditions'
      writeFileSync(OUT, JSON.stringify(finding, null, 2))
      return
    }

    // ---- (2c) THE FULL-TRANSPORT ARM: real HTTP, as the browser does ------
    // WHY THIS ARM EXISTS. The gateway arm above reaches the RIGHT ENDPOINT but
    // not the right TRANSPORT: a browser's button reaches `POST
    // /api/commands/execute` over HTTP with the process launch-token cookie, and
    // the route that serves it enforces host trust and authentication
    // (`requestRejection` -> 403/401). Measuring only the in-process dispatcher
    // would leave "the UI can actually reach this" as an argument.
    //
    // The token is obtained the way the browser obtains it: from
    // `ctx.connection.authenticatedUrl(origin)`, then exchanged through
    // `authorizeIndex` for the signed cookie. That is the shipped
    // `BrowserAuth` flow, not a bypass.
    const connection = ctx.get('connection')
    // The port is read from the LIVE `webServer` service rather than passed in:
    // `boot-harness.mjs` picks a free port by binding it, so a hardcoded number
    // would either be wrong or collide. `web-app`'s own `localWebUrl` reads the
    // same accessor (`packages/bundle/web-app/src/index.ts:150`).
    const bootPort = ctx.get('webServer')?.port
    finding.httpArmOrigin = bootPort === undefined ? null : `http://127.0.0.1:${String(bootPort)}`
    finding.httpArmAvailable = connection !== undefined && gateway !== undefined && bootPort !== undefined
    const httpInvoke = async (line, rpcId) => {
      if (connection === undefined || bootPort === undefined) {
        return { error: 'no connection service or web server port available' }
      }
      const origin = `http://127.0.0.1:${String(bootPort)}`
      try {
        const target = new URL(connection.authenticatedUrl(origin))
        let cookie
        connection.authorizeIndex(
          { method: 'GET', url: `${target.pathname}${target.search}`, headers: { host: target.host } },
          {
            writeHead(_status, headers) { cookie = headers?.['set-cookie'] },
            end() {},
          },
        )
        if (cookie === undefined) return { error: 'no authentication cookie was issued' }
        const response = await fetch(`${origin}/api/commands/execute`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            cookie: cookie.split(';', 1)[0],
          },
          body: JSON.stringify({
            type: 'client-request',
            rpcId,
            method: 'commands/execute',
            payload: { args: { agentId: String(finding.sessionId), line, submittedAttachments: [] } },
          }),
        })
        const text = await response.text()
        return { status: response.status, body: text }
      } catch (error) {
        return { error: error instanceof Error ? error.message : String(error) }
      }
    }

    // ---- (2d) TWO CONCURRENT AUTHORIZATIONS FOR ONE SESSION ------------
    // The check-then-act race the root agent found. Measured through the REAL
    // command registry, as two UI dispatches would arrive, and BEFORE the
    // sequential arm below so the run count is unambiguous. A second session is
    // created so this arm's run cannot be confused with the positive arm's.
    if (commands !== undefined && ctx.get('agents') !== undefined) {
      const concurrentSession = await sessions.create({ cwd: 'D:/DSH/work/wt-r4' })
      const concurrentAgent = ctx.get('agents')?.get(concurrentSession.sessionId)
      if (concurrentAgent !== undefined) {
        const settled = await Promise.all([
          commands.execute(concurrentAgent, '/work start 10', [], new AbortController().signal),
          commands.execute(concurrentAgent, '/work start 10', [], new AbortController().signal),
        ])
        finding.concurrentStartTexts = settled.map(
          execution => String(execution?.result?.text ?? '').split(String.fromCharCode(10), 1)[0] ?? '',
        )
        finding.concurrentClaimedCreated = finding.concurrentStartTexts
          .filter(text => text.includes('Run authorized')).length
        finding.runCountAfterConcurrentStart = runView(
          service, String(concurrentSession.sessionId),
        ).runsForSession
        finding.concurrentSessionId = String(concurrentSession.sessionId)
      }
    }

    // ---- (3) THE POSITIVE ARM ------------------------------------------
    // The exact call a UI adapter makes. `execute` does not send the line to
    // the model: it resolves the definition and calls the handler directly,
    // logging `command/run` with `source.kind === 'user'`.
    try {
      const execution = await commands.execute(
        agent, '/work start 10', [], new AbortController().signal,
      )
      if (execution === undefined) {
        finding.startError = 'the command did not resolve (execute returned undefined)'
      } else {
        finding.startResultKind = execution.result.kind
        finding.startResultText = execution.result.text ?? null
        finding.startCommandId = String(execution.commandId)
      }
    } catch (error) {
      finding.startError = error instanceof Error ? error.message : String(error)
    }

    const afterStart = runView(service, finding.sessionId)
    finding.runCountAfterStart = afterStart.runsForSession
    finding.hostRunCountAfterStart = afterStart.runCount
    finding.runAfterStart = afterStart.run

    // ---- (4) DUPLICATE START -------------------------------------------
    try {
      const execution = await commands.execute(
        agent, '/work start 10', [], new AbortController().signal,
      )
      if (execution !== undefined) {
        finding.duplicateStartKind = execution.result.kind
        finding.duplicateStartText = execution.result.text ?? null
      }
    } catch (error) {
      finding.duplicateStartText = error instanceof Error ? error.message : String(error)
    }
    const afterDuplicate = runView(service, finding.sessionId)
    finding.runCountAfterDuplicateStart = afterDuplicate.runsForSession
    finding.hostRunCountAfterDuplicateStart = afterDuplicate.runCount
    finding.duplicateRunId = afterDuplicate.run?.runId ?? null

    // ---- (2b, continued) the SAME handler through the UI's own route -----
    // `/work status` first: a pure read, and it must not change the run count.
    const uiStatus = await uiInvoke('/work status')
    finding.uiStatusInvoke = uiStatus.value
    finding.uiStatusUnresolved = uiStatus.unresolved
    finding.uiStatusInvokeError = uiStatus.error
    finding.runCountAfterUiStatus = runView(service, finding.sessionId).runsForSession

    // `/work start 5` through the Remote route on a session that ALREADY has a
    // run: the adapter must be idempotent here too, so the button cannot create a
    // duplicate the slash command refuses to.
    const uiStart = await uiInvoke('/work start 5')
    finding.uiStartInvoke = uiStart.value
    finding.uiStartUnresolved = uiStart.unresolved
    finding.uiStartInvokeError = uiStart.error
    finding.runCountAfterUiStart = runView(service, finding.sessionId).runsForSession

    // ---- (2c, continued) the SAME handler over REAL HTTP ------------------
    // Both lines go through the browser's actual transport: the launch-token
    // cookie, `POST /api/commands/execute`, the connection route's host-trust and
    // auth check, and the gateway dispatcher behind it. `/work status` is a read
    // that must not change anything; `/work start 5` is the UI ACTION that must be
    // idempotent on an already-active run.
    const httpStatus = await httpInvoke('/work status', 'rpc-r4-status')
    finding.httpStatusStatus = httpStatus.status ?? null
    finding.httpStatusBody = httpStatus.body ?? null
    finding.httpArmError = httpStatus.error ?? finding.httpArmError
    finding.runCountAfterHttpStatus = runView(service, finding.sessionId).runsForSession

    const httpStart = await httpInvoke('/work start 5', 'rpc-r4-start')
    finding.httpStartStatus = httpStart.status ?? null
    finding.httpStartBody = httpStart.body ?? null
    finding.httpArmError = httpStart.error ?? finding.httpArmError
    finding.runCountAfterHttpStart = runView(service, finding.sessionId).runsForSession

    // ---- (5) TARGET UPDATE ---------------------------------------------
    try {
      const execution = await commands.execute(
        agent, '/work target 7', [], new AbortController().signal,
      )
      if (execution !== undefined) {
        finding.targetUpdateKind = execution.result.kind
        finding.targetUpdateText = execution.result.text ?? null
      }
    } catch (error) {
      finding.targetUpdateText = error instanceof Error ? error.message : String(error)
    }
    finding.targetAfterUpdate = runView(service, finding.sessionId).run?.requestedTarget ?? null

    // ---- (7) THE MODEL TOOL RESOLVES THE RUN ---------------------------
    const tools = ctx.get('tools')
    if (tools !== undefined && agent !== undefined) {
      // `schemas(agent)` is the AGENT-KEYED view. `ctx.tools` layers are keyed
      // by the AGENT OBJECT, so passing `agent.ctx` would collapse the view to
      // the global layer with zero tools (the false negative recorded as
      // G-FIX-06).
      const schemas = tools.schemas?.(agent) ?? []
      const names = schemas.map(s => s?.name).filter(n => typeof n === 'string')
      finding.workToolPresent = names.includes('work')
      finding.toolCountAgentKey = names.length

      const workSchema = schemas.find(s => s?.name === 'work')
      // `ToolSchema.parameters` is a JSON Schema object, not a definition map:
      // `{ type: 'object', properties: { action: { type: 'string', enum: [...] } } }`.
      const actionSchema = workSchema?.parameters?.properties?.action
      finding.workToolActions = Array.isArray(actionSchema?.enum)
        ? actionSchema.enum.map(String)
        : []

      if (finding.workToolPresent) {
        // A benign read-only call: `status` creates nothing. What is measured is
        // whether it can FIND the run.
        //
        // THE ORACLE IS THE RESULT, NOT AN EXCEPTION. A tool failure does NOT
        // throw out of `execute`; it returns a STRUCTURED result with
        // `isError: true`. A probe that asserted on a throw would read a failed
        // call as reachable — that error was made once in this project and
        // corrected, and this probe repeats the correction rather than the
        // mistake.
        try {
          const result = await tools.execute({
            callId: 'r4-probe-work-status',
            name: 'work',
            arguments: { action: 'status' },
            agent,
            signal: new AbortController().signal,
          })
          finding.workToolIsError = result?.isError === true
          finding.workToolValue = result === undefined ? null : JSON.parse(JSON.stringify(result.value ?? null))
          finding.workToolErrorText = finding.workToolIsError
            ? String(result?.error?.message ?? modelText(result))
            : null
          finding.workToolResolvedRun = finding.workToolValue?.runId ?? null
          finding.workToolRunIdMatches = finding.workToolValue?.runId !== undefined
            && afterDuplicate.run !== null
            && String(finding.workToolValue.runId) === String(afterDuplicate.run.runId)
        } catch (error) {
          finding.workToolErrorText = error instanceof Error ? error.message : String(error)
          finding.workToolIsError = true
        }
      }
    }

    // ---- (8) NEGATIVE ARM: the model cannot create a run ---------------
    // Measured two ways, because either alone is weak: the ACTION ENUM is read
    // from the schema the model is actually offered, and a raw call naming a
    // create action is made. The tool must not create a run either way.
    //
    // The baseline is read HERE rather than compared against the session-create
    // count, because in AFTER mode the positive arm above has already created a
    // run. Comparing to a stale baseline would report the human's own run as if a
    // model call had created it.
    const runCountBeforeModelCreate = runView(service, finding.sessionId).runsForSession
    finding.runCountBeforeModelCreateAttempt = runCountBeforeModelCreate
    if (tools !== undefined && agent !== undefined && finding.workToolPresent) {
      finding.modelCanCreateRun = finding.workToolActions.includes('create')
      try {
        const result = await tools.execute({
          callId: 'r4-probe-work-create',
          name: 'work',
          arguments: { action: 'create', targetChildren: 30, authorizedByUser: true },
          agent,
          signal: new AbortController().signal,
        })
        finding.modelCreateErrorText = result?.isError === true
          ? String(result?.error?.message ?? modelText(result))
          : 'the call was NOT an error'
      } catch (error) {
        finding.modelCreateErrorText = error instanceof Error ? error.message : String(error)
      }
    }
    finding.runCountAfterModelCreateAttempt = runView(service, finding.sessionId).runsForSession
    if (finding.runCountAfterModelCreateAttempt !== runCountBeforeModelCreate) {
      // Loud rather than quiet: a run appeared from a model call.
      finding.modelCanCreateRun = true
    }

    // ---- (9) NEGATIVE ARM: a settings change must not create a run -----
    // The exact "settings-as-action" failure V3 excludes: the settings section
    // carries a PERSISTED CONFIGURATION VALUE (`targetActiveChildren`), and
    // reading it at startup and creating a run from it would make a run that is
    // re-created on every boot. So the arm drives a REAL settings write -- the
    // strongest form of "settings changed" -- and asserts the run count does not
    // move. `describe()` is performed first because that is the read a
    // configuration surface does, and a read must be inert too.
    const settings = ctx.get('settings')
    if (settings !== undefined && service !== undefined) {
      const before = runView(service, finding.sessionId).runsForSession
      finding.runCountBeforeSettingsReload = before
      try {
        settings.describe({ redactSecrets: true })
        await settings.update('daily-work', { targetActiveChildren: 20 })
        finding.settingsReloadRan = true
      } catch (error) {
        finding.settingsReloadError = error instanceof Error ? error.message : String(error)
      }
      finding.runCountAfterSettingsReload = runView(service, finding.sessionId).runsForSession
      if (finding.runCountAfterSettingsReload !== before) finding.modelCanCreateRun = true
    }

    // ---- (10) the durable lifecycle the human command wrote ------------
    if (agent !== undefined) {
      const events = agent.session.snapshotEvents()
      for (const event of events) {
        if (event.type === 'command/run') {
          finding.commandRunEvents.push({
            seq: event.seq,
            commandId: String(event.data.commandId),
            name: event.data.name,
            args: event.data.args ?? null,
            sourceKind: event.data.source?.kind ?? null,
          })
        }
        if (event.type === 'command/done') {
          finding.commandDoneEvents.push({
            seq: event.seq,
            commandId: String(event.data.commandId),
            kind: event.data.kind,
            text: event.data.text ?? null,
          })
        }
      }
    }

    // ---- (6) STOP, LAST, because it changes the run's phase ------------
    // The order is deliberate: stop is measured AFTER the positive arm so the
    // `work` tool reading above is against an open run.
    try {
      const execution = await commands.execute(
        agent, '/work stop', [], new AbortController().signal,
      )
      if (execution !== undefined) {
        finding.stopKind = execution.result.kind
        finding.stopText = execution.result.text ?? null
      }
    } catch (error) {
      finding.stopText = error instanceof Error ? error.message : String(error)
    }
    const afterStop = runView(service, finding.sessionId)
    finding.phaseAfterStop = afterStop.run?.phase ?? null
    finding.gateAfterStop = service?.capacityGate?.snapshot() ?? null
  } catch (error) {
    finding.error = error instanceof Error ? error.message : String(error)
    finding.errorPhase = finding.errorPhase ?? 'body'
  }

  writeFileSync(OUT, JSON.stringify(finding, null, 2))
}
