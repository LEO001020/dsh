/**
 * T10 boot probe: is the child-capacity guard actually MOUNTED and BINDING on a
 * real composed profile, and is the run that capacity governs reachable by a
 * user action?
 *
 * WHY A BOOT PROBE AND NOT THE UNIT SUITE. `capacity.test.ts` constructs a
 * `WorkService` directly and calls `createRun` on it. That proves the MECHANISM
 * and says nothing about the product: a row could be absent from every bundle
 * and the suite would still be green. This project has retracted that exact
 * over-claim nine times (docs/GAPS.md, the defect-class table), and G-SEAM-31
 * names `createRun` as instance 9. So this probe boots the REAL profile through
 * the REAL resolver and measures three separate facts, each with its own
 * instrument:
 *
 *   1. IS THE GUARD MOUNTED? `WorkService`'s CONSTRUCTOR calls
 *      `mountChildAdmissionGuard`, and `host-plugin.ts` constructs the service
 *      at boot, so the `agent/created` listener should be live even though no
 *      run exists. This is measured BEHAVIOURALLY, not by reading source: the
 *      probe creates a real continuable child on the composed profile and reads
 *      the ledger afterwards. A ledger that went 0 -> 1 proves a listener
 *      answered; a ledger that stayed 0 proves it did not. (The ledger is
 *      reached through `ctx.get('dailyWork').capacityGate`, which is the
 *      service's own public reader.)
 *
 *   2. IS THE RUN REACHABLE? `createRun`'s non-test callers are enumerated by
 *      grep in a separate artifact; here the model-facing answer is measured by
 *      calling the `work` tool through the REAL tool runtime with a real agent,
 *      and recording the error. If the product could create a run, this call
 *      would not throw `no active run`.
 *
 *   3. WHAT ARE THE NUMBERS? The composed `subagent` row's `maxActiveSubagents`
 *      and `maxDepth`, read from the LIVE loader entries (not from the patch
 *      file), and the ledger's own `limit`.
 *
 * WHAT IT DOES NOT DO. It does not insert any row, and it does not create a run
 * to make a gate green. `createRun` is deliberately NOT called: calling it would
 * install the very entry point whose existence is the question. The one child it
 * creates goes through the model-facing seam, which is the seam a user action
 * would take.
 *
 * WHY IT INJECTS ONLY `sessionController`. `inject` is a readiness gate, so a
 * probe that injected `dailyWork` would not run at all when the service is
 * missing, and the artifact would be absent instead of reporting `false`. Every
 * other service is read through `ctx.get`, so a missing one lands in the
 * artifact as a measured absence.
 */
import { writeFileSync } from 'node:fs'

export const name = 'verify-t10-capacity'
export const inject = ['sessionController']

const OUT = process.env.DSH_PROBE_OUT
  ?? 'D:/DSH/work/dsh-native-daily/qualification/results/T10-capacity/prod-capacity.json'

