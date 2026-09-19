/**
 * Run the whole dsh-ipython suite while sampling python.exe every second.
 *
 * The isolated shutdown is clean (see `leak-diagnostic.mts`: both processes gone
 * 1069 ms after shutdown). The full suite is where the leak appeared, so the
 * question is whether a kernel survives, and if so WHICH one and for HOW LONG.
 *
 * Sampling continuously turns "2 pids appeared" into a timeline: when each new
 * pid first shows up, when it disappears, and how long it outlived the test that
 * created it.
 *
 *   node --experimental-strip-types .probe/leak-under-suite.mts
 */
import { execFileSync, spawn } from 'node:child_process'
import { appendFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const PKG = resolve(import.meta.dirname, '..')
const LOG = resolve(PKG, '.probe/leak-under-suite.jsonl')
writeFileSync(LOG, '')

function pythonPids(): Set<number> {
  try {
    const out = execFileSync('tasklist', ['/FI', 'IMAGENAME eq python.exe', '/NH', '/FO', 'CSV'], {
      encoding: 'utf8',
    })
    const set = new Set<number>()
    for (const line of out.split(/\r?\n/)) {
      const match = /^"python\.exe","(\d+)"/.exec(line.trim())
      if (match?.[1] !== undefined) set.add(Number(match[1]))
    }
    return set
  } catch {
    return new Set()
  }
}

const t0 = Date.now()
const baseline = pythonPids()
const firstSeen = new Map<number, number>()
const lastSeen = new Map<number, number>()

appendFileSync(LOG, `${JSON.stringify({ event: 'baseline', ms: 0, pids: [...baseline] })}\n`)

// Sampler runs for the whole suite and a grace period after it.
const sampler = setInterval(() => {
  const now = Date.now() - t0
  const current = pythonPids()
  for (const pid of current) {
    if (baseline.has(pid)) continue
    if (!firstSeen.has(pid)) {
      firstSeen.set(pid, now)
      appendFileSync(LOG, `${JSON.stringify({ event: 'appear', pid, ms: now })}\n`)
    }
    lastSeen.set(pid, now)
  }
}, 1000)

const child = spawn(
  process.platform === 'win32' ? 'npx.cmd' : 'npx',
  ['vitest', 'run', '--maxWorkers=1', '--no-file-parallelism'],
  { cwd: PKG, stdio: 'inherit', shell: process.platform === 'win32' },
)

const exitCode: number = await new Promise(resolvePromise => {
  child.on('close', code => { resolvePromise(code ?? -1) })
})
const suiteEnd = Date.now() - t0

// Keep sampling well past the suite so a slow reap is distinguishable from a leak.
await new Promise(resolvePromise => setTimeout(resolvePromise, 20_000))
clearInterval(sampler)

const final = pythonPids()
const survivors = [...firstSeen.keys()].filter(pid => final.has(pid))
const report = {
  exitCode,
  suiteEndMs: suiteEnd,
  baselineCount: baseline.size,
  // Pids that appeared during the run and how long each stayed.
  appeared: [...firstSeen.entries()].map(([pid, first]) => ({
    pid,
    firstSeenMs: first,
    lastSeenMs: lastSeen.get(pid) ?? first,
    livedMs: (lastSeen.get(pid) ?? first) - first,
    survivedToEnd: final.has(pid),
  })).sort((a, b) => a.firstSeenMs - b.firstSeenMs),
  survivors,
  verdict: survivors.length === 0
    ? 'no python.exe created by this suite outlived the sampling window'
    : `${survivors.length} python.exe survived the whole run AND a 20 s grace period`,
}
console.log(JSON.stringify(report, null, 2))
