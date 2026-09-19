/**
 * Requirements 8, 10, and 11: the cases that destroy or flood a kernel.
 *
 * WHY THESE ARE IN THEIR OWN FILE. Each drives the kernel into a state that must
 * NOT be reused, so each gets a fresh `KernelHost` and its own describe block. A
 * kernel that has been killed cannot also demonstrate persistence, and a kernel
 * that has been flooded is not a clean subject for an interrupt test. Sharing one
 * kernel across them produces exactly the measurement artefact M11's own probes
 * hit: a busy kernel makes the NEXT case report `aborted`, which looks like a
 * fact about the namespace and is not.
 *
 * THE HONEST PART. Requirement 8 asks for an interrupt of an `await`-suspended
 * cell. M11 measured that this does NOT settle: `probe-cases.py` records
 * `settled: false` after 20.15 s and again after a second interrupt, with the
 * kernel process still alive. So the test below asserts what the platform
 * actually does -- `unknown` plus a reset, with the epoch advanced -- and the
 * FINDINGS record the await case as a partial PASS with the exact numbers rather
 * than as a closed requirement.
 */
import { Context } from '@deepseek-ai/cordis'
import Subprocess from '@deepseek-ai/dsh-subprocess-local'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { KernelHost, KernelOutcomeUnknownError } from './kernel.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const BROKER = resolve(HERE, 'broker.py')
const PYTHON = process.env['DSH_PYTHON'] ?? 'C:/Users/hzq00/AppData/Local/Programs/Python/Python314/python.exe'

let ctx: Context
let root: string
let host: KernelHost | undefined

beforeEach(async () => {
  ctx = new Context()
  await ctx.plugin(Subprocess)
  root = await mkdtemp(join(tmpdir(), 'dsh-ipython-fault-'))
})

afterEach(async () => {
  if (host !== undefined) {
    await host.shutdown().catch(() => undefined)
    host = undefined
  }
  await ctx.fiber.dispose()
  await rm(root, { recursive: true, force: true })
})

interface HostOptions {
  readonly outputCapBytes?: number
  readonly cellTimeoutMs?: number
  readonly interruptGraceMs?: number
}

function makeHost(options: HostOptions = {}): KernelHost {
  host = new KernelHost({
    subprocess: ctx.subprocess,
    identity: { sessionId: 'faults', executionWorld: 'local', environmentDigest: 'test-env' },
    brokerScript: BROKER,
    pythonExecutable: PYTHON,
    workingDirectory: root,
    ...options.outputCapBytes === undefined ? {} : { outputCapBytes: options.outputCapBytes },
    ...options.cellTimeoutMs === undefined ? {} : { cellTimeoutMs: options.cellTimeoutMs },
    ...options.interruptGraceMs === undefined ? {} : { interruptGraceMs: options.interruptGraceMs },
  })
  return host
}

// ---------------------------------------------------------------------------
// 8. Interrupt then reuse.
// ---------------------------------------------------------------------------

