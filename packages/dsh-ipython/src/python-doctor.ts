/**
 * THE PYTHON DOCTOR: discover a compatible CPython, build the DSH-owned venv,
 * probe it, and refuse to report healthy when it is not (V5 §11.3).
 *
 * THE DEFECT THIS CLOSES (V5 §11.3 / finding N). The profile's interpreter was
 *
 *     pythonExecutable: !!js process.env.DSH_PYTHON ?? 'C:/Users/hzq00/.../python.exe'
 *
 * The `DSH_PYTHON` override was progress over an unoverrideable path, and a fresh
 * clone on another machine STILL cannot start a kernel by default, because the
 * fallback names one user's interpreter. A default is not made portable by being
 * overridable -- it is made portable by not naming a machine.
 *
 * WHAT THIS MODULE DOES, in the order V5 lists it:
 *   1. discover a compatible system CPython (no network);
 *   2. create the venv at `$DSH_HOME/runtime/python` (no network -- MEASURED
 *      5.8 s, `ensurepip 25.3` present in the system interpreter);
 *   3. install the pinned requirements from `requirements.lock.txt` (NETWORK);
 *   4. probe the environment and report what is actually there.
 *
 * STEP 3 IS `BLOCKED_EXTERNAL` IN THIS DEPLOYMENT. No budget is authorized for a
 * network install, so this module never runs one on its own initiative. It
 * reports the exact command an operator must run, and the probe in step 4 then
 * reports the environment as NOT READY until that command has been run and the
 * imports actually resolve. The alternative -- creating the venv and calling it
 * provisioned -- would be a new way to look healthy while broken, which is the
 * defect class this project has recorded more than twelve times.
 *
 * WHY THIS IS NOT A SECOND PROBE (coordination with P11). P11 owns the
 * environment MANIFEST: the canonical digest bound into kernel identity. This
 * module owns the LAYOUT and the BOOTSTRAP. So it deliberately does NOT compute a
 * digest and does NOT claim to be the manifest; it reports the raw facts a
 * manifest needs (`interpreterPath`, `pythonVersion`, per-package versions) as
 * `PythonEnvironmentFacts`, and P11's manifest builder is free to consume exactly
 * that shape. One probe, one digest, one place that decides identity -- this
 * module only feeds it.
 *
 * WHAT IT DOES NOT DO. It does not boot DSH, does not start a kernel, and does not
 * touch the network. It is safe to run on a machine with no DSH_HOME yet.
 *
 * @module dsh-ipython/python-doctor
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  interpreterPathProblem,
  isConfiguredInterpreter,
  managedVenvPython,
  managedVenvRoot,
  personalPathComponent,
  pythonConfigurationInstruction,
  resolveRuntimeDshHome,
  DSH_HOME_ENV,
} from './runtime-root.ts'

/** The packages the broker imports directly, plus the transitives whose versions reach a cell. */
export const REQUIRED_PYTHON_PACKAGES = [
  'IPython',
  'ipykernel',
  'jupyter_client',
  'pyzmq',
  'jupyter_core',
  'traitlets',
  'tornado',
] as const

/** The minimum CPython the broker supports. See the docstring on `discoverSystemPython`. */
export const MINIMUM_PYTHON = [3, 10] as const

/** Where the pinned requirements live, relative to this package. */
const HERE = fileURLToPath(new URL('.', import.meta.url))
const PACKAGE_ROOT = resolve(HERE, '..')

/** The checked-in lock file. Shipped in `files` so an installed package carries it. */
export function requirementsLockPath(): string {
  // `lib/` at runtime, `src/` in a source checkout -- both are one level under the
  // package root, and the file is at the root, so this needs no build-time
  // substitution (the same reasoning as `DEFAULT_BROKER_SCRIPT`).
  return join(PACKAGE_ROOT, 'requirements.lock.txt')
}

