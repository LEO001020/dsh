/**
 * S11 verdict — computed from the four boot artifacts, never typed.
 *
 * WHY A SCRIPT AND NOT A HAND-WRITTEN JSON. A verdict object typed by hand is a
 * claim about what the artifacts say, and this project has already recorded two
 * FALSE findings produced exactly that way (G-SEAM-29, G-SEAM-36: a stale built
 * `lib/` and a hand-built harness). So every boolean below is READ from an
 * artifact and every artifact is first checked for the two ways it could be
 * lying:
 *
 *   1. OWNERSHIP. Each probe artifact must name the home this wave booted
 *      (`D:/DSH/home/s11`). A probe writing to a fixed path is a SHARED MUTABLE
 *      RESOURCE, and a stale artifact from another writer would produce a
 *      confident false PASS (G-FIX-13).
 *   2. PROVENANCE. Each probe artifact must record the SAME tree the report
 *      names, and the report's identity block is derived from the digests on
 *      disk rather than asserted.
 *
 * A missing artifact is reported as `NOT_RUN`, never as a comfortable default:
 * "not measured" and "measured zero" are different facts.
 *
 * USAGE
 *   node qualification/runners/s11-cmp-verdict.mjs
 */
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'

/** The repository root of the tree THIS FILE was loaded from. */
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..').replace(/\\/g, '/')

// DERIVED, for the same reason as the driver: a literal worktree path makes the
// verdict depend on which checkout happened to run it.
const WORKTREE = REPO_ROOT
const DIR = `${WORKTREE}/qualification/results/S11-cmp`
const HOME = 'D:/DSH/home/s11'

/** Read one artifact, or return `null` when it is absent. */
function read(name) {
  const path = `${DIR}/${name}`
  if (!existsSync(path)) return null
  return JSON.parse(readFileSync(path, 'utf8'))
}

/** SHA-256 of a file, or `null` when absent -- so a missing input is visible. */
function digest(path) {
  if (!existsSync(path)) return null
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

/**
 * HEAD of the worktree the artifacts were measured on.
 *
 * READ FROM GIT RATHER THAN TYPED, because this project filed two FALSE findings
 * (G-SEAM-29, G-SEAM-36) by naming a build identity that was not the one
 * measured. A hardcoded sha here would be exactly that failure mode. `null` when
 * git cannot answer, so a missing identity is visible rather than plausible.
 */
function gitHead() {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: WORKTREE, encoding: 'utf8' }).trim()
  } catch {
    return null
  }
}

const healthy = read('healthy-probe.json')
const confined = read('confined-probe.json')
const healthyNoProbe = read('healthy-noprobe.boot.json')
const confinedNoProbe = read('confined-noprobe.boot.json')

/** Whether an artifact names the home this wave booted. */
function ownsHome(artifact) {
  if (artifact === null) return false
  const roots = (artifact.presetRoots ?? []).map(root => String(root.path ?? root)).join('|')
  return roots.replace(/\\/g, '/').toLowerCase().includes(HOME.toLowerCase())
}

const identity = {
  worktree: WORKTREE,
  branch: 'wt/s11',
  head: gitHead(),
  /**
   * The BOOT artifacts were produced BEFORE the commit that contains this file,
   * so `head` names the tree the RUNNERS live in and the commit the wave was
   * measured under. The boot-time inputs that actually decide the measurement
   * are the digests below, and those are the ones to compare.
   */
  head_note: 'the commit this wave was measured under; the load-bearing identity inputs are the built/profile digests below',
  dsh_src: 'D:/DSH/src/dsh-src',
  dsh_home: HOME,
  built: {
    'packages/dsh-daily-work/lib/no-sandbox-contract.js': digest(`${WORKTREE}/packages/dsh-daily-work/lib/no-sandbox-contract.js`),
    'packages/dsh-ipython/lib/ipython-tool.js': digest(`${WORKTREE}/packages/dsh-ipython/lib/ipython-tool.js`),
  },
  source: {
    'packages/dsh-daily-work/src/no-sandbox-contract.ts': digest(`${WORKTREE}/packages/dsh-daily-work/src/no-sandbox-contract.ts`),
  },
  profiles: {
    'home/profiles/daily/cordis.patch.yml (HEALTHY)': digest('D:/DSH/home/s11/profiles/daily/cordis.patch.yml'),
    'home/profiles/daily-s11-confined/cordis.patch.yml (NEGATIVE ARM)': digest('D:/DSH/home/s11/profiles/daily-s11-confined/cordis.patch.yml'),
    'repo/profiles/daily-candidate/cordis.patch.yml (must equal HEALTHY)': digest(`${WORKTREE}/profiles/daily-candidate/cordis.patch.yml`),
  },
  probes: {
    'qualification/runners/s11-cmp-probe.mjs': digest(`${WORKTREE}/qualification/runners/s11-cmp-probe.mjs`),
    'qualification/runners/s11-cmp-probe.patch.yml': digest(`${WORKTREE}/qualification/runners/s11-cmp-probe.patch.yml`),
  },
}

