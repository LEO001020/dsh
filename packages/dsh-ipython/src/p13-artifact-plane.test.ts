/**
 * P13: the large-exact-result plane is the PROJECT's, and a ref is not a path.
 *
 * WHAT THIS FILE MEASURES, AND WHY IT IS NOT A RESTATEMENT OF THE T7 ARM.
 *
 * `bridge-seam.test.ts:789` proves the artifact door DELIVERS a 2 MiB value
 * losslessly under a 4 KiB inline bound. It says nothing about WHICH retention
 * policy applied, and it predates V5 §12/§2.P. The property this file establishes
 * is the one §12 names: `no raw host path is authority`, plus its two
 * consequences -- the reply carries a typed reference, and a reader can always
 * tell which plane retained the bytes.
 *
 * EVERY ARM HAS A CONTROL THAT MUST FAIL, because a guard that never fires and a
 * guard that is absent produce identical evidence:
 *
 *   P13-1  inline arm       -- a small result is still INLINE, not an Artifact.
 *                              Control for P13-2: if everything became an
 *                              Artifact, P13-2 would pass vacuously.
 *   P13-2  no port          -- scratch plane, path present, plane named.
 *                              Establishes the fallback is RECORDED, not silent.
 *   P13-3  port mounted     -- unified plane, ref present, NO path.
 *   P13-4  load() on unified -- REFUSED with ARTIFACT_NOT_A_PATH. This is the
 *                              arm that fails if a filesystem fallback exists.
 *   P13-5  digest mismatch  -- a plane that retains different bytes is refused,
 *                              not bound to Python under a reference that names
 *                              the wrong object.
 *   P13-6  plane refuses    -- a mounted plane's refusal is an ERROR, not a
 *                              fallback to scratch.
 *   P13-7  no dsh.data      -- paging by reference with no data client installed
 *                              names the missing piece instead of opening a path.
 *   P13-8  ref format       -- the ref this package mints is byte-identical to
 *                              `artifacts.ts:artifactRefOf`, so the two planes
 *                              cannot drift apart.
 *   P13-9  serial semantics -- two sequential dsh.call invocations still produce
 *                              two dispatches in order (the exact ToolRuntime
 *                              lane is unchanged by this slice).
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
import { BridgeServer, scratchArtifactRef, type BridgeArtifactRetention } from './bridge.ts'
import { createNativeCallHandler, type EnclosingAuthority } from './native-call.ts'
import { KernelService } from './kernel-plugin.ts'
import { MemoryBridgeLedger } from './bridge-ledger.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const BROKER = resolve(HERE, 'broker.py')
const PYTHON = process.env['DSH_PYTHON'] ?? 'C:/Users/hzq00/AppData/Local/Programs/Python/Python314/python.exe'

let ctx: Context
let root: string
const bridges: BridgeServer[] = []
const services: KernelService[] = []

beforeEach(async () => {
  ctx = new Context()
  await ctx.plugin(SystemPrompt, { personaPrefix: '' })
  await ctx.plugin(ToolRuntime, { mode: 'native', maxParallelSubCalls: 10 })
  await ctx.plugin(Subprocess)
  root = await mkdtemp(join(tmpdir(), 'p13-plane-'))
})

afterEach(async () => {
  for (const service of services) await service.close().catch(() => undefined)
  for (const bridge of bridges) await bridge.close().catch(() => undefined)
  services.length = 0
  bridges.length = 0
  await ctx.fiber.dispose()
  await rm(root, { recursive: true, force: true })
})

function agentFor(sessionId: string, cwd: string): Agent {
  return { session: { header: { id: sessionId, cwd } } } as unknown as Agent
}

function authorityFor(callId: string, agent: Agent, signal: AbortSignal): EnclosingAuthority {
  return {
    callId,
    rootCallId: callId,
    token: Symbol('p13-test-token') as unknown as EnclosingAuthority['token'],
    agent,
    signal,
  }
}

/** A recording stand-in for the unified plane. NOT a second store. */
function recordingPlane(options: { transform?: (bytes: Uint8Array) => Uint8Array, refuse?: string } = {}): {
  port: BridgeArtifactRetention
  calls: Array<{ artifact: string, bytes: number }>
} {
  const calls: Array<{ artifact: string, bytes: number }> = []
  return {
    calls,
    port: {
      retain: async (bytes: Uint8Array) => {
        if (options.refuse !== undefined) throw new Error(options.refuse)
        const retained = options.transform === undefined ? bytes : options.transform(bytes)
        const sha256 = createHash('sha256').update(retained).digest('hex')
        const artifact = scratchArtifactRef(sha256)
        calls.push({ artifact, bytes: retained.byteLength })
        return { artifact, sha256, bytes: retained.byteLength }
      },
    },
  }
}

