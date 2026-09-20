/**
 * WHERE RUNTIME STATE LIVES: `$DSH_HOME/runtime/...`, never the package.
 *
 * THE DEFECT THIS FILE CLOSES (V5 §11.4 / finding O). `DEFAULT_KERNEL_ROOT` was
 * `join(PACKAGE_ROOT, '.ipython-kernels')` -- runtime scratch inside the
 * package. MEASURED, by running one real cell through the real `KernelService`
 * and walking the tree before and after: nine new entries appeared inside
 * `packages/dsh-ipython/`, and nothing at all under `$DSH_HOME`
 * (`qualification/results/P12-runtime/before-default-root.json`). The control
 * arm, the same run with an explicit root outside the package, reported zero
 * package entries -- so the walk measures the kernel's writes rather than
 * incidental churn.
 *
 * WHY THAT IS A DEFECT AND NOT A PREFERENCE. Two independent reasons, and either
 * alone would be enough:
 *
 *   1. AN INSTALLED PACKAGE MAY BE READ-ONLY. `node_modules` under a global or
 *      system-wide install is not writable by the user running DSH, and the
 *      failure is a kernel that cannot start at all -- with an `EACCES` on a
 *      `.ipython-kernels` path that names a dependency, which reads as a broken
 *      package rather than a misconfigured home.
 *   2. A SOURCE CHECKOUT MUST NOT BE POLLUTED BY RUNTIME STATE. The scratch tree
 *      has to be `.gitignore`d to keep `git status` meaningful (`.gitignore:23`),
 *      and this project has twice had an untracked file mistaken for a real
 *      defect (G-SEAM-30, G-SEAM-42). An ignore rule that exists only because
 *      the code writes to the wrong place is a symptom being managed.
 *
 * THE LAYOUT (V5 §11.4, verbatim):
 *
 *     $DSH_HOME/runtime/ipython/<session-hash>/<epoch>/
 *
 * `<session-hash>` rather than the raw Session id, and `<epoch>` as a real
 * directory level rather than a filename prefix, for one reason each:
 *
 *   - A Session id is opaque and may contain characters that are illegal or
 *     meaningful in a path (`:`, `/`, `\`, a leading dot). `sanitize()` already
 *     replaced them, but sanitizing is LOSSY: two different Session ids can map
 *     to one directory, which would put two Sessions' kernels in one scratch
 *     tree. A hash does not collide by construction, so the directory name is
 *     `sha256(sessionId)` truncated -- still deterministic, still readable in a
 *     listing by matching it against the recorded `sessionId`.
 *   - The EPOCH is the kernel generation, and a restart allocates a NEW one
 *     (`KernelService.restart`). Giving each epoch its own directory means a
 *     restarted kernel cannot inherit its predecessor's connection file, spill
 *     files or logs -- the class of defect where a stale file from a dead
 *     namespace is read as if it described the live one. It also makes the
 *     disposal story decidable: what is left under an old epoch directory is
 *     provably garbage, so it can be reaped without guessing.
 *
 * TWO THINGS STAY SEPARATE, and conflating them was a real defect once already
 * (`kernel.ts:66-79`): the KERNEL'S CWD is the Session's project root, so
 * `open("out.csv")` writes where the model will look; the SCRATCH ROOT is this
 * tree, so connection files, broker logs and spill files do not. This module
 * only ever answers the second question.
 *
 * ===========================================================================
 * THE JUPYTER RUNTIME DIRECTORY IS A THIRD LOCATION, AND IT IS NOT OURS TO LEAVE
 * ===========================================================================
 *
 * MEASURED, not assumed: the connection file does NOT land in the kernel root.
 * `jupyter_client` writes it through `jupyter_core.paths.jupyter_runtime_dir()`,
 * which on this machine resolved to
 * `E:\zcode-labs\zloop-home\AppData\Roaming\jupyter\runtime` -- a user-profile
 * directory outside BOTH the package and `$DSH_HOME`. That file carries the HMAC
 * key that authorises execution on the kernel's sockets, so leaving it in an
 * unmanaged location means the scratch tree can be perfectly clean while the
 * capability-bearing file is somewhere no part of this deployment controls.
 *
 * `JUPYTER_RUNTIME_DIR` is therefore set explicitly (see {@link jupyterRuntimeDir})
 * and it is NOT currently set anywhere in this package -- `kernel.ts:240-255`
 * sets five variables and this is not one of them.
 *
 * WHY THE RESOLVER IS DUPLICATED HERE INSTEAD OF IMPORTED. `@deepseek-ai/dsh-home-paths`
 * is the canonical resolver (`resolveDshHome`, `dshHomePath`) and this module
 * deliberately mirrors its precedence rather than inventing a different one.
 * It is not imported because it does not resolve from this package: measured,
 * `createRequire(packages/dsh-ipython/package.json).resolve('@deepseek-ai/dsh-home-paths')`
 * throws `MODULE_NOT_FOUND`, and the provisioned junction farm has 13 entries
 * without it. Importing it would therefore break the BUILD of every worktree
 * until the farm is extended -- a change to shared provisioning tooling, which is
 * not this slice's to make. The duplication is bounded to four lines and its
 * conformance is asserted against the canonical package's own documented
 * precedence, including the empty-string case, in `runtime-root.test.ts`.
 *
 * @module dsh-ipython/runtime-root
 */
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'

