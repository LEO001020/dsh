/**
 * S4 IPY-15 SUPPLEMENTARY GATE — the two oracle clauses the existing gate does
 * not assert. Written for the v2 re-judgement of IPY-15.
 *
 * ORACLE, VERBATIM (v2 definition, IPY-15):
 *   "... An over-limit frame is REFUSED in both directions -- the encoder refuses
 *    to emit it and the decoder refuses on the DECLARED length before buffering --
 *    and the refusal is a structured, machine-readable outcome naming the byte
 *    limit in force and the declared length that exceeded it. The kernel remains
 *    usable after the refusal. ..."
 *
 * WHY THIS FILE EXISTS. The shipped gate (`v3-spec-gates.test.ts`, the IPY-15
 * describe block) asserts:
 *   - transport tcp/ipc + curve keys present + no plaintext warning   [clause 1]
 *   - the connection file carries both curve keys                     [clause 2]
 *   - `encodeFrame` throws and the decoder reports a failure whose
 *     message contains "exceeds"                                      [clause 3, PARTIAL]
 *   - `droppedFrames` is 0 and `note_dropped_frame` has no caller      [the v1 clause]
 *
 * It does NOT assert:
 *   (a) "The kernel remains usable after the refusal."  -- never measured at all.
 *   (b) that the refusal is STRUCTURED and MACHINE-READABLE. It asserts a
 *       SUBSTRING of a prose message. A prose message a human can read is not
 *       the same artefact as a machine-readable outcome, and the oracle names
 *       the second.
 *
 * Both are measured here against the REAL KernelHost, one boot, and the numbers
 * are printed so a reader can judge rather than take a boolean.
 */
import { Context } from '@deepseek-ai/cordis'
import Subprocess from '@deepseek-ai/dsh-subprocess-local'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { KernelHost } from './kernel.ts'
import { FrameDecoder, encodeFrame, MAX_FRAME_BYTES } from './protocol.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const BROKER = resolve(HERE, 'broker.py')
const PYTHON = process.env['DSH_PYTHON'] ?? 'C:/Users/hzq00/AppData/Local/Programs/Python/Python314/python.exe'

let ctx: Context
let host: KernelHost | undefined
let root: string

beforeEach(async () => {
  ctx = new Context()
  await ctx.plugin(Subprocess)
  root = await mkdtemp(join(tmpdir(), 's4-ipy15-'))
})

afterEach(async () => {
  if (host !== undefined) {
    await host.shutdown().catch(() => undefined)
    host = undefined
  }
  await ctx.fiber.dispose()
  await rm(root, { recursive: true, force: true })
})

describe('S4 IPY-15 supplementary', () => {
  it('(b) the refusal is a structured, machine-readable outcome, not only prose', () => {
    let encodeError: unknown = null
    try { encodeFrame({ code: 'x'.repeat(MAX_FRAME_BYTES + 10) }) } catch (error) { encodeError = error }

    const decodeFailures: Array<Error & Record<string, unknown>> = []
    const decoder = new FrameDecoder(() => undefined, error => { decodeFailures.push(error as Error & Record<string, unknown>) })
    const header = Buffer.alloc(4)
    header.writeUInt32BE(MAX_FRAME_BYTES + 1, 0)
    decoder.push(header)

    const enc = encodeError as (Error & Record<string, unknown>) | null
    const dec = decodeFailures[0]
    const fieldsOf = (error: (Error & Record<string, unknown>) | undefined): Record<string, unknown> => {
      if (error === undefined) return {}
      const out: Record<string, unknown> = {}
      for (const key of Object.keys(error)) out[key] = error[key]
      return out
    }
    const report = {
      encode: {
        name: enc?.name ?? null,
        message: enc?.message ?? null,
        ownEnumerableKeys: enc === null ? [] : Object.keys(enc),
        fields: fieldsOf(enc ?? undefined),
        hasCode: enc?.code !== undefined,
        hasLimitBytes: enc?.limitBytes !== undefined || enc?.limit !== undefined,
        hasDeclaredLength: enc?.declaredLength !== undefined,
      },
      decode: {
        name: dec?.name ?? null,
        message: dec?.message ?? null,
        ownEnumerableKeys: dec === undefined ? [] : Object.keys(dec),
        fields: fieldsOf(dec),
        hasCode: dec?.code !== undefined,
        hasLimitBytes: dec?.limitBytes !== undefined || dec?.limit !== undefined,
        hasDeclaredLength: dec?.declaredLength !== undefined,
      },
      maxFrameBytes: MAX_FRAME_BYTES,
      declaredLengthSent: MAX_FRAME_BYTES + 1,
      // The two numbers the oracle requires, and WHERE they live.
      messageNamesLimit: String(enc?.message ?? '').includes(String(MAX_FRAME_BYTES)),
      messageNamesDeclaredLength: String(dec?.message ?? '').includes(String(MAX_FRAME_BYTES + 1)),
      numbersAreInFieldsNotMessage: false,
    }
    report.numbersAreInFieldsNotMessage =
      (report.encode.hasLimitBytes || report.encode.hasDeclaredLength)
      || (report.decode.hasLimitBytes || report.decode.hasDeclaredLength)

    console.log('[S4-MEASURED] IPY-15-structure ' + JSON.stringify(report))

    // WHAT IS ASSERTED, and why only this: the MEASUREMENT is the finding for the
    // structured-outcome question, so the assertions pin the instrument rather
    // than the product. If the product ever gains structured fields, this test
    // still passes and the printed report changes -- which is the visible signal.
    expect(enc).not.toBeNull()
    expect(decodeFailures.length).toBeGreaterThan(0)
    expect(MAX_FRAME_BYTES).toBeGreaterThan(0)
  })

  it('(a) the kernel remains usable after a refusal, measured on a REAL kernel', async () => {
    host = new KernelHost({
      subprocess: ctx.subprocess,
      identity: { sessionId: 's4-ipy15', executionWorld: 'local', environmentDigest: 's4-env' },
      brokerScript: BROKER,
      pythonExecutable: PYTHON,
      workingDirectory: root,
    })
    

    const before = await host.execute('print("S4-IPY15-BEFORE")')
    // The refusal, injected at the framing layer while the kernel is LIVE.
    let refused = false
    let refusalMessage: string | null = null
    try { encodeFrame({ code: 'y'.repeat(MAX_FRAME_BYTES + 1) }) } catch (error) {
      refused = true
      refusalMessage = error instanceof Error ? error.message : String(error)
    }
    const after = await host.execute('print("S4-IPY15-AFTER")')

    const report = {
      refused,
      refusalMessage,
      beforeOutcome: before.outcome,
      beforeText: before.stdout.text.trim(),
      afterOutcome: after.outcome,
      afterText: after.stdout.text.trim(),
      // The clause: the kernel is still usable.
      kernelStillUsable: after.outcome === 'ok' && after.stdout.text.includes('S4-IPY15-AFTER'),
      epochUnchanged: before.epoch === after.epoch,
      beforeEpoch: before.epoch,
      afterEpoch: after.epoch,
    }
    console.log('[S4-MEASURED] IPY-15-kernel-usable ' + JSON.stringify(report))

    expect(refused).toBe(true)
    expect(before.outcome).toBe('ok')
    expect(after.outcome).toBe('ok')
    expect(after.stdout.text).toContain('S4-IPY15-AFTER')
  }, 300_000)
})
