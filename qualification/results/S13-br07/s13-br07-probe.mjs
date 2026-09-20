/**
 * S13 / BR-07 composition-tier probe: RETURN A CELL WHILE NATIVE CHILD CALLS ARE
 * STILL IN FLIGHT, and record the dispositions the PRODUCT actually writes.
 *
 * WHY THIS IS NOT R5's PROBE RE-RUN. `qualification/runners/r5-bridge-product.mjs`
 * is the right instrument for F2 (does a real boot reach a live BridgeServer) and
 * it was read in full before this file was written. It does not fit BR-07's
 * oracle for two reasons, both measured rather than assumed:
 *
 *   1. Its cell AWAITS its single `dsh.call` before returning, so the only
 *      disposition it can ever observe is `settled`. BR-07's stimulus is the
 *      opposite: the cell returns with the call STILL RUNNING.
 *   2. Its patch row (`r5-bridge-product.patch.yml`) hardcodes the module path
 *      `D:/DSH/work/wt-r5/qualification/runners/r5-bridge-product.mjs`, i.e. a
 *      SIBLING worktree. Running it from this worktree would either load another
 *      writer's probe or fail; and the driver's `OUT` default is that writer's
 *      results directory. That is the stale/foreign-artifact trap that produced
 *      G-SEAM-29 and G-SEAM-36, so it is not touched.
 *
 * WHAT IS DIFFERENT AND WHY IT MATTERS. R5 read the dispositions back through
 * `service.ledgerFor(agent).all()`, which for the durable ledger reads the
 * domain's in-memory table. This probe reads BOTH:
 *
 *   - the service's own ledger object (the API a host caller uses), AND
 *   - the JSON file the storage domain actually wrote on disk,
 *
 * and reports any disagreement as its own field. "Durable" is a claim about the
 * FILE; reading it back through the writer's own cache would not test it.
 *
 * THE ORACLE, VERBATIM: "Return a cell while native child calls are still in
 * flight." The cell therefore starts TWO background calls and returns without
 * awaiting either:
 *
 *   A calls a tool that blocks until aborted -> it is IN FLIGHT (dispatched to
 *     the registry) when the cell settles.
 *   B calls a fast tool, but the lease is SERIAL (V3 §J1), so B is QUEUED behind
 *     A and never starts.
 *
 * A small in-cell sleep after each start is what makes this a measurement rather
 * than a race: without it the frames may not have reached the host at all, and
 * the ledger would correctly hold zero rows -- which is a different fact
 * ("no call arrived") and must not be confused with this one.
 *
 * WHAT THIS PROBE DOES NOT ESTABLISH, stated because it bounds the claim:
 *   - No real model turn. There is no LLM in this boot; the probe calls
 *     `ctx.tools.execute` with the `ipython` tool's name, which is what the
 *     agent loop does, but the model's decision to call the tool is not
 *     exercised.
 *   - The two nested tools are the PROBE's, registered through the boot's real
 *     registry. Registering a tool is what the deployment does; these stand in
 *     for the catalog and are not a claim about which tools it holds.
 *   - Exactly-once external effects are NOT proven and are not claimed.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { writeFileSync } from 'node:fs'

export const name = 's13-br07'
// A readiness gate: with no ipython service composed this probe reports nothing
// rather than reporting a false absence (the G-FIX-04 shape).
export const inject = ['sessionController', 'ipython', 'tools']

const OUT = process.env.DSH_PROBE_OUT
if (OUT === undefined || OUT === '') {
  throw new Error('s13-br07-probe: DSH_PROBE_OUT must name this caller\'s own result path')
}

const SLOW = 's13_slow_inflight'
const QUEUED = 's13_queued_behind'

/** The compiled JSON-Schema form `tools.register` expects (not `defineTool`'s author form). */
const noArgsSchema = {
  type: 'object',
  additionalProperties: false,
  properties: { ran: { type: 'boolean' } },
}

