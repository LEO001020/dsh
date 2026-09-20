/**
 * THE NEGATIVE ARM: does a non-full mode actually fail LOUD at each boundary?
 *
 * WHY THIS PROBE EXISTS. A guard that only ever reports `ok: true` on the correct
 * deployment proves nothing about the deployment -- it proves the guard can say
 * yes. The claim under test is the FAILURE DIRECTION: a runtime mutation to a
 * non-full mode must become a loud incompatible-state failure BEFORE further
 * product execution, and must NOT be silently switched back.
 *
 * WHAT IT INJECTS, AND WHY THIS INJECTION IS FAIR. It does not edit the profile,
 * does not edit a session log and does not reach into a private field. It does
 * the three things a real configuration change would do, through the SAME public
 * surface each one would use:
 *
 *   arm A -- the DEPLOYMENT default moves. A `sandbox-policy` row is inserted by
 *     an overlay patch with `mode: workspace-write`, which is exactly how an
 *     operator reverting the profile would do it. The guard's startup boundary
 *     runs against the composed graph and must refuse.
 *
 *   arm B -- a SESSION carries a confining override. A real Session is created
 *     and a real `sandbox/mode` event is appended through the public
 *     `setSandboxMode` writer (`sandbox-policy/src/session-mode.ts:53`), which is
 *     the documented write path -- "the switch IS its event; nothing mutates mode
 *     state out of band". Then `resolve({ session })` must show the confined mode
 *     while `defaultMode` stays correct, and the session check must fail. This is
 *     the arm that proves the deployment default alone is NOT the whole contract.
 *
 *   arm C -- the NARRATION is read under the confined mode, proving the model is
 *     actually told the false thing (rather than the guard merely computing that
 *     it would be). This is the arm that ties the mode to the model-facing fact.
 *
 * WHAT IT DOES NOT DO. It does not try to make the guard's refusal disappear, and
 * it does not reset the mode afterwards: an arm that "cleaned up" would be
 * indistinguishable from the silent repair the contract forbids. Every mutation
 * happens in a child process whose home is disposable, so nothing durable is
 * touched.
 *
 * The probe ALWAYS writes its artifact, including when a boundary throws, so the
 * refusal is recorded rather than inferred from a missing file.
 */
import { writeFileSync } from 'node:fs'

export const name = 'verify-trusted-local-negative-arm'

export const inject = ['sessionController']

const OUT = process.env.DSH_PROBE_OUT
  ?? 'D:/DSH/work/wt-r1/qualification/results/R1-trusted-local/negative-arm.json'

const TRUSTED_LOCAL_MODE = 'danger-full-access'

/** `SandboxMode` values a mutation could introduce. Named so the probe's intent is readable. */
const CONFINING_MODE = 'workspace-write'

function plain(value) {
  try {
    return JSON.parse(JSON.stringify(value))
  } catch (error) {
    return `unserialisable: ${error instanceof Error ? error.message : String(error)}`
  }
}