/** The healthy profile's patch and the repo's must be byte-identical. */
identity.profiles['repo/profiles/daily-candidate/cordis.patch.yml (must equal HEALTHY)']
  === identity.profiles['home/profiles/daily/cordis.patch.yml (HEALTHY)']

// ── CMP-02 ───────────────────────────────────────────────────────────────────
const c2 = healthy?.cmp02 ?? null
const d = c2?.declared ?? {}
const e = c2?.effective ?? {}
const n = c2?.narration ?? {}

const cmp02 = {
  'the sandbox-policy row is PRESENT (not deleted)': d.rowPresent === true,
  'the row is not disabled and its fiber is ACTIVE (2)': d.rowDisabled === false && d.rowFiberState === 2,
  'the configured mode is the LITERAL string "danger-full-access"': d.modeIsLiteral === true && d.configAsComposed?.mode === 'danger-full-access',
  'the configured mode is NOT an unresolved !!js expression': typeof d.configAsComposed?.mode === 'string',
  'both config keys survive the patch (mode + workspaceRoot)': JSON.stringify(d.configKeys) === JSON.stringify(['mode', 'workspaceRoot']),
  'the mounted service resolves defaultMode to "danger-full-access"': e.defaultMode === 'danger-full-access',
  'the workspaceRoot resolves to an ABSOLUTE path': e.workspaceRootIsAbsolute === true,
  'resolve({}) with no session returns the trusted-local mode': e.resolveNoSession?.mode === 'danger-full-access',
  'a REAL session resolves to the trusted-local mode': e.perSessionResolvesTrustedLocal === true,
  'that session carries NO confining override': e.perSession?.[0]?.override === null,
  'the model-facing narration names danger-full-access': n.saysUnconfined === true,
  'the narration does NOT name workspace-write': n.saysConfining === false,
  'the narration was read by RUNNING assemble(), not restated from source': n.assembleRan === true && n.assembleError === null,
  'the sandbox:policy context entry IS contributed': n.policyContextPresent === true,
  'the PTC confine decision is NOT taken': c2?.ptc?.confineDecision?.startsWith('no confinement') === true,
  'the guard reports this graph as satisfied': c2?.guard?.reportOk === true && c2?.guard?.violations?.length === 0,
  'the guard RECORDED the startup boundary on this graph': c2?.guard?.startupBoundaryRecorded === true,
  'the startup record itself is ok and names danger-full-access': c2?.guard?.startupBoundaryRecord?.ok === true && c2?.guard?.startupBoundaryRecord?.defaultMode === 'danger-full-access',
}

// ── CMP-04 ───────────────────────────────────────────────────────────────────
const c4 = healthy?.cmp04 ?? null
const cat = c4?.catalog ?? null
const sens = healthy?.probeAddsNoRow?.sensitivity ?? null

/**
 * The name set the checks below are computed FROM.
 *
 * Recomputed from the recorded catalog rather than trusted as a summary, so a
 * mutation that edits the name set cannot leave the derived booleans green.
 */
const names = cat?.toolNamesSorted ?? []

