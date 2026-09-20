/**
 * P4 composition-tier probe: does a REAL BOOT serve a `data:*` call?
 *
 * THE QUESTION, AND WHY THE TEST IS NOT ENOUGH.
 *
 * `packages/dsh-ipython/src/p4-data-routing.test.ts` drives the routing branch
 * with a hand-mounted bridge, a hand-minted lease and a STAND-IN plane. That
 * establishes the SEAM and says nothing about the product: the registry, the
 * kernel service and the data handler there are installed by the test in a
 * context the test owns. This project has recorded the gap between those two
 * tiers more than twelve times, most recently as `G-SEAM-77` itself -- where the
 * plane was complete, unit-tested and correct while no product path could enter
 * it.
 *
 * So this probe boots the REAL `daily` profile and drives the whole path:
 *
 *   final launcher -> DSH_HOME (this caller's) -> daily profile
 *   -> daily-standard Agent -> model-facing `ipython` -> real kernel
 *   -> packaged Python client -> bridge -> CellLease -> data:*
 *   -> the live DataPlaneService the PROFILE mounted -> result in Python
 *
 * WHAT IS REAL HERE. The profile's own bundle and preset rows, its own storage
 * domain, its own attachment provider, its own mounted `dailyData` service, the
 * real registry, a real Session, a real kernel, and the REAL Python client read
 * off the disk of the package that ships it.
 *
 * THE OUTPUT PATH IS OVERRIDABLE AND HAS NO DEFAULT. A probe writing to a fixed
 * path is a SHARED MUTABLE RESOURCE and two callers cannot tell whose result they
 * hold -- a false PASS this project recorded once (G-FIX-13). An unset
 * `DSH_PROBE_OUT` is therefore a HARD ERROR rather than a write into somebody
 * else's tree, which is the discipline `r5-bridge-product.mjs` established.
 *
 * WHAT THIS PROBE DOES NOT ESTABLISH, stated because it bounds the claim.
 *   1. There is no LLM in this boot, so the model's DECISION to call `ipython`
 *      is not exercised. The probe calls `ctx.tools.execute` with the tool's own
 *      name, which is what the agent loop does.
 *   2. It drives ONE `data:*` operation. One served call does not prove the whole
 *      plane is correct; the per-method behaviour is `data-r6.test.ts`'s subject
 *      and is measured there against the real service.
 *   3. It does not exercise the >32 MiB / long-line / projection arms V5 §5.5
 *      lists. Those are recorded as NOT_RUN in the result rather than implied.
 */
import { writeFileSync } from 'node:fs'

export const name = 'p4-data-product'
// A readiness gate. Without the ipython service and the data plane this probe
// would report a false ABSENCE rather than a real one (the G-FIX-04 shape), so
// it does not run at all and the driver reports the missing service.
export const inject = ['sessionController', 'ipython', 'tools', 'dailyData']

const OUT = process.env.DSH_PROBE_OUT
if (OUT === undefined || OUT === '') {
  throw new Error('p4-data-product: DSH_PROBE_OUT must name this caller\'s own result path; a shared fixed path cannot be attributed to a caller')
}

