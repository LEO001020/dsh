/**
 * TEMPORARY EXPERIMENT (V3), round 4 — THE DECISIVE ONE. Deleted after the run.
 *
 * THE DATA SO FAR, all via KernelHost or KernelService on a real ipykernel:
 *
 *   ARM A   start -> restart immediately                        PASS  (2080 ms)
 *   ARM B   start -> cell -> 3x status() -> restart             PASS  (2027 ms)
 *   ARM C   start -> cell -> restart                            FAIL  (60983 ms)
 *   R2-C1   start -> cell -> restart                            FAIL  (61048 ms)
 *   R2-C2   same                                                FAIL  (60937 ms)
 *   R2-C3   same                                                FAIL  (61059 ms)
 *   R3-A    hand host + explicit kernelWorkingDirectory         FAIL  (60980 ms)
 *   R3-P    KernelService: runCell -> restart (PRODUCT PATH)    FAIL  (63725 ms)
 *   faults.test.ts restart gate (runCell -> status -> restart)  PASS  ( 4917 ms)
 *
 * Every PASS has an intervening `status()` between the cell and the restart, OR
 * no cell at all. Every FAIL ran a cell and then restarted with no intervening
 * shell request. `status()` sends a `kernel_info_request` through
 * `_shell_request`, which is the ONLY other user of the shell channel.
 *
 * THIS ROUND VARIES EXACTLY THAT ONE THING: the same host, the same cell, the
 * same restart, differing ONLY in whether a `status()` is issued between the cell
 * and the restart. Two trials, back to back.
 *
 * If WITH-status passes and WITHOUT-status fails, the mechanism is specific and
 * the finding is: a restart is only reliable after a `kernel_info_request` has
 * been serviced on the current kernel, and `faults.test.ts`'s restart gate passes
 * only because its own shape happens to include one -- a gate whose oracle is
 * narrower than its scenario.
 *
 * If BOTH fail, the `status()` correlation was a coincidence of the earlier arms
 * and the honest statement is "deterministic 60 s timeout, mechanism not
 * isolated".
 */
import { Context } from '@deepseek-ai/cordis'
import Subprocess from '@deepseek-ai/dsh-subprocess-local'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { KernelHost } from './kernel.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const BROKER = resolve(HERE, 'broker.py')
const PYTHON = process.env['DSH_PYTHON'] ?? 'C:/Users/hzq00/AppData/Local/Programs/Python/Python314/python.exe'

let ctx: Context
let root: string
let host: KernelHost | undefined

beforeEach(async () => {
  ctx = new Context()
  await ctx.plugin(Subprocess)
  root = await mkdtemp(join(tmpdir(), 'v3-restart-r4-'))
})

afterEach(async () => {
  if (host !== undefined) {
    await host.shutdown().catch(() => undefined)
    host = undefined
  }
  await ctx.fiber.dispose()
  await rm(root, { recursive: true, force: true })
})

function makeHost(): KernelHost {
  host = new KernelHost({
    subprocess: ctx.subprocess,
    identity: { sessionId: 'r4', executionWorld: 'local', environmentDigest: 'r4' },
    brokerScript: BROKER,
    pythonExecutable: PYTHON,
    workingDirectory: root,
  })
  return host
}

async function trial(label: string, withStatus: boolean): Promise<Record<string, unknown>> {
  const h = makeHost()
  const started = await h.start()
  const cell = await h.execute('print("trial cell")')
  expect(cell.outcome).toBe('ok')

  let statusEpoch: number | undefined
  if (withStatus) {
    statusEpoch = (await h.status()).epoch
  }

  const beganAt = Date.now()
  let thrown: unknown
  let epochAfter: number | undefined
  try {
    epochAfter = (await h.restart()).epoch
  } catch (error) {
    thrown = error
  }
  const record: Record<string, unknown> = {
    label,
    withInterveningStatus: withStatus,
    ok: thrown === undefined,
    elapsedMs: Date.now() - beganAt,
    pidBefore: started.pid,
    statusEpochBeforeRestart: statusEpoch ?? null,
    epochAfter: epochAfter ?? null,
    error: thrown === undefined ? null : String(thrown).slice(0, 200),
  }
  if (thrown !== undefined) {
    const kernelErr = await readFile(join(root, 'kernel.err'), 'utf8').catch(() => '')
    record['kernelErrBytes'] = Buffer.byteLength(kernelErr, 'utf8')
    record['brokerStderrTail'] = h.diagnosticsText.slice(-700)
  }
  console.log('[V3-EXP4] ' + JSON.stringify(record))
  return record
}

describe('restart: the single variable is an intervening status()', () => {
  it('WITH an intervening status() between the cell and the restart', async () => {
    const record = await trial('with-status', true)
    expect(record['ok'], `with-status threw: ${String(record['error'])}`).toBe(true)
  }, 300_000)

  it('WITHOUT an intervening status() between the cell and the restart', async () => {
    // NOT asserted to pass: this arm is EXPECTED to fail, and asserting the
    // measured failure is what makes it a measurement rather than a hope. If it
    // passes, the correlation this round exists to test is falsified and the
    // console line above is the record.
    const record = await trial('without-status', false)
    expect(typeof record['ok']).toBe('boolean')
  }, 300_000)
})
