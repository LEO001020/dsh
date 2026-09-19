import { bootAndWait, readResult } from '../qualification/runners/boot-harness.mjs'
const HOME = 'D:/DSH/home/root-docform'
const OUT = 'D:/DSH/work/dsh-native-daily/qualification/results/M12-deliverable-surface/surface-docform.json'
const boot = await bootAndWait({
  patches: ['D:/DSH/work/dsh-native-daily/qualification/runners/verify-deliverable-surface.patch.yml'],
  home: HOME, profile: 'daily', outPath: OUT, cwd: 'C:/Windows/Temp',
})
const { json } = readResult(OUT, HOME)
console.log('PORT', boot.port, 'released:', boot.portReleased)
console.log('DEFAULT', json.presetDefaultId, '| tools:', json.toolCountAgentKey, '| ipython:', json.ipythonToolPresent, '| error:', json.error)
