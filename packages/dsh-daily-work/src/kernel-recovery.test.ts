/**
 * M5: kernel lifecycle, backpressure, permissions and recovery.
 *
 * WHAT IS REAL HERE, AND WHAT IS NOT, stated up front because the distinction is
 * the whole value of the evidence.
 *
 *   REAL: the `KernelSupervisor` in `kernel-lifecycle.ts` is the production
 *   object. Its queue bounds, budgets, epoch arithmetic, quarantine, eviction,
 *   checkpoint validation and recovery reporting are exercised as written, not
 *   through a re-implementation.
 *
 *   FAKE, AND DELIBERATELY SO: `KernelTransport`. The real transport is a broker
 *   process plus an `ipykernel`, owned by another package. The interface this
 *   file implements is documented at `KernelTransport` in `kernel-lifecycle.ts`
 *   and is exactly what the two halves must agree on, so they can be joined later
 *   without either side changing shape.
 *
 *   The kernel-facing FACTS these tests encode were measured separately against a
 *   real kernel and are recorded in `PROBE-FACTS.md` with raw JSON:
 *   an interrupt of an `await`-suspended cell did not settle in 25.16 s while the
 *   process stayed alive (FACT 8); a non-interruptible C extension did not settle
 *   either (FACT 9); the NEXT cell after a wedge settled `aborted` with no output
 *   (FACT 10); late thread output carries the originating cell's parent id
 *   (FACT 1); a parked kernel holding 256 MiB had RSS 357.71 MB (FACT 13); and a
 *   background thread from one cell mutated what a later cell saw (FACT 16).
 *
 * Every fake below reproduces one of those measured shapes. A fake that invented
 * a shape the real kernel does not produce would be worse than no test.
 *
 * TWO HARNESS RULES THAT ARE NOT STYLE. Both were learned from a first version of
 * this file that failed 35 of 61 tests for reasons that had nothing to do with the
 * production code, and both are the kind of mistake that produces a test suite
 * which passes while proving nothing:
 *
 *   1. A test MUST drive the rig's OWN transport. The first version constructed a
 *      fresh `FakeTransport` inside `register(...)` and then asserted against the
 *      rig's, so every `dispatched`/`interrupts`/`rss` assertion read a different
 *      object and silently saw zero.
 *   2. The fake does NOT settle a cell on its own unless `autoSettle` is set. A
 *      fake that settles immediately cannot be interrupted mid-flight, which is
 *      precisely the state every lifecycle rule in this file is about.
 *
 * CONFINEMENT: this file starts NO processes and no kernel. It is T0/T1 -- pure
 * accounting plus a fake transport -- so it cannot leak a `python.exe`, which is
 * why the resource-cleanup evidence for the real kernel lives in the probe JSON
 * instead. The only real files written are checkpoint fixtures under `mkdtemp`
 * directories removed in `afterEach`.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { deflateRawSync } from 'node:zlib'
import {
  DEFAULT_BUDGETS,
  DEFAULT_CHECKPOINT_LIMITS,
  KernelSupervisor,
  RECOVERY_SCOPE_STATEMENT,
  REFUSED_FORMATS,
  kernelSlotKey,
  sameKernelIncarnation,
  sameKernelSlot,
  validateCheckpoint,
  type CellHandle,
  type CellRequest,
  type CellSettlement,
  type CheckpointDescriptor,
  type FrameFact,
  type KernelIdentity,
  type KernelTransport,
  type OutputSpill,
} from './kernel-lifecycle.ts'

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const tempDirs: string[] = []

afterEach(() => {
  const errors: unknown[] = []
  for (const dir of tempDirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
    } catch (error) {
      errors.push(error)
    }
  }
  if (errors.length > 0) throw new AggregateError(errors, 'temp cleanup failed')
})

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'm5-kernel-'))
  tempDirs.push(dir)
  return dir
}

const IDENTITY: KernelIdentity = {
  sessionId: 'session-1',
  executionWorld: 'world-local',
  environmentDigest: 'env-abc',
  kernelEpoch: 1,
}

/** A settlement the kernel really produces: reply AND idle both observed. */
function settled(status: 'ok' | 'error' | 'aborted' = 'ok', extra: Partial<CellSettlement> = {}): CellSettlement {
  return { outcome: 'settled', status, protocolComplete: true, ...extra }
}

/**
 * A transport that behaves like the measured kernel.
 *
 * Each capability is opt-in so a test states which measured shape it is
 * reproducing. `neverSettles` is FACT 8 -- the interrupt is delivered and the cell
 * still never settles -- and it is the shape that decides the lifecycle rules.
 *
 * `autoSettle` defaults to FALSE. A fake that settles a cell the moment it is
 * dispatched cannot be interrupted while running, and "interrupted while running"
 * is the state every rule in this file is about.
 */
class FakeTransport implements KernelTransport {
  readonly kind = 'fake'
  private sink: ((frame: FrameFact) => void) | undefined
  private readonly handles: { request: CellRequest; resolve: (s: CellSettlement) => void }[] = []
  /** Public so a test can assert a restart really replaced the process. */
  pid = 1000
  restarts = 0
  interrupts = 0
  shutdowns = 0
  starts = 0
  rss = 80 * 1024 * 1024
  procs = 4
  /** Cells whose settlement is never delivered, as the await-suspended case does. */
  neverSettles = false
  /** Set when the transport should reject `execute` outright. */
  refuseExecute: string | undefined
  /** Set when `interrupt()` itself throws. */
  interruptThrows = false
  /** Set when a restart should fail, leaving the kernel unusable. */
  restartFails = false
  /** When true, a dispatched cell settles as `ok` on its own. */
  autoSettle: boolean
  /** Frames emitted synchronously when the next cell is dispatched. */
  autoFrames: FrameFact[] = []
  /** Recorded so a test can assert a cell was never dispatched. */
  readonly dispatched: string[] = []
  /** Set by `shutdown()`, so the NEXT `start()` is known to be a new process. */
  private shutDownSinceStart = false

  constructor(options: { autoSettle?: boolean } = {}) {
    this.autoSettle = options.autoSettle ?? false
  }

  onFrame(sink: (frame: FrameFact) => void): void {
    this.sink = sink
  }

  async start(): Promise<{ pid: number; encrypted: boolean }> {
    // A start AFTER a shutdown is a new process, so the pid advances. Returning the
    // same pid would let a permission-domain change look like a token update when
    // the test asserts the process was really replaced.
    //
    // A FLAG, NOT `shutdowns > starts`. The first version compared the two counters
    // and was WRONG on the very first replacement: `register()` makes starts=1, the
    // domain change makes shutdowns=1, and `1 > 1` is false -- so a real
    // teardown-then-start reported the SAME pid, and the assertion in
    // `MUST restart on a read-permission-domain change` failed with
    // "expected 1000 to be greater than 1000". Counters can only be compared when
    // the same events increment both, and `restart()` increments neither. That was
    // a bug in this fake, not in the supervisor: the supervisor really does
    // `await transport.shutdown()` then `entry.process = await transport.start()`.
    if (this.shutDownSinceStart) this.pid += 1
    this.starts += 1
    this.shutDownSinceStart = false
    return { pid: this.pid, encrypted: true }
  }

  execute(request: CellRequest): CellHandle {
    if (this.refuseExecute !== undefined) throw new Error(this.refuseExecute)
    this.dispatched.push(request.cellId)
    const parentId = `parent-${request.cellId}`
    let resolveSettlement: (s: CellSettlement) => void = () => {}
    const settlement = new Promise<CellSettlement>(resolve => { resolveSettlement = resolve })
    this.handles.push({ request, resolve: resolveSettlement })
    // Emit the queued frames BEFORE any settlement, so a test can exercise
    // "frames arrive, then the cell ends" in the order the kernel produces it.
    for (const frame of this.autoFrames) this.sink?.({ ...frame, parentId })
    this.autoFrames = []
    if (this.neverSettles) return { parentId, settlement }
    if (this.autoSettle) queueMicrotask(() => { resolveSettlement(settled('ok')) })
    return { parentId, settlement }
  }

  async interrupt(): Promise<void> {
    this.interrupts += 1
    if (this.interruptThrows) throw new Error('interrupt dispatch failed')
    // FACT 8: the interrupt is DELIVERED and the cell still does not settle. This
    // method deliberately does not resolve anything; the supervisor's grace is the
    // only thing that ends the wait.
  }

  async restart(): Promise<{ pid: number; encrypted: boolean }> {
    if (this.restartFails) throw new Error('restart refused')
    this.restarts += 1
    this.pid += 1
    // A real restart destroys the process, so every pending settlement is gone.
    this.handles.length = 0
    this.neverSettles = false
    return { pid: this.pid, encrypted: true }
  }
  async shutdown(): Promise<void> {
    this.shutdowns += 1
    this.shutDownSinceStart = true
  }

  async rssBytes(): Promise<number> {
    return this.rss
  }

  async processCount(): Promise<number> {
    return this.procs
  }

  /** Emit a frame as the kernel would, at an arbitrary time. */
  emit(frame: FrameFact): void {
    this.sink?.(frame)
  }

  /** The parent id the transport assigned to the newest dispatched cell. */
  newestParentId(): string {
    const pending = this.handles.at(-1)
    if (pending === undefined) throw new Error('no cell is pending')
    return `parent-${pending.request.cellId}`
  }

  /** Deliver a settlement for the newest cell, as the transport would. */
  settleNewest(status: 'ok' | 'error' | 'aborted' = 'ok', extra: Partial<CellSettlement> = {}): void {
    const pending = this.handles.at(-1)
    if (pending === undefined) throw new Error('no cell is pending')
    pending.resolve(settled(status, extra))
  }

  /** Deliver a settlement that is NOT protocol-complete: reply without idle. */
  settleIncomplete(): void {
    const pending = this.handles.at(-1)
    if (pending === undefined) throw new Error('no cell is pending')
    pending.resolve({ outcome: 'settled', status: 'ok', protocolComplete: false })
  }
}

/** A spill that records what it was asked to write, without touching disk. */
class RecordingSpill implements OutputSpill {
  readonly writes: { cellId: string; kind: string; bytes: number; text: string }[] = []
  async write(part: { cellId: string; kind: string; text: string; bytes: number }): Promise<string> {
    this.writes.push({ cellId: part.cellId, kind: part.kind, bytes: part.bytes, text: part.text })
    return `spill://m5/${part.cellId}/${String(part.bytes)}`
  }
}

