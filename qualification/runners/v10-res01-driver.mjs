/**
 * V10 driver: boot a real composed host and collect the RES-01 chain probe, then
 * answer the provider-SELECTION question from the real profile resolver.
 *
 * WHY IT INSTALLS ITS OWN HOME. The installed profile patch under
 * `$DSH_HOME/profiles/daily/` is a COPY, and on this machine different homes hold
 * different revisions of it. Booting any of them measures that home's copy, not
 * this tree. So this driver installs a FRESH profile from the repository and
 * records both digests, making "the installed copy matched the repository" a
 * measured fact in the artifact rather than an assumption.
 *
 * WHY IT REBUILDS FIRST. Every home installs the extension packages through a
 * `link:`, so the boot executes the BUILT `lib/`, never `src/`. A `lib/` older
 * than its `src/` means the measurement describes a previous build.
 *
 * WHY IT DOES NOT CALL ctx.web.search(). The composed `web` row selects
 * `deepseek-official`, which IS registered and available in this host, so a
 * seam-level search would place a REAL outbound request to the DeepSeek API. No
 * outbound request may leave this machine, so the selection question is answered
 * from the composed entries via the real resolver (a pure read) instead.
 *
 * Usage: node qualification/runners/v10-res01-chain.mjs
 */
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { bootAndWait, readResult, DSH_SRC, LAUNCHER } from './boot-harness.mjs'

const REPO = 'D:/DSH/work/dsh-native-daily'
const HOME = 'D:/DSH/home/v10-research-obs'
const PROFILE_SRC = `${REPO}/profiles/daily-candidate`
const PROFILE_NAME = 'daily'
const PROFILE_DIR = `${HOME}/profiles/${PROFILE_NAME}`
const RESULT_DIR = `${REPO}/qualification/results/V10-research-obs`
const RUN_DIR = `${RESULT_DIR}/runs/res01`
const OUT = `${RUN_DIR}/res01-boot.json`
const OVERLAY = `${RESULT_DIR}/res01-overlay.yml`
const SESSION_ROOT = `${RUN_DIR}/sessions`

mkdirSync(RUN_DIR, { recursive: true })
mkdirSync(SESSION_ROOT, { recursive: true })

const transcript = []
const say = line => { transcript.push(line); console.log(line) }

say('=== V10 / RES-01: the search-to-citation chain in a booted composed host ===')
say(`repo:      ${REPO}`)
say(`checkout:  ${DSH_SRC}`)
say(`home:      ${HOME}`)
say(`launcher:  ${LAUNCHER}`)
say(`probe out: ${OUT}`)

// ---------------------------------------------------------------------------
// (0) REBUILD, so the measurement describes THIS tree's source.
// ---------------------------------------------------------------------------
for (const pkg of ['packages/dsh-daily-work', 'packages/dsh-ipython']) {
  const cwd = `${REPO}/${pkg}`
  const started = Date.now()
  try {
    execFileSync(process.execPath, [`${DSH_SRC}/node_modules/typescript/bin/tsc`, '-p', 'tsconfig.json'], {
      cwd, stdio: 'pipe', timeout: 300_000,
    })
    say(`rebuild ${pkg}: exit=0 in ${String(Date.now() - started)}ms`)
  } catch (error) {
    say(`rebuild ${pkg}: exit=${String(error.status ?? null)} -- ${String(error.message).split('\n')[0]}`)
  }
}

/** Digest every built artifact this boot will load, so a stale build is visible. */
const BUILD_DIGESTS = {}
for (const pkg of ['dsh-daily-work', 'dsh-ipython']) {
  const dir = `${REPO}/packages/${pkg}/lib`
  const digest = createHash('sha256')
  const files = []
  if (existsSync(dir)) {
    // Non-recursive on purpose: the build output is flat, and a recursive walk
    // here would be an unbounded filesystem scan for no gain.
    for (const entry of readdirSync(dir).sort()) {
      if (!entry.endsWith('.js')) continue
      digest.update(entry)
      digest.update(readFileSync(`${dir}/${entry}`))
      files.push(entry)
    }
  }
  BUILD_DIGESTS[pkg] = { fileCount: files.length, digest: digest.digest('hex') }
  say(`build ${pkg}: ${String(files.length)} js files, digest ${BUILD_DIGESTS[pkg].digest.slice(0, 16)}`)
}

// ---------------------------------------------------------------------------
// (1) FRESH INSTALL of the profile from the repository.
// ---------------------------------------------------------------------------
if (existsSync(PROFILE_DIR)) rmSync(PROFILE_DIR, { recursive: true, force: true })
mkdirSync(`${HOME}/profiles`, { recursive: true })
cpSync(PROFILE_SRC, PROFILE_DIR, { recursive: true })
say(`profile installed: ${PROFILE_SRC} -> ${PROFILE_DIR}`)

const sha = path => existsSync(path)
  ? createHash('sha256').update(readFileSync(path)).digest('hex')
  : null
const repoPatchSha = sha(`${PROFILE_SRC}/cordis.patch.yml`)
const installedPatchSha = sha(`${PROFILE_DIR}/cordis.patch.yml`)
say(`repo profile patch      sha256: ${String(repoPatchSha)}`)
say(`installed profile patch sha256: ${String(installedPatchSha)}`)

try {
  const stdout = execFileSync(process.execPath, [LAUNCHER, 'plugin', '--profile', PROFILE_NAME, 'install'], {
    cwd: PROFILE_DIR,
    env: { ...process.env, DSH_HOME: HOME },
    encoding: 'utf8',
    timeout: 300_000,
  })
  say(`plugin install: exit=0 (stdout tail: ${stdout.trim().split('\n').slice(-1)[0] ?? ''})`)
} catch (error) {
  say(`plugin install: exit=${String(error.status ?? null)} -- ${String(error.message).split('\n')[0]}`)
}

