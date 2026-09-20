/**
 * Boot-time probe: does the data plane ACTUALLY load through the real profile
 * resolver, and is it reachable as a live service?
 *
 * WHY A DIRECT `ctx.plugin()` MOUNT IS NOT EVIDENCE
 *
 * A test that calls `ctx.plugin(DataPlaneService)` proves the module runs. It does
 * NOT prove the product loads it: the plugin could be absent from every profile
 * and the test would still be green. This project has retracted that exact
 * over-claim three times -- `setLaunchPort` and `takeContinuation` each had zero
 * production callers while their tests passed, and `dsh-ipython` declared no
 * `dsh.bundle` so it could never reach the model. `docs/GAPS.md` G-FIX-04 states
 * the lesson: a gate whose oracle is weaker than its scenario passes while the
 * product is broken.
 *
 * So this probe runs INSIDE a real composed profile boot and asserts:
 *   1. `ctx.dailyData` is present -- the `cordis.patch.yml` row actually resolved
 *      and `apply()` completed, which means the reference domain is open.
 *   2. the service can CAPTURE a real file through the profile's own `ctx.fs`,
 *      so the data plane is not merely constructed but usable.
 *   3. the capture reaches `durable: true` and reads back byte-for-byte, so the
 *      commit order completed against the real storage backend.
 *
 * A real Session is also created and its tool surface reported, following
 * `verify-e2e-tool.mjs`: this is what makes "the profile booted" a measurement
 * rather than a claim.
 *
 * WHAT THIS DOES NOT PROVE, stated so a green result is not over-read:
 *   - It does not prove the model can reach `data.capture_file` as a TOOL. No
 *     `data.*` tool row exists anywhere in this tree. The M3 `ipython` package
 *     DOES now exist and boots a real kernel (M11/M12), but it registers ONE tool
 *     (`ipython`, one `code` parameter) and exposes no cell-to-host call channel,
 *     so a cell cannot reach the data plane either. What this probe proves is that
 *     the SERVICE the intended caller would bind to is live in the product.
 *   - It does not exercise the M3 kernel path at all; that is M11's probe. The
 *     real-kernel consumption of paged artifacts is in
 *     `src/data-plane.test.ts` (DAT-02, the `[real ipykernel]` case).
 */
import { writeFileSync, mkdirSync } from 'node:fs'

export const name = 'verify-data-plane'
// `inject` is a READINESS GATE, not a wish list.
//
// This is the CORRECT use of it: `dailyData` is the exact service under test, so
// gating on it means this probe activates only once the data plane is genuinely
// live. Gating on `storageDomain` instead (as a first version of this file did)
// made the probe activate on the same edge as the data-plane row and win the race
// -- it then read `ctx.dailyData` before the service was provided and reported a
// FALSE ABSENCE. `docs/GAPS.md` G-FIX-09 records the same class of measurement
// error from an earlier probe.
//
// The negative case stays visible: if the data-plane row is missing or fails to
// resolve, this plugin never activates and the boot prints it under "Plugins
// waiting for services (missing: dailyData)". That is a real signal about the
// product, unlike a probe that runs and blames the product for its own race.
export const inject = ['dailyData']

// ---------------------------------------------------------------------------
// THE OUTPUT PATH IS DERIVED FROM THIS FILE'S OWN LOCATION, not hardcoded.
//
// It used to be the literal `'D:/DSH/work/dsh-native-daily/qualification/results/M4-data/profile-boot.json'`.
// That is a cross-tree WRITE: a writer running this probe from a git worktree
// (which the multi-agent discipline requires) deposited its finding into the MAIN
// tree, and the artifact it landed on is the one a verdict READS. It is invisible
// as a diff because the finding is a small JSON object that looks the same from
// either tree, so the overwrite reads as "the value is what it always was" rather
// than "another tree wrote here". This is the write-side hazard of `G-SEAM-61`
// and the same class as `G-SEAM-66`.
//
// `import.meta.url` is `.../qualification/runners/verify-data-plane.mjs`, so two levels up is the
// repository root of WHICHEVER tree is running -- verified for a worktree, where
// it resolves to that worktree rather than to the main checkout. The finding
// therefore lands in that tree's evidence directory, beside the run record it
// describes. `M4_OUT` still overrides for an explicit target.
// ---------------------------------------------------------------------------
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