/** The environment variable that overrides the default DSH home. Matches `@deepseek-ai/dsh-home-paths`. */
export const DSH_HOME_ENV = 'DSH_HOME'

/** Directory name for the default DSH home under the OS home. Matches `@deepseek-ai/dsh-home-paths`. */
export const DSH_HOME_DIR_NAME = '.dsh'

/** The variable `jupyter_client` reads for the directory holding connection files. */
export const JUPYTER_RUNTIME_DIR_ENV = 'JUPYTER_RUNTIME_DIR'

/**
 * Resolve the DSH home, with the canonical package's precedence.
 *
 * Precedence, highest first: an explicit value, `$DSH_HOME`, then `~/.dsh`. An
 * empty or whitespace-only `$DSH_HOME` is treated as UNSET rather than as the
 * current directory -- the canonical resolver makes that choice deliberately
 * (`home-paths/src/index.ts:80-82`: "a blank override never resolves the home to
 * the current working directory"), and a blank override silently meaning cwd
 * would put runtime state in whatever directory the process happened to start in.
 *
 * `~` and `~/` prefixes are expanded against the OS home, as the canonical
 * resolver does (`home-paths/src/index.ts:70-74`).
 *
 * @param configured - explicit home, which wins over the environment.
 * @param env - environment mapping, injectable so a test can measure the
 *   precedence rather than the ambient machine's value.
 * @returns the normalized absolute home path.
 */
export function resolveRuntimeDshHome(
  configured?: string,
  env: Record<string, string | undefined> = process.env,
): string {
  const fromEnv = env[DSH_HOME_ENV]
  const selected = configured ?? (fromEnv !== undefined && fromEnv.trim().length > 0
    ? fromEnv
    : join(homedir(), DSH_HOME_DIR_NAME))
  return resolve(expandHome(selected))
}

/** Expand the supported tilde prefixes against the OS home, leaving anything else alone. */
function expandHome(path: string): string {
  if (path === '~') return homedir()
  if (path.startsWith('~/') || path.startsWith('~\\')) return join(homedir(), path.slice(2))
  return path
}

/**
 * `$DSH_HOME/runtime` -- the single root for every runtime tree this deployment owns.
 *
 * One level ABOVE `ipython/` on purpose: the data plane, the attachments store and
 * the Python venv all need a DSH-owned runtime location too (V5 §11.3 puts the venv
 * at `$DSH_HOME/runtime/python`), so the parent is named once here rather than each
 * component inventing its own spelling of "somewhere under DSH_HOME".
 *
 * @param configuredHome - explicit DSH home override.
 * @param env - environment mapping.
 */
export function dshRuntimeRoot(
  configuredHome?: string,
  env: Record<string, string | undefined> = process.env,
): string {
  return join(resolveRuntimeDshHome(configuredHome, env), 'runtime')
}

/**
 * The per-Session hash that names a scratch directory.
 *
 * WHY A HASH AND NOT `sanitize(sessionId)`. Sanitizing is lossy: `a/b` and `a\b`
 * both become `a_b`, so two distinct Sessions could share one scratch tree and
 * one Session's kernel could read another's connection file. A truncated SHA-256
 * does not collide in practice and is stable across processes, which is what
 * makes an orphaned directory attributable to a Session after a crash.
 *
 * 32 hex characters rather than the full 64: a Windows path component is limited
 * to 255 characters, and the full digest plus the epoch plus a filename would
 * spend a large fraction of that budget on redundancy. 128 bits is far beyond
 * what a per-machine kernel count could collide on.
 *
 * @param sessionId - the Session's own id.
 */
