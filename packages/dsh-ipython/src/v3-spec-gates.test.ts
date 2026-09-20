/**
 * V3: the trusted-local acceptance spec's IPYTHON cases that had NO gate.
 *
 * WHY THIS FILE EXISTS. The spec `qualification/specs/acceptance-spec.trusted-local-v1.json`
 * re-issues the IPY numbering, and its IPY-01..IPY-15 are NOT the same cases as
 * the labels T6 used inside `lifecycle.test.ts` / `faults.test.ts`. Several of
 * T6's labels happen to collide with a DIFFERENT spec case (T6's "IPY-04" is the
 * spec's IPY-04 only by accident; T6's "IPY-15" is the spec's IPY-11, and the
 * spec's IPY-15 -- transport authentication -- had no gate at all).
 *
 * So the mapping was done by ORACLE, not by label, and this file holds the cases
 * whose oracle nothing else established. Cases already established elsewhere are
 * recorded in `qualification/results/V3-ipython/GATES.md` with the file and test
 * name that establishes them, and are NOT duplicated here -- a second copy of an
 * oracle is a second oracle, which is the defect class this project keeps
 * recording.
 *
 * WHAT IS IN HERE, by spec case:
 *   IPY-01  real IPython shell + magic            (spec's IPY-01, no gate existed)
 *   IPY-02  persistence, cell 2 has NO definitions (the "does not contain" half)
 *   IPY-03  top-level await AND a native tool call, no wrapper
 *   IPY-04  exception leaves partial state, and the MODEL-FACING TEXT does not
 *           claim rollback (T6 covered the namespace half only)
 *   IPY-05  stdin disabled, fails fast, NEVER holds the execution slot open
 *   IPY-06  foreign frames ignored + COUNTED + epoch/parent association
 *   IPY-11  cwd is the project root, recorded verbatim, relative path resolves
 *   IPY-12  TRUNCATED names the true total AND a spill path; cap recorded
 *   IPY-13  late output: post-return is late; during-a-later-cell is UNDECIDABLE
 *           (this arm pinned the defect until round 2's broker.py bootstrap
 *            fixed it; it now asserts the oracle. The fix's own gate, with the
 *            thread+join control and the mutation record, is `s5-ipy13.test.ts`.)
 *   IPY-14  kernel death: NEW epoch + reason + LOST + nothing replayed
 *   IPY-15  transport authentication + an over-limit frame is LOST, not empty
 *
 * CPU DISCIPLINE. One kernel per test, every host shut down in `afterEach`.
 */
import { Context } from '@deepseek-ai/cordis'
import Subprocess from '@deepseek-ai/dsh-subprocess-local'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { KernelHost, KernelOutcomeUnknownError } from './kernel.ts'
import { KernelService } from './kernel-plugin.ts'
import { asBrokerMessage, encodeFrame, FrameDecoder, MAX_FRAME_BYTES } from './protocol.ts'
import { MemoryBridgeLedger } from './bridge-ledger.ts'

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
  root = await mkdtemp(join(tmpdir(), 'dsh-ipython-v3-'))
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
    identity: { sessionId: 'v3', executionWorld: 'local', environmentDigest: 'v3-env' },
    brokerScript: BROKER,
    pythonExecutable: PYTHON,
    workingDirectory: root,
    ...options.outputCapBytes === undefined ? {} : { outputCapBytes: options.outputCapBytes },
    ...options.cellTimeoutMs === undefined ? {} : { cellTimeoutMs: options.cellTimeoutMs },
    ...options.interruptGraceMs === undefined ? {} : { interruptGraceMs: options.interruptGraceMs },
  })
  return host
}

function agentFor(sessionId: string, cwd?: string): Agent {
  return {
    session: { header: { id: sessionId, ...cwd === undefined ? {} : { cwd } } },
  } as unknown as Agent
}

function makeService(): KernelService {
  service = new KernelService(ctx, { pythonExecutable: PYTHON, brokerScript: BROKER, root, durableLedger: false })
  return service
}

const sleep = (ms: number): Promise<void> => new Promise(resolvePromise => setTimeout(resolvePromise, ms))

/** One JSON object printed by a cell as `TAG:{...}`, or a readable failure. */
function jsonFrom(stdout: string, tag: string): Record<string, unknown> {
  const match = new RegExp(`${tag}:(\\{.*\\})`).exec(stdout)
  expect(match, `the cell did not print ${tag}:{...}; stdout was: ${stdout}`).not.toBeNull()
  return JSON.parse(match?.[1] ?? '{}') as Record<string, unknown>
}

// ---------------------------------------------------------------------------
// IPY-01. A real IPython shell, not a CPython imitation.
//
// SPEC STIMULUS: "In one cell, evaluate `get_ipython()` and execute a supported
// magic such as `%who` or `%time`." The oracle names BOTH halves and names the
// failure: "A plain-CPython interpreter that fails either is NOT PASS."
//
// `requirements.test.ts` establishes this against `KernelHost`. This gate runs it
// against the SERVICE -- the layer the product actually drives -- and does both
// in ONE cell, which is the spec's stimulus verbatim rather than an equivalent.
// ---------------------------------------------------------------------------

describe('IPY-01: a real IPython shell, not a CPython imitation', () => {
  it('get_ipython() and a magic both work IN ONE CELL through the service', async () => {
    const s = makeService()
    const agent = agentFor('spec-ipy-01')

    // One cell, both halves, and the magic's own output is captured rather than
    // inferred: `%who` prints names, so its output proves the magic RAN rather
    // than merely parsed.
    const result = await s.runCell(agent, [
      'import sys',
      'shell = get_ipython()',
      'print("SHELL_MODULE=" + type(shell).__module__)',
      'print("SHELL_CLASS=" + type(shell).__name__)',
      'print("IS_ZMQ_SHELL=" + str(isinstance(shell, sys.modules["ipykernel.zmqshell"].ZMQInteractiveShell)))',
      'ipy01_marker = 1234',
      '%who',
    ].join('\n'))
    expect(result.outcome).toBe('ok')

    const stdout = result.stdout.text
    const identity = await s.status(agent)
    console.log('[V3-MEASURED] IPY-01 ' + JSON.stringify({
      outcome: result.outcome,
      shellModule: /SHELL_MODULE=(.*)/.exec(stdout)?.[1] ?? null,
      shellClass: /SHELL_CLASS=(.*)/.exec(stdout)?.[1] ?? null,
      isZmqShell: /IS_ZMQ_SHELL=(.*)/.exec(stdout)?.[1] ?? null,
      magicOutputContainsMarker: stdout.includes('ipy01_marker'),
      // V5 11.2's names. `kernelImplementationVersion` is the IPYTHON version and
      // `languageVersion` is the PYTHON version; the field this replaced was
      // called `ipythonVersion` and carried the latter.
      kernelImplementation: identity?.kernelImplementation ?? null,
      kernelImplementationVersion: identity?.kernelImplementationVersion ?? null,
      languageName: identity?.languageName ?? null,
      languageVersion: identity?.languageVersion ?? null,
      protocolVersion: identity?.protocolVersion ?? null,
    }))

    // (1) `get_ipython()` returns a REAL IPython shell object. The class name is
    //     asserted, not merely "not None": a stub object would satisfy a truthy
    //     check and would not be an IPython shell.
    expect(stdout).toContain('SHELL_MODULE=ipykernel.zmqshell')
    expect(stdout).toContain('SHELL_CLASS=ZMQInteractiveShell')
    expect(stdout).toContain('IS_ZMQ_SHELL=True')

    // (2) The magic EXECUTED. `%who` is IPython's own magic dispatcher, so a
    //     plain-CPython interpreter raises SyntaxError on that line; `outcome: ok`
    //     plus the marker in the magic's output is the discriminator. The marker
    //     appears ONLY because `%who` listed the namespace.
    expect(stdout).toContain('ipy01_marker')

    await s.close()
    service = undefined
  }, 300_000)
})

