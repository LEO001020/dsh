import { bootAndWait, readResult } from '../qualification/runners/boot-harness.mjs'
const OUT = 'D:/DSH/work/wt-r1/qualification/results/R1-trusted-local/mount-latency.json'
const boot = await bootAndWait({
  patches: ['D:/DSH/work/wt-r1/.probe/mount-latency.patch.yml'],
  home: 'D:/DSH/home/r1', profile: 'daily', outPath: OUT, cwd: 'C:/Windows/Temp', timeoutMs: 60_000,
})
let json = null
try { json = readResult(OUT, 'D:/DSH/home/r1').json } catch (e) { json = { ownershipCheckFailed: String(e.message) } }
console.log('port', boot.port, 'timedOut', boot.timedOut, 'stderr:', String(boot.stderr).slice(0, 400))
console.log(JSON.stringify(json, null, 1))
