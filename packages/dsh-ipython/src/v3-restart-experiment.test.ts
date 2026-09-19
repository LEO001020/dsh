/**
 * TEMPORARY EXPERIMENT (V3), round 3. Deleted after the run; not a gate.
 *
 * ROUND 1 (arm A/B/C) and ROUND 2 (3 trials) RESULTS:
 *   A  start -> restart immediately                    PASS  (2080 ms)
 *   B  start -> cell -> 3x status() -> restart         PASS  (2027 ms)
 *   C  start -> cell (no injection) -> restart         FAIL  (60983 ms)
 *   C1 start -> cell -> restart                        FAIL  (61048 ms)
 *   C2 same                                            FAIL  (60937 ms)
 *   C3 same                                            FAIL  (61059 ms)
 *
 * So the injected `status()` calls did NOT break the restart (the hypothesis this
 * experiment was built to test is FALSIFIED), and the failing shape is
 * deterministic: 4/4 failures at ~61 s, all at `broker.py:839`
 * `self._kc.wait_for_ready(timeout=60)` with `RuntimeError: Kernel didn't respond
 * in 60 seconds`. The kernel's own `kernel.err` is EMPTY, so the replacement
 * kernel produced no output at all -- it did not start and fail, it did not start.
 *
 * THE DECISIVE QUESTION FOR THE SPEC: `faults.test.ts`'s restart gate drives
 * restart through `KernelService` and PASSES (measured 4.9 s in the same session
 * as the failures above). If the product path is reliable and only the
 * hand-built `KernelHost` fails, this is a HARNESS fact -- the same shape as
 * G-SEAM-36, where a hand-built host bypassed the service that creates the
 * directory. If the product path ALSO fails, it is a real defect in a
 * model-reachable operation.
 *
 * The two candidate differences between the arms:
 *   (a) the SERVICE sets an explicit `kernelWorkingDirectory` (the Session's
 *       project root) distinct from `workingDirectory` (the scratch), while the
 *       hand-built host defaults it to the same directory; and
 *   (b) the service creates its scratch directory with `mkdirSync` before
 *       starting the host.
 * Both are exercised here so the difference is named rather than guessed.
 */
import { Context } from '@deepseek-ai/cordis'
import Subprocess from '@deepseek-ai/dsh-subprocess-local'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { KernelHost } from './kernel.ts'
import { KernelService } from './kernel-plugin.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const BROKER = resolve(HERE, 'broker.py')
const PYTHON = process.env['DSH_PYTHON'] ?? 'C:/Users/hzq00/AppData/Local/Programs/Python/Python314/python.exe'

let ctx: Context
let root: string
let host: KernelHost | undefined
let service: KernelService | undefined

beforeEach(async () => {
  ctx = new Context()
  await ctx.plugin(Subprocess)
  root = await mkdtemp(join(tmpdir(), 'v3-restart-r3-'))
})

afterEach(async () => {
  if (service !== undefined) {
    await service.close().catch(() => undefined)
    service = undefined
  }
  if (host !== undefined) {
    await host.shutdown().catch(() => undefined)
    host = undefined
  }
  await ctx.fiber.dispose()
  await rm(root, { recursive: true, force: true })
})

function agentFor(sessionId: string, cwd?: string): Agent {
  return { session: { header: { id: sessionId, ...cwd === undefined ? {} : { cwd } } } } as unknown as Agent
}

/** The broker's stderr, which is where a restart failure explains itself. */
async function brokerDiag(h: KernelHost, scratch: string): Promise<Record<string, unknown>> {
  const entries = await readdir(scratch).catch(() => [] as string[])
  const kernelErr = await readFile(join(scratch, 'kernel.err'), 'utf8').catch(() => '')
  return {
    scratchEntries: entries,
    brokerStderrTail: h.diagnosticsText.slice(-1200),
    kernelErrBytes: Buffer.byteLength(kernelErr, 'utf8'),
    kernelErrTail: kernelErr.slice(-600),
  }
}