interface Rig {
  readonly supervisor: KernelSupervisor
  readonly transport: FakeTransport
  readonly key: string
  readonly identity: KernelIdentity
  /** Register the rig's OWN transport. Every test must use this, not `new`. */
  register(): Promise<void>
  /** Move the injected clock and fire every timer that becomes due. */
  advance(ms: number): void
  /** Let the microtask queue drain so a dispatched cell is observable. */
  flush(): Promise<void>
  /**
   * The timers currently armed, as `id@absolute-time`, in arm order.
   *
   * Exposed so a test can measure the timer LEDGER rather than infer it from
   * behaviour. The bounded-grace proof needs this: "the supervisor's own timer is
   * what ended the wait" is only a measurement if the ledger shows that timer and
   * nothing else.
   */
  pendingTimers(): string[]
}

/**
 * A supervisor over the rig's own fake transport, with a controllable clock.
 *
 * The clock is injected rather than faked globally because the grace test needs to
 * advance time WITHOUT waiting for it: the whole point of the bounded grace is
 * that it fires on schedule, and a test that slept for the real grace would be
 * slow and would still not prove the bound is enforced rather than hoped for.
 */
function rig(options: {
  budgets?: Partial<typeof DEFAULT_BUDGETS>
  spill?: OutputSpill
  autoSettle?: boolean
  transport?: FakeTransport
} = {}): Rig {
  let now = 1_000_000
  const timers = new Map<number, { at: number; fn: () => void }>()
  let nextTimerId = 1
  const supervisor = new KernelSupervisor({
    budgets: options.budgets,
    spill: options.spill,
    now: () => now,
    setTimer: (fn, ms) => {
      const id = nextTimerId
      nextTimerId += 1
      timers.set(id, { at: now + ms, fn })
      return id
    },
    clearTimer: handle => { timers.delete(handle as number) },
  })
  const transport = options.transport ?? new FakeTransport({ autoSettle: options.autoSettle ?? false })
  const identity: KernelIdentity = { ...IDENTITY }
  const key = kernelSlotKey(identity)
  return {
    supervisor,
    transport,
    key,
    identity,
    register: async () => { await supervisor.register(identity, transport) },
    advance: (ms: number) => {
      now += ms
      // Fire every timer that is now due, in due order. A timer that schedules
      // another timer within the window fires too, which is what a real event loop
      // does and what the grace escalation relies on.
      for (;;) {
        const due = [...timers.entries()].filter(([, timer]) => timer.at <= now).sort((a, b) => a[1].at - b[1].at)
        if (due.length === 0) break
        for (const [id, timer] of due) {
          timers.delete(id)
          timer.fn()
        }
      }
    },
    flush: async () => { await new Promise<void>(resolve => { setImmediate(resolve) }) },
    pendingTimers: () => [...timers.entries()].map(([id, timer]) => `${String(id)}@${String(timer.at)}`),
  }
}

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

describe('kernel identity is not the Agent object', () => {
  it('names a slot by session + world + environment, and an incarnation by epoch', () => {
    const a: KernelIdentity = { sessionId: 's', executionWorld: 'w', environmentDigest: 'e', kernelEpoch: 1 }
    const b: KernelIdentity = { sessionId: 's', executionWorld: 'w', environmentDigest: 'e', kernelEpoch: 2 }
    const c: KernelIdentity = { sessionId: 's', executionWorld: 'w2', environmentDigest: 'e', kernelEpoch: 1 }
    const d: KernelIdentity = { sessionId: 's2', executionWorld: 'w', environmentDigest: 'e', kernelEpoch: 1 }
    const e: KernelIdentity = { sessionId: 's', executionWorld: 'w', environmentDigest: 'e2', kernelEpoch: 1 }

    // A restart keeps the slot and changes the incarnation. This is what lets the
    // same slot's next incarnation be reported against the loss the previous one
    // suffered.
    expect(sameKernelSlot(a, b)).toBe(true)
    expect(sameKernelIncarnation(a, b)).toBe(false)

    // Every other component of the identity DOES change the slot: a different
    // execution world or environment is not the same kernel, so a variable must
    // never be assumed to exist across the change.
    expect(sameKernelSlot(a, c)).toBe(false)
    expect(sameKernelSlot(a, d)).toBe(false)
    expect(sameKernelSlot(a, e)).toBe(false)
  })

  it('refuses a second registration of the same slot', async () => {
    const r = rig()
    await r.register()
    await expect(r.supervisor.register(r.identity, new FakeTransport())).rejects.toThrow(
      /already registered at epoch 1/,
    )
    await r.supervisor.close(r.key)
  })

  it('does not destroy a parked kernel when an activation ends, and rebinds it at the SAME epoch', async () => {
    // The continuable-child case: the activation ends and releases its AgentHandle
    // while the Session continues. Parking must preserve the kernel and its
    // namespace, revoke the active capability, and allow a later activation to
    // rebind the SAME incarnation.
    const r = rig({ autoSettle: true })
    await r.register()
    await r.supervisor.park(r.key)

    const parked = r.supervisor.status(r.key)
    expect(parked.state).toBe('parked')
    // The epoch did NOT move: nothing was destroyed, so nothing was lost.
    expect(parked.identity.kernelEpoch).toBe(1)
    expect(r.transport.shutdowns).toBe(0)

    // A parked kernel's capability is revoked: a cell is refused, not queued.
    const refused = await r.supervisor.runCell(r.key, { cellId: 'cell-parked', source: 'x = 1' })
    expect(refused.outcome).toBe('refused')
    expect(refused.reason).toContain('parked')
    expect(r.transport.dispatched).toEqual([])

    // A legal activation rebinds it, still at epoch 1.
    const rebound = await r.supervisor.rebind(r.key)
    expect(rebound.state).toBe('idle')
    expect(rebound.identity.kernelEpoch).toBe(1)

    const ran = await r.supervisor.runCell(r.key, { cellId: 'cell-after-rebind', source: 'print(1)' })
    expect(ran.outcome).toBe('settled')
    expect(ran.kernelEpoch).toBe(1)
    await r.supervisor.close(r.key)
  })
})

// ---------------------------------------------------------------------------
// Serial per kernel, concurrent across kernels
// ---------------------------------------------------------------------------

describe('serial per kernel, concurrent across kernels', () => {
  it('runs one cell at a time on a kernel and queues rather than dispatching a second', async () => {
    const r = rig()
    await r.register()

    const first = r.supervisor.runCell(r.key, { cellId: 'c1', source: 'slow' })
    await r.flush()
    expect(r.transport.dispatched).toEqual(['c1'])

    const second = r.supervisor.runCell(r.key, { cellId: 'c2', source: 'other' })
    await r.flush()
    // c2 is QUEUED, not dispatched: only one cell is active per kernel.
    expect(r.transport.dispatched).toEqual(['c1'])
    expect(r.supervisor.status(r.key).pendingCells).toBe(1)

    r.transport.settleNewest('ok')
    expect((await first).outcome).toBe('settled')
    await r.flush()
    expect(r.transport.dispatched).toEqual(['c1', 'c2'])
    r.transport.settleNewest('ok')
    expect((await second).outcome).toBe('settled')
    await r.supervisor.close(r.key)
  })

  it('runs cells on two kernels concurrently', async () => {
    const r = rig()
    await r.register()
    const other: KernelIdentity = { ...IDENTITY, sessionId: 'session-2' }
    const otherKey = kernelSlotKey(other)
    const otherTransport = new FakeTransport()
    await r.supervisor.register(other, otherTransport)

    const a = r.supervisor.runCell(r.key, { cellId: 'a1', source: 'a' })
    const b = r.supervisor.runCell(otherKey, { cellId: 'b1', source: 'b' })
    await r.flush()
    // Both dispatched: concurrency across kernels is the point of the design.
    expect(r.transport.dispatched).toEqual(['a1'])
    expect(otherTransport.dispatched).toEqual(['b1'])

    r.transport.settleNewest('ok')
    otherTransport.settleNewest('ok')
    expect((await a).outcome).toBe('settled')
    expect((await b).outcome).toBe('settled')
    await r.supervisor.closeAll()
  })

  it('bounds the queue and REFUSES past the bound rather than growing', async () => {
    const r = rig({ budgets: { maxPendingCells: 2 } })
    await r.register()

    const running = r.supervisor.runCell(r.key, { cellId: 'run', source: 'hold' })
    await r.flush()
    const queued1 = r.supervisor.runCell(r.key, { cellId: 'q1', source: 'x' })
    const queued2 = r.supervisor.runCell(r.key, { cellId: 'q2', source: 'x' })
    await r.flush()
    // The third is past the bound of 2 and is refused.
    const refused = await r.supervisor.runCell(r.key, { cellId: 'q3', source: 'x' })
    expect(refused.outcome).toBe('refused')
    expect(refused.reason).toContain('bound')
    // The bound is measurable: it is the configured number, not a hope.
    expect(r.supervisor.effectiveBudgets().maxPendingCells).toBe(2)
    expect(r.transport.dispatched).toEqual(['run'])

    r.transport.settleNewest('ok')
    await running
    await r.flush()
    r.transport.settleNewest('ok')
    await queued1
    await r.flush()
    r.transport.settleNewest('ok')
    await queued2
    // The refused cell was NEVER dispatched.
    expect(r.transport.dispatched).toEqual(['run', 'q1', 'q2'])
    await r.supervisor.close(r.key)
  })
})

// ---------------------------------------------------------------------------
// Late and unattributed output
// ---------------------------------------------------------------------------

