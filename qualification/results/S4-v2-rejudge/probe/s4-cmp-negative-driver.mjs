/**
 * S4 CMP-02 + CMP-04 driver: ONE real composed boot, read for both cases.
 *
 * WHY ONE BOOT FOR TWO CASES. CMP-02 and CMP-04 are reads of the SAME live
 * graph, and the CPU directive is one boot at a time. Booting once and reading it
 * twice is also STRONGER than two boots: the facts are then provably about one
 * composition rather than two that might differ.
 *
 * THE PROBE INSERTS NO TOOL ROW. Its only row is itself. A probe that inserted a
 * tool row would make its own catalog a measurement of the OVERLAY rather than of
 * the product -- the G-FIX-04 / G-FIX-05 / G-FIX-12 defect class. CMP-04's oracle
 * says so explicitly: "A catalog measured through a verification overlay that
 * inserts the tool row does NOT establish this case."
 *
 * ORACLES, VERBATIM FROM THE V2 DEFINITION:
 *
 * CMP-02: "A row with `id: sandbox-policy` is present (NOT deleted), its
 *   configured mode is `danger-full-access`, and its `workspaceRoot` resolves to
 *   an absolute path. The row being absent is a specific known failure: it leaves
 *   seven entries pending and drives the tool face to zero."
 *
 * CMP-04: "The model-visible tool surface is intact and named, and the tool count
 *   is MEASURED AND RECORDED IN THE EVIDENCE rather than pinned in this oracle.
 *   The catalog for one real Session, measured through a probe that INSERTS NO
 *   TOOL ROW, must show `ipython` present, `work` present, `pwsh` absent, `error`
 *   null, and `presetRoots` naming the home that was actually booted. ... The
 *   measured count is recorded verbatim in the evidence, together with the full
 *   measured name set, so a change in composition is VISIBLE as a diff without
 *   being a failure of this case."
 *
 * Usage: node qualification/results/S4-v2-rejudge/probe/s4-cmp-driver.mjs
 */
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { bootAndWait, readResult, LAUNCHER } from '../../../runners/boot-harness.mjs'

const REPO = 'D:/DSH/work/wt-s4'
const HOME = 'D:/DSH/home/s4'
const PROFILE_SRC = `${REPO}/profiles/daily-candidate`
const PROFILE_NAME = 'daily'
const PROFILE_DIR = `${HOME}/profiles/${PROFILE_NAME}`
const RUN_DIR = `${REPO}/qualification/results/S4-v2-rejudge/runs/cmp-negative`
const OUT = `${RUN_DIR}/probe.json`
const OVERLAY = `${REPO}/qualification/results/S4-v2-rejudge/probe/s4-cmp-negative-overlay.yml`

mkdirSync(RUN_DIR, { recursive: true })

const transcript = []
const say = line => { transcript.push(line); console.log(line) }
const sha = path => (existsSync(path) ? createHash('sha256').update(readFileSync(path)).digest('hex') : null)

say('=== S4 CMP-02 + CMP-04: one composed boot, two reads ===')
say(`repo: ${REPO}`)
say(`home: ${HOME}`)
say(`at:   ${new Date().toISOString()}`)

// ── FRESH INSTALL, with the profile's `link:` targets REPRODUCED at this tree ──
// The repository's own profile links the MAIN checkout; the provisioner rewrote
// it for this home, and this driver re-copies the repository profile, so the
// rewrite is reproduced here and then ASSERTED. See s4-id01-driver.mjs for the
// measured consequence of getting this wrong.
if (existsSync(PROFILE_DIR)) rmSync(PROFILE_DIR, { recursive: true, force: true })
mkdirSync(`${HOME}/profiles`, { recursive: true })
cpSync(PROFILE_SRC, PROFILE_DIR, { recursive: true })
const pkgJsonPath = `${PROFILE_DIR}/package.json`
const pkgText = readFileSync(pkgJsonPath, 'utf8')
writeFileSync(pkgJsonPath, pkgText.replaceAll('D:/DSH/work/dsh-native-daily', REPO), 'utf8')
const linkTargets = Object.entries(JSON.parse(readFileSync(pkgJsonPath, 'utf8')).dependencies ?? {})
  .map(([k, v]) => ({ name: k, target: String(v) }))
