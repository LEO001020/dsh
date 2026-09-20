/**
 * IPY-15 (S6): the kernel transport is authenticated, frames are bounded, and an
 * over-limit frame does not cost the session.
 *
 * WHY THIS FILE EXISTS SEPARATELY from the `IPY-15` block in `v3-spec-gates.test.ts`.
 * That gate establishes the transport facts and the framing bound. What it could
 * NOT establish is everything that needs a REAL over-limit frame delivered to a
 * REAL peer:
 *
 *   1. the connection file's ENFORCED permission (an ACL, not `st_mode`);
 *   2. that the broker's read loop refuses an over-limit frame by NAME;
 *   3. that the host does not leak a pending entry when it refuses to encode;
 *   4. that a request after the broker died is refused PROMPTLY, not after its
 *      whole budget;
 *   5. that a control channel whose peer exited does not kill the host process.
 *
 * Each of 2-5 was measured as a DEFECT before being fixed, and each arm below is
 * written so that reverting the fix turns it red. The measured before/after pairs
 * are archived under `qualification/results/S6-ipy15/`.
 *
 * WHAT "OVER-LIMIT" MEANS, FROM THE SOURCE. `MAX_FRAME_BYTES` = 4 MiB, declared
 * twice and required to agree: `protocol.ts:41` (host) and `broker.py:47`
 * (broker). The bound belongs to the host<->broker CONTROL channel. It is NOT the
 * kernel's own ZMQ message limit -- see the report's "claims I am not making".
 *
 * THE SECURITY CONSTRAINT. The connection file carries the HMAC key that
 * authorises execution. NOTHING in this file reads the key's value: the one place
 * the file is parsed is inside the kernel process, and the fields extracted are
 * presence and LENGTH. A test that echoed the file would put a credential in an
 * artifact directory, which is worse than not testing it.
 *
 * CPU DISCIPLINE. One kernel per test; every host shut down in `afterEach`.
 */
import { Context } from '@deepseek-ai/cordis'
import Subprocess from '@deepseek-ai/dsh-subprocess-local'
import { execFileSync } from 'node:child_process'
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { KernelHost } from './kernel.ts'
import { encodeFrame, FrameDecoder, MAX_FRAME_BYTES } from './protocol.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const BROKER = resolve(HERE, 'broker.py')
const PYTHON = process.env['DSH_PYTHON']
  ?? 'C:/Users/hzq00/AppData/Local/Programs/Python/Python314/python.exe'

let ctx: Context
let root: string
let host: KernelHost | undefined

beforeEach(async () => {
  ctx = new Context()
  await ctx.plugin(Subprocess)
  root = await mkdtemp(join(tmpdir(), 's6-ipy15-'))
})

afterEach(async () => {
  if (host !== undefined) {
    await host.shutdown().catch(() => undefined)
    host = undefined
  }
  await ctx.fiber.dispose()
  await rm(root, { recursive: true, force: true })
})

function makeHost(options: Record<string, unknown> = {}): KernelHost {
  host = new KernelHost({
    subprocess: ctx.subprocess,
    identity: { sessionId: 's6-ipy15', executionWorld: 'local', environmentDigest: 's6-env' },
    brokerScript: BROKER,
    pythonExecutable: PYTHON,
    workingDirectory: root,
    ...options,
  })
  return host
}

/** Reach the host's own control channel, which is the real socket to the broker. */
function controlOf(h: KernelHost): NodeJS.WritableStream {
  const stream = (h as unknown as { handle?: { control?: NodeJS.WritableStream } }).handle?.control
  if (stream === undefined) throw new Error('the host exposes no control channel')
  return stream
}

/** Write a frame the host's own encoder would refuse, so it reaches the broker. */
function writeRawOverLimitFrame(stream: NodeJS.WritableStream, bytes: number): void {
  const payload = Buffer.alloc(bytes, 0x61)
  const header = Buffer.alloc(4)
  header.writeUInt32BE(payload.byteLength, 0)
  stream.write(Buffer.concat([header, payload]))
}

async function waitForExit(h: KernelHost, budgetMs = 20_000): Promise<void> {
  const started = Date.now()
  while (h.unexpectedExit === undefined && Date.now() - started < budgetMs) {
    await new Promise(resolve_ => setTimeout(resolve_, 150))
  }
}

