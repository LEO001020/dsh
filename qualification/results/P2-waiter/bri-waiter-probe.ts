/**
 * BRI-WAITER — the hand-run probe that produced the BEFORE/AFTER pair.
 *
 * WHY A PROBE IN ADDITION TO THE TEST. The test asserts; a probe REPORTS. The
 * fields a reader needs to audit this slice (how long the barrier held the
 * caller, how many lookups the reader made, whether any of them found no waiter,
 * whether the frame was on the wire before the waiter existed) are all produced
 * here as JSON on disk, so the before/after pair survives independently of the
 * test file that also checks it.
 *
 * It runs the SAME driver the test runs, over the SAME real `BridgeServer`, with
 * the client bytes substituted per arm:
 *   live   -- `PYTHON_CLIENT_SOURCE` as it is in the tree now (fixed)
 *   before -- the archived pre-fix client from
 *             `qualification/results/P2-waiter/dsh_bridge_client.before.py`
 *
 * Run from `packages/dsh-ipython`:
 *   node --experimental-strip-types ../../qualification/results/P2-waiter/bri-waiter-probe.ts
 * Out: JSON on stdout, and `bri-waiter-report.json` beside this file.
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { BridgeServer, PYTHON_CLIENT_SOURCE } from '../../../packages/dsh-ipython/src/bridge.ts'
import { MemoryBridgeLedger } from '../../../packages/dsh-ipython/src/bridge-ledger.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const DRIVER = resolve(HERE, '../../../packages/dsh-ipython/src/bri-waiter-driver.py')
const BEFORE_CLIENT = resolve(HERE, 'dsh_bridge_client.before.py')
const PYTHON = process.env['DSH_PYTHON'] ?? 'C:/Users/hzq00/AppData/Local/Programs/Python/Python314/python.exe'

type Mode = 'sync' | 'async' | 'sendfail'

interface Arm {
  readonly client: 'live' | 'before'
  readonly mode: Mode
  readonly timeoutSeconds: number
}

/** Run one arm and return the driver's own JSON report. */
async function runArm(arm: Arm, clientSource: string): Promise<Record<string, unknown>> {
  const root = mkdtempSync(join(tmpdir(), 'p2-waiter-probe-'))
  const bridge = new BridgeServer({ artifactDirectory: join(root, 'artifacts') })
  try {
    const startup = await bridge.start()
    writeFileSync(startup.clientPath, clientSource, 'utf8')
    const lease = bridge.mintLease({
      sessionId: 'session-probe',
      cellId: 'cell-probe',
      epoch: 1,
      outerCallId: String('ipython-call-probe'),
      rootCallId: String('ipython-call-probe'),
      ledger: new MemoryBridgeLedger(),
      handler: async call => ({
        ok: true,
        value: { marker: 'BRI-WAITER', tag: String((call.arguments as { tag?: unknown } | undefined)?.tag) },
      }),
    })
    const preamblePath = join(root, `preamble-${arm.client}-${arm.mode}.py`)
    writeFileSync(preamblePath, bridge.preamble(lease), 'utf8')

    const child = spawn(PYTHON, [DRIVER, arm.mode, preamblePath, String(arm.timeoutSeconds)], {
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => { stdout += chunk })
    child.stderr.on('data', (chunk: string) => { stderr += chunk })
    const code = await new Promise<number | null>(resolveExit => {
      child.once('exit', value => { resolveExit(value) })
    })
    if (code !== 0) return { arm, driverExitCode: code, stdout, stderr }
    const line = stdout.trim().split('\n').filter(Boolean).pop() ?? '{}'
    return { arm, driver: JSON.parse(line) as Record<string, unknown> }
  } finally {
    await bridge.close().catch(() => undefined)
    rmSync(root, { recursive: true, force: true })
  }
}

const live = PYTHON_CLIENT_SOURCE
const before = readFileSync(BEFORE_CLIENT, 'utf8')
const arms: readonly Arm[] = [
  { client: 'live', mode: 'sync', timeoutSeconds: 10 },
  { client: 'before', mode: 'sync', timeoutSeconds: 0.4 },
  { client: 'live', mode: 'async', timeoutSeconds: 10 },
  { client: 'before', mode: 'async', timeoutSeconds: 0.4 },
  { client: 'live', mode: 'sendfail', timeoutSeconds: 0.4 },
]

const results: Array<Record<string, unknown>> = []
for (const arm of arms) {
  results.push(await runArm(arm, arm.client === 'live' ? live : before))
}

const report = {
  instrument: 'bri-waiter-probe',
  tree: resolve(HERE, '../../..'),
  identity: {
    liveClientBytes: Buffer.byteLength(live, 'utf8'),
    beforeClientBytes: Buffer.byteLength(before, 'utf8'),
    python: PYTHON,
    // The pre-fix client must not contain the fixed signature, or the control
    // arm would be measuring the wrong bytes and would pass for the wrong reason.
    beforeClientIsPreFix: before.includes('request_id = self._send(tool, arguments)\n        waiter = _SyncWaiter()')
      && !before.includes('def _send(self, tool, arguments, waiter)'),
    liveClientHasFixedSignature: live.includes('def _send(self, tool, arguments, waiter)'),
  },
  results,
}
const text = JSON.stringify(report, null, 2)
writeFileSync(join(HERE, 'bri-waiter-report.json'), text + '\n', 'utf8')
process.stdout.write(text + '\n')
