/**
 * Attribute every python.exe to its OWNER, then ask whether MINE survive.
 *
 * The previous sampler compared raw pid SETS, and that measurement was wrong: the
 * machine runs several other agents' Python, including the ZLoop bridge's own
 * IPython kernel (`E:\zcode-labs\zloop\plugin\runtime\...\bridge.py` ->
 * `ipykernel_launcher`). Those pids appeared mid-window and were counted as
 * survivors of THIS suite. A raw set diff cannot tell "my kernel leaked" from
 * "someone else's kernel started", so it is not evidence for either claim.
 *
 * Attribution is by COMMAND LINE, which is a fact about the process rather than
 * about timing:
 *   - `broker.py`            -> this package's broker
 *   - `ipykernel_launcher`   -> a kernel, but WHOSE?
 *
 * The second needs the connection file to disambiguate, so this sampler also
 * records the `-f <connection file>` argument and the parent pid, which is what
 * separates "a kernel my broker started" from "a kernel someone else started".
 *
 *   node --experimental-strip-types .probe/leak-attributed.mts [suite|idle]
 */
import { execFileSync, spawn } from 'node:child_process'
import { resolve } from 'node:path'

const PKG = resolve(import.meta.dirname, '..')
const MODE = process.argv[2] ?? 'suite'

interface Proc { pid: number, ppid: number, cmd: string }

function pythonProcs(): Proc[] {
  const script = [
    "Get-CimInstance Win32_Process -Filter \"Name='python.exe'\"",
    '| ForEach-Object { $c = $_.CommandLine; if (-not $c) { $c = "" };',
    'Write-Output ("{0}|{1}|{2}" -f $_.ProcessId, $_.ParentProcessId, $c) }',
  ].join(' ')
  const out = execFileSync('powershell', ['-NoProfile', '-Command', script], { encoding: 'utf8' })
  const procs: Proc[] = []
  for (const line of out.split(/\r?\n/)) {
    const parts = line.trim().split('|')
    if (parts.length < 3) continue
    const pid = Number(parts[0])
    if (!Number.isFinite(pid) || pid === 0) continue
    procs.push({ pid, ppid: Number(parts[1]), cmd: parts.slice(2).join('|') })
  }
  return procs
}

/** Which process owns this one: mine, or somebody else's? */
function owner(proc: Proc): 'mine-broker' | 'mine-kernel' | 'foreign' {
  if (proc.cmd.includes('dsh-ipython') && proc.cmd.includes('broker.py')) return 'mine-broker'
  if (proc.cmd.includes('ipykernel_launcher')) {
    // My broker starts the kernel as its own child, so a kernel whose ancestry
    // reaches a broker.py process is mine. Checked transitively below.
    return 'mine-kernel'
  }
  return 'foreign'
}

function classify(procs: Proc[]): { mine: number[], foreign: number[] } {
  const byPid = new Map(procs.map(p => [p.pid, p]))
  const mine: number[] = []
  const foreign: number[] = []
  for (const proc of procs) {
    // Walk up the ancestry: a kernel is mine iff some ancestor is my broker.
    let cursor: Proc | undefined = proc
    let isMine = false
    const guard = new Set<number>()
    while (cursor !== undefined && !guard.has(cursor.pid)) {
      guard.add(cursor.pid)
      if (owner(cursor) === 'mine-broker') { isMine = true; break }
      cursor = byPid.get(cursor.ppid)
    }
    if (proc.cmd.includes('broker.py') && proc.cmd.includes('dsh-ipython')) isMine = true
    ;(isMine ? mine : foreign).push(proc.pid)
  }
  return { mine, foreign }
}

const baselineProcs = pythonProcs()
const baseline = classify(baselineProcs)
console.log('baseline mine:', baseline.mine, 'foreign count:', baseline.foreign.length)

const seenMine = new Set<number>(baseline.mine)
const appeared: Array<{ pid: number, ms: number }> = []
const t0 = Date.now()
let suiteExit: number | null = null

const sampler = setInterval(() => {
  const { mine } = classify(pythonProcs())
  for (const pid of mine) {
    if (!seenMine.has(pid)) {
      seenMine.add(pid)
      appeared.push({ pid, ms: Date.now() - t0 })
      console.log(`  + mine appears: ${pid} at ${Date.now() - t0} ms`)
    }
  }
}, 1000)

if (MODE === 'suite') {
  const child = spawn('npx.cmd', ['vitest', 'run', '--maxWorkers=1', '--no-file-parallelism'],
    { cwd: PKG, stdio: 'inherit', shell: true })
  suiteExit = await new Promise<number>(r => { child.on('close', c => { r(c ?? -1) }) })
} else {
  // Control arm: idle for the same order of magnitude, proving the classifier
  // reports zero "mine" when nothing of mine runs.
  await new Promise(r => setTimeout(r, 30_000))
}
const atEnd = Date.now() - t0
await new Promise(r => setTimeout(r, 15_000))
clearInterval(sampler)

const finalProcs = pythonProcs()
const final = classify(finalProcs)
const survivors = [...seenMine].filter(pid => final.mine.includes(pid))
const byPid = new Map(finalProcs.map(p => [p.pid, p]))
console.log(JSON.stringify({
  mode: MODE,
  suiteExit,
  suiteMs: atEnd,
  mineSeenTotal: [...seenMine].length,
  appeared,
  survivors,
  survivorDetails: survivors.map(pid => ({ pid, cmd: byPid.get(pid)?.cmd.slice(0, 200) })),
  verdict: survivors.length === 0
    ? 'NO process of mine (broker or kernel) survived the run plus a 15 s grace period'
    : `${survivors.length} of my processes survived`,
}, null, 2))
