/**
 * P14 MANIFEST DRIVER: boot the exact built candidate ONCE and write the fresh
 * runtime observation the manifest is computed from.
 *
 * WHY A DRIVER AND NOT A `--probe` FLAG ON THE GENERATOR. The generator is Python
 * and must be runnable on a machine with no Node; the observation requires a live
 * boot. Keeping them separate means the observation is a FILE with its own
 * provenance (this tree, this commit, this launcher, this port), and the manifest
 * generator can be re-run over a stored observation to recompute the identity
 * without booting. That is what makes the identity reproducible by a third party.
 *
 * WHAT IT REFUSES. It exits NON-ZERO, and writes no observation, when:
 *   - the boot timed out or the probe never wrote;
 *   - the probe reported an internal error;
 *   - the loader tree never settled (a digest over a moving tree is not an identity);
 *   - the probe result does not name the DSH_HOME this driver booted (the
 *     fixed-output-path trap: reading another agent's result as one's own already
 *     produced a false PASS in this project);
 *   - the catalog is empty (which is indistinguishable from a failed Session);
 *   - the probe row appears in the catalog it measured (the overlay contaminated
 *     its own measurement).
 *
 * WHY IT REBUILDS NOTHING. A driver that rebuilt the packages would make the
 * manifest describe the build IT produced rather than the build that is on disk,
 * and the manifest's whole purpose is to describe what is there. Build freshness is
 * MEASURED instead -- the newest `src/*.ts` mtime against the newest `lib/*.js`
 * mtime, per package -- and recorded in the observation so a stale build is a
 * visible fact rather than an assumption. The generator refuses to emit a manifest
 * from an observation whose build is stale.
 *
 * Usage:
 *   node qualification/runners/run-p14-manifest.mjs [--out <path>] [--home <path>]
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { bootAndWait, LAUNCHER, DSH_SRC } from './boot-harness.mjs'
import { materialiseOverlay } from './overlay.mjs'

/** The repository root of the tree THIS FILE was loaded from, not a literal. */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..').replace(/\\/g, '/')

const RESULT_DIR = join(REPO_ROOT, 'qualification/results/P14-manifest').replace(/\\/g, '/')
const OVERLAY_TEMPLATE = join(REPO_ROOT, 'qualification/runners/p14-manifest.patch.yml').replace(/\\/g, '/')
const PROBE_SRC = join(REPO_ROOT, 'qualification/runners/p14-manifest-probe.mjs').replace(/\\/g, '/')

function arg(flag, fallback) {
  const index = process.argv.indexOf(flag)
  return index >= 0 && process.argv[index + 1] !== undefined ? process.argv[index + 1] : fallback
}

const HOME = arg('--home', process.env.P14_DSH_HOME ?? 'D:/DSH/home/p14')
const PROFILE = arg('--profile', 'daily')
const OUT = resolve(arg('--out', join(RESULT_DIR, 'observation.json'))).replace(/\\/g, '/')
const RUN_DIR = dirname(OUT).replace(/\\/g, '/')
const OVERLAY = join(RUN_DIR, 'p14-manifest.patch.yml').replace(/\\/g, '/')

mkdirSync(RUN_DIR, { recursive: true })

const transcript = []
const say = (line) => { transcript.push(line); console.log(line) }

const sha256 = (path) => {
  try {
    return createHash('sha256').update(readFileSync(path)).digest('hex')
  } catch {
    return null
  }
}

/**
 * Newest mtime under `dir` for the given extensions, and the file count.
 *
 * THE TRAP THIS AVOIDS, measured. The first version of an equivalent check in this
 * project scanned `src` for `*.js` and found none, so `newestSrcMtime` was null and
 * the check reported a stale build that did not exist. Source files here are `.ts`
 * and built files are `.js`; the extension is passed in per directory rather than
 * assumed.
 */
function newestMtime(dir, extensions) {
  if (!existsSync(dir)) return { mtimeMs: null, count: 0 }
  let newest = 0
  let count = 0
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name)
      if (entry.isDirectory()) { walk(full); continue }
      if (!extensions.some(ext => entry.name.endsWith(ext))) continue
      count += 1
      newest = Math.max(newest, statSync(full).mtimeMs)
    }
  }
  walk(dir)
  return { mtimeMs: newest === 0 ? null : newest, count }
}

/** A digest over a built `lib/` tree: path-sorted, so a rename moves it. */
function treeDigest(dir) {
  if (!existsSync(dir)) return { digest: null, fileCount: 0 }
  const hash = createHash('sha256')
  let fileCount = 0
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      const full = join(current, entry.name)
      if (entry.isDirectory()) { walk(full); continue }
      if (!/\.(js|mjs|cjs|d\.ts)$/.test(entry.name)) continue
      hash.update(full.slice(dir.length).replace(/\\/g, '/'))
      hash.update(readFileSync(full))
      fileCount += 1
    }
  }
  walk(dir)
  return { digest: hash.digest('hex'), fileCount }
}