export async function apply(ctx) {
  const f = {
    probe: 'verify-trusted-local-negative-arm',
    ranAt: new Date().toISOString(),
    presetRoots: [],
    injectedMode: CONFINING_MODE,
    error: null,
    // ── arm A: the STARTUP boundary, read off the live composed graph ────────
    startup: {
      contractServicePresent: null,
      defaultMode: null,
      reportOk: null,
      violations: [],
      checks: [],
      // The claim: a refusal must be REPRODUCIBLE by asking the guard, not only
      // observable as a failed mount. A guard whose only refusal is a boot crash
      // cannot be re-checked at the other boundaries.
      refusedByExplicitCall: null,
      refusalMessage: null,
    },
    // ── arm B: the SESSION boundary ──────────────────────────────────────────
    session: {
      sessionId: null,
      defaultModeBefore: null,
      overrideAfterAppend: null,
      resolvedAfterAppend: null,
      reportOk: null,
      violations: [],
      checkObserved: null,
      modeWasRestored: null,
    },
    // ── arm C: the NARRATION under the confined mode ─────────────────────────
    narration: {
      assembled: false,
      assembleError: null,
      policyContextPresent: false,
      policyContextText: null,
      saysConfining: null,
      saysUnconfined: null,
    },
    // ── arm D: the PTC boundary, exercised through the real registry ─────────
    ptc: {
      runCodeOnSurface: null,
      guardRefusal: null,
      callOutcome: null,
    },
  }

  try {
    const roster = ctx.get('agentPresets')
    if (roster !== undefined) {
      f.presetRoots = (roster.roots ?? []).map(root => ({ path: String(root.path), trust: String(root.trust) }))
    }

    const policy = ctx.get('sandboxPolicy')
    const contract = ctx.get('noSandboxContract')
    f.startup.contractServicePresent = contract !== undefined

    if (policy !== undefined) {
      f.startup.defaultMode = policy.defaultMode ?? null
    }

    // ═══ arm A: ask the guard, at the startup boundary, on this graph ═══════
    if (contract !== undefined) {
      const report = contract.checkDeployment()
      f.startup.reportOk = report.ok
      f.startup.violations = [...report.violations]
      f.startup.checks = report.checks.map(check => ({ id: check.id, ok: check.ok, observed: check.observed }))
      // The EXPLICIT refusal, caught rather than allowed to abort the probe: a
      // throw that killed the probe would leave no artifact, and "no artifact"
      // cannot be distinguished from "the probe never ran".
      try {
        contract.checkBoundarySync('startup')
        f.startup.refusedByExplicitCall = false
      } catch (error) {
        f.startup.refusedByExplicitCall = true
        f.startup.refusalMessage = String(error?.message ?? error)
      }
    }

    // ═══ arm B + C: a real Session, a real `sandbox/mode` append ════════════
    const sc = ctx.get('sessionController')
    const agents = ctx.get('agents')
    if (sc !== undefined && policy !== undefined) {
      const created = await sc.create({ cwd: 'D:/DSH/work/wt-r1' })
      const sessionId = created?.sessionId ?? created?.id ?? null
      const agent = sessionId === null ? undefined : agents?.get(sessionId)
      f.session.sessionId = sessionId
      f.session.defaultModeBefore = policy.defaultMode ?? null
      if (agent !== undefined) {
        // THE PUBLIC WRITE PATH, reached through the LIVE SERVICE rather than
        // through a package import. `setSandboxMode` is re-exported from
        // `@deepseek-ai/dsh-sandbox-policy`'s index
        // (`sandbox-policy/src/index.ts:33`) and it appends exactly one
        // `sandbox/mode` event -- "the switch IS its event; nothing mutates mode
        // state out of band" (`session-mode.ts:47-53`). The import is deferred
        // and resolved from the BOOTING profile, because a bare specifier in a
        // probe file does not resolve against the profile's dependency graph
        // (measured: "Cannot find package '@deepseek-ai/dsh-sandbox-policy'
        // imported from .probe/..."). The service's own module path is the same
        // writer, reached through the service the composition already mounted.
        const { setSandboxMode } = await import(
          new URL('../packages/dsh-daily-work/node_modules/@deepseek-ai/dsh-sandbox-policy/lib/index.js', import.meta.url).href
        )
        setSandboxMode(agent.session, CONFINING_MODE)
        f.session.overrideAfterAppend = policy.overrideOf(agent.session) ?? null
        f.session.resolvedAfterAppend = policy.resolve({ session: agent.session }).mode ?? null

        if (contract !== undefined) {
          const sessionReport = contract.checkSession(agent.session)
          f.session.reportOk = sessionReport.ok
          f.session.violations = [...sessionReport.violations]
          const overrideCheck = sessionReport.checks.find(check => check.id === 'session.override')
          f.session.checkObserved = overrideCheck?.observed ?? null
        }
        f.session.modeWasRestored = (policy.defaultMode ?? null) !== TRUSTED_LOCAL_MODE
          ? 'defaultMode itself moved -- this arm did NOT restore it'
          : 'defaultMode unchanged (this arm only wrote a session event, as the guard requires)'

        // ── arm C: what the MODEL is told under the confined session ════════
        const prompt = ctx.get('systemPrompt')
        if (prompt !== undefined) {
          try {
            const assembly = await prompt.assemble({ agent, scope: agent })
            const entry = (assembly.contexts ?? []).find(c => String(c.name) === 'sandbox:policy')
            const text = entry === undefined ? '' : String(entry.text)
            f.narration.assembled = true
            f.narration.policyContextPresent = entry !== undefined
            f.narration.policyContextText = entry === undefined ? null : text
            f.narration.saysConfining = text.includes(CONFINING_MODE)
            f.narration.saysUnconfined = text.includes(TRUSTED_LOCAL_MODE)
          } catch (error) {
            f.narration.assembleError = `${error?.name ?? 'Error'}: ${error?.message ?? String(error)}`
          }
        }

        // ── arm D: the PTC boundary through the REAL registry ───────────────
        //
        // `workflow` IS the reachable PTC producer in this composition, and that
        // is MEASURED rather than assumed: the registry's presentation mode is
        // its schema default `native` here, so no `run_code` transport is
        // presented, while `workflow`'s engine is `PtcWorkflowEngine` and it
        // resolves the session's policy for the same confine decision
        // (`workflow-ptc/src/index.ts:164` -> `ptc-runtime-node:224`).
        //
        // The call is made by NAME through the public `execute`, so what is
        // exercised is the guard's real registration rather than a direct call
        // to the guard function -- a direct call would prove the predicate works
        // and nothing about whether the product reaches it.
        const tools = ctx.get('tools')
        if (tools !== undefined) {
          const names = tools.schemas(agent).map(schema => schema.name)
          f.ptc.runCodeOnSurface = names.includes('run_code')
          f.ptc.workflowOnSurface = names.includes('workflow')
          try {
            const result = await tools.execute({
              callId: 'negative-arm-ptc',
              name: 'workflow',
              arguments: { name: 'negative-arm', script: 'return 1' },
              agent,
              signal: new AbortController().signal,
            })
            f.ptc.callOutcome = {
              threw: false,
              isError: result.isError === true,
              message: result.isError === true
                ? result.error.message
                : (result.content ?? []).map(b => (b.type === 'text' ? b.text : '')).join('\n'),
            }
          } catch (error) {
            f.ptc.callOutcome = { threw: true, message: String(error?.message ?? error) }
          }
          f.ptc.guardRefusal = f.ptc.callOutcome.isError === true
            && String(f.ptc.callOutcome.message).includes('trusted-local contract')
            ? 'REFUSED by the contract guard'
            : 'NOT refused by the contract guard'
        }
      }
    }
  } catch (error) {
    f.error = `${error?.name ?? 'Error'}: ${error?.message ?? String(error)}`
  }

  writeFileSync(OUT, JSON.stringify(f, null, 1))
  throw new Error('probe-complete')
}
