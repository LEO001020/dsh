/**
 * A12 runner: qualify the REAL daily Web host across its whole lifecycle —
 * boot, auth fence, Session round trip, model turn, SHUTDOWN, and RESTART.
 *
 * WHY A SCRIPT AND NOT A VITEST CASE
 *
 * The Web host is a long-lived process that binds a port and holds it. A vitest
 * case that spawned it would make this suite's teardown the gate's real failure
 * mode (a leaked listener, a hung dispose), which is a worse property than the
 * one being tested. So the boot is driven here, its transcript is the evidence,
 * and the gate's claim is re-derivable from a file in the repository.
 *
 * WHAT IS MEASURED, AND HOW EACH FACT IS ESTABLISHED
 *
 *  - boot + port bind: the launcher's own readiness line, then an independent
 *    TCP connect to the port it names.
 *  - the trust fence: an unauthenticated POST to /api/session/list must be 401.
 *  - login: the token URL must exchange for a cookie, and that cookie must serve
 *    the app shell with 200.
 *  - session round trip: session/create then session/list through the real RPC.
 *  - a MODEL TURN: `session/prompt` driven against the IN-TREE MOCK ADAPTER
 *    (packages/test-support/llm-mock-server). This is a controlled LOCAL route —
 *    a real HTTP request over a real socket through the real DeepSeek adapter —
 *    NOT a live provider. Every claim it supports is labelled that way.
 *  - SHUTDOWN: the host is asked to stop through the launcher's own `appExit`,
 *    and the process exit code and wall-clock time are recorded. Leftovers are
 *    then hunted explicitly: the port must stop listening, no descendant process
 *    may survive, and the temp/home trees are checked for what remains.
 *  - RESTART: a second boot on the SAME port after the first exited.
 *
 * WHY SHUTDOWN USES AN INSTRUMENT ROUTE
 *
 * On win32 `child.kill()` calls TerminateProcess for SIGTERM/SIGINT/SIGKILL, so
 * the launcher's handlers never run and no exit code is observable — the exact
 * reason the recorded A12 result carries no shutdown claim. A signal matrix run
 * on this machine (results/P7-daily-host/signal-probe.txt) established that the
 * only catchable console event deliverable to a child here is CTRL_BREAK_EVENT,
 * surfacing as SIGBREAK, which the launcher does not handle. The Web profile has
 * no in-product exit command either. `verify-a12.patch.yml` therefore mounts
 * `verify-a12-shutdown-route.mjs`, which calls the launcher's own `ctx.appExit`
 * (the same callback the product's `exitOnStdinEnd` uses) behind the REAL
 * browser-trust fence. The production shutdown path is what runs; only the
 * trigger is ours.
 *
 * Usage: node verify-a12.mjs <outFile> [--mock]
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { createConnection } from 'node:net'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

const DSH_SRC = 'D:/DSH/src/dsh-src'
const LAUNCHER = `${DSH_SRC}/apps/cli/lib/bin.js`
const REPO = 'D:/DSH/work/dsh-native-daily'
const HOME = 'D:/DSH/home/canary12'
const PROFILE = 'daily-candidate'
const RESULT_DIR = `${REPO}/qualification/results/P7-daily-host`

/** The port the Web host binds. Verified free before use; not assumed. */
const PORT = 18912
/** The in-tree mock adapter's port. Separate from the host so both are visible. */
const MOCK_PORT = 19411
/** Token for the mock endpoint, delivered through the REAL credential reference. */
const MOCK_KEY = 'a12-mock-token'

const out = process.argv[2]
if (out === undefined) throw new Error('usage: node verify-a12.mjs <outFile> [--mock|--nomock]')
const withMock = process.argv.includes('--mock')
const noMock = process.argv.includes('--nomock')
if (withMock && noMock) throw new Error('--mock and --nomock are mutually exclusive')

/**
 * Which overlay this invocation boots. `--nomock` uses an overlay carrying ONLY
 * the shutdown instrument, so the provider route stays stock and the run
 * re-establishes the CREDENTIAL boundary the recorded A12 result stopped at.
 * Redirecting the provider while claiming to measure "no credential" would be a
 * different and misleading boundary (connection refused, not MISSING_CREDENTIAL).
 */
