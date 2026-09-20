/**
 * C1 / IPY-15 clause 2 measurement: WHERE does an over-limit frame's loss actually
 * land, and does the cell result or the model text ever carry a count of it?
 *
 * WHY THIS DRIVER AND NOT ANOTHER GATE. `s6-ipy15-measure.ts` already measured the
 * CONTROL channel in both directions (encode refuses, decode refuses, the broker
 * emits a structured `transport_refused` and exits). What no existing driver
 * measures is the half clause 2 is actually about: the loss of a CELL'S OUTPUT,
 * and whether `CellResult.stdout.droppedFrames` -- whose only writer,
 * `OutputBuffer.note_dropped_frame`, has ZERO call sites -- can ever be non-zero.
 *
 * THE TWO CANDIDATE READINGS, and this driver is what distinguishes them:
 *
 *   (i)  the loss IS already reported by the structured refusal, so the fix is to
 *        wire the count to that refusal;
 *   (ii) the loss is RAISED as a transport error, on a path where no CellResult is
 *        ever built, so `droppedFrames` cannot carry it and the reporting itself
 *        has to be fixed.
 *
 * THE THREE ARMS, each measuring a different claim about where a frame can be
 * refused:
 *
 *   ARM 1  a cell whose output exceeds the OUTPUT CAP but not the FRAME bound.
 *          Expected: the buffer truncates and reports `truncated` + a spill path.
 *          This is the working loss-reporting path, and it is the CONTROL ARM:
 *          if this arm did not report its loss, nothing else here would matter.
 *
 *   ARM 2  a cell whose output exceeds the FRAME bound (raised cap), so the RESULT
 *          REPLY cannot be encoded. This is the only place an over-limit frame is
 *          produced by the broker with a live cell's output in it, and it is the
 *          arm that decides (i) vs (ii): what does the host get, and is any count
 *          in it?
 *
 *   ARM 3  a frame arriving on IOPub that is larger than the FRAME bound. This
 *          measures whether `note_dropped_frame`'s stated premise -- "a frame
 *          libzmq refused" -- is reachable at all on the kernel->broker channel.
 *
 * RUN: node --experimental-strip-types src/c1-ipy15-output-loss-measure.ts
 * (or through vitest, which is how it was actually run -- see the report.)
 */
import { Context } from '@deepseek-ai/cordis'
import Subprocess from '@deepseek-ai/dsh-subprocess-local'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { KernelHost, KernelTransportError } from './kernel.ts'
import { MAX_FRAME_BYTES } from './protocol.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const BROKER = resolve(HERE, 'broker.py')
const PYTHON = process.env['DSH_PYTHON']
  ?? 'C:/Users/hzq00/AppData/Local/Programs/Python/Python314/python.exe'

const REPO_ROOT = resolve(HERE, '..', '..', '..')
const EVIDENCE = process.env['C1_EVIDENCE_DIR']
  ?? join(REPO_ROOT, 'qualification', 'results', 'C1-ipy15')
const TAG = process.env['C1_TAG'] ?? 'after'

const observed: Record<string, unknown> = {}

function record(key: string, value: unknown): void {
  observed[key] = value
  process.stdout.write(`[fact] ${key} = ${JSON.stringify(value)}\n`)
}

/** Byte length of one cell result as the broker would frame it. */
function resultFrameBytes(result: unknown): number {
  return Buffer.byteLength(JSON.stringify({
    type: 'reply', id: 'measure', ok: true, result,
  }), 'utf8')
}

