/**
 * Is the no-sandbox contract guard actually MOUNTED and reachable on the
 * composed profile?
 *
 * T5 built and compiled it and correctly reported that it had no exports entry
 * and no patch row, so nothing booted it -- the defect class this project has
 * recorded eleven times. The root agent wired it. This measures whether the
 * wiring works: the service must be present AND its report must be readable.
 */
import { writeFileSync } from 'node:fs'

export const name = 'verify-contract-mounted'
export const inject = ['sessionController']
const OUT = process.env.DSH_PROBE_OUT ?? 'D:/DSH/work/dsh-native-daily/qualification/results/ROOT-verification/contract-mounted.json'

export async function apply(ctx) {
  const f = { probe: 'verify-contract-mounted' }
  try {
    const svc = ctx.get('noSandboxContract')
    f.servicePresent = svc !== undefined
    if (svc !== undefined) {
      // The deployment-level report. It must not throw: the module's own doc says
      // a degraded graph is what it is FOR.
      const report = svc.checkDeployment()
      f.reportOk = report !== undefined
      f.reportVerdict = report?.verdict ?? null
      f.checkCount = Array.isArray(report?.checks) ? report.checks.length : null
      f.failedChecks = (report?.checks ?? []).filter(c => c.ok === false).map(c => c.id ?? c.label ?? c.name)
      f.observedMode = report?.observed?.sandboxPolicyMode ?? null
    }
    // The loader's own view: is the row present and ACTIVE?
    const loader = ctx.get('loader')
    f.loaderPresent = loader !== undefined
    if (loader !== undefined) {
      const entries = typeof loader.entries === 'function' ? loader.entries() : []
      f.entryCount = entries.length
      // Dump the row SHAPE first: an earlier version of this probe filtered on
      // `.name` and got nothing, and the serialized result was `{}` -- which
      // cannot distinguish "no matching row" from "entries have no name field".
      f.sampleRow = entries.length > 0 ? Object.keys(entries[0]).slice(0, 12) : null
      const matches = []
      for (const e of entries) {
        const hay = JSON.stringify({ id: e.id, name: e.name, plugin: e.plugin?.name })
        if (hay.includes('no-sandbox-contract')) {
          matches.push({ id: e.id ?? null, name: e.name ?? null, disabled: e.disabled ?? null, fiberState: e.fiberState ?? null })
        }
      }
      f.rowsMatchingNoSandbox = matches
      f.rowPresent = matches.length > 0
      f.rowFiberState = matches.length > 0 ? matches[0].fiberState : null
    }
  } catch (error) {
    f.error = String(error && error.message ? error.message : error)
  }
  writeFileSync(OUT, JSON.stringify(f, null, 1))
  throw new Error('probe-complete')
}