const linksPointHere = linkTargets.every(entry => entry.target.includes('wt-s4'))
say(`profile links: ${linkTargets.map(e => `${e.name}=${e.target}`).join(' | ')}`)
say(`profile links all point at THIS worktree: ${String(linksPointHere)}`)
if (!linksPointHere) {
  say('REFUSING: the profile does not link this worktree, so any verdict would describe another checkout.')
  process.exit(3)
}

let installResult
try {
  const stdout = execFileSync(process.execPath, [LAUNCHER, 'plugin', '--profile', PROFILE_NAME, 'install'], {
    cwd: PROFILE_DIR, env: { ...process.env, DSH_HOME: HOME }, encoding: 'utf8', timeout: 300_000,
  })
  installResult = { exitCode: 0, stdoutTail: stdout.slice(-1500), error: null }
} catch (error) {
  installResult = { exitCode: error.status ?? null, error: String(error.message.split('\n')[0]), stderrTail: String(error.stderr ?? '').slice(-2000) }
}
say(`plugin install: exit=${String(installResult.exitCode)}${installResult.error === null ? '' : ` -- ${installResult.error}`}`)

// ── BOOT ──
const boot = await bootAndWait({
  home: HOME,
  profile: PROFILE_NAME,
  patches: [OVERLAY],
  outPath: OUT,
  // A FOREIGN cwd, on purpose: the profile's own directory would hide a
  // cwd-relative defect, and the preset root was measured to be cwd-sensitive
  // once already (G-FIX-13). `C:/Windows/Temp` is on a different drive.
  cwd: 'C:/Windows/Temp',
  timeoutMs: 180_000,
})
say(`port: ${String(boot.port)}  portReleased: ${String(boot.portReleased)}  timedOut: ${String(boot.timedOut)}  exitCode: ${String(boot.exitCode)}`)
writeFileSync(`${RUN_DIR}/boot-stdout.txt`, boot.stdout, 'utf8')
writeFileSync(`${RUN_DIR}/boot-stderr.txt`, boot.stderr, 'utf8')

let probe = null
let probeReadError = null
let roots = []
try {
  const read = readResult(OUT, HOME)
  probe = read.json
  roots = read.roots
} catch (error) {
  probeReadError = error instanceof Error ? error.message : String(error)
}

// ── CMP-02 ──
const sandbox = probe?.sandbox ?? {}
const workspaceRootResolved = sandbox.workspaceRoot ?? sandbox.resolvedWorkspaceRoot ?? null
const cmp02 = {
  rowPresent: sandbox.policyRowInLoader === true || sandbox.policyServicePresent === true,
  rowFiberState: sandbox.policyRowFiberState ?? null,
  configAsComposed: sandbox.policyRowConfigAsComposed ?? null,
  configuredMode: sandbox.policyRowConfigAsComposed?.mode ?? null,
  defaultMode: sandbox.defaultMode ?? null,
  workspaceRoot: workspaceRootResolved,
  workspaceRootIsAbsolute: typeof workspaceRootResolved === 'string' && /^[A-Za-z]:[\\/]/u.test(workspaceRootResolved),
  resolveWithNoSession: sandbox.resolveWithNoSession ?? null,
  perSession: sandbox.perSession ?? [],
  ptcSandboxMode: sandbox.ptcSandboxMode ?? null,
  fsSandboxMode: sandbox.fsSandboxMode ?? null,
  shellSandboxMode: sandbox.shellSandboxMode ?? null,
}

// ── CMP-04 ──
const presets = (probe?.presets ?? []).filter(p => p !== null)
const daily = presets.find(p => p.label === 'daily-standard') ?? presets[0] ?? null
const namesInHeaderOrder = daily?.tools ?? null
const catalogNames = Array.isArray(namesInHeaderOrder) ? namesInHeaderOrder : []
const cmp04 = {
  sessionCreated: daily?.sessionId !== null && daily?.sessionId !== undefined,
  sessionId: daily?.sessionId ?? null,
  agentPresent: daily?.agentPresent ?? null,
  toolCount: daily?.toolCount ?? null,
  namesSorted: catalogNames,
  ipythonPresent: daily?.ipythonPresent === true,
  workPresent: daily?.workPresent === true,
  pwshPresent: daily?.pwshPresent === true,
  error: probe?.error ?? null,
  presetRoots: roots,
  presetRootsNameBootedHome: roots.some(r => String(r).replace(/\\/g, '/').toLowerCase().includes(HOME.toLowerCase())),
}

