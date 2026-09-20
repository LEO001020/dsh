/**
 * R5 composition-tier driver: one real boot, through the port-safe harness.
 *
 * WHY A DRIVER AND NOT A DIRECT BOOT. `boot-harness.mjs` picks a genuinely free
 * port by BINDING it, kills the host afterwards, and VERIFIES the port was
 * released. A second agent booting on a guessed port produces EADDRINUSE ->
 * "2 required plugins did not activate" -> a boot that LOOKS like a composition
 * failure but is only a port conflict. That has already cost this project an
 * investigation, so every boot goes through the harness.
 *
 * THE OUTPUT PATH IS THIS WORKTREE'S OWN. This round measured that 22 of the 38
 * runners here hardcode an absolute path into the MAIN checkout, so running one
 * from a worktree writes into a tree the caller does not own and then reads back
 * a file another writer may have produced. That is the stale-artifact trap that
 * produced two retracted findings (G-SEAM-29, G-SEAM-36). This driver derives
 * its paths from its OWN location, so it cannot write outside the tree it is
 * running in.
 *
 * `readResult` is called because a probe that writes to a fixed path is a SHARED
 * MUTABLE RESOURCE: without the assertion that the result names THIS home, a
 * caller can read another agent's file and report it as its own.
 */
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { bootAndWait, readResult, sleep } from './boot-harness.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
// <repo>/qualification/runners -> <repo>
const REPO = resolve(HERE, '..', '..')

const HOME = process.env.R5_DSH_HOME ?? 'D:/DSH/home/r5'
const PROFILE = process.env.R5_PROFILE ?? 'daily'
const OUT = process.env.R5_OUT
  ?? resolve(REPO, 'qualification', 'results', 'R5-bridge', 'composition-tier.json')
const PATCH = resolve(REPO, 'qualification', 'runners', 'r5-bridge-product.patch.yml')

const boot = await bootAndWait({
  home: HOME,
  profile: PROFILE,
  patches: [PATCH],
  outPath: OUT,
  cwd: REPO,
  timeoutMs: 300_000,
})

// A partial write is possible if the harness sampled mid-write.
await sleep(500)

let result
let resultError = null
try {
  const read = readResult(OUT, HOME, 'presetRoots')
  result = read.json
} catch (error) {
  resultError = error instanceof Error ? error.message : String(error)
}

const summary = {
  scope: 'R5 composition tier driver',
  tree: REPO,
  home: HOME,
  profile: PROFILE,
  patch: PATCH,
  outPath: OUT,
  port: boot.port,
  portReleased: boot.portReleased,
  hostExitCode: boot.exitCode,
  timedOut: boot.timedOut,
  resultRead: result !== undefined,
  resultError,
  result,
  // Kept because a boot that fails to compose reports it here, and that is a
  // different finding from a probe that ran and reported a surface.
  stderrTail: boot.stderr.slice(-4000),
  stdoutTail: boot.stdout.slice(-2000),
}

process.stdout.write(JSON.stringify(summary, null, 2) + '\n')