/**
 * The pinned requirement lines, so a caller can report WHAT will be installed
 * rather than only naming the file.
 *
 * A missing lock file is reported as an empty list rather than thrown, and the
 * doctor turns that into a blocker: `package.json`'s `files` array must carry the
 * lock for an installed package to have it, and a bootstrap that silently
 * installed nothing would leave a venv that probes as broken with no explanation
 * of why. Reading is bounded and comments/blank lines are dropped, so the
 * returned list is exactly the `pip install` argument set.
 */
export function readRequirementsLock(): readonly string[] {
  const path = requirementsLockPath()
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8')
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line.length > 0 && !line.startsWith('#'))
}

/** One package's measured version, or a MISSING marker. */
export interface PythonPackageFact {
  readonly name: string
  /** The installed version, or `undefined` when the import failed. */
  readonly version?: string
  /** The error class name when the import failed, so a missing wheel is distinguishable from a broken one. */
  readonly error?: string
}

/**
 * The raw environment facts a manifest needs.
 *
 * DELIBERATELY NOT A DIGEST. P11 owns the canonical environment digest; this
 * shape is what that builder consumes. Reporting a digest here as well would
 * create a second identity for the same environment, and two identities that can
 * disagree is the defect `KernelService.entryFor` exists to refuse.
 */
export interface PythonEnvironmentFacts {
  /** The interpreter that was probed, verbatim. */
  readonly interpreterPath: string
  /** `sys.version_info` as `[major, minor, micro]`, when the interpreter answered. */
  readonly pythonVersion?: readonly number[]
  /** `sys.executable`, which differs from `interpreterPath` through a venv shim. */
  readonly sysExecutable?: string
  /** `sys.prefix`, which is the venv root when a venv is active. */
  readonly prefix?: string
  /** Whether `prefix` is the managed venv root, i.e. whether this is the DSH-owned environment. */
  readonly managedVenv: boolean
  /** One entry per required package, in `REQUIRED_PYTHON_PACKAGES` order. */
  readonly packages: readonly PythonPackageFact[]
  /** The packages that did not import. Empty is the healthy value. */
  readonly missing: readonly string[]
  /** Set when the interpreter could not be executed at all. */
  readonly interpreterError?: string
}

/** The result of a bootstrap attempt, so a caller can act on it rather than parse prose. */
export interface BootstrapResult {
  readonly action: 'none' | 'created' | 'reused' | 'refused'
  readonly venvRoot: string
  readonly venvPython: string
  readonly facts?: PythonEnvironmentFacts
  /** The exact command that installs the pins. Always reported, because it is the operator's next step. */
  readonly installCommand: string
  readonly blockers: readonly string[]
  readonly notes: readonly string[]
}

/**
 * The interpreter-discovery probe program.
 *
 * WHY IT IS A PROGRAM AND NOT A SEQUENCE OF `-c` CALLS. Discovery has to answer
 * several questions per candidate (version, executable, whether the four imports
 * resolve), and a process per question would multiply a 3-candidate search into
 * a dozen spawns. One JSON-emitting program per candidate keeps the cost at one
 * process and makes the answer atomic -- a candidate that dies halfway produces
 * one unparseable line rather than a partially-filled record that reads as a
 * measurement.
 *
 * It prints ONE json object. Anything else on stdout is a failure of the probe,
 * and the caller treats unparseable output as "candidate refused" rather than
 * guessing.
 */
const PROBE_PROGRAM = `
import json, sys
fact = {"pythonVersion": list(sys.version_info[:3]), "sysExecutable": sys.executable, "prefix": sys.prefix}
packages = []
for name in ${JSON.stringify(REQUIRED_PYTHON_PACKAGES)}:
    entry = {"name": name}
    try:
        module = __import__(name)
        entry["version"] = getattr(module, "__version__", None) or "unknown"
    except BaseException as exc:
        entry["error"] = type(exc).__name__
    packages.append(entry)
fact["packages"] = packages
print(json.dumps(fact))
`

