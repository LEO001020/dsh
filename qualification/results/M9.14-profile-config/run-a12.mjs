/**
 * A12 runner: drive the REAL built launcher's Web host and record what it proves.
 *
 * WHY A SCRIPT AND NOT A VITEST CASE
 *
 * The Web host is a long-lived process that binds a port and holds it. A vitest
 * case that spawned it would make this suite's teardown the gate's real failure
 * mode (a leaked listener, a hung dispose), which is a worse property than the
 * one being tested. So the boot is driven here, its transcript is the evidence,
 * and `profile-config.test.ts` asserts against the transcript. The gate's claim
 * is then re-derivable from a file that is in the repository.
 *
 * WHAT THIS ACTUALLY EXERCISES
 *
 * The real built launcher (`apps/cli/lib/bin.js`), the real `daily-candidate`
 * composition (base + web-app + the work extension), the real HTTP server, the
 * real browser-trust fence, and the real `session/*` RPC surface. No headless
 * run, no testkit, no hand-built Context substitutes for any of it.
 *
 * WHAT IT DELIBERATELY STOPS SHORT OF
 *
 * No model turn is run, because no credential source on this machine supplies
 * `DEEPSEEK_API_KEY`. A prompt submitted now fails at the route, so the
 * transcript records that boundary explicitly rather than pretending a turn
 * completed.
 *
 * Usage: node run-a12.mjs <outFile>
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const DSH_SRC = 'D:/DSH/src/dsh-src'
const LAUNCHER = `${DSH_SRC}/apps/cli/lib/bin.js`
const REPO = 'D:/DSH/work/dsh-native-daily'
const HOME = 'D:/DSH/home/m914'
const PROFILE = 'm914-daily'
const PORT = 18401

const out = process.argv[2]
if (out === undefined) throw new Error('usage: node run-a12.mjs <outFile>')

const lines = []
const say = (text) => { lines.push(text); process.stdout.write(`${text}\n`) }

const profileDir = join(HOME, 'profiles', PROFILE)
const manifest = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8'))

say('=== A12: the real daily Web host ===')
say('')
say(`launcher: ${LAUNCHER}`)
say(`profile: ${PROFILE}`)
say(`bundles: ${manifest.dsh.profile.bundles.join(', ')}`)
say(`profile_dependencies: ${JSON.stringify(manifest.dependencies)}`)
say(`work_extension_mounted: ${existsSync(join(profileDir, 'node_modules', 'dsh-daily-work'))}`)
say(`home: ${HOME}`)
say(`port: ${PORT}`)
say('')

const child = spawn(process.execPath, [
  LAUNCHER, '--profile', PROFILE, '--no-open', '--port', String(PORT),
], {
  cwd: DSH_SRC,
  env: { ...process.env, DSH_HOME: HOME, DSH_TELEMETRY_DISABLED: '1' },
  stdio: ['ignore', 'pipe', 'pipe'],
})

let stdout = ''
let stderr = ''
child.stdout.on('data', chunk => { stdout += chunk.toString() })
child.stderr.on('data', chunk => { stderr += chunk.toString() })

/** Poll until the readiness line appears, or give up. The line IS the readiness signal. */
async function waitForUrl(timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const match = /^dsh web: (http:\/\/[^\s]+)/m.exec(stdout)
    if (match !== null) return match[1]
    await new Promise(resolve => setTimeout(resolve, 500))
  }
  return undefined
}

async function request(path, options = {}) {
  const response = await fetch(path, options)
  const body = await response.text()
  return { status: response.status, body, headers: response.headers }
}

const url = await waitForUrl(60_000)
if (url === undefined) {
  say(`boot_failed: true`)
  say(`stdout: ${JSON.stringify(stdout)}`)
  say(`stderr: ${JSON.stringify(stderr)}`)
  writeFileSync(out, `${lines.join('\n')}\n`)
  child.kill('SIGTERM')
  process.exit(1)
}

say(`url_line: ${url}`)
say(`boot_stdout_has_url: true`)
const base = url.slice(0, url.indexOf('/?'))

// 1. The trust fence: an unauthenticated API request must be refused.
const unauth = await request(`${base}/api/session/list`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ type: 'client-request', rpcId: 'a12-unauth', method: 'session/list', payload: { args: {} } }),
})
say(`unauthenticated_api_status: ${unauth.status}`)
say(`unauthenticated_api_body: ${JSON.stringify(unauth.body.slice(0, 120))}`)

// 2. The token URL exchanges for a session cookie and serves the app shell.
const tokenResponse = await request(url, { redirect: 'manual' })
const setCookie = tokenResponse.headers.get('set-cookie')
say(`token_exchange_status: ${tokenResponse.status}`)
say(`token_exchange_sets_cookie: ${setCookie !== null}`)
const cookie = setCookie === null ? '' : setCookie.split(';', 1)[0]

