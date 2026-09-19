// Does the MODEL-VISIBLE tool schema expose sandbox escalation params?
import { writeFileSync } from 'node:fs'
export const name = 'probe-tool-schema'
export const inject = ['sessionController', 'ipython']
const OUT = process.env.DSH_PROBE_OUT ?? 'D:/tmp/schema.json'
export async function apply(ctx) {
  const f = { tools: [], sandboxParams: {}, error: null }
  try {
    const sc = ctx.get('sessionController')
    const created = await sc.create({ cwd: 'D:/DSH/work/dsh-native-daily' })
    const agent = ctx.get('agents')?.get(created?.sessionId ?? created?.id)
    const schemas = ctx.get('tools').schemas(agent)
    f.tools = schemas.map(s => s.name).sort()
    for (const s of schemas) {
      const props = Object.keys((s.parameters ?? {}).properties ?? {})
      const bad = props.filter(p => /sandbox|justification|escalat/i.test(p))
      if (bad.length) f.sandboxParams[s.name] = bad
    }
  } catch (e) { f.error = String(e) }
  writeFileSync(OUT, JSON.stringify(f, null, 2))
}
