/**
 * P4 / G-SEAM-77 — the `dsh.data` ROUTING BRANCH, driven through a REAL kernel.
 *
 * THE CLAIM UNDER TEST. A `data:*` frame arriving on the ONE bridge is
 * dispatched to a SECOND internal dispatcher on the SAME `CellLease`, and a
 * `data:*` operation the plane does not know is a DATA-PLANE error that NEVER
 * falls through to `ctx.tools.execute`.
 *
 * WHY THIS FILE EXISTS AND WHY IT IS NOT `data-r6.test.ts`. That file drives
 * `routeDataRequest` DIRECTLY, with a caller it constructs, so it proves the
 * router works and proves nothing about whether the product can enter it. The
 * measured defect (`G-SEAM-77`) is exactly that gap: `grep -c 'data:' bridge.ts`
 * returned 0, so no frame could ever reach the router. This file drives the
 * bridge, so the subject is the SEAM and not the router.
 *
 * WHAT IS REAL HERE. A real `BridgeServer` on a real loopback port, a real
 * `CellLease`, a real ipykernel through the real broker, and a real
 * `ToolRuntime` — so "did it reach the tool lane" is answered by the registry's
 * own listener rather than by the bridge's account of itself.
 *
 * THE INSTRUMENT IS NEGATIVE-CAPABLE, and the arms below are the failing
 * directions rather than decoration:
 *   - an UNKNOWN `data:*` op must be a data-plane refusal, and the registry
 *     listener must show that NOTHING reached the pipeline (a fall-through would
 *     put the name in `seenByPipeline` and the arm goes red);
 *   - a lease with NO data handler must refuse `data:*` rather than fall back to
 *     the tool lane, which is the property that has to hold even when the
 *     composition is wrong;
 *   - the SAME lease must still serve `dsh.call` normally, so a passing data arm
 *     cannot be explained by the lease having stopped working.
 *
 * WHAT THIS FILE DOES NOT CLAIM. It drives a HAND-MOUNTED bridge, so it
 * establishes the SEAM. The assembled product path (a real boot, the profile's
 * own rows, the `ipython` tool through the real registry) is a different tier and
 * is measured elsewhere. A green arm here is not a product-reachability claim.
 */
import { Context } from '@deepseek-ai/cordis'
import Subprocess from '@deepseek-ai/dsh-subprocess-local'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import {
  BridgeServer,
  DATA_TOOL_PREFIX,
  isDataRequest,
  renderBridgePreamble,
  type DataCallHandler,
  type NativeCallOutcome,
} from './bridge.ts'
import { MemoryBridgeLedger } from './bridge-ledger.ts'
import { createNativeCallHandler, type EnclosingAuthority } from './native-call.ts'
import { KernelService } from './kernel-plugin.ts'

const PYTHON = process.env.DSH_PYTHON ?? 'C:/Users/hzq00/AppData/Local/Programs/Python/Python314/python.exe'
const HERE = dirname(fileURLToPath(import.meta.url))
const BROKER = resolve(HERE, 'broker.py')

/** A marker only the registry's own value can carry, so the cell cannot fake it. */
const ECHO_MARKER = 'p4-routing-echo'

interface PipelineEntry { readonly name: string }

let cleanup: Array<() => Promise<void>> = []

afterEach(async () => {
  const pending = cleanup
  cleanup = []
  for (const dispose of pending.reverse()) await dispose().catch(() => undefined)
})

function agentFor(sessionId: string, cwd: string): Agent {
  return {
    session: { header: { id: sessionId, cwd } },
  } as unknown as Agent
}

/** The live tool authority a real `ipython` execution would supply. */
function authorityFor(agent: Agent, signal: AbortSignal): EnclosingAuthority {
  return {
    callId: 'ipython-call-1',
    rootCallId: 'ipython-call-1',
    // Only the registry can mint a real token; this file asserts nothing about
    // its contents, and a fabricated symbol is enough for the scheduler.
    token: Symbol('probe-token') as never,
    agent,
    signal,
  }
}

