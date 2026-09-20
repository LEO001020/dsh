/**
 * S6 / IPY-15 raw measurement driver: the transport facts, the over-limit frame in
 * BOTH directions, and the recovery half -- against a REAL live kernel.
 *
 * WHY A DRIVER AND NOT ONLY THE TEST. `s6-ipy15.test.ts` asserts; this RECORDS.
 * Every value below is printed as JSON so the report can cite numbers rather than
 * a green tick, and so a later reader can re-run one command and compare. The
 * BEFORE values are archived separately under
 * `qualification/results/S6-ipy15/before/`, captured with the fixes reverted.
 *
 * WHAT "OVER-LIMIT" MEANS, FROM THE SOURCE. `MAX_FRAME_BYTES` = 4 MiB, declared in
 * two places that must agree: `protocol.ts:41` (host) and `broker.py:47` (broker).
 * The bound belongs to the host<->broker CONTROL channel. It is NOT the kernel's
 * own ZMQ message limit -- see the report's "claims I am not making".
 *
 * THE SECURITY CONSTRAINT. The connection file carries the HMAC key that
 * authorises execution. This driver NEVER extracts the key's value: the one place
 * the file is parsed is inside the kernel process, and the fields read are
 * presence and LENGTH. `icacls` reports principals and rights, never contents.
 *
 * RUN: node src/s6-ipy15-measure.ts
 */
import { Context } from '@deepseek-ai/cordis'
import Subprocess from '@deepseek-ai/dsh-subprocess-local'
import { execFileSync } from 'node:child_process'
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { KernelHost } from './kernel.ts'
import { encodeFrame, FrameDecoder, MAX_FRAME_BYTES } from './protocol.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const BROKER = resolve(HERE, 'broker.py')
const PYTHON = process.env['DSH_PYTHON']
  ?? 'C:/Users/hzq00/AppData/Local/Programs/Python/Python314/python.exe'

const REPO_ROOT = resolve(HERE, '..', '..', '..')
const EVIDENCE = process.env['S6_EVIDENCE_DIR']
  ?? join(REPO_ROOT, 'qualification', 'results', 'S6-ipy15')
const TAG = process.env['S6_TAG'] ?? 'after'

const observed: Record<string, unknown> = {}

function record(key: string, value: unknown): void {
  observed[key] = value
  process.stdout.write(`[fact] ${key} = ${JSON.stringify(value)}\n`)
}

/** Read one length-prefixed frame from a byte stream, with a hard deadline. */
function readFrame(stream: NodeJS.ReadableStream, timeoutMs: number): Promise<unknown> {
  return new Promise((resolve_, reject_) => {
    let buffer = Buffer.alloc(0)
    const timer = setTimeout(() => {
      stream.removeListener('data', onData)
      reject_(new Error('no frame within the deadline'))
    }, timeoutMs)
    const onData = (chunk: Buffer): void => {
      buffer = Buffer.concat([buffer, chunk])
      if (buffer.byteLength < 4) return
      const length = buffer.readUInt32BE(0)
      if (buffer.byteLength < 4 + length) return
      clearTimeout(timer)
      stream.removeListener('data', onData)
      resolve_(JSON.parse(buffer.subarray(4, 4 + length).toString('utf8')))
    }
    stream.on('data', onData)
  })
}

/**
 * The connection file's own facts, read INSIDE the kernel process.
 *
 * The path comes from the kernel's own argv (`-f`), not from the manager's
 * request: a manager that ignored the policy would otherwise be recorded as
 * encrypted. The key's VALUE is never extracted -- only presence and length.
 */
const CONNECTION_FACTS_CELL = [
  'import json, os, stat, sys',
  'path = None',
  'for i, arg in enumerate(sys.argv):',
  '    if arg == "-f" and i + 1 < len(sys.argv):',
  '        path = sys.argv[i + 1]',
  'facts = {"connection_file": path}',
  'if path is not None:',
  '    with open(path, encoding="utf-8") as handle:',
  '        doc = json.load(handle)',
  '    facts["transport_in_file"] = doc.get("transport")',
  '    facts["has_curve_publickey"] = "curve_publickey" in doc',
  '    facts["has_curve_secretkey"] = "curve_secretkey" in doc',
  '    facts["signature_scheme"] = doc.get("signature_scheme")',
  // PRESENCE AND LENGTH ONLY. The value of `key` is the execution capability.
  '    facts["key_present"] = bool(doc.get("key"))',
  '    facts["key_length_chars"] = len(doc.get("key") or "")',
  '    facts["top_level_keys"] = sorted(doc.keys())',
  '    facts["st_mode_octal"] = oct(stat.S_IMODE(os.stat(path).st_mode))',
  '    facts["os_name"] = os.name',
  'print("S6FACTS:" + json.dumps(facts, sort_keys=True))',
].join('\n')

function parseTagged(text: string, tag: string): Record<string, unknown> {
  for (const line of text.split(/\r?\n/)) {
    const at = line.indexOf(`${tag}:`)
    if (at >= 0) return JSON.parse(line.slice(at + tag.length + 1)) as Record<string, unknown>
  }
  throw new Error(`no ${tag} line in output`)
}