const cmp04 = {
  'a REAL session was created and its Agent is live': c4?.sessionId !== null && c4?.agentPresent === true,
  'the catalog was read with NO error': c4?.error === null,
  'ipython is present': names.includes('ipython') === true,
  'work is present': names.includes('work') === true,
  'pwsh is absent': names.includes('pwsh') === false,
  'the full name set was recorded (sorted length equals the count)': names.length === cat?.toolCount && names.length > 0,
  'the SECOND instrument (assembled request tool list) agrees with the registry': c4?.assembledMatchesRegistry === true,
  'the catalog does NOT contain the probe sentinel': names.includes('s11_probe_sensitivity_sentinel') === false,
  "the probe's own derived flags AGREE with this recomputation":
    cat?.ipythonPresent === (names.includes('ipython') === true)
    && cat?.workPresent === (names.includes('work') === true)
    && cat?.pwshPresent === (names.includes('pwsh') === true),
  'the overlay adds exactly ONE row and it is NOT a tool row': healthy?.probeAddsNoRow?.overlayToolRows?.length === 0,
  'the probe registered ZERO tool rows before the sensitivity arm': healthy?.probeAddsNoRow?.toolRowsRegisteredByProbeBeforeSensitivityArm === 0,
  // The falsification arm: if the channel could not see a probe-added row, every
  // catalog number above would be worthless, so this is a PRECONDITION for
  // reading them rather than an extra credit.
  'SENSITIVITY: registering a tool row DOES change the measured catalog (+1)': sens?.channelDetectsAProbeAddedRow === true,
  'SENSITIVITY: the sentinel appeared in the re-read catalog': sens?.deltaNames?.includes('s11_probe_sensitivity_sentinel') === true,
  'SENSITIVITY: disposing it returns the catalog to the original count': sens?.returnedToOriginal === true,
}

// ── CMP-13 ───────────────────────────────────────────────────────────────────
//
// RECOMPUTED FROM THE CATALOG, not read from the probe's own derived flags.
//
// WHY, AND IT IS A FIX TO THIS SCRIPT RATHER THAN TO THE PROBE. The first
// version of this verdict read `cmp13.pwshAbsent`, `cmp13.shellEquivalentsPresent`
// and friends -- booleans the PROBE computed. A mutation test (append `pwsh` to
// the recorded catalog) then flipped CMP-04 red while CMP-13 stayed GREEN,
// because CMP-13 was reading a summary the mutation had not touched. The two
// cases were therefore not two independent readings of one catalog; the second
// was a restatement of the first's own conclusion. Recomputing here from the
// name set is what makes the mutation test able to reach it.
const catalogNames = cat?.toolNamesSorted ?? []
const SHELL_EQUIVALENT_NAMES = ['pwsh', 'bash', 'shell', 'run_code']

const cmp13 = {
  'pwsh is ABSENT from the daily catalog': catalogNames.includes('pwsh') === false,
  'no shell-equivalent tool is present either (pwsh/bash/shell/run_code)':
    SHELL_EQUIVALENT_NAMES.filter(name => catalogNames.includes(name)).length === 0,
  'ipython IS present': catalogNames.includes('ipython') === true,
  'the full measured name set is recorded verbatim (sorted length equals the count)':
    catalogNames.length === cat?.toolCount && catalogNames.length > 0,
  // The probe's own derived flags must AGREE with the recomputation above. They
  // are kept as a cross-check rather than as the source, so a probe that
  // mis-derived them is visible here instead of silently authoritative.
  'the probe\'s own derived flags AGREE with this recomputation':
    healthy?.cmp13?.pwshAbsent === (catalogNames.includes('pwsh') === false)
    && healthy?.cmp13?.ipythonPresent === (catalogNames.includes('ipython') === true),
}

// ── the negative arm ─────────────────────────────────────────────────────────
const cnp = confinedNoProbe?.bootEvidence ?? null
const cp = confined?.cmp02 ?? null

const negativeArm = {
  'the confined profile copy really carries workspace-write': cp?.declared?.configAsComposed?.mode === 'workspace-write',
  'the copy resolves defaultMode to workspace-write': cp?.effective?.defaultMode === 'workspace-write',
  'the NARRATION changes to the confining sentence (the channel is mode-sensitive)': cp?.narration?.saysConfining === true && cp?.narration?.saysUnconfined === false,
  'the narration names the session workspace, i.e. it is a LIVE render': typeof cp?.narration?.policyContextText === 'string' && cp.narration.policyContextText.includes('session workspace'),
  'the PTC confine decision WOULD confine': cp?.ptc?.confineDecision?.startsWith('WOULD CONFINDE') === true,
  'the guard service is NOT published, because its own entry FAILED at apply': cp?.guard?.servicePresent === false,
  'PROBE-FREE boot is SERVED (not a dead boot)': cnp?.served === true,
  'PROBE-FREE stderr carries the activation warning line': cnp?.activationWarningLine !== null,
  'PROBE-FREE stderr names the guard entry': cnp?.guardEntryNamedOnStderr === true,
  'PROBE-FREE stderr carries the refusal text': cnp?.refusalTextOnStderr === true,
  'PROBE-FREE stderr names the failing check id': cnp?.violationIdOnStderr === true,
  'PROBE-FREE stderr reports the observed confining mode': cnp?.observedConfinedModeOnStderr === true,
  'PROBE-FREE stderr contains NO probe (the product wrote it)': cnp?.probeCompleteOnStderr === false,
}

