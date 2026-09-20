/**
 * Is the trusted-local composition TRUE, or only DOCUMENTED?
 *
 * THE DEFECT THIS MEASURES (V3 F3 / spec case CMP-02). The deployment's stated
 * trust model is "Windows trusted-local, no sandbox, the OS user account is the
 * execution authority boundary". Three separate facts have to agree for that to
 * be true, and only the first is easy to check:
 *
 *   1. the DECLARED policy row (`sandbox-policy`) and its configured mode;
 *   2. the EFFECTIVE mode a real Session resolves to (`resolve({ session })`);
 *   3. the NARRATION the model actually receives about its own authority, which
 *      is contributed by `sandbox-policy`'s own `systemPrompt.context` provider
 *      (`packages/sandbox/sandbox-policy/src/index.ts:141-152`).
 *
 * (3) is read here by RUNNING the real assembly (`ctx.systemPrompt.assemble`)
 * and reading the `sandbox:policy` context entry's rendered text. That is the
 * exact string `AgentLoop` folds into the request (`agent.ts:246-249` calls
 * `assemble` then `renderContextSections`/`joinContextSections`), so this is a
 * read of the model-facing value, not a restatement of the source. Reading the
 * source and asserting the sentence would be the weaker oracle: it would still
 * pass if the provider were never registered.
 *
 * (4) A FOURTH fact, which is why the defect is behavioural rather than mere
 * narration: `ptc-runtime-node` confines unless the mode is EXACTLY
 * `danger-full-access` (`packages/ptc-runtime/ptc-runtime-node/src/index.ts:224`).
 * So a `workspace-write` mode does not only tell the model something false, it
 * makes the PTC path fence. The confine DECISION is recomputed here from the
 * same resolved policy the runtime would receive.
 *
 * WHAT IT DOES NOT DO. It inserts no product row and reconfigures nothing. The
 * one row it adds is itself, and the ownership stamp (`presetRoots`) is written
 * first so `readResult()` can prove the result belongs to the caller's home --
 * a probe writing to a fixed path is a SHARED MUTABLE RESOURCE (G-FIX-13).
 *
 * `inject` is `['sessionController']` only. Every other service is read through
 * `ctx.get`, because a hard inject is a READINESS GATE: a probe that injected a
 * service it wants to ASSERT is present would never run when the service is
 * missing, and the artifact would be ABSENT rather than reporting `false`.
 */
import { writeFileSync } from 'node:fs'

export const name = 'verify-trusted-local-composition'

export const inject = ['sessionController']

const OUT = process.env.DSH_PROBE_OUT
  ?? 'D:/DSH/work/wt-r1/qualification/results/R1-trusted-local/composition.json'

/** The mode the trusted-local contract requires. Named, not inlined, so the spelling is shared. */
const TRUSTED_LOCAL_MODE = 'danger-full-access'

/** Serialise a live value without letting a cycle abort the probe. */
function plain(value) {
  try {
    return JSON.parse(JSON.stringify(value))
  } catch (error) {
    return `unserialisable: ${error instanceof Error ? error.message : String(error)}`
  }
}