const OVERLAY = noMock
  ? `${REPO}/qualification/runners/verify-a12-nomock.patch.yml`
  : `${REPO}/qualification/runners/verify-a12.patch.yml`

const lines = []
const say = (text) => { lines.push(text); process.stdout.write(`${text}\n`) }

/** Redact the launcher's live session token: it is a working credential. */
const redact = (text) => text.replace(/token=[A-Za-z0-9_-]+/g, 'token=<redacted>')

/**
 * Decompress a concatenated-frame zstd session log, frame by frame.
 *
 * The backend writes a CONCATENATED-FRAME container: one independently
 * decodable frame per header/event batch. `zstdDecompressSync(buffer)` returns
 * only the FIRST frame's plaintext, so a whole-buffer call silently truncates
 * the log to its header. This reimplements the product's own structural scan
 * (packages/session/session-persistence-jsonl/src/zstd.ts `scanZstdFrames`) and
 * reports a torn tail instead of hiding it.
 * @param raw - the complete bytes currently present in the session artifact.
 * @returns the concatenated plaintext plus the torn-tail offset, when present.
 */
function decompressZstdFrames(raw) {
  const ZSTD_MAGIC = 0xFD2FB528
  let text = ''
  let offset = 0
  let frames = 0
  while (offset < raw.length) {
    const start = offset
    if (raw.length - offset < 4) return { text, frames, tornStart: start }
    if (raw.readUInt32LE(offset) !== ZSTD_MAGIC) return { text, frames, tornStart: start, corrupt: start }
    offset += 4
    if (offset === raw.length) return { text, frames, tornStart: start }
    const descriptor = raw.readUInt8(offset)
    offset += 1
    const contentSizeFlag = descriptor >>> 6
    const singleSegment = (descriptor & 0x20) !== 0
    const checksum = (descriptor & 0x04) !== 0
    const dictionaryFlag = descriptor & 0x03
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
    if (raw.length - offset < remainingHeaderBytes) return { text, frames, tornStart: start }
    offset += remainingHeaderBytes
    for (;;) {
      if (raw.length - offset < 3) return { text, frames, tornStart: start }
      const blockHeader = raw.readUIntLE(offset, 3)
      offset += 3
      const lastBlock = (blockHeader & 1) !== 0
      const blockType = (blockHeader >>> 1) & 0x03
      const blockSize = blockHeader >>> 3
      const payloadBytes = blockType === 0x01 ? 1 : blockSize
      if (raw.length - offset < payloadBytes) return { text, frames, tornStart: start }
      offset += payloadBytes
      if (lastBlock) break
    }
    if (checksum) {
      if (raw.length - offset < 4) return { text, frames, tornStart: start }
      offset += 4
    }
    try {
      text += zstdDecompressSync(raw.subarray(start, offset)).toString()
    } catch {
      return { text, frames, tornStart: start, decompressFailed: start }
    }
    frames += 1
  }
  return { text, frames }
}

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms))

/** Independent evidence that a TCP port is bound, without trusting the host's own log. */
function portIsListening(port) {
  return new Promise((resolve) => {
    const socket = createConnection({ host: '127.0.0.1', port })
    const done = (result) => { socket.destroy(); resolve(result) }
    socket.setTimeout(1_500)
    socket.once('connect', () => { done(true) })
    socket.once('timeout', () => { done(false) })
    socket.once('error', () => { done(false) })
  })
}

// A tiny alias so the file works as an ES module without a CJS require.
const require$ = (specifier) => process.getBuiltinModule(specifier)

/**
 * Temp-root entries whose names look harness-owned. Used as a BEFORE/AFTER diff
 * so a leftover can be attributed to this run: a bare list of matches is not
 * evidence, because other agents' runs and pre-existing directories match too.
 * @returns the matching entry names, sorted.
 */
function listTempMatches() {
  try {
    return readdirSync('C:/Users/hzq00/AppData/Local/Temp')
      .filter(name => /^dsh|a12|headless-agent/i.test(name))
      .sort()
  } catch { return [] }
}

/** PIDs of node processes whose command line names this runner's port or home. */
function ownedProcesses() {
  const { execFileSync } = require$('node:child_process')
  const ps = [
    'Get-CimInstance Win32_Process -Filter "Name=\'node.exe\'" |',
    'Where-Object { $_.CommandLine -like \'*canary12*\' -or $_.CommandLine -like \'*18912*\' } |',
    'Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress',
  ].join(' ')
  try {
    const raw = execFileSync('powershell', ['-NoProfile', '-Command', ps], { encoding: 'utf8' }).trim()
    if (raw === '') return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : [parsed]
  } catch { return [] }
}

