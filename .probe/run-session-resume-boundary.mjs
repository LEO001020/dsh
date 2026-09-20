/**
 * Two boots: SEED a confined session, then RESUME it through the product path.
 *
 * Boot 1 writes a real `sandbox/mode` event into a real session log. Boot 2 is a
 * FRESH process (so no agent is live) and calls the product's own resume entry
 * point, `ctx.sessionController.resolveAgent(sessionId)` — the same call the Web
 * UI makes when a user reopens a session.
 */
import { bootAndWait, readResult } from '../qualification/runners/boot-harness.mjs'

const HOME = 'D:/DSH/home/r1'
const DIR = 'D:/DSH/work/wt-r1/qualification/results/R1-trusted-local'
const PATCH = 'D:/DSH/work/wt-r1/.probe/session-resume.patch.yml'

async function boot(phase, outPath) {
  const b = await bootAndWait({
    patches: [PATCH], home: HOME, profile: 'daily', outPath, cwd: 'C:/Windows/Temp',
    timeoutMs: 120_000, env: { RESUME_PHASE: phase },
  })
  let json = null
  try { json = readResult(outPath, HOME).json } catch (e) { json = { ownershipCheckFailed: String(e.message) } }
  return { phase, boot: b, json }
}

const seed = await boot('seed', `${DIR}/session-resume-seed-result.json`)
console.log('=== SEED ===')
console.log(JSON.stringify(seed.json.seeded ?? seed.json, null, 1))

const resume = await boot('resume', `${DIR}/session-resume-boundary.json`)
console.log('=== RESUME (fresh process) ===')
console.log(JSON.stringify(resume.json.resume ?? resume.json, null, 1))
console.log('stderr:', String(resume.boot.stderr).slice(0, 900))
