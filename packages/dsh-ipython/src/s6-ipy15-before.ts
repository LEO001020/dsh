/**
 * S6 / IPY-15 BEFORE-state reproduction.
 *
 * WHY THIS FILE EXISTS. `s6-ipy15-measure.ts` reports the AFTER state and uses
 * getters that only exist after the fix (`transportRefusals`,
 * `controlChannelErrors`). A before/after pair has to be produced by the SAME
 * stimulus, so this driver is the minimal version that runs against the ORIGINAL
 * code: it uses only the API surface that existed before the change.
 *
 * It is archived as evidence of the old behaviour and is NOT a gate. Its output
 * is the `before/` half of the pair; the fix's justification is the difference.
 *
 * THE SECURITY CONSTRAINT. No connection file is read here at all; no key value
 * exists in this file.
 *
 * RUN against the ORIGINAL sources:
 *   node src/s6-ipy15-before.ts
 */
import { Context } from '@deepseek-ai/cordis'
import Subprocess from '@deepseek-ai/dsh-subprocess-local'
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { KernelHost } from './kernel.ts'
import { MAX_FRAME_BYTES } from './protocol.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const BROKER = resolve(HERE, 'broker.py')
const PYTHON = process.env['DSH_PYTHON']
  ?? 'C:/Users/hzq00/AppData/Local/Programs/Python/Python314/python.exe'

const REPO_ROOT = resolve(HERE, '..', '..', '..')
const EVIDENCE = process.env['S6_EVIDENCE_DIR']
  ?? join(REPO_ROOT, 'qualification', 'results', 'S6-ipy15')
const TAG = process.env['S6_TAG'] ?? 'before'

const observed: Record<string, unknown> = {}

function record(key: string, value: unknown): void {
  observed[key] = value
  process.stdout.write(`[fact] ${key} = ${JSON.stringify(value)}\n`)
}

