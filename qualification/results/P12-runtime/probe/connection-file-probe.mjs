/**
 * P12 probe 2: WHERE IS THE CONNECTION FILE WHILE THE KERNEL IS ALIVE?
 *
 * WHY THIS IS A SEPARATE PROBE. `KernelManager` removes its connection file on
 * shutdown, so a walk taken after the kernel stops cannot see it -- the
 * `runtime-location-probe.mjs` AFTER run correctly reported an EMPTY `jupyter/`
 * directory and that is not evidence that the file was written elsewhere. This
 * probe walks while the kernel is up, which is the only window in which the
 * question "where does the HMAC-bearing file live" is answerable.
 *
 * WHAT IT ESTABLISHES, and it is a two-sided claim:
 *   (a) a connection file exists under `$DSH_HOME/runtime/ipython/...` during the
 *       run, and
 *   (b) `jupyter_core`'s default runtime dir does NOT exist, i.e. nothing was
 *       written to the user-profile location the unset variable would have used.
 *
 * (b) alone would be weak -- a run that wrote nothing anywhere would satisfy it --
 * which is exactly why (a) is measured in the same run.
 *
 * THE CONTROL ARM is `--unset-jupyter-runtime-dir`, which removes the pin by
 * running the kernel host directly with the variable absent. If (a) still holds
 * in that arm, the pin is not what put the file there and the fix is not
 * established.
 *
 * Usage:
 *   DSH_HOME=<dir> DSH_PYTHON=<interpreter> node connection-file-probe.mjs
 */
import { createRequire } from 'node:module'
import { existsSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..', '..', '..', '..')
const PACKAGE_ROOT = join(REPO, 'packages', 'dsh-ipython')
const BROKER = join(PACKAGE_ROOT, 'src', 'broker.py')

const packageRequire = createRequire(join(PACKAGE_ROOT, 'package.json'))
const load = async specifier => await import(pathToFileURL(packageRequire.resolve(specifier)).href)

const PYTHON = process.env['DSH_PYTHON']
const DSH_HOME = process.env['DSH_HOME']
if (PYTHON === undefined || PYTHON === '' || DSH_HOME === undefined || DSH_HOME === '') {
  console.error('DSH_HOME and DSH_PYTHON are required')
  process.exit(2)
}

/** Every `kernel-*.json` below `root`, so the answer is a path and not a boolean. */
function findConnectionFiles(root, limit = 200) {
  const found = []
  const queue = [root]
  while (queue.length > 0 && found.length < limit) {
    const current = queue.shift()
    let entries
    try {
      entries = readdirSync(current, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const full = join(current, entry.name)
      if (entry.isDirectory()) queue.push(full)
      else if (/^kernel-.*\.json$/.test(entry.name)) found.push(full)
    }
  }
  return found
}

const { Context } = await load('@deepseek-ai/cordis')
const { default: Subprocess } = await load('@deepseek-ai/dsh-subprocess-local')
const { KernelService } = await import(pathToFileURL(join(PACKAGE_ROOT, 'lib', 'kernel-plugin.js')).href)
const { defaultKernelRoot } = await import(pathToFileURL(join(PACKAGE_ROOT, 'lib', 'runtime-root.js')).href)

const ctx = new Context()
await ctx.plugin(Subprocess)
const service = new KernelService(ctx, { pythonExecutable: PYTHON, brokerScript: BROKER })
const agent = { session: { header: { id: 'p12-conn-probe', cwd: REPO } } }

const report = {
  probe: 'P12 connection file location (measured while the kernel is alive)',
  dshHome: DSH_HOME,
  defaultKernelRoot: defaultKernelRoot(),
  jupyterRuntimeDirEnv: process.env['JUPYTER_RUNTIME_DIR'] ?? null,
  kernelAlive: false,
  connectionFilesUnderDshHome: [],
  connectionFilesUnderPackage: [],
  connectionFilesUnderUserProfile: [],
  userProfileJupyterRuntimeDir: undefined,
  errors: [],
}

try {
  await service.runCell(agent, 'print("alive")')
  const status = await service.status(agent)
  report.kernelAlive = status?.alive === true
  report.transport = status?.transport
  report.curveKeysPresent = status?.curveKeysPresent

  // The walk happens HERE, with the kernel still up.
  report.connectionFilesUnderDshHome = findConnectionFiles(join(DSH_HOME, 'runtime'))
  report.connectionFilesUnderPackage = findConnectionFiles(PACKAGE_ROOT)
} catch (error) {
  report.errors.push(String(error && error.message ? error.message : error))
}

// The location the UNPINNED path would have used, asked of jupyter_core itself
// rather than restated from the docstring. Resolved in a child so a missing
// jupyter_core is a reported fact rather than a crash of this probe.
try {
  const { execFileSync } = await import('node:child_process')
  const out = execFileSync(PYTHON, ['-c', 'from jupyter_core.paths import jupyter_runtime_dir; print(jupyter_runtime_dir())'], {
    encoding: 'utf8',
    timeout: 30_000,
    windowsHide: true,
  }).trim()
  report.userProfileJupyterRuntimeDir = out
  report.connectionFilesUnderUserProfile = findConnectionFiles(out)
} catch (error) {
  report.errors.push(`could not ask jupyter_core for its runtime dir: ${String(error)}`)
}

await service.close().catch(() => undefined)
await ctx.fiber.dispose()

console.log(JSON.stringify(report, null, 2))
