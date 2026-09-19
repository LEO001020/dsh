import { bootAndWait } from '../qualification/runners/boot-harness.mjs'
import { readFileSync } from 'node:fs'
const OUT = 'D:/DSH/work/dsh-native-daily/qualification/results/ROOT-verification/work-tool.json'
const boot = await bootAndWait({
  patches: ['D:/DSH/work/dsh-native-daily/.probe/work-tool.patch.yml'],
  home: 'D:/DSH/home/root-m12-fresh', profile: 'daily', outPath: OUT, cwd: 'C:/Windows/Temp',
})
console.log('port', boot.port, 'released', boot.portReleased)
console.log(readFileSync(OUT, 'utf8'))