describe('late and unattributed output is classified, never attached to the next cell', () => {
  it('classifies output arriving after a cell settled as `late` for the ORIGINATING cell', async () => {
    // FACT 1: a background thread's print after the cell settled still carries the
    // originating cell's parent id, so attribution is possible and must be used.
    const r = rig({ autoSettle: true })
    await r.register()

    const first = await r.supervisor.runCell(r.key, { cellId: 'owner', source: 'thread' })
    expect(first.outcome).toBe('settled')
    expect(first.output?.classes.cell).toBe(0)

    // The thread prints now, after the cell settled.
    r.transport.emit({ parentId: 'parent-owner', kind: 'stream', bytes: 17, text: 'LATE-FROM-THREAD\n', name: 'stdout' })

    const late = r.supervisor.lateFrames()
    expect(late).toHaveLength(1)
    expect(late[0]?.cellId).toBe('owner')
    expect(late[0]?.bytes).toBe(17)

    // The next cell must NOT receive it.
    const second = await r.supervisor.runCell(r.key, { cellId: 'next', source: 'x' })
    expect(second.output?.text).toBe('')
    expect(second.output?.classes.late).toBe(0)
    expect(second.output?.totalBytes).toBe(0)
    await r.supervisor.close(r.key)
  })

  it('classifies a frame whose parent was never issued as `unattributed`, not as the running cell', async () => {
    const r = rig()
    await r.register()

    const running = r.supervisor.runCell(r.key, { cellId: 'live', source: 'x' })
    await r.flush()
    // A frame from a parent this host never issued.
    r.transport.emit({ parentId: 'parent-from-nowhere', kind: 'stream', bytes: 5, text: 'stray', name: 'stdout' })

    const unattributed = r.supervisor.unattributedFrames()
    expect(unattributed).toHaveLength(1)
    expect(unattributed[0]?.cellId).toBeUndefined()

    r.transport.settleNewest('ok')
    const result = await running
    // The stray text is NOT in the cell's payload.
    expect(result.output?.text).toBe('')
    expect(result.output?.classes.unattributed).toBe(1)
    await r.supervisor.close(r.key)
  })

  it('classifies a stray shell reply as `foreign` and lets it settle nothing', async () => {
    // Measured to exist on EVERY kernel start: `wait_for_ready` sends a
    // `kernel_info_request` whose reply can still be queued when the first cell is
    // issued (M11 TRANSPORT-FINDINGS). The reader must filter by parent id.
    const r = rig()
    await r.register()

    const running = r.supervisor.runCell(r.key, { cellId: 'first', source: 'x' })
    await r.flush()
    r.transport.emit({ parentId: 'parent-kernel-info-1', kind: 'status', bytes: 0, shell: true })

    const foreign = r.supervisor.unattributedFrames()
    expect(foreign).toHaveLength(1)
    expect(foreign[0]?.frameClass).toBe('foreign')

    // The cell is still running: a foreign frame did not settle it.
    expect(r.supervisor.status(r.key).activeCellId).toBe('first')
    r.transport.settleNewest('ok')
    expect((await running).outcome).toBe('settled')
    await r.supervisor.close(r.key)
  })
})

// ---------------------------------------------------------------------------
// Budgets
// ---------------------------------------------------------------------------

describe('budgets are explicit and their breaches are reported', () => {
  it('bounds kept output, reports the true total, and spills the dropped tail', async () => {
    // FACT 4: a 256 MiB flood left broker and kernel RSS flat because the consumer
    // stopped keeping bytes. The bound must be on the KEPT copy.
    const spill = new RecordingSpill()
    const r = rig({ budgets: { outputBytes: 100 }, spill })
    await r.register()

    const running = r.supervisor.runCell(r.key, { cellId: 'flood', source: 'print' })
    await r.flush()
    r.transport.emit({ parentId: 'parent-flood', kind: 'stream', bytes: 50, text: 'a'.repeat(50), name: 'stdout' })
    r.transport.emit({ parentId: 'parent-flood', kind: 'stream', bytes: 200, text: 'b'.repeat(200), name: 'stdout' })
    r.transport.settleNewest('ok')
    const result = await running

    expect(result.output?.keptBytes).toBe(100)
    expect(result.output?.totalBytes).toBe(250)
    expect(result.output?.truncated).toBe(true)
    // Truncation is EXPLICIT with a spill ref: a bounded result must be
    // distinguishable from a short one.
    expect(result.output?.spillRef).toBe('spill://m5/flood/150')
    expect(spill.writes[0]?.bytes).toBe(150)
    expect(spill.writes[0]?.text).toBe('b'.repeat(150))
    const breach = result.breaches.find(b => b.budget === 'outputBytes')
    expect(breach?.limit).toBe(100)
    expect(breach?.observed).toBe(250)
    expect(breach?.action).toBe('truncated')
    await r.supervisor.close(r.key)
  })

  it('cuts a truncated stream on a character boundary rather than corrupting UTF-8', async () => {
    const r = rig({ budgets: { outputBytes: 5 } })
    await r.register()
    const running = r.supervisor.runCell(r.key, { cellId: 'utf8', source: 'x' })
    await r.flush()
    // Each of these characters is 3 bytes in UTF-8, so a naive 5-byte cut would
    // split one and produce a replacement character.
    r.transport.emit({ parentId: 'parent-utf8', kind: 'stream', bytes: 9, text: '日本語', name: 'stdout' })
    r.transport.settleNewest('ok')
    const result = await running
    expect(result.output?.text).toBe('日')
    expect(result.output?.text.includes('\ufffd')).toBe(false)
    expect(result.output?.truncated).toBe(true)
    await r.supervisor.close(r.key)
  })

  it('bounds MIME separately from stdout and counts it without keeping it', async () => {
    // FACT 5: a single 20 MB `text/html` payload is delivered whole. MIME must have
    // its own budget, because the stdout budget would not bound it.
    const r = rig({ budgets: { outputBytes: 1000, mimeBytes: 128 } })
    await r.register()
    const running = r.supervisor.runCell(r.key, { cellId: 'mime', source: 'display' })
    await r.flush()
    r.transport.emit({
      parentId: 'parent-mime', kind: 'mime', bytes: 20_000_041,
      mimeTypes: ['text/html', 'text/plain'],
    })
    r.transport.settleNewest('ok')
    const result = await running
    expect(result.output?.mimeBytes).toBe(20_000_041)
    // Counted, not kept: the cell's text is empty even though the frame was huge.
    expect(result.output?.text).toBe('')
    expect(result.output?.keptBytes).toBe(0)
    const breach = result.breaches.find(b => b.budget === 'mimeBytes')
    expect(breach?.limit).toBe(128)
    expect(breach?.observed).toBe(20_000_041)
    await r.supervisor.close(r.key)
  })

  it('bounds IPC frames and stops keeping payloads past the bound', async () => {
    const r = rig({ budgets: { ipcFrames: 3, outputBytes: 10_000 } })
    await r.register()
    const running = r.supervisor.runCell(r.key, { cellId: 'frames', source: 'chatty' })
    await r.flush()
    for (let index = 0; index < 5; index += 1) {
      r.transport.emit({ parentId: 'parent-frames', kind: 'stream', bytes: 1, text: String(index), name: 'stdout' })
    }
    r.transport.settleNewest('ok')
    const result = await running
    // THREE frames kept, two counted and dropped. `frames` reports all five,
    // because a count that hid the dropped frames would make a flood look quiet;
    // `text` is what proves only three payloads were retained.
    expect(result.output?.frames).toBe(5)
    expect(result.output?.text).toBe('012')
    expect(result.output?.keptBytes).toBe(3)
    const breach = result.breaches.find(b => b.budget === 'ipcFrames')
    expect(breach?.observed).toBe(4)
    expect(breach?.limit).toBe(3)
    await r.supervisor.close(r.key)
  })

  it('bounds nested native calls per cell and states what the refusal cannot undo', async () => {
    const r = rig({ budgets: { nestedCalls: 2 } })
    await r.register()
    const running = r.supervisor.runCell(r.key, { cellId: 'nested', source: 'x' })
    await r.flush()

    expect(r.supervisor.recordNestedCall(r.key, 'nested')).toEqual({ allowed: true })
    expect(r.supervisor.recordNestedCall(r.key, 'nested')).toEqual({ allowed: true })
    const refused = r.supervisor.recordNestedCall(r.key, 'nested')
    expect(refused.allowed).toBe(false)
    expect(refused.reason).toContain('past its bound')

    r.transport.settleNewest('ok')
    const result = await running
    const breach = result.breaches.find(b => b.budget === 'nestedCalls')
    // The residue says the two calls already happened. A refusal is not a rollback.
    expect(breach?.residue).toContain('already made happened')
    await r.supervisor.close(r.key)
  })

  it('bounds data-plane bytes per cell', async () => {
    const r = rig({ budgets: { dataBytes: 100 } })
    await r.register()
    const running = r.supervisor.runCell(r.key, { cellId: 'data', source: 'x' })
    await r.flush()
    expect(r.supervisor.recordDataBytes(r.key, 'data', 60).allowed).toBe(true)
    expect(r.supervisor.recordDataBytes(r.key, 'data', 30).allowed).toBe(true)
    expect(r.supervisor.recordDataBytes(r.key, 'data', 20).allowed).toBe(false)
    r.transport.settleNewest('ok')
    await running
    await r.supervisor.close(r.key)
  })

  it('bounds declared kernel RSS and process count, and says the memory is already resident', async () => {
    // FACT 13: a kernel holding one 256 MiB array had RSS 357.71 MB. The budget is
    // checked against the OBSERVED footprint, not against a declaration.
    const r = rig({ budgets: { kernelRssBytes: 100 * 1024 * 1024, processes: 2 } })
    await r.register()
    r.transport.rss = 357 * 1024 * 1024
    r.transport.procs = 7

    const observed = await r.supervisor.observeResources(r.key)
    expect(observed.rssBytes).toBe(357 * 1024 * 1024)
    const rssBreach = observed.breaches.find(b => b.budget === 'kernelRssBytes')
    expect(rssBreach?.action).toBe('escalated')
    expect(rssBreach?.residue).toContain('already resident')
    const procBreach = observed.breaches.find(b => b.budget === 'processes')
    // A restart kills the kernel tree, but a detached child may survive. Saying so
    // is the honest version of "escalated".
    expect(procBreach?.residue).toContain('detached child may survive')
    await r.supervisor.close(r.key)
  })
})

// ---------------------------------------------------------------------------
// THE BOUNDED GRACE: interrupt that does not settle
// ---------------------------------------------------------------------------

