/**
 * P3 / P0.4 — `CellLease`: the durable-STARTED failure, and the `pending` count.
 *
 * TWO DEFECTS, AND WHY THIS FILE EXISTS AS A FAULT INJECTION RATHER THAN A
 * HAPPY PATH. Both were found by reading the code, and both are the shape this
 * project keeps recording: a mechanism that looks right while a reader cannot
 * tell what actually happened.
 *
 * DEFECT 1 (V5 §6.2). `invoke` published the accepted call into `byRequestId`,
 * the FIFO `queue` and `inFlight` BEFORE `await this.ledger.started(...)`. A
 * rejected STARTED write therefore left the lease holding a call it had told
 * the caller had failed: a duplicate `requestId` joined a promise nothing would
 * ever settle, and `close()` had to cope with a call that was never legitimately
 * published. V5 offers two safe shapes; this tree implements OPTION A (a
 * provisional accepting map, then publish only after the write resolves), and
 * the reasoning for A over B is recorded in `CellLease.accepting` and in the
 * commit message. The arms below are the ones V5 §6.2 names:
 *
 *   - inject a `ledger.started` throw
 *   - no `ctx.tools.execute`
 *   - no queued/inFlight ghost
 *   - a duplicate with the same `requestId` gets a documented structured result
 *   - `close()` reaches CLOSED promptly
 *
 * and the arm V5 says decides whether A is actually safe: WHAT A DUPLICATE DOES
 * WHILE THE LEDGER WRITE IS IN FLIGHT. That one is driven with a gated ledger
 * whose `started` is held open, because a race that only exists while a write is
 * pending cannot be observed by injecting a synchronous throw.
 *
 * DEFECT 2 (V5 §6.3). `pending` was `this.inFlight.size + this.queue.length`
 * while a queued call is ALREADY in `inFlight`, so every queued call was counted
 * twice. The arms below assert the count against a state where the two readings
 * differ (one running + one queued = 2 logical calls: the old expression said 3),
 * which is what makes the assertion a measurement rather than a tautology.
 *
 * WHAT IS REAL HERE, AND WHAT IS NOT. The registry is the real `ToolRuntime`,
 * mounted the way `bridge-seam.test.ts` mounts it, and the dispatch counter is a
 * `tools/pre-execute` listener -- the registry's own pre-dispatch stage -- plus
 * the tool body's own entry count, so "nothing was dispatched" is observed at
 * the layer the claim names rather than inferred from the bridge's own state.
 * The lease is minted by a real `BridgeServer` and the handler is the
 * production `createNativeCallHandler`. The LEDGER IS A STUB: `started` is
 * monkey-patched on a `MemoryBridgeLedger` to fail or to block on demand. That
 * is a real fault injected into the real call path, but it is NOT a real storage
 * backend failing -- see CLAIMS in the report.
 */
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BridgeServer, LeaseRejection } from './bridge.ts'
import { createNativeCallHandler, type EnclosingAuthority } from './native-call.ts'
import { MemoryBridgeLedger } from './bridge-ledger.ts'

let ctx: Context
let root: string
let bridge: BridgeServer | undefined

beforeEach(async () => {
  ctx = new Context()
  await ctx.plugin(SystemPrompt, { personaPrefix: '' })
  await ctx.plugin(ToolRuntime, { mode: 'native', maxParallelSubCalls: 10 })
  root = await mkdtemp(join(tmpdir(), 'dsh-ipython-p3-lease-'))
})

afterEach(async () => {
  if (bridge !== undefined) {
    await bridge.close().catch(() => undefined)
    bridge = undefined
  }
  await ctx.fiber.dispose()
  await rm(root, { recursive: true, force: true })
})

/** The Agent stand-in the registry reads to key scope layers. No model loop. */
function agentFor(sessionId: string): Agent {
  return { session: { header: { id: sessionId, cwd: root } } } as unknown as Agent
}

/** The authority `createNativeCallHandler` needs, as the enclosing call mints it. */
function authorityFor(callId: string, agent: Agent): EnclosingAuthority {
  return {
    callId,
    rootCallId: callId,
    // Only the registry can mint a real token; this file asserts nothing about
    // its contents, and `parent` is exercised by `bridge-seam.test.ts`.
    token: Symbol('p3-token') as unknown as EnclosingAuthority['token'],
    agent,
    signal: new AbortController().signal,
  }
}

