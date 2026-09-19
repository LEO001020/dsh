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
import type { Agent } from '@deepseek-ai/dsh-agent'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { KernelHost, KernelOutcomeUnknownError } from './kernel.ts'
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
  root = await mkdtemp(join(tmpdir(), 'dsh-ipython-fault-'))
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

// ---------------------------------------------------------------------------
// IPY-07 (second half): a cell that TIMES OUT is not silently abandoned, and the
// loss of its state is reported rather than implied.
//
// WHAT IS MEASURED, and why the assertion is `unknown` rather than `interrupted`.
// A pure-Python loop that overruns `cellTimeoutMs` is NOT interrupted by the
// timeout itself: the timeout path in `broker.py:655-664` reports the cell
// unsettled and calls `_unknown_result`, which resets the kernel. Measured with
// `cellTimeoutMs: 6000, interruptGraceMs: 4000`: the call threw
// `KernelOutcomeUnknownError` after 8.2 s, the epoch advanced 1 -> 2, the kernel
// PID CHANGED (29896 -> 36552), and the pre-timeout variable was gone.
//
// So a timeout destroys volatile state. That is a real product behaviour and it is
// asserted as such, because the alternative -- reporting `interrupted` for a cell
// that was never interrupted -- would be a false claim about what happened.
// ---------------------------------------------------------------------------

describe('IPY-07: a cell that overruns the budget is classified, and its state loss is stated', () => {
  it('a timeout reports unknown with a NEW epoch and a replaced kernel, never a false success', async () => {
    const h = makeHost({ cellTimeoutMs: 6_000, interruptGraceMs: 4_000 })
    const started = await h.start()
    const pidBefore = started.pid
    const epochBefore = h.currentEpoch
    await h.execute('kept_across_timeout = "value set before the overrun"')

    const beganAt = Date.now()
    let thrown: unknown
    try {
      await h.execute('while True:\n    pass')
    } catch (error) {
      thrown = error
    }
    const elapsed = Date.now() - beganAt

    // The outcome must be `unknown`, and it must be an ERROR rather than a
    // returned result: a caller that ignored a field would otherwise mistake a
    // reset kernel for a completed cell.
    expect(thrown).toBeInstanceOf(KernelOutcomeUnknownError)
    const unknown = thrown as KernelOutcomeUnknownError
    expect(unknown.result.outcome).toBe('unknown')
    expect(unknown.result.generation?.volatileStateLost).toBe(true)
    expect(unknown.result.generation?.epoch).toBeGreaterThan(epochBefore)
    // The reason names the budget, so the report says WHY rather than only THAT.
    expect(unknown.result.generation?.reason).toContain('6000 ms')

    // The elapsed time is bounded: the cell must be classified, not waited on
    // forever. The bound is generous (budget + grace + a start allowance) and is
    // asserted so a regression that hung would fail rather than time out opaquely.
    expect(elapsed).toBeLessThan(60_000)

    // The kernel was REPLACED, and the host can see that: a new pid, alive.
    const after = await h.status()
    expect(after.alive).toBe(true)
    expect(after.pid).toBeDefined()
    expect(after.pid).not.toBe(pidBefore)

    // And the pre-timeout variable is GONE -- the consequence the epoch change
    // was announcing. Asserting this is what makes "volatileStateLost: true" a
    // fact rather than a label.
    const state = await h.execute('print("kept_across_timeout present:", "kept_across_timeout" in dir())')
    expect(state.outcome).toBe('ok')
    expect(state.stdout.text).toContain('kept_across_timeout present: False')
  }, 300_000)

  it('the replacement kernel after a timeout is genuinely usable', async () => {
    // A reset that left an unusable kernel would satisfy the classification test
    // above while being a worse product: the Session would be dead. This is the
    // "reuse" half of the requirement.
    const h = makeHost({ cellTimeoutMs: 5_000, interruptGraceMs: 4_000 })
    await h.start()
    await h.execute('while True:\n    pass').catch(() => undefined)

    const usable = await h.execute('print("replacement usable:", 21 * 2)')
    expect(usable.outcome).toBe('ok')
    expect(usable.stdout.text).toContain('replacement usable: 42')
  }, 300_000)
})

// ---------------------------------------------------------------------------
// IPY-07 (restart): restart semantics -- what survives and what does not.
//
// MEASURED, and the numbers are the assertion's basis: `restart()` advanced the
// epoch 1 -> 2, replaced the kernel PID (19352 -> 36164), and the variable set
// before the restart was gone (`survives_restart present: False`), while the
// replacement answered a new cell correctly. The kernel's cwd was preserved
// across the restart, which matters: a restart that silently moved the kernel to
// a scratch directory would reintroduce the wrong-relative-path defect for every
// cell after it.
// ---------------------------------------------------------------------------

