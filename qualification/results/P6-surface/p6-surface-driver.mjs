/**
 * P6 driver: capture the model tool catalog BEFORE and AFTER the preset change,
 * then diff the two name SETS and judge V5 §18's WORK-NO-BYPASS.
 *
 * WHY A DRIVER AND NOT JUST A PROBE. The probe (`p6-surface-probe.mjs`) runs
 * INSIDE the host's Cordis context and can only see one composition. The
 * question V5 §8/§18 asks is a DIFFERENCE between two compositions: which
 * model-facing child-creation tools the preset offered before the change and
 * which it offers after. That difference is only visible from outside, from a
 * caller that owns both boots.
 *
 * THE TWO HOMES, AND WHY TWO RATHER THAN ONE. A `daily` boot reads the preset
 * from ITS OWN profile directory, not from this repository
 * (`packages/preset/agent-presets/src/discovery.ts:285` resolves a root's path
 * against the process cwd, and the profile's `agent-presets` row derives the
 * root from `ctx.baseUrl`, which is the profile directory). So the change under
 * test cannot be observed by editing the repository alone -- it has to be
 * INSTALLED into a home. Two sibling homes are built here, and the ONLY
 * difference between them is the two commits under test:
 *
 *   <BEFORE_HOME>  the parent commit's profile: the archived pre-change preset
 *                  and `maxActiveSubagents: 10`.
 *   <AFTER_HOME>   the same skeleton with THIS worktree's preset and profile
 *                  patch.
 *
 * WHY NOT THE PROVISIONED HOME ITSELF. `D:/DSH/home/p6` is left alone on
 * purpose. A driver that mutated the caller's own home would leave it in a
 * state a later reader could not attribute -- and this project has already
 * retracted findings that rested on a tree another agent had moved
 * (G-SEAM-29/G-SEAM-36). The scratch homes are named in the artifact, so the
 * attribution is explicit.
 *
 * THE POSITIVE CONTROL, WHICH IS THE POINT OF THE BEFORE BOOT. A negative arm
 * that only ever sees refusals proves nothing: the refusal could come from a
 * malformed argument, a missing service, or a probe bug, and it would look
 * identical. The BEFORE boot runs the SAME probe code against the SAME
 * arguments on a composition where the routes are known to be live. If BEFORE
 * shows refusals too, the AFTER refusals are not evidence and this driver says
 * so in `verdict`.
 *
 * ONE BOOT AT A TIME. The boots are strictly serial (`await`), because boots are
 * CPU-heavy and many writers share this machine. The port comes from
 * `boot-harness.mjs`, which binds port 0 to get a genuinely free port rather
 * than guessing one -- a guess produced an `EADDRINUSE` false positive twice in
 * this project.
 *
 * THE OUTPUT PATHS ARE THE CALLER'S OWN. Each boot writes to a path under
 * `qualification/results/P6-surface/`, and `readResult()` asserts the artifact
 * names the home that was booted, so an artifact another agent overwrote throws
 * instead of being reported as ours (G-FIX-13).
 *
 * Usage: node qualification/results/P6-surface/p6-surface-driver.mjs
 *        node qualification/results/P6-surface/p6-surface-driver.mjs --build-only
 *
 * `--build-only` constructs both homes, prints their layout, and exits without
 * booting. It exists because a boot costs minutes and CPU this machine shares
 * with many writers, and a home that is subtly wrong fails as a COMPOSITION
 * error rather than as a path error -- the same shape as the `EADDRINUSE` false
 * positive. Checking the two homes before spending two boots is the cheap half
 * of the measurement.
 */
import { cpSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { bootAndWait, readResult } from '../../runners/boot-harness.mjs'
import { materialiseOverlay } from '../../runners/overlay.mjs'

/** The repository root of the tree THIS FILE was loaded from. */
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..').replace(/\\/g, '/')

const RESULT_DIR = `${REPO_ROOT}/qualification/results/P6-surface`
const PROBE = `${RESULT_DIR}/p6-surface-probe.mjs`
const OVERLAY_TEMPLATE = `${RESULT_DIR}/p6-surface.patch.yml`

/** The home the probe booted from, whose profile is the SOURCE of the skeleton. */
const CANONICAL_HOME = 'D:/DSH/home/p6'
const BEFORE_HOME = 'D:/DSH/home/p6-surface-before'
const AFTER_HOME = 'D:/DSH/home/p6-surface-after'

const PROFILE = 'daily'

/** A cwd that is neither the repository nor any profile directory. */
const FOREIGN_CWD = 'C:/Windows/Temp'

/**
 * The built artifacts this boot will actually EXECUTE.
 *
 * WHY THIS LIST EXISTS. The profile installs `dsh-ipython` and `dsh-daily-work`
 * through a `link:` into this repo, so a booted profile runs their BUILT `lib/`,
 * never their `src/`. That has already produced three stale-artifact false
 * findings in this project (the most recent being G-SEAM-29, a stale
 * `lib/kernel-plugin.js` reported as a product defect). Hashing them on both
 * sides of the boot is what lets this result claim it measured the build it
 * names -- and the preset row it is about is executed through
 * `dsh-daily-work`'s host plugin, so a rebuild mid-boot would make the numbers
 * describe a build that no longer exists.
 */
const TRACKED_ARTIFACTS = [
  'packages/dsh-daily-work/lib/host-plugin.js',
  'packages/dsh-daily-work/lib/capacity.js',
  'packages/dsh-daily-work/lib/tools.js',
  'packages/dsh-ipython/lib/kernel-plugin.js',
  'packages/dsh-ipython/lib/host-plugin.js',
]

/** @returns a map of artifact path to its SHA-256, or null where unreadable. */
function digestArtifacts() {
  const out = {}
  for (const rel of TRACKED_ARTIFACTS) {
    try {
      out[rel] = createHash('sha256').update(readFileSync(`${REPO_ROOT}/${rel}`)).digest('hex')
    } catch {
      out[rel] = null
    }
  }
  return out
}

/**
 * Build one scratch home whose ONLY content is the profile skeleton, with the
 * two `link:` dependencies re-created as junctions into THIS tree.
 *
 * WHY JUNCTIONS RATHER THAN A COPY. `cp -a` on this machine DEREFERENCES the
 * pnpm symlinks, so a copied home would execute a private 7 MB copy of the
 * packages rather than the tree under test -- the stale-artifact trap again, in
 * a new place. Junctions keep the boot reading the same bytes the repository
 * holds, and they are removed with the home.
 *
 * @param home - absolute home path to (re)create.
 * @param presetSource - absolute path of the `agent.cordis.yml` to install.
 * @param patchSource - absolute path of the `cordis.patch.yml` to install.
 */
function buildHome(home, presetSource, patchSource) {
  rmSync(home, { recursive: true, force: true })
  const profileDir = `${home}/profiles/${PROFILE}`
  const source = `${CANONICAL_HOME}/profiles/${PROFILE}`
  mkdirSync(profileDir, { recursive: true })

  // The profile's own files, minus `node_modules` (rebuilt as junctions) and
  // minus `presets` (installed from the named source below).
  for (const name of ['package.json', 'cordis.yml', 'pnpm-lock.yaml']) {
    cpSync(`${source}/${name}`, `${profileDir}/${name}`)
  }
  mkdirSync(`${profileDir}/node_modules`, { recursive: true })
  for (const name of ['.package-map.json', '.pnpm-workspace-state-v1.json']) {
    cpSync(`${source}/node_modules/${name}`, `${profileDir}/node_modules/${name}`)
  }
  cpSync(`${source}/node_modules/.pnpm`, `${profileDir}/node_modules/.pnpm`, { recursive: true })

  // The two `link:` dependencies, as junctions into THIS worktree. `cmd /c
  // mklink /J` is used rather than `symlinkSync` because a directory symlink on
  // Windows needs elevation while a junction does not.
  for (const pkg of ['dsh-daily-work', 'dsh-ipython']) {
    const target = `${REPO_ROOT}/packages/${pkg}`.replace(/\//g, '\\')
    const link = `${profileDir}/node_modules/${pkg}`.replace(/\//g, '\\')
    execFileSync('cmd', ['/c', 'mklink', '/J', link, target], { stdio: 'ignore' })
  }

  mkdirSync(`${profileDir}/presets/daily-standard`, { recursive: true })
  cpSync(presetSource, `${profileDir}/presets/daily-standard/agent.cordis.yml`)
  cpSync(`${CANONICAL_HOME}/profiles/${PROFILE}/presets/daily-standard/preset.yml`,
    `${profileDir}/presets/daily-standard/preset.yml`)
  cpSync(patchSource, `${profileDir}/cordis.patch.yml`)
  return profileDir
}

/** Boot one home and return `{ boot, probe, probeError, artifactUsed }`. */
async function bootHome({ label, home, outPath }) {
  const overlay = materialiseOverlay(
    OVERLAY_TEMPLATE, `${RESULT_DIR}/${label}.overlay.patch.yml`, PROBE,
  )
  const partialPath = `${outPath}.partial`
  rmSync(partialPath, { force: true })
  const before = digestArtifacts()
  const boot = await bootAndWait({
    home,
    profile: PROFILE,
    patches: [overlay],
    outPath,
    cwd: FOREIGN_CWD,
    // A creation call in the BEFORE boot reaches a provider with no model
    // route; the probe bounds each such call and writes the partial artifact
    // after each one, so a slow arm costs the arm and not the catalog.
    timeoutMs: 240_000,
    env: { DSH_PROBE_PARTIAL_OUT: partialPath },
  })
  const after = digestArtifacts()
  let probe = null
  let probeError = null
  let artifactUsed = null
  try {
    probe = readResult(outPath, home).json
    artifactUsed = outPath
  } catch (error) {
    probeError = error instanceof Error ? error.message : String(error)
    // THE PARTIAL FALLBACK. The main file is the harness's completion signal,
    // so its absence means the probe did not finish -- and the partial file
    // then holds everything up to the step that hung. A partial result is
    // reported as PARTIAL by the driver rather than as a completed one; the
    // catalog in it is still the measurement.
    try {
      probe = readResult(partialPath, home).json
      artifactUsed = partialPath
    } catch (partialError) {
      probeError += `\n  partial: ${partialError instanceof Error ? partialError.message : String(partialError)}`
    }
  }
  return {
    boot,
    probe,
    probeError,
    artifactUsed,
    partial: artifactUsed === partialPath,
    buildIdentity: {
      artifacts: after,
      changedDuringBoot: TRACKED_ARTIFACTS.filter(rel => before[rel] !== after[rel]),
    },
  }
}

/**
 * The diff, computed as SET operations over the two catalogs.
 *
 * DELIBERATELY NOT A COUNT. A previous writer in this project reported "27
 * tools" and the count alone was uncheckable -- a reader could not tell which
 * tools. The deliverable is the name SET, and the diff names each member.
 */
function catalogDiff(before, after) {
  const b = new Set(before ?? [])
  const a = new Set(after ?? [])
  return {
    beforeCount: b.size,
    afterCount: a.size,
    // Present before, absent after: the four creation rows must ALL be here.
    removed: [...b].filter(name => !a.has(name)).sort(),
    // Absent before, present after: expected EMPTY. A non-empty list is a
    // change nobody asked for.
    added: [...a].filter(name => !b.has(name)).sort(),
    kept: [...a].filter(name => b.has(name)).sort(),
  }
}

mkdirSync(RESULT_DIR, { recursive: true })

// The two sources. BEFORE is the ARCHIVED pre-change preset -- the artifact the
// previous commit wrote for exactly this purpose, so the "before" is a
// committed file rather than a reconstructed one. AFTER is the live worktree.
const BEFORE_PRESET = `${RESULT_DIR}/preset-before/agent.cordis.yml`
const AFTER_PRESET = `${REPO_ROOT}/profiles/daily-candidate/presets/daily-standard/agent.cordis.yml`
const BEFORE_PATCH = execFileSync('git', ['show', '2e1b2c2:profiles/daily-candidate/cordis.patch.yml'],
  { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 })
writeFileSync(`${RESULT_DIR}/profile-before.cordis.patch.yml`, BEFORE_PATCH)
const AFTER_PATCH = `${REPO_ROOT}/profiles/daily-candidate/cordis.patch.yml`

const homes = {
  before: buildHome(BEFORE_HOME, BEFORE_PRESET, `${RESULT_DIR}/profile-before.cordis.patch.yml`),
  after: buildHome(AFTER_HOME, AFTER_PRESET, AFTER_PATCH),
}

const OUT_BEFORE = `${RESULT_DIR}/catalog-before.json`
const OUT_AFTER = `${RESULT_DIR}/catalog-after.json`

/**
 * `--replay`: re-judge the artifacts already on disk instead of booting again.
 *
 * WHY THIS EXISTS. The judgment (the diff and the assertions) is separable from
 * the observation (the two boots), and the observation is the expensive half:
 * two boots cost minutes of a CPU many writers share. A defect in the JUDGMENT
 * therefore must not cost two more boots — which is exactly what happened here,
 * where a row-id lookup keyed the bare id while the Loader reports
 * `include:agent-presets:tool-subagent`.
 *
 * IT READS ONLY FILES THIS DRIVER WROTE, and it re-derives the diff from the
 * artifacts rather than from anything in memory, so a replay cannot report a
 * result the recorded observations do not support. The report it writes says
 * `mode: 'replay'` so a reader can tell a re-judgment from a fresh measurement.
 */
const REPLAY = process.argv.includes('--replay')

/**
 * `--boot=before` / `--boot=after`: re-run ONE side and read the other from
 * disk.
 *
 * WHY. A change to the PROBE invalidates the artifact that side produced, but
 * not the other side's. Re-booting both would be the reflex and it would spend a
 * boot on a side whose composition did not change. This flag makes the economy
 * explicit, and the report records which side was booted so a reader is not left
 * guessing whether the two artifacts came from the same run.
 *
 * The loaded side goes through `loadRecorded`, so the same attribution guard
 * (`readResult`) applies to it as to a replay.
 */
const BOOT_ONLY = (process.argv.find(arg => arg.startsWith('--boot=')) ?? '').slice('--boot='.length) || null
if (BOOT_ONLY !== null && !['before', 'after'].includes(BOOT_ONLY)) {
  throw new Error(`--boot= must name 'before' or 'after', not ${JSON.stringify(BOOT_ONLY)}`)
}

// `--build-only`: construct both homes and stop, so the cheap half of the
// measurement can be checked before the expensive half is paid for.
if (process.argv.includes('--build-only')) {
  const listing = dir => readdirSync(dir, { withFileTypes: true })
    .map(entry => `${entry.isSymbolicLink() ? 'link ' : entry.isDirectory() ? 'dir  ' : 'file '}${entry.name}`)
  const report = {
    mode: 'build-only',
    homes,
    before: {
      profile: listing(homes.before),
      nodeModules: listing(`${homes.before}/node_modules`),
      presets: listing(`${homes.before}/presets/daily-standard`),
      // The junction targets, read back: a junction into the WRONG tree is the
      // stale-artifact trap, and it fails silently.
      junctions: Object.fromEntries(['dsh-daily-work', 'dsh-ipython'].map(pkg => [
        pkg, realpathSync(`${homes.before}/node_modules/${pkg}`).replace(/\\/g, '/'),
      ])),
    },
    after: {
      profile: listing(homes.after),
      nodeModules: listing(`${homes.after}/node_modules`),
      presets: listing(`${homes.after}/presets/daily-standard`),
      junctions: Object.fromEntries(['dsh-daily-work', 'dsh-ipython'].map(pkg => [
        pkg, realpathSync(`${homes.after}/node_modules/${pkg}`).replace(/\\/g, '/'),
      ])),
    },
    // THE DIFFERENCE THAT MUST BE THE ONLY ONE. The two homes exist to isolate
    // the two commits; anything else that differs between them is a confound.
    presetDiffers: readFileSync(`${homes.before}/presets/daily-standard/agent.cordis.yml`, 'utf8')
      !== readFileSync(`${homes.after}/presets/daily-standard/agent.cordis.yml`, 'utf8'),
    patchDiffers: readFileSync(`${homes.before}/cordis.patch.yml`, 'utf8')
      !== readFileSync(`${homes.after}/cordis.patch.yml`, 'utf8'),
    packageJsonSame: readFileSync(`${homes.before}/package.json`, 'utf8')
      === readFileSync(`${homes.after}/package.json`, 'utf8'),
    presetYmlSame: readFileSync(`${homes.before}/presets/daily-standard/preset.yml`, 'utf8')
      === readFileSync(`${homes.after}/presets/daily-standard/preset.yml`, 'utf8'),
  }
  writeFileSync(`${RESULT_DIR}/homes.json`, JSON.stringify(report, null, 2))
  process.stdout.write(`P6-SURFACE-BUILD-ONLY: ${JSON.stringify(report)}\n`)
  process.exit(0)
}

// ONE BOOT AT A TIME. Strictly serial.
//
// In replay mode the observations come from the artifacts already on disk and
// NO boot is run. `readResult` still guards each read, so a replay cannot pick
// up another home's file.
function loadRecorded(outPath, home, label) {
  const partialPath = `${outPath}.partial`
  const read = candidate => readResult(candidate, home).json
  const attempts = [outPath, partialPath].map(candidate => {
    try {
      return { candidate, probe: read(candidate), error: null }
    } catch (error) {
      return { candidate, probe: null, error: error instanceof Error ? error.message : String(error) }
    }
  })
  const used = attempts.find(attempt => attempt.probe !== null)
  return {
    // THE SAME SHAPE AS A BOOTED SIDE, with `booted: false`. A block whose keys
    // change with the mode forces every reader to special-case it, and the
    // first version of this file did exactly that -- the report's `boots` object
    // threw on a missing `timedOut` for a loaded side. A uniform shape with an
    // explicit `booted` flag is the honest form: the fields are absent as
    // VALUES, not as KEYS.
    boot: { booted: false, label, port: null, portReleased: null, exitCode: null, timedOut: null, stderr: null },
    probe: used?.probe ?? null,
    probeError: used === undefined ? attempts.map(a => a.error).join('\n  ') : null,
    artifactUsed: used?.candidate ?? null,
    partial: used?.candidate === partialPath,
    buildIdentity: { artifacts: null, changedDuringBoot: null },
  }
}

const bootBefore = !REPLAY && (BOOT_ONLY === null || BOOT_ONLY === 'before')
const bootAfter = !REPLAY && (BOOT_ONLY === null || BOOT_ONLY === 'after')

const before = bootBefore
  ? await bootHome({ label: 'before', home: BEFORE_HOME, outPath: OUT_BEFORE })
  : loadRecorded(OUT_BEFORE, BEFORE_HOME, 'before')
const after = bootAfter
  ? await bootHome({ label: 'after', home: AFTER_HOME, outPath: OUT_AFTER })
  : loadRecorded(OUT_AFTER, AFTER_HOME, 'after')

const diff = catalogDiff(before.probe?.tools, after.probe?.tools)

/**
 * The four rows V5 §8 disables, and the two it keeps.
 *
 * Written out here rather than derived from the preset, for the same reason the
 * probe's CREATION_ROUTES are: an oracle read out of the file under test could
 * not fail.
 */
const DISABLED_TOOLS = ['subagent', 'subagent_fork', 'workflow']
const KEPT_TOOLS = ['send_message', 'interrupt_agent', 'list_agents', 'work']

const refusalsBy = probe => Object.fromEntries(
  (probe?.unknownToolRefusals ?? []).map(row => [row.tool, {
    executed: row.executed, errorCode: row.errorCode, errorName: row.errorName,
    message: row.message, settled: row.settled, dispatchedButUnsettled: row.dispatchedButUnsettled,
  }]),
)
const beforeRefusals = refusalsBy(before.probe)
const afterRefusals = refusalsBy(after.probe)

/** The rows the Loader reported as enabled, keyed by entry id. */
const rowsBy = probe => Object.fromEntries((probe?.rowEnablement ?? []).map(row => [row.entryId, row.enabled]))
const beforeRows = rowsBy(before.probe)
const afterRows = rowsBy(after.probe)

/**
 * Look one row up in the Loader's entry table by its SHORT id.
 *
 * THE IDS ARE NAMESPACED, and this is measured rather than assumed. The preset
 * is mounted through an `include:` row, so the entry ids the Loader reports are
 * `include:agent-presets:tool-subagent` — not `tool-subagent`. A first version
 * of this driver looked up the bare id, found nothing, and reported two
 * assertions as failures whose underlying values were correct. The match below
 * accepts the exact id or any id ending in `:` + the short id, so it survives a
 * different include prefix without silently matching a substring.
 */
function rowEnabled(rows, shortId) {
  const key = Object.keys(rows).find(id => id === shortId || id.endsWith(`:${shortId}`))
  return key === undefined ? undefined : rows[key]
}

const assertions = {
  // The measurement itself must have happened on both sides.
  bothBootsProducedACatalog:
    (before.probe?.toolCountAgentKey ?? 0) > 0 && (after.probe?.toolCountAgentKey ?? 0) > 0,
  // BOTH ARTIFACTS ARE COMPLETE, not partial fallbacks. A partial AFTER
  // artifact would still hold the catalog, but it would mean the negative arm
  // was cut short -- and this assertion exists so that state cannot pass as a
  // finished measurement.
  bothArtifactsAreComplete: before.partial === false && after.partial === false,
  // The agent-keyed read is the right one: the unscoped control differs.
  agentKeyIsTheScopeKey:
    before.probe?.toolCountContextKey !== before.probe?.toolCountAgentKey,
  // The four creation tools are GONE from the after catalog.
  fourCreationRoutesAbsentAfter: DISABLED_TOOLS.every(name => !after.probe?.tools?.includes(name)),
  // ...and WERE PRESENT before. Without this the absence above is not a change.
  creationRoutesWerePresentBefore: DISABLED_TOOLS.every(name => before.probe?.tools?.includes(name)),
  // The management surface SURVIVES, and is usable (it carries arguments).
  managementSurfaceKept: KEPT_TOOLS.every(name =>
    after.probe?.managementSurface?.[name]?.visibleToModel === true),
  managementSurfaceUsable: KEPT_TOOLS.every(name =>
    (after.probe?.managementSurface?.[name]?.parameters ?? []).length > 0),
  // THE NEGATIVE ARM. Every creation route is refused in the after boot...
  //
  // The conjunction is deliberate: `settled === true` excludes a route that
  // reached DISPATCH and then hit the probe's own bound, which is the opposite
  // of the claim. A `dispatchedButUnsettled` route makes this assertion FAIL
  // rather than pass quietly.
  allCreationRoutesRefusedAfter: Object.values(afterRefusals).every(row =>
    row.settled === true && row.executed === false),
  // ...and the refusal is the REGISTRY's, not a tool body's own failure.
  refusalsAreUnknownTool: Object.values(afterRefusals).every(row => row.errorCode === 'UNKNOWN_TOOL'),
  // THE POSITIVE CONTROL. In the before boot the SAME calls must NOT all be
  // refusals, or the after refusals carry no information. A route that reached
  // dispatch and did not settle counts too: reaching dispatch IS the route
  // being live, which is exactly what the control asserts.
  positiveControlSomeRouteReachedTheRegistryBefore: Object.values(beforeRefusals).some(row =>
    row.errorCode !== 'UNKNOWN_TOOL'),
  // The row table agrees with the catalog, so "disabled in the file" and
  // "absent from the mounted composition" are two facts and not one.
  //
  // `undefined` must FAIL, not pass: a lookup that finds no row is a driver bug,
  // and the first version of this file read it as a pass. Each comparison is
  // therefore explicit against true/false.
  disabledRowsReportedDisabledAfter: ['tool-subagent', 'tool-subagent-fork', 'workflow-ptc', 'tool-workflow']
    .every(id => rowEnabled(afterRows, id) === false),
  disabledRowsWereEnabledBefore: ['tool-subagent', 'tool-subagent-fork', 'workflow-ptc', 'tool-workflow']
    .every(id => rowEnabled(beforeRows, id) === true),
  // The two rows V5 §8 KEEPS must stay enabled on BOTH sides: a change that
  // took the management surface down with the creation rows would be a
  // different regression, and it would not show in the catalog diff if the
  // tools were re-registered from elsewhere.
  keptRowsStayEnabled: ['tool-subagent-control', 'tool-subagent-list-agents']
    .every(id => rowEnabled(beforeRows, id) === true && rowEnabled(afterRows, id) === true),
  // No row appeared that nobody asked for.
  noUnexpectedToolsAdded: diff.added.length === 0,
  // The preset did not die: the measured FACT F failure was toolCount 0.
  presetSurvivedTheDisable: (after.probe?.toolCountAgentKey ?? 0) > 0,
  // Neither boot's executed bytes moved underneath it.
  //
  // NULL WHEN EITHER SIDE WAS NOT BOOTED IN THIS RUN, and it must be: a side
  // read back from disk has no before/after digests, so the fact was not
  // observed this run. Recording it as `true` would be a free pass for a fact
  // nobody measured -- the vacuous-truth trap. `null` is reported as NOT_RUN.
  buildsStableDuringBothBoots: bootBefore && bootAfter
    ? (before.buildIdentity.changedDuringBoot ?? []).length === 0
      && (after.buildIdentity.changedDuringBoot ?? []).length === 0
    : null,
  // The hidden arm: Python could not reach a creation route either.
  bridgeArmDidNotExecute: after.probe?.bridgeArm?.anyExecuted === false
    || after.probe?.bridgeArm?.available === false,

  // THE CATALOG IS THE WHOLE SURFACE, because the deployment is in NATIVE mode.
  //
  // WHY THIS IS AN ASSERTION AND NOT A FOOTNOTE. Under `tools` mode `ptc`, the
  // registry presents ONLY `run_code` and collapses the executor to match
  // (packages/core/tools/src/index.ts:653-668, `collapses()` at :1330-1332). The
  // model would then reach every tool through `run_code`'s SDK sub-dispatch --
  // INCLUDING a creation tool whose row was still live, which the catalog would
  // not name. So the catalog is only the model's full surface if `run_code` is
  // absent, and that is measured rather than assumed: neither boot's catalog
  // contains it, and no `tools` row in the profile patch sets a mode.
  //
  // If a future change flips the deployment to PTC, THIS ASSERTION FAILS, which
  // is the correct outcome: the catalog diff would no longer be sufficient
  // evidence and the measurement would have to be re-taken through run_code.
  deploymentIsNativeMode: !(after.probe?.tools ?? []).includes('run_code')
    && !(before.probe?.tools ?? []).includes('run_code'),

  // THE HONEST BOUNDARY, ASSERTED SO IT CANNOT BE MISREAD.
  //
  // These are the OPPOSITE direction from the assertions above: they must be
  // TRUE, because the change does NOT remove the capability. An assertion that
  // the seam were gone would be a claim this slice cannot support and must not
  // make -- and if the seam ever DID disappear, that would be a different,
  // larger change than the one under test, and a reader deserves to be told.
  //
  // A null/undefined here FAILS: it means the arm did not run, so the boundary
  // was not measured. NOT_RUN is not PASS.
  substrateSeamStillPresent: after.probe?.substrateSeam?.servicePresent === true,
  substrateSeamStillCallable:
    after.probe?.substrateSeam?.startContinuableIsCallable === true
    && after.probe?.substrateSeam?.startIsCallable === true,
  // A seam with no provider would be present in signature and absent in fact,
  // so the registry is part of the claim rather than a detail.
  substrateSeamHasProviders: (after.probe?.substrateSeam?.registeredProviders ?? []).length > 0,
  // AND THE CHANGE DID NOT TOUCH THE SEAM. Present on BOTH sides means the
  // difference between them is exactly the model-facing rows and nothing
  // underneath -- which is the precise form of "this removes the surface, not
  // the capability". Comparing the two provider lists makes it checkable rather
  // than a sentence.
  substrateSeamUnchangedByTheDisable:
    (before.probe?.substrateSeam?.servicePresent ?? null) === (after.probe?.substrateSeam?.servicePresent ?? null)
    && JSON.stringify(before.probe?.substrateSeam?.registeredProviders ?? null)
      === JSON.stringify(after.probe?.substrateSeam?.registeredProviders ?? null)
    && (after.probe?.substrateSeam?.servicePresent ?? null) !== null,
}

/**
 * Three outcomes, not two.
 *
 * `true` passes; `false` fails; `null` means NOT_RUN -- the observation was not
 * made (a replay runs no boot, so it has no digests to compare). Collapsing
 * NOT_RUN into PASS is the vacuous-truth trap, and collapsing it into FAIL would
 * report a replay as a product failure. It is named separately so a reader sees
 * which assertions the run actually exercised.
 */
const failed = Object.entries(assertions).filter(([, ok]) => ok === false).map(([name]) => name)
const notRun = Object.entries(assertions).filter(([, ok]) => ok === null).map(([name]) => name)

const report = {
  driver: 'p6-surface-driver',
  slice: 'P6 — the model-facing child-creation surface, before and after',
  ranAt: new Date().toISOString(),
  // `boot` = two fresh boots produced the observations below.
  // `replay` = the observations were READ BACK from artifacts already on disk
  // and only the judgment was re-run. A reader must be able to tell these apart:
  // a replay says nothing new about the product.
  mode: REPLAY ? 'replay' : BOOT_ONLY === null ? 'boot' : `boot:${BOOT_ONLY}`,
  bootedSides: { before: bootBefore, after: bootAfter },
  homes: { before: homes.before, after: homes.after, canonical: CANONICAL_HOME },
  cwd: FOREIGN_CWD,
  boots: {
    before: {
      port: before.boot.port, portReleased: before.boot.portReleased, exitCode: before.boot.exitCode,
      timedOut: before.boot.timedOut, probeError: before.probeError,
      artifactUsed: before.artifactUsed, partial: before.partial,
      // NULL, not [], when the side was not booted. An empty list would read as
      // "a boot ran and emitted no warnings", which is a stronger claim than
      // "no boot ran" -- the same vacuous-truth trap as the assertion below.
      activationWarnings: before.boot.stderr === null ? null
        : before.boot.stderr.split('\n').filter(l => /did not activate|startup failed/i.test(l)),
      buildIdentity: before.buildIdentity,
    },
    after: {
      port: after.boot.port, portReleased: after.boot.portReleased, exitCode: after.boot.exitCode,
      timedOut: after.boot.timedOut, probeError: after.probeError,
      artifactUsed: after.artifactUsed, partial: after.partial,
      activationWarnings: after.boot.stderr === null ? null
        : after.boot.stderr.split('\n').filter(l => /did not activate|startup failed/i.test(l)),
      buildIdentity: after.buildIdentity,
    },
  },
  // THE DELIVERABLE: the two name sets, verbatim, and their diff.
  catalog: {
    before: before.probe?.tools ?? null,
    after: after.probe?.tools ?? null,
    diff,
  },
  // The catalog the MODEL is offered, and the rows as the LOADER evaluated them.
  rowEnablement: { before: beforeRows, after: afterRows },
  creationRoutes: {
    before: before.probe?.creationRoutes ?? null,
    after: after.probe?.creationRoutes ?? null,
  },
  // THE NEGATIVE ARM, both boots, so the positive control is visible.
  negativeArm: {
    before: beforeRefusals,
    after: afterRefusals,
    beforeAnyExecuted: before.probe?.anyCreationRouteExecuted ?? null,
    afterAnyExecuted: after.probe?.anyCreationRouteExecuted ?? null,
  },
  // THE HIDDEN ARM: the ipython bridge, a second door into the same registry.
  hiddenArm: { after: after.probe?.bridgeArm ?? null, before: before.probe?.bridgeArm ?? null },
  managementSurface: { before: before.probe?.managementSurface ?? null, after: after.probe?.managementSurface ?? null },
  subagentRowConfig: { before: before.probe?.subagentRowConfig ?? null, after: after.probe?.subagentRowConfig ?? null },
  // THE HONEST BOUNDARY, reported beside the catalog it qualifies. A reader who
  // takes only the diff away must not conclude the substrate became
  // unreachable; this field is what says otherwise, from the boot itself.
  substrateSeam: { before: before.probe?.substrateSeam ?? null, after: after.probe?.substrateSeam ?? null },
  assertions,
  failedAssertions: failed,
  notRunAssertions: notRun,
  verdict: failed.length === 0 ? 'PASS' : 'FAIL',
}

writeFileSync(`${RESULT_DIR}/driver.json`, JSON.stringify(report, null, 2))
process.stdout.write(`P6-SURFACE-DRIVER: ${JSON.stringify({
  verdict: report.verdict,
  mode: report.mode,
  failed,
  notRun,
  diff,
  afterCount: diff.afterCount,
  beforeCount: diff.beforeCount,
  afterAnyExecuted: report.negativeArm.afterAnyExecuted,
  beforeAnyExecuted: report.negativeArm.beforeAnyExecuted,
  bridgeArm: { available: after.probe?.bridgeArm?.available ?? null, anyExecuted: after.probe?.bridgeArm?.anyExecuted ?? null },
  probeErrors: { before: before.probeError, after: after.probeError },
})}\n`)

process.exit(failed.length === 0 ? 0 : 1)