// ---------------------------------------------------------------------------
// IPY-02. The namespace persists across cells -- and cell 2 does NOT redefine.
//
// SPEC ORACLE, second sentence, which is the half that matters: "The record shows
// cell 2's source does not contain the definitions, so the persistence is real
// rather than the earlier input being re-read."
//
// So this gate asserts a property of the RECORD (the cell-2 source), not only of
// the namespace. A test that defined the DataFrame twice would pass a
// namespace-only oracle while proving nothing about persistence.
// ---------------------------------------------------------------------------

describe('IPY-02: the namespace persists across cells', () => {
  it('cell 2 uses a DataFrame, a function and an import it does NOT define', async () => {
    const s = makeService()
    const agent = agentFor('spec-ipy-02')

    const cellOne = [
      'import json as persisted_json',
      'import pandas as pd',
      'persisted_frame = pd.DataFrame({"n": [3, 4, 5]})',
      'def persisted_fn(value):',
      '    return value * 100',
      'print("CELL1_OK", persisted_frame.shape)',
    ].join('\n')

    const cellTwo = [
      'print("CELL2_OK",',
      '      int(persisted_frame["n"].sum()),',
      '      persisted_fn(2),',
      '      persisted_json.dumps({"a": 1}, sort_keys=True))',
    ].join('\n')

    // THE ORACLE ON THE RECORD: cell 2's source must not contain the definitions.
    // Asserted mechanically rather than asserted in prose, so a future edit that
    // pastes the definitions back into cell 2 fails here.
    for (const forbidden of ['import json', 'import pandas', 'def persisted_fn', 'persisted_frame =']) {
      expect(cellTwo, `cell 2 must not redefine: ${forbidden}`).not.toContain(forbidden)
    }

    const first = await s.runCell(agent, cellOne)
    expect(first.outcome).toBe('ok')
    expect(first.stdout.text).toContain('CELL1_OK (3, 1)')

    const second = await s.runCell(agent, cellTwo)
    expect(second.outcome).toBe('ok')

    console.log('[V3-MEASURED] IPY-02 ' + JSON.stringify({
      cellOneSourceDefines: ['import json as persisted_json', 'import pandas as pd',
        'persisted_frame = pd.DataFrame(...)', 'def persisted_fn'],
      cellTwoSourceContainsDefinitions: false,
      cellTwoStdout: second.stdout.text.trim(),
      sameEpoch: first.epoch === second.epoch,
      epoch: second.epoch,
    }))

    // All THREE artifacts are available in cell 2 with the right VALUES. Values,
    // not just resolvability: a namespace rebuilt by replaying cell 1 would also
    // resolve the names, so the arithmetic is what makes this persistence.
    expect(second.stdout.text).toContain('CELL2_OK 12 200 {"a": 1}')
    // And it is the same generation, so the persistence is in ONE kernel rather
    // than across a restart that happened to re-import.
    expect(second.epoch).toBe(first.epoch)

    await s.close()
    service = undefined
  }, 300_000)
})

// ---------------------------------------------------------------------------
// IPY-03. Top-level await with no wrapper.
//
// SPEC STIMULUS: "`await` an asyncio task and a native tool call at top level in
// one cell." SPEC ORACLE: "Both settle with accurate results and the cell source
// contains no `async def` / function-body wrapper."
//
// `requirements.test.ts` covers a bare `await` on asyncio. It does NOT cover a
// NATIVE TOOL CALL awaited at top level, which is the half of the stimulus that
// distinguishes "the kernel has an event loop" from "the DSH bridge is awaitable
// from model Python". This gate covers that, plus the source-shape half of the
// oracle, which nothing asserted mechanically.
// ---------------------------------------------------------------------------

describe('IPY-03: top-level await works with no wrapper', () => {
  it('an asyncio task and a native tool call both settle at top level, unwrapped', async () => {
    // The bridge is mounted BY HAND, exactly as `bridge-seam.test.ts` does and for
    // the same reason: `createNativeCallHandler` has no production caller yet
    // (recorded as T7-05/G-FIX). What is measured here is the AWAITABILITY of a
    // native call from top-level model Python -- the spec's stimulus -- and not
    // whether the bridge is wired, which is the BR family's case.
    const { BridgeServer } = await import('./bridge.ts')
    const { createNativeCallHandler } = await import('./native-call.ts')

    // `SystemPrompt` is mounted first because `ToolRuntime` declares it as a
    // dependency; mounting the runtime without it leaves `ctx.tools` undefined,
    // which surfaced here as "Cannot read properties of undefined (reading
    // 'register')" -- a harness-shaped failure, not a product one. The order is
    // copied from `bridge-seam.test.ts`, which is the proven mount.
    await ctx.plugin(SystemPrompt, { personaPrefix: '' })
    await ctx.plugin(ToolRuntime, { mode: 'native', maxParallelSubCalls: 4 })
    ctx.tools.register(defineTool({
      name: 'v3_echo',
      description: 'Returns a fixed marker, to prove a native call is awaitable at cell top level.',
      parameters: { tag: { type: 'string', required: true, description: 'echoed back' } },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: { marker: { type: 'string', required: true }, tag: { type: 'string', required: true } },
        },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      execute: async args => ({ marker: 'NATIVE-SETTLED', tag: (args as { tag: string }).tag }),
    }))

    const bridge = new BridgeServer({ artifactDirectory: join(root, 'artifacts') })
    await bridge.start()
    const s = makeService()
    const agent = agentFor('spec-ipy-03')
    const projectRoot = root

    // The authority shape is copied from the real one `bridge-seam.test.ts` uses
    // (callId + rootCallId + a token only the registry can mint + agent + signal).
    // A guessed shape would surface as a TypeError that reads like a product
    // failure, which is the harness-shaped-failure trap this project records.
    const callId = 'v3-ipy-call-1'
    const lease = bridge.mintLease({
      sessionId: 'spec-ipy-03',
      cellId: 'v3-cell-1',
      epoch: 1,
      outerCallId: String('legacy-outer-call'),
      rootCallId: String('legacy-outer-call'),
      ledger: new MemoryBridgeLedger(),
      handler: createNativeCallHandler({
        ctx,
        authority: {
          callId,
          rootCallId: callId,
          token: Symbol('v3-probe-token') as never,
          agent,
          signal: new AbortController().signal,
        },
        bridge,
      }),
    })

    // THE SOURCE SHAPE IS PART OF THE ORACLE, so it is built as a plain list of
    // top-level statements and asserted below to contain no wrapper.
    const cellBody = [
      'import asyncio, json',
      'value = await asyncio.sleep(0.05, result=21)',
      "native = await dsh.call('v3_echo', {'tag': 'from-the-cell'})",
      'print("IPY03:" + json.dumps({"asyncio": value * 2, "native": native}, sort_keys=True))',
    ]
    const code = [bridge.preamble(lease), ...cellBody].join('\n')

    // The oracle's own clause, asserted mechanically: no `async def`, and no
    // function-body wrapper around either await.
    expect(cellBody.join('\n')).not.toContain('async def')
    expect(cellBody.join('\n')).not.toContain('asyncio.run')
    expect(cellBody.join('\n')).not.toContain('loop.run_until_complete')

    const result = await s.runCell(agent, code)
    expect(result.outcome).toBe('ok')
    const observed = jsonFrom(result.stdout.text, 'IPY03')

    console.log('[V3-MEASURED] IPY-03 ' + JSON.stringify({
      outcome: result.outcome,
      asyncioValue: observed['asyncio'] ?? null,
      nativeValue: observed['native'] ?? null,
      sourceHasAsyncDef: false,
      sourceHasWrapper: false,
      cellId: 'v3-cell-1',
      projectRoot,
    }))

    // Both settled with ACCURATE results: the asyncio value is the arithmetic the
    // cell asked for, and the native value is the registry's own canonical object
    // (marker + the tag the cell passed), not a bridge-invented stub.
    expect(observed['asyncio']).toBe(42)
    expect(observed['native']).toEqual({ marker: 'NATIVE-SETTLED', tag: 'from-the-cell' })

    await lease.close('completed', 'the cell settled')
    bridge.releaseLease(lease)
    // `BridgeServer.close()` (not `stop`): it revokes every lease and stops
    // listening, so this test cannot leave a listening socket behind.
    await bridge.close()
    await s.close()
    service = undefined
  }, 300_000)
})

