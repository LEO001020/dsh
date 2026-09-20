/**
 * V2 IDENTITY boot driver: measure the two runtime inputs a file read cannot supply.
 *
 * WHAT IT PRODUCES. A probe artifact plus a transcript, and a NON-ZERO EXIT if the
 * measurement is not usable -- a boot that timed out, a probe that never wrote, a
 * result that does not name the home this driver booted, or an empty catalog. A
 * driver that reported success on an unusable measurement would let a
 * NOT_MEASURED value enter the runtime identity looking like a measurement.
 *
 * WHY IT HAS ITS OWN HARNESS CALL RATHER THAN IMPORTING THE SHARED ONE.
 * `boot-harness.mjs` resolves DSH_SRC to the MAIN checkout (`D:/DSH/src/dsh-src`)
 * and its `readResult()` guard compares against whatever home the caller passes.
 * That is correct for the shared runners. This driver must additionally prove the
 * launcher it booted is the one the lock names and that the probe it loaded is
 * THIS worktree's file, so it builds its own argv and records both. The port is
 * still bound rather than guessed, for the reason the shared harness documents:
 * `--port 0` is not available to a patch that must restate the whole config, so a
 * free port is found by binding and releasing.
 *
 * Usage: node run-v2-identity.mjs
 */
import { createHash } from 'node:crypto'
import { createServer } from 'node:net'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'

const REPO = 'D:/DSH/work/wt-r0'
const HOME = 'D:/DSH/home/r0'
const PROFILE = 'daily'
const LAUNCHER = 'D:/DSH/src/dsh-src/apps/cli/lib/bin.js'
const OVERLAY = `${REPO}/qualification/runners/v2-identity.patch.yml`
const PROBE_SRC = `${REPO}/qualification/runners/v2-identity-probe.mjs`
const RESULT_DIR = `${REPO}/qualification/results/trusted-local-v2-identity`
const OUT = `${RESULT_DIR}/probe.json`
const TRANSCRIPT = `${RESULT_DIR}/transcript.txt`
const PORT_PATCH = `${RESULT_DIR}/port.patch.yml`

// The home this driver booted. `readResult`-style ownership is asserted below
// against this value, so a probe writing to a shared path cannot be read as ours.
const EXPECTED_HOME = HOME

const transcript = []
const say = line => { transcript.push(line); console.log(line) }

const digest = path => {
  try {
    return createHash('sha256').update(readFileSync(path)).digest('hex')
  } catch (error) {
    return `unreadable: ${error instanceof Error ? error.message : String(error)}`
  }
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

async function freePort() {
  return await new Promise((resolve, reject) => {
    const srv = createServer()
    srv.once('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address()
      srv.close(() => resolve(port))
    })
  })
}

async function isPortFree(port) {
  return await new Promise(resolve => {
    const srv = createServer()
    srv.once('error', () => resolve(false))
    srv.listen(port, '127.0.0.1', () => srv.close(() => resolve(true)))
  })
}

mkdirSync(RESULT_DIR, { recursive: true })

// A patch REPLACES the whole `config` object, so every key the webserver row
// carries is restated here. Overriding only `port` drops `host` and the loader
// fails with `$.host missing required value`.
const port = await freePort()
writeFileSync(PORT_PATCH, [
  '- id: webserver',
  '  config:',
  "    host: !!js ctx.webStartup.host ?? '127.0.0.1'",
  `    port: ${String(port)}`,
  '    compression: gzip',
  '    compressionLevel: 1',
  '',
].join('\n'), 'utf8')

if (existsSync(OUT)) rmSync(OUT)

const argv = [LAUNCHER, '--profile', PROFILE, '--patch', OVERLAY, '--patch', PORT_PATCH, '--no-open']
say(`command: node ${argv.join(' ')}`)
say(`cwd:     C:/`)
say(`DSH_HOME: ${HOME}`)
say(`port:    ${String(port)} (bound then released, not guessed)`)
say('')

