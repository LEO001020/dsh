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
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'

const HERE = dirname(fileURLToPath(import.meta.url))
// <repo>/qualification/runners -> <repo>
const REPO = resolve(HERE, '..', '..')

const HOME = process.env.R5_DSH_HOME ?? 'D:/DSH/home/r5'
const PROFILE = process.env.R5_PROFILE ?? 'daily'
const OUT = process.env.R5_OUT
  ?? resolve(REPO, 'qualification', 'results', 'R5-bridge', 'composition-tier.json')
const PATCH_SRC = resolve(HERE, 'r5-bridge-product.patch.yml')
/**
 * The overlay is MATERIALISED INTO THIS TREE at run time, with the probe row
 * rewritten to name THIS tree's probe file.
 *
 * WHY IT IS NOT THE COMMITTED FILE ANY MORE. The committed overlay carries the
 * literal `D:/DSH/work/wt-r5/qualification/runners/r5-bridge-product.mjs`, and a
 * cordis row's `name:` is a MODULE SPECIFIER: the loader turns an absolute one
 * into a `file://` URL and imports exactly that file
 * (`packages/boot/app-boot/src/index.ts:521`, `vendor/loader/src/config/tree.ts:122-126`).
 * So a boot from any tree other than `wt-r5` executed ANOTHER writer's probe
 * while believing it measured its own composition -- cross-tree CODE EXECUTION,
 * not merely a cross-tree read. A relative `name:` is not a substitute: the
 * loader resolves it against the PROFILE directory, not against this file.
 *
 * Materialising the overlay beside this driver's own result keeps the row a
 * specifier the loader understands while making the file it names this tree's.
 */
const PATCH = resolve(REPO, 'qualification', 'results', 'R5-bridge', 'r5-bridge-product.patch.yml')
function materialiseOverlay() {
  const text = readFileSync(PATCH_SRC, 'utf8')
  const own = resolve(HERE, 'r5-bridge-product.mjs').replace(/\\/g, '/')
  const rewritten = text.replace(/^(\s*name:\s*)'[^']*r5-bridge-product\.mjs'/mu, `$1'${own}'`)
  if (rewritten === text) {
    throw new Error(`r5-bridge-driver: the overlay names no r5-bridge-product.mjs row to rewrite: ${PATCH_SRC}`)
  }
  mkdirSync(dirname(PATCH), { recursive: true })
  writeFileSync(PATCH, rewritten, 'utf8')
  return PATCH
}
materialiseOverlay()

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
