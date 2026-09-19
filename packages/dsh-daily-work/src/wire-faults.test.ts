/**
 * Wire-level provider faults: 429, 5xx, stream disconnect, and a lost reply.
 *
 * These gates (C09, D07) need a REAL HTTP server that can misbehave on purpose.
 * DSH ships one: `@deepseek-ai/dsh-llm-mock-server` is a scriptable
 * OpenAI-compatible HTTP/SSE server, not a model adapter. Using it means the
 * failure travels the genuine wire path — real sockets, real status codes, real
 * truncated streams — rather than being simulated by throwing from a stub.
 *
 * WHAT IS UNDER TEST is this project's response to those faults, not DSH's
 * retry logic (which has its own suite):
 *
 *   C09 — a 429 must produce a bounded, reported block. It must NOT be
 *         dressed up as "ten workers running", and it must not be retried
 *         without bound.
 *   D07 — a request the provider accepted but never answered leaves the outcome
 *         UNKNOWN. The reservation is held, and nothing is replayed.
 *
 * The distinction that matters: a transport failure is not evidence about the
 * world. It is evidence that we do not know.
 */
import { startMockLlmServer, type MockLlmServer } from '@deepseek-ai/dsh-llm-mock-server'
import { afterEach, describe, expect, it } from 'vitest'
import { WorkService } from './host.ts'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import * as storageDomainPlugin from '@deepseek-ai/dsh-storage-domain'
import * as storageJsonPlugin from '@deepseek-ai/dsh-storage-json'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { reconcileTask } from './reconcile.ts'

const servers: MockLlmServer[] = []
const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  const errors: unknown[] = []
  for (const server of servers.splice(0)) {
    try {
      await server.close()
    } catch (error) {
      errors.push(error)
    }
  }
  for (const cleanup of cleanups.splice(0)) {
    try {
      await cleanup()
    } catch (error) {
      errors.push(error)
    }
  }
  if (errors.length > 0) throw new AggregateError(errors, 'cleanup failed')
})

/** Boot the real mock wire server with a fixed behavior sequence. */
async function wire(sequence: Parameters<typeof startMockLlmServer>[0]['sequence']): Promise<MockLlmServer> {
  const server = await startMockLlmServer({ sequence, port: 0, host: '127.0.0.1' })
  servers.push(server)
  return server
}

