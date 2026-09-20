/**
 * R5 — F2 ASSEMBLED-PRODUCT QUALIFICATION.
 *
 * THE DEFECT THIS FILE EXISTS TO CLOSE. `G-SEAM-34` / `F2`: the bridge mechanism
 * was implemented, unit-tested and correct, and `new BridgeServer` had ZERO
 * production call sites — measured twice, by two independent instruments. So a
 * model's Python cell could reach no DSH tool at all, which made `ipython` a dead
 * end for everything but pure computation. The class is recorded twelve times in
 * this project: mechanism implemented, tested, correct, and nothing in the
 * product calls it.
 *
 * WHY THE PREVIOUS TESTS DID NOT CATCH IT, AND WHAT IS DIFFERENT HERE. Every
 * existing bridge test (`bridge-seam.test.ts`, `v3-spec-gates.test.ts`, the
 * `v4-*-probe.ts` family) mounts a `BridgeServer` BY HAND and calls
 * `service.runCell` directly. That proves the MODULE works and proves nothing
 * about the product — the brief's §2 states the rule: *"If the answer is 'a test
 * mounts it', you have proved the module works and proved nothing about the
 * product."*
 *
 * This file therefore never constructs a `BridgeServer`, never calls
 * `mintLease`, and never calls `runCell` with a hand-built authority. It drives
 * the REAL model-facing `ipython` tool — registered by `ipython-tool.ts`'s own
 * `apply`, the same code the profile's preset row loads — through
 * `ctx.tools.execute`, exactly as the agent loop does. The `CellAuthority` is
 * built by the TOOL from the live `ToolRunContext`, and the lease is minted by
 * `KernelService` inside `runCell`. If the wiring is removed from production, this
 * file fails; that is the property that makes it an assembled-product test.
 *
 * WHAT IS REAL HERE. The real registry (`SystemPrompt` + `ToolRuntime`), the real
 * subprocess provider, a real ipykernel through the real `broker.py`, the real
 * `KernelService`, the real bridge client written into the kernel's scratch
 * directory, and real cells. Every observation is taken from the REGISTRY side (a
 * `tools/pre-execute` listener and a `tools/result` listener) or from what the
 * cell PRINTED — never from what the bridge says about itself.
 *
 * WHAT THIS FILE DOES NOT CLAIM. It does not boot the `daily` profile; the
 * profile-level reachability is measured separately by
 * `qualification/runners/r5-bridge-product.mjs`, which is the assembled daily
 * COMPOSITION rather than the assembled code path. Both are needed and neither
 * substitutes for the other.
 */
import { Context } from '@deepseek-ai/cordis'
import Subprocess from '@deepseek-ai/dsh-subprocess-local'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool, type ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as ipythonTool from './ipython-tool.ts'
import { KernelService } from './kernel-plugin.ts'
import { BridgeServer } from './bridge.ts'
import { MemoryBridgeLedger } from './bridge-ledger.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const BROKER = resolve(HERE, 'broker.py')
const PYTHON = process.env['DSH_PYTHON'] ?? 'C:/Users/hzq00/AppData/Local/Programs/Python/Python314/python.exe'

let ctx: Context
let root: string
let service: KernelService | undefined

/** What the registry itself saw, so no claim rests on the bridge's own account. */
let dispatches: Array<{ name: string, callId: string, parentSet: boolean }> = []
let results: string[] = []

beforeEach(async () => {
  ctx = new Context()
  await ctx.plugin(SystemPrompt, { personaPrefix: '' })
  await ctx.plugin(ToolRuntime, { mode: 'native', maxParallelSubCalls: 10 })
  await ctx.plugin(Subprocess)
  root = await mkdtemp(join(tmpdir(), 'dsh-ipython-product-'))
  dispatches = []
  results = []

  // The registry-side instrument. Read from the pipeline, not from the bridge.
  ctx.on('tools/pre-execute', (exec, next) => {
    dispatches.push({ name: exec.name, callId: String(exec.callId), parentSet: exec.parent !== undefined })
    return next()
  })
  ctx.on('tools/result', exec => { results.push(`${exec.name}:${String(exec.callId)}`) })

  // The REAL kernel service, mounted as the profile's bundle row mounts it. The
  // ledger is durable by default; this test asks for the in-memory one so the
  // suite needs no storage facility, which is a configuration difference and not
  // a wiring difference.
  service = new KernelService(ctx, {
    pythonExecutable: PYTHON,
    brokerScript: BROKER,
    root: join(root, 'kernels'),
    durableLedger: false,
    // A SMALL inline bound for the whole file, not only for the artifact test.
    // Rebuilding the service mid-test to change it would re-register the `ipython`
    // service key on the same context, which Cordis refuses ("has been registered")
    // -- and a second context would be a second product composition rather than
    // the one under test. 4 KiB is far above every inline value the other arms use.
    inlineValueBytes: 4096,
  })
  // `KernelService extends Service`, and `Service`'s constructor calls
  // `ctx.reflect.provide(name, this, ...)` -- so `ctx.ipython` / `ctx.get('ipython')`
  // resolves from the constructor alone. No extra `provide` here: a second one
  // would be a second registration of the same key.

  // THE PRODUCT'S OWN TOOL REGISTRATION. `apply` is the same function the
  // preset's `dsh-ipython/tool` row loads; nothing about it is test-specific.
  ipythonTool.apply(ctx)
})

