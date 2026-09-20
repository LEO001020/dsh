/**
 * V10 driver: boot a real composed host and collect the OBS history-plane probe.
 *
 * Same mechanics as `v10-res01-driver.mjs`: rebuild, install a fresh profile from
 * the repository, boot once on a harness-chosen free port, then ASSERT the probe
 * result names the home this driver booted (the fixed-output-path guard).
 *
 * Usage: node qualification/runners/v10-obs-driver.mjs
 */
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { bootAndWait, readResult, DSH_SRC, LAUNCHER } from './boot-harness.mjs'

const REPO = 'D:/DSH/work/dsh-native-daily'
const HOME = 'D:/DSH/home/v10-research-obs'
const PROFILE_SRC = `${REPO}/profiles/daily-candidate`
const PROFILE_NAME = 'daily'
const PROFILE_DIR = `${HOME}/profiles/${PROFILE_NAME}`
const RESULT_DIR = `${REPO}/qualification/results/V10-research-obs`
const RUN_DIR = `${RESULT_DIR}/runs/obs`
const OUT = `${RUN_DIR}/obs-plane-boot.json`
const OVERLAY = `${RESULT_DIR}/obs-overlay.yml`
const SESSION_ROOT = `${RUN_DIR}/sessions`

mkdirSync(RUN_DIR, { recursive: true })
mkdirSync(SESSION_ROOT, { recursive: true })

const say = line => { console.log(line) }

say('=== V10 / OBS: the loaded history plane, in a booted composed host ===')
say(`repo:      ${REPO}`)
say(`home:      ${HOME}`)
say(`probe out: ${OUT}`)

for (const pkg of ['packages/dsh-daily-work']) {
  const cwd = `${REPO}/${pkg}`
  try {
    // NOTE (F10): this uses `tsconfig.json` -- the BUILD config -- on purpose, and it
    // is NOT the typecheck gate. The build must EXCLUDE `src/**/*.test.ts` so test
    // code never emits into `lib/`, which is exactly why `tsconfig.json` cannot be
    // cited as evidence that "the tests type-check": it exits 0 with or without a
    // test file present. The official typecheck is `pnpm typecheck`, which drives
    // `tsconfig.check.json` (exclude cleared, `noEmit`) across every package. This
    // call is here to REBUILD `lib/` so the measurement below describes this tree's
    // source; it must not be read as a compiler gate.
    execFileSync(process.execPath, [`${DSH_SRC}/node_modules/typescript/bin/tsc`, '-p', 'tsconfig.json'], {
      cwd, stdio: 'pipe', timeout: 300_000,
    })
    say(`rebuild ${pkg}: exit=0`)
  } catch (error) {
    say(`rebuild ${pkg}: exit=${String(error.status ?? null)} -- ${String(error.message).split('\n')[0]}`)
  }
}

const BUILD_DIGESTS = {}
{
  const dir = `${REPO}/packages/dsh-daily-work/lib`
  const digest = createHash('sha256')
  const files = []
  if (existsSync(dir)) {
    for (const entry of readdirSync(dir).sort()) {
      if (!entry.endsWith('.js')) continue
      digest.update(entry)
      digest.update(readFileSync(`${dir}/${entry}`))
      files.push(entry)
    }
  }
  BUILD_DIGESTS['dsh-daily-work'] = { fileCount: files.length, digest: digest.digest('hex') }
  say(`build dsh-daily-work: ${String(files.length)} js files, digest ${BUILD_DIGESTS['dsh-daily-work'].digest.slice(0, 16)}`)
}

if (existsSync(PROFILE_DIR)) rmSync(PROFILE_DIR, { recursive: true, force: true })
mkdirSync(`${HOME}/profiles`, { recursive: true })
cpSync(PROFILE_SRC, PROFILE_DIR, { recursive: true })

const sha = path => existsSync(path)
  ? createHash('sha256').update(readFileSync(path)).digest('hex')
  : null
const repoPatchSha = sha(`${PROFILE_SRC}/cordis.patch.yml`)
const installedPatchSha = sha(`${PROFILE_DIR}/cordis.patch.yml`)
say(`repo profile patch      sha256: ${String(repoPatchSha)}`)
say(`installed profile patch sha256: ${String(installedPatchSha)}`)

try {
  execFileSync(process.execPath, [LAUNCHER, 'plugin', '--profile', PROFILE_NAME, 'install'], {
    cwd: PROFILE_DIR, env: { ...process.env, DSH_HOME: HOME }, encoding: 'utf8', timeout: 300_000,
  })
  say('plugin install: exit=0')
} catch (error) {
  say(`plugin install: exit=${String(error.status ?? null)} -- ${String(error.message).split('\n')[0]}`)
}

writeFileSync(OVERLAY, [
  '- insert:',
  '    - id: v10-obs-plane',
  `      name: '${REPO}/qualification/runners/v10-obs-plane.mjs'`,
  '',
].join('\n'), 'utf8')

const boot = await bootAndWait({
  home: HOME,
  profile: PROFILE_NAME,
  patches: [OVERLAY],
  outPath: OUT,
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

const report = {
  driver: 'v10-obs-driver',
  home: HOME,
  launcher: LAUNCHER,
  profile: PROFILE_NAME,
  repoProfilePatchSha256: repoPatchSha,
  installedProfilePatchSha256: installedPatchSha,
  installedProfilePatchIsTheRepositoryOne: repoPatchSha === installedPatchSha,
  buildDigests: BUILD_DIGESTS,
  boot: { port: boot.port, portReleased: boot.portReleased, timedOut: boot.timedOut, exitCode: boot.exitCode },
  probeWritten: probe !== null,
  probeReadError,
  probeNamesTheBootedHome: probeReadError === null,
  probeResult: probe,
}
writeFileSync(`${RESULT_DIR}/OBS-plane-boot.json`, JSON.stringify(report, null, 2), 'utf8')

say('')
if (probe === null) say(`NO PROBE RESULT: ${String(probeReadError)}`)
else {
  say(`probe names the booted home: ${String(probeReadError === null)}`)
  say(`probe error:                 ${JSON.stringify(probe.error)}`)
  say(`OBS-02 watermark pinned:     ${JSON.stringify(probe.obs02WatermarkPinned)}`)
  say(`OBS-03 oversized event:      ${JSON.stringify(probe.obs03OversizedEvent)}`)
  say(`OBS-04 replay:               ${JSON.stringify(probe.obs04Replay)}`)
  say(`OBS-05 visibilities:         ${JSON.stringify(probe.obs05Visibilities)}`)
  say(`REACH:                       ${JSON.stringify(probe.reach)}`)
}
say('')
say(`written: ${RESULT_DIR}/OBS-plane-boot.json`)