describe('restart: product path vs hand-built host', () => {
  // -------------------------------------------------------------------------
  // THE PRODUCT PATH. This is the one that decides the spec.
  // -------------------------------------------------------------------------
  it('PRODUCT 1: KernelService restart, twice in one session', async () => {
    const project = await mkdtemp(join(tmpdir(), 'v3-r3-project-'))
    const s = service = new KernelService(ctx, { pythonExecutable: PYTHON, brokerScript: BROKER, root })
    const agent = agentFor('r3-product', project)

    const records: Array<Record<string, unknown>> = []
    for (let trial = 1; trial <= 2; trial += 1) {
      const cell = await s.runCell(agent, `print("product trial ${String(trial)}")`)
      expect(cell.outcome).toBe('ok')
      const epochBefore = s.currentEpoch(agent)
      const beganAt = Date.now()
      let thrown: unknown
      let epochAfter: number | undefined
      try {
        epochAfter = await s.restart(agent)
      } catch (error) {
        thrown = error
      }
      records.push({
        trial,
        ok: thrown === undefined,
        elapsedMs: Date.now() - beganAt,
        epochBefore,
        epochAfter: epochAfter ?? null,
        error: thrown === undefined ? null : String(thrown).slice(0, 240),
      })
    }
    console.log('[V3-EXP3] PRODUCT ' + JSON.stringify({
      shape: 'KernelService: runCell -> restart (x2, same session)',
      records,
    }))

    // The Session must remain usable after each restart, which is the clause that
    // matters for IPY-07's "the kernel is usable afterwards".
    const after = await s.runCell(agent, 'print("usable after restarts")')
    expect(after.outcome).toBe('ok')
    expect(after.stdout.text).toContain('usable after restarts')

    await s.close()
    service = undefined
    await rm(project, { recursive: true, force: true })

    for (const record of records) {
      expect(record['ok'], `PRODUCT restart failed: ${String(record['error'])}`).toBe(true)
    }
  }, 400_000)

  // -------------------------------------------------------------------------
  // THE HAND-BUILT HOST, WITH the service's explicit kernelWorkingDirectory.
  // Isolates candidate (a): does the SEPARATE kernel cwd change the outcome?
  // -------------------------------------------------------------------------
  it('ISOLATE (a): hand-built host WITH an explicit kernelWorkingDirectory', async () => {
    const project = await mkdtemp(join(tmpdir(), 'v3-r3-cwd-'))
    host = new KernelHost({
      subprocess: ctx.subprocess,
      identity: { sessionId: 'r3-cwd', executionWorld: 'local', environmentDigest: 'exp' },
      brokerScript: BROKER,
      pythonExecutable: PYTHON,
      workingDirectory: root,
      kernelWorkingDirectory: project,
    })
    const h = host
    await h.start()
    const cell = await h.execute('print("cwd-variant cell")')
    expect(cell.outcome).toBe('ok')

    const beganAt = Date.now()
    let thrown: unknown
    let epochAfter: number | undefined
    try {
      epochAfter = (await h.restart()).epoch
    } catch (error) {
      thrown = error
    }
    const record = {
      shape: 'hand-built host WITH kernelWorkingDirectory, start -> cell -> restart',
      ok: thrown === undefined,
      elapsedMs: Date.now() - beganAt,
      epochAfter: epochAfter ?? null,
      error: thrown === undefined ? null : String(thrown).slice(0, 240),
    }
    console.log('[V3-EXP3] ISOLATE-A ' + JSON.stringify({
      ...record,
      diagnostics: thrown === undefined ? null : await brokerDiag(h, root),
    }))
    expect(thrown, `ISOLATE-A threw: ${String(thrown)}`).toBeUndefined()
    await rm(project, { recursive: true, force: true })
  }, 300_000)
})
