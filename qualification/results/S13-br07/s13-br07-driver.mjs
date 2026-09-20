/**
 * S13 / BR-07 composition-tier driver: one real boot, through the port-safe harness.
 *
 * WHY A DRIVER AND NOT A DIRECT BOOT. `boot-harness.mjs` picks a genuinely free
 * port by BINDING it, kills the host afterwards and VERIFIES the port was
 * released. A guessed port produces EADDRINUSE -> "2 required plugins did not
 * activate" -> a boot that LOOKS like a composition failure and is only a port
 * conflict; that has already cost this project an investigation.
 *
 * EVERY PATH IS DERIVED FROM THIS FILE'S OWN LOCATION, so this driver cannot
 * write outside the tree it is running in. The probe's patch overlay is the only
 * absolute path and it names THIS worktree. R5's driver is not reused because its
 * `OUT` default and its overlay both point at `D:/DSH/work/wt-r5` and
 * `D:/DSH/home/r5` -- a sibling writer's tree and home -- which is the
 * foreign-artifact trap that produced G-SEAM-29 and G-SEAM-36.
 *
 * `readResult` is called because a probe that writes to a fixed path is a SHARED
 * MUTABLE RESOURCE: without the assertion that the result names THIS home, a
 * caller can read another agent's file and report it as its own.
 */
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { bootAndWait, readResult, sleep } from '../../runners/boot-harness.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
// <repo>/qualification/results/S13-br07 -> <repo>
const REPO = resolve(HERE, '..', '..', '..')

const HOME = process.env.S13_DSH_HOME ?? 'D:/DSH/home/s13'
const PROFILE = process.env.S13_PROFILE ?? 'daily'
const OUT = process.env.S13_OUT ?? resolve(HERE, 'composition-tier.json')
const PATCH = resolve(HERE, 's13-br07.patch.yml')

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
  result = readResult(OUT, HOME, 'presetRoots').json
} catch (error) {
  resultError = error instanceof Error ? error.message : String(error)
}

const summary = {
  scope: 'S13 / BR-07 composition-tier driver',
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
  stderrTail: boot.stderr.slice(-4000),
  stdoutTail: boot.stdout.slice(-2000),
}

process.stdout.write(JSON.stringify(summary, null, 2) + '\n')
