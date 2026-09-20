/**
 * P13 probe: what the large-exact-result path does TODAY, before unification.
 *
 * WHY THIS FILE EXISTS. V5 §12 / §2.P says the bridge `Artifact` class is a
 * "temporary independent plane" that hands Python a raw host path, and that a
 * huge exact result must not be forced through IOPub or one 4 MiB bridge frame.
 * Neither of those statements had a measurement on this tree: the T7 arm at
 * `bridge-seam.test.ts:789` proves the artifact door works for a 2 MiB payload
 * under a 4 KiB inline bound, but nothing measured
 *
 *   (a) what happens at and above the FRAME limit, and
 *   (b) what a Python caller can DO with the raw path it is handed.
 *
 * Both are measured here through a real ipykernel over the real broker with a
 * real ToolRuntime, and every observation is taken from what the CELL printed or
 * from the filesystem -- never from what the bridge says about itself.
 *
 * Run:  node --experimental-strip-types src/p13-artifact-plane-probe.ts
 * Out:  JSON on stdout, and to $DSH_PROBE_OUT when that is set.
 */
import { Context } from '@deepseek-ai/cordis'
import Subprocess from '@deepseek-ai/dsh-subprocess-local'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createHash } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { BridgeServer } from './bridge.ts'
import { createNativeCallHandler, type EnclosingAuthority } from './native-call.ts'
import { KernelService } from './kernel-plugin.ts'
import { MemoryBridgeLedger } from './bridge-ledger.ts'
import { MAX_FRAME_BYTES } from './protocol.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const BROKER = resolve(HERE, 'broker.py')
const PYTHON = process.env['DSH_PYTHON'] ?? 'C:/Users/hzq00/AppData/Local/Programs/Python/Python314/python.exe'

const observed: Record<string, unknown> = {}

function agentFor(sessionId: string, cwd: string): Agent {
  return { session: { header: { id: sessionId, cwd } } } as unknown as Agent
}
function authorityFor(callId: string, agent: Agent, signal: AbortSignal): EnclosingAuthority {
  return {
    callId,
    rootCallId: callId,
    token: Symbol('p13-probe-token') as unknown as EnclosingAuthority['token'],
    agent,
    signal,
  }
}

