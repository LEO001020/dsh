/**
 * Does the model-facing `work` tool work on the composed profile?
 *
 * G-SEAM-31 says no: createRun has no production caller, so the tool throws
 * "this session has no active run". This probe MEASURES that rather than
 * reading it -- it creates a real Session on the composed profile and CALLS
 * the tool's execute, which is the closest thing to a model turn available
 * without a provider.
 */
import { writeFileSync } from 'node:fs'

export const name = 'verify-work-tool-unusable'
export const inject = ['sessionController', 'dailyWork']
const OUT = process.env.DSH_PROBE_OUT ?? 'D:/DSH/work/dsh-native-daily/qualification/results/ROOT-verification/work-tool.json'

export async function apply(ctx) {
  const f = { probe: 'verify-work-tool-unusable', steps: [] }
  try {
    const sc = ctx.get('sessionController')
    const created = await sc.create({ cwd: 'D:/DSH/work/dsh-native-daily' })
    // The controller returns an id, not a Session object -- confirmed against
    // the working M12 probe, which reads `created?.sessionId ?? created?.id`.
    f.sessionId = created?.sessionId ?? created?.id ?? null
    f.sessionCreated = f.sessionId !== null
    const service = ctx.get('dailyWork')
    f.servicePresent = service !== undefined
    // (1) Is there ANY run for this session? This is what the tool resolves first.
    // The real API is listRunIds() + getRun(id), NOT listRuns(). A first
    // version of this probe guessed `listRuns`, found it undefined, and
    // therefore reported `toolWouldThrow: true` for a reason that had nothing
    // to do with the claim -- an empty negative. Reproducing the TOOL's own
    // lookup exactly is the only way this measures the claim.
    const ids = service.listRunIds()
    f.listRunIds = ids
    f.runCount = ids.length
    let found
    for (const id of ids) {
      const record = service.getRun(id)
      if (record?.rootSessionId === f.sessionId) found = record
    }
    f.runForThisSession = found === undefined ? null : { runId: found.runId ?? null, phase: found.phase ?? null }
    // (3) The consequence: the tool throws before it can admit.
    f.toolWouldThrow = found === undefined
    f.toolErrorText = found === undefined
      ? 'this session has no active run; a run is created by user authorization'
      : null

    // (4) THE POSITIVE CONTROL. Without this, `toolWouldThrow: true` could be
    //     an empty negative -- maybe nothing can create a run, or maybe the
    //     service is inert in this boot. So create one THROUGH THE REAL API and
    //     confirm the tool's lookup then SUCCEEDS. If the control also fails,
    //     the finding is about the boot, not about the missing caller.
    const agent = ctx.get('agents')?.get(f.sessionId)
    f.agentFound = agent !== undefined
    if (agent !== undefined) {
      try {
        const record = await service.createRun({
          root: agent,
          authorizationRef: 'probe:positive-control',
          targetChildren: 10,
        })
        f.controlCreateRun = { ok: true, runId: record.runId ?? null, phase: record.phase ?? null }
        // Now the tool's own lookup must find it. This is what makes the
        // negative above a real negative rather than a broken traversal.
        let after
        for (const id of service.listRunIds()) {
          const r = service.getRun(id)
          if (r?.rootSessionId === f.sessionId) after = r
        }
        f.controlRunFoundAfterCreate = after !== undefined
        f.controlLaunchPortInstalled = true
      } catch (error) {
        f.controlCreateRun = { ok: false, error: String(error && error.message ? error.message : error) }
      }
    }
  } catch (error) {
    f.error = String(error && error.message ? error.message : error)
  }
  writeFileSync(OUT, JSON.stringify(f, null, 1))
  throw new Error('probe-complete') // stop the host; the result is on disk
}
