/**
 * THE SESSION-RESUME BOUNDARY, exercised through the REAL product path.
 *
 * WHY A TWO-PHASE PROBE. V3 §F2's hazard is "a Session whose DURABLE LOG carries
 * a confining `sandbox/mode` override". `resolve()` is
 * `request.mode ?? overrideOf(session) ?? defaultMode`, so the deployment default
 * being `danger-full-access` does NOT migrate such a session -- it still resolves
 * confined. The only way to reach that state through the product is for the
 * session to EXIST and then be loaded again, so:
 *
 *   phase "seed"  -- create a real Session and append a real `sandbox/mode` event
 *                    through the public writer, then write the session id to a
 *                    sidecar file.
 *   phase "resume"-- boot FRESH (so the agent is not live in the registry) and
 *                    call `ctx.sessionController.resolveAgent(sessionId)`, which
 *                    is the product's own resume entry point. This is the same
 *                    call the Web UI makes when a user reopens a session.
 *
 * The refusal is recorded even when it throws, because "no artifact" cannot be
 * distinguished from "the probe never ran".
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'

export const name = 'verify-session-resume-boundary'
export const inject = ['sessionController']

const DIR = 'D:/DSH/work/wt-r1/qualification/results/R1-trusted-local'
const SIDECAR = `${DIR}/session-resume-seed.json`
const CONFINING_MODE = 'workspace-write'

export async function apply(ctx) {
  const phase = process.env.RESUME_PHASE ?? 'seed'
  const out = {
    probe: 'verify-session-resume-boundary',
    phase,
    ranAt: new Date().toISOString(),
    presetRoots: [],
    confiningMode: CONFINING_MODE,
    error: null,
  }
  const roster = ctx.get('agentPresets')
  if (roster !== undefined) out.presetRoots = (roster.roots ?? []).map(r => ({ path: String(r.path), trust: String(r.trust) }))

  try {
    const sc = ctx.get('sessionController')
    const policy = ctx.get('sandboxPolicy')
    const agents = ctx.get('agents')

    if (phase === 'seed') {
      const created = await sc.create({ cwd: 'D:/DSH/work/wt-r1' })
      const sessionId = created?.sessionId ?? created?.id ?? null
      const agent = sessionId === null ? undefined : agents?.get(sessionId)
      out.seeded = { sessionId, agentPresent: agent !== undefined }
      if (agent !== undefined) {
        // THE PUBLIC WRITE PATH: `setSandboxMode` appends exactly one
        // `sandbox/mode` event ("the switch IS its event").
        const { setSandboxMode } = await import(
          new URL('../packages/dsh-daily-work/node_modules/@deepseek-ai/dsh-sandbox-policy/lib/index.js', import.meta.url).href
        )
        setSandboxMode(agent.session, CONFINING_MODE)
        out.seeded.overrideAfterAppend = policy?.overrideOf(agent.session) ?? null
        out.seeded.resolvedAfterAppend = policy?.resolve({ session: agent.session }).mode ?? null
        // Let the durable log commit before the process is torn down.
        await new Promise(r => setTimeout(r, 1200))
        out.seeded.durableLogWritten = true
      }
      mkdirSync(DIR, { recursive: true })
      writeFileSync(SIDECAR, JSON.stringify({ sessionId, cwd: 'D:/DSH/work/wt-r1', mode: CONFINING_MODE }, null, 1))
    } else {
      const seed = JSON.parse(readFileSync(SIDECAR, 'utf8'))
      out.resume = { sessionId: seed.sessionId, expectedOverride: seed.mode, defaultMode: policy?.defaultMode ?? null }
      out.resume.agentLiveBefore = agents?.get(seed.sessionId) !== undefined
      // The product's own resume entry point. A refusal here is the finding.
      try {
        const resolved = await sc.resolveAgent(seed.sessionId)
        out.resume.outcome = resolved?.error !== undefined
          ? { kind: 'error-result', error: String(resolved.error?.message ?? resolved.error) }
          : { kind: 'agent-returned', agentId: String(resolved?.agent?.id ?? resolved?.id ?? 'unknown') }
        out.resume.refused = resolved?.error !== undefined
      } catch (error) {
        out.resume.outcome = { kind: 'threw', message: String(error?.message ?? error) }
        out.resume.refused = true
      }
      const live = agents?.get(seed.sessionId)
      out.resume.agentLiveAfter = live !== undefined
      if (live !== undefined) {
        out.resume.resolvedModeAfter = policy?.resolve({ session: live.session }).mode ?? null
      }
    }
  } catch (error) {
    out.error = `${error?.name ?? 'Error'}: ${error?.message ?? String(error)}`
  }

  writeFileSync(process.env.DSH_PROBE_OUT ?? `${DIR}/session-resume-${phase}.json`, JSON.stringify(out, null, 1))
  throw new Error('probe-complete')
}
