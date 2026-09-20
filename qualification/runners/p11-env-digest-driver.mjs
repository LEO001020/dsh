/**
 * P11 composition-tier driver: boot the real `daily` profile with the
 * `p11-env-digest-product` probe mounted, and archive the result.
 *
 * WHY A DRIVER AND NOT A TEST. The probe runs INSIDE the booted host, where the
 * profile's own composition is what decides whether the environment identity is
 * manifest-derived. A test constructs its own context and therefore cannot answer
 * that question; see the probe's own header.
 *
 * IDENTITY. The result records which DSH_HOME, which profile, and which probe file
 * were used, because a composition-tier result that does not name its own boot
 * cannot be attributed to a tree.
 *
 * Run:
 *   DSH_HOME=D:/DSH/home/p11 node qualification/runners/p11-env-digest-driver.mjs
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { bootAndWait, readResult, sleep } from './boot-harness.mjs'
import { materialiseOverlay } from './overlay.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(HERE, '..', '..')
const OUT_DIR = join(REPO_ROOT, 'qualification', 'results', 'P11-env')
/** Where the PROBE writes. Distinct from the driver's record, because the driver
 * overwrites its own file at the end and would otherwise destroy the probe's
 * result -- measured: the first run of this driver read its own record back and
 * reported the probe as absent. */
const PROBE_OUT = join(OUT_DIR, 'composition-tier.probe.json')
const OUT = join(OUT_DIR, 'composition-tier.json')
const PROBE = join(HERE, 'p11-env-digest-product.mjs')
const PATCH_SRC = join(HERE, 'p11-env-digest-product.patch.yml')

const HOME = process.env['DSH_HOME']
if (HOME === undefined || HOME === '') {
  throw new Error('P11 driver: DSH_HOME must name this writer\'s own home; a shared home cannot be attributed to a caller')
}

mkdirSync(OUT_DIR, { recursive: true })
// Materialised into THIS tree, with the probe row rewritten to name THIS tree's
// probe file -- see the template's header for the cross-tree code execution this
// avoids.
const PATCH = materialiseOverlay(PATCH_SRC, join(OUT_DIR, 'p11-env-digest-product.patch.yml'), PROBE)

const boot = await bootAndWait({
  home: HOME,
  profile: 'daily',
  patches: [PATCH],
  outPath: PROBE_OUT,
  cwd: REPO_ROOT,
  timeoutMs: 180_000,
})

// A partial write is possible if the harness sampled mid-write.
await sleep(500)

// Read back through the harness's own reader, which ASSERTS the result describes
// the home that was booted -- a result from another agent's boot would otherwise
// be indistinguishable from this one's.
let result = null
let resultError = null
try {
  result = readResult(PROBE_OUT, HOME, 'presetRoots').json
} catch (error) {
  resultError = error instanceof Error ? error.message : String(error)
}

const record = {
  scope: 'P11 composition tier: the environment identity a REAL daily boot uses',
  identity: {
    dshHome: HOME,
    profile: 'daily',
    repoRoot: REPO_ROOT,
    probe: PROBE,
    overlay: PATCH,
    launcher: 'D:/DSH/src/dsh-src/apps/cli/lib/bin.js',
  },
  boot: {
    port: boot.port,
    exitCode: boot.exitCode,
    timedOut: boot.timedOut,
    // Kept short: the boot's stdout is not the finding and can be long.
    stdoutTail: boot.stdout.slice(-2000),
    stderrTail: boot.stderr.slice(-2000),
  },
  probeResult: result,
  resultError,
  verdict: {
    booted: result !== null,
    kernelServicePresent: result?.kernelServicePresent === true,
    digestIsFullSha256: result?.digestIsFullSha256 === true,
    digestMovedWithFileContent: result?.digestMovedWithFileContent === true,
    brokerRestoredByteIdentical: result?.brokerRestoredByteIdentical === true,
    error: result?.error ?? resultError,
  },
}

writeFileSync(OUT, `${JSON.stringify(record, null, 2)}\n`, 'utf8')
console.log(JSON.stringify(record.verdict, null, 2))
console.log(`\narchived: ${OUT}`)
if (record.verdict.error !== null || !record.verdict.booted) process.exitCode = 1