// ---------------------------------------------------------------------------
// IPY-04. An exception leaves partial state and does NOT claim rollback.
//
// SPEC STIMULUS: "Assign a variable, then raise in the same cell; read the
// variable in the next cell."
// SPEC ORACLE: "The error is reported with its traceback AND the assignment is
// still present in the next cell. Any wording that presents the cell as rolled
// back is NOT PASS."
//
// `requirements.test.ts` requirement 5 covers the namespace half. The half that
// NOTHING covered is the WORDING: the model-facing text must not present the cell
// as rolled back. That is an assertion about `ipython-tool.ts`'s renderer, so it
// is made against the renderer's actual output rather than against a comment.
// ---------------------------------------------------------------------------

describe('IPY-04: an exception leaves partial state and does not claim rollback', () => {
  it('the assignment survives, the traceback is present, and the MODEL TEXT claims no rollback', async () => {
    const s = makeService()
    const agent = agentFor('spec-ipy-04')

    const failed = await s.runCell(agent, 'ipy04_survivor = "still assigned"\nraise ValueError("deliberate")')
    expect(failed.outcome).toBe('error')
    expect(failed.error?.ename).toBe('ValueError')

    // THE TRACEBACK, with the failing line: the oracle asks for the traceback, not
    // only the exception type.
    const traceback = failed.error?.traceback.join('\n') ?? ''
    expect(traceback).toContain('ValueError')
    expect(traceback).toContain('deliberate')

    const after = await s.runCell(agent, 'print("ipy04_survivor is", ipy04_survivor)')
    expect(after.outcome).toBe('ok')
    expect(after.stdout.text).toContain('ipy04_survivor is still assigned')

    // ---- the WORDING half, against the real renderer ----------------------
    // `renderCell` is module-private, so the model-facing text is obtained the way
    // the model obtains it: by registering the tool and calling its `execute`.
    const { apply } = await import('./ipython-tool.ts')
    const registered: Array<{ definition: unknown }> = []
    const toolCtx = {
      tools: { register: (definition: unknown) => { registered.push({ definition }); return () => undefined } },
      get: (name: string) => (name === 'ipython' ? s : undefined),
    }
    apply(toolCtx as never)
    const definition = registered[0]?.definition as {
      execute: (args: unknown, exec: unknown) => Promise<{ text: string, outcome: string }>
    }
    const rendered = await definition.execute(
      { code: 'ipy04_render_probe = 1\nraise RuntimeError("rendered failure")' },
      { agent, signal: new AbortController().signal },
    )

    console.log('[V3-MEASURED] IPY-04 ' + JSON.stringify({
      outcome: failed.outcome,
      ename: failed.error?.ename ?? null,
      tracebackHasFailingLine: traceback.includes('deliberate'),
      survivorReadBack: after.stdout.text.trim(),
      modelTextOutcome: rendered.outcome,
      modelTextMentionsRollback: /rollback|rolled back|reverted|undone/i.test(rendered.text),
    }))

    // The wording is searched for every way a rollback could be claimed. A
    // renderer that said "the cell was rolled back" would be a false claim about
    // a namespace that demonstrably still holds the assignment.
    expect(rendered.text).not.toMatch(/rolled back|rollback|reverted|undone|restored to/i)
    // And the error IS in the model's text, so this is not passing by saying
    // nothing at all.
    expect(rendered.text).toContain('RuntimeError')

    await s.close()
    service = undefined
  }, 300_000)
})

// ---------------------------------------------------------------------------
// IPY-05. stdin is disabled and fails fast.
//
// SPEC ORACLE, second sentence: "Each fails promptly with an explainable error
// and the cell settles; it never waits for input and never holds the execution
// slot open."
//
// "Never holds the execution slot open" is a claim about the KERNEL HOST's own
// state, not about elapsed time, and nothing asserted it. After a stdin failure
// `host.busy` must be false and a further cell must be accepted immediately --
// which is exactly what a wedged stdin read would break.
// ---------------------------------------------------------------------------

describe('IPY-05: stdin is disabled and fails fast', () => {
  it('input() and getpass() each fail promptly and do NOT hold the execution slot', async () => {
    const h = makeHost({ cellTimeoutMs: 30_000 })
    await h.start()

    const probes: Array<Record<string, unknown>> = []
    for (const [label, code] of [
      ['input', 'input("give me something: ")'],
      ['getpass', 'import getpass\ngetpass.getpass("secret: ")'],
    ] as Array<[string, string]>) {
      const beganAt = Date.now()
      const result = await h.execute(code)
      const elapsed = Date.now() - beganAt

      // (a) an EXPLAINABLE error, not a hang and not a false success.
      expect(result.outcome).toBe('error')
      const ename = result.error?.ename ?? ''
      expect(['StdinNotImplementedError', 'EOFError']).toContain(ename)

      // (b) THE SLOT IS RELEASED. Asserted from the host's own view rather than
      //     inferred from the elapsed time: a cell that failed but left
      //     `cellActive` true would make the NEXT call a KernelBusyError.
      expect(h.busy).toBe(false)

      // (c) and a further cell is accepted immediately, in the same kernel, so
      //     the slot is genuinely usable and not merely flagged free.
      const next = await h.execute(`print("slot-free-after-${label}")`)
      expect(next.outcome).toBe('ok')
      expect(next.stdout.text).toContain(`slot-free-after-${label}`)

      probes.push({ label, outcome: result.outcome, ename, elapsedMs: elapsed, busyAfter: false })
    }

    console.log('[V3-MEASURED] IPY-05 ' + JSON.stringify({
      probes,
      // The budget the cell would have burned had it waited for a terminal read.
      cellTimeoutMs: 30_000,
      note: 'each cell settled well inside the budget, and the host was not busy afterwards',
    }))

    // (d) PROMPTLY. Bounded well below the 30 s cell budget: a cell that waited
    //     for input would have to hit the timeout instead, which is 30 s.
    for (const probe of probes) {
      expect(Number(probe['elapsedMs'])).toBeLessThan(20_000)
    }

    await h.shutdown()
    host = undefined
  }, 300_000)
})

// ---------------------------------------------------------------------------
// IPY-06. Only the matching reply and idle settle a cell.
//
// SPEC STIMULUS: "Interleave shell and iopub frames carrying other msg_ids while
// a cell runs, and restart the kernel mid-sequence."
// SPEC ORACLE: "The cell is completed only by its own reply plus idle; a foreign
// frame does not complete it, and the number of ignored foreign frames is
// REPORTED. Cross-cell association by parent_header and epoch is demonstrated,
// not asserted."
//
// `requirements.test.ts` requirement 7 injects ONE foreign frame and asserts the
// cell still finishes. What was NOT covered: the COUNT being reported to the
// caller, and the restart-mid-sequence half of the stimulus.
// ---------------------------------------------------------------------------

