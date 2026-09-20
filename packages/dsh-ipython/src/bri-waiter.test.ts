/**
 * BRI-WAITER — an immediate reply cannot beat waiter registration.
 *
 * V5 §6.1 and V5 §18 name this case. V5 §2's fact 13 records the pre-fix state:
 * "waiter registered before send? NO — `_send()` at `:1526` sends, `:1529`
 * registers".
 *
 * THE DEFECT. The Python client's reader thread matches a reply to a waiter by
 * request id, and a reply it cannot match is DISCARDED:
 *
 *     request_id = message.get("requestId")
 *     with self._lock:
 *         waiter = self._waiters.pop(request_id, None)
 *     if waiter is None:
 *         continue                      # <-- the reply is gone
 *
 * In the pre-fix client, `call_sync`/`call_async` put the request on the wire
 * and only THEN registered a waiter. A reply that arrived in that window was
 * popped, found to have no waiter, and dropped; the caller then waited out its
 * entire timeout for an answer the host had already sent. The window is not
 * exotic -- the reader is blocked on `self._lock` holding a parsed reply while
 * `_send` holds that lock, so the reader is the very next lock holder once the
 * send releases.
 *
 * THE FIX. Registration and send happen in ONE lock acquisition (`_send` takes
 * the waiter and installs it in the same critical section that writes the
 * frame), so the reader cannot observe the request before its waiter exists.
 * That is the rule `broker.py`'s own `ShellRouter` already states and enforces:
 * `register()` is documented "Call BEFORE sending the request", and its reader
 * COUNTS a frame whose parent matches no waiter instead of delivering it. The
 * fix is consistency with that router, not a new mechanism.
 *
 * WHY THIS TEST IS DETERMINISTIC RATHER THAN REPEATED. "Send 100 calls and see
 * if one times out" is not a test: the natural run usually wins the window, so
 * that instrument reports green on broken code. Instead the interleaving is
 * FORCED and the forcing is stated:
 *
 *   `src/bri-waiter-driver.py` replaces the client's own lock with one that
 *   holds the CALLER (never the reader) on its first post-send acquisition
 *   until the reader has completed a lookup. In the pre-fix client that
 *   acquisition IS the registration, so the reader is guaranteed to look up
 *   the reply first -- and the reply is therefore guaranteed to be lost. In the
 *   fixed client the waiter is already registered before the frame leaves, so
 *   the reply is found.
 *
 * Everything else is REAL: a real `BridgeServer` on a real loopback port, the
 * real per-cell preamble, the real client source, a real socket and a real
 * reader thread. Nothing about the client's `_send`, `call_sync`, `call_async`
 * or `_read_loop` is patched, stubbed or rewritten.
 *
 * THE ARMS, AND WHY EACH IS NEEDED:
 *   1. the LIVE client, sync  -- the gate. Must return the value.
 *   2. the PRE-FIX client, sync -- the control. Real pre-fix bytes, archived at
 *      `qualification/results/P2-waiter/dsh_bridge_client.before.py` and
 *      extracted mechanically from the pre-fix `bridge.ts`. MUST time out, and
 *      the reader must be observed discarding the reply. An arm that is never
 *      watched failing is not evidence, and this is that arm -- reproducible on
 *      every run instead of a one-time observation in a changelog.
 *   3. the LIVE client, async -- the same defect existed in `call_async`, so the
 *      same gate is applied to the async path.
 *   4. the PRE-FIX client, async -- its control.
 *   5. a scheduling-free arm that reads the ORDERING out of the live source text,
 *      so the gate cannot pass merely because this harness happens to work.
 *   6. a fail-closed arm for the `except BaseException` cleanup, which is easy to
 *      drop as decoration.
 *
 * WHAT THIS FILE DOES NOT CLAIM. See the report's CLAIMS I AM NOT MAKING. In
 * particular: this is a synchronised stand-in for the *timing*, not for the
 * transport; and a race fixed at the client says nothing about whether the host
 * can double-reply.
 */
