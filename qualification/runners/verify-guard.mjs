/**
 * Boot-time probe: is the exact-owner guard actually MOUNTED in the composed
 * profile, and does it deny a stale owner?
 *
 * This exists because of a specific failure mode this project already hit once:
 * a module can be correct, tested, and still not be in the composition. The
 * tool-protocol suite proves the guard's logic; only a real boot proves the
 * profile mounts it. Before this probe, `cordis.patch.yml` did not include the
 * guard row at all, so B04's production closure was incomplete while its tests
 * were green.
 *
 * The guard is observable through the same seam that would deny a call, so the
 * probe drives a real `work` call from a FORGED owner object and reports the
 * denial reason. A guard that is mounted denies; a guard that is absent lets the
 * call through to the tool body, which fails differently.
 */
import { writeFileSync } from 'node:fs'

export const name = 'verify-guard'
export const inject = ['tools', 'agents']

const OUT = 'D:/DSH/work/dsh-native-daily/qualification/results/M9.21-guard-mounted/guard.json'

export async function apply(ctx) {
  const finding = {
    toolsServicePresent: false,
    forgedOwnerDenied: null,
    denialReason: null,
    honestPathAllowed: null,
    error: null,
  }

  try {
    const tools = ctx.get('tools')
    finding.toolsServicePresent = tools !== undefined

    // `guards` lives on the internal LAYER, not on `ToolRuntime`, so reading
    // `tools.guards` returns undefined and proves nothing. The observable seam is
    // `guardReason`, which is the documented read of the monotonic slot.
    //
    // A forged owner: same id a real Session would have, but not the object the
    // registry holds. This is exactly the stale-lifecycle shape.
    const forged = {
      id: 'session-forged-by-probe',
      session: { header: { id: 'session-forged-by-probe' } },
      ctx,
    }

    const exec = { name: 'work', agent: forged, callId: 'probe', arguments: { action: 'status' }, token: 0 }
    let reason
    try {
      reason = tools.guardReason(exec)
      finding.atApplyTime = reason ?? null
      // Sibling rows activate in service-availability order, not source order, so
      // a probe can legitimately be applied before the row it is asking about.
      // Re-check after the rest of the graph settles; the verdict must describe
      // the composed profile, not the moment this probe happened to run.
      for (let i = 0; i < 40 && reason === undefined; i += 1) {
        await new Promise(r => setTimeout(r, 50))
        reason = tools.guardReason(exec)
      }
      finding.settledAfterMs = 50
    } catch (e) {
      finding.error = `guardReason threw: ${e instanceof Error ? e.message : String(e)}`
    }
    finding.forgedOwnerDenied = reason !== undefined && reason !== null
    finding.denialReason = reason ?? null
    finding.guardMounted = finding.forgedOwnerDenied

    // Discriminating control: the SAME guard stage must leave an unrelated tool
    // alone. Without this, a guard that denied everything would also "deny the
    // forged owner" while breaking every other tool.
    const otherTool = { name: 'read', agent: forged, callId: 'probe3', arguments: {}, token: 0 }
    finding.otherToolUntouched = tools.guardReason(otherTool) === undefined

    // The guard is only useful if it is specific. A guard that denies EVERY call
    // would also "deny the forged owner" while breaking the product, so record
    // whether an ownerless execution is left alone -- that is the documented
    // non-denial case the tool body handles with a better diagnostic.
    const ownerless = { name: 'work', callId: 'probe2', arguments: { action: 'status' }, token: 0 }
    let ownerlessReason
    try {
      ownerlessReason = tools.guardReason(ownerless)
    } catch (e) {
      finding.error = `ownerless guardReason threw: ${e instanceof Error ? e.message : String(e)}`
    }
    finding.honestPathAllowed = ownerlessReason === undefined

  } catch (e) {
    finding.error = e instanceof Error ? e.message : String(e)
  }

  writeFileSync(OUT, JSON.stringify(finding, null, 2))
  process.stdout.write(`GUARD: ${JSON.stringify(finding)}\n`)
}