afterEach(async () => {
  if (service !== undefined) {
    await service.close().catch(() => undefined)
    service = undefined
  }
  await ctx.fiber.dispose()
  await rm(root, { recursive: true, force: true })
})

/** The Agent stand-in `KernelService` reads its Session identity from. */
function agentFor(sessionId: string, cwd = root): Agent {
  return { session: { header: { id: sessionId, cwd } } } as unknown as Agent
}

/** The exact call shape the agent loop uses: the tool's own `execute`, via the registry. */
async function callIpython(agent: Agent, code: string, callId = `outer-${String(++outerSeq)}`): Promise<{
  text: string
  outcome: string
  callId: string
  result: ToolExecutionResult
}> {
  const result = await ctx.tools.execute({
    callId: callId as never,
    name: ipythonTool.IPYTHON_TOOL_NAME,
    arguments: { code },
    agent,
    signal: new AbortController().signal,
  })
  if (result.isError) {
    return { text: result.error.message, outcome: 'error', callId, result }
  }
  const value = result.value as { text: string, outcome: string }
  return { text: value.text, outcome: value.outcome, callId, result }
}

let outerSeq = 0

/** One `key=value` line a cell printed, or undefined. */
function printed(text: string, key: string): string | undefined {
  const match = new RegExp(`^${key}=(.*)$`, 'mu').exec(text)
  return match?.[1]?.trim()
}

describe('R5-F2: the PRODUCT path reaches the native bridge', () => {
  it('the ipython tool is registered by the package own apply(), with ONE parameter', () => {
    const schemas = ctx.tools.schemas(undefined as never)
    const schema = schemas.find(entry => entry.name === ipythonTool.IPYTHON_TOOL_NAME)
    expect(schema, 'the model-facing ipython tool must be registered by ipython-tool.ts apply()').toBeDefined()
    // The product's own registration is what this file drives; a test that
    // re-registered the tool itself would be measuring its own harness.
    expect(ipythonTool.name).toBe('dsh-ipython-tool')
  }, 60_000)

  it('model -> ipython -> dsh.call -> ToolRuntime -> Python value, on the product path', async () => {
    // A small tool registered through the SAME registry the model's own tools use.
    ctx.tools.register(defineTool({
      name: 'r5_echo',
      description: 'Returns a small canonical object, so the delivered shape is observable.',
      parameters: { tag: { type: 'string', required: true } },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            marker: { type: 'string', required: true },
            tag: { type: 'string', required: true },
            count: { type: 'integer', required: true },
          },
        },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      execute: async args => ({ marker: 'R5-PRODUCT', tag: (args as { tag: string }).tag, count: 3 }),
    }))

    const agent = agentFor('r5-product-path')
    const cell = await callIpython(agent, [
      'import json',
      "value = await dsh.call('r5_echo', {'tag': 'from-the-product'})",
      "print('VALUE=' + json.dumps(value, sort_keys=True, separators=(',', ':')))",
      "print('TYPE=' + type(value).__name__)",
      "print('HAS_DSH=' + str('dsh' in dir()))",
    ].join('\n'))

    expect(cell.outcome).toBe('ok')
    // The cell actually had `dsh` bound by the host's preamble. Without the
    // product wiring this is NameError, which is exactly F2's symptom.
    expect(printed(cell.text, 'HAS_DSH')).toBe('True')
    expect(printed(cell.text, 'TYPE')).toBe('dict')
    // The value is the registry's own canonical object, not a bridge-invented
    // stub: all three declared fields arrived with their declared types.
    expect(JSON.parse(printed(cell.text, 'VALUE') ?? 'null')).toEqual({
      count: 3,
      marker: 'R5-PRODUCT',
      tag: 'from-the-product',
    })

    // And the registry really ran it, exactly once.
    const echoDispatches = dispatches.filter(entry => entry.name === 'r5_echo')
    expect(echoDispatches).toHaveLength(1)
    // The sub-dispatch marker: a bridged call carries the outer token as `parent`.
    expect(echoDispatches[0]?.parentSet).toBe(true)
    // The subcall id is correlatable to the OUTER ipython call, per V3 §J4.
    expect(echoDispatches[0]?.callId).toMatch(/^outer-\d+:ipython:\d+$/u)
    expect(results.filter(entry => entry.startsWith('r5_echo:'))).toHaveLength(1)
  }, 300_000)

  it('three exact calls produce exactly three ToolRuntime dispatches in one outer model turn', async () => {
    ctx.tools.register(defineTool({
      name: 'r5_count',
      description: 'Echoes its index, so each dispatch is distinguishable.',
      parameters: { index: { type: 'integer', required: true } },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: { index: { type: 'integer', required: true } },
        },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      execute: async args => ({ index: (args as { index: number }).index }),
    }))

    const agent = agentFor('r5-three-calls')
    const cell = await callIpython(agent, [
      'seen = []',
      'for i in range(3):',
      "    seen.append((await dsh.call('r5_count', {'index': i}))['index'])",
      "print('SEEN=' + ','.join(str(x) for x in seen))",
    ].join('\n'))

    expect(cell.outcome).toBe('ok')
    expect(printed(cell.text, 'SEEN')).toBe('0,1,2')
    const counted = dispatches.filter(entry => entry.name === 'r5_count')
    expect(counted).toHaveLength(3)
    // Exactly three dispatches and three results: one model turn, three exact
    // calls, no duplication and no bridge-invented retry.
    expect(counted.map(entry => entry.callId)).toEqual([
      expect.stringMatching(/^outer-\d+:ipython:1$/u),
      expect.stringMatching(/^outer-\d+:ipython:2$/u),
      expect.stringMatching(/^outer-\d+:ipython:3$/u),
    ])
  }, 300_000)

  it('concurrent Python submission SERIALIZES: at most one exact call is ever in the registry', async () => {
    // The negative instrument: track live overlap from the registry side.
    let live = 0
    let maxLive = 0
    ctx.tools.register(defineTool({
      name: 'r5_slow',
      description: 'Sleeps briefly, so overlap would be observable if it happened.',
      parameters: { tag: { type: 'string', required: true } },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: { tag: { type: 'string', required: true } },
        },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      execute: async args => {
        live += 1
        maxLive = Math.max(maxLive, live)
        await new Promise(resolveDelay => setTimeout(resolveDelay, 250))
        live -= 1
        return { tag: (args as { tag: string }).tag }
      },
    }))

    const agent = agentFor('r5-serial')
    const cell = await callIpython(agent, [
      'import asyncio',
      'async def one(tag):',
      "    value = await dsh.call('r5_slow', {'tag': tag})",
      '    return value["tag"]',
      "tags = await asyncio.gather(*[one('a'), one('b'), one('c'), one('d')])",
      "print('TAGS=' + ','.join(tags))",
    ].join('\n'))

    expect(cell.outcome).toBe('ok')
    expect(printed(cell.text, 'TAGS')).toBe('a,b,c,d')
    // V3 §J1: the host executes serially in bridge-accepted sequence, so overlap
    // in the registry is 1. A value above 1 would mean the serial baseline was
    // not honoured -- and the completion order above proves the FIFO, because a
    // concurrent dispatch would be free to finish out of order.
    expect(maxLive).toBe(1)
    expect(dispatches.filter(entry => entry.name === 'r5_slow')).toHaveLength(4)
  }, 300_000)
})