describe('IPY-15: the transport is authenticated and the connection file is owner-only', () => {
  it('the live kernel reports curve-encrypted tcp, and the connection file ACL grants no other user', async () => {
    const h = makeHost()
    const status = await h.start()

    // ---- (1) the transport facts, from the LIVE kernel ---------------------
    // Read from the connection file the kernel was actually handed (`sys.argv -f`),
    // not from the manager's request: a manager that ignored the policy would
    // otherwise be recorded as encrypted.
    const facts = await h.execute([
      'import json, os, sys',
      'path = None',
      'for i, arg in enumerate(sys.argv):',
      '    if arg == "-f" and i + 1 < len(sys.argv):',
      '        path = sys.argv[i + 1]',
      'info = {"connection_file": path}',
      'if path is not None:',
      '    with open(path, encoding="utf-8") as handle:',
      '        doc = json.load(handle)',
      '    info["transport"] = doc.get("transport")',
      '    info["has_curve_publickey"] = "curve_publickey" in doc',
      '    info["has_curve_secretkey"] = "curve_secretkey" in doc',
      '    info["signature_scheme"] = doc.get("signature_scheme")',
      // PRESENCE AND LENGTH ONLY -- never the value.
      '    info["key_present"] = bool(doc.get("key"))',
      '    info["key_length_chars"] = len(doc.get("key") or "")',
      'print("S6FACTS:" + json.dumps(info, sort_keys=True))',
    ].join('\n'))
    expect(facts.outcome).toBe('ok')
    const factsLine = facts.stdout.text.split(/\r?\n/).find(line => line.includes('S6FACTS:'))!
    const info = JSON.parse(factsLine.slice(factsLine.indexOf('S6FACTS:') + 'S6FACTS:'.length)) as
      Record<string, unknown>

    console.log('[S6-MEASURED] ipy15-transport ' + JSON.stringify({
      transport: status.transport,
      curveKeysPresent: status.curveKeysPresent,
      plaintextWarningSeen: status.plaintextWarningSeen,
      transportInFile: info['transport'],
      hasCurvePublic: info['has_curve_publickey'],
      hasCurveSecret: info['has_curve_secretkey'],
      signatureScheme: info['signature_scheme'],
      keyPresent: info['key_present'],
      keyLengthChars: info['key_length_chars'],
    }))

    // (1a) The transport is TCP or IPC WITH curve keys, and no plaintext warning.
    //      Plaintext TCP would be the recorded FINDING and NOT PASS, so the
    //      absence of the warning is asserted rather than assumed.
    expect(['tcp', 'ipc']).toContain(status.transport)
    expect(status.curveKeysPresent).toBe(true)
    expect(status.plaintextWarningSeen).toBe(false)
    expect(info['transport']).toBe(status.transport)
    expect(info['has_curve_publickey']).toBe(true)
    expect(info['has_curve_secretkey']).toBe(true)
    expect(info['key_present']).toBe(true)
    expect(info['key_length_chars']).toBeGreaterThan(0)

    // ---- (2) the ENFORCED permission, which is an ACL on this platform -----
    // `st_mode` is NOT the permission here: Windows CPython synthesizes it from
    // the read-only attribute, so a plain file in %TEMP% reports `0o666` with
    // `S_IROTH` set. Reporting that as "world-readable" would give a real number a
    // false meaning, so the ACL is read instead -- `icacls` reports what the OS
    // will enforce.
    const connectionFile = String(info['connection_file'])
    const acl = execFileSync('icacls', [connectionFile], { encoding: 'utf8', windowsHide: true })

    // THE CONTROL FOR THIS MEASUREMENT. The same command on a file this test
    // created plainly. If `icacls` returned the same string for both, the reading
    // could not distinguish a restricted file from an unrestricted one.
    const controlPath = join(root, 's6-acl-control.txt')
    await writeFile(controlPath, 'control', 'utf8')
    const controlAcl = execFileSync('icacls', [controlPath], { encoding: 'utf8', windowsHide: true })

    const worldPrincipals = /Everyone|BUILTIN\\Users|Authenticated Users/i
    const stMode = (await stat(connectionFile)).mode

    console.log('[S6-MEASURED] ipy15-connection-file ' + JSON.stringify({
      connectionFile,
      aclGrantsNoWorldPrincipal: !worldPrincipals.test(acl),
      aclMentionsOwner: /hzq00/i.test(acl),
      controlAclDiffersFromConnectionFileAcl: controlAcl !== acl,
      stModeOctal: `0o${(stMode & 0o777).toString(8)}`,
      stModeIsPlatformArtifact: process.platform === 'win32',
    }))

    // (2a) The connection file grants no WORLD principal. `BUILTIN\Administrators`
    //      is deliberately NOT asserted against: it is the OS's own elevation
    //      path on this platform, and this deployment's execution authority
    //      boundary is the OS user account, not a sandbox. Claiming the file is
    //      unreadable by an administrator would be a claim about Windows, not
    //      about this product.
    expect(worldPrincipals.test(acl)).toBe(false)
    // (2b) The owner is named, so the ACL is not an empty or malformed reading.
    expect(/hzq00/i.test(acl)).toBe(true)
    // (2c) The control arm: the two readings DIFFER, so this check can distinguish
    //      a restricted file from an unrestricted one.
    expect(controlAcl).not.toBe(acl)
    // (2d) And the recorded reason the mode bits are not asserted: on Windows they
    //      are synthesized, so a `0o666` here carries no permission meaning.
    if (process.platform === 'win32') {
      expect((stMode & 0o777)).toBe(0o666)
    }
  }, 180_000)
})