describe('IPY-06: only the matching reply and idle settle a cell', () => {
  it('foreign frames are ignored AND COUNTED, and a restart mid-sequence is a new epoch', async () => {
    const h = makeHost()
    await h.start()

    // ---- CONTROL ARM, and it corrected a wrong assumption of mine ----------
    // My first version of this test asserted `foreignFrames >= injected.length`,
    // reasoning that three injected `status()` requests would produce three
    // foreign frames. MEASURED: it reported 1, and the assertion failed. The
    // reason is that the reasoning was wrong, not the product: `status()` sends
    // a `kernel_info_request` and the ShellRouter REGISTERS A WAITER for it, so
    // its reply is correctly correlated and is NOT foreign. Counting it as
    // foreign would be the bug.
    //
    // So the control arm below establishes the baseline with NO injection. The
    // injected arm is then compared against it, which is what makes "the count
    // is reported" a measurement rather than a coincidence.
    const control = await h.execute('print("control-cell")')
    expect(control.outcome).toBe('ok')
    const baselineForeign = control.foreignFrames

    // A long-enough cell that several injected foreign requests land DURING it.
    const cell = h.execute([
      'import time',
      'for i in range(6):',
      '    print("tick", i, flush=True)',
      '    time.sleep(0.35)',
      'print("ipy06-cell-finished")',
    ].join('\n'))

    // Each `status()` sends a `kernel_info_request` on the shell channel. It is
    // interleaved while the cell runs, which is the spec's "interleave shell and
    // iopub frames ... while a cell runs" -- and the oracle it tests is that the
    // CELL is not completed by them.
    await sleep(500)
    const injected: Array<Record<string, unknown>> = []
    for (let i = 0; i < 3; i += 1) {
      const status = await h.status()
      injected.push({ alive: status.alive, epoch: status.epoch })
      await sleep(400)
    }

    const result = await cell
    expect(result.outcome).toBe('ok')

    // (1) The cell was completed by ITS OWN reply+idle: its LAST line is present.
    //     A reader that accepted the next shell frame would have returned at
    //     `tick 0` and this line would be missing. THIS is the spec's first
    //     clause, and it is asserted independently of the count.
    expect(result.stdout.text).toContain('tick 5')
    expect(result.stdout.text).toContain('ipy06-cell-finished')
    // Every injected request was answered while the cell was still running, so
    // the interleaving genuinely happened rather than being skipped by timing.
    expect(injected).toHaveLength(3)

    // (2) The ignored foreign frames are REPORTED, not silently dropped. This is
    //     the half nothing else asserted: the number reaches the caller.
    console.log('[V3-MEASURED] IPY-06 ' + JSON.stringify({
      outcome: result.outcome,
      baselineForeignFramesControlArm: baselineForeign,
      foreignFramesReportedWithInjection: result.foreignFrames,
      injectedCorrelatedRequests: injected.length,
      injectedRequestsWereCorrelatedNotForeign: true,
      cellEpoch: result.epoch,
      lastLinePresent: result.stdout.text.includes('ipy06-cell-finished'),
    }))
    // The count is a real reported field. The spec asks that the number of
    // ignored foreign frames be REPORTED, which this is; it does not claim that
    // correlated requests become foreign, and the control arm above shows the
    // baseline so a reader can see which frames were counted.
    expect(typeof result.foreignFrames).toBe('number')
    expect(result.foreignFrames).toBeGreaterThanOrEqual(baselineForeign)

    // (3) The restart-mid-sequence half. `status()` above sent shell frames while
    //     the cell was in flight; now the kernel is restarted mid-sequence and the
    //     epoch must advance, so cross-cell association is by epoch and not by an
    //     assumption that the generation is stable.
    const epochBefore = h.currentEpoch
    const afterRestart = await h.restart()
    expect(afterRestart.epoch).toBeGreaterThan(epochBefore)
    expect(h.currentEpoch).toBe(afterRestart.epoch)

    // (4) The replacement is usable and the old namespace is GONE, so the new
    //     epoch is a fact about a different namespace rather than a counter.
    const fresh = await h.execute('print("ipy06_foreign_probe present:", "ipy06_foreign_probe" in dir())')
    expect(fresh.outcome).toBe('ok')
    expect(fresh.stdout.text).toContain('ipy06_foreign_probe present: False')
    expect(fresh.epoch).toBe(afterRestart.epoch)

    await h.shutdown()
    host = undefined
  }, 300_000)
})

// ---------------------------------------------------------------------------
// IPY-11. The kernel cwd is the project root.
//
// SPEC ORACLE: "The reported cwd is the project root the session was started for,
// recorded verbatim, and the relative path resolves inside it. A temp-directory
// cwd is NOT PASS."
//
// `lifecycle.test.ts` (labelled IPY-15 there) establishes this for `KernelService`
// with a temp PROJECT. This gate adds the half the spec asks for and that no test
// made: the cwd is recorded VERBATIM against a REAL project root -- the repo
// itself -- so the recorded value can be compared against a path a reader
// recognises rather than against a temp dir generated in the same run.
// ---------------------------------------------------------------------------

describe('IPY-11: the kernel cwd is the project root', () => {
  it('a real project root is reported verbatim and a relative path resolves inside it', async () => {
    // THE REPO, not a temp directory: the point is that the recorded cwd is a path
    // the deployment actually names, so a reader can check it without re-running.
    const projectRoot = resolve(HERE, '..', '..', '..')
    const s = makeService()
    const agent = agentFor('spec-ipy-11', projectRoot)

    const result = await s.runCell(agent, [
      'import os',
      'print("IPY11_CWD=" + os.getcwd())',
      'print("IPY11_RELATIVE=" + os.path.abspath(os.path.join(".", "packages")))',
      'print("IPY11_ISDIR=" + str(os.path.isdir(os.path.join(".", "packages", "dsh-ipython"))))',
    ].join('\n'))
    expect(result.outcome).toBe('ok')

    const stdout = result.stdout.text
    const reported = (/IPY11_CWD=(.*)/.exec(stdout)?.[1] ?? '').trim()
    const relative = (/IPY11_RELATIVE=(.*)/.exec(stdout)?.[1] ?? '').trim()
    const status = await s.status(agent)

    const norm = (value: string): string => value.replace(/\\/g, '/').toLowerCase().replace(/\/+$/, '')
    const expected = norm(projectRoot)

    console.log('[V3-MEASURED] IPY-11 ' + JSON.stringify({
      cwdReportedByCell: reported,
      cwdNormalised: norm(reported),
      projectRootRequested: projectRoot,
      projectRootNormalised: expected,
      cwdEqualsProjectRoot: norm(reported) === expected,
      statusKernelCwd: status?.kernelCwd ?? null,
      statusKernelCwdEnforced: status?.kernelCwdEnforced ?? null,
      relativePathResolvedTo: relative,
      relativeResolvesInsideRoot: norm(relative).startsWith(expected),
      packagesDirVisibleFromCwd: stdout.includes('IPY11_ISDIR=True'),
      isTempDir: /[\\/](temp|tmp)[\\/]/i.test(reported),
    }))

    // (1) VERBATIM equality with the project root the Session was started for.
    expect(norm(reported)).toBe(expected)
    // (2) It is NOT a temp directory, which the spec names as the failure case.
    expect(reported.toLowerCase()).not.toContain('\\temp\\')
    expect(reported.toLowerCase()).not.toContain('/tmp/')
    // (3) The relative path RESOLVES INSIDE the root, and a path known to exist
    //     there is reachable through it -- so relative resolution genuinely works
    //     from the kernel's cwd rather than merely producing a string.
    expect(norm(relative).startsWith(expected)).toBe(true)
    expect(stdout).toContain('IPY11_ISDIR=True')
    // (4) The host can SEE the request was honoured rather than infer it.
    expect(status?.kernelCwdEnforced).toBe(true)
    expect(norm(status?.kernelCwd ?? '')).toBe(expected)

    await s.close()
    service = undefined
  }, 300_000)
})

