/**
 * V2 COMPOSITION probe: the facts CMP-02/03/06/07/08/09/10 need from ONE real
 * composed boot of the deliverable profile.
 *
 * WHY ONE PROBE AND NOT SIX BOOTS. The CPU directive for this run is one boot at
 * a time, and each of these cases is a read of the SAME live graph. Booting once
 * and reading it six ways is both cheaper and STRONGER than six boots: the facts
 * are then provably about one composition rather than six that might differ.
 *
 * IT ADDS NO TOOL ROW. The one row it adds is ITSELF. A probe that inserted a
 * tool row would make its own catalog a measurement of the overlay -- the
 * G-FIX-04 / G-FIX-05 / G-FIX-12 defect class this project has recorded five
 * times. Everything below is read from the profile's own composition.
 *
 * `inject` is ONLY `sessionController`, and that is load-bearing rather than
 * tidy. `inject` is a READINESS GATE: a probe that injected a service it wants
 * to ASSERT is present would never run when the service is missing, so the
 * artifact would be ABSENT instead of reporting `false`. Every other service is
 * read through `ctx.get`, which returns `undefined` honestly.
 *
 * WHAT IT DOES NOT DO. It does not insert, remove or reconfigure any product row.
 * The one exception is deliberate and is the STIMULUS of CMP-09: it creates two
 * runs and admits a task in each through the service's own public API, then
 * reads both records back. That is the product's own path, and it writes only to
 * this home's storage.
 */
import { writeFileSync } from 'node:fs'

export const name = 'verify-cmp-composition'

export const inject = ['sessionController']

const OUT = process.env.DSH_PROBE_OUT
  ?? 'D:/DSH/work/dsh-native-daily/qualification/results/V2-composition/boot4-composition.json'

/** FiberState.ACTIVE === 2 (`vendor/cordis/src/fiber.ts:147-155`). */
const FIBER_ACTIVE = 2

/** The row ids whose registration count CMP-10 is about. */
const HOST_ROW_IDS = [
  'daily-work-host', 'daily-history', 'daily-data-plane', 'daily-writers',
  'daily-programmatic-scope', 'daily-no-sandbox-contract', 'daily-web-search',
  'daily-work-tool-protocol-guards', 'ipython-kernel-host',
  'sandbox-policy', 'sandbox', 'approval', 'permission', 'ui-permission',
  'fs-sandbox', 'fs-local', 'pwsh-sandbox', 'pwsh-local',
  'agent-presets', 'subagent',
]

/** Tool names a model might guess at to change its own permission posture. */
const POLICY_TOOL_GUESSES = [
  'permission', 'permission_preset', 'approval', 'set_approval_policy',
  'set_permission_mode', 'sandbox', 'escalate',
]

/** Serialise a live value for the artifact, without letting a cycle abort the probe. */
function plain(value) {
  try {
    return JSON.parse(JSON.stringify(value))
  } catch (error) {
    return `unserialisable: ${error instanceof Error ? error.message : String(error)}`
  }
}

/** One tool call through the REAL registry, on behalf of a REAL agent. */
async function callTool(ctx, agent, n, toolName, args) {
  try {
    const result = await ctx.get('tools').execute({
      callId: `cmp-${String(n)}`,
      name: toolName,
      arguments: args,
      ...agent === undefined ? {} : { agent },
      signal: new AbortController().signal,
    })
    const text = (result.content ?? []).map(b => (b.type === 'text' ? b.text : '')).join('\n')
    return {
      threw: false,
      isError: result.isError === true,
      code: result.isError === true ? (result.error?.info?.code ?? null) : null,
      message: result.isError === true ? result.error.message : text,
    }
  } catch (error) {
    // A refusal that THROWS is a different fact from one returned as
    // `isError`, so both are recorded rather than normalised away.
    return { threw: true, isError: null, code: null, message: error instanceof Error ? `${error.name}: ${error.message}` : String(error) }
  }
}

