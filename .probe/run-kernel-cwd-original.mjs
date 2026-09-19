// Re-run the ORIGINAL kernel-cwd probe verbatim, against the current build, to
// decide whether G-SEAM-29 was a real defect or a stale-lib artifact.
import { bootAndWait } from '../qualification/runners/boot-harness.mjs'
import { readFileSync } from 'node:fs'
const OUT = 'D:/DSH/work/dsh-native-daily/qualification/results/ROOT-verification/kernel-cwd-rerun.json'
const boot = await bootAndWait({
  patches: ['D:/DSH/work/dsh-native-daily/.probe/kernel-cwd.patch.yml'],
  home: 'D:/DSH/home/root-m12-fresh', profile: 'daily', outPath: OUT, cwd: 'C:/Windows/Temp', timeoutMs: 120000,
})
console.log('port', boot.port, 'released', boot.portReleased)
console.log(readFileSync(OUT, 'utf8'))
