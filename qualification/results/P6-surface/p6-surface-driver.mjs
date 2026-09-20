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
 */
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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

/** Boot one home and return `{ boot, probe, probeError }`. */
async function bootHome({ label, home, outPath }) {
  const overlay = materialiseOverlay(
    OVERLAY_TEMPLATE, `${RESULT_DIR}/${label}.overlay.patch.yml`, PROBE,
  )
  const before = digestArtifacts()
  const boot = await bootAndWait({
    home,
    profile: PROFILE,
    patches: [overlay],
    outPath,
    cwd: FOREIGN_CWD,
    // A creation call in the BEFORE boot reaches a provider with no model
    // route; the harness kills the host either way, and the probe flushes its
    // catalog BEFORE the bridge arm, so a slow arm cannot cost the deliverable.
    timeoutMs: 180_000,
  })
  const after = digestArtifacts()
  let probe = null
  let probeError = null
  try {
    probe = readResult(outPath, home).json
  } catch (error) {
    probeError = error instanceof Error ? error.message : String(error)
  }
  return {
    boot,
    probe,
    probeError,
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

// ONE BOOT AT A TIME. Strictly serial.
const before = await bootHome({ label: 'before', home: BEFORE_HOME, outPath: OUT_BEFORE })
const after = await bootHome({ label: 'after', home: AFTER_HOME, outPath: OUT_AFTER })

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
    executed: row.executed, errorCode: row.errorCode, errorName: row.errorName, message: row.message,
  }]),
)
const beforeRefusals = refusalsBy(before.probe)
const afterRefusals = refusalsBy(after.probe)

/** The rows the Loader reported as enabled, keyed by entry id. */
const rowsBy = probe => Object.fromEntries((probe?.rowEnablement ?? []).map(row => [row.entryId, row.enabled]))
const beforeRows = rowsBy(before.probe)
const afterRows = rowsBy(after.probe)

const assertions = {
  // The measurement itself must have happened on both sides.
  bothBootsProducedACatalog:
    (before.probe?.toolCountAgentKey ?? 0) > 0 && (after.probe?.toolCountAgentKey ?? 0) > 0,
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
  allCreationRoutesRefusedAfter: Object.values(afterRefusals).every(row => row.executed === false),
  // ...and the refusal is the REGISTRY's, not a tool body's own failure.
  refusalsAreUnknownTool: Object.values(afterRefusals).every(row => row.errorCode === 'UNKNOWN_TOOL'),
  // THE POSITIVE CONTROL. In the before boot the SAME calls must NOT all be
  // refusals, or the after refusals carry no information.
  positiveControlSomeRouteReachedTheRegistryBefore:
    Object.values(beforeRefusals).some(row => row.errorCode !== 'UNKNOWN_TOOL'),
  // The row table agrees with the catalog, so "disabled in the file" and
  // "absent from the mounted composition" are two facts and not one.
  disabledRowsReportedDisabledAfter: DISABLED_TOOLS
    .map(name => ({ subagent: 'tool-subagent', subagent_fork: 'tool-subagent-fork', workflow: 'tool-workflow' }[name]))
    .every(id => afterRows[id] === false),
  disabledRowsWereEnabledBefore: ['tool-subagent', 'tool-subagent-fork', 'tool-workflow']
    .every(id => beforeRows[id] === true),
  // No row appeared that nobody asked for.
  noUnexpectedToolsAdded: diff.added.length === 0,
  // The preset did not die: the measured FACT F failure was toolCount 0.
  presetSurvivedTheDisable: (after.probe?.toolCountAgentKey ?? 0) > 0,
  // Neither boot's executed bytes moved underneath it.
  buildsStableDuringBothBoots:
    before.buildIdentity.changedDuringBoot.length === 0 && after.buildIdentity.changedDuringBoot.length === 0,
  // The hidden arm: Python could not reach a creation route either.
  bridgeArmDidNotExecute: after.probe?.bridgeArm?.anyExecuted === false
    || after.probe?.bridgeArm?.available === false,
}

const failed = Object.entries(assertions).filter(([, ok]) => ok !== true).map(([name]) => name)

const report = {
  driver: 'p6-surface-driver',
  slice: 'P6 — the model-facing child-creation surface, before and after',
  ranAt: new Date().toISOString(),
  homes: { before: homes.before, after: homes.after, canonical: CANONICAL_HOME },
  cwd: FOREIGN_CWD,
  boots: {
    before: {
      port: before.boot.port, portReleased: before.boot.portReleased, exitCode: before.boot.exitCode,
      timedOut: before.boot.timedOut, probeError: before.probeError,
      activationWarnings: before.boot.stderr.split('\n').filter(l => /did not activate|startup failed/i.test(l)),
      buildIdentity: before.buildIdentity,
    },
    after: {
      port: after.boot.port, portReleased: after.boot.portReleased, exitCode: after.boot.exitCode,
      timedOut: after.boot.timedOut, probeError: after.probeError,
      activationWarnings: after.boot.stderr.split('\n').filter(l => /did not activate|startup failed/i.test(l)),
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
  assertions,
  failedAssertions: failed,
  verdict: failed.length === 0 ? 'PASS' : 'FAIL',
}

writeFileSync(`${RESULT_DIR}/driver.json`, JSON.stringify(report, null, 2))
process.stdout.write(`P6-SURFACE-DRIVER: ${JSON.stringify({
  verdict: report.verdict,
  failed,
  diff,
  afterCount: diff.afterCount,
  beforeCount: diff.beforeCount,
  afterAnyExecuted: report.negativeArm.afterAnyExecuted,
  beforeAnyExecuted: report.negativeArm.beforeAnyExecuted,
  bridgeArm: { available: after.probe?.bridgeArm?.available ?? null, anyExecuted: after.probe?.bridgeArm?.anyExecuted ?? null },
  probeErrors: { before: before.probeError, after: after.probeError },
})}\n`)

process.exit(failed.length === 0 ? 0 : 1)