export async function apply(ctx) {
  const f = {
    probe: 'verify-trusted-local-composition',
    ranAt: new Date().toISOString(),
    // FIRST and unconditional: the harness asserts the result names the home
    // this caller booted.
    presetRoots: [],
    presetDefaultId: null,
    error: null,
    // ── fact 1: the DECLARED row ─────────────────────────────────────────────
    declared: {
      rowPresent: null,
      rowFiberState: null,
      rowDisabled: null,
      configAsComposed: null,
      configKeys: [],
    },
    // ── fact 2: the EFFECTIVE values, kept separable ─────────────────────────
    effective: {
      policyServicePresent: false,
      defaultMode: null,
      workspaceRoot: null,
      resolveNoSession: null,
      perSession: [],
    },
    // ── fact 3: the model-facing NARRATION, measured by running the assembly ─
    narration: {
      systemPromptServicePresent: false,
      assembleRan: false,
      assembleError: null,
      sandboxPolicyContextPresent: false,
      sandboxPolicyContextText: null,
      contextNames: [],
      saysWorkspaceWrite: null,
      saysDangerFullAccess: null,
    },
    // ── fact 4: the BEHAVIOURAL consequence on the PTC path ──────────────────
    ptc: {
      runtimePresent: false,
      runtimeName: null,
      sandboxMode: null,
      confineDecision: null,
      runCodeOnSurface: null,
      note: null,
    },
    // ── the surrounding composition facts the same contract names ────────────
    composition: {
      fsProvider: null,
      fsSandboxMode: null,
      shellProvider: null,
      shellSandboxMode: null,
      shellMounted: false,
      ipythonMounted: false,
      permissionRowDisabled: null,
      uiPermissionRowDisabled: null,
      permissionPresetsServicePresent: null,
      approvalRowPresent: null,
      approvalRowConfig: null,
      approvalServicePresent: null,
      approvalConfiguredPolicy: null,
      escalationTools: [],
      toolNames: [],
      pwshPresent: null,
      ipythonPresent: null,
    },
    // ── the guard's own verdict on this very graph ───────────────────────────
    contract: {
      servicePresent: false,
      ok: null,
      checkCount: null,
      violations: [],
      migrationRequired: [],
    },
  }

  try {
    const roster = ctx.get('agentPresets')
    if (roster !== undefined) {
      f.presetDefaultId = roster.defaultId ?? null
      f.presetRoots = (roster.roots ?? []).map(root => ({ path: String(root.path), trust: String(root.trust) }))
    }

    // ═══ fact 1: the DECLARED row, read from the loader's own table ═════════
    const loader = ctx.get('loader')
    if (loader !== undefined) {
      for (const entry of loader.entries()) {
        if (entry.options.id !== 'sandbox-policy') continue
        f.declared.rowPresent = true
        f.declared.rowFiberState = entry.fiber?.state ?? null
        f.declared.rowDisabled = entry.disabled === true
        f.declared.configAsComposed = plain(entry.options.config ?? null)
        f.declared.configKeys = entry.options.config === undefined || entry.options.config === null
          ? []
          : Object.keys(entry.options.config)
      }
      f.declared.rowPresent = f.declared.rowPresent ?? false
      for (const entry of loader.entries()) {
        if (entry.options.id === 'permission') f.composition.permissionRowDisabled = entry.disabled === true
        if (entry.options.id === 'ui-permission') f.composition.uiPermissionRowDisabled = entry.disabled === true
        if (entry.options.id === 'approval') {
          f.composition.approvalRowPresent = true
          f.composition.approvalRowConfig = plain(entry.options.config ?? null)
        }
      }
    }

    // ═══ fact 2: the EFFECTIVE values ═══════════════════════════════════════
    const policy = ctx.get('sandboxPolicy')
    f.effective.policyServicePresent = policy !== undefined
    if (policy !== undefined) {
      f.effective.defaultMode = policy.defaultMode ?? null
      f.effective.workspaceRoot = policy.workspaceRoot ?? null
      try {
        const resolved = policy.resolve({})
        f.effective.resolveNoSession = { mode: resolved.mode ?? null, workspaceRoot: resolved.workspaceRoot ?? null }
      } catch (error) {
        f.effective.resolveNoSessionError = String(error?.message ?? error)
      }
    }

    // ═══ the surrounding composition, read from the live services ═══════════
    const fs = ctx.get('fs')
    const shell = ctx.get('shell')
    const ptc = ctx.get('ptcRuntime')
    f.composition.fsProvider = fs === undefined ? null : (Reflect.get(fs, 'constructor')?.name ?? 'unknown')
    f.composition.fsSandboxMode = fs?.sandboxMode ?? null
    f.composition.shellMounted = shell !== undefined
    f.composition.shellProvider = shell === undefined ? null : (Reflect.get(shell, 'constructor')?.name ?? 'unknown')
    f.composition.shellSandboxMode = shell?.sandboxMode ?? null
    f.composition.ipythonMounted = ctx.get('ipython') !== undefined
    f.composition.permissionPresetsServicePresent = ctx.get('permissionPresets') !== undefined

    const approval = ctx.get('approval')
    f.composition.approvalServicePresent = approval !== undefined
    f.composition.approvalConfiguredPolicy = approval?.config?.policy ?? null

    // ═══ fact 4: the PTC path, from the mounted runtime ═════════════════════
    f.ptc.runtimePresent = ptc !== undefined
    f.ptc.runtimeName = ptc === undefined ? null : (Reflect.get(ptc, 'constructor')?.name ?? 'unknown')
    f.ptc.sandboxMode = ptc?.sandboxMode ?? null
    if (policy !== undefined) {
      // The EXACT expression `ptc-runtime-node` evaluates at `:224`, recomputed
      // from the policy the runtime would be handed. `danger-full-access` is the
      // one value that skips `ctx.sandbox.confine`; every other value confines.
      const mode = f.effective.resolveNoSession?.mode ?? null
      f.ptc.confineDecision = mode === null
        ? 'undecidable: no resolved mode'
        : mode === TRUSTED_LOCAL_MODE
          ? `no confinement (mode is exactly '${TRUSTED_LOCAL_MODE}')`
          : `WOULD CONFINDE (mode is '${mode}', and ptc-runtime-node:224 confines unless mode === '${TRUSTED_LOCAL_MODE}')`
      f.ptc.note = 'Recomputed from the resolved policy, not read from a log. The runtime is not invoked here: running it would spawn a Node child and this probe is a read.'
    }

    // ═══ a real Session, so facts 2/3/4 are about an Agent and not a bare service ═══
    const sc = ctx.get('sessionController')
    const agents = ctx.get('agents')
    const tools = ctx.get('tools')
    if (sc !== undefined) {
      const created = await sc.create({ cwd: 'D:/DSH/work/wt-r1' })
      const sessionId = created?.sessionId ?? created?.id ?? null
      const agent = sessionId === null ? undefined : agents?.get(sessionId)
      const row = {
        label: 'daily-standard',
        sessionId,
        agentPreset: created?.agentPreset ?? null,
        agentPresent: agent !== undefined,
        override: null,
        resolved: null,
      }
      if (policy !== undefined && agent !== undefined) {
        try {
          row.override = policy.overrideOf(agent.session) ?? null
          row.resolved = policy.resolve({ session: agent.session }).mode ?? null
        } catch (error) {
          row.error = String(error?.message ?? error)
        }
      }
      f.effective.perSession.push(row)

      // ═══ fact 3: the model-facing narration ═══════════════════════════════
      //
      // THE REAL ASSEMBLY. `AgentLoop` does exactly this at
      // `packages/core/agent-loop/src/agent.ts:246`, with
      // `assembleContextFor(agent)` === `{ agent, scope: agent }`
      // (`packages/core/agent/src/dispatch.ts:174-176`). Calling the registry
      // directly is the same read the loop performs, and it is the only way to
      // see what a context PROVIDER renders -- a static section would be
      // readable from source, but this one is a closure over the live policy.
      const prompt = ctx.get('systemPrompt')
      f.narration.systemPromptServicePresent = prompt !== undefined
      if (prompt !== undefined && agent !== undefined) {
        try {
          const assembly = await prompt.assemble({ agent, scope: agent })
          f.narration.assembleRan = true
          const contexts = Array.isArray(assembly?.contexts) ? assembly.contexts : []
          f.narration.contextNames = contexts.map(entry => String(entry.name))
          const entry = contexts.find(c => String(c.name) === 'sandbox:policy')
          f.narration.sandboxPolicyContextPresent = entry !== undefined
          f.narration.sandboxPolicyContextText = entry === undefined ? null : String(entry.text)
          const text = entry === undefined ? '' : String(entry.text)
          f.narration.saysWorkspaceWrite = text.includes('workspace-write')
          f.narration.saysDangerFullAccess = text.includes('danger-full-access')
        } catch (error) {
          f.narration.assembleError = `${error?.name ?? 'Error'}: ${error?.message ?? String(error)}`
        }
      }

      // ═══ the model surface ════════════════════════════════════════════════
      if (tools !== undefined && agent !== undefined) {
        const schemas = tools.schemas(agent)
        f.composition.toolNames = schemas.map(s => s.name).sort()
        f.composition.pwshPresent = schemas.some(s => s.name === 'pwsh')
        f.composition.ipythonPresent = schemas.some(s => s.name === 'ipython')
        f.ptc.runCodeOnSurface = schemas.some(s => s.name === 'run_code')
        for (const schema of schemas) {
          const props = schema.parameters?.['properties']
          if (props === null || typeof props !== 'object' || Array.isArray(props)) continue
          const advertised = ['sandbox_permissions', 'justification'].filter(n => n in props)
          if (advertised.length > 0) f.composition.escalationTools.push({ name: schema.name, parameters: advertised })
        }
      }
    }

    // ═══ the guard's own verdict, so the before/after pair is on one graph ══
    const contract = ctx.get('noSandboxContract')
    f.contract.servicePresent = contract !== undefined
    if (contract !== undefined) {
      const report = contract.checkDeployment()
      f.contract.ok = report.ok
      f.contract.checkCount = report.checks.length
      f.contract.violations = [...report.violations]
      f.contract.migrationRequired = [...report.migrationRequired]
    }
  } catch (error) {
    f.error = `${error?.name ?? 'Error'}: ${error?.message ?? String(error)}`
  }

  writeFileSync(OUT, JSON.stringify(f, null, 1))
  // The probe is a read; it terminates the boot so the harness does not wait.
  throw new Error('probe-complete')
}