/**
 * Run the probe program under one interpreter and parse its facts.
 *
 * `execFileSync` is used rather than `ctx.subprocess` deliberately: this is a
 * HOST DIAGNOSTIC that runs BEFORE any DSH context exists (the doctor is what an
 * operator runs when the deployment will not start), so there is no subprocess
 * service to route through. It is synchronous and bounded by `timeout`, so a
 * hung interpreter cannot hang a doctor indefinitely.
 *
 * @param interpreter - absolute path to the interpreter to probe.
 * @param options.timeoutMs - bound on the probe.
 */
export function probeInterpreter(interpreter: string, options: { timeoutMs?: number } = {}): PythonEnvironmentFacts {
  const managedRoot = managedVenvRoot()
  const base = {
    interpreterPath: interpreter,
    managedVenv: false,
    packages: [],
    missing: [] as string[],
  }
  let raw: string
  try {
    raw = execFileSync(interpreter, ['-c', PROBE_PROGRAM], {
      encoding: 'utf8',
      timeout: options.timeoutMs ?? 30_000,
      windowsHide: true,
    })
  } catch (error) {
    return { ...base, interpreterError: describeExecError(error) }
  }
  const parsed = parseProbeOutput(raw)
  if (parsed === undefined) {
    return { ...base, interpreterError: 'the probe produced no parseable JSON object' }
  }
  const packages = parsed.packages ?? []
  const missing = packages.filter(entry => entry.error !== undefined).map(entry => entry.name)
  const prefix = typeof parsed.prefix === 'string' ? parsed.prefix : undefined
  return {
    interpreterPath: interpreter,
    pythonVersion: Array.isArray(parsed.pythonVersion) ? parsed.pythonVersion : undefined,
    sysExecutable: typeof parsed.sysExecutable === 'string' ? parsed.sysExecutable : undefined,
    prefix,
    // Compared through `resolve` on both sides so a trailing separator or a
    // case-differing drive letter does not read as "not the managed venv".
    managedVenv: prefix !== undefined && samePath(prefix, managedRoot),
    packages,
    missing,
  }
}

/** Windows path comparison is case-insensitive; a case-differing drive letter must not read as a different tree. */
function samePath(left: string, right: string): boolean {
  const a = resolve(left).replace(/[\\/]+$/, '')
  const b = resolve(right).replace(/[\\/]+$/, '')
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
}

/** Turn a spawn failure into a sentence, keeping the errno that identifies it. */
function describeExecError(error: unknown): string {
  const candidate = error as { code?: string, status?: number, stderr?: unknown, message?: string }
  const code = candidate.code ?? (candidate.status === undefined ? undefined : `exit ${candidate.status}`)
  const stderr = typeof candidate.stderr === 'string' ? candidate.stderr.trim().split('\n').slice(-1)[0] : undefined
  return [code, stderr].filter(part => part !== undefined && part !== '').join(': ')
    || (candidate.message ?? 'the interpreter could not be executed')
}

/** The subset of the probe's JSON this module reads. */
interface ProbeOutput {
  readonly pythonVersion?: unknown
  readonly sysExecutable?: unknown
  readonly prefix?: unknown
  readonly packages?: readonly PythonPackageFact[]
}

/** Parse the probe's stdout, taking the LAST parseable line so a warning on stdout cannot void a good answer. */
function parseProbeOutput(raw: string): ProbeOutput | undefined {
  const lines = raw.split(/\r?\n/).map(line => line.trim()).filter(line => line.length > 0)
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]
    if (line === undefined || !line.startsWith('{')) continue
    try {
      const parsed = JSON.parse(line) as ProbeOutput
      if (typeof parsed === 'object' && parsed !== null) return parsed
    } catch {
      continue
    }
  }
  return undefined
}

/**
 * Whether an interpreter satisfies the minimum version.
 *
 * A version the probe could not establish is NOT accepted. "Unknown" must not be
 * treated as "new enough", because that is how a Python 3.6 install becomes a
 * kernel that fails at import time with a syntax error in `broker.py`.
 */