describe('P4 [real kernel] the bridge routes data:* to a second dispatcher and never to ToolRuntime', () => {
  it('serves a data:* call on the data lane, refuses an unknown data:* op as a DATA error, and keeps dsh.call intact', async () => {
    const root = await mkdtemp(join(tmpdir(), 'p4-routing-'))
    const ctx = new Context()
    const seenByPipeline: PipelineEntry[] = []

    await ctx.plugin(SystemPrompt, { personaPrefix: '' })
    await ctx.plugin(ToolRuntime, { mode: 'native', maxParallelSubCalls: 10 })
    await ctx.plugin(Subprocess)
    // The REGISTRY-SIDE observation. A call that reached `ctx.tools.execute` is
    // recorded here, so "did the data lane fall through to the tool lane" is
    // answered by the pipeline and not by the bridge.
    ctx.on('tools/pre-execute', (exec, next) => {
      seenByPipeline.push({ name: exec.name })
      return next()
    })
    ctx.tools.register(defineTool({
      name: 'probe_echo',
      description: 'Returns a fixed marker object, to prove the value crosses back into the cell.',
      parameters: {
        tag: { type: 'string', required: true, description: 'echoed back' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            marker: { type: 'string', required: true },
            tag: { type: 'string', required: true },
          },
        },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      execute: async args => {
        const tag = (args as { tag: string }).tag
        return { marker: ECHO_MARKER, tag }
      },
    }))

    // THE REAL SHIPPED PYTHON CLIENT, BY ABSOLUTE PATH. This is the file the
    // packaging decision (V5 §5.3) makes ship inside `dsh-daily-work`, resolved
    // here the way the composition resolves it -- from the owning package's own
    // location, never from source-tree adjacency of the caller.
    const b = new BridgeServer({
      artifactDirectory: join(root, 'artifacts'),
      dataClientPath: resolve(HERE, '..', '..', 'dsh-daily-work', 'src', 'dsh_data_client.py'),
    })
    const service = new KernelService(ctx, {
      pythonExecutable: PYTHON,
      brokerScript: BROKER,
      root: join(root, 'kernels'),
    })
    cleanup.push(async () => { await b.close() }, async () => { await service.close() }, async () => { await ctx.fiber.dispose() }, async () => { await rm(root, { recursive: true, force: true }) })

    const startup = await b.start()
    const agent = agentFor('session-routing', root)

    // WHAT THE DATA LANE SEES. A stand-in plane: this file's subject is the
    // SEAM, so the plane is deliberately a recording double -- the real plane's
    // own behaviour is `data-r6.test.ts`'s subject. `routeData`'s signature is
    // the one `DataPlaneService.routeData` publishes.
    const seenByDataLane: Array<{ tool: string, sessionId: string, cwd: string | undefined, aborted: boolean }> = []
    const dataHandler: DataCallHandler = async (call, _context): Promise<NativeCallOutcome> => {
      seenByDataLane.push({
        tool: call.tool,
        sessionId: 'session-routing',
        cwd: root,
        aborted: false,
      })
      if (call.tool === `${DATA_TOOL_PREFIX}fs.capture`) {
        return { ok: true, value: { observation_id: 'obs-routing', acquired_bytes: 5 } }
      }
      // THE UNKNOWN-OP ARM, answered the way the real plane answers it: a
      // structured refusal with the plane's own code.
      return {
        ok: false,
        error: {
          code: 'DATA_INVALID_REQUEST',
          message: `"${call.tool}" is not a dsh.data method.`,
        },
      }
    }

    const controller = new AbortController()
    const lease = b.mintLease({
      sessionId: 'session-routing',
      cellId: 'cell-routing-1',
      epoch: 1,
      outerCallId: String('ipython-call-1'),
      rootCallId: String('ipython-call-1'),
      ledger: new MemoryBridgeLedger(),
      controller,
      handler: createNativeCallHandler({
        ctx,
        authority: authorityFor(agent, controller.signal),
        bridge: b,
      }),
      dataHandler,
    })

    const code = [
      b.preamble(lease),
      'import json',
      "cap = await dsh.data.fs.capture('probe.txt')",
      "# The plane's value, read through the CLIENT's own accessors -- so the",
      "# assertion is about what a program actually receives, not about an",
      "# internal shape. `cap` is an Observation, not a dict: it is an address",
      "# plus provenance, and the bytes are deliberately NOT here.",
      "print('DATA_OK:' + json.dumps({'observation_id': cap.observation_id, 'acquired_bytes': cap.acquired_bytes}, sort_keys=True, separators=(',', ':')))",
      "print('DATA_SURFACE:' + json.dumps(sorted(n for n in dir(dsh.data) if not n.startswith('_'))))",
      "# THE UNKNOWN-OP ARM, SENT AS A RAW FRAME. `dsh.data.fs.typo` cannot be",
      "# used here because the client's surface is CLOSED at the attribute level",
      "# (an unknown method does not exist, so Python raises AttributeError before",
      "# any frame is sent) -- which is a different property, and one",
      "# `data-r6.test.ts` already covers. The property THIS arm measures is the",
      "# HOST's: a data:* operation the plane does not know must be refused as a",
      "# DATA-PLANE error and must NOT be dispatched to ctx.tools.execute. A",
      "# hand-built frame is exactly the right instrument for that, and it is also",
      "# the honest model of a program that builds its own frames.",
      "try:",
      "    await dsh._channel.call_async('data:fs.typo', {'x': 1}, 120.0)",
      "    print('UNKNOWN_OP:no-refusal')",
      "except Exception as exc:",
      "    print('UNKNOWN_OP:' + getattr(exc, 'code', type(exc).__name__))",
      "value = await dsh.call('probe_echo', {'tag': 'tool-lane-still-works'})",
      "print('TOOL_OK:' + json.dumps(value, sort_keys=True, separators=(',', ':')))",
    ].join('\n')

    const result = await service.runCell(agent, code)
    const stdout = result.stdout.text
    if (stdout === '') {
      // The cell raised. Surface the whole result so a failure is diagnosable
      // rather than reported as an empty string.
      throw new Error('cell produced no stdout; result=' + JSON.stringify(result, (_k, v) => typeof v === 'function' ? undefined : v).slice(0, 4000))
    }

    // (a) THE DATA LANE SERVED THE CALL. The cell saw the plane's value, which
    //     means the frame reached the data dispatcher rather than the registry.
    expect(stdout, `cell stdout was:\n${stdout}`).toContain('DATA_OK:{"acquired_bytes":5,"observation_id":"obs-routing"}')
    expect(seenByDataLane.map(entry => entry.tool)).toContain(`${DATA_TOOL_PREFIX}fs.capture`)

    // (b) THE NO-FALL-THROUGH PROPERTY, measured from the PIPELINE's side. The
    //     unknown op was refused by the data lane, and the registry never saw a
    //     name starting `data:` -- a fall-through would put it in this list.
    expect(stdout, `cell stdout was:\n${stdout}`).toContain('UNKNOWN_OP:DATA_INVALID_REQUEST')
    expect(
      seenByPipeline.filter(entry => isDataRequest(entry.name)).map(entry => entry.name),
      'a data:* name reached ctx.tools.execute, which is the fall-through this routing exists to prevent',
    ).toEqual([])

    // (c) THE TOOL LANE IS UNCHANGED ON THE SAME LEASE. Without this arm, a
    //     passing data arm could be explained by the lease having stopped
    //     dispatching tools at all.
    expect(stdout).toContain(`TOOL_OK:{"marker":"${ECHO_MARKER}","tag":"tool-lane-still-works"}`)
    expect(seenByPipeline.map(entry => entry.name)).toEqual(['probe_echo'])

    // (d) THE LANE DECISION IS THE PRODUCTION ONE. The prefix is what `onCall`
    //     branches on, and it is asserted to be exactly the reserved one.
    expect(DATA_TOOL_PREFIX).toBe('data:')
    expect(isDataRequest(`${DATA_TOOL_PREFIX}fs.capture`)).toBe(true)
    expect(isDataRequest('probe_echo')).toBe(false)
    expect(startup.endpoint.port).toBeGreaterThan(0)

    await lease.close('completed', 'the cell settled')
    b.releaseLease(lease)
  }, 300_000)

  it('a lease with NO data plane refuses data:* with DATA_NO_CAPABILITY and does NOT dispatch it as a tool', async () => {
    // THE ARM THAT HAS TO HOLD WHEN THE COMPOSITION IS WRONG. A lease minted
    // without a data handler must REFUSE the data lane. If it fell back to the
    // tool lane, an unknown data operation would be answered by the tool
    // registry -- a typo becoming a tool dispatch, and a data refusal that looks
    // like a tool result.
    const root = await mkdtemp(join(tmpdir(), 'p4-nofall-'))
    const ctx = new Context()
    const seenByPipeline: PipelineEntry[] = []

    await ctx.plugin(SystemPrompt, { personaPrefix: '' })
    await ctx.plugin(ToolRuntime, { mode: 'native', maxParallelSubCalls: 10 })
    await ctx.plugin(Subprocess)
    ctx.on('tools/pre-execute', (exec, next) => {
      seenByPipeline.push({ name: exec.name })
      return next()
    })
    ctx.tools.register(defineTool({
      name: 'probe_echo',
      description: 'Returns a fixed marker object, to prove the value crosses back into the cell.',
      parameters: {
        tag: { type: 'string', required: true, description: 'echoed back' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            marker: { type: 'string', required: true },
            tag: { type: 'string', required: true },
          },
        },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      execute: async args => {
        const tag = (args as { tag: string }).tag
        return { marker: ECHO_MARKER, tag }
      },
    }))

    const b = new BridgeServer({ artifactDirectory: join(root, 'artifacts-none') })
    const service = new KernelService(ctx, {
      pythonExecutable: PYTHON,
      brokerScript: BROKER,
      root: join(root, 'kernels'),
    })
    cleanup.push(async () => { await b.close() }, async () => { await service.close() }, async () => { await ctx.fiber.dispose() }, async () => { await rm(root, { recursive: true, force: true }) })

    await b.start()
    const agent = agentFor('session-nofall', root)
    const controller = new AbortController()
    const lease = b.mintLease({
      sessionId: 'session-nofall',
      cellId: 'cell-nofall-1',
      epoch: 1,
      outerCallId: String('ipython-call-1'),
      rootCallId: String('ipython-call-1'),
      ledger: new MemoryBridgeLedger(),
      controller,
      handler: createNativeCallHandler({
        ctx,
        authority: authorityFor(agent, controller.signal),
        bridge: b,
      }),
      // NO dataHandler ON PURPOSE.
    })

    // The data lane is exercised WITHOUT the Python client, because the property
    // under test is the HOST's refusal. `dsh` has no `.data` here (no
    // dataClientPath was supplied), so the frame is sent by the raw channel --
    // which is also the honest model of a program that hand-builds a frame.
    const code = [
      b.preamble(lease),
      'import json',
      "print('HAS_DATA:' + str(hasattr(dsh, 'data')))",
      "try:",
      "    await dsh._channel.call_async('data:fs.capture', {'path': 'x'}, 120.0)",
      "    print('REFUSAL:none')",
      "except Exception as exc:",
      "    print('REFUSAL:' + getattr(exc, 'code', type(exc).__name__))",
    ].join('\n')

    const result = await service.runCell(agent, code)
    const stdout = result.stdout.text

    // (a) The refusal carries the DATA plane's code, so a caller branching on it
    //     sees a data-plane fact rather than a tool-registry one.
    expect(stdout, `cell stdout was:\n${stdout}`).toContain('REFUSAL:DATA_NO_CAPABILITY')
    // (b) NOTHING reached the pipeline. This is the arm that fails if a future
    //     change makes the data lane fall back to the tool lane.
    expect(
      seenByPipeline.map(entry => entry.name),
      'a data:* name was dispatched to ctx.tools.execute when no data plane was mounted',
    ).toEqual([])
    // (c) No `dsh.data` namespace was installed, which agrees with the refusal
    //     rather than promising a capability the host will not serve.
    expect(stdout).toContain('HAS_DATA:False')

    await lease.close('completed', 'the cell settled')
    b.releaseLease(lease)
  }, 300_000)
})