async function main(): Promise<void> {
  const ctx = new Context()
  await ctx.plugin(Subprocess)
  const root = mkdtempSync(join(tmpdir(), 's6-ipy15-measure-'))

  const unhandled: string[] = []
  process.on('unhandledRejection', (reason: unknown) => { unhandled.push(String(reason).slice(0, 200)) })

  const host = new KernelHost({
    subprocess: ctx.subprocess,
    identity: { sessionId: 's6-ipy15', executionWorld: 'local', environmentDigest: 's6' },
    brokerScript: BROKER,
    pythonExecutable: PYTHON,
    workingDirectory: root,
    cellTimeoutMs: 5_000,
    interruptGraceMs: 2_000,
  })

  try {
    // ---- (1) THE TRANSPORT FACTS, from a real live kernel --------------------
    const status = await host.start()
    record('status_transport', status.transport)
    record('status_curveKeysPresent', status.curveKeysPresent)
    record('status_plaintextWarningSeen', status.plaintextWarningSeen)
    record('status_alive', status.alive)
    record('status_kernel_pid', status.pid ?? null)

    const facts = await host.execute(CONNECTION_FACTS_CELL)
    const f = parseTagged(facts.stdout.text, 'S6FACTS')
    for (const k of [
      'connection_file', 'transport_in_file', 'has_curve_publickey', 'has_curve_secretkey',
      'signature_scheme', 'key_present', 'key_length_chars', 'top_level_keys',
      'st_mode_octal', 'os_name',
    ]) record(`cf_${k}`, f[k])

    // ---- (2) THE CONNECTION FILE'S ENFORCED PERMISSION (an ACL) --------------
    // `st_mode` is NOT the permission on Windows: CPython synthesizes it from the
    // read-only attribute, so a plain file in %TEMP% reports `0o666` with
    // `S_IROTH` set. The ACL is what the OS enforces.
    const connectionFile = String(f['connection_file'])
    const acl = execFileSync('icacls', [connectionFile], { encoding: 'utf8', windowsHide: true })
    const controlPath = join(root, 's6-acl-control.txt')
    writeFileSync(controlPath, 'control')
    const controlAcl = execFileSync('icacls', [controlPath], { encoding: 'utf8', windowsHide: true })
    const worldPrincipals = /Everyone|BUILTIN\\Users|Authenticated Users/i
    record('acl_grants_no_world_principal', !worldPrincipals.test(acl))
    record('acl_mentions_owner', /hzq00/i.test(acl))
    record('acl_control_arm_differs', controlAcl !== acl)
    record('acl_raw', acl.trim())
    record('acl_control_raw', controlAcl.trim())

    // ---- (3) HOST -> BROKER: the ENCODE direction ---------------------------
    // The refusal must happen BEFORE any byte is produced: a refusal that had
    // already written a partial frame would desynchronise the reader. The byte
    // count is MEASURED, not hardcoded.
    let encodeRefused = false
    let bytesProduced = 0
    try {
      const frame = encodeFrame({ id: 's6', op: 'execute', code: 'x'.repeat(MAX_FRAME_BYTES + 1) })
      bytesProduced = frame.byteLength
    } catch (error) {
      encodeRefused = true
      record('hostToBroker_refusalErrorName', error instanceof Error ? error.name : String(error))
    }
    record('hostToBroker_encodeRefused', encodeRefused)
    record('hostToBroker_bytesProducedOnRefusal', bytesProduced)

    // ---- (4) BROKER -> HOST: the DECODE direction ---------------------------
    // A 4-byte header claiming more than the bound, with NO payload: a reader that
    // trusted the prefix would block for bytes that never come.
    const decodeErrors: string[] = []
    const decoded: unknown[] = []
    const decoder = new FrameDecoder(v => { decoded.push(v) }, e => { decodeErrors.push(e.message) })
    const header = Buffer.alloc(4)
    header.writeUInt32BE(MAX_FRAME_BYTES + 1, 0)
    decoder.push(header)
    record('brokerToHost_decodeRefused', decodeErrors.length > 0)
    record('brokerToHost_decodeError', decodeErrors[0] ?? null)
    record('brokerToHost_decodedFrameCount', decoded.length)
    record('brokerToHost_decoderFailed', decoder.failed)

    // ---- (5) RECOVERY after the framing-layer refusals ----------------------
    // THE HALF THAT DISTINGUISHES "rejects safely" FROM "dies".
    const after = await host.execute('print("s6-ipy15-still-usable")')
    record('after_over_limit_outcome', after.outcome)
    record('after_over_limit_stdout', after.stdout.text.trim())
    record('after_over_limit_epoch', after.epoch)
    record('kernelStillUsableAfterFramingRefusal', after.outcome === 'ok')

    // ---- (6) A REFUSED REQUEST MUST NOT LEAK A PENDING ENTRY ----------------
    // `request` registers a pending entry with a timer, then encodes. When the
    // encode was evaluated inside the write call, a refusal threw with the entry
    // already registered: nothing removed it, and `shutdown`'s `failAll` later
    // rejected it into no handler. The observable symptom is an unhandled
    // rejection, so that is what is captured.
    let refused = false
    try {
      await host.execute('x'.repeat(MAX_FRAME_BYTES + 1))
    } catch {
      refused = true
    }
    record('overLimitRequest_refused', refused)
    const recoveryAfterRefusal = await host.execute('print("s6-recovery")')
    record('recoveryAfterRefusedRequest_outcome', recoveryAfterRefusal.outcome)

    // ---- (7) AN OVER-LIMIT FRAME THAT ACTUALLY ARRIVES ---------------------
    // A different code path from the host's decoder: the broker's read loop. The
    // frame is written RAW to the real control socket, because the host's own
    // encoder refuses to build it -- which is exactly what a peer that does not
    // share our bound does.
    const declared = MAX_FRAME_BYTES + 1024
    const handle = (host as unknown as { handle?: { control?: NodeJS.WritableStream } }).handle
    const controlStream = handle?.control
    if (controlStream === undefined) throw new Error('the host exposes no control channel')
    const huge = Buffer.alloc(declared, 0x61)
    const rawHeader = Buffer.alloc(4)
    rawHeader.writeUInt32BE(huge.byteLength, 0)
    controlStream.write(Buffer.concat([rawHeader, huge]))
    record('rawFrame_declaredBytes', declared)

    const exitWaitStart = Date.now()
    while (host.unexpectedExit === undefined && Date.now() - exitWaitStart < 20_000) {
      await new Promise(resolve_ => setTimeout(resolve_, 150))
    }
    record('brokerExit_registered_after_ms', Date.now() - exitWaitStart)
    record('host_unexpectedExit', host.unexpectedExit ?? null)

    // THE STRUCTURED REFUSAL, as the HOST recorded it -- not as the broker
    // printed it. An event the host cannot decode would be reported as a
    // malformed frame, so this is the only reading that proves it is usable.
    record('host_transportRefusals', host.transportRefusals)
    record('host_refusalCode', host.transportRefusals[0]?.code ?? null)
    record('host_refusalLimitBytes', host.transportRefusals[0]?.limitBytes ?? null)
    record('host_refusalDeclaredBytes', host.transportRefusals[0]?.declaredBytes ?? null)
    record('host_controlChannelErrors', host.controlChannelErrors.slice(0, 3))
    record('brokerDiagnostics_hasLimit', host.diagnosticsText.includes('exceeds the limit'))

    // ---- (8) RECOVERY AFTER THE BROKER DIED --------------------------------
    // Measured before the fix: the next request registered a fresh pending entry
    // that nothing could reject, so it waited its whole budget (62 015 ms against
    // a predicted 62 000 ms) to learn something the host already knew.
    const cellStart = Date.now()
    const failure = await host.execute('print("s6-after-death")')
      .then(() => undefined)
      .catch((error: unknown) => error as Error)
    record('cellAfterBrokerDeath_waitedMs', Date.now() - cellStart)
    record('cellAfterBrokerDeath_errorName', failure?.name ?? null)
    record('cellAfterBrokerDeath_errorMessage', failure?.message ?? null)

    // Give any rejection raised by shutdown a turn to be recorded. SHUTDOWN IS
    // RACED AND TIMED, so this reading is comparable with the BEFORE half: there
    // it did not complete within an 8 s ceiling against a broker that had already
    // exited. Measuring it the same way on both sides is what makes the pair a
    // comparison rather than two unrelated numbers.
    const shutdownStart = Date.now()
    const shutdownOutcome = await Promise.race([
      host.shutdown().then(() => 'resolved' as const).catch(() => 'threw' as const),
      new Promise<'hung'>(resolve_ => { setTimeout(() => resolve_('hung'), 8_000) }),
    ])
    record('shutdownOutcome', shutdownOutcome)
    record('shutdown_waitedMs', Date.now() - shutdownStart)
    await new Promise(resolve_ => setTimeout(resolve_, 500))
    record('unhandledRejectionCount', unhandled.length)
    record('unhandledRejections', unhandled.slice(0, 3))
    record('maxFrameBytes', MAX_FRAME_BYTES)
  } catch (error) {
    record('probeError', error instanceof Error ? error.message.slice(0, 300) : String(error))
  } finally {
    record('armComplete', true)
  }

  mkdirSync(join(EVIDENCE, TAG), { recursive: true })
  writeFileSync(join(EVIDENCE, TAG, 'transport-and-frame-bound.json'), `${JSON.stringify(observed, null, 2)}\n`)
  appendFileSync(join(EVIDENCE, 'measurement-runs.jsonl'), `${JSON.stringify({ tag: TAG, observed })}\n`)
  console.log(`[S6-IPY15] wrote ${join(EVIDENCE, TAG, 'transport-and-frame-bound.json')}`)
}

await main()
// A HARD EXIT. Teardown against a broker that exited without the host being told
// is one of the states being measured; awaiting it here would replace the
// measurement with a hang.
process.exit(0)