export function satisfiesMinimum(facts: PythonEnvironmentFacts): boolean {
  const version = facts.pythonVersion
  if (version === undefined || version.length < 2) return false
  const [major, minor] = version
  if (major === undefined || minor === undefined) return false
  if (major !== MINIMUM_PYTHON[0]) return major > MINIMUM_PYTHON[0]
  return minor >= MINIMUM_PYTHON[1]
}

/** A discovery candidate and why it was or was not accepted. */
export interface PythonCandidate {
  readonly path: string
  readonly source: string
  readonly facts?: PythonEnvironmentFacts
  readonly accepted: boolean
  readonly reason: string
}

/**
 * Discover a compatible system CPython.
 *
 * WHY THIS DOES NOT WALK THE FILESYSTEM. Searching for `python.exe` on disk is
 * unbounded, slow, and finds virtualenv shims whose base interpreter is not what
 * their path suggests. The candidates are instead the places a Windows/POSIX
 * install actually registers itself, each tried and PROBED rather than trusted:
 *
 *   1. the Windows `py` launcher, which is the OS's own registry of installed
 *      Pythons and is the one mechanism that finds a per-user install without
 *      guessing a path;
 *   2. `python3` / `python` on `PATH`;
 *   3. the well-known per-user install root, ENUMERATED rather than hardcoded to
 *      one version -- this is the arm that replaces the deleted personal default
 *      without reintroducing it: the same directory is probed, but the version
 *      directory is discovered rather than pinned to `Python314`, and the result
 *      is validated by a probe rather than assumed to exist.
 *
 * A candidate that fails the probe is reported with its reason and does not stop
 * the search, so an operator sees every path that was tried. A `DSH_PYTHON` that
 * is set is probed FIRST and, when it works, is the only candidate considered.
 */
export function discoverSystemPython(options: {
  readonly env?: Record<string, string | undefined>
  readonly platform?: NodeJS.Platform
  readonly timeoutMs?: number
} = {}): readonly PythonCandidate[] {
  const env = options.env ?? process.env
  const platform = options.platform ?? process.platform
  const candidates: PythonCandidate[] = []
  const tried = new Set<string>()

  const consider = (path: string | undefined, source: string): void => {
    if (!isConfiguredInterpreter(path)) return
    const key = process.platform === 'win32' ? path.toLowerCase() : path
    if (tried.has(key)) return
    tried.add(key)
    const problem = interpreterPathProblem(path)
    if (problem !== undefined) {
      candidates.push({ path, source, accepted: false, reason: problem })
      return
    }
    const facts = probeInterpreter(path, options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs })
    if (facts.interpreterError !== undefined) {
      candidates.push({ path, source, facts, accepted: false, reason: `not executable: ${facts.interpreterError}` })
      return
    }
    if (!satisfiesMinimum(facts)) {
      candidates.push({
        path,
        source,
        facts,
        accepted: false,
        reason: `Python ${facts.pythonVersion?.join('.') ?? 'unknown'} is below the required `
          + `${MINIMUM_PYTHON.join('.')}`,
      })
      return
    }
    candidates.push({
      path,
      source,
      facts,
      accepted: true,
      reason: `Python ${facts.pythonVersion?.join('.') ?? 'unknown'} with `
        + `${facts.missing.length === 0 ? 'every required package' : `missing ${facts.missing.join(', ')}`}`,
    })
  }

  // 1. The configured override, first and always reported even when it fails.
  consider(env['DSH_PYTHON'], 'DSH_PYTHON')
  if (candidates.some(candidate => candidate.accepted)) return candidates

  // 2. The Windows launcher, which is the OS's own registry of installed Pythons.
  if (platform === 'win32') {
    for (const versionFlag of ['-3', '-3.14', '-3.13', '-3.12', '-3.11', '-3.10']) {
      const resolved = tryResolveViaLauncher(versionFlag, options.timeoutMs)
      if (resolved !== undefined) consider(resolved, `py ${versionFlag}`)
    }
  }

  // 3. PATH.
  for (const name of ['python3', 'python']) {
    consider(whichOnPath(name, env), `PATH:${name}`)
  }

  // 4. The well-known install roots, ENUMERATED. See the docstring.
  for (const root of wellKnownInstallRoots(env, platform)) {
    consider(join(root, platform === 'win32' ? 'python.exe' : 'bin/python'), root)
  }

  return candidates
}