const child = spawn(process.execPath, argv, {
  cwd: 'C:/',
  env: { ...process.env, DSH_HOME: HOME, DSH_PROBE_OUT: OUT },
  stdio: ['ignore', 'pipe', 'pipe'],
})
let stdout = '', stderr = ''
child.stdout.on('data', d => { stdout += String(d) })
child.stderr.on('data', d => { stderr += String(d) })

const deadline = Date.now() + 120_000
let timedOut = false
while (!existsSync(OUT)) {
  if (Date.now() > deadline) { timedOut = true; break }
  if (child.exitCode !== null) { await sleep(1200); break }
  await sleep(200)
}
if (!timedOut && existsSync(OUT)) await sleep(1200)
child.kill('SIGKILL')
await sleep(600)
const portReleased = await isPortFree(port)

say(`exitCode:      ${String(child.exitCode)}`)
say(`timedOut:      ${String(timedOut)}`)
say(`portReleased:  ${String(portReleased)}`)
say(`probe written: ${String(existsSync(OUT))}`)
say('')
if (stderr.trim()) { say('--- stderr ---'); say(stderr.trim()); say('') }
if (stdout.trim()) { say('--- stdout ---'); say(stdout.trim()); say('') }

const checks = []
const check = (label, ok, detail) => {
  checks.push({ label, ok: Boolean(ok), detail: String(detail) })
}

check('the boot did not time out', !timedOut, `timedOut=${String(timedOut)}`)
check('the port was released', portReleased, `portReleased=${String(portReleased)}`)
check('the probe wrote its result', existsSync(OUT), OUT)
check('the probe source is THIS worktree\'s file',
  PROBE_SRC.startsWith(REPO), PROBE_SRC)
check('the overlay names THIS worktree\'s probe',
  readFileSync(OVERLAY, 'utf8').includes(REPO), OVERLAY)

let probe = null
let probeReadError = null
try {
  probe = JSON.parse(readFileSync(OUT, 'utf8'))
} catch (error) {
  probeReadError = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
}
check('the probe result parses', probe !== null, probeReadError ?? 'parsed')