describe('requirement 8: interrupt, then reuse the kernel', () => {
  it('a CPU loop is interrupted, KeyboardInterrupt is reported, and the kernel is reusable', async () => {
    const h = makeHost({ interruptGraceMs: 8_000 })
    await h.execute('survivor_before_interrupt = "still here"')

    const cell = h.execute('while True:\n    pass')
    // Let the loop actually start before signalling; interrupting a cell that has
    // not begun would test the queue, not the kernel.
    await new Promise(resolvePromise => setTimeout(resolvePromise, 1200))
    const interrupt = await h.interrupt()
    expect(interrupt.interrupted).toBe(true)

    const result = await cell
    expect(result.outcome).toBe('interrupted')
    expect(result.error?.ename).toBe('KeyboardInterrupt')

    // Reuse is the requirement's second half, and it is the part that matters:
    // an interrupt that leaves a wedged kernel would be worse than a timeout.
    const after = await h.execute('print("reused:", survivor_before_interrupt)')
    expect(after.outcome).toBe('ok')
    expect(after.stdout.text).toContain('reused: still here')
  }, 180_000)

  it('an interrupt of an await-suspended cell reports unknown and resets, never a false success', async () => {
    // MEASURED: this cell does not settle. `probe-cases.py` records
    // settled=false after 20.15 s and again after a second interrupt, with the
    // kernel alive. The requirement's own escape hatch applies -- "if the outcome
    // cannot be established, report unknown and reset" -- so that is what is
    // asserted. Asserting `interrupted` here would be asserting something the
    // platform does not do.
    const h = makeHost({ interruptGraceMs: 6_000, cellTimeoutMs: 90_000 })
    await h.execute('await_marker = "pre-interrupt"')
    const epochBefore = h.currentEpoch

    const cell = h.execute('import asyncio\nawait asyncio.sleep(600)')
    await new Promise(resolvePromise => setTimeout(resolvePromise, 1500))
    await h.interrupt()

    let thrown: unknown
    try {
      await cell
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(KernelOutcomeUnknownError)
    const unknown = thrown as KernelOutcomeUnknownError
    expect(unknown.result.outcome).toBe('unknown')
    // The reset is asserted, not assumed: the epoch must have advanced, because
    // that number is the only signal the next caller gets that the namespace it
    // remembers is gone.
    expect(unknown.result.generation?.volatileStateLost).toBe(true)
    expect(h.currentEpoch).toBeGreaterThan(epochBefore)

    // And the post-reset kernel is genuinely usable, with the old state GONE.
    const after = await h.execute('print("epoch after reset:", "await_marker" in dir())')
    expect(after.outcome).toBe('ok')
    expect(after.stdout.text).toContain('epoch after reset: False')
  }, 240_000)
})

// ---------------------------------------------------------------------------
// 10. Bounded output.
// ---------------------------------------------------------------------------

describe('requirement 10: a flooding cell cannot OOM the host', () => {
  it('hundreds of MB of stdout is capped, reported truncated, and spilled', async () => {
    // 200 MB is the number M11's probe used: `probe-cases.py` measured ipykernel
    // coalescing it into TWO stream messages, so the cap has to be enforced on
    // the receiving side rather than hoped for from the sender.
    const cap = 64 * 1024
    const h = makeHost({ outputCapBytes: cap, cellTimeoutMs: 180_000 })
    const result = await h.execute(
      [
        'chunk = "x" * 65536',
        'for _ in range(3200):',
        '    print(chunk, end="")',
        'print()',
        'print("FLOOD-DONE")',
      ].join('\n'),
    )
    // The cell itself SUCCEEDED; only its output was bounded. Reporting the cell
    // as failed would be a different lie from reporting the output as complete.
    expect(result.outcome).toBe('ok')
    expect(result.stdout.truncated).toBe(true)
    expect(result.stdout.totalBytes).toBeGreaterThan(200 * 1024 * 1024)
    // The retained text is bounded by the cap, so the host's own memory is too.
    expect(Buffer.byteLength(result.stdout.text, 'utf8')).toBeLessThanOrEqual(cap)
    // The loss is recoverable: a spill file holds what was dropped.
    // Asserted before use rather than asserted away with `!`: a `!` here would turn
    // "no spill path was reported" into `stat(undefined)`, which throws a type error
    // that reads like a test-harness bug instead of the product failure it is.
    expect(result.stdout.spillPath).toBeDefined()
    const spillPath = result.stdout.spillPath
    if (spillPath === undefined) throw new Error('the truncated cell reported no spill path')
    const spill = await stat(spillPath)
    expect(spill.size).toBeGreaterThan(0)
    expect(h.currentEpoch).toBeGreaterThan(0)
  }, 300_000)

  it('a cell under the cap reports no truncation, so the flag is not always-on', async () => {
    const h = makeHost({ outputCapBytes: 64 * 1024 })
    const result = await h.execute('print("small output")')
    expect(result.outcome).toBe('ok')
    expect(result.stdout.truncated).toBe(false)
    expect(result.stdout.spillPath).toBeUndefined()
    expect(result.stdout.text).toContain('small output')
  }, 120_000)

  it('a giant display payload is bounded too, not just stdout', async () => {
    const h = makeHost({ outputCapBytes: 32 * 1024 })
    const result = await h.execute(
      [
        'from IPython.display import display',
        'display({"payload": "y" * (4 * 1024 * 1024)})',
      ].join('\n'),
    )
    expect(result.outcome).toBe('ok')
    expect(result.display.length).toBeGreaterThan(0)
    // The display channel has its own cap, independent of the stream cap: a
    // single MIME payload is one message and would otherwise bypass it entirely.
    for (const entry of result.display) {
      expect(Buffer.byteLength(entry.text, 'utf8')).toBeLessThanOrEqual(64 * 1024)
    }
  }, 180_000)
})

// ---------------------------------------------------------------------------
// 11. Kernel death changes the generation.
// ---------------------------------------------------------------------------

describe('requirement 11: kernel death changes the generation', () => {
  it('killing the kernel reports a NEW epoch and a lost-state notice', async () => {
    const h = makeHost()
    await h.execute('precious = "built before the kill"')
    const epochBefore = h.currentEpoch
    const status = await h.status()
    expect(status.pid).toBeDefined()

    // Kill the kernel process directly. This is the hostile case: no request asked
    // for it, so nothing in the protocol announced it.
    const { execFile } = await import('node:child_process')
    await new Promise<void>((resolvePromise) => {
      execFile('taskkill', ['/F', '/PID', String(status.pid)], () => { resolvePromise() })
    })
    await new Promise(resolvePromise => setTimeout(resolvePromise, 1500))

    // The next call must report the loss. It must NOT silently continue as if the
    // variable still existed, and it must NOT be a false success.
    const result = await h.execute('print("value:", precious)')
    expect(result.outcome).not.toBe('ok')
    expect(result.generation?.volatileStateLost).toBe(true)
    expect(result.generation?.previousEpoch).toBe(epochBefore)
    expect(result.generation?.epoch).toBeGreaterThan(epochBefore)
    expect(result.generation?.reason).toBeTruthy()
    expect(h.currentEpoch).toBeGreaterThan(epochBefore)
  }, 240_000)

  it('after the death is reported, the replacement kernel is usable and empty', async () => {
    const h = makeHost()
    await h.execute('marker_variable = 1')
    const status = await h.status()
    const { execFile } = await import('node:child_process')
    await new Promise<void>((resolvePromise) => {
      execFile('taskkill', ['/F', '/PID', String(status.pid)], () => { resolvePromise() })
    })
    await new Promise(resolvePromise => setTimeout(resolvePromise, 1500))

    // First call after the death: reports the loss.
    await h.execute('pass').catch(() => undefined)
    // Second call: runs against the replacement, which cannot know the variable.
    const after = await h.execute('print("marker present:", "marker_variable" in dir())')
    expect(after.outcome).toBe('ok')
    expect(after.stdout.text).toContain('marker present: False')
  }, 240_000)
})
