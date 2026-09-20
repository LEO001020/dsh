/**
 * P8 — IPY-MAGIC-BIND / IPY-SOURCE-IDENTITY (V5 §9, §18).
 *
 * THE DEFECT THESE ARMS EXIST TO CATCH. `runCell` used to prepend a Python
 * bootstrap to the model's cell:
 *
 *     const dispatched = canPrependPreamble(code)
 *       ? [entry.bridge.server.preamble(lease), code].join('\n')
 *       : code
 *
 * Four measured consequences, all of them reproduced in
 * `qualification/results/P8-bind/before.json` on a real ipykernel:
 *
 *   1. THE EXECUTED BYTES WERE NOT THE AUTHORED BYTES. IPython's own record of
 *      the cell (`history_manager.input_hist_raw[-1]`) was the preamble plus the
 *      user's source: `f83a15f9…` submitted, `d2f187b5…` recorded.
 *   2. TRACEBACK AND SYNTAXERROR LINE NUMBERS SHIFTED. A raise on user line 3
 *      reported line 15, and so did a SyntaxError on user line 3.
 *   3. A CELL MAGIC TOOK A DIFFERENT PATH AND GOT NO FRESH BINDING.
 *      `canPrependPreamble` returns false for `%%`, so those cells ran with
 *      whatever `dsh` a previous cell had left behind. Measured inside a
 *      `%%capture` cell: `dsh_in_dir: true`, and a call through it returned
 *      `LEASE_UNKNOWN` -- a dead capability, not an absent one.
 *   4. A STALE `dsh` SURVIVED IN THE PERSISTENT NAMESPACE. The old comment claimed
 *      an authority-less cell has `dsh` "simply absent"; measured, it was present
 *      with a settled lease id.
 *
 * THE FIX THESE ARMS MEASURE. The bind is now its own HIDDEN control request
 * (`silent`, `store_history=false`), awaited to its own `execute_reply` AND its
 * own `idle`, and the user's cell travels as its own request carrying exactly the
 * bytes the caller passed. A cell with no authority gets an explicit REVOKE
 * instead of merely no bind.
 *
 * THE INVARIANT ASSERTED, in V5 §9's own words:
 *
 *     model-authored code bytes == user execute_request code bytes
 *
 * HOW THE OBSERVATION IS TAKEN, AND WHY IT IS NOT SELF-REPORTING. The recorded
 * source is read back from IPython's own `history_manager`, which IPython fills
 * from the `execute_request`'s `code` field (`interactiveshell.py:3407-3411`
 * calls `store_inputs(execution_count, cell, raw_cell)`). So the comparison is
 * between the bytes the model submitted and the bytes the KERNEL received -- not
 * the host's account of what it sent, and not what the bridge says about itself.
 *
 * WHAT IS REAL HERE. A real ipykernel through the real `broker.py`, a real
 * `ToolRuntime`, and real cells driven through the REAL model-facing `ipython`
 * tool via `ctx.tools.execute` -- the same registration the profile's preset row
 * loads. Nothing in this file constructs a `BridgeServer` or calls `mintLease`.
 *
 * THE INSTRUMENT IS NEGATIVE-CAPABLE. Every arm below was run against the PRE-FIX
 * tree first and failed there; the before/after pair is archived. The mutation
 * test that shows this file can go red is in the report, and one arm
 * (`SOURCE IDENTITY: the recorded source is the model's own bytes`) is the exact
 * assertion that was false before the change.
 */
import { Context } from '@deepseek-ai/cordis'
import Subprocess from '@deepseek-ai/dsh-subprocess-local'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as ipythonTool from './ipython-tool.ts'
import { KernelService } from './kernel-plugin.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const BROKER = resolve(HERE, 'broker.py')
const PYTHON = process.env['DSH_PYTHON'] ?? 'C:/Users/hzq00/AppData/Local/Programs/Python/Python314/python.exe'