/**
 * Register the size-controlled tool under a per-arm name.
 *
 * ONE definition, called by every arm, so an arm cannot pass because its tool
 * happened to differ from the one another arm measured. The tool returns a
 * canonical value whose SIZE the caller chooses, which is what lets one tool
 * exercise both delivery doors.
 */
function registerBlob(name: string): void {
  ctx.tools.register(defineTool({
    name: `p13_blob_${name}`,
    description: 'Returns a blob of a requested character count.',
    parameters: { chars: { type: 'number', required: true, description: 'how many characters' } },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { blob: { type: 'string', required: true } },
      },
      render: (_args, value) => [{ type: 'text', text: `<${String((value as { blob: string }).blob.length)} chars>` }],
    },
    execute: async (args: { chars: number }) => ({ blob: 'x'.repeat(args.chars) }),
  }))
}

/** Mount a bridge + kernel service + lease, and register the size-controlled tool. */
async function mount(
  name: string,
  options: { retention?: BridgeArtifactRetention } = {},
): Promise<{ bridge: BridgeServer, service: KernelService, preamble: string }> {
  registerBlob(name)

  const bridge = new BridgeServer({
    artifactDirectory: join(root, `artifacts-${name}`),
    inlineValueBytes: 4096,
    ...options.retention === undefined ? {} : { retention: options.retention },
  })
  bridges.push(bridge)
  await bridge.start()
  const service = new KernelService(ctx, {
    pythonExecutable: PYTHON,
    brokerScript: BROKER,
    root: join(root, `kernels-${name}`),
  })
  services.push(service)
  const agent = agentFor(`session-${name}`, root)
  const lease = bridge.mintLease({
    sessionId: `session-${name}`,
    cellId: `cell-${name}`,
    epoch: 1,
    outerCallId: String(`ipython-call-${name}`),
    rootCallId: String(`ipython-call-${name}`),
    ledger: new MemoryBridgeLedger(),
    handler: createNativeCallHandler({
      ctx,
      authority: authorityFor(`ipython-call-${name}`, agent, new AbortController().signal),
      bridge,
    }),
  })
  return { bridge, service, preamble: bridge.preamble(lease) }
}