describe('IPY-07: restart replaces the kernel and preserves its working directory', () => {
  it('restart advances the epoch, replaces the process, loses the namespace, and keeps the cwd', async () => {
    // THE SERVICE IS THE SUBJECT, not a bare `KernelHost`. The service is the layer
    // that creates the kernel's working directory (`kernel-plugin.ts:180`); a
    // `KernelHost` constructed by hand with a directory that does not exist fails
    // with the broker's own `NotADirectoryError`, which is a fact about the
    // harness and not about the product. Measured: that is exactly how the first
    // version of this test failed.
    const project = await mkdtemp(join(tmpdir(), 't6-restart-project-'))
    const s = service = new KernelService(ctx, {
      pythonExecutable: PYTHON,
      brokerScript: BROKER,
      root,
    })
    const agent = {
      session: { header: { id: 'restart', cwd: project } },
    } as unknown as Agent

    await s.runCell(agent, 'survives_restart = "set before the restart"')
    const before = await s.status(agent)
    expect(before).toBeDefined()
    if (before === undefined) throw new Error('no status for a live kernel')
    const epochBefore = before.epoch
    expect(s.currentEpoch(agent)).toBe(epochBefore)

    const epochAfter = await s.restart(agent)
    const after = await s.status(agent)
    expect(after).toBeDefined()
    if (after === undefined) throw new Error('no status after the restart')

    // (1) A restart is a NEW GENERATION, always -- it is not a no-op.
    expect(epochAfter).toBeGreaterThan(epochBefore)
    expect(s.currentEpoch(agent)).toBe(epochAfter)
    expect(after.epoch).toBe(epochAfter)
    // (2) The PROCESS is replaced, not merely the epoch counter. This is the
    //     assertion that separates a real restart from a bookkeeping change.
    expect(before.pid).toBeDefined()
    expect(after.pid).toBeDefined()
    expect(after.pid).not.toBe(before.pid)
    // (3) The kernel is alive and usable afterwards.
    expect(after.alive).toBe(true)
    // (4) The cwd SURVIVES the restart: a restarted kernel that lost its
    //     directory would silently root every later cell somewhere else, which is
    //     the wrong-relative-path defect IPY-15 exists to prevent.
    expect(after.kernelCwd).toBe(before.kernelCwd)
    expect(after.kernelCwdEnforced).toBe(true)
    expect((after.kernelCwd ?? '').replace(/\\/g, '/').toLowerCase())
      .toBe(project.replace(/\\/g, '/').toLowerCase())

    // (5) The namespace is GONE, and the replacement is still usable. Both are
    //     asserted because either alone is satisfiable by a broken kernel.
    const state = await s.runCell(agent, 'print("survives_restart present:", "survives_restart" in dir())')
    expect(state.outcome).toBe('ok')
    expect(state.stdout.text).toContain('survives_restart present: False')
    const usable = await s.runCell(agent, 'print("usable after restart:", 6 * 7)')
    expect(usable.stdout.text).toContain('usable after restart: 42')

    await s.close()
    service = undefined
    await rm(project, { recursive: true, force: true })
  }, 300_000)
})

// ---------------------------------------------------------------------------
// IPY-12 (boundary): the output cap governs the IOPub projection, NOT the
// kernel's real stdout descriptor.
//
// THIS IS A FINDING, PINNED SO IT CANNOT BE FORGOTTEN. A cell that writes to
// fd 1 directly (`os.write(1, ...)`) bypasses the cap completely: the bytes go to
// the file the broker redirected stdout into (`kernel.out` in the scratch
// directory), and IOPub never carries them. MEASURED with a 4096-byte cap: the
// cell reported `stdoutBytes: 10`, `truncated: false`, and `kernel.out` grew from
// 0 to exactly 5,000,000 bytes.
//
// The consequence is bounded by a host-side file rather than by host memory, so it
// is not the OOM class the cap exists to prevent. It IS a silent-loss class: a
// model that writes to fd 1 sees a clean, untruncated result and never learns that
// 5 MB went somewhere it cannot read. The test asserts the observed behaviour
// rather than a guarantee, so that a future change either keeps this exact
// boundary or fails here and has to say why.
// ---------------------------------------------------------------------------

describe('IPY-12: the cap bounds the cell projection, and a direct fd-1 write is a measured boundary', () => {
  it('stdout written through the cell\'s own fd 1 is NOT capped, and is recorded as such', async () => {
    const cap = 4_096
    const h = makeHost({ outputCapBytes: cap, cellTimeoutMs: 180_000 })
    await h.start()
    const logPath = join(root, 'kernel.out')
    const sizeBefore = (await stat(logPath).catch(() => undefined))?.size ?? 0

    const result = await h.execute('import os\nos.write(1, b"B" * 5_000_000)\nprint("CELL-DONE")')
    expect(result.outcome).toBe('ok')

    // What the MODEL sees: small, untruncated, and therefore not obviously lossy.
    expect(result.stdout.totalBytes).toBeLessThan(cap)
    expect(result.stdout.truncated).toBe(false)
    expect(result.stdout.text).toContain('CELL-DONE')

    // What actually happened: the bytes landed in the kernel's log file.
    const sizeAfter = (await stat(logPath)).size
    expect(sizeAfter - sizeBefore).toBe(5_000_000)

    // The bound that IS enforced is on IOPub, which is what the cap governs. A
    // normal print flood through the cap is asserted in the requirement-10 tests
    // above; this test exists to record that fd-1 is outside it.
    expect(result.stdout.text).not.toContain('BBBB')
  }, 300_000)
})