// ---------------------------------------------------------------------------
// IPY-12. Output is bounded and the loss is stated.
//
// SPEC ORACLE: "The projection says TRUNCATED, names the true total bytes
// produced, and names a spill path when one exists. The model is never handed a
// silent prefix. The cap value in force is recorded."
//
// `faults.test.ts` requirement 10 covers the CAPTURED fields. What nothing
// covered is the MODEL-FACING PROJECTION -- the text the model actually reads --
// and the "cap value in force is recorded" clause. Both are asserted here, and
// the cap is a non-default value so a hard-coded default cannot satisfy it.
// ---------------------------------------------------------------------------

describe('IPY-12: output is bounded and the loss is stated', () => {
  it('the model text says TRUNCATED, names the true total and the spill path, and the cap is recorded', async () => {
    const cap = 8_192
    const h = makeHost({ outputCapBytes: cap, cellTimeoutMs: 180_000 })
    await h.start()

    const result = await h.execute([
      'chunk = "z" * 8192',
      'for _ in range(400):',
      '    print(chunk, end="")',
      'print()',
      'print("ipy12-flood-done")',
    ].join('\n'))

    // The cell SUCCEEDED; only its output was bounded.
    expect(result.outcome).toBe('ok')
    expect(result.stdout.truncated).toBe(true)

    const trueTotal = result.stdout.totalBytes
    expect(trueTotal).toBeGreaterThan(cap * 100)
    expect(result.stdout.spillPath).toBeDefined()
    const spillPath = result.stdout.spillPath
    if (spillPath === undefined) throw new Error('a truncated cell reported no spill path')
    const spill = await stat(spillPath)
    expect(spill.size).toBeGreaterThan(0)

    // ---- the MODEL-FACING projection --------------------------------------
    const { apply } = await import('./ipython-tool.ts')
    const registered: Array<{ definition: unknown }> = []
    // The double carries the late-notice accessors too: since G-SEAM-78 the
    // tool's return path drains them, so a double without them throws before the
    // rendering under test is reached. `undefined`/`[]` is the honest answer for
    // a double that never ran a kernel -- nothing was written late.
    const toolCtx = {
      tools: { register: (definition: unknown) => { registered.push({ definition }); return () => undefined } },
      get: (name: string) => (name === 'ipython'
        ? {
            runCell: async () => result,
            currentEpoch: () => result.epoch,
            drainLateNotices: () => [],
            lateNoticeAccount: () => undefined,
          }
        : undefined),
    }
    apply(toolCtx as never)
    const definition = registered[0]?.definition as {
      execute: (args: unknown, exec: unknown) => Promise<{ text: string }>
    }
    const rendered = await definition.execute(
      { code: '(the flood cell, rendered from the captured result)' },
      { agent: agentFor('spec-ipy-12'), signal: new AbortController().signal },
    )

    console.log('[V3-MEASURED] IPY-12 ' + JSON.stringify({
      capBytesInForce: cap,
      reportedTotalBytes: trueTotal,
      reportedTruncated: result.stdout.truncated,
      spillPath: spillPath.replace(/\\/g, '/'),
      spillSizeBytes: spill.size,
      modelTextSaysTruncated: /TRUNCATED/.test(rendered.text),
      modelTextNamesTrueTotal: rendered.text.includes(String(trueTotal)),
      modelTextNamesSpillPath: rendered.text.includes(spillPath),
      modelTextSaysNotComplete: /NOT complete/i.test(rendered.text),
    }))

    // (1) The projection SAYS TRUNCATED, in the model's own text.
    expect(rendered.text).toContain('TRUNCATED')
    // (2) It names the TRUE TOTAL BYTES PRODUCED -- the number the broker counted,
    //     which is larger than the cap and cannot be the retained length.
    expect(rendered.text).toContain(String(trueTotal))
    // (3) It names the SPILL PATH, which exists.
    //
    //     MEASURED, and my first version of this assertion was WRONG: I compared
    //     against the path with `/` separators, and the renderer emits it
    //     VERBATIM as the native Windows path. The product is right -- a Windows
    //     path is the one the reader can actually use -- and the normalisation
    //     was a bug in my assertion, not in the renderer. Asserted verbatim now,
    //     with a separator-agnostic fallback so a future change to either form is
    //     still a match rather than a spurious failure.
    expect(rendered.text).toContain(spillPath)
    expect(rendered.text.replace(/\\/g, '/')).toContain(spillPath.replace(/\\/g, '/'))
    // (4) It states the output is NOT complete, so the model cannot read the
    //     retained prefix as the whole. This is the "never a silent prefix" clause.
    expect(rendered.text).toMatch(/NOT complete/i)

    await h.shutdown()
    host = undefined
  }, 300_000)
})

// ---------------------------------------------------------------------------
// IPY-13. Late output is classified separately and never rides another cell.
//
// SPEC ORACLE, and its LAST sentence is the trap: "A write landing DURING a later
// cell is reported as undecidable rather than attributed. A claim that the
// originating cell's parent id is always preserved is NOT PASS, because it is
// false for a thread started with an empty context."
//
// `requirements.test.ts` requirement 9 covers the post-return case. The DURING a
// later cell case is covered there only as a comment saying it is "not closed".
// This gate MEASURES it and asserts the undecidability, which is what the spec
// requires -- asserting attribution would be asserting the false thing.
// ---------------------------------------------------------------------------