// ── CHECKS ──
const checks = []
const check = (name, ok, observed) => { checks.push({ name, ok: ok === true, observed }); say(`${ok ? 'ok  ' : 'FAIL'} ${name}${observed === undefined ? '' : `\n       observed: ${JSON.stringify(observed)}`}`) }

check('the probe wrote its result', probe !== null, probeReadError ?? 'present')
check('the result names the home this driver booted', probeReadError === null, { roots })
check('the boot did not time out', boot.timedOut === false)
check('the host was killed and the port released', boot.portReleased === true)
check('the probe recorded no error', (probe?.error ?? null) === null, probe?.error ?? null)

// CMP-02's three clauses.
check('CMP-02: a row with id sandbox-policy is present (NOT deleted)', cmp02.rowPresent === true, { rowPresent: cmp02.rowPresent, rowFiberState: cmp02.rowFiberState })
check('CMP-02: its configured mode is danger-full-access', cmp02.configuredMode === 'danger-full-access', { configuredMode: cmp02.configuredMode, configAsComposed: cmp02.configAsComposed })
check('CMP-02: its workspaceRoot resolves to an absolute path', cmp02.workspaceRootIsAbsolute === true, { workspaceRoot: cmp02.workspaceRoot, resolveWithNoSession: cmp02.resolveWithNoSession })
check('CMP-02: the EFFECTIVE mode for a real session is danger-full-access', cmp02.defaultMode === 'danger-full-access' && cmp02.perSession.every(s => s.resolved === 'danger-full-access'), { defaultMode: cmp02.defaultMode, perSession: cmp02.perSession })

// CMP-04's five named clauses.
check('CMP-04: a real Session was created', cmp04.sessionCreated === true, { sessionId: cmp04.sessionId, agentPresent: cmp04.agentPresent })
check('CMP-04: ipython is PRESENT on the model-visible catalog', cmp04.ipythonPresent === true)
check('CMP-04: work is PRESENT on the model-visible catalog', cmp04.workPresent === true)
check('CMP-04: pwsh is ABSENT from the model-visible catalog', cmp04.pwshPresent === false)
check('CMP-04: the probe error is null', cmp04.error === null, cmp04.error)
check('CMP-04: presetRoots names the home that was actually booted', cmp04.presetRootsNameBootedHome === true, cmp04.presetRoots)
check('CMP-04: the tool count was MEASURED and is recorded verbatim', typeof cmp04.toolCount === 'number' && cmp04.toolCount > 0, { toolCount: cmp04.toolCount, namesSorted: cmp04.namesSorted })

const failed = checks.filter(c => !c.ok)
say('')
say(`CMP-02 workspaceRoot: ${JSON.stringify(cmp02.workspaceRoot)}`)
say(`CMP-04 measured tool count: ${String(cmp04.toolCount)}`)
say(`checks_passed: ${String(checks.length - failed.length)}/${String(checks.length)}`)
say(`verdict: ${failed.length === 0 ? 'PASS' : 'FAIL'}`)

const verdict = {
  cases: ['CMP-02', 'CMP-04'],
  measured_at: new Date().toISOString(),
  worktree: REPO,
  head: (() => { try { return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO, encoding: 'utf8' }).trim() } catch { return null } })(),
  home: HOME,
  profile: { links: linkTargets, linksPointHere },
  instrument: {
    driver: sha(`${REPO}/qualification/results/S4-v2-rejudge/probe/s4-cmp-driver.mjs`),
    probe: sha(`${REPO}/qualification/results/S4-v2-rejudge/probe/s4-cmp-probe.mjs`),
    probe_original: sha(`${REPO}/qualification/runners/verify-cmp-composition.mjs`),
    overlay: sha(OVERLAY),
    overlay_note: 'the probe row ONLY; no sandbox/sandbox-policy/approval/subagent row is restated, so each subject is read from the PROFILE composition rather than from the overlay',
  },
  boot: { port: boot.port, portReleased: boot.portReleased, timedOut: boot.timedOut, exitCode: boot.exitCode },
  cmp02,
  cmp04,
  checks,
  checksPassed: checks.length - failed.length,
  checksTotal: checks.length,
  verdict: failed.length === 0 ? 'PASS' : 'FAIL',
}
writeFileSync(`${RUN_DIR}/verdict.json`, `${JSON.stringify(verdict, null, 2)}\n`, 'utf8')
writeFileSync(`${RUN_DIR}/transcript.txt`, `${transcript.join('\n')}\n`, 'utf8')
say(`artifact: ${RUN_DIR}/verdict.json`)
