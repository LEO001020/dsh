import { Context } from '@deepseek-ai/cordis'

const root = new Context()
const a = root.isolate('realmA')
const b = root.isolate('realmB')

a.provide('svcA', { tag: 'A' })
b.provide('svcB', { tag: 'B' })

console.log('a.get(svcA) =', a.get('svcA')?.tag)
console.log('a.get(svcB) =', a.get('svcB')?.tag)
console.log('b.get(svcA) =', b.get('svcA')?.tag)
console.log('b.get(svcB) =', b.get('svcB')?.tag)
console.log('root.get(svcA) =', root.get('svcA')?.tag)
console.log('root.get(svcB) =', root.get('svcB')?.tag)
console.log('reflect is shared:', a.reflect === root.reflect, b.reflect === root.reflect)
