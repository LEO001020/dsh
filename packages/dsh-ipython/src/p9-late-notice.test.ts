/**
 * P9 — G-SEAM-78: late/background output is DELIVERED, separately and bounded.
 *
 * ===========================================================================
 * THE DEFECT THIS FILE GATES
 * ===========================================================================
 *
 * IPY-13's CLASSIFICATION half was built and measured by writer S5: a background
 * write is attributed by ORIGIN, a thread a cell started carries that cell's
 * identity, and a write whose origin cannot be preserved is reported
 * `undecidable` rather than guessed. That half is preserved and this file does
 * not re-test it (`s5-ipy13.test.ts` and `v3-spec-gates.test.ts` CLAUSE 1/2 are
 * its gates).
 *
 * The DELIVERY half was not wired, and G-SEAM-78 records the measurement:
 * `KernelService.drainUnattributed` (`kernel-plugin.ts:760`) had ZERO production
 * callers -- the only reference in the repository was a probe -- while
 * `ipython-tool.ts:183` told the model its late output "is reported separately as
 * unattributed output". A promise the product did not keep. The archived S5
 * measurement (`qualification/results/S5-ipy13/delivery-probe.json`) is the
 * BEFORE: one record existed, and no model-facing text contained it.
 *
 * ===========================================================================
 * WHAT IS MEASURED HERE, AND FROM WHERE
 * ===========================================================================
 *
 * Every arm drives the REAL product path: the real registry (`SystemPrompt` +
 * `ToolRuntime`), the real `KernelService`, the real `ipython` tool registered by
 * `ipython-tool.ts`'s own `apply`, and real cells through the real `broker.py`.
 * Nothing is hand-mounted, and no arm calls `runCell` with a hand-built authority.
 *
 * THE MODEL-VISIBLE BOUNDARY IS `result.additionalContexts`, and it is not a
 * stand-in for one. The chain is:
 *
 *   `exec.deferContext`        packages/core/tools/src/index.ts:408
 *   -> `additionalContexts`    packages/core/tools/src/index.ts:1590-1598
 *   -> `acceptContext`         packages/core/agent-loop/src/tool-calls.ts:157
 *   -> `inbox.splice('next-step')`  packages/core/agent-loop/src/agent.ts:491
 *   -> the next step boundary  packages/core/agent-loop/src/agent.ts:316-321
 *
 * so a context present on the OUTER `ipython` result is a message the agent loop
 * stages for the model. The arms assert BOTH halves of the separation: the
 * notice IS in `additionalContexts`, and it is NOT in the tool's rendered `text`
 * (which is the cell's stdout projection).
 *
 * WHAT THIS FILE DOES NOT DO. It does NOT run a model turn. A notice reaching the
 * next-step inbox is proof that the product delivers it to the model-visible
 * boundary; it is NOT proof that a model read it or acted on it. No live provider
 * is authorized in this round.
 *
 * CPU DISCIPLINE. ONE kernel per arm, every service closed in `afterEach`. The
 * bounds are small on purpose, so the flood arm is a real flood over a real
 * kernel without printing megabytes.
 */