export async function apply(ctx) {
  const finding = {
    scope: 'S13 / BR-07: dispositions actually written when a real boot returns a cell with calls in flight',
    profileBooted: true,
    presetDefaultId: null,
    presetRoots: [],
    kernelServicePresent: false,
    sessionCreated: false,
    sessionId: null,
    ipythonToolPresent: false,
    toolCountAgentKey: 0,
    bridgePresentAfterBoot: false,
    bridgeEndpointPort: null,
    bridgeLeasesAtRestAtStart: null,
    /**
     * Read AFTER the cell ran, not before. The first version of this probe read
     * `bridgeFor` at the top, before any cell, and got `false` with
     * `kernelEpoch: 0` -- a FALSE NEGATIVE: the kernel and its bridge are created
     * LAZILY on the first cell, so there is nothing to find yet. Recorded because
     * it is the same shape as the G-FIX-06 false negative (a probe measuring
     * before the thing exists) and a reader must not take the earlier reading as
     * an F2 regression.
     */
    bridgePresentAfterCell: null,
    bridgeEndpointPortAfterCell: null,
    kernelEpochBeforeCell: null,
    kernelEpoch: null,
    kernelLifecycle: null,

    // ---- the stimulus -------------------------------------------------------
    toolCallDispatched: false,
    toolCallOutcome: null,
    cellPrinted: null,
    returnedWithAInFlight: null,
    returnedWithBInFlight: null,

    // ---- what the registry itself saw (not the bridge's own account) --------
    registryDispatches: [],
    slowEntered: 0,
    queuedToolEntered: 0,

    // ---- the dispositions, read from the service's own ledger API ----------
    ledgerDurable: null,
    ledgerRowsViaApi: [],
    ledgerDispositionsViaApi: [],
    ledgerUnrecordedFailures: [],

    // ---- the same rows, read from the FILE the storage domain wrote --------
    ledgerFilePath: null,
    ledgerFileReadable: false,
    ledgerFileRows: [],
    ledgerDispositionsViaFile: [],
    apiAndFileAgree: null,

    // ---- crash window ------------------------------------------------------
    unknownOutcomeCount: null,
    unknownOutcomeRows: [],
    /**
     * THE CONTRAST: what the NAIVE predicate (`settledAt === undefined`) would
     * have returned, computed here rather than read from the ledger. Reported so a
     * reader can see the two sets differ, and by how much. Before the fix this
     * array and `unknownOutcomeRows` were the same set.
     */
    unknownByNaiveSettledAtFilter: [],

    // ---- reachability of the handoff arm -----------------------------------
    jobsServicePresent: null,
    jobsServiceNames: [],

    leasesAtRestAfter: null,
    error: null,
  }

  try {
    const roster = ctx.get('agentPresets')
    if (roster !== undefined) {
      finding.presetDefaultId = roster.defaultId ?? null
      finding.presetRoots = (roster.roots ?? []).map(root => String(root.path))
    }

    const service = ctx.get('ipython')
    finding.kernelServicePresent = service !== undefined
    if (service === undefined) throw new Error('the ipython service is not mounted in this profile')

    // IS THERE A JOBS CAPABILITY IN THIS COMPOSITION? This is the question the
    // `handed-to-jobs` reachability verdict turns on, and it is asked of the BOOT
    // rather than inferred from a patch file.
    const jobs = ctx.get('jobs')
    finding.jobsServicePresent = jobs !== undefined
    if (jobs !== undefined) {
      finding.jobsServiceNames = Object.getOwnPropertyNames(Object.getPrototypeOf(jobs) ?? {})
        .filter(n => n !== 'constructor')
        .slice(0, 40)
    }

    const sc = ctx.get('sessionController')
    const created = await sc.create({ cwd: process.cwd() })
    finding.sessionId = created?.sessionId ?? created?.id ?? null
    finding.sessionCreated = finding.sessionId !== null
    const agent = ctx.get('agents')?.get(finding.sessionId)
    if (agent === undefined) throw new Error('the created session has no live agent in this process')

    finding.bridgePresentAfterBoot = service.bridgeFor?.(agent) !== undefined
    finding.bridgeEndpointPort = service.bridgeFor?.(agent)?.endpoint?.port ?? null
    finding.bridgeLeasesAtRestAtStart = service.bridgeFor?.(agent)?.server?.openLeases?.().length ?? null
    finding.kernelEpochBeforeCell = service.currentEpoch?.(agent) ?? null

    // ---- the registry-side instrument --------------------------------------
    ctx.on('tools/pre-execute', (exec, next) => {
      if (exec.name === SLOW || exec.name === QUEUED) {
        finding.registryDispatches.push({ name: exec.name, callId: String(exec.callId) })
      }
      return next()
    })

    // A: dispatched, and stays in the registry until the lease close aborts it.
    ctx.tools.register({
      name: SLOW,
      description: 'Stays in the registry until the cell lease close aborts it.',
      parameters: noArgsSchema,
      output: { schema: noArgsSchema, render: (_a, v) => [{ type: 'text', text: JSON.stringify(v) }] },
      execute: async (_args, exec) => {
        finding.slowEntered += 1
        await new Promise(resolveDelay => {
          const timer = setTimeout(resolveDelay, 60_000)
          exec.signal.addEventListener('abort', () => { clearTimeout(timer); resolveDelay() }, { once: true })
        })
        return { ran: true }
      },
    })

    // B: must never be dispatched -- the serial queue never reaches it.
    ctx.tools.register({
      name: QUEUED,
      description: 'Fast, but queued behind the slow call and never started.',
      parameters: noArgsSchema,
      output: { schema: noArgsSchema, render: (_a, v) => [{ type: 'text', text: JSON.stringify(v) }] },
      execute: async () => {
        finding.queuedToolEntered += 1
        return { ran: true }
      },
    })

    const tools = ctx.get('tools')
    const names = tools.schemas(agent).map(schema => schema.name)
    finding.ipythonToolPresent = names.includes('ipython')
    finding.toolCountAgentKey = names.length

    // ---- THE STIMULUS: the cell returns with both calls pending ------------
    const result = await tools.execute({
      callId: 's13-br07-outer-1',
      name: 'ipython',
      arguments: {
        code: [
          'import asyncio',
          'async def first():',
          `    return await dsh.call('${SLOW}', {})`,
          'async def second():',
          `    return await dsh.call('${QUEUED}', {})`,
          'a = asyncio.ensure_future(first())',
          'await asyncio.sleep(0.6)',
          'b = asyncio.ensure_future(second())',
          'await asyncio.sleep(0.6)',
          "print('RETURNING_WITH_A_IN_FLIGHT=' + str(not a.done()))",
          "print('RETURNING_WITH_B_IN_FLIGHT=' + str(not b.done()))",
        ].join('\n'),
      },
      agent,
      signal: new AbortController().signal,
    })
    finding.toolCallDispatched = true
    finding.toolCallOutcome = result.isError ? 'error' : 'ok'
    const text = result.isError ? result.error.message : String(result.value?.text ?? '')
    finding.cellPrinted = text.slice(0, 4000)
    finding.returnedWithAInFlight = /^RETURNING_WITH_A_IN_FLIGHT=(True|False)$/mu.exec(text)?.[1] ?? null
    finding.returnedWithBInFlight = /^RETURNING_WITH_B_IN_FLIGHT=(True|False)$/mu.exec(text)?.[1] ?? null

    finding.kernelLifecycle = service.lifecycleOf?.(agent) ?? null

    // THE BRIDGE, read now that a cell has created the kernel lazily.
    finding.bridgePresentAfterCell = service.bridgeFor?.(agent) !== undefined
    finding.bridgeEndpointPortAfterCell = service.bridgeFor?.(agent)?.endpoint?.port ?? null
    finding.kernelEpoch = service.currentEpoch?.(agent) ?? null

    // ---- READ 1: the service's own ledger API ------------------------------
    finding.ledgerDurable = service.ledgerIsDurable?.(agent) ?? null
    const ledger = service.ledgerFor?.(agent)
    const rowsViaApi = ledger?.all?.() ?? []
    finding.ledgerRowsViaApi = rowsViaApi.length
    finding.ledgerDispositionsViaApi = rowsViaApi.map(row => ({
      subCallId: row.subCallId,
      name: row.name,
      disposition: row.disposition ?? null,
      jobId: row.jobId ?? null,
      closeReason: row.closeReason ?? null,
      started: row.startedAt !== undefined,
      settled: row.settledAt !== undefined,
    }))
    finding.ledgerUnrecordedFailures = (service.ledgerFailures?.(agent) ?? []).map(error => String(error?.message ?? error))
    // A call that was ACCEPTED but NEVER DISPATCHED has no `settledAt`, because
    // the only writer of that stamp is the runner that dispatches. It must NOT be
    // reported as the crash window: its disposition proves nothing ran.
    finding.unknownOutcomeRows = (ledger?.unknownOutcomes?.() ?? []).map(row => ({
      subCallId: row.subCallId,
      name: row.name,
      disposition: row.disposition ?? null,
      settled: row.settledAt !== undefined,
    }))
    finding.unknownOutcomeCount = finding.unknownOutcomeRows.length
    // The independent cross-check, computed from the rows this probe already
    // holds, so the ledger's own predicate can be shown to agree or disagree.
    finding.unknownByNaiveSettledAtFilter = rowsViaApi
      .filter(row => row.settledAt === undefined)
      .map(row => row.subCallId)

    // ---- READ 2: the FILE the storage domain wrote -------------------------
    const home = process.env.DSH_HOME
    if (home !== undefined && home !== '') {
      const file = join(home, 'storages', 'dsh_ipython_bridge_ledger.json')
      finding.ledgerFilePath = file
      try {
        const parsed = JSON.parse(readFileSync(file, 'utf8'))
        finding.ledgerFileReadable = true
        // The JSON backend's on-disk shape: find every record-shaped object that
        // carries a subCallId, wherever the backend nests its tables, so this
        // reader is not coupled to one nesting.
        const found = []
        const visit = node => {
          if (node === null || typeof node !== 'object') return
          if (Array.isArray(node)) { for (const item of node) visit(item); return }
          if (typeof node.subCallId === 'string') found.push(node)
          for (const value of Object.values(node)) visit(value)
        }
        visit(parsed)
        finding.ledgerFileRows = found.length
        finding.ledgerDispositionsViaFile = found.map(row => ({
          subCallId: row.subCallId,
          name: row.name ?? null,
          disposition: row.disposition ?? null,
          jobId: row.jobId ?? null,
          closeReason: row.closeReason ?? null,
          started: row.startedAt !== undefined,
          settled: row.settledAt !== undefined,
        }))
      } catch (error) {
        finding.ledgerFileReadable = false
        finding.ledgerFileError = error instanceof Error ? error.message : String(error)
      }
    }

    // The agreement check, so a reader does not have to diff two arrays by eye.
    const key = entry => `${entry.subCallId}|${entry.disposition}|${entry.jobId ?? ''}`
    finding.apiAndFileAgree = finding.ledgerFileReadable
      ? JSON.stringify([...finding.ledgerDispositionsViaApi].map(key).sort())
        === JSON.stringify([...finding.ledgerDispositionsViaFile].map(key).sort())
      : null

    finding.leasesAtRestAfter = service.bridgeFor?.(agent)?.server?.openLeases?.().length ?? null

    await service.close?.().catch(() => undefined)
  } catch (error) {
    finding.error = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
  }
  writeFileSync(OUT, JSON.stringify(finding, null, 2))
  process.stdout.write(`S13-BR07: ${JSON.stringify(finding)}\n`)
}