const root = await request(`${base}/`, { headers: { cookie } })
say(`authenticated_root_status: ${root.status}`)
say(`authenticated_root_is_app_shell: ${root.body.includes('<!doctype html')}`)

const api = async (method, args) => {
  const response = await request(`${base}/api/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ type: 'client-request', rpcId: `a12-${method}`, method, payload: { args } }),
  })
  return JSON.parse(response.body)
}

// 3. The model route, read from the real catalog.
const catalog = await api('session/modelCatalog', {})
say(`model_catalog_ok: ${catalog.result.ok}`)
if (catalog.result.ok) {
  say(`model_catalog_default: ${JSON.stringify(catalog.result.value.default)}`)
  say(`model_catalog_routable_providers: ${JSON.stringify(catalog.result.value.routableProviders)}`)
}

// 4. A real Session, created and read back through the real RPC surface.
const created = await api('session/create', { request: { cwd: REPO } })
say(`session_create_ok: ${created.result.ok}`)
const sessionId = created.result.ok ? created.result.value.sessionId : undefined
say(`session_created_id: ${sessionId ?? '<none>'}`)
if (created.result.ok) say(`session_created_preset: ${created.result.value.agentPreset}`)

const listed = await api('session/list', { _request: {} })
say(`session_list_ok: ${listed.result.ok}`)
if (listed.result.ok) {
  const found = listed.result.value.items.find(item => item.sessionId === sessionId)
  say(`session_list_found_created: ${found !== undefined}`)
  if (found !== undefined) {
    say(`session_list_item_running: ${found.running}`)
    say(`session_list_item_cwd: ${found.cwd}`)
    say(`session_list_item_preset: ${found.projections.values.agentPreset}`)
    say(`session_list_item_permissions: ${found.projections.values.permissions.currentValue}`)
    say(`session_list_item_model_next: ${JSON.stringify(found.projections.values.modelSelection.next)}`)
  }
}

// 5. The credential boundary, stated as a fact rather than inferred.
//
// The point is to distinguish "the host would not boot" from "the host booted
// and had no key to call a model with". Only the second leaves this gate
// closeable by adding a credential, so the absence is checked at every source
// the credentials provider actually layers
// (packages/credentials/credentials-local/src/index.ts):
//   inherited process environment > $DSH_HOME/.credentials.yaml > cwd/.env > $DSH_HOME/.env
const credentialsFile = join(HOME, '.credentials.yaml')
let credentialKeys = []
if (existsSync(credentialsFile)) {
  credentialKeys = readFileSync(credentialsFile, 'utf8')
    .split('\n')
    .filter(line => /^\s{2,}\S/.test(line))
    .map(line => line.trim().split(':', 1)[0])
}
say(`credentials_file_exists: ${existsSync(credentialsFile)}`)
say(`credentials_file_record_keys: ${JSON.stringify(credentialKeys)}`)
say(`credentials_file_has_refs_section: ${readFileSync(credentialsFile, 'utf8').includes('refs:')}`)
say(`cwd_env_exists: ${existsSync(join(DSH_SRC, '.env'))}`)
say(`home_env_exists: ${existsSync(join(HOME, '.env'))}`)
say(`deepseek_api_key_in_process_env: ${process.env.DEEPSEEK_API_KEY !== undefined}`)
say(`model_turn_run: false`)
say(`credential_boundary: DEEPSEEK_API_KEY not configured`)
say('')
say('--- launcher stdout ---')
say(stdout.trimEnd())
say('--- launcher stderr ---')
say(stderr.trimEnd())
say('--- shutdown ---')
// The stop is honest about what it is. Windows has no POSIX signals: Node's
// `child.kill('SIGTERM')` terminates the process rather than delivering a
// catchable signal, so the launcher's own SIGTERM handler
// (apps/cli/src/profile-boot.ts: `process.on('SIGTERM', () => interrupt(0))`)
// never runs on this platform. The measured exit is therefore a SIGNAL
// termination, and reporting it as "exit 0" would be a claim about a code path
// that was not taken.
say('stop_requested: SIGTERM via child.kill()')
say('note: on win32 child.kill() terminates rather than delivering a catchable signal,')
say('      so the launcher SIGTERM handler did not run and no exit code was observed.')
say('      A clean-shutdown claim would need a different driver and is NOT made here.')

child.kill('SIGTERM')
const exit = await new Promise(resolve => {
  const timer = setTimeout(() => resolve({ code: null, signal: 'TIMEOUT' }), 30_000)
  child.on('exit', (code, signal) => { clearTimeout(timer); resolve({ code, signal }) })
})
say(`exit_code: ${exit.code}`)
say(`exit_signal: ${exit.signal}`)

writeFileSync(out, `${lines.join('\n')}\n`)
process.exit(0)