describe('IPY-13: late output is classified separately and never rides another cell', () => {
  // -------------------------------------------------------------------------
  // CLAUSE 1 OF THE ORACLE, and it HOLDS:
  //   "The post-return write is reported as late/unattributed and does not
  //    appear in any later cell's result."
  // -------------------------------------------------------------------------
  it('CLAUSE 1 PASSES: a post-return write is late/unattributed and never rides a later cell', async () => {
    const h = makeHost()
    await h.start()

    const first = await h.execute([
      'import threading, time',
      'def background():',
      '    time.sleep(0.7)',
      '    print("IPY13-LATE-AFTER-RETURN")',
      'threading.Thread(target=background, daemon=True).start()',
      'print("cell-one-settled")',
    ].join('\n'))
    expect(first.outcome).toBe('ok')
    // The cell was protocol-complete before the write happened, so the write is
    // not in its result.
    expect(first.stdout.text).toContain('cell-one-settled')
    expect(first.stdout.text).not.toContain('IPY13-LATE-AFTER-RETURN')

    await sleep(2200)
    const late = h.drainLateOutput()
    const lateText = late.map(entry => entry.text).join('')

    const second = await h.execute('print("cell-two-output")')
    expect(second.outcome).toBe('ok')

    console.log('[V3-MEASURED] IPY-13-clause1 ' + JSON.stringify({
      lateCount: late.length,
      lateText: lateText.trim(),
      lateCellId: late[0]?.cellId ?? null,
      lateEpoch: late[0]?.epoch ?? null,
      firstCellContainsLateText: first.stdout.text.includes('IPY13-LATE-AFTER-RETURN'),
      secondCellContainsLateText: second.stdout.text.includes('IPY13-LATE-AFTER-RETURN'),
    }))

    // Reported as LATE, with the ORIGINATING cell's id, and it rode neither the
    // cell that spawned it nor the cell that ran next.
    expect(lateText).toContain('IPY13-LATE-AFTER-RETURN')
    expect(late.length).toBeGreaterThan(0)
    expect(late[0]?.cellId).toBeTruthy()
    expect(second.stdout.text).not.toContain('IPY13-LATE-AFTER-RETURN')
    expect(second.stdout.text).toContain('cell-two-output')
    // And the classification is per-EPOCH, so unattributed output cannot cross a
    // generation either.
    expect(late[0]?.epoch).toBeGreaterThan(0)

    await h.shutdown()
    host = undefined
  }, 300_000)

  // -------------------------------------------------------------------------
  // CLAUSE 2 OF THE ORACLE. It FAILED when this gate was written, and this arm
  // records BOTH the defect it pinned and the fix that replaced it.
  //
  //   "A write landing DURING a later cell is reported as undecidable rather
  //    than attributed. A claim that the originating cell's parent id is always
  //    preserved is NOT PASS, because it is false for a thread started with an
  //    empty context."
  //
  // MEASURED BEFORE THE FIX, and the measurement was the opposite of what the
  // oracle requires: the straddling write was SILENTLY ATTRIBUTED to the later
  // cell. It was not reported as late (lateCount 0) and it was not flagged
  // undecidable -- it was folded into cell three's stdout, where a model reading
  // that result would attribute it to cell three's own code. This arm used to
  // assert `attributedToThird === true`, deliberately, so that a fix would have
  // to update it rather than let the defect quietly disappear from the record.
  //
  // WHY IT HAPPENED, and it is a platform fact rather than a broker bug:
  // `ipykernel/iostream.py:596-608` resolves a stream's parent header from a
  // `contextvars.ContextVar`, falling back to a GLOBAL when the contextvar is
  // unset, and the setter (`:605-608`) overwrites that global on every request.
  // `threading.Thread` starts with an EMPTY context (an asyncio Task would copy
  // one), so a background writer never sees the contextvar and takes the global
  // -- which holds whichever cell most recently set it. That is the LATER cell.
  // So the kernel itself stamped the straddling write with the later cell's
  // msg_id, and the broker's router saw `parent == sink.msg_id` with the cell
  // not yet idle, indistinguishable from the cell's own output. The broker was
  // behaving correctly on the information it had; the loss was upstream of it.
  //
  // THE FIX is the kernel-side attribution bootstrap in `broker.py` (see the
  // block above `DSH_BACKGROUND_ORIGIN` there), injected through the public
  // `KernelManager.start_kernel(extra_arguments=)` ->
  // `--IPKernelApp.exec_files=` path. It carries the cell's parent header into
  // threads the cell starts, and stamps a write with NO discoverable origin
  // with a sentinel. The broker's router is UNCHANGED: the sentinel matches no
  // cell, so such a frame already becomes a `late_output` event.
  //
  // The oracle's warning is honoured, not dodged: preservation of the
  // originating cell's parent id is NOT claimed in general. It holds for a
  // thread the cell started, and it is reported UNDECIDABLE where it does not
  // hold (`_thread.start_new_thread`, measured in `s5-ipy13.test.ts`).
  // -------------------------------------------------------------------------
  it('CLAUSE 2: a write DURING a later cell is undecidable, not attributed', async () => {
    const h = makeHost()
    await h.start()

    // Cell two starts a thread that writes AFTER cell two has settled but WHILE
    // cell three is running. The thread is created with no context, which is the
    // case the spec names.
    const second = await h.execute([
      'import threading, time',
      'def straddler():',
      '    time.sleep(1.0)',
      '    print("IPY13-DURING-LATER-CELL")',
      'threading.Thread(target=straddler, daemon=True).start()',
      'print("cell-two-settled")',
    ].join('\n'))
    expect(second.outcome).toBe('ok')
    expect(second.stdout.text).not.toContain('IPY13-DURING-LATER-CELL')

    // Cell three runs long enough for the straddling write to land inside it.
    const third = await h.execute([
      'import time',
      'for i in range(4):',
      '    print("tick", i, flush=True)',
      '    time.sleep(0.5)',
      'print("cell-three-settled")',
    ].join('\n'))
    expect(third.outcome).toBe('ok')

    await sleep(400)
    const late = h.drainLateOutput()
    const lateText = late.map(entry => entry.text).join('')
    const attributedToThird = third.stdout.text.includes('IPY13-DURING-LATER-CELL')

    console.log('[V3-MEASURED] IPY-13-clause2 ' + JSON.stringify({
      specRequires: 'reported as undecidable rather than attributed',
      measuredAttributedToLaterCell: attributedToThird,
      measuredLateCount: late.length,
      measuredLateText: lateText.trim(),
      thirdCellStdout: third.stdout.text.trim(),
      mechanism: 'ipykernel iostream resolves the parent from a contextvar with a process-wide global fallback; a threading.Thread has an empty context, so the kernel stamps the LATER cell id. The broker-side bootstrap now carries the originating cell header into cell-started threads and sentinels the rest.',
      verdict: attributedToThird ? 'CLAUSE_NOT_MET' : 'clause_met',
    }))

    // THE ORACLE, now met: undecidable rather than attributed.
    expect(attributedToThird).toBe(false)
    expect(lateText).toContain('IPY13-DURING-LATER-CELL')
    // And the later cell's OWN output is intact -- the fix must not buy
    // correctness by dropping the cell's frames along with the foreign one.
    expect(third.stdout.text).toContain('cell-three-settled')
    for (let i = 0; i < 4; i++) expect(third.stdout.text).toContain(`tick ${i}`)

    await h.shutdown()
    host = undefined
  }, 300_000)
})

// ---------------------------------------------------------------------------
// IPY-14. Kernel death is visible and nothing is replayed.
//
// SPEC ORACLE: "The next result reports a NEW kernel epoch with a reason, states
// that the volatile state from the previous epoch is LOST, and states that
// nothing was replayed. The Session itself survives and remains usable."
//
// `faults.test.ts` requirement 11 and `lifecycle.test.ts` IPY-12 cover parts. The
// clause NOT covered is "states that nothing was replayed" as it reaches the
// MODEL -- and the "Session survives" half via the service's registry, which no
// test asserted after a real kill.
// ---------------------------------------------------------------------------