export async function apply(ctx) {
  const finding = {
    probe: 'T10-capacity',
    ranAt: new Date().toISOString(),
    profileName: ctx.get('profileContext')?.profile?.name ?? 'unknown',

    // (1) Is the capacity service mounted at all, and is its guard live?
    workServicePresent: false,
    gateLimit: null,
    ledgerBeforeChild: null,
    childCreated: false,
    childId: null,
    ledgerAfterChild: null,
    guardIsLive: false,
    childCreateError: null,

    // (2) Is the run reachable by a user action?
    workToolPresent: false,
    subagentToolPresent: false,
    toolCountAgentKey: 0,
    workToolError: null,
    workToolResult: null,
    runReachable: null,

    // (3) The composed deployment numbers, read from the LIVE loader.
    subagentRowConfig: null,
    hardChildCapacity: null,

    // (4) Does the cap actually REFUSE a real creation call on this profile?
    ledgerBeforeBoundary: null,
    ledgerAtBoundary: null,
    capRefusedRealChild: null,
    capRefusalError: null,
    ledgerAfterRefusal: null,
    ledgerAfterRelease: null,

    // (5) G-SEAM-19: is the upstream one-shot hole still open IN THIS PRODUCT?
    oneShotStarted: null,
    oneShotError: null,
    ledgerAfterOneShot: null,
    oneShotTookHostSlot: null,

    // The preset the Session actually mounted, so the tool face measured below
    // is provably this preset's.
    agentPreset: null,
    sessionId: null,
    presetRoots: [],
    error: null,
    errorPhase: null,
  }

  try {
    // ---- (1) the guard, measured behaviourally ----------------------------
    const service = ctx.get('dailyWork')
    finding.workServicePresent = service !== undefined
    if (service !== undefined) {
      const gate = service.capacityGate
      finding.gateLimit = gate?.limit ?? null
      finding.ledgerBeforeChild = gate?.snapshot() ?? null
    }

    // The `subagent` row's composed config, read from the LIVE loader entries
    // rather than from `cordis.patch.yml`. A patch that was written but never
    // composed reads identically to one that was; the entry table does not.
    const loader = ctx.get('loader')
    if (loader !== undefined) {
      for (const entry of loader.entries()) {
        if (entry.options.name === '@deepseek-ai/dsh-subagent' || entry.options.id === 'subagent') {
          finding.subagentRowConfig = {
            id: entry.options.id,
            name: entry.options.name,
            config: entry.options.config ?? null,
            fiberState: entry.fiber?.state ?? null,
          }
        }
      }
    }

    // A real Session on the deployment's own default preset, so the `work` and
    // `subagent` tools below are the ones a user's Session is actually offered.
    //
    // `cwd` is passed EXPLICITLY. The session controller creates the project
    // directory for a new Session, and the boot harness runs the host from
    // `C:/` to catch a cwd-relative resolution regression — which makes the
    // controller try `mkdir C:\` and fail with EPERM. That is a property of
    // running from a drive root, not a product defect, so the probe names a real
    // directory rather than measuring that failure by accident.
    const sessions = ctx.get('sessionController')
    let agent
    if (sessions !== undefined) {
      const created = await sessions.create({ cwd: 'D:/DSH/work/dsh-native-daily' })
      finding.sessionId = String(created.sessionId)
      finding.agentPreset = created.agentPreset ?? null
      // The preset ROOTS are recorded BEFORE anything else can throw, because
      // `readResult()` uses them to prove the artifact describes the home this
      // caller booted. An artifact written after a later failure must still
      // carry them, or the driver cannot tell whose run it holds.
      const roster = ctx.get('agentPresets')
      if (roster !== undefined) {
        finding.presetRoots = (roster.roots ?? []).map(root => String(root.path))
      }
      agent = ctx.get('agents')?.get(created.sessionId)
    }

    // ---- (2) is the run reachable? ----------------------------------------
    // The `work` tool is the model-facing door to the run. It resolves the run
    // FIRST, so the error it throws is the measurement: if the product created a
    // run, this call would reach the tool body instead.
    const tools = ctx.get('tools')
    if (tools !== undefined && agent !== undefined) {
      // `schemas(agent)` is the AGENT-KEYED view. `ctx.tools` layers are keyed by
      // the AGENT OBJECT (AgentLoop builds the scope with `createScope(loopCtx,
      // this)`, agent-loop/src/agent.ts:104), so passing `agent.ctx` yields a key
      // owning no scope layer and the view collapses to the global layer with
      // zero tools — the false negative recorded as G-FIX-06.
      const schemas = tools.schemas?.(agent) ?? []
      const names = schemas.map(s => s?.name ?? s?.function?.name).filter(n => typeof n === 'string')
      finding.workToolPresent = names.includes('work')
      finding.toolCountAgentKey = names.length
      finding.subagentToolPresent = names.includes('subagent')

      if (finding.workToolPresent) {
        try {
          // A benign read-only call: `status` needs no arguments and creates
          // nothing. What is measured is whether it can even FIND a run.
          //
          // `ToolRuntime.execute` takes ONE `ToolExecutionInput` object
          // (tools/src/index.ts:1348), not positional arguments, and requires a
          // caller-owned `signal`. The shape is copied from the interface at
          // :309 rather than guessed: a wrong shape here would surface as a
          // TypeError that reads like a product failure.
          const result = await tools.execute({
            callId: 't10-probe-work-status',
            name: 'work',
            arguments: { action: 'status' },
            agent,
            signal: new AbortController().signal,
          })
          finding.workToolResult = result === undefined ? null : JSON.parse(JSON.stringify(result))

          // THE ORACLE IS THE RESULT, NOT AN EXCEPTION, and getting this wrong
          // would have inverted the finding. Measured: a tool failure does NOT
          // throw out of `execute` — it returns a STRUCTURED result with
          // `isError: true` and the message under `error.message`. A first
          // revision of this probe asserted on a throw, saw no throw, and
          // reported `runReachable: true` for a call that had in fact failed.
          // That is the weaker-oracle failure this project keeps recording, in
          // the direction that hides the defect.
          const isError = finding.workToolResult?.isError === true
          const message = finding.workToolResult?.error?.message
            ?? finding.workToolResult?.content?.[0]?.text
            ?? ''
          finding.workToolError = isError ? String(message) : null
          finding.runReachable = isError !== true
        } catch (error) {
          // A throw is still recorded honestly, and is also a non-reach (the
          // tool could not complete). Both shapes land as `runReachable: false`.
          finding.workToolError = error instanceof Error ? error.message : String(error)
          finding.runReachable = false
        }
      }
    }

    // ---- (1, continued) a real child through the model-facing seam --------
    // This is the behavioural half: if the guard is mounted, the ledger moves.
    // It creates ONE child, not thirty, and it does not call `createRun`.
    const subagents = ctx.get('subagents')
    if (subagents !== undefined && agent !== undefined && service !== undefined) {
      try {
        const started = await subagents.startContinuable({
          provider: 'spawn',
          label: 't10-probe-child',
          childId: undefined,
          request: {
            parent: agent,
            prompt: [{ type: 'text', text: 't10 probe: take one slot' }],
            maxDepth: 1,
          },
          signal: new AbortController().signal,
        })
        finding.childCreated = true
        finding.childId = String(started.childId)
      } catch (error) {
        finding.childCreateError = error instanceof Error ? error.message : String(error)
      }
      finding.ledgerAfterChild = service.capacityGate?.snapshot() ?? null
      // The guard is LIVE iff the ledger recorded the child. Comparing the two
      // snapshots rather than asserting a number keeps this honest when the
      // child fails to start: a failed start leaves the ledger at 0 and the
      // finding is `false`, not a pass.
      const before = finding.ledgerBeforeChild?.liveChildren ?? 0
      const after = finding.ledgerAfterChild?.liveChildren ?? 0
      finding.guardIsLive = finding.childCreated === true && after > before
      finding.ledgerDelta = after - before
    }

    finding.hardChildCapacity = 30

    // ---- (4) THE CAP ACTUALLY REFUSES, on the COMPOSED PROFILE -------------
    // The behavioural proof that the deployment constant BINDS in a production
    // path, not merely that a listener exists. The user's own constraint forbids
    // spawning 30 real children, so the boundary is reached with 29 arithmetic
    // reservations on the SAME live ledger and then ONE real child through the
    // model-facing seam. If the guard is live and binding, that real child is
    // refused by the production path.
    //
    // WHY THIS IS NOT A WEAKER ORACLE. The thing under test is the gate's
    // decision on a real creation call, and the call IS real: a genuine
    // `startContinuable` through the composed `spawn` provider, refused before
    // publication. The 29 reservations only position the ledger at the
    // boundary. (Contrast the G-FIX-04 failure mode, where the test replaced the
    // PRODUCTION mechanism with a test double; here nothing is replaced.)
    if (service !== undefined && subagents !== undefined && agent !== undefined) {
      const gate = service.capacityGate
      const filler = []
      const occupiedBefore = gate.snapshot().occupied
      // The state the release below must RESTORE. It is NOT `ledgerBeforeChild`:
      // the probe's own first child is still live and holding its slot, so the
      // correct post-release occupancy is "whatever was there before the filler
      // went in", which is 1. Comparing against 0 would assert that the probe's
      // own child vanished, which is not what this arm measures.
      finding.ledgerBeforeBoundary = gate.snapshot()
      for (let i = occupiedBefore; i < 30; i += 1) filler.push(gate.reserveChild(`t10-filler-${String(i)}`))
      finding.ledgerAtBoundary = gate.snapshot()

      try {
        await subagents.startContinuable({
          provider: 'spawn',
          label: 't10-probe-overflow',
          request: {
            parent: agent,
            prompt: [{ type: 'text', text: 't10 probe: must be refused at the cap' }],
            maxDepth: 1,
          },
          signal: new AbortController().signal,
        })
        finding.capRefusedRealChild = false
        finding.capRefusalError = null
      } catch (error) {
        finding.capRefusedRealChild = true
        finding.capRefusalError = error instanceof Error ? error.message : String(error)
      }
      finding.ledgerAfterRefusal = gate.snapshot()

      // Release the filler so the artifact's ledger is left as it was found and
      // no slot leaks into a later measurement.
      for (const slot of filler) slot.release()
      finding.ledgerAfterRelease = gate.snapshot()

      // ---- (5) G-SEAM-19: does the ONE-SHOT path consume a host slot? ------
      // The upstream fact is that `SubagentRuntime.start` reaches
      // `provider.start(resolved)` with NO capacity pool of its own
      // (subagent/src/index.ts:591), and that the continuable pool is a
      // `WeakMap<Agent, ActivationPool>` keyed by root
      // (continuation-activation.ts:180). Both are still true of the pinned
      // checkout — re-verified in the source, recorded in the artifact notes.
      //
      // The question THIS measures is the one that decides whether the gap is
      // still OPEN IN THIS PRODUCT: does the project's own guard, mounted on
      // `agent/created`, catch the one-shot path anyway? If the ledger rises,
      // the gap is closed in the product even though it is open upstream.
      const beforeOneShot = gate.snapshot().liveChildren
      let oneShotRun
      try {
        oneShotRun = await subagents.start('spawn', {
          prompt: [{ type: 'text', text: 't10 probe: one-shot child' }],
          parent: agent,
          signal: new AbortController().signal,
          maxDepth: 1,
        })
        finding.oneShotStarted = true
        finding.oneShotError = null
      } catch (error) {
        finding.oneShotStarted = false
        finding.oneShotError = error instanceof Error ? error.message : String(error)
      }
      finding.ledgerAfterOneShot = gate.snapshot()
      finding.oneShotTookHostSlot =
        finding.ledgerAfterOneShot.liveChildren > beforeOneShot
      if (oneShotRun !== undefined) {
        try {
          await oneShotRun.dispose()
        } catch { /* disposal failure is not this gate's measurement */ }
      }
    }
  } catch (error) {
    finding.error = error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error)
  }

  const json = JSON.stringify(finding, null, 2)
  writeFileSync(OUT, json)
  process.stdout.write(`T10-CAPACITY: ${json}\n`)
}