// ── BUILD FRESHNESS, measured rather than assumed ───────────────────────────
const buildFreshness = {}
for (const pkg of ['dsh-daily-work', 'dsh-ipython']) {
  const libDir = join(REPO_ROOT, 'packages', pkg, 'lib')
  const srcDir = join(REPO_ROOT, 'packages', pkg, 'src')
  const lib = newestMtime(libDir, ['.js'])
  const src = newestMtime(srcDir, ['.ts'])
  buildFreshness[pkg] = {
    newestLibMtimeMs: lib.mtimeMs,
    newestLibMtime: lib.mtimeMs === null ? null : new Date(lib.mtimeMs).toISOString(),
    libFileCount: lib.count,
    newestSrcMtimeMs: src.mtimeMs,
    newestSrcMtime: src.mtimeMs === null ? null : new Date(src.mtimeMs).toISOString(),
    srcFileCount: src.count,
    // A `lib` older than its `src` is a STALE BUILD: the boot would execute code
    // that predates the source in the tree. This is a refusal condition, not a note.
    libNewerThanSrc: lib.mtimeMs !== null && src.mtimeMs !== null && lib.mtimeMs >= src.mtimeMs,
    libTree: treeDigest(libDir),
  }
  say(`build ${pkg}: lib=${buildFreshness[pkg].newestLibMtime} src=${buildFreshness[pkg].newestSrcMtime} fresh=${String(buildFreshness[pkg].libNewerThanSrc)} libFiles=${String(buildFreshness[pkg].libFileCount)}`)
}

// ── THE OVERLAY IS MATERIALISED INTO THIS TREE, naming THIS tree's probe ────
materialiseOverlay(OVERLAY_TEMPLATE, OVERLAY, PROBE_SRC)
say(`overlay materialised: ${OVERLAY}`)

if (existsSync(OUT)) rmSync(OUT)

const boot = await bootAndWait({
  home: HOME,
  profile: PROFILE,
  patches: [OVERLAY],
  outPath: OUT,
  // A FOREIGN cwd, deliberately: it is what proves the preset root is anchored at
  // the profile rather than at the process cwd.
  cwd: 'C:/Windows/Temp',
  timeoutMs: Number(process.env.P14_BOOT_TIMEOUT_MS ?? 180_000),
  env: { P14_OUT: OUT, P14_SESSION_CWD: REPO_ROOT },
})

say('')
say(`port: ${String(boot.port)}  released: ${String(boot.portReleased)}  timedOut: ${String(boot.timedOut)}  exitCode: ${String(boot.exitCode)}`)

let probe = null
let probeReadError = null
try {
  probe = JSON.parse(readFileSync(OUT, 'utf8'))
} catch (error) {
  probeReadError = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
}

const checks = []
const check = (label, ok, detail) => checks.push({ label, ok: Boolean(ok), detail: String(detail) })

check('the boot did not time out', !boot.timedOut, `timedOut=${String(boot.timedOut)}`)
check('the port was released', boot.portReleased, `portReleased=${String(boot.portReleased)}`)
check('the probe wrote its result', existsSync(OUT), OUT)
check('the probe result parses', probe !== null, probeReadError ?? 'parsed')