/**
 * Ask the Windows `py` launcher to resolve a version to an absolute path.
 *
 * Returns `undefined` rather than throwing: the launcher is absent on most POSIX
 * hosts and on many Windows installs, and "no launcher" is a normal search
 * outcome, not a diagnostic.
 */
function tryResolveViaLauncher(versionFlag: string, timeoutMs?: number): string | undefined {
  try {
    const output = execFileSync('py', [versionFlag, '-c', 'import sys; print(sys.executable)'], {
      encoding: 'utf8',
      timeout: timeoutMs ?? 15_000,
      windowsHide: true,
    }).trim()
    const last = output.split(/\r?\n/).map(line => line.trim()).filter(line => line.length > 0).slice(-1)[0]
    return last === undefined || last.length === 0 ? undefined : last
  } catch {
    return undefined
  }
}

/**
 * Resolve one bare name against `PATH` without a shell.
 *
 * `which`/`where` are not used: they are separate programs whose absence or
 * different output shape would become a second failure mode, and this needs only
 * a file existence check per `PATH` entry.
 */
function whichOnPath(name: string, env: Record<string, string | undefined>): string | undefined {
  const raw = env['PATH'] ?? env['Path'] ?? ''
  const separator = process.platform === 'win32' ? ';' : ':'
  const extensions = process.platform === 'win32'
    ? (env['PATHEXT'] ?? '.EXE;.CMD;.BAT').split(';').map(extension => extension.toLowerCase())
    : ['']
  for (const directory of raw.split(separator)) {
    if (directory.trim().length === 0) continue
    for (const extension of extensions) {
      const candidate = join(directory, name + extension)
      if (existsSync(candidate)) return candidate
    }
  }
  return undefined
}

/**
 * The well-known per-user and machine install roots, with their version
 * directories ENUMERATED.
 *
 * THE POINT OF ENUMERATING. The deleted default was
 * `<user>/AppData/Local/Programs/Python/Python314/python.exe`. The version
 * component is what made it a statement about one machine. Here the SAME parent
 * is searched, but every `Python*` directory under it is a candidate and each one
 * is probed -- so this host finds its own 3.14 without the repository naming 3.14,
 * and a host with only 3.12 finds that instead.
 *
 * The OS home is read from `env` when present so a test can point the search at a
 * fixture tree rather than at the machine it runs on.
 */
function wellKnownInstallRoots(
  env: Record<string, string | undefined>,
  platform: NodeJS.Platform,
): readonly string[] {
  const roots: string[] = []
  const addVersionDirectories = (parent: string): void => {
    if (!existsSync(parent)) return
    let entries: string[]
    try {
      entries = readdirSync(parent)
    } catch {
      return
    }
    for (const entry of entries) {
      if (!/^Python\d/i.test(entry) && !/^python\d/i.test(entry)) continue
      roots.push(join(parent, entry))
    }
  }

  if (platform === 'win32') {
    const localAppData = env['LOCALAPPDATA']
    if (isConfiguredInterpreter(localAppData)) addVersionDirectories(join(localAppData, 'Programs', 'Python'))
    const programFiles = env['ProgramFiles']
    if (isConfiguredInterpreter(programFiles)) addVersionDirectories(programFiles)
    // The all-users install location, which is NOT under a user's home at all.
    roots.push('C:\\Python314', 'C:\\Python313', 'C:\\Python312')
  } else {
    for (const parent of ['/usr/local/bin', '/usr/bin', '/opt/homebrew/bin']) {
      roots.push(parent.replace(/\/bin$/, ''))
    }
    roots.push('/usr/local', '/usr')
  }
  return roots
}