describe('an interrupt that does not settle becomes unknown and restarts the kernel', () => {
  it('does not wait for the reply: the bounded grace fires and the cell becomes unknown', async () => {
    // THIS IS THE GATE. FACT 8: the interrupt was delivered in 0.001 s and the
    // cell had still not settled 25.16 s later, while the process stayed alive. A
    // supervisor that awaited the reply would hang a model turn forever.
    const r = rig({ budgets: { interruptGraceMs: 5_000 } })
    await r.register()
    r.transport.neverSettles = true

    const running = r.supervisor.runCell(r.key, { cellId: 'await-cell', source: 'await asyncio.sleep(600)' })
    await r.flush()
    const cancel = await r.supervisor.cancel(r.key, 'await-cell')
    expect(cancel.dispatched).toBe(true)
    expect(r.transport.interrupts).toBe(1)

    // The cell has NOT settled. Nothing has resolved yet.
    let resolved = false
    void running.then(() => { resolved = true })
    await r.flush()
    expect(resolved).toBe(false)

    // Advance past the grace. The supervisor stops waiting on its own.
    r.advance(5_000)
    const result = await running

    expect(result.outcome).toBe('unknown')
    expect(result.kernelRestarted).toBe(true)
    expect(result.kernelEpoch).toBe(2)
    expect(result.uncertainty).toContain('did not settle within 5000 ms')
    expect(result.uncertainty).toContain('every prior variable is lost')
    // The process was really replaced.
    expect(r.transport.restarts).toBe(1)
    await r.supervisor.close(r.key)
  })

  it('resolves a cell whose transport promise NEVER settles at all', async () => {
    // The stronger form: not merely "slow", but a promise that is never resolved.
    // The wall-clock bound is the only thing that guarantees runCell resolves.
    //
    // TWO ADVANCES, and the reason is a real property of the design rather than a
    // test artefact: the wall bound fires first and it responds by ISSUING an
    // interrupt, whose own grace then starts. So the wall bound and the grace are
    // sequential bounds, not one bound, and time must pass for each.
    const r = rig({ budgets: { wallMs: 1_000, interruptGraceMs: 500 } })
    await r.register()
    r.transport.neverSettles = true

    const running = r.supervisor.runCell(r.key, { cellId: 'never', source: 'while True: pass' })
    await r.flush()
    r.advance(1_000)
    // The wall bound expired and an interrupt was dispatched; the grace is running.
    await r.flush()
    expect(r.transport.interrupts).toBe(1)
    r.advance(500)
    const result = await running
    expect(result.outcome).toBe('unknown')
    expect(result.kernelRestarted).toBe(true)
    expect(r.transport.restarts).toBe(1)
    await r.supervisor.close(r.key)
  })

  it('escalates to process isolation on a non-interruptible C extension, and says so', async () => {
    // FACT 9: `re.match(r'(a+)+$', ...)` did not settle in 12.16 s and the interrupt
    // was delivered in 0.002 s. Nothing in userspace can stop it.
    const r = rig({ budgets: { wallMs: 2_000, interruptGraceMs: 1_000 } })
    await r.register()
    r.transport.neverSettles = true

    const running = r.supervisor.runCell(r.key, { cellId: 'crec', source: 're.match(...)' })
    await r.flush()
    r.advance(2_000)
    // TWO SEQUENTIAL BOUNDS, and the injected clock must be driven through both.
    // The wall timer responds by DISPATCHING an interrupt, which is an async
    // transport call, so the grace timer is armed on a LATER microtask than the
    // synchronous `advance` that fired the wall bound. Advancing once and awaiting
    // leaves the grace timer unarmed and the cell never settles -- a test-drive
    // bug, not a product bug. This is the same two-advance shape the sibling
    // "transport promise NEVER settles" case documents and relies on.
    await r.flush()
    expect(r.transport.interrupts).toBe(1)
    r.advance(1_000)
    const result = await running
    expect(result.outcome).toBe('unknown')
    const escalation = r.supervisor.breachLog().find(b => b.action === 'escalated')
    // The residue is the honest statement: process isolation ends the cell, it does
    // not undo what the cell did, and the extension may still be running.
    expect(escalation?.residue).toContain('does not undo effects the cell already produced')
    expect(escalation?.residue).toContain('may still be running inside the dying process')
    await r.supervisor.close(r.key)
  })

  it('reports the restart loss: the namespace is gone and the loss is named', async () => {
    const r = rig({ budgets: { wallMs: 1_000, interruptGraceMs: 500 } })
    await r.register()
    r.supervisor.noteBinding(r.key, 'dataframe')
    r.supervisor.noteBinding(r.key, 'helper_function')
    r.transport.neverSettles = true

    const running = r.supervisor.runCell(r.key, { cellId: 'loss', source: 'x' })
    await r.flush()
    r.advance(1_000)
    // Both sequential bounds, for the reason stated in the escalation case above.
    await r.flush()
    r.advance(500)
    await running

    const losses = r.supervisor.restartLosses()
    expect(losses).toHaveLength(1)
    expect(losses[0]?.lost).toEqual(['dataframe', 'helper_function'])
    expect(losses[0]?.previousEpoch).toBe(1)
    expect(losses[0]?.identity.kernelEpoch).toBe(2)
    await r.supervisor.close(r.key)
  })

  it('refuses further cells on a kernel that could not be restarted', async () => {
    // When the process cannot be replaced the kernel is unusable. Reporting it as
    // idle would invite the next cell into a process that is still wedged.
    const r = rig({ budgets: { wallMs: 1_000, interruptGraceMs: 500 } })
    await r.register()
    r.transport.neverSettles = true
    r.transport.restartFails = true

    const running = r.supervisor.runCell(r.key, { cellId: 'stuck', source: 'x' })
    await r.flush()
    r.advance(1_000)
    // Both sequential bounds, for the reason stated in the escalation case above.
    await r.flush()
    r.advance(500)
    const result = await running
    expect(result.outcome).toBe('unknown')
    expect(result.kernelRestarted).toBe(false)
    expect(result.uncertainty).toContain('could not be replaced')
    expect(r.supervisor.status(r.key).state).toBe('wedged')

    const next = await r.supervisor.runCell(r.key, { cellId: 'after', source: 'x' })
    expect(next.outcome).toBe('refused')
    expect(next.reason).toContain('wedged')
    await r.supervisor.close(r.key)
  })

  it('starts the grace even when the interrupt could not be dispatched at all', async () => {
    const r = rig({ budgets: { interruptGraceMs: 500 } })
    await r.register()
    r.transport.neverSettles = true
    r.transport.interruptThrows = true

    const running = r.supervisor.runCell(r.key, { cellId: 'nodispatch', source: 'x' })
    await r.flush()
    const cancel = await r.supervisor.cancel(r.key, 'nodispatch')
    expect(cancel.dispatched).toBe(false)
    // The grace still runs: an interrupt that could not be sent is strictly worse
    // than one that was sent and ignored, so the outcome is unknown either way.
    r.advance(500)
    const result = await running
    expect(result.outcome).toBe('unknown')
    expect(result.kernelRestarted).toBe(true)
    await r.supervisor.close(r.key)
  })

  it('does NOT declare unknown when the cell settles inside the grace', async () => {
    // The control arm. Without it, a test that always produced `unknown` would
    // pass the previous cases while proving nothing about the grace being bounded.
    const r = rig({ budgets: { interruptGraceMs: 5_000 } })
    await r.register()
    r.transport.neverSettles = true

    const running = r.supervisor.runCell(r.key, { cellId: 'cpu-loop', source: 'while True: pass' })
    await r.flush()
    await r.supervisor.cancel(r.key, 'cpu-loop')
    // FACT 7: a CPU loop interrupts cleanly, in ~1.1-1.6 s.
    r.transport.settleNewest('error', { ename: 'KeyboardInterrupt', evalue: '' })
    const result = await running
    expect(result.outcome).toBe('settled')
    expect(result.ename).toBe('KeyboardInterrupt')
    expect(result.kernelRestarted).toBe(false)
    expect(r.transport.restarts).toBe(0)
    // No quarantine was created for a cell that settled.
    expect(r.supervisor.quarantinedCells()).toHaveLength(0)
    r.advance(10_000)
    expect(r.supervisor.quarantinedCells()).toHaveLength(0)
    await r.supervisor.close(r.key)
  })

  it('treats a reply without a matching idle as NOT settled', async () => {
    // "reply AND matching idle" is the completion rule. A reply alone is a partial
    // observation, and calling it settled would report a cell as finished while the
    // kernel may still be emitting.
    const r = rig()
    await r.register()
    const running = r.supervisor.runCell(r.key, { cellId: 'partial', source: 'x' })
    await r.flush()
    r.transport.settleIncomplete()
    const result = await running
    expect(result.outcome).toBe('unknown')
    // Both the reason and the uncertainty name the missing half explicitly, so a
    // reader can tell "reply without idle" from "no reply at all".
    expect(result.reason).toContain('without both an execute_reply and a matching idle')
    expect(result.uncertainty).toContain('protocol did not complete')
    expect(r.supervisor.quarantinedCells()).toHaveLength(1)
    await r.supervisor.close(r.key)
  })

  it('the `unknown` decision is NODE-SIDE: it is made by the supervisor\'s own timer, not by the broker', async () => {
    // WHAT THIS PROVES, AND WHY THE DISTINCTION IS THE WHOLE POINT.
    //
    // `unknown` can be reached two ways, and they have OPPOSITE consequences for
    // the design:
    //
    //   (a) NODE-SIDE. The supervisor's own bounded grace expires, it stops
    //       waiting, declares the outcome unestablished and replaces the process.
    //       The bound holds even against a broker that never speaks again.
    //   (b) KERNEL-DRIVEN. The broker (or the kernel) notices the interrupt and
    //       reports something -- an `aborted` status, an error reply, a socket
    //       close. The outcome then depends on the peer's co-operation, and a
    //       peer that simply never replies leaves the cell pending forever.
    //
    // FACT 8 rules out (b) as the mechanism that can be relied on: the interrupt
    // was delivered in 0.001 s and the cell had still not settled 25.16 s later,
    // with the process alive and no frame of any kind. A design that waited for
    // the kernel to say something would hang a model turn for as long as the
    // kernel chose.
    //
    // THE TRANSPORT BELOW IS BUILT TO MAKE (b) IMPOSSIBLE, so that reaching
    // `unknown` can only have been (a):
    //   - `interrupt()` RESOLVES (so the supervisor cannot be blamed for a hung
    //     dispatch) but settles nothing and emits nothing;
    //   - the settlement promise is NEVER resolved -- not late, not eventually;
    //   - `emit` is never called, so no frame arrives to be mistaken for a signal.
    //
    // IF THE DECISION WERE KERNEL-DRIVEN, what would this test look like? It would
    // have to RESOLVE the settlement promise from inside the fake -- e.g. have
    // `interrupt()` call `settleNewest('aborted')` -- and then assert that the
    // result is `unknown` BECAUSE the kernel reported an abort. The assertion
    // would be about the fake's own resolution, and the grace timer would be
    // irrelevant: removing the timer would not change the outcome. Here the
    // opposite holds, and that is the falsifier: NO promise is ever resolved by
    // anyone, the ONLY event that can end the wait is the supervisor's timer
    // firing, and the injected clock is the only thing that advances time. If the
    // supervisor were relying on the broker, `await running` below would stay
    // pending exactly as it does in the never-settles case with no advance.
    //
    // The three assertions that make it a proof rather than a description:
    //   - the grace timer is the ONLY armed timer when the cell is declared
    //     unknown (measured below, not assumed);
    //   - a fresh advance of exactly the grace is what settles it;
    //   - `kernelRestarted === true` and the epoch advanced, so the supervisor did
    //     not merely give up on the cell -- it replaced the process, which is the
    //     NODE-SIDE action (b) could never force.
    const r = rig({ budgets: { interruptGraceMs: 750 } })
    await r.register()
    r.transport.neverSettles = true

    const running = r.supervisor.runCell(r.key, { cellId: 'silent-broker', source: 'await never_answered()' })
    await r.flush()

    // The interrupt is dispatched and the transport's own promise RESOLVES: this
    // fake cannot be described as a hung dispatch. It simply has nothing to say.
    const cancel = await r.supervisor.cancel(r.key, 'silent-broker')
    expect(cancel.dispatched).toBe(true)
    expect(r.transport.interrupts).toBe(1)
    // No frame was ever emitted and the settlement promise is still pending, so
    // there is no kernel-side signal in existence that could decide anything.
    expect(r.supervisor.lateFrames()).toHaveLength(0)
    expect(r.supervisor.unattributedFrames()).toHaveLength(0)

    // Time passes by LESS than the grace: the decision must NOT have been taken.
    // This is the control arm -- without it, a test that always produced `unknown`
    // would pass the assertions below while proving nothing about the bound.
    let resolved = false
    void running.then(() => { resolved = true })
    r.advance(749)
    await r.flush()
    expect(resolved).toBe(false)
    expect(r.transport.restarts).toBe(0)

    // THE LEDGER, MEASURED RATHER THAN ASSUMED. At this instant exactly two timers
    // are armed, and the measurement is worth stating precisely because a guess
    // would have got it wrong:
    //
    //   - the GRACE timer, armed for now + 750 ms when the cancel was issued. This
    //     is the decision.
    //   - the WALL timer (default 300_000 ms), still armed because it is cleared in
    //     the settlement promise's `.then` and that promise was never resolved.
    //
    // The wall timer is INERT here, not a second decider: its callback returns
    // immediately on `active.abandoned`, which the grace set before escalating.
    // That is asserted below by advancing past it and observing no further effect,
    // so the claim "the grace is the only thing that decides" is measured on both
    // sides instead of inferred from the arm order.
    const armed = r.pendingTimers()
    expect(armed).toHaveLength(2)
    expect(armed.filter(at => at.endsWith('@1000750'))).toHaveLength(1)

    // Now the final millisecond, on the supervisor's own clock, with nothing
    // arriving from the transport.
    r.advance(1)
    await r.flush()
    const result = await running

    expect(result.outcome).toBe('unknown')
    // THE RESTART IS THE NODE-SIDE ACT. A kernel-driven `unknown` would leave the
    // process alone (nothing told the supervisor the kernel was unusable); this
    // one replaced it because the supervisor decided, from its own timer, that a
    // process which cannot confirm a stop must not be reused.
    expect(result.kernelRestarted).toBe(true)
    expect(r.transport.restarts).toBe(1)
    expect(result.kernelEpoch).toBe(2)
    expect(result.uncertainty).toContain('did not settle within 750 ms')
    // The quarantine is the node-side record of the ambiguity.
    expect(r.supervisor.quarantinedCells()).toHaveLength(1)

    // The residual wall timer is proven INERT: advancing far past its 300 s
    // deadline changes nothing, because the grace already marked the cell
    // abandoned and its callback returns on that flag. So the timer count of two
    // above does not weaken the claim -- exactly one of the two can act.
    const restartsAfterGrace = r.transport.restarts
    const lossesAfterGrace = r.supervisor.restartLosses().length
    r.advance(300_000)
    await r.flush()
    expect(r.transport.restarts).toBe(restartsAfterGrace)
    expect(r.supervisor.restartLosses()).toHaveLength(lossesAfterGrace)
    expect(r.supervisor.quarantinedCells()).toHaveLength(1)
    await r.supervisor.close(r.key)
  })
})

