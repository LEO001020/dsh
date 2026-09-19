import { bootAndWait, readResult, DSH_SRC } from '../qualification/runners/boot-harness.mjs'
import { writeFileSync } from 'node:fs'

const HOME = 'D:/DSH/home/root-m12-fresh'
const OUT = 'D:/DSH/work/dsh-native-daily/qualification/results/M12-deliverable-surface/surface-fresh-install.json'

// Boot from a FOREIGN cwd on purpose: the cwd-dependent preset root was the
// defect (G-FIX-13), so booting from the profile directory would not test it.
const boot = await bootAndWait({
  patches: ['D:/DSH/work/dsh-native-daily/qualification/runners/verify-deliverable-surface.patch.yml'],
  home: HOME, profile: 'daily', outPath: OUT, cwd: 'C:/Windows/Temp',
})
const { json, roots } = readResult(OUT, HOME)
writeFileSync(OUT + '.boot.json', JSON.stringify({ boot, roots }, null, 1))
console.log('PORT', boot.port, 'released:', boot.portReleased, 'timedOut:', boot.timedOut)
console.log('ROOTS', JSON.stringify(roots))
console.log('DEFAULT', json.presetDefaultId)
console.log('PRESETS', JSON.stringify(json.presetsListed?.map(p => p.id)))
console.log('TOOLCOUNT(agentKey)', json.toolCountAgentKey, 'ipython:', json.ipythonToolPresent, 'work:', json.workToolPresent)
console.log('ERROR', json.error)