describe('IPY-15: an over-limit frame is refused by name in both directions, and the session survives', () => {
  it('the host refuses to encode it, the decoder refuses to buffer it, and a normal cell still runs', async () => {
    const h = makeHost()
    await h.start()

    // ---- (1) HOST -> BROKER: the encode direction --------------------------
    // The refusal must happen BEFORE any byte is produced, because a refusal that
    // had already written a partial frame would desynchronise the reader. The
    // count is measured, not assumed.
    let encodeRefused = false
    let bytesProduced = 0
    try {
      const frame = encodeFrame({ id: 'x', op: 'execute', code: 'x'.repeat(MAX_FRAME_BYTES + 1) })
      bytesProduced = frame.byteLength
    } catch {
      encodeRefused = true
    }

    // ---- (2) BROKER -> HOST: the decode direction --------------------------
    // A header claiming more than the bound with NO payload: a reader that trusted
    // the prefix would wait for bytes that never arrive.
    const decodeErrors: string[] = []
    const decoded: unknown[] = []
    const decoder = new FrameDecoder(v => { decoded.push(v) }, e => { decodeErrors.push(e.message) })
    const header = Buffer.alloc(4)
    header.writeUInt32BE(MAX_FRAME_BYTES + 1, 0)
    decoder.push(header)

    // ---- (3) RECOVERY: the session is still usable ------------------------
    const after = await h.execute('print("s6-after-over-limit")')

    console.log('[S6-MEASURED] ipy15-both-directions ' + JSON.stringify({
      maxFrameBytes: MAX_FRAME_BYTES,
      encodeRefused,
      bytesProducedOnRefusal: bytesProduced,
      decodeRefused: decodeErrors.length > 0,
      decodeError: decodeErrors[0] ?? null,
      decodedFrameCount: decoded.length,
      decoderFailed: decoder.failed,
      recoveryOutcome: after.outcome,
      recoveryStdout: after.stdout.text.trim(),
    }))

    expect(encodeRefused).toBe(true)
    expect(bytesProduced).toBe(0)
    expect(decodeErrors.length).toBeGreaterThan(0)
    expect(decodeErrors[0]).toContain('exceeds')
    expect(decoded.length).toBe(0)
    // RECOVERY IS THE POINT: a refusal that cost the session would not be safe.
    expect(after.outcome).toBe('ok')
    expect(after.stdout.text).toContain('s6-after-over-limit')
  }, 180_000)

  it('a REFUSED request leaves no pending entry behind (the leak that escaped shutdown)', async () => {
    const h = makeHost()
    await h.start()

    // THE ARM. `request` registers a pending entry with a timer and then encodes.
    // When the encode is evaluated inside the write call, a refusal throws with
    // the entry already registered: nothing removes it, and `shutdown`'s `failAll`
    // later rejects it into no handler. The observable symptom is an unhandled
    // rejection, so that is what is captured.
    const unhandled: string[] = []
    const onUnhandled = (reason: unknown): void => { unhandled.push(String(reason)) }
    process.on('unhandledRejection', onUnhandled)
    try {
      let refused = false
      try {
        await h.execute('x'.repeat(MAX_FRAME_BYTES + 1))
      } catch {
        refused = true
      }
      expect(refused).toBe(true)

      // The session must be unaffected: the refusal belongs to the frame, not to
      // the kernel.
      const after = await h.execute('print("s6-leak-recovery")')
      expect(after.outcome).toBe('ok')

      // `shutdown` is where the orphaned entry would be rejected into nothing.
      await h.shutdown()
      host = undefined
      // Give the rejection a turn to be delivered.
      await new Promise(resolve_ => setTimeout(resolve_, 300))

      console.log('[S6-MEASURED] ipy15-refused-request-leak ' + JSON.stringify({
        unhandledRejectionCount: unhandled.length,
        unhandledRejections: unhandled.slice(0, 3),
      }))

      // THE ASSERTION. Before the fix this was 1 ("KernelTransportError: the
      // kernel host was shut down"); after it, 0.
      expect(unhandled).toEqual([])
    } finally {
      process.removeListener('unhandledRejection', onUnhandled)
    }
  }, 180_000)
})