async function main(): Promise<void> {
  const ctx = new Context()
  await ctx.plugin(Subprocess)
  const root = mkdtempSync(join(tmpdir(), 's6-ipy15-before-'))

  // THE ORIGINAL CODE HAS NO 'error' LISTENER ON THE CONTROL CHANNEL, so a write
  // to a peer that has exited raises an UNCAUGHT exception. Surviving to record
  // that fact requires a handler here -- and the fact that this handler is
  // necessary IS the finding.
  const uncaught: string[] = []
  process.on('uncaughtException', (error: Error) => {
    uncaught.push(`${error.name}: ${error.message}`.slice(0, 200))
    record('uncaughtException', uncaught.at(-1))
  })
  const unhandled: string[] = []
  process.on('unhandledRejection', (reason: unknown) => {
    unhandled.push(String(reason).slice(0, 200))
  })

  const host = new KernelHost({
    subprocess: ctx.subprocess,
    identity: { sessionId: 's6-ipy15-before', executionWorld: 'local', environmentDigest: 's6' },
    brokerScript: BROKER,
    pythonExecutable: PYTHON,
    workingDirectory: root,
    cellTimeoutMs: 1_000,
    interruptGraceMs: 1_000,
  })

  try {
    const status = await host.start()
    record('status_transport', status.transport)
    record('status_curveKeysPresent', status.curveKeysPresent)
    record('status_plaintextWarningSeen', status.plaintextWarningSeen)
    record('status_kernel_pid', status.pid ?? null)
    record('maxFrameBytes', MAX_FRAME_BYTES)

    const control = await host.execute('print("before-control")')
    record('controlArm_outcome', control.outcome)

    // ---- the leak: a request the host refuses to encode ---------------------
    let refused = false
    try {
      await host.execute('x'.repeat(MAX_FRAME_BYTES + 1))
    } catch {
      refused = true
    }
    record('overLimitRequest_refused', refused)
    const afterRefusal = await host.execute('print("before-recovery")')
    record('recoveryAfterRefusedRequest_outcome', afterRefusal.outcome)

    // ---- the raw over-limit frame, on the real control socket --------------
    const handle = (host as unknown as { handle?: { control?: NodeJS.WritableStream } }).handle
    const controlStream = handle?.control
    if (controlStream === undefined) throw new Error('the host exposes no control channel')
    const declared = MAX_FRAME_BYTES + 1024
    const huge = Buffer.alloc(declared, 0x61)
    const header = Buffer.alloc(4)
    header.writeUInt32BE(huge.byteLength, 0)
    controlStream.write(Buffer.concat([header, huge]))
    record('rawFrame_declaredBytes', declared)

    const exitStart = Date.now()
    while (host.unexpectedExit === undefined && Date.now() - exitStart < 20_000) {
      await new Promise(resolve_ => setTimeout(resolve_, 150))
    }
    record('brokerExit_registered_after_ms', Date.now() - exitStart)
    record('host_unexpectedExit', host.unexpectedExit ?? null)
    record('brokerDiagnostics_hasLimit', host.diagnosticsText.includes('exceeds the limit'))

    // ---- recovery after the broker died: the full budget? -------------------
    // A KEEP-ALIVE IS REQUIRED TO MEASURE THIS AT ALL. The pending entry's timer
    // is `unref`'d, so with nothing else on the loop Node exits instead of
    // waiting -- measured: without this, the run printed the registration facts
    // and then died with "unsettled top-level await". In the product the DSH
    // server holds the loop open, so this interval stands in for that and makes
    // the wait observable rather than invisible.
    const keepAlive = setInterval(() => undefined, 1_000)
    const cellStart = Date.now()
    const failure = await host.execute('print("before-after-death")')
      .then(() => undefined)
      .catch((error: unknown) => error as Error)
    clearInterval(keepAlive)
    record('cellAfterBrokerDeath_waitedMs', Date.now() - cellStart)
    record('cellAfterBrokerDeath_errorName', failure?.name ?? null)
    record('cellAfterBrokerDeath_errorMessage', failure?.message ?? null)

    // ---- the leak's escape through shutdown --------------------------------
    record('unhandledRejectionCount_beforeShutdown', unhandled.length)
    // SHUTDOWN IS RACED, NOT AWAITED. Against a broker that exited without the
    // host being told, `shutdown` awaits the managed range and does not return --
    // measured: the first run of this driver printed everything above and then
    // hung here. That hang is itself part of the BEFORE state, so it is recorded
    // as a bounded fact rather than allowed to swallow the evidence file.
    const shutdownStart = Date.now()
    const shutdownOutcome = await Promise.race([
      host.shutdown().then(() => 'resolved' as const).catch(() => 'threw' as const),
      new Promise<'hung'>(resolve_ => { setTimeout(() => resolve_('hung'), 8_000) }),
    ])
    record('shutdownOutcome', shutdownOutcome)
    record('shutdown_waitedMs', Date.now() - shutdownStart)
    await new Promise(resolve_ => setTimeout(resolve_, 500))
    record('unhandledRejectionCount_afterShutdown', unhandled.length)
    record('unhandledRejections', unhandled.slice(0, 3))
    record('uncaughtExceptionCount', uncaught.length)
    record('uncaughtExceptions', uncaught.slice(0, 3))
  } catch (error) {
    record('probeError', error instanceof Error ? error.message.slice(0, 300) : String(error))
  } finally {
    record('armComplete', true)
  }

  mkdirSync(join(EVIDENCE, TAG), { recursive: true })
  writeFileSync(join(EVIDENCE, TAG, 'transport-and-frame-bound.json'), `${JSON.stringify(observed, null, 2)}\n`)
  appendFileSync(join(EVIDENCE, 'measurement-runs.jsonl'), `${JSON.stringify({ tag: TAG, observed })}\n`)
  console.log(`[S6-IPY15-BEFORE] wrote ${join(EVIDENCE, TAG, 'transport-and-frame-bound.json')}`)
}

await main()
process.exit(0)
