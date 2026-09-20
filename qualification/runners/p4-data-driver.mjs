/**
 * Drive `p4-data-product.mjs` through a REAL boot of this worktree's profile.
 *
 * WHY A DRIVER AND NOT JUST THE PROBE. The probe runs INSIDE the host process, so
 * it cannot boot the host. The boot must name this caller's own `DSH_HOME` and
 * write its result to this caller's own path, and both are decided here.
 *
 * THE RESULT IS READ BACK AND CHECKED AGAINST THE HOME THAT WAS BOOTED. A probe
 * that writes to a fixed path is a shared mutable resource, and this project
 * already reported one false PASS from exactly that (G-FIX-13: a reader held a
 * result produced by a different agent's home). So this driver asserts the result
 * names the home it booted before it reports anything.
 *
 * ONE BOOT AT A TIME. Fifteen writers share this machine; the harness picks a
 * genuinely free port by binding it, so concurrent boots do not collide.
 */
import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { bootAndWait } from './boot-harness.mjs'
import { materialiseOverlay } from './overlay.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..', '..')

const HOME = process.env.P4_DSH_HOME ?? 'D:\\DSH\\home\\p4'
const OUT = process.env.DSH_PROBE_OUT
if (OUT === undefined || OUT === '') {
  throw new Error('p4-data-driver: DSH_PROBE_OUT must name this caller\'s own result path')
}

// THE OVERLAY IS MATERIALISED INTO THIS TREE, naming THIS tree's probe. The
// committed template carries a placeholder precisely so that a boot from another
// checkout cannot execute this one's probe (see the template's own comment).
const PATCH = materialiseOverlay(
  join(HERE, 'p4-data-product.patch.yml'),
  join(dirname(OUT), 'p4-data-product.patch.yml'),
  join(HERE, 'p4-data-product.mjs'),
)

mkdirSync(dirname(OUT), { recursive: true })
if (process.env.P4_KEEP_OUT !== '1') rmSync(OUT, { force: true })

const boot = await bootAndWait({
  home: HOME,
  profile: process.env.P4_PROFILE ?? 'daily',
  patches: [PATCH],
  outPath: OUT,
  cwd: REPO,
  timeoutMs: 180_000,
})

const verdict = {
  driver: 'p4-data-driver',
  homeBooted: HOME,
  profile: process.env.P4_PROFILE ?? 'daily',
  port: boot.port,
  portReleased: boot.portReleased,
  timedOut: boot.timedOut,
  exitCode: boot.exitCode,
  resultWritten: false,
  resultNamesBootedHome: false,
  probe: null,
  stderrTail: boot.stderr.slice(-2000),
  stdoutTail: boot.stdout.slice(-2000),
}

try {
  const raw = readFileSync(OUT, 'utf8')
  verdict.resultWritten = true
  verdict.probe = JSON.parse(raw)
  // THE ATTRIBUTION CHECK. The probe records the DSH_HOME it actually ran under;
  // if that is not the home this driver booted, the result belongs to somebody
  // else's tree and must not be reported.
  verdict.resultNamesBootedHome = verdict.probe.homeBooted === HOME
} catch (error) {
  verdict.stderrTail += `\n[driver] could not read the probe result: ${error instanceof Error ? error.message : String(error)}`
}

console.log(JSON.stringify(verdict, null, 2))