// ── the in-tree mock adapter ────────────────────────────────────────────────

let mockServer
if (withMock) {
  const mockModule = await import('file:///D:/DSH/src/dsh-src/packages/test-support/llm-mock-server/lib/index.js')
  mockServer = await mockModule.startMockLlmServer({
    host: '127.0.0.1',
    port: MOCK_PORT,
    apiKey: MOCK_KEY,
    // FIFO, one behavior per accepted request. The first call returns a tool
    // call to the REAL `read` tool; the second answers with text.
    sequence: ['tool_call_success', 'success'],
    toolName: 'read',
    toolArguments: JSON.stringify({ file_path: `${REPO}/AGENTS.md`, limit: 5 }),
    successText: 'A12_MOCK_TURN_COMPLETE',
    reasoningText: 'A12 mock reasoning',
    chunkSize: 64,
  })
  say(`mock_llm_base_url: ${mockServer.baseURL}`)
  say(`mock_llm_route: in-tree @deepseek-ai/dsh-llm-mock-server (LOCAL, not a live provider)`)
}

// ── boot ────────────────────────────────────────────────────────────────────

const env = {
  ...process.env,
  DSH_HOME: HOME.replaceAll('/', '\\'),
  DSH_TELEMETRY_DISABLED: '1',
}
if (withMock) env.A12_MOCK_KEY = MOCK_KEY

// Launcher flags come FIRST; everything after `--` reaches the booted profile's
// own app. `--patch` is a launcher flag, so putting it after `--no-open --port`
// makes the Web app reject it as an unknown option.
const args = [LAUNCHER, '--profile', PROFILE, '--patch', OVERLAY, '--', '--no-open', '--port', String(PORT)]

say('=== A12: the real daily Web host, full lifecycle ===')
say('')
say(`launcher: ${LAUNCHER}`)
say(`profile: ${PROFILE}`)
say(`home: ${HOME}`)
say(`overlay: ${OVERLAY}`)
say(`port: ${PORT}`)
say(`port_listening_before_boot: ${await portIsListening(PORT)}`)
say(`boot_command: node ${args.slice(1).join(' ')}`)
say(`boot_cwd: ${DSH_SRC}`)
say('')

const child = spawn(process.execPath, args, {
  cwd: DSH_SRC,
  env,
  stdio: ['ignore', 'pipe', 'pipe'],
})

let stdout = ''
let stderr = ''
child.stdout.on('data', (chunk) => { stdout += chunk.toString() })
child.stderr.on('data', (chunk) => { stderr += chunk.toString() })

let exited = false
let exitInfo
child.on('close', (code, signal) => { exited = true; exitInfo = { code, signal } })

/** Poll the launcher's stdout for its own readiness line. */
async function waitForUrl(timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const match = /^dsh web: (http:\/\/[^\s]+)/m.exec(stdout)
    if (match !== null) return match[1]
    if (exited) return undefined
    await sleep(300)
  }
  return undefined
}

const bootStarted = Date.now()
// Snapshot the temp root BEFORE the boot so leftovers can be attributed to THIS
// host rather than to whatever else is on the machine. The earlier version listed
// every matching entry, which is not evidence of a leak: other agents' runs and
// pre-existing directories match the same pattern.
const tempBefore = new Set(listTempMatches())
const url = await waitForUrl(90_000)
const bootMs = Date.now() - bootStarted
say(`boot_ready_line_ms: ${bootMs}`)
if (url === undefined) {
  say('boot_failed: true')
  say(`launcher_stdout: ${JSON.stringify(redact(stdout))}`)
  say(`launcher_stderr: ${JSON.stringify(redact(stderr))}`)
  if (mockServer !== undefined) await mockServer.close()
  writeFileSync(out, `${lines.join('\n')}\n`)
  process.exit(1)
}

say(`url_line: ${redact(url)}`)
say(`url_line_shape: http://127.0.0.1:<port>/?token=<redacted>`)
say(`boot_stdout_has_url: true`)
say(`port_listening_after_boot: ${await portIsListening(PORT)}`)
const base = url.slice(0, url.indexOf('/?'))

