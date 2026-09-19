import { Context } from '@deepseek-ai/cordis'

const root = new Context()
// Provide a service at the ROOT, from the root fiber.
root.provide('rootService', { tag: 'root' })
console.log('root.get(rootService) =', root.get('rootService')?.tag)

// A child that isolates a DIFFERENT name (this is what a preset realm does).
const child = root.isolate('somePresetOwnedService')
console.log('child.get(rootService) =', child.get('rootService')?.tag)
console.log('child.get(terminalController) =', child.get('terminalController'))

// Now provide a service in the child's own realm.
child.provide('childService', { tag: 'child' })
console.log('root.get(childService) =', root.get('childService'))
console.log('child.get(childService) =', child.get('childService')?.tag)

// extend() semantics (metadata only)
const ext = root.extend({ hello: 1 })
console.log('ext.get(rootService) =', ext.get('rootService')?.tag)
console.log('ext.hello =', ext.hello)