/** The repository root of the tree THIS FILE was loaded from. */
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

const OUT = process.env.M4_OUT ?? join(REPO_ROOT, 'qualification/results/M4-data/profile-boot.json')


export async function apply(ctx) {
  const finding = {
    servicePresent: false,
    // The chain `cordis.patch.yml -> data-plugin -> data-service -> artifacts ->
    // observations` is only unbroken if the object that came back is the CLASS
    // from `data-service.ts` and it carries the collaborators `artifacts.ts`
    // constructs. A bare "present" boolean would not distinguish a correctly
    // wired service from a stub registered under the same name.
    serviceKind: null,
    serviceSurface: [],
    artifactRoot: null,
    grantRevision: null,
    captureState: null,
    capturedBytes: null,
    readBackMatches: false,
    sessionCreated: false,
    sessionId: null,
    toolCountAgentKey: 0,
    dataToolPresent: false,
    dataToolNames: [],
    error: null,
  }
  try {
    const service = ctx.get('dailyData')
    if (service === undefined) {
      finding.error = 'ctx.dailyData is ABSENT: the data-plane row did not resolve through the profile'
      throw new Error(finding.error)
    }
    finding.servicePresent = true
    finding.serviceKind = service.constructor?.name ?? null
    // The methods the intended caller binds to. Each one exists only if
    // `data-service.ts` reached `artifacts.ts`, which reached `observations.ts`.
    finding.serviceSurface = ['capture', 'page', 'walk', 'lineIndex', 'readLine', 'readRange', 'resolve', 'reconcile']
      .filter(method => typeof service[method] === 'function')
    finding.artifactRoot = service.store?.root ?? null
    finding.grantRevision = service.grantRevision

    // Capture through the PROFILE'S OWN fs service, so the read is subject to the
    // authority the composed profile actually mounted.
    const probeDir = join(REPO_ROOT, 'qualification/results/M4-data')
    mkdirSync(probeDir, { recursive: true })
    const payloadPath = `${probeDir}/probe-payload.txt`
    const payload = `${'x'.repeat(150)}-PROBE-TAIL\n`
    writeFileSync(payloadPath, payload, 'utf8')

    const fs = ctx.get('fs')
    if (fs === undefined) throw new Error('ctx.fs is absent; the profile mounted no filesystem')
    const outcome = await service.capture({
      fs,
      path: payloadPath,
      mediaType: 'text/plain',
      observationId: `obs-probe-${Date.now()}`,
    })
    finding.captureState = outcome.reference.state
    finding.capturedBytes = outcome.descriptor.captured.bytes
    // Read it back through the committed reference, which is the path a kernel
    // would use. A byte-for-byte match is what makes the capture real.
    const resolved = await service.resolve(outcome.descriptor.id)
    finding.readBackMatches = Buffer.from(resolved.bytes).toString('utf8') === payload

    // A real Session, so "the profile booted" is measured rather than asserted.
    // Read through `ctx.get`, NOT through `inject`: the session controller is not
    // guaranteed present on every profile, and a hard injection gate would stop
    // this probe from running at all on a profile that lacks it -- reporting the
    // probe's own absence as the product's.
    const sc = ctx.get('sessionController')
    if (sc !== undefined) {
      const created = await sc.create({ cwd: process.cwd() })
      const sessionId = created?.sessionId ?? created?.id ?? null
      finding.sessionId = sessionId
      finding.sessionCreated = sessionId !== null
      const agents = ctx.get('agents')
      const agent = agents?.get(sessionId)
      if (agent !== undefined) {
        const names = ctx.get('tools').schemas(agent).map(schema => schema.name).sort()
        finding.toolCountAgentKey = names.length
        // Named rather than counted: a `data` prefix is a CLAIM about the surface,
        // and an empty list is what makes `dataToolPresent: false` checkable.
        finding.dataToolNames = names.filter(entry => entry.startsWith('data'))
        finding.dataToolPresent = finding.dataToolNames.length > 0
        finding.tools = names
      }
    }
  } catch (error) {
    finding.error = error instanceof Error ? `${error.message}` : String(error)
  }
  writeFileSync(OUT, JSON.stringify(finding, null, 2))
  process.stdout.write(`VERIFY-DATA-PLANE: ${JSON.stringify(finding)}\n`)
}