describe('IPY-15: an over-limit frame that actually ARRIVES is refused by name, and the broker does not die silently', () => {
  it('the broker names FRAME_TOO_LARGE, tells the host, and the host refuses the next cell promptly', async () => {
    const h = makeHost({ cellTimeoutMs: 3_000, interruptGraceMs: 1_000 })
    await h.start()

    // CONTROL ARM: the host works before the stimulus, so nothing below can be
    // attributed to a host that never functioned.
    const before = await h.execute('print("s6-before-raw")')
    expect(before.outcome).toBe('ok')

    // THE STIMULUS: a real over-limit frame on the real control socket. The
    // host's encoder would refuse it, so it is written raw -- which is exactly
    // what a peer that does not share our bound does.
    const declared = MAX_FRAME_BYTES + 1024
    writeRawOverLimitFrame(controlOf(h), declared)
    await waitForExit(h)

    // ---- (1) the broker exited, and the host registered the death ----------
    expect(h.unexpectedExit).toBeDefined()

    // ---- (2) the refusal is NAMED, and it reached the HOST -----------------
    // Not merely printed to the broker's stderr: an event the host cannot decode
    // would make it report a malformed frame instead of a bounded refusal.
    console.log('[S6-MEASURED] ipy15-structured-refusal ' + JSON.stringify({
      unexpectedExit: h.unexpectedExit ?? null,
      transportRefusals: h.transportRefusals,
      controlChannelErrors: h.controlChannelErrors.slice(0, 3),
    }))

    expect(h.transportRefusals.length).toBeGreaterThan(0)
    const refusal = h.transportRefusals[0]!
    expect(refusal.code).toBe('FRAME_TOO_LARGE')
    expect(refusal.limitBytes).toBe(MAX_FRAME_BYTES)
    expect(refusal.declaredBytes).toBe(declared)

    // ---- (3) RECOVERY: the next cell is refused PROMPTLY and by name -------
    // Measured before the fix: the request registered a fresh pending entry that
    // nothing could reject, so it waited its whole budget -- 62 015 ms against a
    // predicted 62 000 ms -- to learn something the host already knew. In this
    // product the host is the model's own process, so that is a wedged turn.
    const startedAt = Date.now()
    const failure = await h.execute('print("s6-after-death")')
      .then(() => undefined)
      .catch((error: unknown) => error as Error)
    const waitedMs = Date.now() - startedAt

    console.log('[S6-MEASURED] ipy15-after-broker-death ' + JSON.stringify({
      waitedMs,
      errorName: failure?.name ?? null,
      errorMessage: failure?.message ?? null,
    }))

    expect(failure).toBeDefined()
    expect(failure?.name).toBe('KernelTransportError')
    expect(failure?.message).toContain('broker is not running')
    // THE BOUND ON THE FIX: prompt means far below the request budget, which is
    // `cellTimeoutMs + interruptGraceMs + 60_000` = 64 000 ms here. A generous
    // 5 s ceiling still fails loudly if the wait returns.
    expect(waitedMs).toBeLessThan(5_000)

    // ---- (4) the control channel's failure did not kill the host ----------
    // A write to a peer that has exited raises `write EOF`. With no 'error'
    // listener that is an uncaught exception, which in this product takes down the
    // model's own process. Its presence in this list is the proof it was caught.
    expect(h.controlChannelErrors.length).toBeGreaterThan(0)
  }, 180_000)
})
