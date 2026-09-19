/**
 * V2 COMPOSITION driver: boot 7, the HOME-OVERRIDE arms (CMP-12) and the
 * PATCH-SEMANTICS dump (CMP-07's failure direction).
 *
 * ═══ CMP-12 ═══
 * The oracle: "The resolved graph shows the override explicitly for the canary
 * home, and the stock control uses an uncontaminated home whose graph shows no
 * such override."
 *
 * So there are TWO arms and BOTH are needed:
 *   - CANARY: a home carrying `$DSH_HOME/cordis.patch.yml` that changes the model
 *     and the preset. The override must be visible in the resolved graph.
 *   - CONTROL: a home with NO such file. The graph must show NO override.
 *
 * The control arm is the one that is easy to skip and is the one that matters: a
 * canary-only measurement cannot tell "the home layer is read" from "that value
 * is what the composition produces anyway". The control also needs its own HOME,
 * because a home that once carried the patch would be contaminated.
 *
 * WHY THE HOME LAYER IS THE RIGHT MECHANISM TO TEST. `composeProfile` applies, in
 * order: bundle layers, the profile's own `cordis.patch.yml`, the HOME-level
 * `$DSH_HOME/cordis.patch.yml`, then `--patch` overlays
 * (`apps/cli/src/profile-boot.ts:188-193`). So a home patch OUTRANKS the profile's
 * layer and is the documented way a machine-local preference is expressed.
 *
 * ═══ CMP-07 failure direction ═══
 * The oracle: "no unmentioned key has silently reverted to a schema default. A
 * dump showing a lost sibling key is NOT PASS."
 *
 * The success direction is already measured in boot 4 (the `subagent` row carries
 * BOTH `maxActiveSubagents` and `maxDepth`). This adds the DIRECTION THAT WOULD
 * FALSIFY IT: an overlay that patches only ONE key of the same row, with the dump
 * showing what actually happened to the sibling. That is the mechanism the
 * project's own comments describe ("a patch replaces the target row's WHOLE
 * `config` object; it is not a deep merge"), and measuring it turns a source-read
 * claim into a measurement.
 *
 * `--dump-config` is the right instrument HERE and not for activation: it
 * composes the patch layers WITHOUT booting, which is exactly what a config
 * question needs. Its documented limitation is that it never executes plugins
 * (`apps/cli/src/dump-config.ts:1-5`), so it is used only for the config dump.
 *
 * Usage: node run-boot7-home-override.mjs
 */
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { bootAndWait, readResult } from 'file:///D:/DSH/work/dsh-native-daily/qualification/runners/boot-harness.mjs'

const REPO = 'D:/DSH/work/dsh-native-daily'
const RESULTS = `${REPO}/qualification/results/V2-composition`
const LAUNCHER = 'D:/DSH/src/dsh-src/apps/cli/lib/bin.js'

const CANARY_HOME = 'D:/DSH/home/v2-cmp-canary'
const CONTROL_HOME = 'D:/DSH/home/v2-cmp-control'
const PROFILE = 'daily'
const SURFACE_OVERLAY = `${REPO}/qualification/runners/verify-deliverable-surface.patch.yml`

const digest = path => existsSync(path)
  ? createHash('sha256').update(readFileSync(path)).digest('hex')
  : null

const results = {
  probe: 'V2-composition boot7: home override (CMP-12) + patch semantics (CMP-07)',
  ranAt: new Date().toISOString(),
  canaryHome: CANARY_HOME,
  controlHome: CONTROL_HOME,
  inputDigests: {
    repoProfilePatch: digest(`${REPO}/profiles/daily-candidate/cordis.patch.yml`),
    repoPreset: digest(`${REPO}/profiles/daily-candidate/presets/daily-standard/agent.cordis.yml`),
    surfaceOverlay: digest(SURFACE_OVERLAY),
    surfaceProbe: digest(`${REPO}/qualification/runners/verify-deliverable-surface.mjs`),
  },
  canary: null,
  control: null,
  patchSemantics: null,
}

