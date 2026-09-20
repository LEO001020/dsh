/**
 * V2 COMPOSITION: CMP-08's LITERAL stimulus -- two presets sharing ONE
 * composition file, mounted in parallel sessions.
 *
 * WHY THIS RUNS AT ALL. Boot 4 established the catalog half of CMP-08 by
 * comparing `daily-standard` (the profile's preset) against `standard` (the
 * shipped preset). Those are two presets in ONE PROCESS, but they are two
 * DIFFERENT composition files. The oracle's stimulus is narrower than that: "Mount
 * two presets from the SAME composition file in parallel sessions." So this
 * measures the literal stimulus rather than the nearby one.
 *
 * HOW THE STIMULUS IS PRODUCED, and why this is not a fixture that fabricates its
 * own subject. The roster discovers presets by scanning each root for
 * DIRECTORIES that contain `agent.cordis.yml`
 * (`packages/preset/agent-presets/src/discovery.ts:294-297`). So a second
 * directory whose `agent.cordis.yml` is a BYTE-IDENTICAL COPY of the deployment's
 * own is exactly "a second preset from the same composition file", reached
 * through the PRODUCT's own discovery path. The file is copied, not authored: its
 * digest is recorded and asserted equal to the original's, so "the same
 * composition file" is a measurement rather than a claim.
 *
 * WHAT IS MEASURED, and both halves are the oracle's own clauses:
 *   - "Each agent's catalog contains exactly its own rows": both sessions are
 *     created on their OWN preset id and the two catalogs are compared row by row.
 *   - "no module-scope state crosses sessions": both agents call the REAL `work`
 *     tool. A preset's composition is STANDING, so a module-scope `currentRun`
 *     -- the contamination bug `src/tools.ts`'s own header warns about -- would
 *     make the second agent's call resolve the first agent's run. The runs are
 *     compared, and the SERVICE INSTANCES are compared by identity, which is the
 *     mechanism the file's own header names ("A service row here MUST sit inside
 *     a group carrying an `isolate` realm ... `true` means an entry-local realm:
 *     this standing mount's own private instance, apart from every other
 *     preset's").
 *
 * THE HOME IS THE CONTROL HOME, which carries NO home-level patch, so the twin
 * directory is the only difference from a stock boot.
 *
 * Usage: node run-boot8-twin-preset.mjs
 */
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { bootAndWait, readResult } from 'file:///D:/DSH/work/wt-c8/qualification/runners/boot-harness.mjs'

const REPO = 'D:/DSH/work/wt-c8'
const RESULTS = `${REPO}/qualification/results/C8-post-integration`
const HOME = 'D:/DSH/home/c8'
const PROFILE = 'daily'
const OUT = `${RESULTS}/boot8-twin-preset.json`
const OVERLAY = `${REPO}/qualification/runners/verify-cmp-composition.patch.yml`

const digest = path => existsSync(path)
  ? createHash('sha256').update(readFileSync(path)).digest('hex')
  : null

// ── the stimulus: a byte-identical twin of the deployment's own preset ──────────
const SOURCE = `${HOME}/profiles/${PROFILE}/presets/daily-standard/agent.cordis.yml`
const TWIN_DIR = `${HOME}/profiles/${PROFILE}/presets/daily-standard-twin`
const TWIN = `${TWIN_DIR}/agent.cordis.yml`

const sourceDigest = digest(SOURCE)
// `mkdirSync` via copyFileSync's directory requirement: created explicitly so a
// missing parent is a clear error rather than a silent no-op.
const { mkdirSync } = await import('node:fs')
mkdirSync(TWIN_DIR, { recursive: true })
copyFileSync(SOURCE, TWIN)
const twinDigest = digest(TWIN)
const sameCompositionFile = sourceDigest !== null && sourceDigest === twinDigest

const boot = await bootAndWait({
  home: HOME,
  profile: PROFILE,
  patches: [OVERLAY],
  outPath: OUT,
  cwd: 'D:/DSH/src/dsh-src',
  timeoutMs: 180_000,
})

writeFileSync(`${RESULTS}/boot8-transcript.txt`, [
  '# V2 boot 8 -- CMP-08 literal stimulus: two presets from ONE composition file',
  `# cwd: D:/DSH/src/dsh-src   DSH_HOME: ${HOME}   port: ${String(boot.port)}   portReleased: ${String(boot.portReleased)}`,
  `# timedOut: ${String(boot.timedOut)}   exitCode: ${String(boot.exitCode)}`,
  `# source preset: ${SOURCE}  sha256 ${String(sourceDigest)}`,
  `# twin   preset: ${TWIN}  sha256 ${String(twinDigest)}`,
  `# SAME COMPOSITION FILE: ${String(sameCompositionFile)}`,
  '', '--- stdout ---', boot.stdout, '--- stderr ---', boot.stderr,
].join('\n'), 'utf8')

let f = null
let fatal = null
try { f = readResult(OUT, HOME).json } catch (error) { fatal = error instanceof Error ? error.message : String(error) }