let ctx: Context
let root: string
let service: KernelService | undefined
/** What the registry itself saw, so no claim rests on the bridge's own account. */
let dispatches: Array<{ name: string, callId: string }> = []

beforeEach(async () => {
  ctx = new Context()
  await ctx.plugin(SystemPrompt, { personaPrefix: '' })
  await ctx.plugin(ToolRuntime, { mode: 'native', maxParallelSubCalls: 10 })
  await ctx.plugin(Subprocess)
  root = await mkdtemp(join(tmpdir(), 'dsh-ipython-p8-'))
  dispatches = []

  // The registry-side instrument: a call that reached the real pipeline is
  // distinguishable from one that never left the kernel.
  ctx.on('tools/pre-execute', (exec, next) => {
    dispatches.push({ name: exec.name, callId: String(exec.callId) })
    return next()
  })

  // The tool the bridged cells call, registered through the SAME registry the
  // model's own tools use. It echoes its tag, so a served call is distinguishable
  // from a refusal that happened to return something.
  ctx.tools.register(defineTool({
    name: 'p8_echo',
    description: 'Echoes its tag, so a served call is distinguishable from a refusal.',
    parameters: { tag: { type: 'string', required: true } },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { tag: { type: 'string', required: true } } },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    execute: async args => ({ tag: (args as { tag: string }).tag }),
  }))

  service = new KernelService(ctx, {
    pythonExecutable: PYTHON,
    brokerScript: BROKER,
    root: join(root, 'kernels'),
    durableLedger: false,
  })
  // The PRODUCT's own tool registration -- the same `apply` the preset loads.
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

let outerSeq = 0

/** Drive the real model-facing tool through the real registry, as the loop does. */
async function cell(agent: Agent, code: string): Promise<{ text: string, outcome: string, isError: boolean }> {
  outerSeq += 1
  const result = await ctx.tools.execute({
    callId: `p8-outer-${String(outerSeq)}` as never,
    name: ipythonTool.IPYTHON_TOOL_NAME,
    arguments: { code },
    agent,
    signal: new AbortController().signal,
  })
  if (result.isError) return { text: result.error.message, outcome: 'error', isError: true }
  const value = result.value as { text: string, outcome: string }
  return { text: value.text, outcome: value.outcome, isError: false }
}

/** One `key=value` line a cell printed, or undefined. */
function printed(text: string, key: string): string | undefined {
  const match = new RegExp(`^${key}=(.*)$`, 'mu').exec(text)
  return match?.[1]?.trim()
}

/** One JSON value a cell printed on a line shaped `KEY=<json>`. */
function jsonLine(text: string, key: string): Record<string, unknown> | null {
  const raw = printed(text, key)
  if (raw === undefined) return null
  try { return JSON.parse(raw) as Record<string, unknown> } catch { return null }
}

const sha256 = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex')

/**
 * The `line N` a traceback or SyntaxError names, as a number.
 *
 * ANSI colour codes are stripped first because IPython colourises the frame
 * header, and a pattern that only matched the uncoloured form would silently
 * report `null` and turn a real line-number assertion into a vacuous one.
 */
function reportedLine(text: string): number | null {
  const plain = text.replace(/\u001B\[[0-9;]*m/gu, '')
  const matches = [...plain.matchAll(/line (\d+)/gu)].map(match => Number(match[1]))
  return matches.length === 0 ? null : matches[0] as number
}

/**
 * The cell that prints back IPython's own record of the PREVIOUS cell's source.
 *
 * WHY `[-2]` AND NOT `[-1]`. This probe cell is itself an `execute_request` with
 * `store_history` true, so `[-1]` is the probe's own source. Reading `[-1]` would
 * make every assertion below compare the probe against itself and pass no matter
 * what the host did to the cell under test -- a vacuous oracle, which is the
 * failure this project records most often. `[-2]` is the cell that actually ran
 * before the probe.
 *
 * `ENTRIES` counts the NON-EMPTY recorded entries, which is what makes the
 * "the bind does not enter history" claim falsifiable: the bind runs with
 * `store_history=false`, so N user cells must produce exactly N entries.
 */
const RECORD_SOURCE_CELL = [
  'import json as _json, IPython as _ipython',
  '_h = _ipython.get_ipython().history_manager',
  '_recorded = [entry for entry in _h.input_hist_raw if entry is not None]',
  'print("RECORDED=" + _json.dumps(_recorded[-2]))',
  'print("ENTRIES=" + _json.dumps(len(_recorded)))',
].join('\n')

/** The source IPython recorded for the cell that ran immediately before now. */
async function recordedPreviousSource(agent: Agent): Promise<{ source: string, entries: number }> {
  const probe = await cell(agent, RECORD_SOURCE_CELL)
  expect(probe.outcome, `the recording probe must run: ${probe.text}`).toBe('ok')
  const recorded = printed(probe.text, 'RECORDED')
  expect(recorded, 'the kernel must report what it recorded').toBeDefined()
  return {
    source: JSON.parse(recorded as string) as string,
    entries: Number(printed(probe.text, 'ENTRIES') ?? '-1'),
  }
}

describe('P8 / IPY-SOURCE-IDENTITY: the user code executes UNCHANGED', () => {
  it('the recorded source IS the model\'s own bytes, with no prefix and no shift', async () => {
    // THE INVARIANT, AS ONE ASSERTION. Read back from IPython's own history.
    const agent = agentFor('p8-source-identity')
    const submitted = 'p8_probe_a = 1\nprint("A=True")'
    expect((await cell(agent, submitted)).outcome).toBe('ok')

    const { source } = await recordedPreviousSource(agent)
    // BYTE EQUALITY, not "contains". A prefix, a suffix, a re-indent or a
    // trailing-newline change would all fail here.
    expect(sha256(source)).toBe(sha256(submitted))
    expect(source).toBe(submitted)
    // And the specific thing that used to be there, asserted as an absence so a
    // reader can see which defect this arm closes.
    expect(source).not.toContain('_dsh_mod')
    expect(source).not.toContain('_bind(')
    expect(source).not.toContain('import sys as _dsh_sys')

    // THE CONTROL ARM: a cell whose source happens to contain none of the host's
    // names would pass a weaker test by accident, so the same measurement is
    // taken on a cell that DOES use `dsh`. A bridged cell must be recorded
    // unrewritten too -- and it is the case where a prefix would be most tempting.
    const bridgedSource = "await dsh.call('p8_echo', {'tag': 'x'})\nprint('BRIDGED=True')"
    const bridged = await cell(agent, bridgedSource)
    expect(bridged.outcome).toBe('ok')
    expect(printed(bridged.text, 'BRIDGED')).toBe('True')
    const bridgedRecorded = await recordedPreviousSource(agent)
    expect(bridgedRecorded.source).toBe(bridgedSource)
    // And the bridged call really reached the registry, so the byte-equality
    // above is not the equality of two cells that did nothing.
    expect(dispatches.filter(entry => entry.name === 'p8_echo')).toHaveLength(1)
  }, 300_000)

  it('the hidden bind does NOT enter the input history: the user cell is the last entry', async () => {
    // A bind that recorded itself would satisfy byte-equality by coincidence on
    // an even-numbered sequence and be wrong on an odd one, so this asserts the
    // ORDER and the COUNT as well.
    //
    // THE COUNT IS A DELTA, NOT AN ABSOLUTE. The kernel's history has a baseline
    // this test does not control (measured: one entry exists before any user
    // cell), and asserting an absolute number would encode that baseline as if it
    // were part of the contract. The falsifiable property is the DELTA: two user
    // cells must add exactly two entries. A bind that stored history would add
    // two more, and the delta would be four.
    const agent = agentFor('p8-history-order')
    const before = await recordedPreviousSource(agent)

    const first = 'marker_one = 1\nprint("FIRST=True")'
    const second = 'marker_two = 2\nprint("SECOND=True")'
    expect((await cell(agent, first)).outcome).toBe('ok')
    expect((await cell(agent, second)).outcome).toBe('ok')

    const { source, entries } = await recordedPreviousSource(agent)
    // The previous user cell is the last recorded entry: never a bind.
    expect(source).toBe(second)
    // THREE CELLS WERE DISPATCHED between the two measurements -- `first`,
    // `second`, and this probe -- so the history grew by exactly three. A bind
    // that stored history would add two more (one per bridged cell) and make this
    // six. The DELTA is used rather than an absolute because the kernel's history
    // has a baseline this test does not control, and encoding that baseline as if
    // it were part of the contract would be an oracle weaker than its scenario.
    expect(entries - before.entries).toBe(3)

    // No recorded entry anywhere carries the bind's own names.
    const tail = await cell(agent, [
      'import json as _json, IPython as _ipython',
      '_h = _ipython.get_ipython().history_manager',
      'print("ALL=" + _json.dumps([e for e in _h.input_hist_raw if e is not None]))',
    ].join('\n'))
    const all = JSON.parse(printed(tail.text, 'ALL') as string) as string[]
    for (const entry of all) {
      expect(entry).not.toContain('_dsh_mod')
      expect(entry).not.toContain('dsh_bridge_client')
      expect(entry).not.toContain('_bind(')
    }
    // The recorded sequence CONTAINS the user's cells, in order, with nothing
    // host-authored interleaved between them: `first` and `second` are adjacent
    // recorded entries.
    const firstAt = all.indexOf(first)
    expect(firstAt).toBeGreaterThanOrEqual(0)
    expect(all[firstAt + 1]).toBe(second)
  }, 300_000)

  it('a traceback reports the USER\'s line number, not a shifted one', async () => {
    const agent = agentFor('p8-traceback-line')
    // The raise is on user line 3.
    const submitted = ['x = 1', 'y = 2', 'raise ValueError("p8-boom")'].join('\n')
    const result = await cell(agent, submitted)
    expect(result.outcome).toBe('error')
    expect(reportedLine(result.text)).toBe(3)
    // The traceback must also NOT show host lines as context, which is what a
    // shifted frame displayed before.
    expect(result.text).not.toContain('_dsh_mod')
    expect(result.text).not.toContain('_dsh_sys')
  }, 300_000)

  it('a SyntaxError reports the USER\'s line number, not a shifted one', async () => {
    const agent = agentFor('p8-syntax-line')
    // Invalid syntax on user line 3.
    const submitted = ['a = 1', 'b = 2', 'def broken(:'].join('\n')
    const result = await cell(agent, submitted)
    expect(result.outcome).toBe('error')
    expect(reportedLine(result.text)).toBe(3)
    expect(result.text).not.toContain('_dsh_mod')
  }, 300_000)

  it('top-level await and `%who` still work, and neither rewrites the source', async () => {
    // The two "ordinary IPython still works" arms from V5 §9's list. They are
    // regression guards for the change: the bind is a separate request now, so a
    // cell's own top-level `await` must be unaffected.
    const agent = agentFor('p8-await-who')
    const awaited = ['import asyncio', 'value = await asyncio.sleep(0.01, result=7)', 'print("AWAIT=" + str(value))'].join('\n')
    const awaitResult = await cell(agent, awaited)
    expect(awaitResult.outcome).toBe('ok')
    expect(printed(awaitResult.text, 'AWAIT')).toBe('7')

    const who = await cell(agent, '%who')
    expect(who.outcome).toBe('ok')
    // `dsh` is a bound name in a bridged cell, so `%who` must list it -- which is
    // also evidence the bind happened in THIS cell's namespace rather than in a
    // hidden namespace the user's cell cannot see.
    expect(who.text).toContain('dsh')

    // And `%who`'s own source is unrewritten.
    const { source } = await recordedPreviousSource(agent)
    expect(source).toBe('%who')
  }, 300_000)
})

describe('P8 / IPY-MAGIC-BIND: a cell magic receives a fresh capability', () => {
  it('a real cell magic runs, is the first line of its own request, and has a LIVE dsh', async () => {
    // `%%capture` is a real IPython cell magic present in this environment.
    // `%%bash` is deliberately NOT used: this is Windows.
    //
    // THE BODY USES `call_sync`, AND THAT IS A MEASURED CHOICE. A cell magic runs
    // its body through IPython's own nested `run_cell`; a top-level `await` inside
    // one dies with `RuntimeError: This event loop is already running`
    // (`asyncio/base_events.py:631`). MEASURED IDENTICALLY BEFORE AND AFTER the
    // bind change, so it is a property of nested magics and NOT of this path.
    // `call_sync` reaches the same lease and the same host dispatch on the same
    // socket, so it answers the binding question without importing that unrelated
    // failure into this arm.
    const agent = agentFor('p8-magic-bind')
    // A first, ordinary cell, so a stale `dsh` EXISTS before the magic cell. This
    // is what makes the arm negative-capable: without a fresh bind the magic cell
    // would find the previous cell's dead capability, which is exactly what the
    // pre-fix tree did.
    const primed = await cell(agent, [
      "await dsh.call('p8_echo', {'tag': 'priming'})",
      'print("PRIMED=True")',
      'print("PRIMED_LEASE=" + dsh._channel._lease)',
    ].join('\n'))
    expect(primed.outcome).toBe('ok')

    const reportPath = join(root, 'magic-report.json').replace(/\\/gu, '/')
    const magicSource = [
      '%%capture cap',
      'import json as _json',
      'report = {"dsh_in_dir": "dsh" in dir()}',
      'try:',
      "    import dsh as _dsh",
      "    report['import'] = 'OK'",
      'except Exception as exc:',
      "    report['import'] = type(exc).__name__",
      'report["bound_lease"] = getattr(getattr(dsh, "_channel", None), "_lease", None)',
      'try:',
      "    report['call'] = 'SERVED:' + str(dsh.call_sync('p8_echo', {'tag': 'from-the-magic-cell'})['tag'])",
      'except Exception as exc:',
      "    report['call'] = getattr(exc, 'code', type(exc).__name__)",
      `with open(${JSON.stringify(reportPath)}, 'w', encoding='utf-8') as _h:`,
      '    _json.dump(report, _h, sort_keys=True)',
    ].join('\n')

    const magic = await cell(agent, magicSource)
    expect(magic.outcome).toBe('ok')

    // THE MAGIC'S SOURCE IS UNREWRITTEN AND STILL STARTS WITH `%%`. If the host
    // had prepended anything, IPython would have refused the cell outright.
    const { source } = await recordedPreviousSource(agent)
    expect(source).toBe(magicSource)
    expect(source.startsWith('%%capture')).toBe(true)

    // The observation is read from a FILE the magic wrote, because `%%capture`
    // swallows stdout -- a captured print and a cell that never ran look the same.
    const report = JSON.parse(await readText(reportPath)) as Record<string, unknown>
    expect(report['dsh_in_dir']).toBe(true)
    expect(report['import']).toBe('OK')
    // THE LIVE CAPABILITY, not a dead one: the call reached the registry and the
    // value came back.
    expect(report['call']).toBe('SERVED:from-the-magic-cell')
    // And the registry really saw it, exactly once per bridged cell so far.
    expect(dispatches.filter(entry => entry.name === 'p8_echo')).toHaveLength(2)

    // THE LEASE IS FRESH. The magic cell's bound lease differs from the priming
    // cell's, so it was not the stale object the pre-fix tree handed it.
    const magicLease = report['bound_lease']
    expect(typeof magicLease).toBe('string')
    // Captured from the priming cell BEFORE the magic ran, via a name that
    // survives, so this compares two real leases rather than two guesses.
    const primingLease = printed(primed.text, 'PRIMED_LEASE')
    expect(primingLease).toBeTruthy()
    expect(magicLease).not.toBe(primingLease)
  }, 300_000)

  it('the lease CHANGES every cell, and a STALE lease presented to the host is refused', async () => {
    const agent = agentFor('p8-lease-rotation')
    const first = await cell(agent, 'print("LEASE=" + dsh._channel._lease)')
    const second = await cell(agent, 'print("LEASE=" + dsh._channel._lease)')
    const firstLease = printed(first.text, 'LEASE')
    const secondLease = printed(second.text, 'LEASE')
    expect(firstLease).toBeTruthy()
    expect(secondLease).toBeTruthy()
    // A FRESH capability per cell is the requirement; an equal one would mean the
    // bind did not run.
    expect(secondLease).not.toBe(firstLease)

    // ---- WHAT "AN OLD `dsh` REFERENCE" ACTUALLY IS, MEASURED ---------------
    // `held = dsh` does NOT capture a stale capability, and this arm records that
    // rather than assuming otherwise: the client keeps ONE module-level `_channel`
    // and `_bind` mutates it in place, so `held` and the current `dsh` are the
    // same object and `held._channel._lease` tracks the CURRENT bind.
    // MEASURED: an earlier version of this arm asserted `held` kept the lease it
    // had when it was assigned, and failed -- the assumption was wrong, not the
    // product. The honest assertion is the one below: same object, and a lease
    // that is NOT the one from the earlier cell.
    const held = await cell(agent, [
      'held = dsh',
      'print("IS_SAME=" + str(held is dsh))',
      'print("HELD_LEASE=" + held._channel._lease)',
    ].join('\n'))
    expect(printed(held.text, 'IS_SAME')).toBe('True')
    const heldLease = printed(held.text, 'HELD_LEASE')
    expect(heldLease).toBeTruthy()
    // It is a LATER lease than the first cell's, because the shared channel was
    // rebound by the binds of the cells in between.
    expect(heldLease).not.toBe(firstLease)
    expect(heldLease).not.toBe(secondLease)

    // SO THE REAL STALE-CAPABILITY QUESTION IS AT THE PROTOCOL BOUNDARY: a frame
    // presenting a SETTLED lease id must be refused, and refused with a stable
    // code rather than served. This is what a genuinely stale object would do, and
    // it is reachable by pinning the channel's lease back to a settled one.
    const after = await cell(agent, [
      'import json as _json',
      'report = {"stale_lease": ' + JSON.stringify(firstLease) + '}',
      'dsh._channel._lease = ' + JSON.stringify(firstLease),
      'try:',
      "    await dsh.call('p8_echo', {'tag': 'stale'})",
      "    report['call'] = 'SERVED'",
      'except Exception as exc:',
      "    report['call'] = getattr(exc, 'code', type(exc).__name__)",
      'finally:',
      // The channel is restored to the CURRENT bind so this cell leaves no
      // residue for a later arm. The value is INTERPOLATED from the lease the
      // previous cell reported, not written as a bare Python name -- a bare name
      // is a NameError inside the cell, which would make this arm fail for a
      // reason that has nothing to do with the capability.
      '    dsh._channel._lease = ' + JSON.stringify(heldLease),
      'print("STALE=" + _json.dumps(report, sort_keys=True))',
    ].join('\n'))
    const stale = jsonLine(after.text, 'STALE')
    // `LEASE_UNKNOWN`: the settled lease was RELEASED from the server's table when
    // the cell ended, so a frame naming it is an unknown capability. This is the
    // same stable refusal the pre-fix tree produced for a stale object -- which is
    // the point: the defect was never that a stale call succeeded, it was that a
    // stale OBJECT was left reachable at all, and that is what the revoke and the
    // fresh bind now prevent.
    expect(stale?.['call']).toBe('LEASE_UNKNOWN')
    // AND IT DID NOT REACH THE REGISTRY: a refusal at the bridge is not a
    // dispatch that was cancelled afterwards. The tag makes the search exact.
    expect(dispatches.filter(entry => entry.callId.includes('stale'))).toHaveLength(0)
  }, 300_000)
})

describe('P8 / authority-less cells: a prior capability is REVOKED, not inherited', () => {
  it('an internal cell with no authority cannot reuse a previous dsh capability', async () => {
    // THE CLAIM THE OLD COMMENT MADE, measured. It said an authority-less cell has
    // `dsh` "simply absent". In a PERSISTENT namespace that was false: after any
    // bridged cell, `dsh` and `sys.modules['dsh']` were both still there, carrying
    // a settled lease id, and a call through them returned `LEASE_UNKNOWN`.
    const agent = agentFor('p8-authority-less')
    // Establish a real capability first, through the product path.
    const bridged = await cell(agent, "await dsh.call('p8_echo', {'tag': 'before'})\nprint('BRIDGED=True')")
    expect(bridged.outcome).toBe('ok')
    const liveLease = printed((await cell(agent, 'print("LEASE=" + dsh._channel._lease)')).text, 'LEASE')
    expect(liveLease).toBeTruthy()

    // Now dispatch with NO authority -- the internal-probe path.
    const result = await service?.runCell(agent, [
      'import json as _json',
      'report = {"dsh_in_dir": "dsh" in dir()}',
      'try:',
      "    import dsh as _dsh",
      "    report['import'] = 'OK'",
      'except Exception as exc:',
      "    report['import'] = type(exc).__name__",
      'print("NOAUTH=" + _json.dumps(report, sort_keys=True))',
    ].join('\n'))
    expect(result?.outcome).toBe('ok')
    const report = jsonLine(result?.stdout.text ?? '', 'NOAUTH')

    // THE REVOKE, as a NEGATIVE on both channels a capability could travel on.
    expect(report?.['dsh_in_dir']).toBe(false)
    expect(report?.['import']).toBe('ModuleNotFoundError')
  }, 300_000)

  it('the revoke leaves the rest of the namespace intact, so it is a revoke and not a reset', async () => {
    // A revoke implemented as a kernel reset would also make `dsh` absent, and
    // would destroy the user's variables. This arm separates the two.
    const agent = agentFor('p8-revoke-scope')
    expect((await cell(agent, 'p8_survivor = "kept"')).outcome).toBe('ok')
    const epochBefore = service?.currentEpoch(agent)

    const result = await service?.runCell(agent, [
      'import json as _json',
      'print("SCOPE=" + _json.dumps({"dsh": "dsh" in dir(), "survivor": p8_survivor}))',
    ].join('\n'))
    const scope = jsonLine(result?.stdout.text ?? '', 'SCOPE')
    expect(scope?.['dsh']).toBe(false)
    expect(scope?.['survivor']).toBe('kept')
    // No new epoch: nothing was reset.
    expect(service?.currentEpoch(agent)).toBe(epochBefore)
  }, 300_000)

  it('a BRIDGED cell after an authority-less one gets a fresh live capability', async () => {
    // The revoke must not poison the next bridged cell: the bind re-creates the
    // module if it is gone.
    const agent = agentFor('p8-rebind-after-revoke')
    expect((await service?.runCell(agent, 'print("NOAUTH_CELL=True")'))?.outcome).toBe('ok')
    const after = await cell(agent, "await dsh.call('p8_echo', {'tag': 'after-revoke'})\nprint('REBOUND=True')")
    expect(after.outcome).toBe('ok')
    expect(printed(after.text, 'REBOUND')).toBe('True')
    expect(dispatches.filter(entry => entry.name === 'p8_echo')).toHaveLength(1)
  }, 300_000)
})

/** Read a file the kernel wrote, as UTF-8 text. */
async function readText(path: string): Promise<string> {
  const { readFile } = await import('node:fs/promises')
  return await readFile(path, 'utf8')
}
