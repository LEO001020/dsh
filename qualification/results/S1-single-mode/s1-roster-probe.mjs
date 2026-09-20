/**
 * S1 probe: what MODES does the installed daily profile actually offer?
 *
 * WHY THIS EXISTS. The user authorized keeping only our single mode. The change
 * is `includeShippedRoot: false` on the profile's `agent-presets` row, and the
 * only honest way to show it works is to boot the REAL installed profile and
 * read the roster the product itself composes -- not to assert that a YAML key
 * says `false`.
 *
 * IT ADDS NO ROWS. Everything below comes from the profile's own composition:
 * its bundles plus its own `agent-presets` root. A probe that inserted a preset
 * row would measure the overlay rather than the product (the G-FIX-04 /
 * G-FIX-05 / G-FIX-12 defect class this project has recorded five times).
 *
 * WHAT IT MEASURES, and why each field is load-bearing:
 *   - `roots`: the RESOLVED root list from `roster.roots`, which is the
 *     mechanism under test. `includeShippedRoot: false` must REMOVE the
 *     package's bundled `presets/` directory from this list while leaving the
 *     profile's own root present.
 *   - `listed`: what `roster.list()` returns -- the actual selectable set.
 *   - `defaultId`: what an unnamed new Session would mount.
 *   - `resolveOf(id)` for each SHIPPED id: whether the shipped presets are still
 *     reachable by name. A roster that merely stopped LISTING them while
 *     `resolve()` still answered would be a weaker result than it looks, so the
 *     probe asks the resolution path directly instead of inferring from `list()`.
 *   - `selectionPolicy`: `modeSelectionEnabled` + the effective default, which
 *     is what the UI's picker visibility keys on
 *     (`ui-agent-preset/src/client/seat-store.ts:93-101`).
 *   - `toolFace`: the agent-keyed tool catalog of a REAL Session on the
 *     profile's own default preset, so "one mode remains AND it still carries
 *     both extension tools" is one measurement rather than two claims.
 */
import { writeFileSync } from 'node:fs'

export const name = 's1-roster-probe'

// `agentPresets` alone. `inject` is a readiness gate, so naming a service the
// change could plausibly remove would make the probe refuse to run and report
// NOTHING rather than reporting the absence -- which is the failure mode the
// `verify-t4-preset.mjs` header records. The roster service is the subject
// here and must exist for the probe to have anything to say.
export const inject = ['agentPresets']

const OUT = process.env.DSH_PROBE_OUT ?? 'D:/DSH/work/wt-s1/qualification/results/S1-single-mode/s1-roster.json'

/** Every id the pinned checkout ships in its bundled preset root. */
const SHIPPED_IDS = ['standard', 'ptc', 'minimal', 'cordis']