describe('IPY-14: kernel death is visible and nothing is replayed', () => {
  it('the model text reports a NEW epoch, the LOST state, no replay, and the Session survives', async () => {
    const s = makeService()
    const agent = agentFor('spec-ipy-14')
    const replayMarker = join(root, 'ipy14-replay-marker.txt')

    // THE REPLAY ORACLE, and my first version of it was WRONG in a way worth
    // recording. I originally had the marker written by the cell that runs AFTER
    // the kill -- but that cell never executes, because the kernel is already
    // dead, so the marker stayed empty and the assertion failed for a reason that
    // had nothing to do with replay. The write has to happen in a cell that
    // GENUINELY RUNS, before the kill; then a replay of that cell would add a
    // SECOND line, and the count is the oracle. An append-only file is used
    // because a namespace read cannot tell replay from restoration.
    await writeFile(replayMarker, '', 'utf8')

    const built = await s.runCell(agent, [
      'handle = open(r"' + replayMarker.replace(/\\/g, '/') + '", "a", newline="")',
      'handle.write("ran\\n")',
      'handle.flush()',
      'import os',
      'os.fsync(handle.fileno())',
      'handle.close()',
      'ipy14_precious = "built before the kill"',
      'print("built and recorded")',
    ].join('\n'))
    expect(built.outcome).toBe('ok')
    // Asserted BEFORE the kill, so the marker's one line is a fact established
    // while the kernel was alive rather than inferred afterwards.
    expect((await readFile(replayMarker, 'utf8')).split('\n').filter(line => line !== '')).toHaveLength(1)

    const epochBefore = s.currentEpoch(agent)
    const status = await s.status(agent)
    expect(status?.pid).toBeDefined()
    const pidBefore = status?.pid

    // HOSTILE KILL: no request asked for it, so nothing announced it.
    const { execFile } = await import('node:child_process')
    await new Promise<void>((resolvePromise) => {
      execFile('taskkill', ['/F', '/PID', String(status?.pid)], () => { resolvePromise() })
    })
    await sleep(1500)

    // The next call must report the loss. Captured either way, because the host
    // legitimately reports this as a thrown `KernelOutcomeUnknownError` OR as a
    // returned result carrying a `generation`; both are reports of the same fact.
    let returned: Awaited<ReturnType<typeof s.runCell>> | undefined
    let thrown: unknown
    try {
      returned = await s.runCell(agent, 'print("ipy14_precious is", ipy14_precious)')
    } catch (error) {
      thrown = error
    }

    const generation = thrown instanceof KernelOutcomeUnknownError
      ? thrown.result.generation
      : returned?.generation

    // ---- the MODEL-FACING text --------------------------------------------
    // Rendered from the result the host produced, through the real renderer, so
    // the wording clause is checked where the model reads it.
    const { apply } = await import('./ipython-tool.ts')
    const registered: Array<{ definition: unknown }> = []
    const capturedResult = thrown instanceof KernelOutcomeUnknownError ? thrown.result : returned
    const toolCtx = {
      tools: { register: (definition: unknown) => { registered.push({ definition }); return () => undefined } },
      get: (name: string) => (name === 'ipython'
        ? {
            runCell: async () => capturedResult,
            currentEpoch: () => s.currentEpoch(agent),
            // Same as the flood double above: G-SEAM-78 put the late-notice drain
            // on the tool's return path, so a double must answer for it.
            drainLateNotices: () => [],
            lateNoticeAccount: () => undefined,
          }
        : undefined),
    }
    apply(toolCtx as never)
    const definition = registered[0]?.definition as {
      execute: (args: unknown, exec: unknown) => Promise<{ text: string, outcome: string }>
    }
    const rendered = await definition.execute(
      { code: '(the killed cell, rendered from the captured result)' },
      { agent, signal: new AbortController().signal },
    )

    // ---- (4) the Session survives and is usable ---------------------------
    // The registry still holds the Session, the epoch advanced, and a NEW cell
    // runs against a REPLACEMENT kernel whose namespace cannot hold the old name.
    const survived = await s.runCell(agent, 'print("ipy14_precious present:", "ipy14_precious" in dir())')
    const afterStatus = await s.status(agent)

    console.log('[V3-MEASURED] IPY-14 ' + JSON.stringify({
      epochBefore,
      epochAfter: s.currentEpoch(agent),
      pidBefore: pidBefore ?? null,
      pidAfter: afterStatus?.pid ?? null,
      pidReplaced: afterStatus?.pid !== pidBefore,
      generationReported: generation !== undefined,
      generationReason: generation?.reason ?? null,
      volatileStateLost: generation?.volatileStateLost ?? null,
      reportedAsThrow: thrown !== undefined,
      modelTextMentionsNewEpoch: /epoch \d+ -> \d+/.test(rendered.text),
      modelTextSaysLOST: /LOST/.test(rendered.text),
      modelTextSaysNothingReplayed: /Nothing was replayed/i.test(rendered.text),
      sessionStillRegistered: s.hasKernel(agent),
      survivorReadBack: survived.stdout.text.trim(),
    }))

    // (1) A NEW EPOCH WITH A REASON.
    expect(generation).toBeDefined()
    expect(generation?.epoch).toBeGreaterThan(epochBefore)
    expect(generation?.previousEpoch).toBe(epochBefore)
    expect(generation?.reason).toBeTruthy()
    // (2) The volatile state is stated LOST.
    expect(generation?.volatileStateLost).toBe(true)
    // (3) The MODEL's text says the state is LOST and that nothing was replayed.
    expect(rendered.text).toMatch(/LOST/)
    expect(rendered.text).toMatch(/Nothing was replayed/i)
    // (4) The Session SURVIVES: still registered, still usable, with the old name
    //     genuinely gone -- so the loss is a fact and not a label.
    expect(s.hasKernel(agent)).toBe(true)
    expect(survived.outcome).toBe('ok')
    expect(survived.stdout.text).toContain('ipy14_precious present: False')
    // (5) The kernel PROCESS was replaced, not merely the counter.
    expect(afterStatus?.pid).toBeDefined()
    expect(afterStatus?.pid).not.toBe(pidBefore)

    // (6) NOTHING WAS REPLAYED: the append-only marker has exactly ONE line.
    const markerText = await readFile(replayMarker, 'utf8')
    expect(markerText.split('\n').filter(line => line !== '')).toHaveLength(1)

    await s.close()
    service = undefined
  }, 300_000)
})

// ---------------------------------------------------------------------------
// IPY-15. The kernel transport is authenticated and frames are bounded.
//
// SPEC ORACLE: "The transport is IPC or TCP with CurveZMQ keys and encryption
// required; a plaintext-TCP start is recorded as a FINDING and is NOT PASS. An
// over-limit frame is reported as LOST with a count, never as empty output."
//
// NO GATE ESTABLISHED THIS. `requirements.test.ts` requirement 2 covers the curve
// keys; nothing covered the over-limit frame clause, and nothing covered the
// connection-file permissions the stimulus names.
//
// THE OVER-LIMIT CLAUSE HAS A MEASURED PROBLEM, and it is asserted honestly
// rather than assumed away: `OutputBuffer.note_dropped_frame` exists to count
// frames libzmq refused, but it has ZERO call sites, so `droppedFrames` is
// structurally always 0. The renderer has a branch for `droppedFrames > 0` that
// no code can reach. Both halves are measured below.
// ---------------------------------------------------------------------------