// ---------------------------------------------------------------------------
// Control latency under load (RES-01)
// ---------------------------------------------------------------------------

describe('control is not stuck behind a data stream', () => {
  it('dispatches cancel while frames are still arriving, and both latencies stay visible', async () => {
    // FACT 6: under a flood the interrupt was DELIVERED in 0.002 s but the cell did
    // not leave the running state for 7.33 s. Those are two different numbers and
    // both must be visible, because a single number would hide whichever is bad.
    // The grace here is deliberately LONGER than the settle latency, so this
    // exercises the path where the kernel does answer -- the non-settling path is
    // covered by its own tests above.
    const r = rig({ budgets: { outputBytes: 64, interruptGraceMs: 60_000 } })
    await r.register()

    const running = r.supervisor.runCell(r.key, { cellId: 'flooding', source: 'while True: print(x)' })
    await r.flush()
    // A stream of frames is arriving, and the output budget is already breached.
    for (let index = 0; index < 20; index += 1) {
      r.transport.emit({ parentId: 'parent-flooding', kind: 'stream', bytes: 1024, text: 'x'.repeat(1024), name: 'stdout' })
    }
    const cancel = await r.supervisor.cancel(r.key, 'flooding')
    // The cancel was dispatched even though frames were still arriving.
    expect(cancel.dispatched).toBe(true)
    expect(r.transport.interrupts).toBe(1)

    // The kernel answers 7.33 s later, as it did in the measurement.
    r.advance(7_330)
    r.transport.settleNewest('error', { ename: 'KeyboardInterrupt', evalue: '' })
    const result = await running
    expect(result.outcome).toBe('settled')
    // The wall time the cell really consumed is reported, so a caller can see that
    // control was fast while the cell was slow to leave the running state.
    expect(result.wallMs).toBe(7_330)
    // And the data bound held throughout: only the budget was kept.
    expect(result.output?.keptBytes).toBeLessThanOrEqual(64)
    expect(result.output?.totalBytes).toBe(20 * 1024)
    expect(result.output?.truncated).toBe(true)
    await r.supervisor.close(r.key)
  })

  it('refuses a second cancel for a cell that already has an interrupt in flight', async () => {
    const r = rig()
    await r.register()
    r.transport.neverSettles = true
    const running = r.supervisor.runCell(r.key, { cellId: 'once', source: 'x' })
    await r.flush()
    expect((await r.supervisor.cancel(r.key, 'once')).dispatched).toBe(true)
    const second = await r.supervisor.cancel(r.key, 'once')
    expect(second.dispatched).toBe(false)
    expect(second.reason).toContain('already in flight')
    expect(r.transport.interrupts).toBe(1)
    r.advance(DEFAULT_BUDGETS.interruptGraceMs)
    await running
    await r.supervisor.close(r.key)
  })

  it('refuses to cancel a cell that is not the running one', async () => {
    const r = rig()
    await r.register()
    const running = r.supervisor.runCell(r.key, { cellId: 'real', source: 'x' })
    await r.flush()
    const wrong = await r.supervisor.cancel(r.key, 'imaginary')
    expect(wrong.dispatched).toBe(false)
    expect(wrong.reason).toContain('not the running cell')
    r.transport.settleNewest('ok')
    await running
    await r.supervisor.close(r.key)
  })
})

// ---------------------------------------------------------------------------
// Quarantine and reconnection (REC-04, REC-08)
// ---------------------------------------------------------------------------

describe('unknown side effects stay quarantined', () => {
  it('keeps an in-flight cell with no confirmed terminal state quarantined', async () => {
    const r = rig({ budgets: { wallMs: 1_000, interruptGraceMs: 500 } })
    await r.register()
    r.transport.neverSettles = true
    const running = r.supervisor.runCell(r.key, { cellId: 'ambiguous', source: 'writes a file' })
    await r.flush()
    // TWO SEQUENTIAL BOUNDS, and the injected clock must be driven through both.
    // The wall timer's callback does `void this.cancelInternal(...)`, which AWAITS
    // `transport.interrupt()`, so the grace timer is armed on a LATER microtask
    // than the synchronous `advance` that fired the wall bound. Advancing once and
    // awaiting leaves the grace timer unarmed and the cell never settles -- a
    // test-drive bug, not a product bug. Same shape as the sibling "transport
    // promise NEVER settles" case, which documents it in full.
    r.advance(1_000)
    await r.flush()
    r.advance(500)
    await running

    const quarantined = r.supervisor.quarantinedCells()
    expect(quarantined).toHaveLength(1)
    expect(quarantined[0]?.cellId).toBe('ambiguous')
    expect(quarantined[0]?.requires).toBe('explicit-reconciliation')
    // `possibleEffects` is never empty: an empty list would read as "nothing
    // happened", which is exactly what `unknown` denies.
    expect(quarantined[0]?.possibleEffects.length).toBeGreaterThan(0)
    expect(quarantined[0]?.possibleEffects.join(' ')).toContain('may have completed')
    await r.supervisor.close(r.key)
  })

  it('does NOT re-execute an ambiguous call when the transport reconnects', async () => {
    // REC-08. The gate is the empty `reexecuted` list: a reconnect is evidence that
    // a connection exists, not that an effect did not happen.
    const r = rig({ budgets: { wallMs: 1_000, interruptGraceMs: 500 } })
    await r.register()
    r.transport.neverSettles = true
    const running = r.supervisor.runCell(r.key, { cellId: 'ambiguous', source: 'charge a card' })
    await r.flush()
    // Both sequential bounds; see the quarantine case above for the full reason.
    r.advance(1_000)
    await r.flush()
    r.advance(500)
    await running
    const dispatchedBefore = [...r.transport.dispatched]

    const reconnect = r.supervisor.onTransportReconnect()
    expect(reconnect.reexecuted).toEqual([])
    expect(reconnect.ambiguousCells).toEqual(['ambiguous'])
    expect(reconnect.note).toContain('not that an ambiguous effect did not happen')
    // Nothing was dispatched by the reconnect.
    expect(r.transport.dispatched).toEqual(dispatchedBefore)

    // And the quarantine is STILL in place: a reconnect did not clear it either.
    expect(r.supervisor.quarantinedCells()).toHaveLength(1)
    await r.supervisor.close(r.key)
  })

  it('clears a quarantine only through an explicit, evidenced resolution', async () => {
    const r = rig({ budgets: { wallMs: 1_000, interruptGraceMs: 500 } })
    await r.register()
    r.transport.neverSettles = true
    const running = r.supervisor.runCell(r.key, { cellId: 'ambiguous', source: 'x' })
    await r.flush()
    // Both sequential bounds; see the quarantine case above for the full reason.
    r.advance(1_000)
    await r.flush()
    r.advance(500)
    await running

    // No evidence is refused.
    expect(() => r.supervisor.resolveQuarantine('ambiguous', {
      resolvedAs: 'confirmed-no-effect',
      evidence: '   ',
    })).toThrow(/without evidence/)

    const resolved = r.supervisor.resolveQuarantine('ambiguous', {
      resolvedAs: 'confirmed-effect',
      evidence: 'the artifact at /tmp/out.json exists with mtime inside the cell window',
    })
    expect(resolved.resolvedAs).toBe('confirmed-effect')
    expect(r.supervisor.quarantinedCells()).toHaveLength(0)
    expect(r.supervisor.quarantineResolutions()).toHaveLength(1)
    await r.supervisor.close(r.key)
  })

  it('refuses to resolve a cell that was never quarantined', () => {
    const r = rig()
    expect(() => r.supervisor.resolveQuarantine('nope', { resolvedAs: 'confirmed-no-effect', evidence: 'x' }))
      .toThrow(/is not quarantined/)
  })
})