export function sessionScratchKey(sessionId: string): string {
  return createHash('sha256').update(sessionId, 'utf8').digest('hex').slice(0, 32)
}

/**
 * The scratch directory for one Session at one kernel epoch (V5 §11.4's layout).
 *
 * @param options.sessionId - the Session's own id.
 * @param options.kernelEpoch - the kernel generation; a restart allocates a new one.
 * @param options.dshHome - explicit DSH home override.
 * @param options.env - environment mapping.
 * @returns `<DSH_HOME>/runtime/ipython/<session-hash>/<epoch>`.
 */
export function kernelScratchDir(options: {
  readonly sessionId: string
  readonly kernelEpoch: number
  readonly dshHome?: string
  readonly env?: Record<string, string | undefined>
}): string {
  const epoch = Number.isFinite(options.kernelEpoch) && options.kernelEpoch >= 0
    ? Math.trunc(options.kernelEpoch)
    : 0
  return join(
    dshRuntimeRoot(options.dshHome, options.env ?? process.env),
    'ipython',
    sessionScratchKey(options.sessionId),
    String(epoch),
  )
}

/**
 * The root under which every Session's scratch lives: `$DSH_HOME/runtime/ipython`.
 *
 * This is the value `KernelService` uses when the profile sets no `root`, and it
 * is the ONE thing a host that wants scratch elsewhere overrides. It is not
 * per-Session or per-epoch because a single configured root has to serve every
 * kernel the service owns.
 */
export function defaultKernelRoot(
  configuredHome?: string,
  env: Record<string, string | undefined> = process.env,
): string {
  return join(dshRuntimeRoot(configuredHome, env), 'ipython')
}

/**
 * The directory `jupyter_client` must write connection files into.
 *
 * WHY THIS IS PINNED RATHER THAN LEFT TO `jupyter_core`. The connection file
 * carries the kernel's HMAC key and, on TCP, its curve keys. MEASURED: with no
 * `JUPYTER_RUNTIME_DIR`, `jupyter_runtime_dir()` resolved to
 * `%APPDATA%\jupyter\runtime` on this machine -- outside `$DSH_HOME` entirely,
 * and shared with every other Jupyter user on the account. Pinning it keeps the
 * capability-bearing file inside the tree this deployment owns, alongside the
 * rest of the kernel's runtime state, so "delete the runtime tree" is a complete
 * statement about the kernel's on-disk footprint.
 *
 * It lives UNDER the Session+epoch scratch directory rather than in a shared
 * `runtime/jupyter`: two kernels writing one shared runtime dir is what makes a
 * connection file unattributable to a kernel, and `jupyter_client` names files
 * by kernel id rather than by our Session.
 */
export function jupyterRuntimeDir(scratchDir: string): string {
  return join(scratchDir, 'jupyter')
}

/**
 * The Python environment layout V5 §11.3 asks for: a DSH-owned venv.
 *
 * `$DSH_HOME/runtime/python` -- not under `ipython/`, because the venv is the
 * INTERPRETER and the scratch tree is one of the things the interpreter's
 * kernels produce. Keeping them siblings means deleting scratch cannot delete
 * the environment, which would turn a cleanup into a reinstall.
 */
export function managedVenvRoot(
  configuredHome?: string,
  env: Record<string, string | undefined> = process.env,
): string {
  return join(dshRuntimeRoot(configuredHome, env), 'python')
}

/**
 * The interpreter inside the managed venv, by platform.
 *
 * Windows puts it in `Scripts/python.exe`; POSIX in `bin/python`. Derived from
 * `process.platform` rather than probed, because a caller needs the path to
 * EXIST-CHECK it, and a probe that searched both layouts would report success on
 * a half-built venv.
 */
export function managedVenvPython(
  configuredHome?: string,
  env: Record<string, string | undefined> = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  const root = managedVenvRoot(configuredHome, env)
  return platform === 'win32' ? join(root, 'Scripts', 'python.exe') : join(root, 'bin', 'python')
}

/**
 * Whether a configured path is usable as the interpreter, or is absent.
 *
 * A blank string is treated as ABSENT rather than as a path, because that is how
 * an unset environment variable arrives and because `''` would otherwise be
 * passed to `spawn` and fail with an opaque `ENOENT` at the first cell instead
 * of at configuration time.
 */
export function isConfiguredInterpreter(value: string | undefined): value is string {
  return value !== undefined && value.trim().length > 0
}