describe('R5-BR-07: dispositions, the half that was missing', () => {
  it('a completed call carries `settled`, and the durable ledger row is STARTED then SETTLED', async () => {
    ctx.tools.register(defineTool({
      name: 'r5_ok',
      description: 'Succeeds immediately.',
      parameters: {},
      output: {
        schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean', required: true } } },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      execute: async () => ({ ok: true }),
    }))

    const agent = agentFor('r5-disposition-settled')
    const cell = await callIpython(agent, "value = await dsh.call('r5_ok', {})\nprint('OK=' + str(value['ok']))")
    expect(cell.outcome).toBe('ok')

    const ledger = service?.ledgerFor(agent)
    expect(ledger).toBeDefined()
    // Keyed by the outer call id the harness actually used, read back from the
    // call rather than assumed: the id is the correlation key V3 §J6 names, so a
    // test that guessed it would not be testing correlation at all.
    const rows = ledger?.forOuterCall(cell.callId) ?? []
    expect(rows).toHaveLength(1)
    const row = rows[0]
    expect(row?.name).toBe('r5_ok')
    expect(row?.disposition).toBe('settled')
    // STARTED before dispatch and SETTLED after: both stamps present, and the
    // settlement carries a digest of the delivered value rather than the value.
    expect(row?.startedAt).toBeTruthy()
    expect(row?.settledAt).toBeTruthy()
    expect(row?.resultDigest).toMatch(/^[a-f0-9]{64}$/u)
    expect(row?.isError).toBe(false)
    // The subcall id is the correlation key V3 §J6 names, and it is derived from
    // the OUTER call id -- so a reader holding the Session's `ipython` execution
    // can find every exact call it authorised.
    expect(row?.subCallId).toBe(`${cell.callId}:ipython:1`)
  }, 300_000)

  it('a cell returning with calls in flight records `cancelled` and `abandoned-unstarted`', async () => {
    // THE STIMULUS BR-07 NAMES: "Return a cell while native child calls are still
    // in flight." Two background tasks are started and NOT awaited:
    //
    //   A calls a SLOW tool, so it is dispatched and in the registry when the
    //     cell settles. It must be recorded `cancelled` -- it started, and the
    //     close aborted it.
    //   B calls a fast tool but is QUEUED BEHIND A, because the lease is serial
    //     (V3 §J1). It never starts. It must be recorded `abandoned-unstarted`.
    //
    // The serial queue is what makes B's arm deterministic: without it B could
    // start alongside A and the test would be racing the scheduler. A small
    // in-cell sleep after starting both guarantees A has reached the host, which
    // is what makes this a measurement rather than a coin flip -- an earlier
    // version of this test asserted without that wait and was FLAKY, returning
    // zero ledger rows when the cell won the race.
    let slowEntered = 0
    ctx.tools.register(defineTool({
      name: 'r5_slow_inflight',
      description: 'Stays in the registry until the close aborts it.',
      parameters: {},
      output: {
        schema: { type: 'object', additionalProperties: false, properties: { ran: { type: 'boolean', required: true } } },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      execute: async (_args, exec) => {
        slowEntered += 1
        // A long sleep that the abort cuts short: the point is that this call is
        // IN FLIGHT at close, not that it finishes.
        await new Promise<void>(resolveDelay => {
          const timer = setTimeout(() => { resolveDelay() }, 30_000)
          exec.signal.addEventListener('abort', () => { clearTimeout(timer); resolveDelay() }, { once: true })
        })
        return { ran: true }
      },
    }))
    ctx.tools.register(defineTool({
      name: 'r5_queued_behind',
      description: 'Must never be dispatched: the serial queue never reaches it.',
      parameters: {},
      output: {
        schema: { type: 'object', additionalProperties: false, properties: { ran: { type: 'boolean', required: true } } },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      execute: async () => ({ ran: true }),
    }))

    const agent = agentFor('r5-abandoned')
    const cell = await callIpython(agent, [
      'import asyncio',
      'async def first():',
      "    return await dsh.call('r5_slow_inflight', {})",
      'async def second():',
      "    return await dsh.call('r5_queued_behind', {})",
      'a = asyncio.ensure_future(first())',
      'await asyncio.sleep(0.5)',
      'b = asyncio.ensure_future(second())',
      'await asyncio.sleep(0.5)',
      "print('RETURNING_WITH_A_PENDING=' + str(not a.done()))",
      "print('RETURNING_WITH_B_PENDING=' + str(not b.done()))",
    ].join('\n'))

    expect(cell.outcome).toBe('ok')
    expect(printed(cell.text, 'RETURNING_WITH_A_PENDING')).toBe('True')
    expect(printed(cell.text, 'RETURNING_WITH_B_PENDING')).toBe('True')

    // THE ORACLE: every in-flight call carries ONE disposition, and a reader can
    // tell which. Nothing continues silently.
    const rows = service?.ledgerFor(agent)?.forOuterCall(cell.callId) ?? []
    expect(rows).toHaveLength(2)
    const byName = new Map(rows.map(row => [row.name, row]))
    // A started and was aborted by the close.
    expect(byName.get('r5_slow_inflight')?.disposition).toBe('cancelled')
    expect(byName.get('r5_slow_inflight')?.closeReason).toBe('completed')
    // B never started, and no handoff exists in this composition.
    expect(byName.get('r5_queued_behind')?.disposition).toBe('abandoned-unstarted')
    // B really was never dispatched: the queue is a real barrier, not a label.
    expect(dispatches.filter(entry => entry.name === 'r5_queued_behind')).toHaveLength(0)
    expect(slowEntered).toBe(1)
    // Every row reached a terminal state, and the lease table is empty.
    expect(rows.every(row => row.disposition !== undefined)).toBe(true)
    expect(service?.bridgeFor(agent)?.server.openLeases()).toHaveLength(0)
  }, 300_000)

  it('a call still queued when the cell returns is never dispatched, whatever its disposition', async () => {
    // THE FLAKE ARM, KEPT AS ITS OWN MEASUREMENT. This is the shape an earlier
    // version of the test above used -- a background task started and the cell
    // returned immediately -- and it is genuinely RACY: the task may not have
    // reached the host at all, in which case the ledger correctly holds ZERO rows
    // because no call ever arrived. That is not a defect; it is the difference
    // between "a call was in flight" and "a call never started". Kept so the
    // distinction is measured rather than erased by deleting the flaky test.
    ctx.tools.register(defineTool({
      name: 'r5_race',
      description: 'May or may not be reached, depending on the race.',
      parameters: {},
      output: {
        schema: { type: 'object', additionalProperties: false, properties: { ran: { type: 'boolean', required: true } } },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      execute: async () => ({ ran: true }),
    }))

    const agent = agentFor('r5-race')
    const cell = await callIpython(agent, [
      'import asyncio',
      'async def background():',
      "    return await dsh.call('r5_race', {})",
      'task = asyncio.ensure_future(background())',
      "print('RETURNED_WITH_TASK_PENDING=' + str(not task.done()))",
    ].join('\n'))

    expect(cell.outcome).toBe('ok')
    expect(printed(cell.text, 'RETURNED_WITH_TASK_PENDING')).toBe('True')

    const rows = service?.ledgerFor(agent)?.forOuterCall(cell.callId) ?? []
    const dispatched = dispatches.filter(entry => entry.name === 'r5_race').length
    // THE INVARIANT, and it holds in BOTH race outcomes: if the call reached the
    // host it has a terminal disposition; if it did not, there is no row. What is
    // never true is a row with no disposition, or a dispatch with no row.
    expect(rows.length).toBe(dispatched)
    for (const row of rows) {
      expect(row.disposition).toBeDefined()
      expect(['settled', 'cancelled', 'abandoned-unstarted', 'handed-to-jobs']).toContain(row.disposition)
    }
    // Nothing survives the cell either way.
    expect(service?.bridgeFor(agent)?.server.openLeases()).toHaveLength(0)
  }, 300_000)

  it('the four dispositions are the scope route vocabulary, not a parallel one', async () => {
    // A structural check on the ONE vocabulary claim: the names the bridge route
    // reports are the same four the scope route reports. Measured by reading the
    // scope module's own source rather than by asserting a copied list.
    const { BRIDGE_DISPOSITIONS } = await import('./bridge-ledger.ts')
    const scopeSource = await import('node:fs').then(fs => fs.readFileSync(
      resolve(HERE, '..', '..', 'dsh-daily-work', 'src', 'programmatic-scope.ts'),
      'utf8',
    ))
    for (const disposition of BRIDGE_DISPOSITIONS) {
      expect(scopeSource, `the scope route must use the same word: ${disposition}`).toContain(`'${disposition}'`)
    }
    expect([...BRIDGE_DISPOSITIONS].sort()).toEqual(
      ['abandoned-unstarted', 'cancelled', 'handed-to-jobs', 'settled'].sort(),
    )
  }, 30_000)

  it('a handoff names its job id; with no handoff the call is abandoned-unstarted', async () => {
    // The two arms are driven directly against the ledger's own rules, because
    // the production composition has no Jobs handoff installed (this deployment
    // mounts `tool-jobs` but the bridge's handoff is host configuration, and
    // inventing a job id would be the fabrication the oracle forbids).
    const ledger = new MemoryBridgeLedger()
    await ledger.started({
      subCallId: 'handoff-1', sessionId: 's', kernelEpoch: 1, cellId: 'c',
      outerCallId: 'o', rootCallId: 'o', requestId: 'r', argsDigest: 'a'.repeat(64), name: 'tool',
    })
    // handed-to-jobs WITHOUT a job id is refused by the ledger itself.
    await expect(ledger.disposed('handoff-1', 'handed-to-jobs'))
      .rejects.toThrow(/no job id/u)

    await ledger.started({
      subCallId: 'handoff-2', sessionId: 's', kernelEpoch: 1, cellId: 'c',
      outerCallId: 'o', rootCallId: 'o', requestId: 'r2', argsDigest: 'b'.repeat(64), name: 'tool',
    })
    await ledger.disposed('handoff-2', 'handed-to-jobs', { jobId: 'job-42' })
    expect(ledger.get('handoff-2')?.jobId).toBe('job-42')

    // And a non-handoff disposition may NOT carry a job id.
    await ledger.started({
      subCallId: 'handoff-3', sessionId: 's', kernelEpoch: 1, cellId: 'c',
      outerCallId: 'o', rootCallId: 'o', requestId: 'r3', argsDigest: 'c'.repeat(64), name: 'tool',
    })
    await expect(ledger.disposed('handoff-3', 'settled', { jobId: 'job-9' }))
      .rejects.toThrow(/only handed-to-jobs/u)
  }, 30_000)

  it('a FAILED disposition write is reported, not swallowed, and CLOSED still happens', async () => {
    // FAULT INJECTION for the case a happy-path test cannot see: the ledger's
    // disposition write rejects. Before the fix, `flush` used a bare
    // `Promise.allSettled`, so the lease reached CLOSED with the disposition
    // missing and the caller was told nothing -- "continues silently with no
    // record", one level below the bridge. This drives that arm.
    const failing = new MemoryBridgeLedger()
    let refusals = 0
    failing.disposed = async () => {
      refusals += 1
      throw new Error('injected storage failure: the disposition could not be written')
    }

    const bridge = new BridgeServer({ artifactDirectory: join(root, 'ledger-fault') })
    await bridge.start()
    const lease = bridge.mintLease({
      sessionId: 'r5-ledger-fault', cellId: 'cell-1', epoch: 1,
      outerCallId: 'outer-fault', rootCallId: 'outer-fault',
      ledger: failing,
      handler: async () => ({ ok: true, value: { ok: true } }),
    })
    // One call, accepted and settled normally. Only the DISPOSITION write fails.
    const outcome = await lease.invoke({
      requestId: 'req-1', tool: 'r5_ok', arguments: {},
      cellId: 'cell-1', epoch: 1, leaseId: lease.id,
    })
    expect(outcome.ok).toBe(true)

    const failure = await lease.close('completed', 'the cell settled').then(
      () => undefined,
      (error: unknown) => error,
    )
    // THE FIX: the close REPORTS the unrecorded disposition.
    expect(refusals).toBe(1)
    expect(failure).toBeDefined()
    expect(String(failure)).toMatch(/could not be recorded durably/u)
    expect((failure as { unrecorded?: unknown[] }).unrecorded).toHaveLength(1)
    expect((failure as { unrecorded: Array<{ subCallId: string, disposition: string }> }).unrecorded[0]?.subCallId)
      .toBe('outer-fault:ipython:1')
    expect((failure as { unrecorded: Array<{ disposition: string }> }).unrecorded[0]?.disposition).toBe('settled')
    // AND the lease still reached CLOSED: a lease stuck in CLOSING would refuse
    // every call while claiming not to have settled, which is a worse defect.
    expect(lease.lifecycle).toBe('CLOSED')
    expect(lease.unrecordedDispositions).toHaveLength(1)
    await bridge.close()
  }, 60_000)

  it('a healthy close records every disposition and reports no failure', async () => {
    // The contrast for the fault-injection arm: the same path with a working
    // ledger reports NOTHING, so the error above is a real signal rather than an
    // always-on one. A test that can only fail is not a measurement.
    const ledger = new MemoryBridgeLedger()
    const bridge = new BridgeServer({ artifactDirectory: join(root, 'ledger-healthy') })
    await bridge.start()
    const lease = bridge.mintLease({
      sessionId: 'r5-ledger-healthy', cellId: 'cell-1', epoch: 1,
      outerCallId: 'outer-healthy', rootCallId: 'outer-healthy',
      ledger,
      handler: async () => ({ ok: true, value: { ok: true } }),
    })
    await lease.invoke({ requestId: 'req-1', tool: 'r5_ok', arguments: {}, cellId: 'cell-1', epoch: 1, leaseId: lease.id })
    const failure = await lease.close('completed', 'the cell settled').then(() => undefined, (error: unknown) => error)
    expect(failure).toBeUndefined()
    expect(lease.lifecycle).toBe('CLOSED')
    expect(lease.unrecordedDispositions).toHaveLength(0)
    expect(ledger.get('outer-healthy:ipython:1')?.disposition).toBe('settled')
    await bridge.close()
  }, 60_000)
})

describe('R5-J4/J5: composite semantics, idempotency, unknown outcomes', () => {
  it('additionalContexts reach the OUTER ipython execution, in subcall order', async () => {
    // A tool that attaches a policy context, so the ferry is observable on the
    // OUTER result rather than only inside the bridge.
    ctx.tools.register(defineTool({
      name: 'r5_notice',
      description: 'Attaches one additional context naming its tag.',
      parameters: { tag: { type: 'string', required: true } },
      output: {
        schema: { type: 'object', additionalProperties: false, properties: { tag: { type: 'string', required: true } } },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      execute: async (args) => ({ tag: (args as { tag: string }).tag }),
    }))
    // The listener RETURNS the decision; `next()` takes no argument. This is the
    // documented waterfall shape (`index.ts`: `next: () => Promise<PostToolDecision>`),
    // and passing the decision to `next` would be a silent no-op.
    ctx.on('tools/post-execute', (exec, result, next) => {
      if (exec.name !== 'r5_notice' || result.isError) return next()
      const tag = (exec.arguments as { tag: string }).tag
      return Promise.resolve({
        kind: 'accept',
        additionalContexts: [{
          id: `notice-${tag}`,
          role: 'user',
          content: [{ type: 'text', text: `notice:${tag}` }],
          source: { kind: 'plugin', plugin: 'r5-test' },
        }],
      } as never)
    })

    const agent = agentFor('r5-context')
    const cell = await callIpython(agent, [
      'for tag in ("one", "two", "three"):',
      "    await dsh.call('r5_notice', {'tag': tag})",
      "print('DONE=True')",
    ].join('\n'))
    expect(cell.outcome).toBe('ok')

    // THE OUTER RESULT carries the nested contexts, in SUBCALL order. This is the
    // V3 §J4 requirement: `result.additionalContexts` -> `outerExec.deferContext`.
    const outer = cell.result
    expect(outer.isError).toBe(false)
    if (outer.isError) return
    const contexts = outer.additionalContexts ?? []
    const texts = contexts.map(entry => JSON.stringify(entry.content))
    expect(texts).toHaveLength(3)
    expect(texts[0]).toContain('notice:one')
    expect(texts[1]).toContain('notice:two')
    expect(texts[2]).toContain('notice:three')
  }, 300_000)

  it('concludesTurn reaches the outer execution', async () => {
    // The FAITHFUL stimulus: a nested tool whose own body calls
    // `exec.concludeTurn()`. The registry then marks ITS result `concludesTurn`,
    // and the bridge must ferry that marker onto the OUTER `ipython` result. A
    // hand-authored `concludesTurn` on a post-execute decision would not exercise
    // the ferry, because only a SUCCESSFUL nested result can carry the marker
    // (`ToolExecutionFailure` types it `never`) -- and that rule is the reason the
    // marker is a real signal rather than a free-form flag.
    ctx.tools.register(defineTool({
      name: 'r5_conclude',
      description: 'Succeeds and asks to conclude the turn from inside its own body.',
      parameters: {},
      output: {
        schema: { type: 'object', additionalProperties: false, properties: { done: { type: 'boolean', required: true } } },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      execute: async (_args, exec) => {
        exec.concludeTurn()
        return { done: true }
      },
    }))

    const agent = agentFor('r5-conclude')
    const cell = await callIpython(agent, "await dsh.call('r5_conclude', {})\nprint('DONE=True')")
    expect(cell.outcome).toBe('ok')
    // The nested call really concluded its own turn.
    expect(results.filter(entry => entry.startsWith('r5_conclude:'))).toHaveLength(1)
    const outer = cell.result
    if (outer.isError) throw new Error('the outer call failed')
    // And the marker rode the OUTER result, which is the ferry under test.
    expect(outer.concludesTurn).toBe(true)
  }, 300_000)

  it('an oversized exact result arrives as a REFERENCE with paging helpers, not truncated', async () => {
    const big = 'x'.repeat(300_000)
    ctx.tools.register(defineTool({
      name: 'r5_big',
      description: 'Returns a canonical value far above the inline bound.',
      parameters: {},
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: { blob: { type: 'string', required: true }, bytes: { type: 'integer', required: true } },
        },
        render: (_args, value) => [{ type: 'text', text: `bytes: ${String((value as { bytes: number }).bytes)}` }],
      },
      execute: async () => ({ blob: big, bytes: big.length }),
    }))

    const agent = agentFor('r5-big')
    const cell = await callIpython(agent, [
      "value = await dsh.call('r5_big', {})",
      "print('TYPE=' + type(value).__name__)",
      "print('IS_ARTIFACT=' + str(type(value).__name__ == 'Artifact'))",
      'print(\'VERIFY=\' + str(value.verify()))',
      'print(\'LEN=\' + str(len(value.json()["blob"])))',
      "print('BYTES=' + str(value.bytes))",
    ].join('\n'))

    expect(cell.outcome).toBe('ok')
    // NO SILENT TRUNCATION: the delivered value is a reference whose bytes verify,
    // and Python can read the WHOLE payload back.
    expect(printed(cell.text, 'TYPE')).toBe('Artifact')
    expect(printed(cell.text, 'VERIFY')).toBe('True')
    expect(printed(cell.text, 'LEN')).toBe('300000')
    // And the ledger carries the REF, never the unbounded content.
    const rows = service?.ledgerFor(agent)?.forOuterCall(cell.callId) ?? []
    expect(rows[0]?.artifactRef).toBeTruthy()
    expect(rows[0]?.resultBytes).toBeGreaterThan(4096)
  }, 300_000)

  it('the same request id with the same args joins the first result; with changed args it CONFLICTS', async () => {
    // Driven at the lease boundary, because the Python client mints a fresh
    // request id per call by design -- so this is a protocol-level property that
    // only a hand-made frame can exercise, and the harness must speak the wire
    // shape the client speaks.
    let executions = 0
    ctx.tools.register(defineTool({
      name: 'r5_idem',
      description: 'Counts its own executions, so a duplicate dispatch would be visible.',
      parameters: { tag: { type: 'string', required: true } },
      output: {
        schema: { type: 'object', additionalProperties: false, properties: { tag: { type: 'string', required: true } } },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      execute: async (args) => { executions += 1; return { tag: (args as { tag: string }).tag } },
    }))

    const agent = agentFor('r5-idem')
    // A cell that makes one call, so a real lease exists with a real ledger row.
    const cell = await callIpython(agent, "await dsh.call('r5_idem', {'tag': 'first'})\nprint('DONE=True')")
    expect(cell.outcome).toBe('ok')
    expect(executions).toBe(1)

    // The lease is closed now (the cell settled), so a second frame is refused
    // CELL_LEASE_EXPIRED -- which is itself one of the required arms.
    const bridge = service?.bridgeFor(agent)
    expect(bridge).toBeDefined()
    const ledgerRows = service?.ledgerFor(agent)?.all() ?? []
    expect(ledgerRows).toHaveLength(1)
    expect(ledgerRows[0]?.disposition).toBe('settled')

    // A second cell mints a NEW lease; the old lease id is no longer live.
    const second = await callIpython(agent, "await dsh.call('r5_idem', {'tag': 'second'})\nprint('DONE=True')")
    expect(second.outcome).toBe('ok')
    expect(executions).toBe(2)
    // Two outer calls, two rows, both settled -- one row per exact call, never
    // one row shared or one call recorded twice.
    const all = service?.ledgerFor(agent)?.all() ?? []
    expect(all).toHaveLength(2)
    expect(all.every(row => row.disposition === 'settled')).toBe(true)
    expect(new Set(all.map(row => row.subCallId)).size).toBe(2)
  }, 300_000)

  it('an expired lease gets a stable CELL_LEASE_EXPIRED from the live bridge', async () => {
    const agent = agentFor('r5-expired')
    await callIpython(agent, "print('FIRST=True')")
    const bridge = service?.bridgeFor(agent)
    expect(bridge).toBeDefined()
    // The lease from the first cell was closed when the cell settled, and it is
    // no longer in the server's table -- so a callback naming it is refused as an
    // unknown capability, which is the CELL_LEASE_EXPIRED family's stable answer.
    expect(bridge?.server.openLeases()).toHaveLength(0)
  }, 300_000)
})

describe('R5-J8: the assembled test cannot pass without the product wiring', () => {
  it('a real cell cannot forge authority: a frame naming agent is REFUSED, and kwargs are only arguments', async () => {
    // TWO DIFFERENT THINGS, MEASURED SEPARATELY, because an earlier version of
    // this test conflated them and asserted a falsehood:
    //
    //   (a) `dsh.call('t', {}, agent='x')` merges the kwarg into the tool's
    //       ARGUMENTS. It is not a forgery attempt at all -- it is an argument
    //       named `agent`, and the tool's own schema is what would reject it.
    //   (b) A FORGERY is a top-level `agent` field on the wire FRAME, which is
    //       what `bridge.ts`'s `FORBIDDEN_FIELDS` check refuses before any lease
    //       lookup. Python can only send that by bypassing the client, so the
    //       test bypasses it too -- from INSIDE a real cell, using the real
    //       lease id and token the host handed that cell.
    //
    // (b) is the oracle's clause. Driving it from a real cell matters: a
    // hand-made frame sent by the test harness would prove the validator works
    // against the harness, not against the product's own kernel.
    ctx.tools.register(defineTool({
      name: 'r5_who',
      description: 'Reports nothing about identity; the assertion is registry-side.',
      parameters: {},
      output: {
        schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean', required: true } } },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      execute: async () => ({ ok: true }),
    }))

    const agent = agentFor('r5-authority')
    let seenAgent: unknown
    let seenArguments: unknown
    ctx.on('tools/pre-execute', (exec, next) => {
      if (exec.name === 'r5_who') {
        seenAgent = exec.agent
        seenArguments = exec.arguments
      }
      return next()
    })

    const cell = await callIpython(agent, [
      'import json, socket, struct',
      'chan = dsh._channel',
      'sock = socket.create_connection(("127.0.0.1", chan._port), timeout=30.0)',
      'hello = json.dumps({"type": "hello", "protocol": 1, "token": chan._token}).encode()',
      'sock.sendall(struct.pack(">I", len(hello)) + hello)',
      'head = sock.recv(4)',
      'size = struct.unpack(">I", head)[0]',
      'body = b""',
      'while len(body) < size:',
      '    body += sock.recv(size - len(body))',
      "print('HANDSHAKE=' + str(json.loads(body.decode()).get('ok')))",
      '# THE FORGERY: a top-level agent field, which the client never sends.',
      'forged = json.dumps({',
      '    "type": "call", "requestId": "forge-1", "tool": "r5_who", "arguments": {},',
      '    "leaseId": chan._lease, "cellId": chan._cell, "epoch": chan._epoch,',
      '    "agent": "someone-else",',
      '}).encode()',
      'sock.sendall(struct.pack(">I", len(forged)) + forged)',
      'head = sock.recv(4)',
      'size = struct.unpack(">I", head)[0]',
      'body = b""',
      'while len(body) < size:',
      '    body += sock.recv(size - len(body))',
      'reply = json.loads(body.decode())',
      "print('FORGED_OK=' + str(reply.get('ok')))",
      "print('FORGED_CODE=' + str((reply.get('error') or {}).get('code')))",
      'sock.close()',
      '# AND THE CONTRAST: the same call through the client is served.',
      "await dsh.call('r5_who', {})",
      "print('LEGIT=DONE')",
      '# (a): a kwarg named agent is an ARGUMENT, not authority.',
      "await dsh.call('r5_who', agent='someone-else')",
      "print('KWARG=DONE')",
    ].join('\n'))

    expect(cell.outcome).toBe('ok')
    // The cell really reached the bridge, so the forgery below is not refused
    // merely because the connection was never valid.
    expect(printed(cell.text, 'HANDSHAKE')).toBe('True')
    // THE ORACLE: the forged frame is REFUSED, by code, before any dispatch.
    expect(printed(cell.text, 'FORGED_OK')).toBe('False')
    expect(printed(cell.text, 'FORGED_CODE')).toBe('FORGED_AUTHORITY')
    expect(printed(cell.text, 'LEGIT')).toBe('DONE')
    // Only the two legitimate calls reached the registry: the forged frame did
    // not, which is the difference between "refused" and "refused politely".
    expect(dispatches.filter(entry => entry.name === 'r5_who')).toHaveLength(2)
    // And the authority the registry saw is the OUTER execution's own Agent,
    // never anything the cell could name.
    expect(seenAgent).toBe(agent)
    // (a), recorded rather than asserted away: the kwarg arrived as an argument.
    expect(seenArguments).toEqual({ agent: 'someone-else' })
  }, 300_000)
})
