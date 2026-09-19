import { Context } from '@deepseek-ai/cordis'

const root = new Context()
root.provide('globalThing', { tag: 'g' })

// The PROXY path (ctx.name) — this is what the fiber chain walk answers.
const child = root.isolate('unrelated')
try { console.log('proxy child.globalThing =', child.globalThing?.tag) }
catch (e) { console.log('proxy child.globalThing THREW:', e.message) }

// Compare with the `get` path.
console.log('get child.globalThing =', child.get('globalThing')?.tag)

// A service provided in the child's realm: can the root's proxy see it?
child.provide('childThing', { tag: 'c' })
try { console.log('proxy root.childThing =', root.childThing?.tag) }
catch (e) { console.log('proxy root.childThing THREW:', e.message) }
console.log('get root.childThing =', root.get('childThing')?.tag)