if (probe !== null) {
  // THE OWNERSHIP GUARD. A probe writing to a fixed path is a SHARED MUTABLE
  // RESOURCE, and reading another writer's result as one's own has already produced
  // a false PASS in this project (G-FIX-13).
  const norm = (s) => String(s).replace(/\\/g, '/').toLowerCase()
  const roots = (probe.presetRoots ?? []).map((r) => String(r.path ?? r)).join('|')
  check('the result describes the home this driver booted',
    norm(roots).includes(norm(HOME)), `expected=${HOME} roots=${roots}`)
  check('the probe reported no internal error', probe.error === null, JSON.stringify(probe.error))
  check('the loader tree SETTLED before it was read',
    probe.settle?.settled === true,
    `settled=${String(probe.settle?.settled)} waitedMs=${String(probe.settle?.waitedMs)} stillMoving=${JSON.stringify(probe.settle?.stillMoving ?? null)}`)
  check('a real resolver was reachable',
    probe.resolver !== null && probe.resolver !== undefined,
    JSON.stringify(probe.resolver ?? null))
  check('the resolved graph is non-empty', (probe.graph?.rowCount ?? 0) > 0,
    `rows=${String(probe.graph?.rowCount)} resolved=${String(probe.graph?.resolvedRowCount)}`)
  check('every row either resolved to a realpath or is a loader builtin',
    (probe.graph?.resolvedRowCount ?? 0) + (probe.graph?.builtinRowCount ?? -1) === (probe.graph?.rowCount ?? -2),
    `rows=${String(probe.graph?.rowCount)} resolved=${String(probe.graph?.resolvedRowCount)} builtins=${String(probe.graph?.builtinRowCount)} unresolved=${JSON.stringify((probe.graph?.unresolvedRows ?? []).slice(0, 8))}`)
  check('the extension rows are present and resolved',
    (probe.extensionRows ?? []).length > 0 && (probe.extensionRows ?? []).every((r) => r.realpath !== null),
    JSON.stringify((probe.extensionRows ?? []).map((r) => `${r.name} -> ${r.realpath}`)))
  check('a real Session was created, so an empty catalog would mean something',
    probe.catalog?.sessionCreated === true,
    `sessionCreated=${String(probe.catalog?.sessionCreated)} id=${JSON.stringify(probe.catalog?.sessionId)} error=${JSON.stringify(probe.catalog?.error)}`)
  check('the per-Agent catalog is non-empty', (probe.catalog?.toolCount ?? 0) > 0,
    `tools=${String(probe.catalog?.toolCount)}`)
  check('the catalog carries an order digest', typeof probe.catalog?.orderDigest === 'string',
    JSON.stringify(probe.catalog?.orderDigest ?? null))
  check('the catalog carries a schema digest', typeof probe.catalog?.schemaDigest === 'string',
    JSON.stringify(probe.catalog?.schemaDigest ?? null))
  // THE OVERLAY DID NOT CONTAMINATE ITS OWN MEASUREMENT.
  check('the probe row is ABSENT from the catalog it measured',
    !(probe.catalog?.namesInHeaderOrder ?? []).includes('p14-manifest-probe'),
    JSON.stringify(probe.catalog?.namesInHeaderOrder ?? null))
  check('the probe row is ABSENT from the graph it digested',
    !(probe.graph?.rows ?? []).some((r) => String(r.key) === 'p14-manifest-probe'),
    JSON.stringify((probe.graph?.rows ?? []).map((r) => r.key).filter((k) => String(k).includes('p14'))))
  check('every package build is newer than its source',
    Object.values(buildFreshness).every((b) => b.libNewerThanSrc),
    JSON.stringify(Object.fromEntries(Object.entries(buildFreshness).map(([k, v]) => [k, v.libNewerThanSrc]))))
}

const failures = checks.filter((row) => !row.ok)
const verdict = failures.length === 0 && probeReadError === null ? 'OBSERVED' : 'UNUSABLE'

say('')
say('--- checks ---')
for (const row of checks) {
  say(`${row.ok ? 'ok  ' : 'FAIL'} ${row.label}${row.ok ? '' : `\n       observed: ${row.detail}`}`)
}
say('')
say(`checks_passed: ${String(checks.length - failures.length)}/${String(checks.length)}`)
say(`verdict: ${verdict}`)

const observation = {
  schema_version: 1,
  kind: 'P14_FRESH_RUNTIME_OBSERVATION_NOT_A_DSH_ARTIFACT',
  _what_this_is: [
    'The freshly observed runtime facts a BuildManifest is computed from, produced by',
    'a live boot of the exact built candidate. It is an INPUT to the manifest, and it',
    'is kept beside it so the manifest can be recomputed without booting again.',
    '',
    'It is NOT a manifest and NOT an identity. It carries the observation and the',
    'conditions under which it was taken; the generator decides whether those',
    'conditions permit an identity to be computed from it.',
  ],
  ran_at: new Date().toISOString(),
  verdict,
  driver: {
    path: 'qualification/runners/run-p14-manifest.mjs',
    sha256: sha256(fileURLToPath(import.meta.url)),
    repo_root: REPO_ROOT,
    launcher: LAUNCHER,
    launcher_sha256: sha256(LAUNCHER),
    dsh_src: DSH_SRC,
    home: HOME,
    profile: PROFILE,
    port: boot.port,
    port_released: boot.portReleased,
    timed_out: boot.timedOut,
    exit_code: boot.exitCode,
    boot_cwd: 'C:/Windows/Temp',
    probe_source: PROBE_SRC,
    probe_source_sha256: sha256(PROBE_SRC),
    overlay: OVERLAY,
    overlay_sha256: sha256(OVERLAY),
  },
  build_freshness: buildFreshness,
  probe,
  checks,
  failures: failures.map((row) => `${row.label} -- observed: ${row.detail}`),
}

writeFileSync(OUT, `${JSON.stringify(observation, null, 2)}\n`, 'utf8')
writeFileSync(join(RUN_DIR, 'transcript.txt'), `${transcript.join('\n')}\n`, 'utf8')
say(`wrote ${OUT}`)

process.exit(verdict === 'OBSERVED' ? 0 : 1)
