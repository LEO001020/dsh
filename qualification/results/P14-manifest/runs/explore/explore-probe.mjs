import { writeFileSync, realpathSync } from 'node:fs'
export const name = 'p14-explore'
export const inject = ['sessionController']
export async function apply(ctx) {
  const f = { ranAt: new Date().toISOString(), loaderInternal: null, rowSample: [], catalog: null, capProbe: {}, promptSections: null }
  try {
    const loader = ctx.get('loader')
    f.loaderInternal = loader?.internal === undefined ? null : { version: loader.internal.version, keys: Object.keys(loader.internal).slice(0, 20) }
    const entries = [...loader.entries()]
    f.entryCount = entries.length
    f.rowSample = entries.slice(0, 6).map(e => ({ id: e.options?.id, name: e.options?.name, baseUrl: e.parent?.tree?.ctx?.baseUrl ?? null, keys: Object.keys(e).slice(0,15) }))
    const own = entries.filter(e => String(e.options?.name ?? '').includes('dsh-'))
    f.ownRows = own.map(e => ({ id: e.options?.id, name: e.options?.name }))
    const sc = ctx.get('sessionController')
    const created = await sc.create({ cwd: 'D:/DSH/work/wt-p14' })
    const sid = created?.sessionId ?? created?.id
    const agent = ctx.get('agents')?.get(sid)
    if (agent) {
      const schemas = ctx.get('tools').schemas(agent)
      f.catalog = { toolCount: schemas.length, names: schemas.map(s => s.name) }
    }
    const dw = ctx.get('dailyWork')
    f.capProbe = { dailyWorkPresent: dw !== undefined, dwKeys: dw === undefined ? [] : Object.getOwnPropertyNames(Object.getPrototypeOf(dw)).slice(0, 40) }
    const sp = ctx.get('systemPrompt')
    f.promptSections = { present: sp !== undefined, keys: sp === undefined ? [] : Object.getOwnPropertyNames(Object.getPrototypeOf(sp)).slice(0, 30) }
  } catch (e) { f.error = `${e.name}: ${e.message}` }
  writeFileSync(process.env.P14_OUT, JSON.stringify(f, null, 2))
}