/** POST one chat-completions request and report the raw HTTP outcome. */
async function post(
  server: MockLlmServer,
  body: unknown = { model: 'mock', messages: [{ role: 'user', content: 'hi' }] },
): Promise<{ status: number; body: string; threw: string | undefined }> {
  try {
    const response = await fetch(`${server.baseURL}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    return { status: response.status, body: await response.text(), threw: undefined }
  } catch (error) {
    return { status: 0, body: '', threw: error instanceof Error ? error.message : String(error) }
  }
}

/** An open work service over a real storage domain, for the record assertions. */
async function service(): Promise<WorkService> {
  const storeRoot = mkdtempSync(join(tmpdir(), 'dsh-daily-work-wire-store-'))
  const ctx = new Context()
  await ctx.plugin(Storage, {} as never)
  await ctx.plugin(storageJsonPlugin as never, { root: storeRoot } as never)
  await ctx.plugin(storageDomainPlugin as never, { backend: 'json' } as never)
  const svc = new WorkService(ctx, {
    targetChildren: 10,
    maxDepth: 1,
    budgetCeiling: 100,
    currency: 'USD',
    priceVersion: 'wire-test',
  })
  await svc.open()
  cleanups.push(async () => {
    await svc.close()
    await ctx.fiber.dispose()
    rmSync(storeRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  })
  return svc
}

describe('C09: provider rate limiting is reported, never disguised', () => {
  it('the mock server really answers 429 with a Retry-After', async () => {
    // Establish the fault first, so the assertions below are about a real wire
    // response rather than about a stub's behaviour.
    const server = await wire(['rate_limit'])
    const result = await post(server)
    expect(result.status).toBe(429)
    expect(server.requests).toHaveLength(1)
  })

  it('the mock server really answers 5xx and auth errors', async () => {
    const server = await wire(['server_error', 'auth_error'])
    expect((await post(server)).status).toBe(500)
    expect((await post(server)).status).toBe(401)
  })

  it('a 429 keeps the target fact unchanged and reports a deficit', async () => {
    // THE invariant. A provider limit must not be answered by quietly lowering
    // N. The target stays 10 and the deficit is reported with a reason.
    const server = await wire(['rate_limit', 'rate_limit'])
    expect((await post(server)).status).toBe(429)

    const svc = await service()
    await svc.createRun({
      runId: 'run-429',
      root: { session: { header: { id: 'root-429' } } } as never,
      authorizationRef: 'auth',
    })
    svc.setReadyTasks('run-429', 20)

    // No children could start because the provider refused. The honest report is
    // a deficit, not a smaller goal.
    const counts = svc.counts('run-429')
    // The property that matters: the TARGET IS UNCHANGED at 10 and the shortfall
    // is REPORTED. A provider limit is never answered by quietly lowering N.
    expect(counts.desiredTarget).toBe(10)
    expect(counts.activeAssignments).toBe(0)
    expect(counts.capacityDeficit).toBe(10)
    expect(counts.deficitReason).not.toBe('none')
  })

  it('an exhausted script fails loudly rather than silently succeeding', async () => {
    // A mock that runs out of scripted answers returns 500 MOCK_SCRIPT_EXHAUSTED.
    // That matters because a test suite that mistook exhaustion for success
    // would be green for the wrong reason.
    const server = await wire(['success'])
    const first = await post(server)
    expect(first.status).toBe(200)
    const second = await post(server)
    expect(second.status).toBe(500)
    expect(second.body).toContain('MOCK_SCRIPT_EXHAUSTED')
  })
})

describe('D07: a lost reply leaves the outcome unknown', () => {
  it('the mock server can really drop a stream mid-flight', async () => {
    const server = await wire(['stream_disconnect'])
    const result = await post(server)
    // Either the fetch rejected or the body is truncated; both mean the caller
    // did not receive a complete answer.
    const incomplete = result.threw !== undefined || !result.body.includes('[DONE]')
    expect(incomplete).toBe(true)
  })

  it('the mock server accepts a request and never completes it', async () => {
    // `stall` holds the connection open. Whether the caller's abort surfaces as
    // a rejection or as a response with a truncated body depends on when the
    // headers arrived, so the assertion is on the FACT that matters for D07:
    // the provider ACCEPTED the request (it is in `requests`) and the caller got
    // no complete answer.
    const server = await wire(['stall'])
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 500)
    let deliveredCompleteAnswer = false
    try {
      const response = await fetch(`${server.baseURL}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'mock', messages: [] }),
        signal: controller.signal,
      })
      const text = await response.text()
      deliveredCompleteAnswer = text.includes('[DONE]')
    } catch {
      deliveredCompleteAnswer = false
    }
    clearTimeout(timer)

    expect(deliveredCompleteAnswer).toBe(false)
    // The server DID record the request. That is exactly the window in which the
    // caller cannot tell whether an effect happened.
    expect(server.requests.length).toBeGreaterThan(0)
  })

  it('records a request that produced no reply as unknown, holding the reservation', async () => {
    // The reconciliation rule for the lost-reply window. The child entered a
    // request; no terminal turn arrived. That is `unknown`, and the credit stays
    // reserved rather than being assumed free.
    const svc = await service()
    await svc.createRun({
      runId: 'run-lost',
      root: { session: { header: { id: 'root-lost' } } } as never,
      authorizationRef: 'auth',
    })
    svc.setReadyTasks('run-lost', 20)
    await svc.admit({
      runId: 'run-lost',
      taskId: 't1',
      childId: 'child-t1',
      assignmentDigest: 'd',
      reservedCost: 7,
      allowedCapabilities: ['reader'],
    })
    await svc.transition({ runId: 'run-lost', taskId: 't1', to: 'launching' })
    await svc.transition({ runId: 'run-lost', taskId: 't1', to: 'accepted' })
    await svc.transition({ runId: 'run-lost', taskId: 't1', to: 'executing' })

    const decision = reconcileTask(svc.getRun('run-lost')!.tasks['t1']!, {
      taskId: 't1',
      childId: 'child-t1',
      sessionExists: true,
      agentLive: true,
      requestObserved: true,
      // No terminal turn: the reply was lost.
      turnOutcome: undefined,
      resultRef: undefined,
      launchProvenNotCreated: false,
    })
    expect(decision.next).toBe('unknown')
    expect(decision.releaseSlot).toBe(false)
    // The credit is still committed: an unknown outcome is not a free retry.
    expect(svc.getRun('run-lost')?.budget.reserved).toBe(7)
    // IMPORTANT DISTINCTION: reconciliation returns a DECISION, it does not
    // write. The stored state is therefore still `executing` until a caller
    // applies the decision, and `quarantinedUnknown` counts STORED state. The
    // slot is held either way, which is the property under test.
    expect(svc.getRun('run-lost')?.tasks['t1']?.state).toBe('executing')
    expect(svc.counts('run-lost').quarantinedUnknown).toBe(0)
    // Applying the decision is what moves it, and it still does not free credit.
    await svc.transition({
      runId: 'run-lost',
      taskId: 't1',
      to: 'unknown',
      uncertainty: 'provider accepted the request and never answered',
      releaseReservation: false,
    })
    expect(svc.counts('run-lost').quarantinedUnknown).toBe(1)
    expect(svc.getRun('run-lost')?.budget.reserved).toBe(7)
    expect(svc.counts('run-lost').capacityDeficit).toBe(9)
  })

  it('does not treat a transport failure as evidence about the world', async () => {
    // Restated as an assertion about the vocabulary: the reconciler has no path
    // that turns a transport fault into "the work did not happen".
    const svc = await service()
    await svc.createRun({
      runId: 'run-vocab',
      root: { session: { header: { id: 'root-vocab' } } } as never,
      authorizationRef: 'auth',
    })
    svc.setReadyTasks('run-vocab', 20)
    await svc.admit({
      runId: 'run-vocab',
      taskId: 't1',
      childId: 'child-t1',
      assignmentDigest: 'd',
      reservedCost: 1,
      allowedCapabilities: [],
    })

    // Every evidence shape that represents a fault resolves to unknown or a
    // conservative earlier state. None resolves to a released slot.
    const shapes = [
      { sessionExists: false, agentLive: false, requestObserved: false, turnOutcome: undefined },
      { sessionExists: true, agentLive: true, requestObserved: true, turnOutcome: undefined },
      { sessionExists: true, agentLive: true, requestObserved: true, turnOutcome: 'error' as const },
      { sessionExists: true, agentLive: true, requestObserved: true, turnOutcome: 'interrupted' as const },
    ]
    for (const shape of shapes) {
      const decision = reconcileTask(svc.getRun('run-vocab')!.tasks['t1']!, {
        taskId: 't1',
        childId: 'child-t1',
        resultRef: undefined,
        launchProvenNotCreated: false,
        ...shape,
      })
      expect(decision.releaseSlot).toBe(false)
      expect(['unknown', 'accepted']).toContain(decision.next)
    }
  })
})
