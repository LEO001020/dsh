/**
 * C1 / IPY-15 clause 2 MEASUREMENT DRIVER.
 *
 * THE QUESTION, AND WHY IT CANNOT BE ANSWERED BY READING SOURCE.
 *
 * IPY-15 clause 2: "An over-limit frame is reported as LOST with a count, never as
 * empty output." The integrated tree measures `droppedFrames: 0` on every cell and
 * `OutputBuffer.note_dropped_frame` with zero call sites. But the broker ALSO emits
 * a structured `transport_refused` event, so two worlds are possible and only
 * DRIVING the path separates them:
 *
 *   (i)  the loss IS reported through the structured refusal, and the counter is a
 *        legacy field that stayed 0 -- then the count can be wired to the existing
 *        refusal path.
 *   (ii) the refusal is raised where the cell result never carries it, so the loss
 *        is effectively silent to the model -- then the reporting is the defect.
 *
 * THE ARMS, each against a REAL ipykernel through the REAL broker:
 *
 *   A. A request the HOST cannot encode (`encodeFrame` refuses before producing a
 *      byte). NO FRAME IS LOST: the broker never sees one. This is the control
 *      that establishes what a caller is told when nothing was lost.
 *   B. An over-limit frame that ACTUALLY ARRIVES at the broker's reader (written
 *      raw on the real control socket, since the host's encoder refuses to build
 *      one -- exactly what a peer without our bound does). The frame is refused
 *      and the broker exits. Measures what the CALLER holds afterwards.
 *   C. A cell whose OUTPUT is over-limit, with the output cap raised above the
 *      frame bound. The cell runs, its bytes reach the broker, and the reply frame
 *      that would carry them is refused. THE ONLY ARM WHERE CELL OUTPUT IS LOST.
 *   D. The same loss with the DEFAULT cap (256 KiB): a cell that emits many
 *      `display_data` payloads. `_absorb_display` bounds EACH payload at 64 KiB
 *      but nothing bounds the NUMBER of them, so the reply grows past the frame
 *      bound without any cap being raised. This arm decides whether the loss is
 *      reachable in the product's DEFAULT configuration.
 *
 * THE MODEL-FACING TEXT IS PRODUCED BY THE REAL RENDERER. `renderCell` and
 * `explainFailure` are module-private, so the text is obtained the way the model
 * obtains it: the tool is registered through its own `apply()` and its `execute`
 * is called with a service double that returns or throws EXACTLY what the real
 * host produced. Same instrument the v3 gates already use for IPY-04 / IPY-14.
 *
 * CPU DISCIPLINE: arms A/C/D share ONE kernel and run sequentially; B needs its
 * own because it kills the broker. Never two kernels at once.
 *
 * RUN:  node --experimental-strip-types src/c1-ipy15-overlimit-driver.ts
 * OUT:  JSON on stdout, and to $C1_OUT when set.
 */
import { Context } from '@deepseek-ai/cordis'
import Subprocess from '@deepseek-ai/dsh-subprocess-local'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { KernelHost } from './kernel.ts'
import { encodeFrame, MAX_FRAME_BYTES } from './protocol.ts'
import * as ipythonTool from './ipython-tool.ts'
import type { IpythonToolMount, IpythonToolService } from './ipython-tool.ts'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { CellResult } from './protocol.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..', '..', '..')
const BROKER = resolve(HERE, 'broker.py')
const PYTHON = process.env['DSH_PYTHON']
  ?? 'C:/Users/hzq00/AppData/Local/Programs/Python/Python314/python.exe'

const TAG = process.env['C1_TAG'] ?? 'before'
const OUT = process.env['C1_OUT']
  ?? resolve(REPO, 'qualification', 'results', 'C1-ipy15', `${TAG}.json`)

const observed: Record<string, unknown> = {}

function record(key: string, value: unknown): void {
  observed[key] = value
  process.stdout.write(`[c1-fact] ${key} = ${JSON.stringify(value)}\n`)
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolvePromise => setTimeout(resolvePromise, ms))
}

interface ArmOutcome {
  readonly kind: 'returned' | 'threw'
  // `CellResult`, not `unknown`: this is what `service.runCell` resolves to, and
  // typing it loosely is what let the double below stand in for a real service
  // without the compiler noticing the mismatch.
  readonly result?: CellResult
  readonly error?: Error
}

async function capture(run: Promise<CellResult>): Promise<ArmOutcome> {
  try {
    return { kind: 'returned', result: await run }
  } catch (error) {
    return { kind: 'threw', error: error as Error }
  }
}

/**
 * The MODEL-FACING text for one captured host outcome, produced by the tool's own
 * renderer. `service` answers `runCell` with the captured value or throws the
 * captured error, so the text below is what a model would read for that outcome.
 */