/**
 * Reject a path that names a specific user's home, which is the defect V5 §11.3
 * names: a fallback of the form `C:/Users/<someone>/...` makes a fresh clone
 * unbootable on every other machine while looking like a working default.
 *
 * WHY A DETECTOR AND NOT ONLY A DELETION. Deleting the personal fallback fixes
 * today's instance; the shape returns the next time someone makes a fresh clone
 * work by pasting their own path. The detector is what a gate can run, and it
 * reports the offending component rather than a boolean, so the message can name
 * what to change.
 *
 * The rule is deliberately narrow: a path is personal if some component is
 * literally `Users` (Windows) or `home` (POSIX) followed by a non-empty
 * component. A checkout legitimately living under a user's home -- every
 * developer's does -- must NOT be flagged, so only the interpreter's own path is
 * checked, and only at the point where it is about to become a DEFAULT.
 *
 * @param path - the candidate interpreter path.
 * @returns the personal component found, or `undefined` when none is.
 */
export function personalPathComponent(path: string): string | undefined {
  const parts = path.split(/[\\/]+/).filter(part => part.length > 0)
  for (let index = 0; index < parts.length - 1; index += 1) {
    const part = parts[index]
    if (part === undefined) continue
    const lowered = part.toLowerCase()
    if (lowered !== 'users' && lowered !== 'home') continue
    const owner = parts[index + 1]
    // `C:/Users/Public` and `/home/` with nothing after it are not personal.
    if (owner === undefined || owner.length === 0 || owner.toLowerCase() === 'public') continue
    return `${part}/${owner}`
  }
  return undefined
}

/**
 * The refusal a missing interpreter produces, with the exact action that fixes it.
 *
 * WHY THIS IS A SEPARATE EXPORT AND NOT AN INLINE STRING. V5 §11.3's second arm
 * requires a failure that is LOUD and names ONE documented action. A message
 * assembled at the throw site drifts from the message the doctor prints, and the
 * two are the same instruction -- so they share one string, and the test asserts
 * the doctor's output contains it rather than asserting each spelling separately.
 *
 * It names the venv path and the command that creates it, in that order, because
 * "set DSH_PYTHON" alone sends the operator to find an interpreter by hand, which
 * is the manual step this arm exists to make unnecessary.
 *
 * @param options.dshHome - the resolved DSH home, for the venv path.
 * @param options.personal - the personal component found in a rejected default, if any.
 */
export function pythonConfigurationInstruction(options: {
  readonly dshHome: string
  readonly personal?: string
}): string {
  const venv = join(options.dshHome, 'runtime', 'python')
  const personalNote = options.personal === undefined
    ? ''
    : `\nThe configured default names one user's home (${options.personal}), which cannot work on any other machine.`
  return [
    'dsh-ipython: no Python interpreter is configured, so no kernel can start.',
    personalNote,
    '',
    'ONE of these two actions fixes it:',
    '',
    `  1. Bootstrap the DSH-owned environment (preferred):`,
    `       dsh-ipython doctor --bootstrap`,
    `     This creates ${venv} from a compatible system CPython and installs the`,
    '     pinned jupyter requirements from the checked-in lock file.',
    '',
    '  2. Name an interpreter that already has IPython + ipykernel + jupyter_client + pyzmq:',
    `       set ${DSH_HOME_ENV}=<your dsh home>`,
    '       set DSH_PYTHON=<absolute path to python.exe>',
    '',
    'There is deliberately NO default interpreter path. A default naming one',
    "machine's Python is what made a fresh clone fail to start a kernel.",
  ].filter(line => line !== undefined).join('\n')
}

/**
 * Whether an absolute path is required for the interpreter.
 *
 * A RELATIVE interpreter path is resolved by `spawn` against the PROCESS CWD,
 * which for the DSH launcher is whatever directory the operator happened to be
 * standing in -- so the same profile would start a kernel from one interpreter in
 * one shell and a different one in another. Refusing a relative path is the same
 * rule the `sandbox-policy` service applies to `workspaceRoot`, and for the same
 * reason.
 */
export function interpreterPathProblem(path: string): string | undefined {
  if (path.trim().length === 0) return 'the interpreter path is blank'
  if (!isAbsolute(path)) {
    return `the interpreter path "${path}" is not absolute; a relative path resolves against the launcher's cwd, `
      + 'so the same profile would start a different interpreter from a different directory'
  }
  return undefined
}
