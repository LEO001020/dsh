import { writeFileSync, realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
export const name = 'p14-explore2'
export const inject = ['sessionController']
export async function apply(ctx) {
  const f = { ranAt: new Date().toISOString() }
  try {
    const loader = ctx.get('loader')
    const baseUrl = loader.ctx.baseUrl
    f.baseUrl = baseUrl
    const resolved = []
    for (const e of loader.entries()) {
      const nm = e.options?.name
      if (nm === undefined) continue
      const id = String(e.options?.id ?? '')
      if (!/dsh-daily-work|dsh-ipython|^@deepseek-ai\//.test(String(nm))) continue
      let row = { id, name: nm, url: null, realpath: null, err: null }
      try {
        const r = loader.internal.version === 'v2'
          ? loader.internal.resolveSync(baseUrl, { specifier: String(nm) })
          : loader.internal.resolveSync(String(nm), baseUrl, {})
        row.url = r.url
        try { row.realpath = realpathSync(fileURLToPath(r.url)) } catch (e2) { row.err = 'fileURL: ' + e2.message.slice(0,80) }
      } catch (e) { row.err = `${e.code ?? e.name}: ${String(e.message).slice(0,100)}` }
      resolved.push(row)
    }
    f.resolvedCount = resolved.length
    f.resolved = resolved
    f.ownRows = resolved.filter(r => /dsh-daily-work|dsh-ipython/.test(String(r.name)))
    // resolved config of selected rows
    f.rowConfigs = {}
    for (const e of loader.entries()) {
      const id = String(e.options?.id ?? '')
      if (['tools','subagent','sandbox-policy','agent-presets','daily-work-host','ipython-kernel-host','agent-loop'].includes(id)) {
        f.rowConfigs[id] = { name: e.options?.name ?? null, config: e.options?.config ?? null }
      }
    }
    // dailyWork capacity
    const dw = ctx.get('dailyWork')
    try { f.dwCapacity = dw.capacity } catch (e) { f.dwCapacityErr = String(e.message).slice(0,120) }
    // tool catalog + presentation inference
    const sc = ctx.get('sessionController')
    const created = await sc.create({ cwd: 'D:/DSH/work/wt-p14' })
    const sid = created?.sessionId ?? created?.id
    const agent = ctx.get('agents')?.get(sid)
    if (agent) {
      const schemas = ctx.get('tools').schemas(agent)
      f.catalog = { count: schemas.length, names: schemas.map(s => s.name), hasRunCode: schemas.some(s => s.name === 'run_code') }
      try { f.presentAsConflict = 'presentAs exists: ' + String(typeof ctx.get('tools').presentAs) } catch (e) { f.presentAsConflict = String(e.message) }
    }
  } catch (e) { f.error = `${e.name}: ${e.message}` }
  writeFileSync(process.env.P14_OUT, JSON.stringify(f, null, 2))
}