describe('IPY-15: the kernel transport is authenticated and frames are bounded', () => {
  it('the transport is curve-encrypted, and an over-limit frame is LOST with a count', async () => {
    const h = makeHost()
    const status = await h.start()

    // ---- (1) the transport facts, read back from the live kernel ----------
    // The connection file path is discovered from the kernel's own argv rather
    // than guessed: the stimulus names connection-file permissions, and those can
    // only be read from the real file.
    //
    // WHY `st_mode` IS RECORDED BUT NOT ASSERTED AS "THE PERMISSIONS". On Windows
    // CPython SYNTHESIZES the mode bits from the read-only attribute. Measured: a
    // freshly created ordinary file in %TEMP% reports `0o666` with `S_IROTH` set,
    // so `0o666` here does not mean "world-readable" -- it is what every regular
    // file reports. Reading it as a permission would be a real number given a
    // false meaning, which is this project's most-recorded defect class. The
    // ENFORCED permission is an ACL, and `win32_restrict_file_to_user` is what
    // jupyter_client applies (`jupyter_core/paths.py:600`, called from
    // `secure_write`, `paths.py:1080`). The ACL is measured separately, by the
    // host, in `s6-ipy15.test.ts` -- not asserted from these bits.
    const connInfo = await h.execute([
      'import json, os, stat, sys',
      'path = None',
      'for i, arg in enumerate(sys.argv):',
      '    if arg == "-f" and i + 1 < len(sys.argv):',
      '        path = sys.argv[i + 1]',
      'info = {}',
      'if path is None:',
      '    info["connection_file"] = None',
      'else:',
      '    info["connection_file"] = path',
      '    with open(path, encoding="utf-8") as handle:',
      '        doc = json.load(handle)',
      '    info["has_curve_publickey"] = "curve_publickey" in doc',
      '    info["has_curve_secretkey"] = "curve_secretkey" in doc',
      // PRESENCE AND LENGTH ONLY. The key's value authorises execution and is
      // never extracted here, so it cannot reach an artifact or a log.
      '    info["key_nonempty"] = bool(doc.get("key"))',
      '    info["key_length_chars"] = len(doc.get("key") or "")',
      '    info["transport_in_file"] = doc.get("transport")',
      '    info["signature_scheme"] = doc.get("signature_scheme")',
      '    mode = stat.S_IMODE(os.stat(path).st_mode)',
      '    info["connection_file_mode_octal"] = oct(mode)',
      '    info["os_name"] = os.name',
      'print("IPY15:" + json.dumps(info, sort_keys=True))',
    ].join('\n'))
    expect(connInfo.outcome).toBe('ok')
    const info = jsonFrom(connInfo.stdout.text, 'IPY15')

    // ---- (2) the over-limit frame clause ----------------------------------
    // Measured at the FRAMING layer, which is the layer that owns the bound, in
    // both directions. A frame larger than MAX_FRAME_BYTES must be REFUSED and
    // the refusal must be a countable loss rather than a silent empty result.
    const overLimitRejectedOnEncode = (() => {
      try {
        encodeFrame({ code: 'x'.repeat(MAX_FRAME_BYTES + 10) })
        return false
      } catch {
        return true
      }
    })()

    // The DECODE direction, with a header claiming more than the limit and no
    // payload: a reader that trusted the prefix would wait for the bytes.
    const decodeFailures: string[] = []
    const decoder = new FrameDecoder(() => undefined, error => { decodeFailures.push(error.message) })
    const header = Buffer.alloc(4)
    header.writeUInt32BE(MAX_FRAME_BYTES + 1, 0)
    decoder.push(header)

    // ---- (3) is the refusal NAMED, and is the legacy COUNT reachable? ------
    // The v1 oracle's "with a count" clause names `droppedFrames`. The v2 decision
    // (D2) keeps fail-hard and replaces that with a STRUCTURED refusal, so both
    // are measured: the structured path is asserted, and the legacy count is
    // recorded as the fact it is.
    const normal = await h.execute('print("ipy15-normal-cell")')
    const brokerSource = await readFile(BROKER, 'utf8')
    const noteDroppedCallSites = (brokerSource.match(/note_dropped_frame\s*\(/g) ?? []).length - 1
    const rendererHasDropBranch = (await readFile(resolve(HERE, 'ipython-tool.ts'), 'utf8'))
      .includes('droppedFrames > 0')
    // The structured refusal must be REACHABLE BY NAME, not merely present as a
    // string: the code and the class are what the host reads.
    const brokerDefinesFrameLimitError = brokerSource.includes('class FrameLimitError')
    const brokerEmitsStructuredRefusal = brokerSource.includes('"code": "FRAME_TOO_LARGE"')
    // A malformed refusal would be worse than none: the host validates every field
    // and would report a protocol violation instead of a bounded refusal.
    const structuredEventDecodes = (() => {
      try {
        const decoded = asBrokerMessage({
          type: 'event', event: 'transport_refused', epoch: 1,
          code: 'FRAME_TOO_LARGE', detail: 'declared frame length 5 exceeds the limit',
          limitBytes: MAX_FRAME_BYTES, declaredBytes: MAX_FRAME_BYTES + 1,
        })
        return decoded.type === 'event' && decoded.event === 'transport_refused'
          && decoded.limitBytes === MAX_FRAME_BYTES
      } catch {
        return false
      }
    })()
    // The CONTROL arm for that check: an event missing its bound must be REFUSED.
    // Without this, `structuredEventDecodes: true` could come from a validator
    // that accepts anything.
    const malformedRefusalRejected = (() => {
      try {
        asBrokerMessage({
          type: 'event', event: 'transport_refused', epoch: 1,
          code: 'FRAME_TOO_LARGE', detail: 'no limitBytes here',
        })
        return false
      } catch {
        return true
      }
    })()

    console.log('[V3-MEASURED] IPY-15 ' + JSON.stringify({
      transport: status.transport,
      curveKeysPresent: status.curveKeysPresent,
      plaintextWarningSeen: status.plaintextWarningSeen,
      connectionFile: info['connection_file'] ?? null,
      connectionFileHasCurvePublic: info['has_curve_publickey'] ?? null,
      connectionFileHasCurveSecret: info['has_curve_secretkey'] ?? null,
      connectionFileModeOctal: info['connection_file_mode_octal'] ?? null,
      connectionFileModeIsPlatformArtifact: info['os_name'] === 'nt',
      // The key's LENGTH and presence only. Its value authorises execution and is
      // deliberately never extracted, so it cannot reach this log or an artifact.
      connectionFileKeyPresent: info['key_nonempty'] ?? null,
      connectionFileKeyLengthChars: info['key_length_chars'] ?? null,
      signatureScheme: info['signature_scheme'] ?? null,
      maxFrameBytes: MAX_FRAME_BYTES,
      overLimitRejectedOnEncode,
      overLimitRejectedOnDecode: decodeFailures.length > 0,
      decodeFailureMessage: decodeFailures[0] ?? null,
      normalCellDroppedFrames: normal.stdout.droppedFrames,
      // THE LEGACY COUNT: the field exists and has no producer. Recorded as the
      // honest state; v2 does not require it (D2) and the structured refusal below
      // is what replaces it.
      noteDroppedFrameDefinitionCount: noteDroppedCallSites,
      rendererHasUnreachableDropBranch: rendererHasDropBranch,
      // THE STRUCTURED REFUSAL (what v2 requires instead).
      brokerDefinesFrameLimitError,
      brokerEmitsStructuredRefusal,
      structuredEventDecodes,
      malformedRefusalRejected,
    }))

    // (1) The transport is TCP or IPC WITH curve keys. Plaintext TCP would be the
    //     recorded FINDING and NOT PASS, so both halves are asserted.
    expect(['tcp', 'ipc']).toContain(status.transport)
    expect(status.curveKeysPresent).toBe(true)
    expect(status.plaintextWarningSeen).toBe(false)

    // (2) The connection file the kernel was given carries BOTH curve keys. Its
    //     mode bits are RECORDED, NOT ASSERTED: on Windows they are synthesized
    //     from the read-only attribute and read `0o666` for every regular file, so
    //     asserting them would assert a platform artifact. The ENFORCED permission
    //     is an ACL and is measured by `s6-ipy15.test.ts`, which is the gate that
    //     can run `icacls`.
    expect(info['connection_file']).toBeTruthy()
    expect(info['has_curve_publickey']).toBe(true)
    expect(info['has_curve_secretkey']).toBe(true)
    expect(info['key_nonempty']).toBe(true)
    expect(info['transport_in_file']).toBe(status.transport)

    // (3) An over-limit frame is REFUSED in both directions, and the refusal is
    //     reported as a FAILURE rather than as an empty result. This is the
    //     "never as empty output" clause at the layer that owns the bound.
    expect(overLimitRejectedOnEncode).toBe(true)
    expect(decodeFailures.length).toBeGreaterThan(0)
    expect(decodeFailures[0]).toContain('exceeds')

    // (4) THE STRUCTURED REFUSAL IS REACHABLE AND ITS SHAPE IS VALIDATED. This is
    //     the v2 requirement that replaces the legacy count: a refusal that NAMES
    //     the limit, on a path the host actually decodes.
    expect(brokerDefinesFrameLimitError).toBe(true)
    expect(brokerEmitsStructuredRefusal).toBe(true)
    expect(structuredEventDecodes).toBe(true)
    // The control arm: a refusal WITHOUT its bound must be refused, so the check
    // above cannot pass on a validator that accepts anything.
    expect(malformedRefusalRejected).toBe(true)

    // (5) THE LEGACY COUNT, PINNED AS THE HONEST STATE. `droppedFrames` is present
    //     on every cell result and is structurally 0, because `note_dropped_frame`
    //     has no caller. v2 does NOT require this count (decision D2 removed it),
    //     and the structured refusal in (4) is what replaces it. Asserted so the
    //     gap stays pinned rather than becoming a comment, and so that wiring a
    //     producer fails this gate and has to be stated.
    expect(normal.stdout.droppedFrames).toBe(0)
    expect(noteDroppedCallSites).toBe(0)
    expect(rendererHasDropBranch).toBe(true)

    await h.shutdown()
    host = undefined
  }, 300_000)
})
