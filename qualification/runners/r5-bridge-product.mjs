/**
 * R5 composition-tier probe: does a REAL BOOT reach a live BridgeServer?
 *
 * WHY THIS EXISTS, AND WHY IT IS NOT THE SAME AS THE TEST.
 *
 * `packages/dsh-ipython/src/r5-product-bridge.test.ts` measures the assembled
 * CODE PATH: it drives the package's own `apply()` and the real `ipython` tool
 * through a real `ToolRuntime`, with a real kernel. That is strictly stronger
 * than the hand-mounted probes it replaced, and it is still not the product:
 * the registry, the subprocess provider and the kernel service are installed by
 * the TEST in a context the test owns.
 *
 * This probe measures the assembled COMPOSITION. It boots the real `daily`
 * profile through the shared port-safe harness, resolves the `ipython` SERVICE
 * and the `ipython` TOOL out of that boot's own layers, creates a real Session,
 * and then drives one `ipython` tool call whose cell runs `dsh.call(...)`. The
 * question it answers is the one the audit's F2 finding was about: does anything
 * in the PRODUCT construct a bridge, and can a model's Python reach a DSH tool
 * through it.
 *
 * WHAT IS REAL HERE. The profile's own bundle and preset rows (the `daily`
 * install's `dsh-ipython` host row and its `daily-standard` preset tool row),
 * the profile's own storage domain, the profile's own subprocess provider, the
 * real registry, a real Session, a real kernel.
 *
 * WHAT THIS PROBE DOES NOT ESTABLISH, stated because it bounds the claim.
 *   1. It does NOT drive a real model turn. There is no LLM in this boot; the
 *      probe calls `ctx.tools.execute` with the `ipython` tool's own schema,
 *      which is exactly what the agent loop does, but the model's decision to
 *      call the tool is not exercised. `live_provider_budget_authorized` is
 *      false in this deployment, so that tier is not available here.
 *   2. It uses `ctx.get('tools')` and a Session the probe creates. Both are
 *      things the real host also does, but a probe is not the host.
 *   3. The tool it calls inside the cell is one the PROBE registers, because the
 *      daily catalog's own tools (`read`, `write`, ...) need a workspace and a
 *      policy context this probe deliberately does not fabricate. Registering a
 *      tool is what the deployment does too; the probe's tool is a stand-in for
 *      the catalog, not a claim about which tools the catalog holds (that is
 *      IPY-09's probe, which measures the catalog itself).
 *
 * THE OUTPUT PATH IS OVERRIDABLE, and it must be: a probe writing to a fixed
 * path is a SHARED MUTABLE RESOURCE, and two agents cannot tell whose result
 * they hold. That produced a false PASS earlier in this project (G-FIX-13), and
 * this round added a second reason -- 22 of the runners here hardcode an
 * absolute path into the MAIN checkout, so running one from a worktree writes
 * into a tree the caller does not own. This probe honours `DSH_PROBE_OUT` and
 * defaults to nothing: an unset variable is a hard error rather than a write
 * into somebody else's tree.
 */
import { writeFileSync } from 'node:fs'

export const name = 'r5-bridge-product'
// A readiness gate. If the ipython service is not composed this probe never
// runs and reports NOTHING, rather than reporting a false absence -- the
// G-FIX-04 shape, where a gate passed while the product mounted no service.
export const inject = ['sessionController', 'ipython', 'tools']

const OUT = process.env.DSH_PROBE_OUT
if (OUT === undefined || OUT === '') {
  throw new Error('r5-bridge-product: DSH_PROBE_OUT must name this caller\'s own result path; a shared fixed path cannot be attributed to a caller')
}

/** The probe's stand-in tool, registered through the boot's real registry. */
const PROBE_TOOL = 'r5_product_echo'