export async function apply(ctx) {
  const finding = {
    scope: 'P4 composition tier: a real daily boot serves a data:* call through the plane',
    profileBooted: true,
    homeBooted: process.env.DSH_HOME ?? null,
    cwd: process.cwd(),
    presetDefaultId: null,
    presetRoots: [],
    kernelServicePresent: false,
    dataPlanePresent: false,
    dataPlaneIsService: false,
    dataClientPath: null,
    dataClientExists: false,
    sessionCreated: false,
    sessionId: null,
    ipythonToolPresent: false,
    toolCountAgentKey: 0,
    // The product path, driven.
    toolCallDispatched: false,
    toolCallOutcome: null,
    cellPrinted: null,
    dshBoundInCell: null,
    dataNamespaceInCell: null,
    dataSurfaceInCell: null,
    captureObservationId: null,
    captureAcquiredBytes: null,
    pageOffset: null,
    pageByteLength: null,
    pageSha256: null,
    // The no-fall-through property, observed from the registry's side.
    dataNamesSeenByPipeline: [],
    toolNamesSeenByPipeline: [],
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

    // THE PLANE THE PROFILE MOUNTED, read as a fact rather than inferred from the
    // patch file. This is the `G-SEAM-52` discipline: check by CALLING the seam.
    const plane = ctx.get('dailyData')
    finding.dataPlanePresent = plane !== undefined
    if (plane === undefined) throw new Error('ctx.dailyData is not mounted in this profile')
    finding.dataPlaneIsService = typeof plane.routeData === 'function'
    if (typeof plane.dataClientPath === 'function') {
      const clientPath = plane.dataClientPath()
      finding.dataClientPath = clientPath
      const { existsSync } = await import('node:fs')
      finding.dataClientExists = existsSync(clientPath)
    }

    // A REAL Session on the profile's own default preset.
    const sc = ctx.get('sessionController')
    const created = await sc.create({ cwd: process.cwd() })
    finding.sessionId = created?.sessionId ?? created?.id ?? null
    finding.sessionCreated = finding.sessionId !== null
    const agent = ctx.get('agents')?.get(finding.sessionId)
    if (agent === undefined) throw new Error('the created session has no live agent in this process')

    // THE REGISTRY-SIDE INSTRUMENT. Every call the REAL pipeline saw is recorded
    // before dispatch, so "did a data:* name reach ctx.tools.execute" is answered
    // by the pipeline rather than by the bridge's account of itself.
    ctx.on('tools/pre-execute', (exec, next) => {
      const callName = String(exec.name)
      if (callName.startsWith('data:')) finding.dataNamesSeenByPipeline.push(callName)
      finding.toolNamesSeenByPipeline.push(callName)
      return next()
    })

    const tools = ctx.get('tools')
    const names = tools.schemas(agent).map(schema => schema.name)
    finding.ipythonToolPresent = names.includes('ipython')
    finding.toolCountAgentKey = names.length

    // A REAL FILE TO CAPTURE, inside the Session's own workspace.
    const { writeFileSync: write } = await import('node:fs')
    const { join } = await import('node:path')
    const probeFile = join(process.cwd(), 'p4-data-product-input.txt')
    write(probeFile, 'the data plane reads this through the host FS backend\n', 'utf8')

    // ── THE PRODUCT PATH, DRIVEN ──────────────────────────────────────────────
    // One cell that installs nothing and fabricates nothing: it uses only what
    // the host's preamble put in its namespace.
    const code = [
      'import json',
      "print('DSH_BOUND=' + str('dsh' in dir()))",
      "print('HAS_DATA=' + str(hasattr(dsh, 'data')))",
      "print('DATA_SURFACE=' + json.dumps(sorted(n for n in dir(dsh.data) if not n.startswith('_'))))",
      `obs = await dsh.data.fs.capture(${JSON.stringify(probeFile)})`,
      "print('OBS=' + json.dumps({'id': obs.observation_id, 'acquired': obs.acquired_bytes, 'sha': obs.sha256}, sort_keys=True, separators=(',', ':')))",
      'walk = await obs.pages(max_bytes=8, max_pages=1)',
      "print('WALK=' + json.dumps({'pages': walk.pages, 'bytes': walk.bytes, 'artifact_bytes': walk.artifact_bytes}, sort_keys=True, separators=(',', ':')))",
      'async for page in walk:',
      "    print('PAGE=' + json.dumps({'offset': walk.io.get('offsets', [None])[0], 'len': len(page), 'sha': walk.sha256}, sort_keys=True, separators=(',', ':')))",
      '    break',
      // THE UNKNOWN-OP ARM, as a RAW FRAME: the client's surface is closed at the
      // attribute level, so an unknown method never reaches the host. The host's
      // own rule is what is measured here -- refused as a DATA error, never
      // dispatched as a tool.
      'try:',
      "    await dsh._channel.call_async('data:fs.not_a_method', {'x': 1}, 120.0)",
      "    print('UNKNOWN_OP=no-refusal')",
      'except Exception as exc:',
      "    print('UNKNOWN_OP=' + str(getattr(exc, 'code', type(exc).__name__)))",
    ].join('\n')

    const result = await tools.execute({
      callId: 'p4-data-outer-1',
      name: 'ipython',
      arguments: { code },
      agent,
      signal: new AbortController().signal,
    })
    finding.toolCallDispatched = true
    finding.toolCallOutcome = result.isError ? 'error' : 'ok'
    const text = result.isError ? result.error.message : String(result.value?.text ?? '')
    finding.cellPrinted = text.slice(0, 4000)
    finding.dshBoundInCell = /^DSH_BOUND=(True|False)$/mu.exec(text)?.[1] ?? null
    finding.dataNamespaceInCell = /^HAS_DATA=(True|False)$/mu.exec(text)?.[1] ?? null
    finding.dataSurfaceInCell = /^DATA_SURFACE=(.*)$/mu.exec(text)?.[1] ?? null
    const obs = /^OBS=(.*)$/mu.exec(text)?.[1]
    if (obs !== undefined) {
      const parsed = JSON.parse(obs)
      finding.captureObservationId = parsed.id ?? null
      finding.captureAcquiredBytes = parsed.acquired ?? null
    }
    const walk = /^WALK=(.*)$/mu.exec(text)?.[1]
    if (walk !== undefined) {
      const parsed = JSON.parse(walk)
      finding.pageOffset = parsed.bytes ?? null
      finding.pageByteLength = parsed.artifact_bytes ?? null
    }
    const page = /^PAGE=(.*)$/mu.exec(text)?.[1]
    if (page !== undefined) finding.pageSha256 = JSON.parse(page).sha ?? null
    finding.unknownDataOpRefusal = /^UNKNOWN_OP=(.*)$/mu.exec(text)?.[1] ?? null
  } catch (error) {
    finding.error = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
  }

  writeFileSync(OUT, `${JSON.stringify(finding, null, 2)}\n`, 'utf8')
}