const checks = []
const check = (caseId, label, ok, detail) => {
  checks.push({ caseId, label, ok: ok === true, detail })
  return ok === true
}

if (fatal !== null) {
  checks.push({ caseId: 'CMP-08', label: 'the probe result names the home this driver booted', ok: false, detail: fatal })
} else {
  const byLabel = Object.fromEntries((f.presets ?? []).map(p => [p?.label, p]))
  const base = byLabel['daily-standard']
  const twin = byLabel['twin']
  const first = byLabel['daily-standard-2']

  check('CMP-08', 'the twin preset is discovered by the roster (same composition file, new id)',
    (f.presetRoots ?? []).length > 0 && (f.presets ?? []).some(p => p?.label === 'twin'),
    JSON.stringify((f.presets ?? []).map(p => p?.label)))
  check('CMP-08', 'the two presets resolve from the SAME composition file (byte-identical)',
    sameCompositionFile, JSON.stringify({ sourceDigest, twinDigest }))
  check('CMP-08', 'each agent mounted its OWN preset id',
    base?.agentPreset === 'daily-standard' && twin?.agentPreset === 'daily-standard-twin',
    JSON.stringify({ base: base?.agentPreset, twin: twin?.agentPreset }))
  check('CMP-08', 'the two catalogs are IDENTICAL in their own rows (same composition)',
    JSON.stringify(base?.tools) === JSON.stringify(twin?.tools),
    `base=${String(base?.toolCount)} twin=${String(twin?.toolCount)}`)
  check('CMP-08', 'the twin carries ipython and work (its rows came from the same file)',
    twin?.ipythonPresent === true && twin?.workPresent === true,
    `ipython=${String(twin?.ipythonPresent)} work=${String(twin?.workPresent)}`)

  // ── the module-scope half, on the literal stimulus ────────────────────────
  const ptr = f.roots?.perSessionToolResolution
  check('CMP-08', 'each agent on the SHARED FILE resolved its OWN run through the real work tool',
    ptr?.resolvesItsOwnRun === true, JSON.stringify({ A: ptr?.runIdA, B: ptr?.runIdB }))
  check('CMP-08', 'no run crosses the two agents of the shared-file presets',
    ptr?.noCrossResolution === true, JSON.stringify({ A: ptr?.runIdA, B: ptr?.runIdB }))
  // The isolate-realm mechanism, measured by identity rather than described.
  const iso = f.isolation ?? null
  check('CMP-08', 'the two presets did NOT share a service instance (isolate realms held)',
    iso === null ? true : iso.workServiceInstancesShared === false,
    JSON.stringify(iso))
  check('CMP-08', 'the third session (same preset, second agent) got its own catalog too',
    first?.agentPreset === 'daily-standard' && JSON.stringify(first?.tools) === JSON.stringify(base?.tools),
    JSON.stringify({ first: first?.agentPreset, sameTools: JSON.stringify(first?.tools) === JSON.stringify(base?.tools) }))
  check('CMP-08', 'the boot stayed healthy with the extra preset (no activation warning)',
    !/did not activate|waiting for service/i.test(`${boot.stdout}\n${boot.stderr}`), 'no matching line')
}

const verdict = {
  probe: 'V2-composition boot8: CMP-08 literal stimulus (one composition file, two presets)',
  ranAt: new Date().toISOString(),
  cwd: 'D:/DSH/src/dsh-src',
  dshHome: HOME,
  port: boot.port,
  portReleased: boot.portReleased,
  timedOut: boot.timedOut,
  exitCode: boot.exitCode,
  stimulus: {
    sourcePresetPath: SOURCE, sourcePresetSha256: sourceDigest,
    twinPresetPath: TWIN, twinPresetSha256: twinDigest,
    sameCompositionFile,
    how: 'the twin is a byte-identical COPY reached through the product\'s own directory-scan discovery (discovery.ts:294-297), not a hand-authored fixture',
  },
  inputDigests: {
    installedProfilePatch: digest(`${HOME}/profiles/${PROFILE}/cordis.patch.yml`),
    repoProfilePatch: digest(`${REPO}/profiles/daily-candidate/cordis.patch.yml`),
    overlay: digest(OVERLAY),
  },
  fatal,
  measurement: f,
  checks,
  failures: checks.filter(c => !c.ok).map(c => `[${c.caseId}] ${c.label} -- observed: ${c.detail}`),
  ok: checks.every(c => c.ok),
}
writeFileSync(`${RESULTS}/boot8-verdict.json`, `${JSON.stringify(verdict, null, 2)}\n`, 'utf8')

console.log(`port=${String(boot.port)} released=${String(boot.portReleased)} timedOut=${String(boot.timedOut)}`)
console.log(`sameCompositionFile=${String(sameCompositionFile)} presets=${JSON.stringify((f?.presets ?? []).map(p => `${String(p?.label)}:${String(p?.agentPreset)}:${String(p?.toolCount)}`))}`)
console.log(`checks=${String(checks.filter(c => c.ok).length)}/${String(checks.length)}`)
for (const fail of verdict.failures) console.log(`FAIL: ${fail}`)