/**
 * Create the DSH-owned venv from a discovered system interpreter.
 *
 * NO NETWORK. `python -m venv <dir>` uses the interpreter's own bundled
 * `ensurepip` to lay down `pip`; MEASURED on the qualification machine: exit 0 in
 * 5.8 s with `ensurepip 25.3` present. The pinned INSTALL is a separate step and
 * is not attempted here.
 *
 * REFUSES RATHER THAN OVERWRITES when a venv already exists and does not probe
 * clean. Rebuilding over a half-populated venv would discard whatever an operator
 * had already installed there, and the honest report is that the directory exists
 * and is not usable.
 *
 * @param options.interpreter - the system interpreter to build from.
 * @param options.dshHome - explicit DSH home override.
 * @param options.env - environment mapping.
 * @param options.force - rebuild even when a venv is present.
 * @param options.timeoutMs - bound on the `venv` subprocess.
 */
export function bootstrapManagedVenv(options: {
  readonly interpreter: string
  readonly dshHome?: string
  readonly env?: Record<string, string | undefined>
  readonly force?: boolean
  readonly timeoutMs?: number
}): BootstrapResult {
  const env = options.env ?? process.env
  const home = resolveRuntimeDshHome(options.dshHome, env)
  const venvRoot = managedVenvRoot(options.dshHome, env)
  const venvPython = managedVenvPython(options.dshHome, env)
  const installCommand = `"${venvPython}" -m pip install -r "${requirementsLockPath()}"`
  const blockers: string[] = []
  const notes: string[] = []

  // A lock file that is not present is checked FIRST: it is the input the whole
  // bootstrap exists to apply, and an installed package that dropped it from
  // `files` would otherwise produce a venv, an install command pointing at a
  // missing path, and no statement of the real problem.
  const pins = readRequirementsLock()
  if (pins.length === 0) {
    blockers.push(
      `the pinned requirements file is missing or empty at ${requirementsLockPath()}; `
      + 'the managed environment cannot be reproduced without it',
    )
    return { action: 'refused', venvRoot, venvPython, installCommand, blockers, notes }
  }
  notes.push(`pinned requirements: ${pins.join(' ')}`)

  if (!existsSync(venvPython) || options.force === true) {
    const problem = interpreterPathProblem(options.interpreter)
    if (problem !== undefined) {
      blockers.push(`the base interpreter cannot be used: ${problem}`)
      return { action: 'refused', venvRoot, venvPython, installCommand, blockers, notes }
    }
    const base = probeInterpreter(options.interpreter, options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs })
    if (base.interpreterError !== undefined) {
      blockers.push(`the base interpreter could not be executed: ${base.interpreterError}`)
      return { action: 'refused', venvRoot, venvPython, installCommand, blockers, notes }
    }
    if (!satisfiesMinimum(base)) {
      blockers.push(`the base interpreter is Python ${base.pythonVersion?.join('.') ?? 'unknown'}, below the required `
        + `${MINIMUM_PYTHON.join('.')}`)
      return { action: 'refused', venvRoot, venvPython, installCommand, blockers, notes }
    }
    if (options.force === true && existsSync(venvRoot)) {
      notes.push(`removed the existing venv at ${venvRoot} because force was requested`)
      rmSync(venvRoot, { recursive: true, force: true })
    }
    mkdirSync(venvRoot, { recursive: true })
    try {
      execFileSync(options.interpreter, ['-m', 'venv', venvRoot], {
        encoding: 'utf8',
        timeout: options.timeoutMs ?? 180_000,
        windowsHide: true,
        stdio: 'pipe',
      })
    } catch (error) {
      blockers.push(`creating the venv failed: ${describeExecError(error)}`)
      return { action: 'refused', venvRoot, venvPython, installCommand, blockers, notes }
    }
    if (!existsSync(venvPython)) {
      // `venv` exited 0 and produced no interpreter. Reported rather than
      // assumed, because the next step would otherwise fail with ENOENT and read
      // as a missing file rather than as a failed bootstrap.
      blockers.push(`\`python -m venv\` exited 0 but produced no interpreter at ${venvPython}`)
      return { action: 'refused', venvRoot, venvPython, installCommand, blockers, notes }
    }
    notes.push(`created the venv at ${venvRoot} from ${options.interpreter} (no network was used)`)
  } else {
    notes.push(`reused the existing venv at ${venvRoot}`)
  }

  const facts = probeInterpreter(venvPython, options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs })
  if (facts.missing.length > 0) {
    // THE LOUD, ACTIONABLE FAILURE. V5 §11.3 requires that a deployment which
    // cannot bootstrap says so with ONE documented action; a venv that exists but
    // cannot import ipykernel is exactly that state, and calling it provisioned
    // would be the "looks healthy while broken" defect.
    blockers.push(
      `the managed venv is missing ${facts.missing.join(', ')}; the pinned install has not been run. `
      + 'It needs network access, which this deployment has no authorized budget for.',
    )
    notes.push(`run exactly this, once, with network access: ${installCommand}`)
    return {
      action: existsSync(venvPython) ? 'created' : 'refused',
      venvRoot,
      venvPython,
      facts,
      installCommand,
      blockers,
      notes,
    }
  }

  // A venv that probes clean is the only state that reports no blocker.
  return { action: 'created', venvRoot, venvPython, facts, installCommand, blockers, notes }
}