async function main(): Promise<void> {
  const ctx = new Context()
  await ctx.plugin(Subprocess)
  const root = mkdtempSync(join(tmpdir(), 'c1-ipy15-'))

  record('maxFrameBytes', MAX_FRAME_BYTES)

  // -------------------------------------------------------------------------
  // ARM 1 -- output over the CAP, under the FRAME bound. The control arm.
  // -------------------------------------------------------------------------
  {
    const cap = 64 * 1024
    const host = new KernelHost({
      subprocess: ctx.subprocess,
      identity: { sessionId: 'c1-arm1', executionWorld: 'local', environmentDigest: 'c1' },
      brokerScript: BROKER,
      pythonExecutable: PYTHON,
      workingDirectory: root,
      cellTimeoutMs: 30_000,
      outputCapBytes: cap,
    })
    try {
      await host.start()
      // Four times the cap, so the truncation branch is definitely crossed.
      const result = await host.execute(`print("A" * ${String(cap * 4)})`)
      record('arm1_outcome', result.outcome)
      record('arm1_stdout_bytes', Buffer.byteLength(result.stdout.text, 'utf8'))
      record('arm1_stdout_totalBytes', result.stdout.totalBytes)
      record('arm1_stdout_truncated', result.stdout.truncated)
      record('arm1_stdout_droppedFrames', result.stdout.droppedFrames)
      record('arm1_stdout_spillPath_present', result.stdout.spillPath !== undefined)
      record('arm1_resultFrameBytes', resultFrameBytes(result))
      record('arm1_resultFrameUnderBound', resultFrameBytes(result) <= MAX_FRAME_BYTES)
    } catch (error) {
      record('arm1_error', error instanceof Error ? `${error.name}: ${error.message}` : String(error))
    } finally {
      await host.shutdown().catch(() => undefined)
    }
  }

  // -------------------------------------------------------------------------
  // ARM 2 -- output over the FRAME bound. The result reply cannot be encoded.
  // -------------------------------------------------------------------------
  {
    // A cap ABOVE the frame bound, so the buffer does NOT truncate below it and
    // the reply the broker tries to frame is genuinely over-limit.
    const cap = MAX_FRAME_BYTES * 2
    const host = new KernelHost({
      subprocess: ctx.subprocess,
      identity: { sessionId: 'c1-arm2', executionWorld: 'local', environmentDigest: 'c1' },
      brokerScript: BROKER,
      pythonExecutable: PYTHON,
      workingDirectory: root,
      cellTimeoutMs: 60_000,
      outputCapBytes: cap,
    })
    try {
      await host.start()
      const printed = MAX_FRAME_BYTES + 512 * 1024
      record('arm2_capBytes', cap)
      record('arm2_bytesPrinted', printed)
      const started = Date.now()
      const outcome = await host.execute(`print("B" * ${String(printed)})`)
        .then(result => ({ kind: 'result' as const, result }))
        .catch((error: unknown) => ({ kind: 'error' as const, error }))
      record('arm2_waitedMs', Date.now() - started)
      if (outcome.kind === 'result') {
        record('arm2_kind', 'result')
        record('arm2_outcome', outcome.result.outcome)
        record('arm2_stdout_droppedFrames', outcome.result.stdout.droppedFrames)
        record('arm2_stdout_truncated', outcome.result.stdout.truncated)
        record('arm2_stdout_totalBytes', outcome.result.stdout.totalBytes)
      } else {
        const error = outcome.error
        record('arm2_kind', 'error')
        record('arm2_errorName', error instanceof Error ? error.name : String(error))
        record('arm2_errorMessage', error instanceof Error ? error.message.slice(0, 400) : String(error))
        record(
          'arm2_errorCarriesCellResult',
          error instanceof KernelTransportError ? false : undefined,
        )
        // The transport code, which is what the model-facing text is built from.
        record(
          'arm2_transportCode',
          error instanceof KernelTransportError ? error.code ?? null : null,
        )
        record(
          'arm2_errorHasDroppedFramesField',
          /droppedFrames|dropped frame/i.test(error instanceof Error ? error.message : ''),
        )
      }
      // What the host recorded about refusals on the stream itself.
      record('arm2_host_transportRefusals', host.transportRefusals.length)
      record('arm2_host_unexpectedExit', host.unexpectedExit ?? null)
      record('arm2_host_controlChannelErrors', host.controlChannelErrors.slice(0, 3))
      record('arm2_brokerDiagnostics_hasFrameBound', host.brokerDiagnostics.includes('exceeds the limit'))
    } catch (error) {
      record('arm2_outerError', error instanceof Error ? `${error.name}: ${error.message}` : String(error))
    } finally {
      await host.shutdown().catch(() => undefined)
    }
  }

  // -------------------------------------------------------------------------
  // ARM 3 -- is a frame larger than the bound even DELIVERABLE on IOPub?
  //
  // `note_dropped_frame`'s docstring says "a frame libzmq refused". libzmq's
  // `MAXMSGSIZE` default is -1 (no limit) and jupyter_client never sets it, so
  // the premise may be unreachable. Measured, not read: a cell that writes one
  // stream message larger than the frame bound, with a cap high enough that the
  // buffer does not cut it first.
  // -------------------------------------------------------------------------
  {
    const cap = MAX_FRAME_BYTES * 2
    const host = new KernelHost({
      subprocess: ctx.subprocess,
      identity: { sessionId: 'c1-arm3', executionWorld: 'local', environmentDigest: 'c1' },
      brokerScript: BROKER,
      pythonExecutable: PYTHON,
      workingDirectory: root,
      cellTimeoutMs: 60_000,
      outputCapBytes: cap,
    })
    try {
      await host.start()
      // ONE write of just over the bound, flushed as a single stream message.
      const chunk = MAX_FRAME_BYTES + 4096
      const outcome = await host.execute(
        [
          'import sys',
          `sys.stdout.write("C" * ${String(chunk)})`,
          'sys.stdout.flush()',
          'print("")',
        ].join('\n'),
      ).then(result => ({ kind: 'result' as const, result }))
        .catch((error: unknown) => ({ kind: 'error' as const, error }))
      record('arm3_kind', outcome.kind)
      if (outcome.kind === 'result') {
        record('arm3_outcome', outcome.result.outcome)
        record('arm3_stdout_totalBytes', outcome.result.stdout.totalBytes)
        record('arm3_stdout_truncated', outcome.result.stdout.truncated)
        record('arm3_stdout_droppedFrames', outcome.result.stdout.droppedFrames)
        // If the kernel->broker frame were refused, the bytes would be gone and
        // totalBytes would be short. It is not: the frame is delivered whole and
        // the CAP is what bounds it.
        record('arm3_bytesReachedBroker', outcome.result.stdout.totalBytes)
      } else {
        record('arm3_errorName', outcome.error instanceof Error ? outcome.error.name : String(outcome.error))
        record('arm3_errorMessage', outcome.error instanceof Error ? outcome.error.message.slice(0, 300) : String(outcome.error))
      }
      record('arm3_host_transportRefusals', host.transportRefusals.length)
      record('arm3_brokerDiagnostics_hasLimit', host.brokerDiagnostics.includes('exceeds the limit'))
    } catch (error) {
      record('arm3_outerError', error instanceof Error ? `${error.name}: ${error.message}` : String(error))
    } finally {
      await host.shutdown().catch(() => undefined)
    }
  }

  // -------------------------------------------------------------------------
  // ARM 4 -- the PRODUCTION-reachable over-limit reply, at the DEFAULT cap.
  //
  // Arms 2 and 3 raised the cap, which is a configuration no session uses. The
  // question this arm answers is whether an over-limit reply frame is reachable
  // with the cap the product actually ships (256 KiB). It is: `_absorb_display`
  // bounds EACH display payload at 64 KiB but nothing bounds the NUMBER of
  // display entries, so a cell that displays in a loop accumulates a reply far
  // larger than the frame bound while every individual stream stays under the cap.
  // -------------------------------------------------------------------------
  {
    const host = new KernelHost({
      subprocess: ctx.subprocess,
      identity: { sessionId: 'c1-arm4', executionWorld: 'local', environmentDigest: 'c1' },
      brokerScript: BROKER,
      pythonExecutable: PYTHON,
      workingDirectory: root,
      cellTimeoutMs: 60_000,
      // NO outputCapBytes: the product default, exactly as a Session gets it.
    })
    try {
      await host.start()
      const perDisplay = 64 * 1024
      const displays = 200
      record('arm4_defaultCapUsed', true)
      record('arm4_displays', displays)
      record('arm4_bytesPerDisplay', perDisplay)
      const code = [
        'from IPython.display import display',
        `for i in range(${String(displays)}):`,
        `    display({"i": i, "blob": "D" * ${String(perDisplay)}})`,
        'print("arm4-printed")',
      ].join('\n')
      const outcome = await host.execute(code)
        .then(result => ({ kind: 'result' as const, result }))
        .catch((error: unknown) => ({ kind: 'error' as const, error }))
      record('arm4_kind', outcome.kind)
      if (outcome.kind === 'result') {
        record('arm4_outcome', outcome.result.outcome)
        record('arm4_stdout_text_len', outcome.result.stdout.text.length)
        record('arm4_stdout_totalBytes', outcome.result.stdout.totalBytes)
        record('arm4_stdout_truncated', outcome.result.stdout.truncated)
        record('arm4_stdout_droppedFrames', outcome.result.stdout.droppedFrames)
        record('arm4_display_entries', outcome.result.display.length)
      } else {
        record('arm4_errorName', outcome.error instanceof Error ? outcome.error.name : String(outcome.error))
        record('arm4_errorMessage', outcome.error instanceof Error ? outcome.error.message.slice(0, 300) : String(outcome.error))
        record('arm4_transportCode', outcome.error instanceof KernelTransportError ? outcome.error.code ?? null : null)
      }
      record('arm4_host_transportRefusals', host.transportRefusals.length)
      record('arm4_brokerDiagnostics_hasLimit', host.brokerDiagnostics.includes('exceeds the limit'))
    } catch (error) {
      record('arm4_outerError', error instanceof Error ? `${error.name}: ${error.message}` : String(error))
    } finally {
      await host.shutdown().catch(() => undefined)
    }
  }

  // -------------------------------------------------------------------------
  // ARM 5 -- a LATE frame whose text exceeds the FRAME bound.
  //
  // The only other place the broker itself frames a cell's output is the
  // `late_output` event. `_route_iopub` builds it with the frame's text VERBATIM
  // and `write_frame` encodes it, so a background write larger than the bound
  // makes `encode_frame` raise INSIDE the pump -- where the pump's own
  // `except Exception` swallows it and logs one line.
  //
  // This arm is the one that decides whether the loss can be counted while a
  // cell result still reaches the caller, which is the shape clause 2 needs.
  // -------------------------------------------------------------------------
  {
    const host = new KernelHost({
      subprocess: ctx.subprocess,
      identity: { sessionId: 'c1-arm5', executionWorld: 'local', environmentDigest: 'c1' },
      brokerScript: BROKER,
      pythonExecutable: PYTHON,
      workingDirectory: root,
      cellTimeoutMs: 60_000,
      // NO outputCapBytes: the product default. The CAP bounds the live cell's
      // own buffer; it does NOT bound a late frame, which has no sink.
    })
    try {
      await host.start()
      // Start a thread that outlives its cell, then writes one over-limit
      // message AFTER the cell has settled -- the definition of late output.
      const huge = MAX_FRAME_BYTES + 256 * 1024
      const started = await host.execute([
        'import sys, threading, time',
        'def background():',
        '    time.sleep(1.0)',
        `    sys.stdout.write("E" * ${String(huge)})`,
        '    sys.stdout.flush()',
        '    print("arm5-background-done")',
        'threading.Thread(target=background, daemon=True).start()',
        'print("arm5-thread-started")',
      ].join('\n'))
      record('arm5_settling_outcome', started.outcome)
      record('arm5_settling_stdout_totalBytes', started.stdout.totalBytes)
      // Give the background write time to be produced and pumped.
      await new Promise(resolve_ => setTimeout(resolve_, 4_000))
      // A second cell: it settles normally, and is the caller's chance to be told
      // about the background write. It is also where a `late_output` event would
      // have been routed had it been deliverable.
      const after = await host.execute('print("arm5-after")')
      record('arm5_after_outcome', after.outcome)
      record('arm5_after_stdout_droppedFrames', after.stdout.droppedFrames)
      record('arm5_after_stdout_truncated', after.stdout.truncated)
      record('arm5_after_stdout_totalBytes', after.stdout.totalBytes)
      record('arm5_host_transportRefusals', host.transportRefusals.length)
      record(
        'arm5_brokerDiagnostics_pumpFrameFailed',
        host.brokerDiagnostics.includes('iopub pump failed on one frame'),
      )
      record('arm5_brokerDiagnostics_hasLimit', host.brokerDiagnostics.includes('exceeds the limit'))
      record('arm5_bytesWritten', huge)
    } catch (error) {
      record('arm5_outerError', error instanceof Error ? `${error.name}: ${error.message}` : String(error))
    } finally {
      await host.shutdown().catch(() => undefined)
    }
  }

  mkdirSync(join(EVIDENCE, TAG), { recursive: true })
  writeFileSync(join(EVIDENCE, TAG, 'output-loss.json'), `${JSON.stringify(observed, null, 2)}\n`)
  console.log(`[C1-IPY15] wrote ${join(EVIDENCE, TAG, 'output-loss.json')}`)
}

await main()
process.exit(0)