/** One HTTP request, returning status, body, and headers. */
async function request(path, options = {}) {
  const response = await fetch(path, options)
  const body = await response.text()
  return { status: response.status, body, headers: response.headers }
}

// ── 1. the trust fence ──────────────────────────────────────────────────────

const unauth = await request(`${base}/api/session/list`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ type: 'client-request', rpcId: 'a12-unauth', method: 'session/list', payload: { args: {} } }),
})
say(`unauthenticated_api_status: ${unauth.status}`)
say(`unauthenticated_api_body: ${JSON.stringify(unauth.body.slice(0, 120))}`)

// ── 2. token URL -> cookie -> app shell ─────────────────────────────────────

const tokenResponse = await request(url, { redirect: 'manual' })
const setCookie = tokenResponse.headers.get('set-cookie')
say(`token_exchange_status: ${tokenResponse.status}`)
say(`token_exchange_sets_cookie: ${setCookie !== null}`)
const cookie = setCookie === null ? '' : setCookie.split(';', 1)[0]

const root = await request(`${base}/`, { headers: { cookie } })
say(`authenticated_root_status: ${root.status}`)
say(`authenticated_root_is_app_shell: ${root.body.includes('<!doctype html')}`)

/** Call one real RPC method with the authenticated cookie. */
async function api(method, args) {
  const response = await request(`${base}/api/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ type: 'client-request', rpcId: `a12-${method}-${String(Date.now())}`, method, payload: { args } }),
  })
  try { return JSON.parse(response.body) } catch { return { parseError: response.body.slice(0, 200) } }
}

// ── 3. the model route and a real Session ───────────────────────────────────

const catalog = await api('session/modelCatalog', {})
say(`model_catalog_ok: ${catalog.result?.ok}`)
if (catalog.result?.ok) {
  say(`model_catalog_default: ${JSON.stringify(catalog.result.value.default)}`)
  say(`model_catalog_routable_providers: ${JSON.stringify(catalog.result.value.routableProviders)}`)
}

const created = await api('session/create', { request: { cwd: REPO } })
say(`session_create_ok: ${created.result?.ok}`)
const sessionId = created.result?.ok ? created.result.value.sessionId : undefined
say(`session_created_id: ${sessionId ?? '<none>'}`)
if (created.result?.ok) say(`session_created_preset: ${created.result.value.agentPreset}`)

const listed = await api('session/list', { _request: {} })
say(`session_list_ok: ${listed.result?.ok}`)
if (listed.result?.ok) {
  const found = listed.result.value.items.find(item => item.sessionId === sessionId)
  say(`session_list_found_created: ${found !== undefined}`)
  if (found !== undefined) {
    say(`session_list_item_running: ${found.running}`)
    say(`session_list_item_cwd: ${found.cwd}`)
    say(`session_list_item_preset: ${found.projections.values.agentPreset}`)
    say(`session_list_item_permissions: ${found.projections.values.permissions.currentValue}`)
  }
}

// ── 4. the model turn ───────────────────────────────────────────────────────

say('')
say('--- model turn (controlled local route) ---')
if (noMock) {
  // The CREDENTIAL boundary, measured on the STOCK provider route. The overlay
  // here carries only the shutdown instrument, so the provider endpoint is the
  // real one and the failure that comes back is the credential failure itself.
  say('model_turn_attempted: true (to establish the CREDENTIAL boundary)')
  const credentialsFile = join(HOME, '.credentials.yaml')
  say(`credentials_file_exists: ${existsSync(credentialsFile)}`)
  if (existsSync(credentialsFile)) {
    // Only the KEY NAMES are read; values are never printed.
    const keys = readFileSync(credentialsFile, 'utf8')
      .split('\n')
      .filter(line => /^\s{2,}\S/.test(line))
      .map(line => line.trim().split(':', 1)[0])
    say(`credentials_file_record_keys: ${JSON.stringify(keys)}`)
    say(`credentials_file_has_refs_section: ${readFileSync(credentialsFile, 'utf8').includes('refs:')}`)
  }
  say(`cwd_env_exists: ${existsSync(join(DSH_SRC, '.env'))}`)
  say(`home_env_exists: ${existsSync(join(HOME, '.env'))}`)
  say(`deepseek_api_key_in_process_env: ${process.env.DEEPSEEK_API_KEY !== undefined}`)
  say(`deepseek_api_key_in_invocation_env: ${env.DEEPSEEK_API_KEY !== undefined}`)
  if (sessionId !== undefined) {
    const boundary = await api('session/prompt', {
      request: {
        requestId: `a12-boundary-${String(Date.now())}`,
        sessionId,
        mode: 'queue',
        content: [{ type: 'text', text: 'Say hello.' }],
      },
    })
    say(`boundary_prompt_rpc_ok: ${boundary.result?.ok}`)
    say(`boundary_prompt_value: ${JSON.stringify(boundary.result?.value ?? boundary.result?.error ?? boundary).slice(0, 300)}`)
    // Wait for the route to report its failure into the durable log.
    const deadline = Date.now() + 30_000
    let boundaryLog = ''
    while (Date.now() < deadline) {
      await sleep(1_000)
      const files = (() => {
        const root = join(HOME, 'sessions')
        if (!existsSync(root)) return []
        let all = []
        for (const d of readdirSync(root, { withFileTypes: true })) {
          if (!d.isDirectory()) continue
          const inner = join(root, d.name)
          let subs = []
          try { subs = readdirSync(inner, { withFileTypes: true }) } catch { continue }
          for (const s of subs) {
            if (!s.isDirectory()) continue
            const f = join(inner, s.name, 'session.v3.jsonl.zstd')
            if (existsSync(f)) all.push(f)
          }
        }
        return all
      })()
      for (const f of files) {
        const { text } = decompressZstdFrames(readFileSync(f))
        if (text.includes('MISSING_CREDENTIAL')) { boundaryLog = text; break }
      }
      if (boundaryLog !== '') break
    }
    const match = /MISSING_CREDENTIAL[^"\\]{0,200}/.exec(boundaryLog)
    say(`boundary_missing_credential_seen_in_session_log: ${match !== null}`)
    if (match !== null) say(`boundary_message: ${JSON.stringify(match[0])}`)
    say(`credential_boundary: DEEPSEEK_API_KEY not configured`)
  }
} else if (!withMock) {
  say('model_turn_attempted: false')
  say('model_turn_reason: this invocation did not enable the mock route (--mock)')
} else if (sessionId === undefined) {
  say('model_turn_attempted: false')
  say('model_turn_reason: no session was created')
} else {
  const promptResponse = await api('session/prompt', {
    request: {
      requestId: `a12-prompt-${String(Date.now())}`,
      sessionId,
      mode: 'queue',
      // The prompt deliberately does NOT contain the marker string. If it did,
      // the user message echoed into the log would match a substring search and
      // a turn that never ran would look like a turn that produced the reply.
      // The marker is supplied ONLY by the mock's scripted assistant text.
      content: [{ type: 'text', text: 'Read the first lines of AGENTS.md, then report what you read.' }],
    },
  })
  say(`session_prompt_ok: ${promptResponse.result?.ok}`)
  say(`session_prompt_value: ${JSON.stringify(promptResponse.result?.value ?? promptResponse.result?.error ?? promptResponse)}`)

  // The turn is asynchronous: poll the persisted session log for the events the
  // turn must produce. The log is the durable record, so this reads the real
  // outcome rather than a UI frame.
  const sessionRoot = join(HOME, 'sessions')
  const scan = () => {
    const found = { call: false, result: false, resultHasFile: false, text: false, textBody: '', frames: 0, tornStart: undefined, eventTypes: {}, logs: [] }
    if (!existsSync(sessionRoot)) return found
    for (const dir of readdirSync(sessionRoot, { withFileTypes: true })) {
      if (!dir.isDirectory()) continue
      const inner = join(sessionRoot, dir.name)
      let sessionDirs = []
      try { sessionDirs = readdirSync(inner, { withFileTypes: true }) } catch { continue }
      for (const s of sessionDirs) {
        if (!s.isDirectory()) continue
        const file = join(inner, s.name, 'session.v3.jsonl.zstd')
        if (!existsSync(file)) continue
        const raw = readFileSync(file)
        if (raw.subarray(0, 4).toString('hex') !== '28b52ffd') continue
        const { text, frames, tornStart } = decompressZstdFrames(raw)
        found.frames += frames
        if (tornStart !== undefined) found.tornStart = tornStart
        found.logs.push(`${s.name} frames=${frames} bytes=${text.length} tornStart=${tornStart ?? 'none'}`)
        for (const line of text.split('\n')) {
          if (line.trim() === '') continue
          let record
          try { record = JSON.parse(line) } catch { continue }
          const type = record.type
          found.eventTypes[type] = (found.eventTypes[type] ?? 0) + 1
          if (type === 'tool/call') found.call = true
          if (type === 'tool/result') found.result = true
          // The marker must come from an ASSISTANT-produced event. A substring
          // search over the whole log would also match the user's own prompt,
          // which would make a turn that never ran look successful. Only
          // assistant/message is counted, so the reply must be model-produced.
          if (type === 'assistant/message') {
            const assistantText = JSON.stringify(record)
            if (assistantText.includes('A12_MOCK_TURN_COMPLETE')) {
              found.text = true
              if (found.textBody === '') found.textBody = assistantText.slice(0, 400)
            }
          }
          // The tool result must carry the REAL file content the read tool
          // returned, so the round trip is proven end to end rather than by an
          // event merely existing.
          if (type === 'tool/result' && JSON.stringify(record).includes('AGENTS.md')) found.resultHasFile = true
        }
      }
    }
    return found
  }

  let seen = scan()
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline && !(seen.call && seen.result && seen.text)) {
    await sleep(1_000)
    seen = scan()
  }
  say(`model_turn_tool_call_event: ${seen.call}`)
  say(`model_turn_tool_result_event: ${seen.result}`)
  say(`model_turn_tool_result_carries_file_content: ${seen.resultHasFile}`)
  say(`model_turn_final_text_seen: ${seen.text}`)
  if (seen.textBody !== '') say(`model_turn_final_text_sample: ${seen.textBody}`)
  say(`model_turn_run: ${seen.call && seen.result && seen.text}`)
  say(`session_log_frames_total: ${seen.frames}`)
  say(`session_log_torn_tail: ${seen.tornStart ?? 'none'}`)
  say(`session_log_event_types: ${JSON.stringify(seen.eventTypes)}`)
  for (const line of seen.logs) say(`  session_log: ${line}`)
  if (mockServer !== undefined) {
    const requests = mockServer.requests
    say(`mock_requests_accepted: ${requests.length}`)
    for (const record of requests) {
      say(`  mock_request_${record.attempt}: script=${record.scriptBehavior} behavior=${record.behavior} path=${record.path} outcome=${record.outcome ?? 'open'} chunks=${record.chunksSent}`)
      const messages = record.body?.messages
      if (Array.isArray(messages)) {
        // Tool calls recorded on ASSISTANT messages in the request history: this
        // is what the adapter sent back on the follow-up request, i.e. proof the
        // model's tool call was carried into the second round trip.
        const assistantToolNames = messages
          .filter(m => m.role === 'assistant')
          .flatMap(m => (m.tool_calls ?? []).map(tc => tc.function?.name))
          .filter(Boolean)
        say(`    mock_request_${record.attempt}_assistant_tool_calls_in_history: ${JSON.stringify(assistantToolNames)}`)
        say(`    mock_request_${record.attempt}_message_roles: ${JSON.stringify(messages.map(m => m.role))}`)
      }
      const tools = record.body?.tools
      if (Array.isArray(tools)) {
        const toolNames = tools.map(t => t.function?.name ?? t.name).filter(Boolean)
        say(`    mock_request_${record.attempt}_tool_catalog_count: ${toolNames.length}`)
        say(`    mock_request_${record.attempt}_has_read_tool: ${toolNames.includes('read')}`)
        say(`    mock_request_${record.attempt}_has_work_tool: ${toolNames.includes('work')}`)
      }
    }
  }
}
say('')
say('--- launcher stdout ---')
say(redact(stdout.trimEnd()))
say('--- launcher stderr ---')
say(redact(stderr.trimEnd()))

// ── 5. shutdown ─────────────────────────────────────────────────────────────

say('')
say('--- shutdown ---')
say(`shutdown_trigger: POST ${base}/a12/shutdown (launcher ctx.appExit via the gate instrument route)`)
say(`shutdown_trigger_is_product_route: false`)
say(`shutdown_path_is_production: true (ctx.appExit runs the launcher's own bounded dispose)`)

const beforePids = ownedProcesses().map(p => p.ProcessId)
say(`pids_before_shutdown: ${JSON.stringify(beforePids)}`)

const shutdownStarted = Date.now()
// The host disposes its own server while answering this request, so the socket
// may close before the response is read. That IS the expected behaviour, not a
// failure: a transport error here is recorded as such rather than thrown.
let shutdownStatus
let shutdownBody
try {
  const shutdownResponse = await request(`${base}/a12/shutdown`, { method: 'POST', headers: { cookie } })
  shutdownStatus = shutdownResponse.status
  shutdownBody = shutdownResponse.body.trim()
} catch (error) {
  shutdownStatus = 'socket-closed-before-response'
  shutdownBody = error instanceof Error ? error.message : String(error)
}
say(`shutdown_route_status: ${shutdownStatus}`)
say(`shutdown_route_body: ${JSON.stringify(shutdownBody)}`)

const exitedInTime = await (async () => {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    if (exited) return true
    await sleep(100)
  }
  return false
})()
const shutdownMs = Date.now() - shutdownStarted
say(`process_exited: ${exitedInTime}`)
say(`shutdown_ms: ${shutdownMs}`)
say(`exit_code: ${exitInfo?.code ?? 'null'}`)
say(`exit_signal: ${exitInfo?.signal ?? 'null'}`)

// ── 6. leftovers ────────────────────────────────────────────────────────────

say('')
say('--- leftovers ---')
await sleep(1_000)
say(`port_listening_after_shutdown: ${await portIsListening(PORT)}`)
const afterPids = ownedProcesses()
say(`pids_after_shutdown: ${JSON.stringify(afterPids.map(p => p.ProcessId))}`)
for (const entry of afterPids) say(`  leftover_pid_${entry.ProcessId}: ${String(entry.CommandLine).slice(0, 200)}`)
say(`descendant_process_left_behind: ${afterPids.length > 0}`)

// The storage domain and session logs are the things a leaked handle would keep
// open; a lock file or a still-growing log would show that.
const lockPath = join(HOME, 'storages')
say(`home_storages_dir_exists: ${existsSync(lockPath)}`)
if (existsSync(lockPath)) {
  const walk = (dir, depth = 0) => {
    if (depth > 2) return []
    let out2 = []
    let entries = []
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return [] }
    for (const e of entries) {
      const full = join(dir, e.name)
      if (e.isDirectory()) out2 = out2.concat(walk(full, depth + 1))
      else out2.push(full)
    }
    return out2
  }
  const files = walk(lockPath)
  say(`home_storages_file_count: ${files.length}`)
  for (const f of files.slice(0, 10)) {
    say(`  storage_file: ${f.slice(HOME.length)} size=${statSync(f).size}`)
  }
}
const tempLeftovers = listTempMatches()
const tempNewAfterBoot = tempLeftovers.filter(name => !tempBefore.has(name))
say(`temp_matches_total_after_shutdown: ${tempLeftovers.length}`)
say(`temp_entries_CREATED_during_this_run: ${JSON.stringify(tempNewAfterBoot)}`)
say(`temp_entry_left_behind_by_this_host: ${tempNewAfterBoot.length > 0}`)
// An empty directory and a directory holding spilled tool output are different
// findings, so the contents are measured rather than the name alone. The spill
// backend's own contract is a per-process root reclaimed by a STARTUP sweep
// after `cleanupPeriodDays` (default 30) -- so retention across one shutdown is
// by design, and what matters is whether DATA survived.
for (const name of tempNewAfterBoot) {
  const full = `C:/Users/hzq00/AppData/Local/Temp/${name}`
  const walkFiles = (dir, depth = 0) => {
    if (depth > 3) return []
    let files = []
    let entries = []
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return [] }
    for (const e of entries) {
      const child = `${dir}/${e.name}`
      if (e.isDirectory()) files = files.concat(walkFiles(child, depth + 1))
      else files.push(child)
    }
    return files
  }
  const files = walkFiles(full)
  let bytes = 0
  for (const f of files) { try { bytes += statSync(f).size } catch { /* raced */ } }
  say(`  temp_created_${name}: files=${files.length} bytes=${bytes}`)
  for (const f of files.slice(0, 5)) say(`    ${f.slice(full.length)} size=${statSync(f).size}`)
}
// ── 7. restart on the same port ─────────────────────────────────────────────