/** The interpreter the service should use, or the refusal that says why it cannot. */
export interface InterpreterResolution {
  /** The resolved absolute interpreter, when there is one. */
  readonly interpreter?: string
  /** How it was chosen, so a reader can tell a managed venv from an override. */
  readonly source: 'config' | 'DSH_PYTHON' | 'managed-venv'
  /** The message to print when `interpreter` is absent. */
  readonly refusal?: string
  /** The probe of the chosen interpreter, when one was chosen. */
  readonly facts?: PythonEnvironmentFacts
  /** Non-fatal observations worth printing. */
  readonly notes: readonly string[]
}

/**
 * Resolve the interpreter for a kernel, with NO personal-path fallback.
 *
 * THE ORDER, and each position is a decision:
 *   1. an explicitly configured `pythonExecutable` from the profile -- the
 *      operator's own choice always wins;
 *   2. `DSH_PYTHON` -- the environment override, which is what a host sets to
 *      point at an interpreter outside the managed venv;
 *   3. the managed venv, if it EXISTS and PROBES CLEAN.
 *
 * A path that is configured but unusable is NOT silently replaced by the next
 * candidate. Substituting a different interpreter than the one named is how a
 * deployment measures the wrong Python while reporting success, and it is the
 * same rule `KernelService.entryFor` applies to the execution world: refuse,
 * rather than serve under a different identity than the one requested.
 *
 * @param options.configured - the profile's `pythonExecutable`, if any.
 * @param options.dshHome - explicit DSH home override.
 * @param options.env - environment mapping.
 */