describe('P4 the preamble installs dsh.data only when a data plane is present', () => {
  it('omits the install entirely with no path, and emits an ordered, token-free install with one', () => {
    const base = {
      clientPath: 'C:/k/dsh_bridge_client.py',
      port: 4191,
      token: 'TOKEN-PLACEHOLDER',
      leaseId: 'lease-1',
      cellId: 'cell-1',
      epoch: 1,
    }
    const without = renderBridgePreamble(base)
    expect(without).not.toContain('dsh_data_client')
    expect(without).not.toContain('install(')

    const withData = renderBridgePreamble({ ...base, dataClientPath: 'C:/p/dsh_data_client.py' })
    expect(withData).toContain('dsh_data_client.py')
    // ORDER IS THE REQUIREMENT: the client binds the CURRENT cell's capability,
    // so installing before `_bind` would bind the previous cell's lease.
    expect(withData.indexOf('_dsh_mod._bind(')).toBeLessThan(withData.indexOf('.install('))
    // AND `dsh` IS HANDED TO THE CELL ONLY AFTER the install, so a cell cannot
    // observe a `dsh` without `dsh.data`.
    expect(withData.indexOf('.install(')).toBeLessThan(withData.indexOf('\ndsh = _dsh_mod'))
    // THE API VERSION IS VERIFIED BEFORE THE CAPABILITY IS EXPOSED.
    expect(withData).toContain('DATA_API_VERSION')
    // THE FILE IS NOT A CAPABILITY: no token is written into the data client's
    // own source or into the install lines that reference it.
    const installLines = withData.split('\n').filter(line => line.includes('_dsh_data'))
    expect(installLines.join('\n')).not.toContain('TOKEN-PLACEHOLDER')
  })
})