async function modelTextFor(outcome: ArmOutcome): Promise<string> {
  const registered: Array<{ definition: unknown }> = []
  // The double answers the four members the tool's `execute` reaches, and it is typed
  // as exactly those -- `IpythonToolService` is a `Pick` of the real service, so this
  // assignment is CHECKED. Before the seam existed this object had to be asserted past
  // the compiler with `as never`, which is how a double that returns `Promise<unknown>`
  // where a `Promise<CellResult>` is required could go unnoticed.
  const double: IpythonToolService = {
    runCell: async () => {
      if (outcome.kind === 'threw') throw outcome.error
      // A `returned` outcome always carries a result; the optional field exists for
      // the `threw` arm. The throw above is what makes this narrowing sound, and
      // stating it here keeps the double's contract honest rather than asserted.
      if (outcome.result === undefined) {
        throw new Error('c1 driver: a returned outcome must carry a CellResult')
      }
      return outcome.result
    },
    currentEpoch: () => 1,
    drainLateNotices: () => [],
    lateNoticeAccount: () => undefined,
  }
  const toolCtx: IpythonToolMount = {
    tools: { register: (definition: ToolDefinition) => { registered.push({ definition }); return () => undefined } },
    get: (name: 'ipython') => (name === 'ipython' ? double : undefined),
  }
  ipythonTool.registerIpythonTool(toolCtx)
  const definition = registered[0]?.definition as {
    execute: (args: unknown, exec: unknown) => Promise<{ text: string, outcome: string, isError: boolean }>
  }
  const agent = { session: { header: { id: 'c1-ipy15' } } } as unknown as Parameters<typeof definition.execute>[1]
  return (await definition.execute({ code: '(the measured cell)' }, { agent, signal: new AbortController().signal })).text
}

function summarize(name: string, outcome: ArmOutcome): void {
  record(`${name}_result`, outcome.kind)
  if (outcome.kind === 'threw') {
    const error = outcome.error as Error & { code?: string }
    record(`${name}_errorName`, error.name)
    record(`${name}_errorCode`, error.code ?? null)
    record(`${name}_errorMessage`, error.message.slice(0, 300))
  }
}

interface CellShape {
  readonly outcome?: string
  readonly stdout?: { readonly text?: string, readonly totalBytes?: number, readonly truncated?: boolean, readonly droppedFrames?: number }
  readonly stderr?: { readonly text?: string, readonly totalBytes?: number, readonly truncated?: boolean, readonly droppedFrames?: number }
  readonly display?: readonly unknown[]
}

function recordResultShape(name: string, shape: CellShape | undefined): void {
  record(`${name}_outcome`, shape?.outcome ?? null)
  record(`${name}_stdoutTextLength`, shape?.stdout?.text?.length ?? null)
  record(`${name}_stdoutTotalBytes`, shape?.stdout?.totalBytes ?? null)
  record(`${name}_stdoutTruncated`, shape?.stdout?.truncated ?? null)
  record(`${name}_stdoutDroppedFrames`, shape?.stdout?.droppedFrames ?? null)
  record(`${name}_stderrDroppedFrames`, shape?.stderr?.droppedFrames ?? null)
  record(`${name}_displayCount`, Array.isArray(shape?.display) ? shape.display.length : null)
}

type SubprocessPort = ConstructorParameters<typeof KernelHost>[0]['subprocess']

function makeHost(
  subprocess: SubprocessPort,
  root: string,
  options: { readonly cellTimeoutMs?: number, readonly outputCapBytes?: number },
): KernelHost {
  return new KernelHost({
    subprocess,
    identity: { sessionId: 'c1-ipy15', executionWorld: 'local', environmentDigest: 'c1' },
    brokerScript: BROKER,
    pythonExecutable: PYTHON,
    workingDirectory: root,
    cellTimeoutMs: options.cellTimeoutMs ?? 120_000,
    interruptGraceMs: 3_000,
    ...options.outputCapBytes === undefined ? {} : { outputCapBytes: options.outputCapBytes },
  })
}