describe('P13 — the large-result plane is the project artifact plane, not a path', () => {
  it('P13-1 a SMALL result is still inline, so the artifact door is not vacuous', async () => {
    const { service, preamble } = await mount('small')
    const agent = agentFor('session-small', root)
    const result = await service.runCell(agent, [
      preamble,
      "value = await dsh.call('p13_blob_small', {'chars': 32})",
      "print('SMALL_TYPE:' + type(value).__name__)",
      "print('SMALL_IS_DICT:' + str(isinstance(value, dict)))",
    ].join('\n'))
    expect(result.outcome).toBe('ok')
    expect(result.stdout.text).toContain('SMALL_TYPE:dict')
    expect(result.stdout.text).toContain('SMALL_IS_DICT:True')
  }, 240_000)

  it('P13-2 with NO retention port the scratch plane is USED and NAMED, not silent', async () => {
    const { service, preamble } = await mount('noport')
    const agent = agentFor('session-noport', root)
    const result = await service.runCell(agent, [
      preamble,
      "value = await dsh.call('p13_blob_noport', {'chars': 8192})",
      "print('PLANE:' + str(value.plane))",
      "print('PATH_PRESENT:' + str(value.path is not None))",
      "print('REF_PREFIXED:' + str(str(value.artifact).startswith('artifact:sha256:')))",
      "print('REF_MATCHES_DIGEST:' + str(value.artifact == 'artifact:sha256:' + value.sha256))",
      // The scratch plane still reads back exactly, so the fallback is not a
      // degradation of DELIVERY -- only of retention policy.
      "print('SCRATCH_READS:' + str(value.verify()))",
    ].join('\n'))
    expect(result.outcome).toBe('ok')
    expect(result.stdout.text).toContain('PLANE:bridge-scratch')
    expect(result.stdout.text).toContain('PATH_PRESENT:True')
    expect(result.stdout.text).toContain('REF_PREFIXED:True')
    expect(result.stdout.text).toContain('REF_MATCHES_DIGEST:True')
    expect(result.stdout.text).toContain('SCRATCH_READS:True')
  }, 240_000)

  it('P13-3 with a port mounted the reply carries a typed ref and NO host path', async () => {
    const plane = recordingPlane()
    const { service, preamble } = await mount('unified', { retention: plane.port })
    const agent = agentFor('session-unified', root)
    const result = await service.runCell(agent, [
      preamble,
      "value = await dsh.call('p13_blob_unified', {'chars': 8192})",
      "print('PLANE:' + str(value.plane))",
      "print('PATH_IS_NONE:' + str(value.path is None))",
      "print('REF_PREFIXED:' + str(str(value.artifact).startswith('artifact:sha256:')))",
      "print('REF_MATCHES_DIGEST:' + str(value.artifact == 'artifact:sha256:' + value.sha256))",
      "print('REPR:' + repr(value))",
    ].join('\n'))
    expect(result.outcome).toBe('ok')
    expect(result.stdout.text).toContain('PLANE:unified')
    // THE INVARIANT. No raw host path reaches Python at all on this plane.
    expect(result.stdout.text).toContain('PATH_IS_NONE:True')
    expect(result.stdout.text).toContain('REF_PREFIXED:True')
    expect(result.stdout.text).toContain('REF_MATCHES_DIGEST:True')
    expect(result.stdout.text).toContain('Artifact(plane=unified')
    // And the port really was the retention path, with the same bytes.
    expect(plane.calls).toHaveLength(1)
    expect(plane.calls[0]!.bytes).toBeGreaterThan(8192)
  }, 240_000)

  it('P13-4 load() on the unified plane is REFUSED, so no filesystem fallback exists', async () => {
    const plane = recordingPlane()
    const { service, preamble } = await mount('noload', { retention: plane.port })
    const agent = agentFor('session-noload', root)
    const result = await service.runCell(agent, [
      preamble,
      "value = await dsh.call('p13_blob_noload', {'chars': 8192})",
      // The control: the OLD behaviour is a direct open() of a host path. If the
      // unified plane still carried a path, this line would succeed.
      "import os as _os",
      "print('HAS_PATH:' + str(getattr(value, 'path', None) is not None))",
      // EVERY call below is inside the try, INCLUDING verify(). A first version
      // left verify() outside it, and the mutation test showed why that matters:
      // with a leaked path, verify() raised an uncaught FileNotFoundError and the
      // cell failed on `outcome` instead of on HAS_PATH -- red for an adjacent
      // reason rather than for the property under test.
      "try:",
      "    value.load()",
      "    print('LOAD_REFUSED:no')",
      "except Exception as exc:",
      "    print('LOAD_REFUSED:yes')",
      "    print('LOAD_CODE:' + str(getattr(exc, 'code', None)))",
      "try:",
      "    print('VERIFY_WITHOUT_PATH:' + str(value.verify()))",
      "except Exception as exc:",
      "    print('VERIFY_RAISED:' + type(exc).__name__)",
    ].join('\n'))
    expect(result.outcome).toBe('ok')
    expect(result.stdout.text).toContain('HAS_PATH:False')
    expect(result.stdout.text).toContain('LOAD_REFUSED:yes')
    expect(result.stdout.text).toContain('LOAD_CODE:ARTIFACT_NOT_A_PATH')
    expect(result.stdout.text).toContain('VERIFY_WITHOUT_PATH:True')
  }, 240_000)

  it('P13-5 a plane that retains DIFFERENT bytes is refused, not bound to Python', async () => {
    // The mutation that makes this arm meaningful: the plane hashes something
    // other than what the tool produced. Accepting its reference would bind
    // Python to an object that is not the result.
    const plane = recordingPlane({ transform: bytes => Buffer.concat([Buffer.from(bytes), Buffer.from('tamper')]) })
    const { service, preamble } = await mount('mismatch', { retention: plane.port })
    const agent = agentFor('session-mismatch', root)
    const result = await service.runCell(agent, [
      preamble,
      "try:",
      "    value = await dsh.call('p13_blob_mismatch', {'chars': 8192})",
      "    print('RAISED:no')",
      "    print('GOT_PLANE:' + str(getattr(value, 'plane', None)))",
      "except Exception as exc:",
      "    print('RAISED:yes')",
      "    print('CODE:' + str(getattr(exc, 'code', None)))",
    ].join('\n'))
    expect(result.outcome).toBe('ok')
    expect(result.stdout.text).toContain('RAISED:yes')
    expect(result.stdout.text).toContain('CODE:ARTIFACT_DIGEST_MISMATCH')
  }, 240_000)

  it('P13-6 a plane that REFUSES is an error, not a fallback to scratch', async () => {
    const plane = recordingPlane({ refuse: 'quota exceeded for this owner scope' })
    const { service, preamble } = await mount('refused', { retention: plane.port })
    const agent = agentFor('session-refused', root)
    const result = await service.runCell(agent, [
      preamble,
      "try:",
      "    value = await dsh.call('p13_blob_refused', {'chars': 8192})",
      "    print('RAISED:no')",
      "    print('GOT_PLANE:' + str(getattr(value, 'plane', None)))",
      "except Exception as exc:",
      "    print('RAISED:yes')",
      "    print('CODE:' + str(getattr(exc, 'code', None)))",
      "    print('MENTIONS_QUOTA:' + str('quota' in str(getattr(exc, 'message', exc))))",
    ].join('\n'))
    expect(result.outcome).toBe('ok')
    expect(result.stdout.text).toContain('RAISED:yes')
    expect(result.stdout.text).toContain('CODE:ARTIFACT_WRITE_FAILED')
    expect(result.stdout.text).toContain('MENTIONS_QUOTA:True')
  }, 240_000)

  it('P13-7 paging by reference with NO dsh.data installed names the missing piece', async () => {
    const plane = recordingPlane()
    const { service, preamble } = await mount('nodata', { retention: plane.port })
    const agent = agentFor('session-nodata', root)
    const result = await service.runCell(agent, [
      preamble,
      "value = await dsh.call('p13_blob_nodata', {'chars': 8192})",
      "print('PLANE:' + str(value.plane))",
      "try:",
      "    await value.pages()",
      "    print('PAGES_RAISED:no')",
      "except Exception as exc:",
      "    print('PAGES_RAISED:yes')",
      "    print('PAGES_CODE:' + str(getattr(exc, 'code', None)))",
      "    print('PAGES_NAMES_DATA:' + str('dsh.data' in str(getattr(exc, 'message', exc))))",
    ].join('\n'))
    expect(result.outcome).toBe('ok')
    // The host-side half is complete: the ref arrives. The Python-side paging
    // half needs the host to install the data namespace, which is P4's routing
    // work -- and the refusal says exactly that rather than opening a path.
    expect(result.stdout.text).toContain('PLANE:unified')
    expect(result.stdout.text).toContain('PAGES_RAISED:yes')
    expect(result.stdout.text).toContain('PAGES_CODE:DATA_PLANE_UNAVAILABLE')
    expect(result.stdout.text).toContain('PAGES_NAMES_DATA:True')
  }, 240_000)

  it('P13-8 the ref this package mints is byte-identical to artifacts.ts:artifactRefOf', async () => {
    // A cross-package drift guard. `scratchArtifactRef` is re-stated rather than
    // imported (dsh-ipython must not depend on dsh-daily-work), so the two
    // definitions are compared as STRINGS here. If either moves, this fails.
    const digest = 'a'.repeat(64)
    const expected = `artifact:sha256:${digest}`
    expect(scratchArtifactRef(digest)).toBe(expected)

    const { readFile } = await import('node:fs/promises')
    const source = await readFile(
      resolve(HERE, '..', '..', 'dsh-daily-work', 'src', 'artifacts.ts'),
      'utf8',
    )
    // Read the AUTHORITATIVE definition out of the other package's source rather
    // than restating it a second time here, so this test cannot pass by agreeing
    // with itself.
    const match = /export function artifactRefOf\(sha256: string\): string \{\s*return `([^`]+)`/u.exec(source)
    expect(match, 'artifacts.ts no longer defines artifactRefOf in the expected shape').not.toBeNull()
    const authority = match![1]!.replace('${sha256}', digest)
    expect(scratchArtifactRef(digest)).toBe(authority)
  })

  it('P13-9 the serial dsh.call lane is UNCHANGED: two calls, two dispatches, in order', async () => {
    const { service, preamble } = await mount('serial')
    const agent = agentFor('session-serial', root)
    const dispatched: string[] = []
    ctx.on('tools/pre-execute', (exec, next) => {
      dispatched.push(String(exec.name))
      return next()
    })
    const result = await service.runCell(agent, [
      preamble,
      "first = await dsh.call('p13_blob_serial', {'chars': 16})",
      "second = await dsh.call('p13_blob_serial', {'chars': 32})",
      "print('FIRST:' + str(len(first['blob'])))",
      "print('SECOND:' + str(len(second['blob'])))",
    ].join('\n'))
    expect(result.outcome).toBe('ok')
    expect(result.stdout.text).toContain('FIRST:16')
    expect(result.stdout.text).toContain('SECOND:32')
    // Both were SMALL, so both were inline: the exact ToolRuntime lane did not
    // acquire an artifact hop from this slice.
    expect(dispatched.filter(name => name === 'p13_blob_serial')).toHaveLength(2)
  }, 240_000)

  it('P13-10 the DURABLE LEDGER carries a typed ref, never a host path', async () => {
    // THIS ARM EXISTS BECAUSE A MUTATION SURVIVED WITHOUT IT. Reverting the
    // ledger field to `outcome.artifact.path` -- the pre-P13 behaviour, which put
    // a host filesystem path into a durable record -- left all nine arms green.
    // A gate that does not notice the durable record naming a replaceable
    // location is not gating the property §12 is about, so this arm was added
    // and the mutation re-run against it.
    const plane = recordingPlane()
    const ledger = new MemoryBridgeLedger()
    registerBlob('ledger')
    const bridge = new BridgeServer({
      artifactDirectory: join(root, 'artifacts-ledger'),
      inlineValueBytes: 4096,
      retention: plane.port,
    })
    bridges.push(bridge)
    await bridge.start()
    const service = new KernelService(ctx, {
      pythonExecutable: PYTHON,
      brokerScript: BROKER,
      root: join(root, 'kernels-ledger'),
    })
    services.push(service)
    const agent = agentFor('session-ledger', root)
    const lease = bridge.mintLease({
      sessionId: 'session-ledger',
      cellId: 'cell-ledger',
      epoch: 1,
      outerCallId: 'ipython-call-ledger',
      rootCallId: 'ipython-call-ledger',
      ledger,
      handler: createNativeCallHandler({
        ctx,
        authority: authorityFor('ipython-call-ledger', agent, new AbortController().signal),
        bridge,
      }),
    })
    const result = await service.runCell(agent, [
      bridge.preamble(lease),
      "value = await dsh.call('p13_blob_ledger', {'chars': 8192})",
      "print('CALL_PLANE:' + str(value.plane))",
    ].join('\n'))
    expect(result.outcome).toBe('ok')
    expect(result.stdout.text).toContain('CALL_PLANE:unified')

    // ── HALF 1: THE SCRATCH PLANE, WHICH IS THE HALF THAT CAN LEAK A PATH ────
    //
    // Order matters here and it is not cosmetic. On the UNIFIED plane
    // `artifact.path` is undefined, so reverting the ledger field to
    // `outcome.artifact.path` writes `undefined` and the row simply has no ref --
    // the unified assertion below would then fire with "carries no artifactRef",
    // which is a CONFUSING message for "the durable record leaked a host path".
    // A gate whose failure text misdescribes the defect is how a gate gets
    // disabled later. So the scratch plane runs FIRST: it is the one where a path
    // genuinely exists to leak, so the failure names the real defect.
    //
    // A SECOND KernelService ON THIS ctx IS NOT POSSIBLE: it registers as the
    // `ipython` service, so constructing one throws `service "ipython" has been
    // registered`. Measured -- the first version of this half failed exactly
    // there. ONE service serves both halves, which is sound because a kernel is
    // keyed by the agent's session id: the two halves use different sessions, so
    // they get different kernels, and the only inputs this arm varies are the
    // bridge and the ledger.
    const scratchBridge = new BridgeServer({
      artifactDirectory: join(root, 'artifacts-ledger-scratch'),
      inlineValueBytes: 4096,
    })
    bridges.push(scratchBridge)
    await scratchBridge.start()
    const scratchAgent = agentFor('session-ledger-scratch', root)
    const scratchLedger = new MemoryBridgeLedger()
    registerBlob('ledger_scratch')
    const scratchLease = scratchBridge.mintLease({
      sessionId: 'session-ledger-scratch',
      cellId: 'cell-ledger-scratch',
      epoch: 1,
      outerCallId: 'ipython-call-ledger-scratch',
      rootCallId: 'ipython-call-ledger-scratch',
      ledger: scratchLedger,
      handler: createNativeCallHandler({
        ctx,
        authority: authorityFor('ipython-call-ledger-scratch', scratchAgent, new AbortController().signal),
        bridge: scratchBridge,
      }),
    })
    const scratchResult = await service.runCell(scratchAgent, [
      scratchBridge.preamble(scratchLease),
      "value = await dsh.call('p13_blob_ledger_scratch', {'chars': 8192})",
      "print('SCRATCH_PLANE:' + str(value.plane))",
      "print('SCRATCH_HAS_PATH:' + str(value.path is not None))",
    ].join('\n'))
    expect(scratchResult.outcome).toBe('ok')
    expect(scratchResult.stdout.text).toContain('SCRATCH_PLANE:bridge-scratch')
    // The path really is present on this plane, so the assertion below is about
    // a path that EXISTS rather than about an absent field.
    expect(scratchResult.stdout.text).toContain('SCRATCH_HAS_PATH:True')

    const scratchRows = scratchLedger.forOuterCall('ipython-call-ledger-scratch')
      .filter(row => row.name === 'p13_blob_ledger_scratch')
    expect(scratchRows.length).toBeGreaterThan(0)
    for (const row of scratchRows) {
      expect(row.artifactRef, `scratch ledger row ${row.subCallId} carries no artifactRef`).toBeDefined()
      expect(row.artifactRef).toMatch(/^artifact:sha256:[a-f0-9]{64}$/u)
      // THE ASSERTION THE MUTATION TRIPS. A path here would be the durable
      // record naming a location that any same-UID writer can replace, which is
      // the defect this slice removes.
      expect(row.artifactRef, 'the durable record must not name a host path').not.toMatch(/^[A-Za-z]:[\\/]/u)
      expect(row.artifactRef).not.toContain('\\')
    }

    // ── HALF 2: THE UNIFIED PLANE, WHERE THERE IS NO PATH AT ALL ─────────────
    const rows = ledger.forOuterCall('ipython-call-ledger')
    const blobRows = rows.filter(row => row.name === 'p13_blob_ledger')
    expect(blobRows.length).toBeGreaterThan(0)
    for (const row of blobRows) {
      // THE PROPERTY, asserted directly on the row so a failure NAMES it.
      expect(row.artifactRef, `ledger row ${row.subCallId} carries no artifactRef`).toBeDefined()
      expect(row.artifactRef).toMatch(/^artifact:sha256:[a-f0-9]{64}$/u)
      expect(row.artifactRef).not.toMatch(/^[A-Za-z]:[\\/]/u)
      expect(row.artifactRef).not.toContain('\\')
      expect(row.artifactRef).not.toContain('/')
    }
  }, 240_000)
})
