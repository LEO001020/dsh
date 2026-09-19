/**
 * Why does a shut-down kernel leave python.exe behind, and for how long?
 *
 * The cleanup gate asserts that no NEW python.exe survives a shutdown. It failed
 * with 2-3 survivors that were gone by the time they were checked by hand. Three
 * explanations fit that, and they need different fixes:
 *
 *   (1) TRANSIENT  -- shutdown returns before the OS reaps; the snapshot is early.
 *   (2) BASELINE   -- a previous test's kernel is still draining, so `before` is
 *                     not a clean baseline.
 *   (3) REAL LEAK  -- something (broker crash, control-channel error, a kernel
 *                     that escaped the managed range) leaves a process behind.
 *
 * This script separates them by recording WHICH pid is which and WHEN each one
 * disappears, rather than sampling once and guessing.
 *
 *   node --experimental-strip-types .probe/leak-diagnostic.mts
 */
import { Context } from '@deepseek-ai/cordis'
import Subprocess from '@deepseek-ai/dsh-subprocess-local'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { KernelHost } from '../src/kernel.ts'

const PYTHON = process.env['DSH_PYTHON']
  ?? 'C:/Users/hzq00/AppData/Local/Programs/Python/Python314/python.exe'
const BROKER = resolve(import.meta.dirname, '../src/broker.py')

function pythonPids(): Set<number> {
  const out = execFileSync('tasklist', ['/FI', 'IMAGENAME eq python.exe', '/NH', '/FO', 'CSV'], {
    encoding: 'utf8',
  })
  const set = new Set<number>()
  for (const line of out.split(/\r?\n/)) {
    const match = /^"python\.exe","(\d+)"/.exec(line.trim())
    if (match?.[1] !== undefined) set.add(Number(match[1]))
  }
  return set
}

const sleep = (ms: number): Promise<void> => new Promise(resolvePromise => setTimeout(resolvePromise, ms))

const report: Record<string, unknown> = {}

// (2) BASELINE: report the ambient set BEFORE anything is started, and again
// after a settle delay, so an in-flight reap from an earlier test is visible.
const ambientAtStart = pythonPids()
await sleep(3000)
const ambientAfterSettle = pythonPids()
report.ambient = {
  atStart: [...ambientAtStart].sort((a, b) => a - b),
  after3sSettle: [...ambientAfterSettle].sort((a, b) => a - b),
  changedWhileIdle: [...ambientAfterSettle].filter(pid => !ambientAtStart.has(pid)),
  vanishedWhileIdle: [...ambientAtStart].filter(pid => !ambientAfterSettle.has(pid)),
}

const ctx = new Context()
await ctx.plugin(Subprocess)
const root = mkdtempSync(join(tmpdir(), 'leak-diag-'))

const host = new KernelHost({
  subprocess: ctx.subprocess,
  identity: { sessionId: 'leak-diag', executionWorld: 'local', environmentDigest: 'diag' },
  brokerScript: BROKER,
  pythonExecutable: PYTHON,
  workingDirectory: root,
})

const startAt = Date.now()
const status = await host.start()
await sleep(800)
const during = pythonPids()
const newPids = [...during].filter(pid => !ambientAfterSettle.has(pid)).sort((a, b) => a - b)
report.start = {
  startMs: Date.now() - startAt,
  kernelPid: status.pid,
  newPids,
  // The broker is the other new python: it is the direct child, the kernel is
  // the one jupyter_client launched inside it.
  brokerPid: newPids.find(pid => pid !== status.pid),
  brokerIsDirectChildOfNode: true,
}

const cell = await host.execute('print("diag cell")')
report.cell = { outcome: cell.outcome, stdout: cell.stdout.text.trim() }

// (1)/(3) THE TIMELINE. Poll every 250 ms for 30 s and record when each pid dies.
const shutdownAt = Date.now()
let shutdownError: string | null = null
try {
  await host.shutdown()
} catch (error) {
  shutdownError = String(error)
}
report.shutdown = { ms: Date.now() - shutdownAt, error: shutdownError }

const timeline: Array<{ ms: number, alive: number[] }> = []
for (let step = 0; step < 120; step += 1) {
  const now = pythonPids()
  const alive = newPids.filter(pid => now.has(pid))
  timeline.push({ ms: Date.now() - shutdownAt, alive })
  if (alive.length === 0) break
  await sleep(250)
}

const last = timeline[timeline.length - 1]
report.timeline = {
  samples: timeline.length,
  firstSample: timeline[0],
  // The step at which each pid disappears is the whole answer.
  disappearance: newPids.map(pid => ({
    pid,
    role: pid === status.pid ? 'kernel' : 'broker',
    goneAtMs: timeline.find(sample => !sample.alive.includes(pid))?.ms ?? null,
  })),
  finalAlive: last?.alive ?? [],
  finalSampleMs: last?.ms ?? 0,
}

// If anything survived the 30 s window, wait longer: that separates "slow reap"
// from "permanent leak".
if ((last?.alive.length ?? 0) > 0) {
  await sleep(60_000)
  const late = pythonPids()
  report.longTail = {
    afterAnother60s: newPids.filter(pid => late.has(pid)),
    verdict: newPids.filter(pid => late.has(pid)).length === 0
      ? 'transient: gone within 90 s'
      : 'PERMANENT: survived 90 s',
  }
}

await ctx.fiber.dispose()
rmSync(root, { recursive: true, force: true })

console.log(JSON.stringify(report, null, 2))