if (probe !== null) {
  // The ownership guard. A probe writing to a fixed path is a SHARED MUTABLE
  // RESOURCE, and reading another writer's result as one's own has already
  // produced a false PASS in this project (G-FIX-13).
  const norm = s => String(s).replace(/\\/g, '/').toLowerCase()
  const roots = (probe.presetRoots ?? []).map(r => String(r.path ?? r)).join('|')
  check('the result describes the home this driver booted',
    norm(roots).includes(norm(EXPECTED_HOME)),
    `expected=${EXPECTED_HOME} roots=${roots}`)
  check('the probe inserted no tool row (it reports itself absent from the catalog)',
    !(probe.agentCatalog?.namesInHeaderOrder ?? []).includes('v2-identity-probe'),
    JSON.stringify(probe.agentCatalog?.namesInHeaderOrder ?? null))
  check('the probe reported no internal error',
    probe.error === null, JSON.stringify(probe.error))
  // A session that FAILED to be created produces `toolCount: 0` and an empty name
  // list, which is indistinguishable from a real empty catalog unless the session
  // is asserted separately. The first run of this driver hit exactly that: session
  // creation threw on `mkdir 'C:\'` and the empty catalog read as a product fact.
  check('a real Session was created, so an empty catalog would mean something',
    probe.agentCatalog?.sessionCreated === true,
    `sessionCreated=${String(probe.agentCatalog?.sessionCreated)} id=${JSON.stringify(probe.agentCatalog?.sessionId)} error=${JSON.stringify(probe.agentCatalog?.error)}`)
  check('the session used an explicit cwd rather than the foreign boot cwd',
    probe.agentCatalog?.sessionCwd !== undefined && !/^C:[/\\]?$/i.test(String(probe.agentCatalog?.sessionCwd)),
    `sessionCwd=${JSON.stringify(probe.agentCatalog?.sessionCwd)}`)
  check('the resolved host graph is non-empty',
    (probe.hostGraph?.rowCount ?? 0) > 0,
    `rows=${String(probe.hostGraph?.rowCount)} active=${String(probe.hostGraph?.activeRowCount)}`)
  // A digest over a tree that was still loading is not an identity: two boots of the
  // same build produced `active=145` and `active=144` before this check existed.
  check('the host graph was read AFTER the loader tree settled',
    probe.settle?.settled === true,
    `settled=${String(probe.settle?.settled)} waitedMs=${String(probe.settle?.waitedMs)} stillMoving=${JSON.stringify(probe.settle?.stillMoving)}`)
  check('the digest was taken on the settled tree',
    probe.hostGraph?.measuredAfterSettle === true,
    `measuredAfterSettle=${String(probe.hostGraph?.measuredAfterSettle)}`)
  check('the per-Agent catalog is non-empty',
    (probe.agentCatalog?.toolCount ?? 0) > 0,
    `tools=${String(probe.agentCatalog?.toolCount)}`)
  check('the catalog carries an order digest', typeof probe.agentCatalog?.orderDigest === 'string',
    JSON.stringify(probe.agentCatalog?.orderDigest ?? null))
  check('the catalog carries a schema digest', typeof probe.agentCatalog?.schemaDigest === 'string',
    JSON.stringify(probe.agentCatalog?.schemaDigest ?? null))
  check('ipython is present in the measured catalog',
    (probe.agentCatalog?.namesInHeaderOrder ?? []).includes('ipython'),
    JSON.stringify(probe.agentCatalog?.namesSorted ?? null))
}

const failures = checks.filter(row => !row.ok)
const verdict = failures.length === 0 && probeReadError === null ? 'MEASURED' : 'UNUSABLE'

say('--- checks ---')
for (const row of checks) {
  say(`${row.ok ? 'ok  ' : 'FAIL'} ${row.label}${row.ok ? '' : `\n       observed: ${row.detail}`}`)
}
say('')
say(`checks_passed: ${String(checks.length - failures.length)}/${String(checks.length)}`)
say(`verdict: ${verdict}`)
say('')
if (probe !== null) {
  say(`hostGraph digest        ${String(probe.hostGraph?.digest)}`)
  say(`  rows=${String(probe.hostGraph?.rowCount)} active=${String(probe.hostGraph?.activeRowCount)}`)
  say(`agentCatalog schemaDigest ${String(probe.agentCatalog?.schemaDigest)}`)
  say(`agentCatalog orderDigest  ${String(probe.agentCatalog?.orderDigest)}`)
  say(`toolCount               ${String(probe.agentCatalog?.toolCount)}`)
  say(`names (header order)    ${JSON.stringify(probe.agentCatalog?.namesInHeaderOrder ?? null)}`)
}

writeFileSync(TRANSCRIPT, `${transcript.join('\n')}\n`, 'utf8')
writeFileSync(`${RESULT_DIR}/driver-verdict.json`, `${JSON.stringify({
  driver: 'run-v2-identity',
  ranAt: new Date().toISOString(),
  launcher: LAUNCHER,
  launcherSha256: digest(LAUNCHER),
  probeSource: PROBE_SRC,
  probeSourceSha256: digest(PROBE_SRC),
  overlay: OVERLAY,
  overlaySha256: digest(OVERLAY),
  dshHome: HOME,
  port,
  portReleased,
  timedOut,
  exitCode: child.exitCode,
  probeReadError,
  probe,
  checks,
  failures: failures.map(row => `${row.label} -- observed: ${row.detail}`),
  verdict,
}, null, 2)}\n`, 'utf8')

process.exit(verdict === 'MEASURED' ? 0 : 1)