async function main(): Promise<void> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt, { personaPrefix: '' })
  await ctx.plugin(ToolRuntime, { mode: 'native', maxParallelSubCalls: 10 })
  await ctx.plugin(Subprocess)
  const root = await mkdtemp(join(tmpdir(), 'p13-probe-'))

  observed['frameLimitBytes'] = MAX_FRAME_BYTES

  // A tool whose canonical value is sized by the caller, so the SAME tool
  // produces an inline-sized and an over-frame-sized result.
  ctx.tools.register(defineTool({
    name: 'p13_blob',
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

  // The inline bound is set BELOW the frame limit, as the production default is
  // (1 MiB inline vs a 4 MiB frame). That is the configuration under which a
  // result can be too large to inline AND still be routed to the artifact door.
  const inlineValueBytes = 4096
  observed['inlineValueBytes'] = inlineValueBytes

  const bridge = new BridgeServer({ artifactDirectory: join(root, 'artifacts'), inlineValueBytes })
  await bridge.start()
  const service = new KernelService(ctx, { pythonExecutable: PYTHON, brokerScript: BROKER, root: join(root, 'kernels') })
  const agent = agentFor('session-p13', root)
  const lease = bridge.mintLease({
    sessionId: 'session-p13',
    cellId: 'cell-p13-1',
    epoch: 1,
    outerCallId: String('ipython-call-p13'),
    rootCallId: String('ipython-call-p13'),
    ledger: new MemoryBridgeLedger(),
    handler: createNativeCallHandler({
      ctx,
      authority: authorityFor('ipython-call-p13', agent, new AbortController().signal),
      bridge,
    }),
  })

  // ---------------------------------------------------------------------
  // ARM A: a result above the INLINE bound but below the FRAME limit.
  // Expect: the artifact door, and a raw path the cell can open directly.
  // ---------------------------------------------------------------------
  const armA = await service.runCell(agent, [
    bridge.preamble(lease),
    "value = await dsh.call('p13_blob', {'chars': 8192})",
    "print('A_TYPE:' + type(value).__name__)",
    "print('A_PATH:' + str(getattr(value, 'path', None)))",
    "print('A_PATH_IS_STR:' + str(isinstance(getattr(value, 'path', None), str)))",
    // THE SECURITY-RELEVANT OBSERVATION: can the cell open the path itself?
    // If yes, the path -- not the ref -- is the authority.
    "import os as _os",
    "print('A_OS_PATH_EXISTS:' + str(_os.path.exists(value.path)))",
    "print('A_DIRECT_OPEN_OK:' + str(len(open(value.path, 'rb').read()) == value.bytes))",
    // And can it be MOVED / REPLACED behind the ref's back? A digest that is
    // only checked by a method the caller chooses to call is not a binding.
    "print('A_PARENT_WRITABLE:' + str(_os.access(_os.path.dirname(value.path), _os.W_OK)))",
    `print('A_IS_UNDER_SESSION_CWD:' + str(_os.path.abspath(value.path).startswith(_os.path.abspath(${JSON.stringify(root)}))))`,
  ].join('\n'))
  observed['armA_belowFrameLimit'] = {
    outcome: armA.outcome,
    stdout: armA.stdout.text.trim().split('\n'),
  }

  // ---------------------------------------------------------------------
  // ARM B: a result above the FRAME limit (4 MiB). The inline bound is 4 KiB,
  // so the host MUST take the artifact door -- the frame limit is never the
  // binding constraint on the RESULT direction. This arm establishes that the
  // 4 MiB frame is not what bounds a large exact result.
  // ---------------------------------------------------------------------
  const armB = await service.runCell(agent, [
    bridge.preamble(lease),
    `value = await dsh.call('p13_blob', {'chars': ${String(5 * 1024 * 1024)}})`,
    "print('B_TYPE:' + type(value).__name__)",
    "print('B_BYTES:' + str(value.bytes))",
    "print('B_VERIFY:' + str(value.verify()))",
    "print('B_LEN:' + str(len(value.json()['blob'])))",
  ].join('\n'))
  observed['armB_aboveFrameLimit'] = {
    outcome: armB.outcome,
    stdout: armB.stdout.text.trim().split('\n'),
    stderrTail: armB.stderr.text.trim().split('\n').slice(-6),
  }

  // ---------------------------------------------------------------------
  // ARM C: the ARGUMENTS direction, which IS bounded by the frame. A call
  // whose arguments exceed 4 MiB is refused by the CLIENT before the socket
  // write. This is the one place the frame limit is authoritative today.
  //
  // THE ARGUMENTS MUST BE BIG ON THE WIRE, so the payload is built INSIDE the
  // cell. A first version of this arm passed `{'chars': 5242880}`, which
  // serializes to ~25 bytes: the number was large but the FRAME was not, so the
  // refusal was never reached and the arm reported `C_RAISED:no`. That is the
  // project's most-recorded defect shape -- a check that does not fire and a
  // check that is absent producing identical evidence -- so this arm now builds
  // the bytes in the kernel and prints the exact serialized size it is about to
  // send, which makes the arm self-falsifying: if the size printed is under the
  // limit, the arm says so rather than passing.
  // ---------------------------------------------------------------------
  const armC = await service.runCell(agent, [
    bridge.preamble(lease),
    "import json as _c_json",
    `_c_payload = {'blob': 'y' * ${String(5 * 1024 * 1024)}}`,
    "print('C_ARGS_JSON_BYTES:' + str(len(_c_json.dumps(_c_payload).encode('utf-8'))))",
    `print('C_FRAME_LIMIT:${String(4 * 1024 * 1024)}')`,
    "try:",
    "    await dsh.call('p13_blob', _c_payload)",
    "    print('C_RAISED:no')",
    "except Exception as exc:",
    "    print('C_RAISED:yes')",
    "    print('C_CODE:' + str(getattr(exc, 'code', None)))",
    "    print('C_TYPE:' + type(exc).__name__)",
  ].join('\n'))
  observed['armC_argumentsOverFrameLimit'] = {
    outcome: armC.outcome,
    stdout: armC.stdout.text.trim().split('\n'),
  }

  // ---------------------------------------------------------------------
  // ARM D: is there ANY retention/quota/provenance policy on the artifact
  // directory? Count what was written and whether anything removed it.
  // ---------------------------------------------------------------------
  const { readdir, stat } = await import('node:fs/promises')
  const artifactDir = join(root, 'artifacts')
  let entries: string[] = []
  try { entries = await readdir(artifactDir) } catch { entries = [] }
  const sizes: Record<string, number> = {}
  for (const name of entries) {
    try { sizes[name] = (await stat(join(artifactDir, name))).size } catch { sizes[name] = -1 }
  }
  observed['armD_artifactDirectory'] = {
    path: artifactDir,
    fileCount: entries.length,
    files: sizes,
    // The bridge exposes no quota, no retention, no GC and no provenance
    // surface for this directory -- see the report. This records only what is
    // observable, not an absence claim.
    surfaceOnBridgeServer: {
      hasQuota: typeof (bridge as unknown as Record<string, unknown>)['quotaBytes'] !== 'undefined',
      hasGc: typeof (bridge as unknown as Record<string, unknown>)['collectGarbage'] !== 'undefined',
      hasArtifactStoreRef: typeof (bridge as unknown as Record<string, unknown>)['artifactStore'] !== 'undefined',
    },
  }

  // ---------------------------------------------------------------------
  // ARM E: the SAME tool, on a bridge that HAS a retention port.
  //
  // This is the after-picture for the host-side half. The port here is a
  // recording stand-in for the unified plane -- it is NOT a second store, and
  // the production binding is the composition's `AttachmentArtifactStore`. What
  // this arm establishes is the CONTRACT: with a plane mounted, the reply
  // carries the plane's own reference, the `plane` field says `unified`, and NO
  // host path crosses the wire.
  //
  // The two observations that matter are the negative ones:
  //   - `E_PATH_IS_NONE` must be True  (no raw path reaches Python at all)
  //   - `E_LOAD_REFUSED` must name ARTIFACT_NOT_A_PATH (load() cannot silently
  //     fall back to a filesystem read, which is the authority confusion §12 is
  //     about)
  // ---------------------------------------------------------------------
  const retainedBytes: Array<{ artifact: string, bytes: number, sha256: string }> = []
  const unifiedBridge = new BridgeServer({
    artifactDirectory: join(root, 'artifacts-unified-scratch'),
    inlineValueBytes: 4096,
    retention: {
      retain: async (bytes: Uint8Array) => {
        const sha256 = createHash('sha256').update(bytes).digest('hex')
        const artifact = `artifact:sha256:${sha256}`
        retainedBytes.push({ artifact, bytes: bytes.byteLength, sha256 })
        return { artifact, sha256, bytes: bytes.byteLength }
      },
    },
  })
  await unifiedBridge.start()
  const unifiedService = new KernelService(ctx, { pythonExecutable: PYTHON, brokerScript: BROKER, root: join(root, 'kernels-unified') })
  const unifiedLease = unifiedBridge.mintLease({
    sessionId: 'session-p13-unified',
    cellId: 'cell-p13-unified-1',
    epoch: 1,
    outerCallId: String('ipython-call-p13-unified'),
    rootCallId: String('ipython-call-p13-unified'),
    ledger: new MemoryBridgeLedger(),
    handler: createNativeCallHandler({
      ctx,
      authority: authorityFor('ipython-call-p13-unified', agent, new AbortController().signal),
      bridge: unifiedBridge,
    }),
  })
  const armE = await unifiedService.runCell(agent, [
    unifiedBridge.preamble(unifiedLease),
    "value = await dsh.call('p13_blob', {'chars': 8192})",
    "print('E_TYPE:' + type(value).__name__)",
    "print('E_PLANE:' + str(value.plane))",
    "print('E_ARTIFACT_PREFIXED:' + str(str(value.artifact).startswith('artifact:sha256:')))",
    "print('E_PATH_IS_NONE:' + str(value.path is None))",
    "print('E_HAS_NO_RAW_PATH_ATTR:' + str(not hasattr(value, 'path') or value.path is None))",
    "try:",
    "    value.load()",
    "    print('E_LOAD_REFUSED:no')",
    "except Exception as exc:",
    "    print('E_LOAD_REFUSED:yes')",
    "    print('E_LOAD_CODE:' + str(getattr(exc, 'code', None)))",
    // On the unified plane there is nothing to open, so verify() must not reach
    // for a path. It reports True because the PLANE checks the digest on read.
    "print('E_VERIFY_NO_PATH:' + str(value.verify()))",
    "print('E_REPR:' + repr(value))",
  ].join('\n'))
  observed['armE_unifiedRetentionPort'] = {
    outcome: armE.outcome,
    stdout: armE.stdout.text.trim().split('\n'),
    stderrTail: armE.stderr.text.trim().split('\n').slice(-6),
    // What the PORT was asked to retain -- the host side of the same call.
    portCalls: retainedBytes.map(entry => ({ artifact: entry.artifact, bytes: entry.bytes })),
    scratchDirectoryEntries: await (async () => {
      try { return await readdir(join(root, 'artifacts-unified-scratch')) } catch { return [] }
    })(),
  }

  await unifiedLease.close('completed', 'the probe finished')
  unifiedBridge.releaseLease(unifiedLease)
  await unifiedService.close()
  await unifiedBridge.close()

  await lease.close('completed', 'the probe finished')
  bridge.releaseLease(lease)
  await service.close()
  await bridge.close()
  await ctx.fiber.dispose()
  await rm(root, { recursive: true, force: true })

  const text = JSON.stringify(observed, null, 2)
  const out = process.env['DSH_PROBE_OUT']
  if (out !== undefined && out !== '') writeFileSync(out, text + '\n', 'utf8')
  process.stdout.write(text + '\n')
}

main().catch(error => {
  process.stderr.write(String(error instanceof Error ? error.stack ?? error.message : error) + '\n')
  process.exitCode = 1
})