export async function apply(ctx) {
  const finding = {
    profileBooted: true,
    roots: [],
    // Present from the start so the harness's home-assertion guard reads a real
    // value on every exit path, including the early returns below.
    presetRoots: [],
    shippedRootPresent: null,
    listed: [],
    listedIds: [],
    listedCount: null,
    defaultId: null,
    resolveOf: {},
    selectionPolicy: null,
    sessionCreated: false,
    sessionId: null,
    sessionAgentPreset: null,
    toolCountAgentKey: 0,
    tools: [],
    ipythonToolPresent: false,
    workToolPresent: false,
    error: null,
  }
  try {
    const roster = ctx.get('agentPresets')
    if (roster === undefined) {
      finding.error = 'the agentPresets service is absent from this composition'
      writeFileSync(OUT, JSON.stringify(finding, null, 2))
      return
    }

    // (1) The RESOLVED root list. This is the mechanism: the private
    //     `resolvedRoots` field is exposed publicly through the `roots` getter
    //     (agent-presets/src/index.ts:515-517), and it is composed at
    //     :182-184 as [shipped?, ...config.roots, user?].
    finding.roots = (roster.roots ?? []).map(root => ({
      path: String(root.path),
      trust: String(root.trust),
    }))
    // The SAME list under the field name the shared harness guard reads.
    // `readResult` in `boot-harness.mjs` asserts `json.presetRoots` names the
    // home the caller booted, and that guard is the only thing standing between
    // this artifact and a fixed-output-path false PASS. Emitting the field it
    // looks for is what lets the guard do its job instead of being bypassed.
    finding.presetRoots = finding.roots
    // The shipped root lives inside the INSTALLED package. Match on the
    // package's own directory name rather than a hardcoded absolute path, so
    // the measurement does not depend on which install layout is booted.
    finding.shippedRootPresent = finding.roots.some(
      root => /agent-presets[\\/]+presets[\\/]*$/i.test(String(root.path).replace(/\\/g, '/')),
    )

    // (2) The selectable set.
    const listed = await roster.list()
    finding.listed = listed.map(p => ({
      id: p.id,
      trust: p.trust,
      name: p.name ?? null,
      order: p.order ?? null,
      broken: p.broken ?? null,
    }))
    finding.listedIds = listed.map(p => p.id)
    finding.listedCount = listed.length

    // (3) What an unnamed Session would mount.
    finding.defaultId = roster.defaultId ?? null

    // (4) The RESOLUTION path, asked per shipped id. `list()` and `resolve()`
    //     are separate code paths; a change that emptied the roster but left
    //     resolution answering would not be the property we claim.
    for (const id of SHIPPED_IDS) {
      try {
        const resolved = await roster.resolve(id)
        finding.resolveOf[id] = { resolved: true, path: String(resolved?.path ?? null), trust: String(resolved?.trust ?? null) }
      } catch (error) {
        finding.resolveOf[id] = {
          resolved: false,
          error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
        }
      }
    }
    // The positive control: our own preset MUST still resolve, or the probe
    // would report "one mode" for a composition that offers none.
    try {
      const own = await roster.resolve('daily-standard')
      finding.resolveOf['daily-standard'] = { resolved: true, path: String(own?.path ?? null), trust: String(own?.trust ?? null) }
    } catch (error) {
      finding.resolveOf['daily-standard'] = {
        resolved: false,
        error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
      }
    }

    // (5) The selection policy the UI's picker reads, taken from the SAME
    //     remote projection the browser takes. `modeSelectionEnabled` is not a
    //     public getter on the service -- it is composed inside the
    //     `@Remote('list')` projection (`agent-presets/src/index.ts:285-305`),
    //     which is what `readRoster` in the client calls
    //     (`ui-agent-preset/src/client/settings-store.ts:83`). Reading the
    //     projection rather than the private field is what makes this the
    //     product's own answer.
    const projected = await roster.remoteExportList()
    finding.selectionPolicy = {
      modeSelectionEnabled: projected.modeSelectionEnabled,
      authorable: projected.authorable,
      isDefaultId: projected.presets.find(p => p.isDefault)?.id ?? null,
      projectedIds: projected.presets.map(p => p.id),
    }
    finding.projectedPresets = projected.presets.map(p => ({
      id: p.id, trust: p.trust, isDefault: p.isDefault, name: p.name ?? null, broken: p.broken ?? null,
    }))

    // (6) A REAL Session on the profile's own default preset, and its catalog.
    //     This is the "and it still works" half: one mode, both tools.
    const sc = ctx.get('sessionController')
    if (sc === undefined) {
      finding.error = 'sessionController is absent, so the tool face could not be measured'
      writeFileSync(OUT, JSON.stringify(finding, null, 2))
      return
    }
    const created = await sc.create({ cwd: process.cwd() })
    finding.sessionId = created?.sessionId ?? created?.id ?? null
    finding.sessionCreated = finding.sessionId !== null
    finding.sessionAgentPreset = created?.agentPreset ?? null

    const agent = ctx.get('agents')?.get(finding.sessionId)
    if (agent === undefined) {
      finding.error = 'the created session has no live agent in this process'
    } else {
      const tools = ctx.get('tools')
      const names = tools.schemas(agent).map(s => s.name).sort()
      finding.toolCountAgentKey = names.length
      finding.tools = names
      finding.ipythonToolPresent = names.includes('ipython')
      finding.workToolPresent = names.includes('work')
    }
  } catch (error) {
    finding.error = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
  }
  writeFileSync(OUT, JSON.stringify(finding, null, 2))
}