import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BridgeServer, PYTHON_CLIENT_SOURCE } from './bridge.ts'
import { MemoryBridgeLedger } from './bridge-ledger.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const DRIVER = resolve(HERE, 'bri-waiter-driver.py')
const BEFORE_CLIENT = resolve(
  HERE, '..', '..', '..', 'qualification', 'results', 'P2-waiter', 'dsh_bridge_client.before.py',
)
const PYTHON = process.env['DSH_PYTHON'] ?? 'C:/Users/hzq00/AppData/Local/Programs/Python/Python314/python.exe'

/** What the driver reports. Every field is measured, none is inferred. */
interface DriverReport {
  readonly mode: string
  readonly ok: boolean
  readonly value?: { readonly marker: string, readonly tag: string }
  readonly error?: { readonly code: string, readonly message: string }
  readonly elapsedMs: number
  readonly sends: number
  readonly readerLookups: number
  readonly readerLookupsWithoutWaiter: number
  readonly callerCleanupPops: number
  readonly registrationSendCount: number | null
  readonly forcedWaitMs: number
  readonly readerWaitExpired: boolean
  readonly waitersAfter: number
}

let root: string
let bridge: BridgeServer | undefined
let clientPath = ''

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-p2-waiter-'))
  bridge = new BridgeServer({ artifactDirectory: join(root, 'artifacts') })
  clientPath = (await bridge.start()).clientPath
})

afterEach(async () => {
  if (bridge !== undefined) {
    await bridge.close().catch(() => undefined)
    bridge = undefined
  }
  await rm(root, { recursive: true, force: true })
})

/**
 * Run ONE bridge call through the real host, with `clientSource` as the client.
 *
 * WHY THIS IS ASYNC AND NOT `spawnSync`. The host that answers the call is the
 * `BridgeServer` in THIS process, so the Python child must be awaited while the
 * Node event loop stays free to serve it. A `spawnSync` here deadlocks on the
 * handshake: the child blocks waiting for a `hello_ack` that a blocked loop can
 * never write. That is not a hypothetical -- it is how the first version of this
 * file hung, and it is recorded because a reader who "simplifies" this back to
 * `spawnSync` will reproduce it.
 *
 * `timeoutSeconds` is passed to the Python call itself, so it bounds the caller's
 * wait for the REPLY and nothing else. The barrier's own budget is separate and
 * larger, which is why a lost reply is reported as TIMEOUT rather than as a
 * harness expiry.
 *
 * The variant client is installed by overwriting the file the PREAMBLE execs, so
 * the real preamble, the real bind, the real handshake and the real reader thread
 * are all the production ones; only the client's bytes differ.
 */