/**
 * A deferred, so a test can hold a write open and decide how it ends.
 *
 * The reject arm exists because the fault V5 names is a THROW; the resolve arm
 * exists because the race that decides Option A's safety only happens while the
 * write is genuinely pending.
 */
function deferred(): { promise: Promise<void>, resolve: () => void, reject: (error: unknown) => void } {
  let resolve!: () => void
  let reject!: (error: unknown) => void
  const promise = new Promise<void>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

/**
 * The registry-side instrument: every call the REAL pipeline saw before dispatch.
 *
 * `tools/pre-execute` is the registry's own pre-dispatch stage, so a count of 0
 * here is the claim "no `ctx.tools.execute` reached a tool" measured where it
 * matters -- not a restatement of the bridge's internal bookkeeping.
 */
function instrument(): { dispatched: string[], bodies: string[] } {
  const dispatched: string[] = []
  const bodies: string[] = []
  ctx.on('tools/pre-execute', (exec, next) => {
    dispatched.push(exec.name)
    return next()
  })
  ctx.tools.register(defineTool({
    name: 'p3_probe',
    description: 'Records that its body ran, so a ghost dispatch cannot hide.',
    parameters: { tag: { type: 'string', required: true, description: 'echoed back' } },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { tag: { type: 'string', required: true } },
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    execute: async args => {
      const tag = (args as { tag: string }).tag
      bodies.push(tag)
      return { tag }
    },
  }))
  return { dispatched, bodies }
}

/**
 * The real lease over the real registry, with a ledger this file controls.
 *
 * The ledger is a `MemoryBridgeLedger` whose `started` is replaced, which is the
 * same fault-injection style `r5-product-bridge.test.ts` uses for `disposed` and
 * `settled` -- the call path is the production one and only the storage answer
 * is synthetic.
 */
function leaseWith(ledger: MemoryBridgeLedger, authority: EnclosingAuthority, outerCallId: string) {
  const b = new BridgeServer({ artifactDirectory: join(root, 'artifacts') })
  bridge = b
  return b.mintLease({
    sessionId: 'p3-lease',
    cellId: 'cell-1',
    epoch: 1,
    outerCallId,
    rootCallId: outerCallId,
    ledger,
    handler: createNativeCallHandler({ ctx, authority, bridge: b }),
  })
}

/** The refusal a promise produced, or a marker that it RESOLVED instead. */
async function refusalOf(promise: Promise<unknown>): Promise<{ code: string | undefined, message: string } | { code: 'RESOLVED' }> {
  return await promise.then(
    () => ({ code: 'RESOLVED' as const }),
    (error: unknown) => ({
      code: error instanceof LeaseRejection ? error.code : undefined,
      message: error instanceof Error ? error.message : String(error),
    }),
  )
}

/** Race a promise against a deadline, so "promptly" is a measurement. */
async function withDeadline<T>(promise: Promise<T>, ms: number): Promise<T | 'TIMED_OUT'> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<'TIMED_OUT'>(resolve => { timer = setTimeout(() => { resolve('TIMED_OUT') }, ms) }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

const REQUEST = { requestId: 'req-1', tool: 'p3_probe', arguments: { tag: 'from-the-cell' }, cellId: 'cell-1', epoch: 1 }

// ---------------------------------------------------------------------------
// BRI-STARTED-ROLLBACK
// ---------------------------------------------------------------------------

describe('BRI-STARTED-ROLLBACK: a durable STARTED failure leaves no ghost', () => {
  it('the call is refused as LEASE_LEDGER_UNAVAILABLE, nothing is dispatched, and close() reaches CLOSED promptly', async () => {
    // THE FAULT V5 §6.2 NAMES: the STARTED write rejects.
    const ledger = new MemoryBridgeLedger()
    let startAttempts = 0
    ledger.started = async () => {
      startAttempts += 1
      throw new Error('injected storage failure: the STARTED row could not be written')
    }
    const { dispatched, bodies } = instrument()
    const lease = leaseWith(ledger, authorityFor('outer-fault', agentFor('p3-fault')), 'outer-fault')

    const refusal = await refusalOf(lease.invoke({ ...REQUEST, leaseId: lease.id }))

    // 1. A DOCUMENTED, STRUCTURED REFUSAL -- not a generic BRIDGE_FAILED and not
    // a raw storage error, so a program can tell "retryable, nothing happened"
    // from "your authority is gone".
    expect(refusal.code).toBe('LEASE_LEDGER_UNAVAILABLE')
    expect('message' in refusal && refusal.message).toMatch(/was NOT accepted and NOT dispatched/u)
    expect(startAttempts).toBe(1)

    // 2. NO ctx.tools.execute, measured at the registry's own pre-dispatch stage
    // AND at the tool body. Both, because either alone could be satisfied by a
    // dispatch that stopped early.
    expect(dispatched).toHaveLength(0)
    expect(bodies).toHaveLength(0)

    // 3. NO GHOST. `pending` is the lease's own count of accepted unsettled
    // calls, and the two collections behind it are asserted through it and
    // through the disposition log and the ledger, so a ghost cannot hide in one
    // structure while another looks clean.
    expect(lease.pending).toBe(0)
    expect(lease.dispositions()).toHaveLength(0)
    expect(ledger.all()).toHaveLength(0)
    expect(ledger.unknownOutcomes()).toHaveLength(0)

    // 4. close() REACHES CLOSED PROMPTLY. Under the old shape this is where a
    // call that was never legitimately published had to be coped with.
    const closed = await withDeadline(lease.close('completed', 'the cell settled').then(
      () => 'CLOSED' as const,
      (error: unknown) => `THREW: ${String(error)}` as const,
    ), 5000)
    expect(closed).toBe('CLOSED')
    expect(lease.lifecycle).toBe('CLOSED')
  }, 30_000)

  it('the same fixture with a healthy ledger dispatches once and settles (the control that makes the arm above a signal)', async () => {
    // A FAULT ARM THAT CAN ONLY FAIL IS NOT A MEASUREMENT. This is the identical
    // fixture with the injection removed: the call must dispatch exactly once,
    // settle, and record both its intent and its disposition.
    const ledger = new MemoryBridgeLedger()
    const { dispatched, bodies } = instrument()
    const lease = leaseWith(ledger, authorityFor('outer-healthy', agentFor('p3-healthy')), 'outer-healthy')

    const outcome = await lease.invoke({ ...REQUEST, leaseId: lease.id })
    expect(outcome.ok).toBe(true)
    expect(dispatched).toEqual(['p3_probe'])
    expect(bodies).toEqual(['from-the-cell'])
    expect(lease.pending).toBe(0)

    await lease.close('completed', 'the cell settled')
    const row = ledger.get('outer-healthy:ipython:1')
    expect(row?.startedAt).toBeTruthy()
    expect(row?.settledAt).toBeTruthy()
    expect(row?.disposition).toBe('settled')
    expect(lease.unrecordedDispositions).toHaveLength(0)
  }, 30_000)

  it('a duplicate arriving WHILE the write is in flight joins it: one write, one dispatch, one shared answer', async () => {
    // THE ARM V5 SAYS DECIDES WHETHER OPTION A IS SAFE. A duplicate frame can
    // arrive while the first frame's STARTED write is unresolved. Under A it must
    // find the provisional entry and JOIN it -- not start a second write, and not
    // miss the entry and dispatch twice.
    const ledger = new MemoryBridgeLedger()
    const gate = deferred()
    const startAttempts: string[] = []
    const realStarted = ledger.started.bind(ledger)
    ledger.started = async record => {
      startAttempts.push(record.subCallId)
      await gate.promise
      return await realStarted(record)
    }
    const { dispatched, bodies } = instrument()
    const lease = leaseWith(ledger, authorityFor('outer-join', agentFor('p3-join')), 'outer-join')

    const first = lease.invoke({ ...REQUEST, leaseId: lease.id })
    // The duplicate is submitted while the write is genuinely pending. It must
    // not be counted as accepted yet, because under A acceptance IS the durable
    // write -- stated here as the documented consequence of choosing A.
    const duplicate = lease.invoke({ ...REQUEST, leaseId: lease.id })
    expect(lease.pending).toBe(0)
    expect(startAttempts).toHaveLength(1)
    expect(dispatched).toHaveLength(0)

    gate.resolve()
    const [a, b] = await Promise.all([first, duplicate])

    // ONE write, ONE dispatch, and ONE answer seen twice.
    expect(startAttempts).toHaveLength(1)
    expect(dispatched).toEqual(['p3_probe'])
    expect(bodies).toEqual(['from-the-cell'])
    expect(a).toEqual(b)
    expect(a.ok).toBe(true)
    // ONE ledger row for the one logical call, and it is the FIRST subcall id.
    expect(ledger.all()).toHaveLength(1)
    expect(ledger.get('outer-join:ipython:1')?.disposition).toBe('settled')
    await lease.close('completed', 'the cell settled')
  }, 30_000)

  it('the same duplicate during a FAILING write gets the SAME structured refusal, and neither caller hangs', async () => {
    // The other half of the in-flight duplicate: the write it joined FAILS. Both
    // callers await one promise, so both must see one classified refusal. A
    // rethrow of the ledger's own error would reach the duplicate as an
    // unstructured failure while the first caller saw a classified one.
    const ledger = new MemoryBridgeLedger()
    const gate = deferred()
    let startAttempts = 0
    ledger.started = async () => {
      startAttempts += 1
      await gate.promise
      throw new Error('injected storage failure: the STARTED row could not be written')
    }
    const { dispatched, bodies } = instrument()
    const lease = leaseWith(ledger, authorityFor('outer-both', agentFor('p3-both')), 'outer-both')

    const first = lease.invoke({ ...REQUEST, leaseId: lease.id })
    const duplicate = lease.invoke({ ...REQUEST, leaseId: lease.id })
    gate.reject(new Error('injected storage failure: the STARTED row could not be written'))

    const raced = await withDeadline(
      Promise.all([refusalOf(first), refusalOf(duplicate)]),
      5000,
    )
    expect(raced).not.toBe('TIMED_OUT')
    if (raced === 'TIMED_OUT') throw new Error('unreachable')
    expect(raced[0].code).toBe('LEASE_LEDGER_UNAVAILABLE')
    expect(raced[1].code).toBe('LEASE_LEDGER_UNAVAILABLE')
    expect(startAttempts).toBe(1)
    expect(dispatched).toHaveLength(0)
    expect(bodies).toHaveLength(0)
    expect(lease.pending).toBe(0)
    expect(ledger.all()).toHaveLength(0)
    await lease.close('completed', 'the cell settled')
  }, 30_000)

  it('a CONFLICTING requestId during the in-flight write is refused as REQUEST_ID_CONFLICT', async () => {
    // The conflict rule must hold on the provisional entry too, or a colliding
    // frame would be judged differently depending on whether the first frame's
    // write happened to commit.
    const ledger = new MemoryBridgeLedger()
    const gate = deferred()
    const realStarted = ledger.started.bind(ledger)
    ledger.started = async record => { await gate.promise; return await realStarted(record) }
    const { dispatched } = instrument()
    const lease = leaseWith(ledger, authorityFor('outer-conflict', agentFor('p3-conflict')), 'outer-conflict')

    const first = lease.invoke({ ...REQUEST, leaseId: lease.id })
    const conflict = await refusalOf(lease.invoke({
      ...REQUEST,
      // Same request id, DIFFERENT arguments: the identity is already taken.
      arguments: { tag: 'different' },
      leaseId: lease.id,
    }))
    expect(conflict.code).toBe('REQUEST_ID_CONFLICT')
    expect('message' in conflict && conflict.message).toMatch(/first used for "p3_probe"/u)

    gate.resolve()
    const settled = await first
    expect(settled.ok).toBe(true)
    // The conflicting frame did NOT dispatch: still exactly one.
    expect(dispatched).toEqual(['p3_probe'])
    await lease.close('completed', 'the cell settled')
  }, 30_000)

  it('the same requestId retried AFTER the refusal is a clean retry: one dispatch, one row, no replay', async () => {
    // THE DOCUMENTED RECOVERY RULE, asserted rather than only written down. The
    // refused call never acquired an identity (no STARTED row, no subcall id
    // published), so a retry with the SAME request id is a fresh logical call and
    // must run exactly once. This is what makes the refusal safe to retry instead
    // of a trap: the program does not have to invent a new request id, and a
    // mutation cannot be doubled because nothing executed the first time.
    const ledger = new MemoryBridgeLedger()
    let failNext = true
    const attempts: string[] = []
    const realStarted = ledger.started.bind(ledger)
    ledger.started = async record => {
      attempts.push(record.subCallId)
      if (failNext) throw new Error('injected storage failure: the STARTED row could not be written')
      return await realStarted(record)
    }
    const { dispatched, bodies } = instrument()
    const lease = leaseWith(ledger, authorityFor('outer-retry', agentFor('p3-retry')), 'outer-retry')

    const refused = await refusalOf(lease.invoke({ ...REQUEST, leaseId: lease.id }))
    expect(refused.code).toBe('LEASE_LEDGER_UNAVAILABLE')
    expect(dispatched).toHaveLength(0)

    // The storage recovers, and the program retries the SAME request id.
    failNext = false
    const outcome = await lease.invoke({ ...REQUEST, leaseId: lease.id })
    expect(outcome.ok).toBe(true)
    expect(dispatched).toEqual(['p3_probe'])
    expect(bodies).toEqual(['from-the-cell'])
    expect(attempts).toHaveLength(2)
    // TWO rows, because the first attempt got as far as minting a subcall id and
    // writing nothing; the second wrote the row that carries the disposition.
    expect(ledger.all()).toHaveLength(1)
    expect(ledger.get('outer-retry:ipython:2')?.disposition).toBe('settled')
    expect(ledger.unknownOutcomes()).toHaveLength(0)
    await lease.close('completed', 'the cell settled')
  }, 30_000)

  it('a close during the in-flight write disposes the call with a recorded disposition, and CLOSED is still reached', async () => {
    // THE WINDOW OPTION A INTRODUCES, AND WHY IT IS CLOSED. `invoke` checks the
    // lease state before the write, but the write is an await, so a close can
    // begin during it. Publishing unconditionally would add the call to
    // `queue`/`inFlight` after `drain` had passed its last disposal and flushed,
    // leaving a CLOSED lease holding a call nothing would settle -- the same
    // ghost in a narrower window. So the late publish disposes it instead.
    const ledger = new MemoryBridgeLedger()
    const gate = deferred()
    const realStarted = ledger.started.bind(ledger)
    ledger.started = async record => { await gate.promise; return await realStarted(record) }
    const { dispatched, bodies } = instrument()
    const lease = leaseWith(ledger, authorityFor('outer-late', agentFor('p3-late')), 'outer-late')

    const pending = lease.invoke({ ...REQUEST, leaseId: lease.id })
    const closePromise = lease.close('completed', 'the cell settled')
    // The write is still open, so the close cannot be finished yet.
    expect(await withDeadline(closePromise.then(() => 'CLOSED'), 200)).toBe('TIMED_OUT')

    gate.resolve()
    const refusal = await refusalOf(pending)
    // The caller is refused with the stable cell-lease code, not left hanging and
    // not told its call succeeded.
    expect(refusal.code).toBe('CELL_LEASE_EXPIRED')
    expect(dispatched).toHaveLength(0)
    expect(bodies).toHaveLength(0)

    const closed = await withDeadline(closePromise.then(() => 'CLOSED' as const, error => `THREW: ${String(error)}`), 5000)
    expect(closed).toBe('CLOSED')
    expect(lease.lifecycle).toBe('CLOSED')
    // THE DISPOSITION IS RECORDED, so the STARTED row is not left looking like
    // the crash window. `outcomeIsUnknown` would otherwise report a call that
    // provably never dispatched as an unknown outcome.
    expect(ledger.get('outer-late:ipython:1')?.disposition).toBe('abandoned-unstarted')
    expect(ledger.unknownOutcomes()).toHaveLength(0)
    expect(lease.unrecordedDispositions).toHaveLength(0)
    expect(lease.dispositions().map(entry => entry.disposition)).toEqual(['abandoned-unstarted'])
  }, 30_000)
})

// ---------------------------------------------------------------------------
// BRI-PENDING
// ---------------------------------------------------------------------------

describe('BRI-PENDING: pending counts each accepted unsettled logical call ONCE', () => {
  it('one running call plus one queued call reports 2, which is where the two readings differ', async () => {
    // THE MEASUREMENT THAT DISTINGUISHES THE TWO READINGS. `inFlight` holds the
    // settlement promise of every ACCEPTED call; the FIFO holds the SUBSET that
    // has not started. With one call running and one queued, the correct count is
    // 2 and the old expression `inFlight.size + queue.length` said 3 -- so this
    // assertion fails against the old code for the right reason.
    const ledger = new MemoryBridgeLedger()
    const release = deferred()
    const b = new BridgeServer({ artifactDirectory: join(root, 'pending') })
    bridge = b
    let running = 0
    const lease = b.mintLease({
      sessionId: 'p3-pending',
      cellId: 'cell-1',
      epoch: 1,
      outerCallId: 'outer-pending',
      rootCallId: 'outer-pending',
      ledger,
      // A handler that BLOCKS, so "running" and "queued" are real, simultaneous
      // states rather than two names for the same moment.
      handler: async () => {
        running += 1
        if (running === 1) await release.promise
        return { ok: true, value: { ran: true } }
      },
    })

    const first = lease.invoke({ requestId: 'req-a', tool: 'p3_a', arguments: {}, cellId: 'cell-1', epoch: 1, leaseId: lease.id })
    for (let i = 0; i < 200 && running === 0; i += 1) await new Promise(resolve => setTimeout(resolve, 5))
    expect(running).toBe(1)

    const second = lease.invoke({ requestId: 'req-b', tool: 'p3_b', arguments: {}, cellId: 'cell-1', epoch: 1, leaseId: lease.id })
    // Let the second one reach the queue without starting (the FIFO is serial).
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(running).toBe(1)

    // ONE RUNNING + ONE QUEUED = TWO LOGICAL CALLS. The old expression said 3.
    expect(lease.pending).toBe(2)

    release.resolve()
    await Promise.all([first, second])
    // Both settled, so nothing is outstanding -- and the count reaches 0, which a
    // double-counting counter also did, but for the wrong reason.
    expect(lease.pending).toBe(0)
    await lease.close('completed', 'the cell settled')
    expect(lease.lifecycle).toBe('CLOSED')
  }, 30_000)

  it('a queued call alone is 1, not 2, and the count tracks settlement', async () => {
    // The single-call case, so the arm above is not the only place the count is
    // read. A queued call is in `inFlight` AND in `queue`; counting both would
    // report 2 for one logical call.
    const ledger = new MemoryBridgeLedger()
    const release = deferred()
    const b = new BridgeServer({ artifactDirectory: join(root, 'pending-one') })
    bridge = b
    let entered = 0
    const lease = b.mintLease({
      sessionId: 'p3-pending-one',
      cellId: 'cell-1',
      epoch: 1,
      outerCallId: 'outer-one',
      rootCallId: 'outer-one',
      ledger,
      handler: async () => {
        entered += 1
        await release.promise
        return { ok: true, value: { ran: true } }
      },
    })

    const call = lease.invoke({ requestId: 'req-a', tool: 'p3_a', arguments: {}, cellId: 'cell-1', epoch: 1, leaseId: lease.id })
    for (let i = 0; i < 200 && entered === 0; i += 1) await new Promise(resolve => setTimeout(resolve, 5))
    expect(entered).toBe(1)
    expect(lease.pending).toBe(1)

    release.resolve()
    await call
    expect(lease.pending).toBe(0)
    await lease.close('completed', 'the cell settled')
  }, 30_000)

  it('a call whose STARTED write is still in flight is NOT counted, because under Option A it is not accepted yet', async () => {
    // THE DOCUMENTED CONSEQUENCE OF CHOOSING A, asserted so it cannot silently
    // become something else. `pending` is "accepted unsettled logical calls"; a
    // call whose durable intent has not committed has not been accepted. A
    // reader who wants "writes outstanding" needs a different surface, and this
    // assertion is what stops `pending` from quietly meaning two things.
    const ledger = new MemoryBridgeLedger()
    const gate = deferred()
    const realStarted = ledger.started.bind(ledger)
    ledger.started = async record => { await gate.promise; return await realStarted(record) }
    const { dispatched } = instrument()
    const lease = leaseWith(ledger, authorityFor('outer-notyet', agentFor('p3-notyet')), 'outer-notyet')

    const call = lease.invoke({ ...REQUEST, leaseId: lease.id })
    expect(lease.pending).toBe(0)
    gate.resolve()
    await call
    expect(dispatched).toEqual(['p3_probe'])
    await lease.close('completed', 'the cell settled')
  }, 30_000)
})