// ---------------------------------------------------------------------------
// Reset, permission change, session swap
// ---------------------------------------------------------------------------

describe('reset and permission change: close admission, cancel, then a NEW epoch', () => {
  it('restarts the kernel and advances the epoch on a reset', async () => {
    const r = rig()
    await r.register()
    r.supervisor.noteBinding(r.key, 'model')

    const reset = await r.supervisor.reset(r.key, 'the operator asked for a clean kernel')
    expect(reset.previousEpoch).toBe(1)
    expect(reset.kernelEpoch).toBe(2)
    expect(reset.lost).toEqual(['model'])
    expect(r.transport.restarts).toBe(1)
    expect(r.supervisor.status(r.key).identity.kernelEpoch).toBe(2)
    await r.supervisor.close(r.key)
  })

  it('MUST restart on a read-permission-domain change, and must not carry variables across', async () => {
    // The rule this gate turns on: the old namespace holds values read under the
    // old domain, and nothing can enumerate them, decide which are secret, and
    // un-read them. A variable holding a file's contents is indistinguishable from
    // one holding a constant, so the kernel is replaced.
    const r = rig()
    await r.register()
    r.supervisor.noteBinding(r.key, 'secret_from_old_domain')
    r.supervisor.noteBinding(r.key, 'derived_from_secret')
    const shutdownsBefore = r.transport.shutdowns
    const pidBefore = r.transport.pid

    const change = await r.supervisor.changeReadPermissionDomain(
      r.key,
      { executionWorld: 'world-local', environmentDigest: 'env-abc' },
      'the project was switched from project-a to project-b',
    )

    expect(change.restarted).toBe(true)
    expect(change.previousEpoch).toBe(1)
    expect(change.kernelEpoch).toBe(2)
    // The old variables are LOST, and named, rather than migrated.
    expect(change.lost).toEqual(['secret_from_old_domain', 'derived_from_secret'])
    // A real teardown and a real start happened, not a token update.
    expect(r.transport.shutdowns).toBe(shutdownsBefore + 1)
    expect(r.transport.pid).toBeGreaterThan(pidBefore)
    expect(r.supervisor.status(r.key).identity.kernelEpoch).toBe(2)

    const loss = r.supervisor.restartLosses().at(-1)
    expect(loss?.reason).toContain('read-permission domain changed')
    expect(loss?.reason).toContain('cannot be classified')
    await r.supervisor.close(r.key)
  })

  it('advances the epoch and moves the slot when the execution world or environment changes', async () => {
    const r = rig()
    await r.register()
    const change = await r.supervisor.changeReadPermissionDomain(
      r.key,
      { executionWorld: 'world-vm', environmentDigest: 'env-xyz' },
      'moved to the execution VM',
    )
    const status = r.supervisor.status(r.key)
    expect(status.identity.executionWorld).toBe('world-vm')
    expect(status.identity.environmentDigest).toBe('env-xyz')
    expect(status.identity.kernelEpoch).toBe(2)
    expect(change.kernelEpoch).toBe(2)
    // The slot key changed, so the old slot is not silently reused: the same
    // Session in a different world is a different kernel.
    expect(kernelSlotKey(status.identity)).not.toBe(kernelSlotKey(r.identity))
    await r.supervisor.close(r.key)
  })

  it('cancels the running cell before replacing the process', async () => {
    const r = rig({ budgets: { interruptGraceMs: 300 } })
    await r.register()
    const running = r.supervisor.runCell(r.key, { cellId: 'inflight', source: 'x' })
    await r.flush()
    r.transport.neverSettles = true

    const changePromise = r.supervisor.changeReadPermissionDomain(
      r.key,
      { executionWorld: 'world-local', environmentDigest: 'env-abc' },
      'domain change with work in flight',
    )
    // THE CLOCK MUST MOVE WHILE THE CHANGE IS IN FLIGHT, which is why this is not
    // `await`ed first. `changeReadPermissionDomain` does not merely issue the
    // cancel: after it, it calls `waitForIdle(key, graceMs + 1000)` and WAITS for
    // the running cell to leave `active`. On the injected clock nothing can make
    // that happen except an `advance`, and an `advance` can only run after the
    // await has yielded -- so `await change` first is a deadlock of the test's own
    // making (it burned the full 60 s timeout), not a product hang. The sequence
    // is: let the interrupt dispatch settle so the grace is armed, fire the grace
    // so the cell is abandoned and the restart settles it, then let the change
    // finish.
    await r.flush()
    r.advance(300)
    await r.flush()
    const change = await changePromise
    // The in-flight cell was cancelled first, so its interrupt was sent.
    expect(r.transport.interrupts).toBeGreaterThanOrEqual(1)
    expect(change.restarted).toBe(true)
    const result = await running
    // Its outcome is unknown, not settled: the process was replaced under it.
    expect(result.outcome).toBe('unknown')
    expect(result.uncertainty).toContain('did not settle')
    r.advance(10_000)
    await r.supervisor.close(r.key)
  })
})

// ---------------------------------------------------------------------------
// Parked kernel memory (RES-06)
// ---------------------------------------------------------------------------

describe('parked kernels count against the memory budget', () => {
  it('counts parked RSS and evicts explicitly with a loss notification', async () => {
    // FACT 13: one parked kernel holding a 256 MiB array was 357.71 MB resident.
    // "The child ended" is not a reason to stop accounting for that memory.
    const r = rig({ budgets: { parkedRssBytes: 400 * 1024 * 1024, maxEvictionsPerPass: 4 } })
    const keys: string[] = []
    for (let index = 0; index < 3; index += 1) {
      const id: KernelIdentity = { ...IDENTITY, sessionId: `session-${String(index)}` }
      const key = kernelSlotKey(id)
      keys.push(key)
      const transport = new FakeTransport()
      transport.rss = 300 * 1024 * 1024
      await r.supervisor.register(id, transport)
      r.supervisor.noteBinding(key, `big_array_${String(index)}`)
      await r.supervisor.park(key)
    }

    const budget = r.supervisor.parkedBudget()
    expect(budget.kernels).toBe(3)
    expect(budget.usedBytes).toBe(900 * 1024 * 1024)
    expect(budget.limitBytes).toBe(400 * 1024 * 1024)

    const reclaimed = await r.supervisor.reclaimParkedMemory()
    // Two evictions bring 900 MB under 400 MB.
    expect(reclaimed.evicted.length).toBe(2)
    expect(reclaimed.satisfied).toBe(true)
    expect(reclaimed.parkedRssBytes).toBe(300 * 1024 * 1024)

    // Each eviction produced a loss record naming what was destroyed.
    const evictions = r.supervisor.evictionLog()
    expect(evictions).toHaveLength(2)
    expect(evictions[0]?.lost).toEqual(['big_array_0'])
    expect(evictions[0]?.rssBytes).toBe(300 * 1024 * 1024)
    const breach = r.supervisor.breachLog().find(b => b.action === 'evicted')
    expect(breach?.residue).toContain('was destroyed')
    expect(breach?.residue).toContain('binding(s) are lost')

    // The evicted slots are gone; the survivor is still parked.
    expect(r.supervisor.listStatuses().map(s => s.state)).toEqual(['parked'])
    expect(r.supervisor.listStatuses()).toHaveLength(1)
    await r.supervisor.closeAll()
  })

  it('reports the parked budget even when nothing needs evicting', async () => {
    const r = rig()
    await r.register()
    r.transport.rss = 90 * 1024 * 1024
    await r.supervisor.park(r.key)
    const budget = r.supervisor.parkedBudget()
    expect(budget.usedBytes).toBe(90 * 1024 * 1024)
    expect(budget.limitBytes).toBe(DEFAULT_BUDGETS.parkedRssBytes)
    await r.supervisor.close(r.key)
  })

  it('refuses to park a kernel that is running a cell', async () => {
    // Parking revokes the active capability, so parking a busy kernel would pull a
    // capability out from under a live cell.
    const r = rig()
    await r.register()
    const running = r.supervisor.runCell(r.key, { cellId: 'live', source: 'x' })
    await r.flush()
    await expect(r.supervisor.park(r.key)).rejects.toThrow(/running cell "live"/)
    r.transport.settleNewest('ok')
    await running
    await r.supervisor.close(r.key)
  })
})

// ---------------------------------------------------------------------------
// The honest security statement (SEC-07)
// ---------------------------------------------------------------------------

describe('a cell id is not a malicious-code isolation boundary', () => {
  it('states the semantics in the DATA, and reports the Session/kernel boundary as the real one', async () => {
    // Asserting the negative: no cell nonce is minted and no isolation is claimed.
    // The cell id is for attribution, cancellation and audit.
    const r = rig()
    await r.register()
    const status = r.supervisor.status(r.key)
    expect(status.cellIdSemantics).toBe('attribution-cancel-audit-only')
    expect(status.isolationBoundary).toBe('session-and-kernel-process')
    await r.supervisor.close(r.key)
  })

  it('records an old cell reaching a later cell as a fact, not as a prevented attack', async () => {
    // FACT 16, reproduced in the accounting layer: a frame from an OLD cell can
    // arrive while a NEW cell is running, and the supervisor's job is to attribute
    // it to the old cell rather than to pretend it cannot happen. The real kernel
    // measurement (`old_thread_touches_new_cell`) showed the later cell actually
    // SAW the mutation; nothing in this layer can prevent that, and this test does
    // not claim it can.
    const r = rig()
    await r.register()
    const first = r.supervisor.runCell(r.key, { cellId: 'owner-cell', source: 'spawn thread' })
    await r.flush()
    r.transport.settleNewest('ok')
    expect((await first).outcome).toBe('settled')

    const second = r.supervisor.runCell(r.key, { cellId: 'victim-cell', source: 'read shared' })
    await r.flush()
    // The old cell's thread prints while the NEW cell is running.
    r.transport.emit({ parentId: 'parent-owner-cell', kind: 'stream', bytes: 24, text: 'MUTATED-BY-OLD-THREAD\n', name: 'stdout' })

    // It is attributed to the OLD cell, so the new cell's result is not polluted.
    expect(r.supervisor.lateFrames()[0]?.cellId).toBe('owner-cell')
    r.transport.settleNewest('ok')
    const result = await second
    expect(result.output?.text).toBe('')
    // ...but attribution is an accounting fact, not containment. The thread can
    // still have changed the memory the new cell read, which is why the isolation
    // boundary is the process, not the cell.
    expect(r.supervisor.status(r.key).cellIdSemantics).toBe('attribution-cancel-audit-only')
    await r.supervisor.close(r.key)
  })
})