export function resolveKernelInterpreter(options: {
  readonly configured?: string
  readonly dshHome?: string
  readonly env?: Record<string, string | undefined>
  readonly timeoutMs?: number
} = {}): InterpreterResolution {
  const env = options.env ?? process.env
  const home = resolveRuntimeDshHome(options.dshHome, env)
  const notes: string[] = []
  const probeOptions = options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }

  const configured = isConfiguredInterpreter(options.configured) ? options.configured : undefined
  if (configured !== undefined) {
    const personal = personalPathComponent(configured)
    if (personal !== undefined) {
      // A configured default that names a user's home is REFUSED rather than
      // used-with-a-warning. Warning would leave a fresh clone broken by default,
      // which is the defect; this makes the misconfiguration fail at the point it
      // is introduced.
      return {
        source: 'config',
        refusal: pythonConfigurationInstruction({ dshHome: home, personal }),
        notes,
      }
    }
    const problem = interpreterPathProblem(configured)
    if (problem !== undefined) {
      return { source: 'config', refusal: pythonConfigurationInstruction({ dshHome: home }), notes: [problem] }
    }
    const facts = probeInterpreter(configured, probeOptions)
    if (facts.interpreterError !== undefined) {
      return {
        source: 'config',
        refusal: `${pythonConfigurationInstruction({ dshHome: home })}\n\nThe configured interpreter could not be used: ${facts.interpreterError}`,
        notes,
      }
    }
    if (facts.missing.length > 0) {
      return {
        source: 'config',
        refusal: `${pythonConfigurationInstruction({ dshHome: home })}\n\nThe configured interpreter is missing `
          + `${facts.missing.join(', ')}.`,
        facts,
        notes,
      }
    }
    return { interpreter: configured, source: 'config', facts, notes }
  }

  const fromEnv = env['DSH_PYTHON']
  if (isConfiguredInterpreter(fromEnv)) {
    const problem = interpreterPathProblem(fromEnv)
    if (problem === undefined) {
      const facts = probeInterpreter(fromEnv, probeOptions)
      if (facts.interpreterError === undefined && facts.missing.length === 0) {
        return { interpreter: fromEnv, source: 'DSH_PYTHON', facts, notes }
      }
      notes.push(`DSH_PYTHON was set but is not usable (${facts.interpreterError ?? `missing ${facts.missing.join(', ')}`})`)
    } else {
      notes.push(`DSH_PYTHON was set but is not usable (${problem})`)
    }
  }

  const venvPython = managedVenvPython(options.dshHome, env)
  if (existsSync(venvPython)) {
    const facts = probeInterpreter(venvPython, probeOptions)
    if (facts.interpreterError === undefined && facts.missing.length === 0) {
      return { interpreter: venvPython, source: 'managed-venv', facts, notes }
    }
    notes.push(`the managed venv at ${venvPython} exists but is not usable `
      + `(${facts.interpreterError ?? `missing ${facts.missing.join(', ')}`})`)
  }

  return { source: 'managed-venv', refusal: pythonConfigurationInstruction({ dshHome: home }), notes }
}

/** The one-line-per-fact human report the doctor prints. */
export function renderDoctorReport(resolution: InterpreterResolution, options: { dshHome?: string } = {}): string {
  const home = resolveRuntimeDshHome(options.dshHome)
  const lines: string[] = []
  lines.push(`DSH home            : ${home}`)
  lines.push(`managed venv root   : ${managedVenvRoot(options.dshHome)}`)
  lines.push(`managed interpreter : ${managedVenvPython(options.dshHome)}`)
  lines.push(`requirements lock   : ${requirementsLockPath()}`)
  lines.push(`${DSH_HOME_ENV} override        : ${isConfiguredInterpreter(process.env[DSH_HOME_ENV]) ? 'set' : 'unset'}`)
  lines.push(`DSH_PYTHON override : ${isConfiguredInterpreter(process.env['DSH_PYTHON']) ? 'set' : 'unset'}`)
  if (resolution.interpreter === undefined) {
    lines.push('')
    lines.push('STATUS: NOT READY -- no usable interpreter')
    lines.push(resolution.refusal ?? pythonConfigurationInstruction({ dshHome: home }))
  } else {
    lines.push('')
    lines.push(`interpreter (${resolution.source}): ${resolution.interpreter}`)
    lines.push(`python version      : ${resolution.facts?.pythonVersion?.join('.') ?? 'unknown'}`)
    lines.push(`sys.prefix          : ${resolution.facts?.prefix ?? 'unknown'}`)
    lines.push(`managed venv active : ${resolution.facts?.managedVenv === true ? 'yes' : 'no'}`)
    lines.push('packages:')
    for (const fact of resolution.facts?.packages ?? []) {
      lines.push(`  ${fact.name.padEnd(16)} ${fact.version ?? `MISSING (${fact.error ?? 'unknown error'})`}`)
    }
    lines.push('')
    lines.push('STATUS: READY')
  }
  for (const note of resolution.notes) lines.push(`note: ${note}`)
  return lines.join('\n')
}