async function main(): Promise<void> {
  record('tag', TAG)
  record('maxFrameBytes', MAX_FRAME_BYTES)
  record('python', PYTHON)

  // A framing-layer control: the host refuses to build the frame at all, so this
  // arm cannot have lost one. Recorded so arm A's null is a measured fact.
  let encodeRefused = false
  let bytesProduced = 0
  try {
    bytesProduced = encodeFrame({ id: 'c1', op: 'execute', code: 'z'.repeat(MAX_FRAME_BYTES + 1) }).byteLength
  } catch {
    encodeRefused = true
  }
  record('hostEncodeRefused', encodeRefused)
  record('hostEncodeBytesProducedOnRefusal', bytesProduced)

  const ctx = new Context()
  await ctx.plugin(Subprocess)
  const root = mkdtempSync(join(tmpdir(), 'c1-ipy15-'))

  // ---- arms A, C, D on ONE kernel, sequentially ----------------------------
  const host = makeHost(ctx.subprocess, root, { outputCapBytes: MAX_FRAME_BYTES * 2 })
  await host.start()

  // ARM A -- the host cannot encode the request. No frame is lost.
  const aControl = await host.execute('print("c1-armA-control")')
  record('armA_controlOutcome', aControl.outcome)
  const a = await capture(host.execute('x'.repeat(MAX_FRAME_BYTES + 1)))
  summarize('armA', a)
  record('armA_modelText', await modelTextFor(a))
  const aAfter = await capture(host.execute('print("c1-armA-recovery")'))
  record('armA_recoveryOutcome', aAfter.kind === 'returned' ? (aAfter.result as CellShape).outcome : null)

  // ARM C -- a cell whose OUTPUT is over-limit: the reply frame carrying it is
  // refused. The only arm where cell output is genuinely lost.
  const cControl = await capture(host.execute('print("c1-armC-control")'))
  record('armC_controlOutcome', cControl.kind === 'returned' ? (cControl.result as CellShape).outcome : null)
  const chunk = 64 * 1024
  const chunks = Math.ceil((MAX_FRAME_BYTES * 1.5) / chunk)
  const c = await capture(host.execute(
    `import sys\nfor _ in range(${chunks}):\n    sys.stdout.write("y" * ${chunk})\n`,
  ))
  record('armC_declaredOutputBytes', chunks * chunk)
  summarize('armC', c)
  recordResultShape('armC', c.kind === 'returned' ? c.result as CellShape : undefined)
  record('armC_modelText', await modelTextFor(c))
  record('armC_transportRefusals', host.transportRefusals)
  record('armC_unexpectedExit', host.unexpectedExit ?? null)
  record('armC_controlChannelErrors', host.controlChannelErrors.slice(0, 3))
  record('armC_diagnosticsHasFrameBound', host.diagnosticsText.includes('exceeded the frame bound'))
  const cAfter = await capture(host.execute('print("c1-armC-recovery")'))
  record('armC_recoveryOutcome', cAfter.kind === 'returned' ? (cAfter.result as CellShape).outcome : `threw:${cAfter.error?.name}`)

  // ARM D -- the SAME loss with the DEFAULT cap: many display payloads. Nothing
  // raises the cap; `_absorb_display` bounds each payload, not their number.
  const hostD = makeHost(ctx.subprocess, root, { cellTimeoutMs: 120_000 })
  await hostD.start()
  record('armD_outputCapBytes', 256 * 1024)
  const dControl = await capture(hostD.execute('print("c1-armD-control")'))
  record('armD_controlOutcome', dControl.kind === 'returned' ? (dControl.result as CellShape).outcome : null)
  const d = await capture(hostD.execute([
    'from IPython.display import display',
    'payload = "d" * 60000',
    'for _ in range(80):',
    '    display({"text/plain": payload})',
    'print("c1-armD-printed")',
  ].join('\n')))
  summarize('armD', d)
  recordResultShape('armD', d.kind === 'returned' ? d.result as CellShape : undefined)
  record('armD_modelText', await modelTextFor(d))
  record('armD_transportRefusals', hostD.transportRefusals)
  record('armD_unexpectedExit', hostD.unexpectedExit ?? null)
  const dAfter = await capture(hostD.execute('print("c1-armD-recovery")'))
  record('armD_recoveryOutcome', dAfter.kind === 'returned' ? (dAfter.result as CellShape).outcome : `threw:${dAfter.error?.name}`)
  await hostD.shutdown().catch(() => undefined)

  await host.shutdown().catch(() => undefined)

  // ARM B -- an over-limit frame that ACTUALLY ARRIVES. Needs its own kernel: the
  // broker exits by design, because the declared length leaves no trustworthy
  // next boundary.
  const hostB = makeHost(ctx.subprocess, root, { cellTimeoutMs: 5_000 })
  await hostB.start()
  const bControl = await capture(hostB.execute('print("c1-armB-control")'))
  record('armB_controlOutcome', bControl.kind === 'returned' ? (bControl.result as CellShape).outcome : null)
  const declared = MAX_FRAME_BYTES + 1024
  const payload = Buffer.alloc(declared, 0x61)
  const header = Buffer.alloc(4)
  header.writeUInt32BE(payload.byteLength, 0)
  const controlStream = (hostB as unknown as { handle?: { control?: NodeJS.WritableStream } }).handle?.control
  if (controlStream === undefined) throw new Error('the host exposes no control channel')
  controlStream.write(Buffer.concat([header, payload]))
  record('armB_declaredBytes', declared)
  const exitStart = Date.now()
  while (hostB.unexpectedExit === undefined && Date.now() - exitStart < 20_000) await sleep(150)
  record('armB_exitRegisteredAfterMs', Date.now() - exitStart)
  record('armB_unexpectedExit', hostB.unexpectedExit ?? null)
  record('armB_transportRefusals', hostB.transportRefusals)
  const b = await capture(hostB.execute('print("c1-armB-after")'))
  summarize('armB', b)
  record('armB_modelText', await modelTextFor(b))
  await hostB.shutdown().catch(() => undefined)

  await ctx.fiber.dispose().catch(() => undefined)

  mkdirSync(dirname(OUT), { recursive: true })
  writeFileSync(OUT, `${JSON.stringify(observed, null, 2)}\n`)
  process.stdout.write(`[c1-ipy15] wrote ${OUT}\n`)
}

await main()
process.exit(0)