const control = {
  'HEALTHY probe-free boot is SERVED (the control is alive, so empty stderr is not a dead boot)': healthyNoProbe?.bootEvidence?.served === true,
  'HEALTHY probe-free stderr is EMPTY': String(healthyNoProbe?.bootEvidence?.stderr ?? '').trim() === '',
  'HEALTHY probe-free stderr has NO activation warning': healthyNoProbe?.bootEvidence?.activationWarningLine === null,
  'HEALTHY probe-free stderr does NOT name the guard (no false alarm)': healthyNoProbe?.bootEvidence?.guardEntryNamedOnStderr === false,
  'the two probe-free arms are DISTINGUISHABLE on stderr': String(confinedNoProbe?.bootEvidence?.stderr ?? '').trim() !== String(healthyNoProbe?.bootEvidence?.stderr ?? '').trim(),
}

// ── the SETTLE comparison: a mid-mount reading is not a failure ─────────────
//
// The probe's first loader read happens while `apply` is still running, so it
// sees entries in LOADING (state 1). The product's own activation audit runs
// after `loader.await()` and reports zero. Recording BOTH readings is what makes
// the difference a finding rather than a contradiction, and the post-settle read
// is the one that can report a REAL failure -- which is exactly what it does on
// the confined arm.
const settle = {
  'HEALTHY: the mid-mount read DOES see entries still loading (so the race is real, not imagined)':
    (healthy?.loader?.nonActiveEntries ?? []).some(entry => entry.state === 1),
  'HEALTHY: after settling, NOTHING is left in a FAILED state':
    healthy?.loader?.stillNonActiveAfterSettle?.length === 0,
  'CONFINED: after settling, the guard entry IS left FAILED (a real finding, not a race)':
    confined?.loader?.stillNonActiveAfterSettle?.length === 1
    && confined?.loader?.stillNonActiveAfterSettle?.[0]?.id === 'daily-no-sandbox-contract',
  'the two arms differ in EXACTLY this: healthy settles clean, confined keeps the guard FAILED':
    healthy?.loader?.stillNonActiveAfterSettle?.length === 0
    && confined?.loader?.stillNonActiveAfterSettle?.length === 1,
}

// ── the artifacts themselves ─────────────────────────────────────────────────
const artifacts = {
  'healthy-probe.json names the home this wave booted': ownsHome(healthy),
  'confined-probe.json names the home this wave booted': ownsHome(confined),
  'healthy-probe.json recorded NO probe error': healthy?.error === null,
  'confined-probe.json recorded NO probe error': confined?.error === null,
  'the probe overlay added exactly ONE loader row (the probe itself)':
    JSON.stringify(healthy?.loader?.probeRowIds ?? []) === JSON.stringify(['s11-cmp-probe']),
}

const all = { artifacts, cmp02, cmp04, cmp13, negativeArm, control, settle }

/**
 * The tree the RUNNERS live in must be the tree the report names.
 *
 * A verdict script that cited an identity it did not verify would be the
 * G-SEAM-29/G-SEAM-36 failure mode in a new place, so the claim "measured on
 * this worktree" is checked against git rather than stated.
 */
const provenance = {
  'git reports a HEAD for this worktree (so the identity is READ, not typed)': identity.head !== null,
  'the worktree the artifacts name is the one this script runs from': WORKTREE.replace(/\\/g, '/').toLowerCase()
    === process.cwd().replace(/\\/g, '/').toLowerCase(),
  'both probe artifacts name this wave\'s DSH_HOME': ownsHome(healthy) && ownsHome(confined),
  'the repo profile is byte-identical to the healthy installed profile (no silent edit)':
    identity.profiles['repo/profiles/daily-candidate/cordis.patch.yml (must equal HEALTHY)']
    === identity.profiles['home/profiles/daily/cordis.patch.yml (HEALTHY)'],
  'the negative arm profile DIFFERS from the healthy one (so the arm is a real change)':
    identity.profiles['home/profiles/daily-s11-confined/cordis.patch.yml (NEGATIVE ARM)']
    !== identity.profiles['home/profiles/daily/cordis.patch.yml (HEALTHY)'],
  'every built/source digest the report cites resolved': [
    ...Object.values(identity.built), ...Object.values(identity.source),
  ].every(value => typeof value === 'string' && value.length === 64),
}