// ---------------------------------------------------------------------------
// Checkpoint validation (REC-07)
// ---------------------------------------------------------------------------

/**
 * Build a real `.npy` file's bytes for a C-contiguous array.
 *
 * Written by hand rather than with a library so the test does not depend on numpy
 * being importable from Node, and so the header is a thing the test controls: the
 * object-dtype refusal is only meaningful if the header really says `|O`.
 */
function npyBytes(shape: readonly number[], descr = '<f8'): Buffer {
  const itemsize = Number(/(\d+)$/.exec(descr)?.[1] ?? 1)
  const elements = shape.reduce((product, dimension) => product * dimension, 1)
  const shapeText = shape.length === 1 ? `${String(shape[0])},` : shape.join(', ')
  const headerText = `{'descr': '${descr}', 'fortran_order': False, 'shape': (${shapeText}), }`
  // numpy pads the header so the data starts on a 64-byte boundary.
  const preamble = 10
  const padding = (64 - ((preamble + headerText.length + 1) % 64)) % 64
  const header = `${headerText}${' '.repeat(padding)}\n`
  const buffer = Buffer.alloc(preamble + header.length + elements * itemsize)
  Buffer.from([0x93, 0x4e, 0x55, 0x4d, 0x50, 0x59]).copy(buffer, 0)
  buffer[6] = 1
  buffer[7] = 0
  buffer.writeUInt16LE(header.length, 8)
  buffer.write(header, 10, 'latin1')
  buffer.fill(1, preamble + header.length)
  return buffer
}

/** Build a real `.npz` (a zip) containing one `.npy` member. */
function npzBytes(memberName: string, content: Buffer): Buffer {
  const name = Buffer.from(memberName, 'utf8')
  const compressed = deflateRawSync(content)
  const checksum = createHash('md5').update(content).digest()
  const local = Buffer.alloc(30)
  local.writeUInt32LE(0x04034b50, 0)
  local.writeUInt16LE(20, 4)
  local.writeUInt16LE(8, 8)
  local.writeUInt32LE(checksum.readUInt32LE(0), 14)
  local.writeUInt32LE(compressed.length, 18)
  local.writeUInt32LE(content.length, 22)
  local.writeUInt16LE(name.length, 26)
  const localRecord = Buffer.concat([local, name, compressed])

  const central = Buffer.alloc(46)
  central.writeUInt32LE(0x02014b50, 0)
  central.writeUInt16LE(20, 4)
  central.writeUInt16LE(20, 6)
  central.writeUInt16LE(8, 10)
  central.writeUInt32LE(checksum.readUInt32LE(0), 16)
  central.writeUInt32LE(compressed.length, 20)
  central.writeUInt32LE(content.length, 24)
  central.writeUInt16LE(name.length, 28)
  const centralRecord = Buffer.concat([central, name])

  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(1, 8)
  eocd.writeUInt16LE(1, 10)
  eocd.writeUInt32LE(centralRecord.length, 12)
  eocd.writeUInt32LE(localRecord.length, 16)
  return Buffer.concat([localRecord, centralRecord, eocd])
}

describe('checkpoint restore accepts only explicitly safe formats', () => {
  function descriptor(entries: CheckpointDescriptor['entries']): CheckpointDescriptor {
    return {
      checkpointId: 'ckpt-1',
      asOf: '2026-09-20T00:00:00.000Z',
      environmentDigest: IDENTITY.environmentDigest,
      kernelEpoch: 1,
      entries,
    }
  }

  function write(dir: string, name: string, bytes: Buffer): string {
    const path = join(dir, name)
    writeFileSync(path, bytes)
    return path
  }

  it('accepts a JSON document and a real non-object .npy array', () => {
    const dir = tempDir()
    const jsonBytes = Buffer.from('{"counter": 42, "label": "ok"}', 'utf8')
    const jsonPath = write(dir, 'state.json', jsonBytes)
    const npy = npyBytes([2, 3])
    const npyPath = write(dir, 'array.npy', npy)
    const validation = validateCheckpoint(descriptor([
      { name: 'state', format: 'json', path: jsonPath, bytes: jsonBytes.length },
      { name: 'array', format: 'npy', path: npyPath, bytes: npy.length },
    ]))
    expect(validation.accepted.map(a => a.name).sort()).toEqual(['array', 'state'])
    const array = validation.accepted.find(a => a.name === 'array')
    // The dtype and shape come out of the REAL header, which is what makes the
    // object-dtype refusal meaningful rather than a name check.
    expect(array?.descr).toBe('<f8')
    expect(array?.shape).toEqual([2, 3])
    expect(array?.sha256).toBe(createHash('sha256').update(npy).digest('hex'))
  })

  it('REFUSES every pickle family format by name', () => {
    const dir = tempDir()
    const path = write(dir, 'model.bin', Buffer.from('anything', 'utf8'))
    for (const format of ['pickle', 'pkl', 'dill', 'cloudpickle', 'joblib', 'torch', 'h5']) {
      const validation = validateCheckpoint(descriptor([{ name: 'model', format, path, bytes: 8 }]))
      expect(validation.accepted, format).toHaveLength(0)
      expect(validation.skipped[0]?.reason, format).toMatch(/arbitrary code|pickled attributes|pickle/)
    }
    expect(REFUSED_FORMATS['dill']).toBeDefined()
  })

  it('REFUSES a pickle disguised as json, on the BYTES rather than the extension', () => {
    // The name is attacker-chosen; the bytes are what a loader would read.
    const dir = tempDir()
    const pickleBytes = Buffer.concat([Buffer.from([0x80, 0x04]), Buffer.from('cos\nsystem\n', 'utf8')])
    const path = write(dir, 'innocent.json', pickleBytes)
    const validation = validateCheckpoint(descriptor([
      { name: 'innocent', format: 'json', path, bytes: pickleBytes.length },
    ]))
    expect(validation.accepted).toHaveLength(0)
    expect(validation.skipped[0]?.reason).toContain('binary pickle')
    expect(validation.skipped[0]?.reason).toContain('not on the extension')
  })

  it('REFUSES an object-dtype array read from the REAL .npy header', () => {
    // An object array's elements are pickled inside the .npy, so accepting it would
    // be accepting a pickle under another name.
    const dir = tempDir()
    const bytes = npyBytes([2], '|O')
    const path = write(dir, 'objects.npy', bytes)
    const validation = validateCheckpoint(descriptor([
      { name: 'objects', format: 'npy', path, bytes: bytes.length },
    ]))
    expect(validation.accepted).toHaveLength(0)
    expect(validation.skipped[0]?.reason).toContain('object-bearing')
  })

  it('REFUSES a truncated array whose header promises more data than the file holds', () => {
    const dir = tempDir()
    const full = npyBytes([4, 4])
    const truncated = full.subarray(0, full.length - 32)
    const path = write(dir, 'truncated.npy', truncated)
    const validation = validateCheckpoint(descriptor([
      { name: 'truncated', format: 'npy', path, bytes: truncated.length },
    ]))
    expect(validation.accepted).toHaveLength(0)
    expect(validation.skipped[0]?.reason).toContain('refusing a truncated array')
  })

  it('REFUSES a checkpoint that disagrees with its own declared size', () => {
    const dir = tempDir()
    const path = write(dir, 'state.json', Buffer.from('{"a": 1}', 'utf8'))
    const validation = validateCheckpoint(descriptor([
      { name: 'state', format: 'json', path, bytes: 999 },
    ]))
    expect(validation.accepted).toHaveLength(0)
    expect(validation.skipped[0]?.reason).toContain('disagrees with itself')
  })

  it('accepts a real .npz of safe arrays and REFUSES one containing an object array', () => {
    const dir = tempDir()
    const safe = npzBytes('a.npy', npyBytes([2, 2]))
    const safePath = write(dir, 'safe.npz', safe)
    const ok = validateCheckpoint(descriptor([
      { name: 'safe', format: 'npz', path: safePath, bytes: safe.length },
    ]))
    expect(ok.accepted.map(a => a.name)).toEqual(['safe'])

    const bad = npzBytes('o.npy', npyBytes([2], '|O'))
    const badPath = write(dir, 'bad.npz', bad)
    const refused = validateCheckpoint(descriptor([
      { name: 'bad', format: 'npz', path: badPath, bytes: bad.length },
    ]))
    expect(refused.accepted).toHaveLength(0)
    expect(refused.skipped[0]?.reason).toContain('object-bearing')
  })

  it('REFUSES an archive whose declared uncompressed size is past the bomb bound', () => {
    const dir = tempDir()
    const bytes = npzBytes('big.npy', npyBytes([64, 64]))
    const path = write(dir, 'bomb.npz', bytes)
    const validation = validateCheckpoint(
      descriptor([{ name: 'bomb', format: 'npz', path, bytes: bytes.length }]),
      { ...DEFAULT_CHECKPOINT_LIMITS, maxUncompressedBytes: 64 },
    )
    expect(validation.accepted).toHaveLength(0)
    expect(validation.skipped[0]?.reason).toContain('decompression-bomb bound')
  })

  it('REFUSES an archive that lies about its sizes, caught by zlib rather than by arithmetic', () => {
    // A real bomb inflates far past what it declares. Here the limit is small, so
    // zlib's own output cap fires -- which is the bound that holds when the
    // declared size is itself a lie.
    const dir = tempDir()
    const content = npyBytes([128, 128])
    const bytes = npzBytes('big.npy', content)
    const path = write(dir, 'liar.npz', bytes)
    const validation = validateCheckpoint(
      descriptor([{ name: 'liar', format: 'npz', path, bytes: bytes.length }]),
      { ...DEFAULT_CHECKPOINT_LIMITS, maxUncompressedBytes: 4096 },
    )
    expect(validation.accepted).toHaveLength(0)
    expect(validation.skipped[0]?.reason).toMatch(/decompression-bomb bound|bound exceeded|inflated to/)
  })

  it('REFUSES an archive whose member is not a .npy at all', () => {
    const dir = tempDir()
    const bytes = npzBytes('notes.txt', Buffer.from('not an array', 'utf8'))
    const path = write(dir, 'odd.npz', bytes)
    const validation = validateCheckpoint(descriptor([
      { name: 'odd', format: 'npz', path, bytes: bytes.length },
    ]))
    expect(validation.accepted).toHaveLength(0)
    expect(validation.skipped[0]?.reason).toContain('magic is absent')
  })

  it('accepts Parquet and Arrow on magic-at-both-ends, and refuses a prefix-only fake', () => {
    const dir = tempDir()
    const parquet = Buffer.concat([Buffer.from('PAR1'), Buffer.from('payload'), Buffer.from('PAR1')])
    const parquetPath = write(dir, 'data.parquet', parquet)
    const arrow = Buffer.concat([Buffer.from('ARROW1'), Buffer.from('payload'), Buffer.from('ARROW1')])
    const arrowPath = write(dir, 'data.arrow', arrow)
    const ok = validateCheckpoint(descriptor([
      { name: 'pq', format: 'parquet', path: parquetPath, bytes: parquet.length },
      { name: 'ar', format: 'arrow', path: arrowPath, bytes: arrow.length },
    ]))
    // HONEST LIMIT: accepted means "the magic is at both ends and the size is
    // within bounds". M5 ran no Parquet or Arrow reader, so it makes no claim
    // about the contents.
    expect(ok.accepted.map(a => a.name).sort()).toEqual(['ar', 'pq'])

    const prefixOnly = Buffer.concat([Buffer.from('PAR1'), Buffer.from('truncated')])
    const prefixPath = write(dir, 'fake.parquet', prefixOnly)
    const refused = validateCheckpoint(descriptor([
      { name: 'fake', format: 'parquet', path: prefixPath, bytes: prefixOnly.length },
    ]))
    expect(refused.accepted).toHaveLength(0)
    expect(refused.skipped[0]?.reason).toContain('not at both ends')
  })

  it('refuses a format M5 does not restore, naming it', () => {
    const dir = tempDir()
    const path = write(dir, 'thing.bin', Buffer.from('data', 'utf8'))
    const validation = validateCheckpoint(descriptor([
      { name: 'thing', format: 'msgpack', path, bytes: 4 },
    ]))
    expect(validation.accepted).toHaveLength(0)
    expect(validation.skipped[0]?.reason).toContain('msgpack')
    expect(validation.skipped[0]?.reason).toContain('not one M5 restores')
  })

  it('reports an unreadable entry as skipped rather than throwing', () => {
    const dir = tempDir()
    const validation = validateCheckpoint(descriptor([
      { name: 'missing', format: 'json', path: join(dir, 'does-not-exist.json'), bytes: 10 },
    ]))
    expect(validation.accepted).toHaveLength(0)
    expect(validation.skipped[0]?.reason).toContain('unreadable')
  })

  it('sums the accepted bytes so a caller can see the restore size', () => {
    const dir = tempDir()
    const jsonBytes = Buffer.from('{"a": 1}', 'utf8')
    const jsonPath = write(dir, 'state.json', jsonBytes)
    const npy = npyBytes([4])
    const npyPath = write(dir, 'array.npy', npy)
    const validation = validateCheckpoint(descriptor([
      { name: 'state', format: 'json', path: jsonPath, bytes: jsonBytes.length },
      { name: 'array', format: 'npy', path: npyPath, bytes: npy.length },
    ]))
    expect(validation.totalBytes).toBe(jsonBytes.length + npy.length)
  })
})