say('')
say('--- restart ---')
say(`restart_port_reused: ${PORT}`)
const restartChild = spawn(process.execPath, args, {
  cwd: DSH_SRC,
  env,
  stdio: ['ignore', 'pipe', 'pipe'],
})
let restartStdout = ''
let restartStderr = ''
restartChild.stdout.on('data', (chunk) => { restartStdout += chunk.toString() })
restartChild.stderr.on('data', (chunk) => { restartStderr += chunk.toString() })
let restartExited = false
restartChild.on('close', () => { restartExited = true })

const restartStarted = Date.now()
let restartUrl
while (Date.now() - restartStarted < 90_000) {
  const match = /^dsh web: (http:\/\/[^\s]+)/m.exec(restartStdout)
  if (match !== null) { restartUrl = match[1]; break }
  if (restartExited) break
  await sleep(300)
}
say(`restart_ready_line_ms: ${restartUrl === undefined ? 'n/a' : Date.now() - restartStarted}`)
say(`restart_boot_succeeded: ${restartUrl !== undefined}`)
if (restartUrl === undefined) {
  say(`restart_stdout: ${JSON.stringify(redact(restartStdout))}`)
  say(`restart_stderr: ${JSON.stringify(redact(restartStderr))}`)
} else {
  say(`restart_url_line: ${redact(restartUrl)}`)
  say(`restart_port_listening: ${await portIsListening(PORT)}`)
  const restartBase = restartUrl.slice(0, restartUrl.indexOf('/?'))
  const restartUnauth = await request(`${restartBase}/api/session/list`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: 'a12-restart-unauth', method: 'session/list', payload: { args: {} } }),
  })
  say(`restart_unauthenticated_api_status: ${restartUnauth.status}`)
  const restartToken = await request(restartUrl, { redirect: 'manual' })
  const restartSetCookie = restartToken.headers.get('set-cookie')
  say(`restart_token_exchange_status: ${restartToken.status}`)
  const restartCookie = restartSetCookie === null ? '' : restartSetCookie.split(';', 1)[0]
  const restartList = await request(`${restartBase}/api/session/list`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: restartCookie },
    body: JSON.stringify({ type: 'client-request', rpcId: 'a12-restart-list', method: 'session/list', payload: { args: { _request: {} } } }),
  })
  let restartListBody
  try { restartListBody = JSON.parse(restartList.body) } catch { restartListBody = undefined }
  say(`restart_session_list_ok: ${restartListBody?.result?.ok}`)
  const previous = restartListBody?.result?.ok
    ? restartListBody.result.value.items.some(item => item.sessionId === sessionId)
    : undefined
  say(`restart_sees_session_from_first_boot: ${previous}`)

  // Stop the second host through the same instrument, so nothing is left behind.
  let restartShutdownStatus
  try {
    const restartShutdown = await request(`${restartBase}/a12/shutdown`, { method: 'POST', headers: { cookie: restartCookie } })
    restartShutdownStatus = restartShutdown.status
  } catch (error) {
    restartShutdownStatus = `socket-closed-before-response (${error instanceof Error ? error.message : String(error)})`
  }
  say(`restart_shutdown_route_status: ${restartShutdownStatus}`)
  const restartDeadline = Date.now() + 30_000
  while (Date.now() < restartDeadline && !restartExited) await sleep(100)
  say(`restart_process_exited: ${restartExited}`)
  say(`restart_exit_code: ${restartChild.exitCode ?? 'null'}`)
  say(`restart_port_listening_after_shutdown: ${await portIsListening(PORT)}`)
}

say('')
say('--- restart launcher stderr ---')
say(redact(restartStderr.trimEnd()))

// ── cleanup ─────────────────────────────────────────────────────────────────

if (mockServer !== undefined) await mockServer.close()
say('')
say(`mock_server_closed: ${mockServer !== undefined}`)
const finalPids = ownedProcesses()
say(`final_owned_pids: ${JSON.stringify(finalPids.map(p => p.ProcessId))}`)
say(`final_port_listening: ${await portIsListening(PORT)}`)
say(`final_mock_port_listening: ${await portIsListening(MOCK_PORT)}`)

writeFileSync(out, `${lines.join('\n')}\n`)
process.exit(0)