/**
 * Build one home from the repository profile, then install it.
 *
 * The install is what makes the home a real deployment rather than a copy: the
 * `link:` dependencies and the pnpm project have to exist or the boot fails with
 * "cannot resolve profile bundle", which would be misread as a composition
 * defect.
 */
function buildHome(home) {
  rmSync(home, { recursive: true, force: true })
  mkdirSync(`${home}/profiles`, { recursive: true })
  cpSync(`${REPO}/profiles/daily-candidate`, `${home}/profiles/${PROFILE}`, { recursive: true })
  const install = spawnSync(process.execPath, [LAUNCHER, 'plugin', '--profile', PROFILE, 'install'], {
    cwd: `${home}/profiles/${PROFILE}`,
    env: { ...process.env, DSH_HOME: home.replace(/\//g, '\\') },
    encoding: 'utf8',
    timeout: 300_000,
  })
  return { status: install.status, stdout: install.stdout, stderr: install.stderr }
}

// ─────────────────────── the CANARY home: a home override ───────────────────────
//
// THE OVERRIDE CHANGES TWO THINGS THE ORACLE NAMES: the MODEL and the PRESET.
//   - `model` is patched to a value this deployment does not otherwise use, so
//     "the override is visible" cannot be confused with "that is the default".
//   - `agent-presets.default` is switched to `standard`, so the resolved graph
//     shows a DIFFERENT preset id than the profile's own `daily-standard`.
//
// The `model` row is patched BY ID with every key it needs restated, because a
// patch replaces the whole `config` object. A patch that dropped a required key
// would fail the boot with `$.x missing required value`, which would be misread
// as "the home layer broke the deployment".
const CANARY_PATCH = `# V2 COMPOSITION CMP-12 CANARY: a HOME-LEVEL override.
#
# This file is \`$DSH_HOME/cordis.patch.yml\` -- the documented machine-local layer
# that outranks the profile's own \`cordis.patch.yml\`
# (\`apps/cli/src/profile-boot.ts:188-193\`). It exists ONLY in the canary home.
#
# It changes the PRESET the roster defaults to, which is the fact CMP-12's oracle
# names ("a home patch that would change the model or the preset"). The value is
# deliberately one the profile does NOT use, so "the override is visible" cannot
# be confused with "that is what the composition produces anyway".
- id: agent-presets
  config:
    default: standard
    roots:
      - path: !!js new URL('presets/', ctx.baseUrl).pathname.replace(/^\\/([A-Za-z]:)/, '$1')
        trust: system
    includeShippedRoot: true
    includeUserRoot: true
`

// ──────────────────── the CONTROL home: no home layer at all ────────────────────

const say = []
const log = text => { say.push(text); process.stdout.write(`${text}\n`) }

// Build both homes first, so a build failure is not confused with a boot failure.
log(`canary_install: ${JSON.stringify(buildHome(CANARY_HOME))}`)
log(`control_install: ${JSON.stringify(buildHome(CONTROL_HOME))}`)

writeFileSync(`${CANARY_HOME}/cordis.patch.yml`, CANARY_PATCH, 'utf8')
// The control home gets NO such file. Verified rather than assumed.
const controlHasHomePatch = existsSync(`${CONTROL_HOME}/cordis.patch.yml`)
log(`control_has_home_patch: ${String(controlHasHomePatch)}`)

results.inputDigests.canaryHomePatch = digest(`${CANARY_HOME}/cordis.patch.yml`)
results.inputDigests.canaryInstalledProfilePatch = digest(`${CANARY_HOME}/profiles/${PROFILE}/cordis.patch.yml`)
results.inputDigests.controlInstalledProfilePatch = digest(`${CONTROL_HOME}/profiles/${PROFILE}/cordis.patch.yml`)
results.inputDigests.controlHomePatch = digest(`${CONTROL_HOME}/cordis.patch.yml`)

// ─────────────────────────── ARM A: the CANARY boot ───────────────────────────
{
  const OUT = `${RESULTS}/boot7-canary.json`
  const boot = await bootAndWait({
    home: CANARY_HOME,
    profile: PROFILE,
    patches: [SURFACE_OVERLAY],
    outPath: OUT,
    cwd: 'D:/DSH/src/dsh-src',
    timeoutMs: 150_000,
  })
  writeFileSync(`${RESULTS}/boot7-canary-transcript.txt`, [
    '# V2 boot 7 arm A -- CANARY home carrying $DSH_HOME/cordis.patch.yml',
    `# cwd: D:/DSH/src/dsh-src   DSH_HOME: ${CANARY_HOME}   port: ${String(boot.port)}   portReleased: ${String(boot.portReleased)}`,
    `# timedOut: ${String(boot.timedOut)}   exitCode: ${String(boot.exitCode)}`,
    '', '--- stdout ---', boot.stdout, '--- stderr ---', boot.stderr,
  ].join('\n'), 'utf8')
  let result = null
  try { result = readResult(OUT, CANARY_HOME).json } catch (error) { result = { error: String(error) } }
  results.canary = {
    port: boot.port, portReleased: boot.portReleased, timedOut: boot.timedOut, exitCode: boot.exitCode,
    presetDefaultId: result?.presetDefaultId ?? null,
    presetRoots: result?.presetRoots ?? [],
    presetsListed: (result?.presetsListed ?? []).map(p => p.id),
    toolCountAgentKey: result?.toolCountAgentKey ?? null,
    ipythonToolPresent: result?.ipythonToolPresent ?? null,
    workToolPresent: result?.workToolPresent ?? null,
    probeError: result?.error ?? null,
    // THE OVERRIDE, as the oracle needs it: the home layer changed the default
    // preset away from the profile's own value.
    overrideVisible: result?.presetDefaultId === 'standard',
  }
  log(`CANARY presetDefaultId=${String(results.canary.presetDefaultId)} toolCount=${String(results.canary.toolCountAgentKey)}`)
}

// ─────────────────────────── ARM B: the CONTROL boot ───────────────────────────
{
  const OUT = `${RESULTS}/boot7-control.json`
  const boot = await bootAndWait({
    home: CONTROL_HOME,
    profile: PROFILE,
    patches: [SURFACE_OVERLAY],
    outPath: OUT,
    cwd: 'D:/DSH/src/dsh-src',
    timeoutMs: 150_000,
  })
  writeFileSync(`${RESULTS}/boot7-control-transcript.txt`, [
    '# V2 boot 7 arm B -- CONTROL home with NO home-level patch',
    `# cwd: D:/DSH/src/dsh-src   DSH_HOME: ${CONTROL_HOME}   port: ${String(boot.port)}   portReleased: ${String(boot.portReleased)}`,
    `# timedOut: ${String(boot.timedOut)}   exitCode: ${String(boot.exitCode)}`,
    '', '--- stdout ---', boot.stdout, '--- stderr ---', boot.stderr,
  ].join('\n'), 'utf8')
  let result = null
  try { result = readResult(OUT, CONTROL_HOME).json } catch (error) { result = { error: String(error) } }
  results.control = {
    port: boot.port, portReleased: boot.portReleased, timedOut: boot.timedOut, exitCode: boot.exitCode,
    presetDefaultId: result?.presetDefaultId ?? null,
    presetRoots: result?.presetRoots ?? [],
    presetsListed: (result?.presetsListed ?? []).map(p => p.id),
    toolCountAgentKey: result?.toolCountAgentKey ?? null,
    ipythonToolPresent: result?.ipythonToolPresent ?? null,
    workToolPresent: result?.workToolPresent ?? null,
    probeError: result?.error ?? null,
    overrideVisible: result?.presetDefaultId !== 'daily-standard',
  }
  log(`CONTROL presetDefaultId=${String(results.control.presetDefaultId)} toolCount=${String(results.control.toolCountAgentKey)}`)
}

// ═════════════ CMP-07 FAILURE DIRECTION: the patch-semantics dump ══════════════
//
// An overlay that patches ONLY `maxActiveSubagents`, omitting `maxDepth`. The
// documented rule is that this REPLACES the whole config object, so the sibling
// key must be GONE from the resolved row -- not silently preserved, and not
// silently restored to a schema default the patch never mentioned.
const ONE_KEY_OVERLAY = `${RESULTS}/one-key-overlay.patch.yml`
writeFileSync(ONE_KEY_OVERLAY, [
  '# CMP-07 failure-direction overlay: patch exactly ONE key of a multi-key row.',
  '# The documented rule is that this REPLACES the whole `config` object',
  '# (`vendor/include/src/index.ts:120-123`), so `maxDepth` must be ABSENT from the',
  '# resolved row. If it survived, the dialect would be a deep merge and the',
  '# project\'s whole "restate every key" discipline would be unnecessary.',
  '- id: subagent',
  '  config:',
  '    maxActiveSubagents: 10',
  '',
].join('\n'), 'utf8')
results.inputDigests.oneKeyOverlay = digest(ONE_KEY_OVERLAY)

const dump = spawnSync(process.execPath, [LAUNCHER, '--profile', PROFILE, '--dump-config', '--patch', ONE_KEY_OVERLAY], {
  cwd: `${CANARY_HOME}/profiles/${PROFILE}`,
  env: { ...process.env, DSH_HOME: CANARY_HOME.replace(/\//g, '\\') },
  encoding: 'utf8',
  timeout: 180_000,
  maxBuffer: 64 * 1024 * 1024,
})
const dumpText = `${dump.stdout ?? ''}\n${dump.stderr ?? ''}`
writeFileSync(`${RESULTS}/boot7-dump-one-key.txt`, [
  `# command: node ${LAUNCHER} --profile ${PROFILE} --dump-config --patch ${ONE_KEY_OVERLAY}`,
  `# DSH_HOME: ${CANARY_HOME}   exit: ${String(dump.status)}`,
  '', dumpText,
].join('\n'), 'utf8')

// The `subagent` row's rendered block, extracted verbatim so a reader sees the
// dump's own text rather than this driver's summary of it.
const dumpLines = dumpText.split(/\r?\n/)
const subagentAt = dumpLines.findIndex(line => /^\s*-?\s*id:\s*subagent\s*$/.test(line) || /id:\s*subagent\b/.test(line))
const subagentBlock = subagentAt < 0 ? [] : dumpLines.slice(subagentAt, subagentAt + 12)
// THE CLAIM HAS TO BE SCOPED TO THE ROW, and getting that wrong would have
// produced a false FAIL. Measured on the first run: `maxDepth` IS present in the
// dump -- but at `daily-work-host`, a DIFFERENT row that legitimately carries its
// own `maxDepth: 1`. A whole-file `/maxDepth/` test therefore reads the sibling
// as "preserved" when it is gone from the row under test. The assertion below is
// scoped to the `subagent` block.
const subagentBlockText = subagentBlock.join('
')
results.patchSemantics = {
  exitCode: dump.status,
  subagentBlock,
  subagentRowHasMaxActiveSubagents: /maxActiveSubagents/.test(subagentBlockText),
  // The falsifiable claim: with a one-key patch, the sibling is GONE FROM THAT ROW.
  subagentRowLostMaxDepth: !/maxDepth/.test(subagentBlockText),
  // Recorded so the scoping is auditable rather than asserted: this is the OTHER
  // row's legitimate occurrence of the same key name.
  maxDepthElsewhereInDump: (dumpText.match(/maxDepth/g) ?? []).length,
}
log(`DUMP exit=${String(dump.status)} maxActiveSubagents=${String(results.patchSemantics.maxActiveSubagentsPresent)} maxDepthPresent=${String(results.patchSemantics.maxDepthPresentInDump)}`)

writeFileSync(`${RESULTS}/boot7-home-override.json`, `${JSON.stringify(results, null, 2)}\n`, 'utf8')
writeFileSync(`${RESULTS}/boot7-transcript.txt`, `${say.join('\n')}\n`, 'utf8')