const allChecks = { ...all, provenance }

/** Roll a group up to PASS / FAIL / NOT_RUN. */
function roll(group) {
  const values = Object.values(group)
  if (values.length === 0) return 'NOT_RUN'
  if (values.some(value => value === false || value === null)) return 'FAIL'
  return 'PASS'
}

const verdicts = Object.fromEntries(Object.entries(allChecks).map(([name, group]) => [name, roll(group)]))

/**
 * The catalog, VERBATIM, at the top level of the artifact.
 *
 * WHY IT IS COPIED RATHER THAN LEFT NESTED. CMP-04's oracle says "the count and
 * the full name set ... recorded verbatim in the evidence, together with the
 * full measured name set, so a change in composition is VISIBLE as a diff". A
 * reader diffing two artifacts should not have to know the nesting to find it.
 */
const catalogVerbatim = {
  count: cat?.toolCount ?? null,
  namesSorted: cat?.toolNamesSorted ?? null,
  namesInRegistryOrder: cat?.toolNamesInRegistryOrder ?? null,
  assembledCount: c4?.assembledToolCount ?? null,
  assembledNamesSorted: c4?.assembledToolNamesSorted ?? null,
  ipythonParameters: cat?.ipythonParameters ?? null,
  shellEquivalentsPresent: cat?.shellEquivalentsPresent ?? null,
}

const record = {
  schema_version: 1,
  kind: 'S11_CMP02_CMP04_MEASUREMENT_NOT_A_DSH_ARTIFACT',
  ranAt: new Date().toISOString(),
  identity,
  sources: {
    'healthy-probe.json': 'the CMP-02 / CMP-04 / CMP-13 measurement. Real profile, foreign cwd, ONE overlay row (the probe).',
    'confined-probe.json': 'the mode-sensitivity control: a COPY of the profile with mode: workspace-write.',
    'healthy-noprobe.boot.json': 'the loudness CONTROL: real profile, NO probe in the tree.',
    'confined-noprobe.boot.json': 'the loudness ARM: confined copy, NO probe in the tree.',
    'dumpconfig-baseline.txt': 'the composed profile tree WITHOUT the overlay, from the launcher itself.',
    'dumpconfig-with-probe.txt': 'the same tree WITH the overlay, proving it adds exactly one row.',
  },
  catalogVerbatim,
  checks: allChecks,
  verdicts,
  boundaryStatement: {
    what_was_removed: 'NOTHING was removed. The pinned checkout D:/DSH/src/dsh-src is untouched and read-only for this wave.',
    what_was_measured: 'The deployment surface, on this worktree, from a foreign cwd, with a probe that adds one loader row (itself) and zero tool rows.',
    negative_arm_profile: 'D:/DSH/home/s11/profiles/daily-s11-confined is a COPY. The real profile D:/DSH/home/s11/profiles/daily was NOT edited, and the repo profile profiles/daily-candidate was NOT edited.',
  },
  notes: [
    'A boot without an LLM is NOT a model turn. Every reading here is a boot-time composition fact or a host-side assembly read; no model was invoked and no request was sent.',
    'The catalog is the surface OFFERED to a model, not what a model used. Nothing here shows a model called any tool.',
    "The probe's own LOADING readings (ui-deliverables, hmr) are a WITHIN-BOOT timing artifact of reading the loader table early; the product's own activation audit, which runs at boot completion, reports them active. See the healthy-noprobe control: zero inactive entries.",
  ],
}

writeFileSync(`${DIR}/MEASUREMENT.json`, `${JSON.stringify(record, null, 1)}\n`, 'utf8')

console.log('=== VERDICTS (computed from the artifacts) ===')
console.log(JSON.stringify(verdicts, null, 1))
console.log('')
for (const [group, checks] of Object.entries(allChecks)) {
  console.log(`--- ${group}: ${verdicts[group]} ---`)
  for (const [label, value] of Object.entries(checks)) {
    console.log(`  ${value === true ? 'ok  ' : value === false ? 'FAIL' : 'N/A '} ${label}`)
  }
}
console.log('')
console.log('=== CMP-04 CATALOG, VERBATIM ===')
console.log(`count: ${String(catalogVerbatim.count)}`)
console.log(JSON.stringify(catalogVerbatim.namesSorted))