async function runDriver(
  mode: 'sync' | 'async' | 'sendfail',
  clientSource: string,
  timeoutSeconds: number,
): Promise<DriverReport> {
  const server = bridge
  if (server === undefined) throw new Error('the bridge server was not started')
  writeFileSync(clientPath, clientSource, 'utf8')

  const preamblePath = join(root, `preamble-${mode}.py`)
  const lease = server.mintLease({
    sessionId: 'session-bri-waiter',
    cellId: 'cell-bri-waiter',
    epoch: 1,
    outerCallId: String('ipython-call-bri-waiter'),
    rootCallId: String('ipython-call-bri-waiter'),
    ledger: new MemoryBridgeLedger(),
    // THE HOST REPLIES IMMEDIATELY, which is the premise of the case: the reply
    // is on the wire before a pre-fix caller can register. It is a real
    // `CellLease` invocation with real validation, a real ledger write and a
    // real serial queue -- only the tool body is trivial.
    handler: async call => ({
      ok: true,
      value: {
        marker: 'BRI-WAITER',
        tag: String((call.arguments as { tag?: unknown } | undefined)?.tag),
      },
    }),
  })
  writeFileSync(preamblePath, server.preamble(lease), 'utf8')

  const child = spawn(PYTHON, [DRIVER, mode, preamblePath, String(timeoutSeconds)], {
    env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (chunk: string) => { stdout += chunk })
  child.stderr.on('data', (chunk: string) => { stderr += chunk })

  // A ceiling well above the driver's own barrier budget plus the call timeout,
  // so a hung child is reported as a hung child rather than silently as a test
  // timeout with no output.
  const exit = await new Promise<{ code: number | null, signal: string | null }>((resolveExit, rejectExit) => {
    const timer = setTimeout(() => {
      child.kill()
      rejectExit(new Error(`the driver did not exit within 30s\nstdout: ${stdout}\nstderr: ${stderr}`))
    }, 30_000)
    child.once('exit', (code, signal) => { clearTimeout(timer); resolveExit({ code, signal }) })
    child.once('error', error => { clearTimeout(timer); rejectExit(error) })
  })
  if (exit.code !== 0) {
    throw new Error(`the driver exited ${String(exit.code)} (signal ${String(exit.signal)})\nstdout: ${stdout}\nstderr: ${stderr}`)
  }
  const line = stdout.trim().split('\n').filter(Boolean).pop() ?? ''
  if (line === '') throw new Error(`the driver produced no JSON\nstdout: ${stdout}\nstderr: ${stderr}`)
  return JSON.parse(line) as DriverReport
}

/**
 * The pre-fix client, read from the archived artifact.
 *
 * It is the bytes that were in `bridge.ts` before the fix -- extracted from the
 * template by `qualification/results/P2-waiter/extract-client-before.ts`, which
 * reads the source rather than copying it, so the archive cannot drift from the
 * tree it describes. The two assertions below keep the control arm honest: if the
 * archive ever became the FIXED client, the control would pass and would prove
 * nothing.
 */
async function beforeClientSource(): Promise<string> {
  const text = await readFile(BEFORE_CLIENT, 'utf8')
  expect(text).toContain('request_id = self._send(tool, arguments)\n        waiter = _SyncWaiter()')
  expect(text).not.toContain('def _send(self, tool, arguments, waiter)')
  return text
}

describe('BRI-WAITER an immediate reply cannot beat waiter registration', () => {
  it('the LIVE client returns the reply, and the waiter exists before the frame does (sync)', async () => {
    const report = await runDriver('sync', PYTHON_CLIENT_SOURCE, 10)

    // THE ORACLE: the value the host sent came back.
    expect(report.error).toBeUndefined()
    expect(report.ok).toBe(true)
    expect(report.value).toEqual({ marker: 'BRI-WAITER', tag: 'from-the-driver' })

    // AND THE ORDERING, measured rather than assumed. `registrationSendCount` is
    // how many frames were already on the wire when the waiter was registered;
    // 0 means the waiter existed first. This is V5 fact 13's question, answered
    // by the client's own execution rather than by reading the source.
    expect(report.registrationSendCount).toBe(0)

    // The reader really did run and really did look the reply up, so the pass is
    // not "the reader never ran".
    expect(report.readerLookups).toBeGreaterThan(0)
    expect(report.readerLookupsWithoutWaiter).toBe(0)
    expect(report.readerWaitExpired).toBe(false)
  }, 60_000)

  it('the PRE-FIX client loses the reply -- the control arm, watched failing', async () => {
    const report = await runDriver('sync', await beforeClientSource(), 0.4)

    // THE DEFECT, OBSERVED. The host answered; the caller never saw it.
    expect(report.ok).toBe(false)
    expect(report.error?.code).toBe('TIMEOUT')

    // AND THE MECHANISM, observed directly rather than inferred from the
    // timeout: the reader looked up the reply and found no waiter, so it
    // discarded it. This is the line that separates "the reply was lost by the
    // reader" from "the host was slow".
    //
    // The count is 1, not "at least 1": exactly one reply was delivered, and the
    // reader discarded exactly that one. `callerCleanupPops` is asserted
    // separately below so a caller's own timeout cleanup can never be mistaken
    // for the reader's discard.
    expect(report.readerLookups).toBe(1)
    expect(report.readerLookupsWithoutWaiter).toBe(1)
    expect(report.callerCleanupPops).toBe(1)

    // The barrier actually forced the interleaving in this run, so the failure
    // is caused by the injected scheduling and not by luck.
    expect(report.forcedWaitMs).toBeGreaterThan(0)
    expect(report.readerWaitExpired).toBe(false)

    // And the pre-fix ordering is visible in the same measurement: the frame was
    // already on the wire when the waiter was registered.
    expect(report.registrationSendCount).toBe(1)
  }, 60_000)

  it('the LIVE client returns the reply (async), and the PRE-FIX client loses it', async () => {
    const live = await runDriver('async', PYTHON_CLIENT_SOURCE, 10)
    expect(live.error).toBeUndefined()
    expect(live.ok).toBe(true)
    expect(live.value).toEqual({ marker: 'BRI-WAITER', tag: 'from-the-driver' })
    expect(live.registrationSendCount).toBe(0)
    expect(live.readerLookupsWithoutWaiter).toBe(0)

    const before = await runDriver('async', await beforeClientSource(), 0.4)
    expect(before.ok).toBe(false)
    expect(before.error?.code).toBe('TIMEOUT')
    expect(before.readerLookups).toBe(1)
    expect(before.readerLookupsWithoutWaiter).toBe(1)
    expect(before.callerCleanupPops).toBe(1)
    expect(before.forcedWaitMs).toBeGreaterThan(0)
    expect(before.registrationSendCount).toBe(1)
  }, 90_000)

  it('the live source registers the waiter BEFORE it writes the frame (scheduling-free)', () => {
    // WHY THIS ARM EXISTS ON TOP OF THE BEHAVIOURAL ONES. The arms above would
    // stay green if the fix were replaced by anything that happened to work under
    // this harness, and they say nothing about the shape of the code a reader
    // will maintain. This arm reads the ordering straight out of the source:
    // inside `_send`, the registration line must come before the send.
    const sendBody = /def _send\(self, tool, arguments, waiter\):([\s\S]*?)\n    def /.exec(PYTHON_CLIENT_SOURCE)?.[1]
    expect(sendBody).toBeDefined()
    const body = sendBody ?? ''
    const registration = body.indexOf('self._waiters[request_id] = waiter')
    const wire = body.indexOf('sock.sendall(')
    expect(registration).toBeGreaterThan(-1)
    expect(wire).toBeGreaterThan(-1)
    expect(registration).toBeLessThan(wire)

    // And no caller registers a waiter for itself any more, which is what would
    // reintroduce a post-send window if one of them did.
    const callers = PYTHON_CLIENT_SOURCE.slice(PYTHON_CLIENT_SOURCE.indexOf('def call_sync'))
    const syncBody = callers.slice(0, callers.indexOf('async def call_async'))
    expect(syncBody).not.toContain('self._waiters[')
    const asyncBody = callers.slice(callers.indexOf('async def call_async'))
    expect(asyncBody).not.toMatch(/_waiters\[[^\]]*\]\s*=/)
  })

  it('the fix fails closed when the send itself fails: no waiter is left behind', async () => {
    // A REGRESSION ARM FOR THE `except BaseException` ARM, which is easy to drop
    // as decoration. If `sendall` raises after the waiter was registered, the
    // waiter must be removed: leaving it would make a later caller wait out its
    // full timeout for a request that was never sent.
    //
    // The injection is a `sendall` that raises, installed by the driver's
    // `sendfail` mode over the REAL socket object. It is stated as an injection
    // because it is one: this arm measures the client's cleanup, not a transport
    // failure the OS produced.
    const report = await runDriver('sendfail', PYTHON_CLIENT_SOURCE, 0.4)
    expect(report.ok).toBe(false)
    // Loud, not a timeout: the caller learns the send failed.
    expect(report.error?.code).toBe('OSError')
    expect(report.waitersAfter).toBe(0)
  }, 60_000)
})