export async function apply(ctx) {
  const f = {
    probe: 'V2-cmp-composition',
    ranAt: new Date().toISOString(),
    // `presetRoots` is reported FIRST and unconditionally, and that is the
    // harness's own guard against the G-FIX-13 false PASS: a probe that writes to
    // a path is a SHARED MUTABLE RESOURCE, so `readResult()` asserts the result
    // names the home the caller booted. A probe that omitted this field could not
    // be checked for ownership at all.
    presetRoots: [],
    presetDefaultId: null,
    error: null,
    // ── CMP-02 / CMP-03: the sandbox rows and the three separate mode values ──
    sandbox: {
      policyServicePresent: false,
      sandboxServicePresent: false,
      policyRowInLoader: null,
      policyRowFiberState: null,
      policyRowConfigAsComposed: null,
      defaultMode: null,
      workspaceRoot: null,
      resolvedWorkspaceRoot: null,
      resolveWithNoSession: null,
      perSession: [],
      ptcRuntimePresent: false,
      ptcSandboxMode: null,
      fsSandboxMode: null,
      shellSandboxMode: null,
    },
    // ── CMP-06: the approval policy and every route to it ────────────────────
    approval: {
      servicePresent: false,
      configuredPolicy: null,
      sessionOverride: null,
      effectivePolicyForSession: null,
      permissionPresetsServicePresent: false,
      permissionRowDisabled: null,
      uiPermissionRowDisabled: null,
      policyToolGuesses: [],
      modelCatalogHasPolicyTool: null,
      hostApiSetPolicyAttempt: null,
      policyAfterHostApiAttempt: null,
    },
    // ── CMP-07: the resolved config of every row the profile patches ─────────
    patchedRows: [],
    // ── CMP-08: two presets, in parallel sessions ───────────────────────────
    presets: [],
    // ── CMP-09: two roots on one standing scope ─────────────────────────────
    roots: { created: [], interleaved: null },
    // ── CMP-10: registration counts ─────────────────────────────────────────
    registration: {
      loaderEntryCount: 0,
      rowIdCounts: {},
      duplicateRegistrationWarnings: [],
      toolRowOwners: {},
      presetCompositions: [],
    },
    loaderInactive: [],
  }

  try {
    // ── the ownership stamp, read before anything else can throw ─────────────
    const roster = ctx.get('agentPresets')
    if (roster !== undefined) {
      f.presetDefaultId = roster.defaultId ?? null
      f.presetRoots = (roster.roots ?? []).map(root => ({ path: String(root.path), trust: String(root.trust) }))
    }

    // ═══ CMP-10: WHERE the agent-scoped tool rows come from ═════════════════
    //
    // WHY THE ROSTER'S OWN `compositionInventory()` AND NOT THE ROOT LOADER.
    // A preset's rows are mounted under a STANDING SCOPE, which is a different
    // Loader from the host's. Measured on the first run of this probe: the root
    // Loader table contains `tool-pwsh`/`tool-fs` (host rows, disabled) and
    // `fs-local`/`pwsh-local` (host rows, ACTIVE), and does NOT contain
    // `daily-work-tools` or `ipython-tool` at all. Reporting "the tool rows are
    // absent" from the root table would have been a FALSE FINDING about the
    // preset -- the rows are in the preset's own subtree. The roster's inventory
    // is the product's own reader for exactly this question
    // (`packages/preset/agent-presets/src/index.ts:325`).
    const rosterSvc = ctx.get('agentPresets')
    if (rosterSvc !== undefined && typeof rosterSvc.compositionInventory === 'function') {
      try {
        const inventory = await rosterSvc.compositionInventory()
        f.registration.presetCompositions = inventory.map(entry => ({
          id: entry.id,
          isDefault: entry.isDefault === true,
          broken: entry.broken ?? null,
          // The row field names are `entryId` and `moduleName`
          // (`packages/preset/agent-presets/src/composition-inventory.ts:36-50`),
          // NOT `id`/`name`. Measured: reading `.id`/`.name` here produced an
          // empty `rowIds` for every preset, which would have been reported as
          // "the preset carries no rows" -- a false finding about the product
          // caused by the probe's own field names.
          rowIds: (entry.rows ?? []).map(row => row.entryId).filter(Boolean),
          rowNamesById: Object.fromEntries((entry.rows ?? [])
            .filter(row => row.entryId)
            .map(row => [row.entryId, row.moduleName ?? null])),
          rowsEnabled: (entry.rows ?? []).map(row => ({ id: row.entryId, enabled: row.enabled })),
          rowCount: (entry.rows ?? []).length,
        }))
      } catch (error) {
        f.registration.presetCompositionsError = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
      }
    }

    // ═══ CMP-02 / CMP-03: the sandbox rows and the mode's three values ═══════
    const policy = ctx.get('sandboxPolicy')
    f.sandbox.policyServicePresent = policy !== undefined
    f.sandbox.sandboxServicePresent = ctx.get('sandbox') !== undefined
    const ptc = ctx.get('ptcRuntime')
    f.sandbox.ptcRuntimePresent = ptc !== undefined
    f.sandbox.ptcSandboxMode = ptc?.sandboxMode ?? null
    const fsSvc = ctx.get('fs')
    const shellSvc = ctx.get('shell')
    f.sandbox.fsSandboxMode = fsSvc?.sandboxMode ?? null
    f.sandbox.shellSandboxMode = shellSvc?.sandboxMode ?? null

    if (policy !== undefined) {
      f.sandbox.defaultMode = policy.defaultMode ?? null
      f.sandbox.workspaceRoot = policy.workspaceRoot ?? null
      // The three values the case says must be SEPARATELY observable. They are
      // read from three different call shapes on purpose: reading only
      // `resolve()` would conflate a deployment default with a session override,
      // which is the specific confusion CMP-03's oracle names.
      const resolvedNoSession = policy.resolve({})
      f.sandbox.resolveWithNoSession = { mode: resolvedNoSession.mode, workspaceRoot: resolvedNoSession.workspaceRoot }
      f.sandbox.resolvedWorkspaceRoot = resolvedNoSession.workspaceRoot
    }

    // ═══ CMP-06: the approval policy ════════════════════════════════════════
    const approval = ctx.get('approval')
    f.approval.servicePresent = approval !== undefined
    f.approval.configuredPolicy = approval?.config?.policy ?? null
    f.approval.permissionPresetsServicePresent = ctx.get('permissionPresets') !== undefined

    // ═══ the live loader table, read ONCE for four cases ════════════════════
    const loader = ctx.get('loader')
    if (loader === undefined) {
      f.error = 'ctx.loader is absent: the probe cannot audit activation or registration'
    } else {
      const counts = {}
      for (const id of HOST_ROW_IDS) counts[id] = 0
      let total = 0
      for (const entry of loader.entries()) {
        total += 1
        const id = entry.options.id
        if (id === name) continue
        if (Object.hasOwn(counts, id)) counts[id] += 1
        if (id === 'sandbox-policy') {
          f.sandbox.policyRowInLoader = true
          f.sandbox.policyRowFiberState = entry.fiber?.state ?? null
          f.sandbox.policyRowConfigAsComposed = plain(entry.options.config ?? null)
        }
        if (id === 'permission') f.approval.permissionRowDisabled = entry.disabled === true
        if (id === 'ui-permission') f.approval.uiPermissionRowDisabled = entry.disabled === true
        if (id === 'fs-sandbox') f.registration.toolRowOwners.fsSandboxRowDisabled = entry.disabled === true
        if (id === 'fs-local') f.registration.toolRowOwners.fsLocalRowFiberState = entry.fiber?.state ?? null
        if (id === 'pwsh-sandbox') f.registration.toolRowOwners.pwshSandboxRowDisabled = entry.disabled === true
        if (id === 'pwsh-local') f.registration.toolRowOwners.pwshLocalRowFiberState = entry.fiber?.state ?? null
        // CMP-07: the RESOLVED config of every row the profile's own patch
        // touches. A patch replaces the WHOLE config object, so a row whose
        // sibling key vanished is visible here as an absent key rather than as a
        // schema default nobody chose.
        if (['subagent', 'agent-presets', 'approval', 'sandbox-policy'].includes(id)) {
          f.patchedRows.push({
            id,
            name: entry.options.name,
            disabled: entry.disabled === true,
            fiberState: entry.fiber?.state ?? null,
            configKeys: entry.options.config === undefined || entry.options.config === null
              ? []
              : Object.keys(entry.options.config),
            config: plain(entry.options.config ?? null),
          })
        }
        // CMP-10: the model-facing rows and where they come from.
        if (['daily-work-tools', 'ipython-tool', 'tool-pwsh', 'tool-fs'].includes(id)) {
          f.registration.toolRowOwners[id] = {
            name: entry.options.name,
            disabled: entry.disabled === true,
            fiberState: entry.fiber?.state ?? null,
          }
        }
        if (entry.fiber?.state !== FIBER_ACTIVE && entry.disabled !== true) {
          f.loaderInactive.push({ id, name: entry.options.name, state: entry.fiber?.state ?? 'never-started' })
        }
      }
      f.registration.loaderEntryCount = total
      f.registration.rowIdCounts = counts
      f.sandbox.policyRowInLoader = f.sandbox.policyRowInLoader ?? false
    }

    // ═══ CMP-08 + CMP-09 + CMP-06: real Sessions ════════════════════════════
    const sc = ctx.get('sessionController')
    const agents = ctx.get('agents')
    const tools = ctx.get('tools')
    const work = ctx.get('dailyWork')

    const sessionFor = async (label, preset) => {
      const created = await sc.create({
        cwd: 'D:/DSH/work/dsh-native-daily',
        ...preset === undefined ? {} : { agentPreset: preset },
      })
      const id = created?.sessionId ?? created?.id ?? null
      const agent = id === null ? undefined : agents?.get(id)
      const schemas = agent === undefined ? [] : tools.schemas(agent)
      return {
        label,
        requestedPreset: preset ?? null,
        sessionId: id,
        agentPreset: created?.agentPreset ?? null,
        agentPresent: agent !== undefined,
        toolCount: schemas.length,
        tools: schemas.map(s => s.name).sort(),
        pwshPresent: schemas.some(s => s.name === 'pwsh'),
        ipythonPresent: schemas.some(s => s.name === 'ipython'),
        workPresent: schemas.some(s => s.name === 'work'),
        agent,
      }
    }

    // CMP-08: two presets, mounted in parallel sessions. `daily-standard` is the
    // deployment's own preset; `daily-standard-twin` is a BYTE-IDENTICAL copy of
    // the same composition file, discovered by the roster's own directory scan
    // when the driver has placed it. When the twin is absent the shipped
    // `standard` preset is used as the contrast instead, and the artifact records
    // WHICH pair was compared -- because "two presets in one process" and "two
    // presets from ONE composition file" are different stimuli and only the
    // second is what CMP-08's stimulus names.
    const daily = await sessionFor('daily-standard', undefined)
    const rosterIds = (ctx.get('agentPresets') !== undefined ? await ctx.get('agentPresets').list() : []).map(p => p.id)
    const hasTwin = rosterIds.includes('daily-standard-twin')
    let contrast = null
    try {
      contrast = hasTwin
        ? await sessionFor('twin', 'daily-standard-twin')
        : await sessionFor('standard', 'standard')
    } catch (error) {
      contrast = {
        label: hasTwin ? 'twin' : 'standard',
        requestedPreset: hasTwin ? 'daily-standard-twin' : 'standard',
        error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
      }
    }
    f.presetsPair = {
      comparedPair: hasTwin ? 'SAME COMPOSITION FILE (daily-standard vs its byte-identical twin)' : 'DIFFERENT COMPOSITION FILES (daily-standard vs shipped standard)',
      rosterIds,
      sameCompositionFile: hasTwin,
    }
    f.presets = [daily, contrast].map(p => {
      if (p === null) return null
      const { agent, ...rest } = p
      return rest
    })

    // The ISOLATE-REALM mechanism, measured by object IDENTITY rather than
    // described. The preset file's own header says a service row must sit inside
    // a group carrying an `isolate` realm, so that each standing mount gets its
    // own private instance. `ctx.get` at the host plane returns ONE service (the
    // host's own); the per-preset instances are what the agents' scopes see. What
    // is measured here is the HOST service's identity plus whether the two
    // sessions' agents carry distinct contexts, which is the observable that
    // would differ if a preset published into the root realm instead.
    f.isolation = {
      workServiceInstancesShared: daily.agent !== undefined && contrast.agent !== undefined
        ? daily.agent.ctx === contrast.agent.ctx
        : null,
      note: 'agent.ctx identity: `true` would mean the two presets published into the SAME realm',
      dailyCtxPresent: daily.agent?.ctx !== undefined,
      contrastCtxPresent: contrast.agent?.ctx !== undefined,
    }

    // CMP-06: the effective policy for a REAL session, and the model's routes to
    // it. Both are read AFTER the sessions exist, because a session-level
    // override is one of the three values that must stay separable.
    if (approval !== undefined && daily.agent !== undefined) {
      // `effectivePolicy` is PRIVATE on `ApprovalService`
      // (packages/interaction/user-approval/src/index.ts:237), so the effective
      // value is composed here from the two public halves it is composed from:
      // the session's own logged override, else the configured default. Composing
      // it from the same two inputs is faithful; reaching for the private method
      // would have been a compile error and a deep-import.
      const override = approval.overrideOf(daily.agent.session) ?? null
      f.approval.sessionOverride = override
      f.approval.effectivePolicyForSession = override ?? approval.config?.policy ?? 'ask'
    }
    if (tools !== undefined && daily.agent !== undefined) {
      const names = tools.schemas(daily.agent).map(s => s.name)
      f.approval.modelCatalogHasPolicyTool = POLICY_TOOL_GUESSES.some(g => names.includes(g))
      for (const guess of POLICY_TOOL_GUESSES) {
        // A MODEL-ORIGINATED ATTEMPT: a tool call by name, exactly what a model
        // can do. Recorded per attempt rather than summarised, because "no tool
        // by that name" and "a tool that refused" are different facts.
        f.approval.policyToolGuesses.push({
          tool: guess,
          result: await callTool(ctx, daily.agent, `policy-${guess}`, guess, {}),
        })
      }
    }
    if (approval !== undefined && daily.agent !== undefined) {
      // The HOST-CODE route. This is the API `/permission` and the permission
      // presets call; BOTH of those rows are disabled in this composition. The
      // attempt is recorded so a reader can see whether the protection is
      // UNREACHABILITY or IMMUTABILITY -- they are different claims and only one
      // of them is true.
      try {
        approval.setPolicy(daily.agent, 'ask')
        f.approval.hostApiSetPolicyAttempt = 'no throw'
      } catch (error) {
        f.approval.hostApiSetPolicyAttempt = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
      }
      f.approval.policyAfterHostApiAttempt = approval.overrideOf(daily.agent.session) ?? approval.config?.policy ?? 'ask'
    }

    // CMP-09: two roots on the same standing scope, interleaving `work` calls.
    if (work !== undefined && tools !== undefined) {
      const second = await sessionFor('daily-standard-2', undefined)
      f.presets.push((() => { const { agent, ...rest } = second; return rest })())
      const runA = 'cmp-run-A'
      const runB = 'cmp-run-B'
      const created = []
      for (const [runId, sess] of [[runA, daily], [runB, second]]) {
        if (sess.agent === undefined) continue
        try {
          await work.createRun({ runId, root: sess.agent, authorizationRef: 'v2-cmp-composition-probe' })
          created.push({ runId, ok: true })
        } catch (error) {
          created.push({ runId, ok: false, error: error instanceof Error ? error.message : String(error) })
        }
      }
      f.roots.created = created

      // INTERLEAVED: A admits, B admits, A cancels, B reads. The order is the
      // stimulus -- if any per-root state were module-scope, the interleave is
      // what surfaces it.
      const steps = []
      const step = async (label, fn) => {
        try { steps.push({ label, ok: true, value: plain(await fn()) }) }
        catch (error) { steps.push({ label, ok: false, error: error instanceof Error ? error.message : String(error) }) }
      }
      await step('A.admit', () => work.admit({
        runId: runA, taskId: 'task-A1', childId: 'child-A1',
        assignmentDigest: 'digest-A1', reservedCost: 1, allowedCapabilities: [],
      }))
      await step('B.admit', () => work.admit({
        runId: runB, taskId: 'task-B1', childId: 'child-B1',
        assignmentDigest: 'digest-B1', reservedCost: 2, allowedCapabilities: [],
      }))
      await step('A.cancel task-A1', () => work.transition({
        runId: runA, taskId: 'task-A1', to: 'cancel_requested',
      }))
      await step('A.confirm cancel task-A1', () => work.transition({
        runId: runA, taskId: 'task-A1', to: 'cancelled',
      }))
      await step('B.admit a second task', () => work.admit({
        runId: runB, taskId: 'task-B2', childId: 'child-B2',
        assignmentDigest: 'digest-B2', reservedCost: 3, allowedCapabilities: [],
      }))

      const recordA = work.getRun(runA)
      const recordB = work.getRun(runB)

      // ═══ CMP-08's SECOND CLAUSE: no module-scope state crosses sessions ═══
      //
      // The catalog half of CMP-08 is measured above. This is the other half, and
      // it needs its own instrument: the `work` TOOL resolves a run for the
      // calling agent by scanning the service and comparing session ids
      // (`src/tools.ts:47-57`). If the tool held a `currentRun` in module scope --
      // which is the contamination bug its own header warns about, because a
      // preset's composition is STANDING and shared by every session that joins
      // it -- then BOTH agents' calls would resolve to the SAME run. So each
      // agent calls the real tool and the two answers are compared.
      const statusFor = async (label, sess, n) => {
        if (sess?.agent === undefined) return { label, error: 'no agent' }
        const call = await callTool(ctx, sess.agent, n, 'work', { action: 'status' })
        return { label, sessionId: sess.sessionId, call }
      }
      const statusA = await statusFor('A', daily, 'status-A')
      const statusB = await statusFor('B', second, 'status-B')
      const runIdOf = entry => {
        const match = /"runId":\s*"([^"]+)"/.exec(String(entry?.call?.message ?? ''))
        return match?.[1] ?? null
      }
      f.roots.perSessionToolResolution = {
        statusA,
        statusB,
        runIdA: runIdOf(statusA),
        runIdB: runIdOf(statusB),
        // The falsifiable claim: each agent's tool call resolved ITS OWN run.
        resolvesItsOwnRun: runIdOf(statusA) === runA && runIdOf(statusB) === runB,
        // And the two are not the same run, which is what a module-scope
        // `currentRun` would have produced.
        noCrossResolution: runIdOf(statusA) !== runIdOf(statusB),
      }

      f.roots.interleaved = {
        steps,
        A: {
          rootSessionId: recordA?.rootSessionId ?? null,
          taskIds: Object.keys(recordA?.tasks ?? {}),
          tombstones: recordA?.terminalTombstones ?? null,
          reserved: recordA?.budget?.reserved ?? null,
        },
        B: {
          rootSessionId: recordB?.rootSessionId ?? null,
          taskIds: Object.keys(recordB?.tasks ?? {}),
          tombstones: recordB?.terminalTombstones ?? null,
          reserved: recordB?.budget?.reserved ?? null,
        },
        // The separation claims, computed rather than left to a reader.
        distinctRoots: recordA?.rootSessionId !== recordB?.rootSessionId,
        noTaskIdCrosses: (Object.keys(recordA?.tasks ?? {})).every(t => !Object.hasOwn(recordB?.tasks ?? {}, t)),
        noTombstoneCrosses: (recordA?.terminalTombstones ?? []).every(t => !(recordB?.terminalTombstones ?? []).includes(t)),
        // A's cancelled task released its reservation, B's two admitted tasks
        // did not. 1 + 2 + 3 - 1 = 5 if the ledgers are separate and correct.
        reservedA: recordA?.budget?.reserved ?? null,
        reservedB: recordB?.budget?.reserved ?? null,
      }
    }

    // CMP-02's per-session half: `overrideOf` and `resolve({session})` are read
    // for a REAL session, so the three values are separately observable rather
    // than inferred from one call shape.
    if (policy !== undefined && daily.agent !== undefined) {
      const session = daily.agent.session
      f.sandbox.perSession = [{
        sessionId: daily.sessionId,
        override: policy.overrideOf(session) ?? null,
        resolved: policy.resolve({ session }).mode ?? null,
        resolvedWorkspaceRoot: policy.resolve({ session }).workspaceRoot ?? null,
      }]
    }
  } catch (error) {
    f.error = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
  }

  writeFileSync(OUT, `${JSON.stringify(f, null, 2)}\n`, 'utf8')
}