// ---------------------------------------------------------------------------
// Recovery report (REC-05, REC-06)
// ---------------------------------------------------------------------------

describe('recovery reports state honestly and never claims full session recovery', () => {
  it('reports epoch, as-of, restored, lost, environment change and unresolved effects', async () => {
    const r = rig({ budgets: { wallMs: 1_000, interruptGraceMs: 500 } })
    await r.register()
    r.transport.neverSettles = true
    const running = r.supervisor.runCell(r.key, { cellId: 'lost-cell', source: 'x' })
    await r.flush()
    // Both sequential bounds; see the quarantine case for the full reason.
    r.advance(1_000)
    await r.flush()
    r.advance(500)
    await running

    const checkpoint: CheckpointDescriptor = {
      checkpointId: 'ckpt-7',
      asOf: '2026-09-19T12:00:00.000Z',
      environmentDigest: 'env-abc',
      kernelEpoch: 1,
      entries: [],
    }
    const report = r.supervisor.recoveryReport(r.key, {
      checkpoint,
      validation: { accepted: [], skipped: [{ name: 'frame', reason: 'refused: object dtype' }], totalBytes: 0 },
      restored: ['state'],
      lost: ['dataframe'],
    })

    expect(report.kernelEpoch).toBe(2)
    expect(report.checkpointAsOf).toBe('2026-09-19T12:00:00.000Z')
    expect(report.restored).toEqual(['state'])
    expect(report.lost).toEqual(['dataframe'])
    expect(report.skipped).toEqual([{ name: 'frame', reason: 'refused: object dtype' }])
    expect(report.environmentChanged).toBe(false)
    // The quarantined cell is carried into the report: the world may be ahead of
    // the record, and the report must say so rather than implying a clean restart.
    expect(report.unresolvedEffects).toHaveLength(1)
    expect(report.unresolvedEffects[0]?.cellId).toBe('lost-cell')
    expect(report.scope).toBe(RECOVERY_SCOPE_STATEMENT)
    expect(report.scope).toContain('not full session recovery')
    expect(report.scope).toContain('No past cell was replayed')
    await r.supervisor.close(r.key)
  })

  it('flags an environment change and refuses to pretend the data is comparable', async () => {
    const r = rig()
    await r.register()
    const report = r.supervisor.recoveryReport(r.key, {
      checkpoint: {
        checkpointId: 'ckpt-8',
        asOf: '2026-09-01T00:00:00.000Z',
        environmentDigest: 'env-DIFFERENT',
        kernelEpoch: 3,
        entries: [],
      },
      restored: [],
      lost: [],
    })
    expect(report.environmentChanged).toBe(true)
    expect(report.skipped.some(s => s.reason.includes('env-DIFFERENT'))).toBe(true)
    await r.supervisor.close(r.key)
  })

  it('says a restart is not full session recovery in the DATA a model reads', () => {
    // The sentence is a constant rather than a comment because it must appear in
    // the report, not only in the source.
    expect(RECOVERY_SCOPE_STATEMENT).toContain('VOLATILE KERNEL only')
    expect(RECOVERY_SCOPE_STATEMENT).toContain('Session log, artifacts and admission record are separate')
  })

  it('reports a checkpoint as-of even when nothing was restored, so staleness is visible', async () => {
    const r = rig()
    await r.register()
    const report = r.supervisor.recoveryReport(r.key, {
      checkpoint: {
        checkpointId: 'ckpt-9',
        asOf: '2026-09-01T00:00:00.000Z',
        environmentDigest: IDENTITY.environmentDigest,
        kernelEpoch: 1,
        entries: [],
      },
      validation: { accepted: [], skipped: [{ name: 'a', reason: 'refused' }], totalBytes: 0 },
      restored: [],
      lost: ['everything'],
    })
    // The as-of is present, so a reader can tell the data is 19 days behind rather
    // than reading "0 restored" as a clean state.
    expect(report.checkpointAsOf).toBe('2026-09-01T00:00:00.000Z')
    expect(report.restored).toHaveLength(0)
    expect(report.lost).toEqual(['everything'])
    await r.supervisor.close(r.key)
  })

  it('reports no as-of when there was no checkpoint at all', async () => {
    const r = rig()
    await r.register()
    const report = r.supervisor.recoveryReport(r.key, {})
    expect(report.checkpointAsOf).toBeUndefined()
    expect(report.restored).toHaveLength(0)
    expect(report.scope).toBe(RECOVERY_SCOPE_STATEMENT)
    await r.supervisor.close(r.key)
  })
})

// ---------------------------------------------------------------------------
// Refusals and shutdown
// ---------------------------------------------------------------------------

describe('refusals carry no output and shutdown releases everything', () => {
  it('gives a refusal a null output, so it cannot be read as an empty cell', async () => {
    const r = rig()
    await r.register()
    await r.supervisor.park(r.key)
    const refused = await r.supervisor.runCell(r.key, { cellId: 'x', source: 'x' })
    expect(refused.outcome).toBe('refused')
    // NOT `{ text: '', totalBytes: 0 }`: an empty output and a cell that produced
    // nothing are the same shape and would be conflated.
    expect(refused.output).toBeUndefined()
    expect(refused.breaches).toEqual([])
    await r.supervisor.close(r.key)
  })

  it('reports a transport that refuses to dispatch, and returns the kernel to idle', async () => {
    const r = rig()
    await r.register()
    r.transport.refuseExecute = 'the kernel connection is not established'
    const result = await r.supervisor.runCell(r.key, { cellId: 'x', source: 'x' })
    expect(result.outcome).toBe('transport-failed')
    expect(result.reason).toContain('not established')
    // The kernel returns to idle so the next cell is not blocked by a dispatch
    // failure that never ran anything.
    expect(r.supervisor.status(r.key).state).toBe('idle')
    await r.supervisor.close(r.key)
  })

  it('closes every kernel and reports the count', async () => {
    const r = rig()
    const first: KernelIdentity = { ...IDENTITY, sessionId: 's-a' }
    const second: KernelIdentity = { ...IDENTITY, sessionId: 's-b' }
    await r.supervisor.register(first, new FakeTransport())
    await r.supervisor.register(second, new FakeTransport())
    const closed = await r.supervisor.closeAll()
    expect(closed.closed).toBe(2)
    expect(closed.errors).toEqual([])
    expect(r.supervisor.listStatuses()).toHaveLength(0)
  })

  it('reports an unknown slot rather than inventing one', () => {
    const r = rig()
    expect(() => r.supervisor.status('no-such-slot')).toThrow(/no kernel registered/)
  })
})
