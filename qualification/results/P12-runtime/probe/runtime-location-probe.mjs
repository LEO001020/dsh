/**
 * P12 BEFORE/AFTER probe: WHERE DOES A REAL KERNEL'S SCRATCH LAND?
 *
 * WHAT THIS MEASURES, and why it is not a unit test. The claim under audit is
 * that kernel runtime state (connection file, broker/kernel logs, spill files,
 * bridge artifacts) is written into the PACKAGE tree. A test that asserts on a
 * constant cannot distinguish "the constant moved" from "the kernel actually
 * wrote somewhere else", so this probe starts a REAL ipykernel through the REAL
 * `KernelService`, runs one cell, and then walks the filesystem to report which
 * directories actually received files.
 *
 * TWO OBSERVATIONS, both from the same run:
 *   1. `DEFAULT_KERNEL_ROOT` -- the path the service resolves when the profile
 *      sets no `root`. Reported verbatim from the loaded module.
 *   2. The set of paths under the PACKAGE ROOT and under `$DSH_HOME` that
 *      appeared during the run. Reported as `packageScratchEntries` and
 *      `homeRuntimeEntries`.
 *
 * THE CONTROL ARM is the same probe run with an explicit `root` outside the
 * package. If the walk reports package entries in that arm too, the walk is
 * measuring something other than the kernel's writes and the result is void.
 *
 * MODULE RESOLUTION. This file lives under `qualification/`, which has no
 * `node_modules`; it resolves `@deepseek-ai/*` through the package's own
 * `package.json`, so the probe loads THE PACKAGE'S dependencies and not a
 * different copy. The kernel service itself is loaded from the package's built
 * `lib/`, which is what a profile loads -- the point is to measure the artifact
 * the product runs.
 *
 * Usage:
 *   DSH_HOME=<dir> DSH_PYTHON=<interpreter> node runtime-location-probe.mjs [--root <dir>]
 */
import { createRequire } from 'node:module'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
// qualification/results/P12-runtime/probe -> repo root is four levels up.
const REPO = resolve(HERE, '..', '..', '..', '..')
const PACKAGE_ROOT = join(REPO, 'packages', 'dsh-ipython')
const BROKER = join(PACKAGE_ROOT, 'src', 'broker.py')

const packageRequire = createRequire(join(PACKAGE_ROOT, 'package.json'))
const load = async specifier => await import(pathToFileURL(packageRequire.resolve(specifier)).href)

const args = process.argv.slice(2)
const explicitRootIndex = args.indexOf('--root')
const explicitRoot = explicitRootIndex === -1 ? undefined : args[explicitRootIndex + 1]

const PYTHON = process.env['DSH_PYTHON']
if (PYTHON === undefined || PYTHON === '') {
  console.error('DSH_PYTHON is required: this probe must not fall back to a personal path')
  process.exit(2)
}
const DSH_HOME = process.env['DSH_HOME']
if (DSH_HOME === undefined || DSH_HOME === '') {
  console.error('DSH_HOME is required: this probe measures the DSH_HOME runtime tree')
  process.exit(2)
}

/** Recursively list every entry below `root`, bounded, as relative paths. */
async function walk(root, limit = 400) {
  const found = []
  const queue = [root]
  while (queue.length > 0 && found.length < limit) {
    const current = queue.shift()
    let entries
    try {
      entries = await readdir(current, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const full = join(current, entry.name)
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'lib') continue
        queue.push(full)
        found.push(relative(root, full) + '/')
      } else {
        found.push(relative(root, full))
      }
    }
  }
  return found.sort()
}

const before = {
  package: await walk(PACKAGE_ROOT),
  home: await walk(DSH_HOME),
}

const { Context } = await load('@deepseek-ai/cordis')
const { default: Subprocess } = await load('@deepseek-ai/dsh-subprocess-local')
const { KernelService, DEFAULT_KERNEL_ROOT } = await import(
  pathToFileURL(join(PACKAGE_ROOT, 'lib', 'kernel-plugin.js')).href
)

const ctx = new Context()
await ctx.plugin(Subprocess)

const service = new KernelService(ctx, {
  pythonExecutable: PYTHON,
  brokerScript: BROKER,
  ...explicitRoot === undefined ? {} : { root: explicitRoot },
})

const sessionId = 'p12-probe-session'
const agent = { session: { header: { id: sessionId, cwd: REPO } } }

const report = {
  probe: 'P12 runtime location',
  arm: explicitRoot === undefined ? 'DEFAULT (no root configured)' : `EXPLICIT root=${explicitRoot}`,
  dshHome: DSH_HOME,
  packageRoot: PACKAGE_ROOT,
  python: PYTHON,
  defaultKernelRootConstant: DEFAULT_KERNEL_ROOT,
  defaultKernelRootInsidePackage: DEFAULT_KERNEL_ROOT.startsWith(PACKAGE_ROOT),
  cellOutcome: undefined,
  cellStdout: undefined,
  kernelCwd: undefined,
  transport: undefined,
  curveKeysPresent: undefined,
  packageScratchEntries: [],
  homeRuntimeEntries: [],
  errors: [],
}

try {
  const result = await service.runCell(agent, 'import os; print("KERNEL_CWD=" + os.getcwd())')
  report.cellOutcome = result.outcome
  report.cellStdout = result.stdout.text.trim()
  const status = await service.status(agent)
  report.kernelCwd = status?.kernelCwd ?? null
  report.transport = status?.transport
  report.curveKeysPresent = status?.curveKeysPresent
} catch (error) {
  report.errors.push(String(error && error.message ? error.message : error))
}

const after = {
  package: await walk(PACKAGE_ROOT),
  home: await walk(DSH_HOME),
}

const beforePkg = new Set(before.package)
const beforeHome = new Set(before.home)
report.packageScratchEntries = after.package.filter(entry => !beforePkg.has(entry))
report.homeRuntimeEntries = after.home.filter(entry => !beforeHome.has(entry))

// What is under each candidate scratch root right now, new or not.
const scratchCandidates = [
  DEFAULT_KERNEL_ROOT,
  join(DSH_HOME, 'runtime', 'ipython'),
  explicitRoot,
].filter(value => typeof value === 'string')

report.scratchTree = {}
for (const candidate of scratchCandidates) {
  report.scratchTree[candidate] = {
    exists: existsSync(candidate),
    entries: existsSync(candidate) ? await walk(candidate, 100) : [],
  }
}

await service.close().catch(() => undefined)
await ctx.fiber.dispose()

console.log(JSON.stringify(report, null, 2))