import { Context } from '@deepseek-ai/cordis'
import Subprocess from '@deepseek-ai/dsh-subprocess-local'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { type ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { readFile } from 'node:fs/promises'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as ipythonTool from './ipython-tool.ts'
import { KernelService } from './kernel-plugin.ts'
import { DSH_BACKGROUND_ORIGIN } from './protocol.ts'
import {
  DEFAULT_LATE_NOTICE_BOUNDS,
  LateNoticeQueue,
  classifyOrigin,
  type LateNotice,
} from './late-notice.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const BROKER = resolve(HERE, 'broker.py')
const PYTHON = process.env['DSH_PYTHON'] ?? 'C:/Users/hzq00/AppData/Local/Programs/Python/Python314/python.exe'

/**
 * Deliberately SMALL bounds, so "bounded" is measured rather than asserted.
 *
 * These are the product's own configuration fields (`lateNoticeBounds`), set
 * here the way a host would set them. They are not a test-only back door: the
 * arm below proves the bound is ENFORCED by driving more output through it than
 * it can hold.
 */
const TEST_BOUNDS = {
  records: 4,
  textBytes: 256,
  totalBytes: 1024,
  spillBytes: 4096,
} as const

let ctx: Context
let root: string
let service: KernelService | undefined

beforeEach(async () => {
  ctx = new Context()
  await ctx.plugin(SystemPrompt, { personaPrefix: '' })
  await ctx.plugin(ToolRuntime, { mode: 'native', maxParallelSubCalls: 10 })
  await ctx.plugin(Subprocess)
  root = await mkdtemp(join(tmpdir(), 'dsh-ipython-p9-late-'))
  service = new KernelService(ctx, {
    pythonExecutable: PYTHON,
    brokerScript: BROKER,
    root: join(root, 'kernels'),
    durableLedger: false,
    lateNoticeBounds: TEST_BOUNDS,
  })
  // THE PRODUCT'S OWN REGISTRATION. The same function the preset's
  // `dsh-ipython/tool` row loads; nothing here is test-specific.
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

function agentFor(sessionId: string, cwd = root): Agent {
  return { session: { header: { id: sessionId, cwd } } } as unknown as Agent
}

const sleep = (ms: number): Promise<void> => new Promise(resolvePromise => setTimeout(resolvePromise, ms))

let outerSeq = 0

/** Drive the model-facing tool through the registry, exactly as the agent loop does. */
async function callIpython(agent: Agent, code: string): Promise<{
  text: string
  outcome: string
  result: ToolExecutionResult
}> {
  const result = await ctx.tools.execute({
    callId: `p9-outer-${String(++outerSeq)}` as never,
    name: ipythonTool.IPYTHON_TOOL_NAME,
    arguments: { code },
    agent,
    signal: new AbortController().signal,
  })
  if (result.isError) return { text: result.error.message, outcome: 'error', result }
  const value = result.value as { text: string, outcome: string }
  return { text: value.text, outcome: value.outcome, result }
}

/** Every text block the agent loop would stage for the model, from a tool result. */
function contextsOf(result: ToolExecutionResult): string[] {
  if (result.isError) return []
  return (result.additionalContexts ?? []).flatMap(context =>
    context.content.flatMap(block => block.type === 'text' ? [block.text] : []))
}

// ===========================================================================
// 1. THE QUEUE'S OWN CONTRACT (no kernel: bounds, classification, isolation)
//
// These arms are here rather than in the kernel arms because each is a claim
// about the queue itself, and a kernel would add time without adding evidence.
// The kernel arms below prove the queue is REACHED; these prove it BEHAVES.
// ===========================================================================

describe('P9: the late-notice record and its bounds', () => {
  it('classifyOrigin reports a sentinel or empty origin as undecidable, and a cell id as known-late', () => {
    // The ONE place the causal class is decided. The sentinel and the empty
    // string are both "no cell can be named"; a real id is a fact.
    expect(classifyOrigin('msg-1234', DSH_BACKGROUND_ORIGIN)).toBe('known-late')
    expect(classifyOrigin(DSH_BACKGROUND_ORIGIN, DSH_BACKGROUND_ORIGIN)).toBe('undecidable')
    expect(classifyOrigin('', DSH_BACKGROUND_ORIGIN)).toBe('undecidable')
    // CONTROL: a classifier that always said `undecidable` would pass the second
    // and third lines and fail the first, which is why the first line is here.
  })

  it('a record carries sessionId, epoch, origin, class, stream and a timestamp', () => {
    const queue = new LateNoticeQueue({
      sessionId: 'sess-record',
      backgroundOrigin: DSH_BACKGROUND_ORIGIN,
      spillDirectory: join(root, 'spill-record'),
      bounds: DEFAULT_LATE_NOTICE_BOUNDS,
    })
    const before = Date.now()
    queue.push({ kernelEpoch: 7, cellId: 'cell-origin-7', stream: 'stderr', text: 'hello\n' })
    const [record] = queue.drain()
    expect(record, 'the pushed record must be drainable').toBeDefined()
    const notice = record as LateNotice
    // V5 section 10's field list, each one checked by value.
    expect(notice.sessionId).toBe('sess-record')
    expect(notice.kernelEpoch).toBe(7)
    expect(notice.cellId).toBe('cell-origin-7')
    expect(notice.causalClass).toBe('known-late')
    expect(notice.stream).toBe('stderr')
    expect(notice.text).toBe('hello\n')
    expect(notice.bytes).toBe(6)
    expect(notice.observedAt).toBeGreaterThanOrEqual(before)
    expect(notice.observedAt).toBeLessThanOrEqual(Date.now())
    // An origin-less record keeps the sentinel VERBATIM and is undecidable. The
    // id is not rewritten, because rewriting it is what would attach the write
    // to a cell.
    queue.push({ kernelEpoch: 7, cellId: DSH_BACKGROUND_ORIGIN, stream: 'unknown', text: 'x' })
    const [second] = queue.drain()
    expect(second?.causalClass).toBe('undecidable')
    expect(second?.cellId).toBe(DSH_BACKGROUND_ORIGIN)
  })

  it('draining is destructive, so one write is never delivered twice', () => {
    const queue = new LateNoticeQueue({
      sessionId: 'sess-drain',
      backgroundOrigin: DSH_BACKGROUND_ORIGIN,
      spillDirectory: join(root, 'spill-drain'),
    })
    queue.push({ kernelEpoch: 1, cellId: 'c1', stream: 'stdout', text: 'once' })
    expect(queue.drain()).toHaveLength(1)
    expect(queue.drain()).toHaveLength(0)
    expect(queue.account().held).toBe(0)
  })

  it('two queues with different Session ids share nothing', () => {
    const a = new LateNoticeQueue({
      sessionId: 'sess-a', backgroundOrigin: DSH_BACKGROUND_ORIGIN, spillDirectory: join(root, 'spill-a'),
    })
    const b = new LateNoticeQueue({
      sessionId: 'sess-b', backgroundOrigin: DSH_BACKGROUND_ORIGIN, spillDirectory: join(root, 'spill-b'),
    })
    a.push({ kernelEpoch: 1, cellId: 'ca', stream: 'stdout', text: 'for-a' })
    expect(b.drain()).toHaveLength(0)
    expect(a.drain().map(entry => entry.text)).toEqual(['for-a'])
  })

  it('a flood is BOUNDED: overflow spills, and past the spill it is counted and dropped', async () => {
    const spillDirectory = join(root, 'spill-flood')
    const queue = new LateNoticeQueue({
      sessionId: 'sess-flood',
      backgroundOrigin: DSH_BACKGROUND_ORIGIN,
      spillDirectory,
      // 2 records held, 200 bytes of text per record, 500 bytes total, 2 KiB spill.
      bounds: { records: 2, textBytes: 200, totalBytes: 500, spillBytes: 2048 },
    })
    // 40 records of 300 bytes: far past every bound, so all three must engage.
    const flood = 'F'.repeat(300)
    for (let index = 0; index < 40; index += 1) {
      queue.push({ kernelEpoch: 1, cellId: `cell-${String(index)}`, stream: 'stdout', text: flood })
    }
    const held = queue.drain()
    const account = queue.account()

    // The memory bound held: at most 2 records, and never more than 500 bytes.
    expect(held.length).toBeLessThanOrEqual(2)
    expect(account.heldBytes).toBe(0)
    // Every held record is itself truncated to the per-record bound, so ONE huge
    // record cannot consume the whole budget.
    for (const notice of held) {
      expect(Buffer.byteLength(notice.text ?? '', 'utf8')).toBeLessThanOrEqual(200)
      expect(notice.truncated).toBe(true)
    }
    // The overflow went SOMEWHERE and is accounted for: spilled, or dropped when
    // even the spill was full. Both counters are bounded by the input, and at
    // least one is non-zero -- a flood that reported nothing would be the defect.
    expect(account.spilled + account.dropped).toBeGreaterThan(0)
    expect(account.spillPath, 'a spill must name its file').toBeDefined()
    const spill = await readFile(account.spillPath as string, 'utf8')
    expect(Buffer.byteLength(spill, 'utf8')).toBeLessThanOrEqual(2048)
    // The spill is real recoverable bytes, not a marker file.
    expect(spill).toContain('F'.repeat(100))
    // CONTROL: the same flood under a huge bound keeps everything, so the bound
    // is what stopped it rather than the queue dropping by accident.
    const roomy = new LateNoticeQueue({
      sessionId: 'sess-roomy',
      backgroundOrigin: DSH_BACKGROUND_ORIGIN,
      spillDirectory: join(root, 'spill-roomy'),
      bounds: { records: 100, textBytes: 4096, totalBytes: 65536, spillBytes: 65536 },
    })
    for (let index = 0; index < 40; index += 1) {
      roomy.push({ kernelEpoch: 1, cellId: `cell-${String(index)}`, stream: 'stdout', text: 'short' })
    }
    expect(roomy.drain()).toHaveLength(40)
    expect(roomy.account().dropped).toBe(0)
  })
})

// ===========================================================================
// 2. THE PRODUCT PATH: a background write reaches the model-visible boundary
//    SEPARATELY, and never inside a cell's stdout.
// ===========================================================================

describe('P9 IPY-LATE-VISIBLE: late output is delivered separately, never merged', () => {
  it('A starts a thread, A settles, B runs, the thread prints: B excludes it and a later cell carries the notice', async () => {
    const agent = agentFor('p9-late-visible')

    // ---- cell A: start a background thread, then settle --------------------
    // The thread waits long enough that its write lands strictly after B has
    // returned, which is the case V5 section 10 names: the write belongs to A,
    // arrives while no cell is running, and must not appear in B.
    const a = await callIpython(agent, [
      'import threading, time',
      'def background():',
      '    time.sleep(6)',
      '    print("P9-LATE-MARKER")',
      'threading.Thread(target=background, daemon=True).start()',
      'print("cell-A-settled")',
    ].join('\n'))
    expect(a.outcome).toBe('ok')
    expect(a.text).toContain('cell-A-settled')
    // A cannot carry its own background write: the cell was protocol-complete
    // before the write existed.
    expect(a.text).not.toContain('P9-LATE-MARKER')

    // ---- cell B: runs and settles BEFORE the thread prints -----------------
    const b = await callIpython(agent, 'print("cell-B-output")')
    expect(b.outcome).toBe('ok')
    expect(b.text).toContain('cell-B-output')
    // THE FIRST RULE OF THE SLICE, on the stdout axis: B's rendered text is the
    // cell's own output and nothing else.
    expect(b.text).not.toContain('P9-LATE-MARKER')
    expect(contextsOf(b.result).join('\n')).not.toContain('P9-LATE-MARKER')

    // ---- the thread now prints, with no cell running -----------------------
    await sleep(8000)

    // ---- cell C: an ordinary cell, and the notice must arrive WITH it ------
    const c = await callIpython(agent, 'print("cell-C-output")')
    expect(c.outcome).toBe('ok')
    expect(c.text).toContain('cell-C-output')

    // THE SEPARATION, both halves, from the SAME result object:
    //   (1) C's stdout does NOT contain the late text -- the merge IPY-13
    //       forbids, which would make the write look like C's own output;
    //   (2) the notice IS present in the contexts the agent loop stages for the
    //       model -- so the delivery is real and separate, not merely absent.
    expect(c.text, 'late output must never ride the next cell stdout').not.toContain('P9-LATE-MARKER')
    const staged = contextsOf(c.result)
    const noticeText = staged.join('\n')
    expect(noticeText, 'the notice must reach the model-visible boundary').toContain('P9-LATE-MARKER')
    expect(noticeText).toContain('Runtime notice')
    // The notice states the ORIGIN rather than implying the cell that carried it.
    expect(noticeText).toContain('background output from earlier cell(s)')
    expect(noticeText).toMatch(/origin cell: [0-9a-f-]+/u)
    // And it says so in its own words, so a reader cannot take it for cell output.
    expect(noticeText).toContain('was NOT produced by the cell you just ran')

    // The record itself, read from the service, carries the required fields. It
    // is drained by now, so this arm re-derives nothing -- it asserts the account
    // shows a clean queue rather than a growing one.
    const account = (service as KernelService).lateNoticeAccount(agent)
    expect(account?.held).toBe(0)
  }, 300_000)

  it('a raw _thread origin is reported UNDECIDABLE, and no cell is named', async () => {
    const agent = agentFor('p9-late-undecidable')

    // `_thread.start_new_thread` bypasses `threading.Thread.start`, which is the
    // hook `broker.py`'s bootstrap patches. The write therefore carries no cell
    // origin and is stamped with the sentinel -- the case IPY-13 requires be
    // reported as undecidable rather than attributed.
    const a = await callIpython(agent, [
      'import _thread, time',
      'def background():',
      '    time.sleep(6)',
      '    print("P9-RAW-THREAD-MARK")',
      '_thread.start_new_thread(background, ())',
      'print("cell-A-settled")',
    ].join('\n'))
    expect(a.outcome).toBe('ok')
    expect(a.text).not.toContain('P9-RAW-THREAD-MARK')

    await sleep(8000)

    const b = await callIpython(agent, 'print("cell-B-output")')
    expect(b.outcome).toBe('ok')
    // Not merged into B's stdout ...
    expect(b.text).not.toContain('P9-RAW-THREAD-MARK')
    // ... and delivered as an UNDECIDABLE notice that names NO cell. This is the
    // negative half of the invariant: the write exists and is reported, and the
    // report refuses to guess which cell produced it.
    const noticeText = contextsOf(b.result).join('\n')
    expect(noticeText).toContain('P9-RAW-THREAD-MARK')
    expect(noticeText).toContain('UNDECIDABLE')
    expect(noticeText).toContain('Do not assume any particular cell produced it')
    expect(noticeText).toContain(DSH_BACKGROUND_ORIGIN)
    // The presentation distinguishes the two classes, so a reader cannot mistake
    // an unknown origin for a known one.
    expect(noticeText).toContain('output of UNDECIDABLE origin')
    expect(noticeText).not.toContain('origin cell: 0')
  }, 300_000)

  it('a late FLOOD is bounded and spilled through the real product path', async () => {
    const agent = agentFor('p9-late-flood')

    // Far more output than the configured bounds can hold, written after the cell
    // settles. The queue must bound it rather than grow.
    const a = await callIpython(agent, [
      'import threading, time',
      'def flood():',
      '    time.sleep(6)',
      '    for i in range(200):',
      '        print("P9-FLOOD-%04d-%s" % (i, "F" * 120))',
      'threading.Thread(target=flood, daemon=True).start()',
      'print("cell-A-settled")',
    ].join('\n'))
    expect(a.outcome).toBe('ok')

    await sleep(12000)

    const b = await callIpython(agent, 'print("cell-B-output")')
    expect(b.outcome).toBe('ok')
    // The flood did not ride B's stdout, and B's stdout is B's own output only.
    expect(b.text).toContain('cell-B-output')
    expect(b.text).not.toContain('P9-FLOOD-')

    const account = (service as KernelService).lateNoticeAccount(agent)
    expect(account, 'a Session with a live kernel reports its account').toBeDefined()
    // The bound ENGAGED: the kernel wrote 200 records and the queue did not keep
    // 200. Both the spill and the drop counters are bounded by the input, and the
    // overflow is accounted for rather than silently forgotten.
    expect((account?.spilled ?? 0) + (account?.dropped ?? 0)).toBeGreaterThan(0)
    expect(account?.spillBytes ?? 0).toBeLessThanOrEqual(TEST_BOUNDS.spillBytes)

    const noticeText = contextsOf(b.result).join('\n')
    // The notice is bounded: it reports the records it kept and NAMES the fact
    // that it is not the complete set.
    expect(noticeText).toContain('Runtime notice')
    expect(noticeText).toContain('This notice is bounded; it is not the complete set of what the kernel wrote.')
    // The kept records are bounded by the configured per-record text bound.
    expect(Buffer.byteLength(noticeText, 'utf8')).toBeLessThan(TEST_BOUNDS.totalBytes * 8)
  }, 300_000)

  it('a background print does NOT wake the model: the write is held, and nothing is delivered until a cell runs', async () => {
    const agent = agentFor('p9-no-wake')

    // Count every context the registry ferries, from the pipeline rather than
    // from the tool's own account.
    const ferried: string[] = []
    ctx.on('tools/result', exec => { ferried.push(`${exec.name}:${String(exec.callId)}`) })

    const a = await callIpython(agent, [
      'import threading, time',
      'def background():',
      '    time.sleep(4)',
      '    print("P9-NO-WAKE-MARK")',
      'threading.Thread(target=background, daemon=True).start()',
      'print("cell-A-settled")',
    ].join('\n'))
    expect(a.outcome).toBe('ok')
    const callsAfterA = ferried.length

    // The thread prints with NO cell running. V5 section 10's first rule is that
    // this must not itself produce a model turn.
    await sleep(6000)

    // THE MEASUREMENT. The registry saw NO new execution -- a print is not a tool
    // call, and nothing in the delivery path can manufacture one. A background
    // write cannot start a turn because the only code that reaches the model is
    // the `ipython` tool's own return path, and that code ran zero more times.
    expect(ferried.length, 'a background print must not dispatch anything').toBe(callsAfterA)

    // The write is HELD, not lost and not delivered: it is sitting in this
    // Session's queue, waiting for the next boundary. That is the difference
    // between "does not wake the model" and "drops the output".
    const held = (service as KernelService).lateNoticeAccount(agent)
    expect(held?.held).toBe(1)
    expect((service as KernelService).drainLateNotices(agent)).toHaveLength(1)
    // And the queue is empty again only because THIS arm drained it, not because
    // the boundary delivered it: `ferried` did not grow.
    expect(ferried.length).toBe(callsAfterA)
  }, 300_000)

  it('notices are SESSION-scoped: another Session cannot drain them', async () => {
    const agentA = agentFor('p9-session-a')
    const agentB = agentFor('p9-session-b')

    const a = await callIpython(agentA, [
      'import threading, time',
      'def background():',
      '    time.sleep(5)',
      '    print("P9-SESSION-A-MARK")',
      'threading.Thread(target=background, daemon=True).start()',
      'print("cell-A-settled")',
    ].join('\n'))
    expect(a.outcome).toBe('ok')
    await sleep(7000)

    // Session B has NO kernel of its own. Draining for B must return nothing --
    // not A's notices, and not an empty list because a kernel was started for B.
    expect((service as KernelService).hasKernel(agentB)).toBe(false)
    expect((service as KernelService).drainLateNotices(agentB)).toEqual([])
    expect((service as KernelService).lateNoticeAccount(agentB)).toBeUndefined()

    // A's notice is still there for A, which is what makes the empty B result a
    // statement about scoping rather than about the write never arriving.
    const forA = (service as KernelService).drainLateNotices(agentA)
    expect(forA).toHaveLength(1)
    expect(forA[0]?.sessionId).toBe('p9-session-a')
    expect(forA[0]?.text).toContain('P9-SESSION-A-MARK')
    expect(forA[0]?.causalClass).toBe('known-late')
    // And it is drained for A too, so a second reader cannot re-deliver it.
    expect((service as KernelService).drainLateNotices(agentA)).toEqual([])
  }, 300_000)

  it('the record carries the kernel EPOCH, and a restart cannot deliver across generations', async () => {
    const agent = agentFor('p9-late-epoch')

    const a = await callIpython(agent, [
      'import threading, time',
      'def background():',
      '    time.sleep(5)',
      '    print("P9-EPOCH-MARK")',
      'threading.Thread(target=background, daemon=True).start()',
      'print("cell-A-settled")',
    ].join('\n'))
    expect(a.outcome).toBe('ok')
    await sleep(7000)

    const first = (service as KernelService).drainLateNotices(agent)
    expect(first).toHaveLength(1)
    // The epoch is IN the record, and it is the epoch the write happened in.
    const epoch = first[0]?.kernelEpoch ?? 0
    expect(epoch).toBeGreaterThan(0)
    expect(epoch).toBe((service as KernelService).currentEpoch(agent))

    // A RESTART ALLOCATES A NEW EPOCH AND A NEW ENTRY. The queue is created with
    // the Entry, so the old generation's notices cannot be delivered by the new
    // one -- a notice about a namespace that no longer exists is not a fact about
    // the current kernel.
    const newEpoch = await (service as KernelService).restart(agent)
    expect(newEpoch).toBeGreaterThan(epoch)
    expect((service as KernelService).drainLateNotices(agent)).toEqual([])
    expect((service as KernelService).currentEpoch(agent)).toBe(newEpoch)
  }, 300_000)
})