export async function apply(ctx) {
  const finding = {
    scope: 'R5 composition tier: a real daily boot reaches a live BridgeServer',
    profileBooted: true,
    presetDefaultId: null,
    presetRoots: [],
    kernelServicePresent: false,
    sessionCreated: false,
    sessionId: null,
    ipythonToolPresent: false,
    toolCountAgentKey: 0,
    toolCountUnscopedKey: 0,
    // The F2 question, as a fact read out of the boot rather than inferred.
    bridgePresentAfterBoot: false,
    bridgeEndpointPort: null,
    bridgeProtocolVersion: null,
    bridgeLeasesAtRest: 0,
    bridgeCreatedByProduction: false,
    kernelEpoch: null,
    kernelLifecycle: null,
    // The product path, driven.
    toolCallDispatched: false,
    toolCallOutcome: null,
    cellPrinted: null,
    dshBoundInCell: null,
    nestedDispatchCount: 0,
    nestedSubCallIds: [],
    ledgerRowCount: 0,
    ledgerDispositions: [],
    ledgerDurable: null,
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

    // A REAL Session on the profile's own default preset.
    const sc = ctx.get('sessionController')
    const created = await sc.create({ cwd: process.cwd() })
    finding.sessionId = created?.sessionId ?? created?.id ?? null
    finding.sessionCreated = finding.sessionId !== null
    const agent = ctx.get('agents')?.get(finding.sessionId)
    if (agent === undefined) throw new Error('the created session has no live agent in this process')

    // The tool the cell will call. Registered through the BOOT's registry, so it
    // travels the same pipeline a catalog tool would.
    let nestedDispatches = 0
    const nestedSubCallIds = []
    ctx.on('tools/pre-execute', (exec, next) => {
      if (exec.name === PROBE_TOOL) {
        nestedDispatches += 1
        nestedSubCallIds.push(String(exec.callId))
      }
      return next()
    })
    ctx.tools.register({
      name: PROBE_TOOL,
      description: 'Returns a small canonical object, so the product path is observable end to end.',
      // THE SCHEMA SHAPE IS THE COMPILED JSON-SCHEMA FORM, NOT `defineTool`'s
      // AUTHOR FORM. `defineTool` accepts `properties: { x: { type, required: true } }`
      // and compiles it; a bare `tools.register` (which is what a probe can do
      // without resolving the package from inside the profile) receives the
      // definition as-is and validates it against JSON Schema, where `required`
      // is an ARRAY of names and a per-property boolean is refused:
      //
      //   JsonSchemaError: schema.properties.marker.required is not supported
      //   on type "string"
      //
      // Measured here, twice, because the error names the property and not the
      // cause. Recorded rather than left as a trap for the next probe author.
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: { tag: { type: 'string' } },
        required: ['tag'],
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            marker: { type: 'string' },
            tag: { type: 'string' },
          },
          required: ['marker', 'tag'],
        },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      execute: async args => ({ marker: 'R5-COMPOSITION', tag: args.tag }),
    })

    // THE CATALOG THE MODEL IS OFFERED, read with the AGENT OBJECT as the scope
    // key. `AgentLoop` builds the scope with `createScope(loopCtx, this)` and
    // DSH's own PTC harvests with `registry.schemas(exec.agent)`, so the agent is
    // the key. A first version of this probe called `schemas()` with no argument
    // and got an EMPTY list while the tool was in fact present -- the false
    // negative recorded as G-FIX-06, reproduced here and corrected by measuring
    // both keys rather than trusting either.
    const tools = ctx.get('tools')
    const names = tools.schemas(agent).map(schema => schema.name)
    finding.ipythonToolPresent = names.includes('ipython')
    finding.toolCountAgentKey = names.length
    finding.toolCountUnscopedKey = (tools.schemas?.() ?? []).length

    // THE PRODUCT PATH, DRIVEN. `ctx.tools.execute` with the tool's own name is
    // what the agent loop does; the tool then builds its CellAuthority from the
    // live ToolRunContext and the kernel service mints the lease.
    const result = await tools.execute({
      callId: 'r5-composition-outer-1',
      name: 'ipython',
      arguments: {
        code: [
          'import json',
          "print('DSH_BOUND=' + str('dsh' in dir()))",
          `value = await dsh.call('${PROBE_TOOL}', {'tag': 'from-a-real-boot'})`,
          "print('CELL_VALUE=' + json.dumps(value, sort_keys=True, separators=(',', ':')))",
        ].join('\n'),
      },
      agent,
      signal: new AbortController().signal,
    })
    finding.toolCallDispatched = true
    finding.toolCallOutcome = result.isError ? 'error' : 'ok'
    const text = result.isError ? result.error.message : String(result.value?.text ?? '')
    finding.cellPrinted = text.slice(0, 4000)
    finding.dshBoundInCell = /^DSH_BOUND=(True|False)$/mu.exec(text)?.[1] ?? null

    // THE F2 FACT, read out of the boot. `bridgeFor` returns the per-epoch
    // capability the creation transaction published, so a non-undefined answer
    // is the product having constructed one -- not a test having done it.
    const bridge = service.bridgeFor?.(agent)
    finding.bridgePresentAfterBoot = bridge !== undefined
    finding.bridgeEndpointPort = bridge?.endpoint?.port ?? null
    finding.bridgeProtocolVersion = bridge?.protocolVersion ?? null
    finding.bridgeLeasesAtRest = bridge?.server?.openLeases?.().length ?? null
    finding.bridgeCreatedByProduction = bridge !== undefined
    finding.kernelEpoch = service.currentEpoch?.(agent) ?? null
    finding.kernelLifecycle = service.lifecycleOf?.(agent) ?? null

    // The ledger, which is BR-07's record. Read back from the boot's own service.
    finding.ledgerDurable = service.ledgerIsDurable?.(agent) ?? null
    const rows = service.ledgerFor?.(agent)?.all?.() ?? []
    finding.ledgerRowCount = rows.length
    finding.ledgerDispositions = rows.map(row => ({
      subCallId: row.subCallId,
      name: row.name,
      disposition: row.disposition ?? null,
      started: row.startedAt !== undefined,
      settled: row.settledAt !== undefined,
      jobId: row.jobId ?? null,
    }))

    finding.nestedDispatchCount = nestedDispatches
    finding.nestedSubCallIds = nestedSubCallIds

    // Leave nothing running: the boot is killed by the harness, but a kernel
    // still holding a lease at exit would make the next reader's numbers differ.
    await service.close?.().catch(() => undefined)
  } catch (error) {
    finding.error = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
  }
  writeFileSync(OUT, JSON.stringify(finding, null, 2))
  process.stdout.write(`R5-BRIDGE-PRODUCT: ${JSON.stringify(finding)}\n`)
}
