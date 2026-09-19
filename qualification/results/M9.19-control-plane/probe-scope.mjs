/**
 * E02 scope probe — the mechanism behind the reachability measurement.
 *
 * The first E02 boot reported `terminalController` reachable from the AGENT
 * scope but NOT from the host scope. That asymmetry is the kind of result that
 * is either the whole finding or a bug in the probe, so it is measured again
 * from the inside rather than reported on the strength of one reading.
 *
 * The question this answers: when `ctx.get(name)` returns a value, is that a
 * statement about SCOPE (the preset realm does or does not see the host's
 * instance) or a statement about the PROCESS-WIDE registry (any context that
 * names it resolves the one instance)? The two readings license completely
 * different claims about E02, so guessing is not acceptable.
 */
import { writeFileSync } from 'node:fs'

export const name = 'verify-e02-scope'
export const inject = ['agents', 'agentPresets', 'sessionController']

const OUT = process.env.E02_SCOPE_OUT ?? 'D:/DSH/work/dsh-native-daily/qualification/results/M9.19-control-plane/e02-scope.json'

/** The isolation symbol a context resolves `name` through, as a stable string. */
function isolateKey(ctx, name) {
  const map = ctx[Symbol.for('cordis.isolate')] ?? ctx[Object.getOwnPropertySymbols(ctx).find(s => String(s).includes('isolate')) ?? '']
  const symbols = Object.getOwnPropertySymbols(ctx).filter(s => String(s).includes('isolate'))
  const found = {}
  for (const sym of symbols) {
    const value = ctx[sym]
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      found[String(sym)] = name in value ? String(value[name]) : '(name absent)'
    }
  }
  return found
}

export async function apply(ctx) {
  const finding = { hostCtx: {}, agentCtx: {}, comparison: {}, errors: [] }
  try {
    const probe = (target, label) => {
      const out = {}
      for (const name of ['terminalController', 'pluginManager', 'webServer', 'sessionController', 'credentials', 'tools']) {
        let value
        try {
          value = target.get(name)
        } catch (error) {
          out[name] = `threw: ${error instanceof Error ? error.message : String(error)}`
          continue
        }
        out[name] = value === undefined
          ? false
          : { present: true, ctor: value?.constructor?.name ?? typeof value, hasName: value?.name ?? null }
      }
      finding[label] = out
      return out
    }

    // Which object is `ctx` here, and which is the root it shares?
    finding.hostCtxIdentity = {
      isRoot: ctx.root === ctx,
      fiberName: ctx.fiber?.name ?? null,
      rootFiberName: ctx.root?.fiber?.name ?? null,
      reflectSharedWithRoot: ctx.reflect === ctx.root?.reflect,
      isolateMapsSharedWithRoot: (() => {
        const sym = Object.getOwnPropertySymbols(ctx).find(s => String(s).includes('isolate'))
        if (sym === undefined) return 'no isolate symbol found'
        return ctx[sym] === ctx.root[sym]
      })(),
    }

    const host = probe(ctx, 'hostCtx')

    const sc = ctx.get('sessionController')
    const created = await sc.create({ cwd: process.cwd() })
    const sessionId = created?.sessionId ?? created?.id
    const agent = ctx.get('agents')?.get(sessionId)
    if (agent === undefined) {
      finding.errors.push('no live agent for the created session')
    } else {
      const agentOut = probe(agent.ctx, 'agentCtx')
      finding.agentCtxIdentity = {
        isRoot: agent.ctx.root === agent.ctx,
        fiberName: agent.ctx.fiber?.name ?? null,
        reflectSharedWithRoot: agent.ctx.reflect === agent.ctx.root?.reflect,
        reflectSharedWithHost: agent.ctx.reflect === ctx.reflect,
        storeSharedWithHost: agent.ctx.reflect?.store === ctx.reflect?.store,
      }
      for (const name of Object.keys(host)) {
        const h = host[name]
        const a = agentOut[name]
        finding.comparison[name] = {
          host: typeof h === 'object' ? 'present' : h,
          agent: typeof a === 'object' ? 'present' : a,
          // The load-bearing question: is it the SAME object?
          sameInstance: typeof h === 'object' && typeof a === 'object' ? h.ctor === a.ctor : null,
        }
      }
    }
  } catch (error) {
    finding.errors.push(error instanceof Error ? `${error.message}\n${error.stack}` : String(error))
  }
  writeFileSync(OUT, `${JSON.stringify(finding, null, 2)}\n`)
  process.stdout.write(`E02-SCOPE: ${JSON.stringify(finding)}\n`)
}