// The overlay: mount the probe. NO tool rows, NO provider rows -- the probe
// measures the profile's OWN composition.
writeFileSync(OVERLAY, [
  '- insert:',
  '    - id: v10-res01-chain',
  `      name: '${REPO}/qualification/runners/v10-res01-chain.mjs'`,
  '',
].join('\n'), 'utf8')

// ---------------------------------------------------------------------------
// (2) BOOT.
// ---------------------------------------------------------------------------
const boot = await bootAndWait({
  home: HOME,
  profile: PROFILE_NAME,
  patches: [OVERLAY],
  outPath: OUT,
  // A FOREIGN cwd: neither the repo nor the profile directory.
  cwd: 'C:/Windows/Temp',
  timeoutMs: 180_000,
  env: { V10_PROBE_OUT: OUT },
})

say('')
say(`port: ${String(boot.port)}  portReleased: ${String(boot.portReleased)}  timedOut: ${String(boot.timedOut)}  exitCode: ${String(boot.exitCode)}`)
writeFileSync(`${RUN_DIR}/boot-stdout.txt`, boot.stdout, 'utf8')
writeFileSync(`${RUN_DIR}/boot-stderr.txt`, boot.stderr, 'utf8')

let probe = null
let probeReadError = null
try {
  probe = readResult(OUT, HOME).json
} catch (error) {
  probeReadError = error instanceof Error ? error.message : String(error)
}

// ---------------------------------------------------------------------------
// (3) THE SELECTION QUESTION, from the REAL profile resolver (read-only).
// ---------------------------------------------------------------------------
let selection = null
let selectionError = null
try {
  const mod = await import(pathToFileURL(join(DSH_SRC, 'packages/boot/app-boot/lib/index.js')).href)
  const profile = mod.loadProfile('dsh', PROFILE_NAME, join(DSH_SRC, 'apps/cli/package.json'), HOME)
  const entries = mod.composeEntries([...profile.layers.map(layer => layer.patches), profile.patches])
  const web = entries.find(entry => entry.id === 'web')
  const row = entries.find(entry => entry.id === 'daily-web-search')
  const deepseek = entries.filter(entry => entry.id === 'web-search-deepseek')
  const fetchHttp = entries.filter(entry => entry.id === 'web-fetch-http')
  selection = {
    composedEntryCount: entries.length,
    webRow: web === undefined ? null : { id: web.id, name: web.name, config: web.config ?? null },
    portedRow: row === undefined ? null : { id: row.id, name: row.name, config: row.config ?? null },
    deepseekProviderRows: deepseek.map(entry => ({ id: entry.id, name: entry.name, config: entry.config ?? null })),
    fetchProviderRows: fetchHttp.map(entry => ({ id: entry.id, name: entry.name, config: entry.config ?? null })),
    selectedProviderId: web?.config?.searchProvider ?? null,
    portedProviderId: row?.config?.id ?? null,
    selectionNamesThePortedProvider: (web?.config?.searchProvider ?? null) === (row?.config?.id ?? null),
  }
} catch (error) {
  selectionError = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
}

// ---------------------------------------------------------------------------
// (4) REPORT.
// ---------------------------------------------------------------------------
const report = {
  driver: 'v10-res01-chain',
  home: HOME,
  launcher: LAUNCHER,
  profile: PROFILE_NAME,
  repoProfilePatchSha256: repoPatchSha,
  installedProfilePatchSha256: installedPatchSha,
  installedProfilePatchIsTheRepositoryOne: repoPatchSha === installedPatchSha,
  buildDigests: BUILD_DIGESTS,
  boot: {
    port: boot.port,
    portReleased: boot.portReleased,
    timedOut: boot.timedOut,
    exitCode: boot.exitCode,
  },
  probeWritten: probe !== null,
  probeReadError,
  probeNamesTheBootedHome: probeReadError === null,
  selection,
  selectionError,
  probeResult: probe,
}

writeFileSync(`${RESULT_DIR}/RES-01-boot-chain.json`, JSON.stringify(report, null, 2), 'utf8')

say('')
say('--- SELECTION, from the real resolver ---')
if (selectionError !== null) say(`ERROR: ${selectionError}`)
else {
  say(`composed entries:               ${String(selection.composedEntryCount)}`)
  say(`web row config:                 ${JSON.stringify(selection.webRow?.config ?? null)}`)
  say(`ported row config:              ${JSON.stringify(selection.portedRow?.config ?? null)}`)
  say(`selected provider id:           ${JSON.stringify(selection.selectedProviderId)}`)
  say(`ported provider id:             ${JSON.stringify(selection.portedProviderId)}`)
  say(`selection names the ported one: ${String(selection.selectionNamesThePortedProvider)}`)
}
say('')
say('--- PROBE, inside the booted host ---')
if (probe === null) say(`NO PROBE RESULT: ${String(probeReadError)}`)
else {
  say(`probe names the booted home:    ${String(probeReadError === null)}`)
  say(`probe error:                    ${JSON.stringify(probe.error)}`)
  say(`composed tool refuses loopback: ${JSON.stringify(probe.composedToolRefusesLoopback)}`)
  say(`seam reaches loopback:          ${JSON.stringify(probe.seamReachesLoopback)}`)
  say(`search link:                    ${JSON.stringify(probe.searchLink)}`)
  say(`citation link:                  ${JSON.stringify(probe.citationLink)}`)
  say(`failure shapes:                 ${JSON.stringify(probe.failureShapes)}`)
}
say('')
say(`written: ${RESULT_DIR}/RES-01-boot-chain.json`)
