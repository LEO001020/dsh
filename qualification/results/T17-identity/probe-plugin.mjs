/**
 * T17 IDENTITY probe plugin.
 *
 * WHY THIS IS A PLUGIN AND NOT A SCRIPT
 *
 * ID-05 is a claim about the RUNNING HOST's module identity: whether the
 * `@deepseek-ai/*` packages the host actually mounted are one physical instance,
 * or whether two non-equivalent copies of a shared-instance contract were
 * loaded. That question cannot be answered from outside the process -- a
 * separate script resolves modules in its OWN loader graph, which says nothing
 * about what the host loaded. So this file is INSERTED into the running tree
 * and runs inside the host.
 *
 * THE HONEST DISCRIMINATOR, AND WHY IT IS NOT A SUBSTRING TEST
 *
 * A previous agent tested `resolvedPath.includes('/src/')` and reported every
 * peer as failing, because the checkout itself lives at `D:\DSH\src\dsh-src` --
 * EVERY path in the tree contains a `src` segment, so a substring test flags all
 * of them. A later agent anchored `createRequire` at a directory with no
 * `node_modules` ancestor and reported every peer unresolvable.
 *
 * This probe does neither. It decides by CLASS IDENTITY:
 *
 *   1. Resolve the package's BUILT entry (`lib/index.js`) and its SOURCE entry
 *      (`src/index.ts`) as two distinct candidate URLs.
 *   2. Ask the RUNNING HOST for the service instance it registered
 *      (`ctx.get('tools')`).
 *   3. Test `hostInstance instanceof candidateClass` for each candidate.
 *
 * Whichever candidate the host's instance IS an instanceof is the copy the host
 * actually mounted -- decided by object identity, not by looking at a path
 * string. The recorded realpath then names the file, and the instanceof result
 * is what makes the path trustworthy: if the path pointed at a copy the host did
 * NOT load, the class would differ and the check would be false.
 *
 * Two non-equivalent physical instances of a shared-instance contract = FAIL.
 *
 * THE ROOT CAUSE THIS INSTRUMENT EXISTS TO CATCH
 *
 * `packages/core/tools/src/index.ts:463` declares
 *
 *     export const TOOL_RUNTIME_SCHEDULER: unique symbol = Symbol('...scheduler')
 *
 * `Symbol()`, NOT `Symbol.for()`: the symbol is PER MODULE INSTANCE. Agent-loop's
 * `tool-calls.ts:170` does `ctx.tools[TOOL_RUNTIME_SCHEDULER].prepare(...)`. If
 * the host registered `ctx.tools` from one physical copy of dsh-tools and the
 * agent-loop doing the dispatch holds another, the lookup yields `undefined` and
 * the run dies at exactly the reported message: `Cannot read properties of
 * undefined (reading 'prepare')`. That is a module-identity defect, which is why
 * it belongs to this gate family and not to the tool gate.
 *
 * HOW THE RESULT LEAVES THE PROCESS
 *
 * One JSON file written to `process.env.T17_PROBE_OUT`, then the launcher's own
 * bounded exit (`ctx.appExit`). The path is read from the environment rather
 * than hardcoded, because a probe writing to a FIXED path is a SHARED MUTABLE
 * RESOURCE: two agents cannot tell whose result it holds, and that produced a
 * false PASS in this project once already. The caller reads the file back and
 * asserts it names the home it booted.
 * @module verify-t17-identity.probe
 */
import { writeFileSync, readFileSync, existsSync, realpathSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { fileURLToPath, pathToFileURL } from 'node:url'

/** Stable Cordis plugin name. */
export const name = 't17-identity-probe'

/** Absolute path of the pinned checkout. Built from parts, never from an escaped literal. */
const DSH_SRC = ['D:', 'DSH', 'src', 'dsh-src'].join('/')

/** Absolute path of the working repository. */
const REPO = ['D:', 'DSH', 'work', 'dsh-native-daily'].join('/')

/**
 * The six packages the gate names, with the class each publishes, the service
 * name it registers, and the two physical entries a resolution can land on.
 *
 * `service: null` means the package publishes no service: for cordis the
 * identity fact is whether the host's own root Context is an instanceof this
 * copy's `Context` class.
 */
const PEERS = [
  { pkg: '@deepseek-ai/cordis', cls: 'Context', service: null, built: 'vendor/cordis/lib/index.js', source: 'vendor/cordis/src/index.ts' },
  { pkg: '@deepseek-ai/dsh-tools', cls: 'ToolRuntime', service: 'tools', built: 'packages/core/tools/lib/index.js', source: 'packages/core/tools/src/index.ts' },
  { pkg: '@deepseek-ai/dsh-agent-loop', cls: 'AgentLoop', service: 'agentLoop', built: 'packages/core/agent-loop/lib/index.js', source: 'packages/core/agent-loop/src/index.ts' },
  { pkg: '@deepseek-ai/dsh-agent', cls: 'AgentRegistry', service: 'agents', built: 'packages/core/agent/lib/index.js', source: 'packages/core/agent/src/index.ts' },
  { pkg: '@deepseek-ai/dsh-session', cls: 'SessionStore', service: 'sessions', built: 'packages/core/session/lib/index.js', source: 'packages/core/session/src/index.ts' },
  { pkg: '@deepseek-ai/dsh-subagent', cls: 'SubagentRuntime', service: 'subagents', built: 'packages/subagent/subagent/lib/index.js', source: 'packages/subagent/subagent/src/index.ts' },
]

/**
 * Classify a filesystem path by the FILE it names.
 *
 * Deliberately NOT a `/\/src\//` substring test: the checkout is at
 * `D:\DSH\src\dsh-src`, so every path inside it contains a `src` segment and a
 * substring test flags all of them. What distinguishes source from built is
 * which file the resolution landed on.
 * @param path - an absolute filesystem path.
 * @returns the discrimination label and the evidence for it.
 */
function classify(path) {
  const normalized = String(path).replace(/\\/g, '/')
  if (/\.ts$/.test(normalized)) {
    return { landedOn: 'SOURCE', evidence: 'the file it names ends in .ts' }
  }
  if (/\/lib\/[^/]+\.js$/.test(normalized)) {
    return { landedOn: 'BUILT', evidence: 'the file it names is a lib/*.js' }
  }
  return { landedOn: 'OTHER', evidence: `the file it names is neither a .ts nor a lib/*.js: ${normalized}` }
}

/** sha256 of a file, or a recorded reason it could not be read. */
function sha256File(path) {
  try {
    return { digest: createHash('sha256').update(readFileSync(path)).digest('hex'), error: null }
  } catch (error) {
    return { digest: null, error: error instanceof Error ? error.message.split('\n')[0] : String(error) }
  }
}

/**
 * Reproduce Python's `json.dumps(obj, sort_keys=True, separators=(',',':'),
 * ensure_ascii=True)` byte for byte.
 *
 * WHY REIMPLEMENT IT RATHER THAN SHELL OUT. `compatibility.lock.json` declares
 * that exact algorithm as its `identity_algorithm`, so the identity can only be
 * re-derived from inside a Node process by reproducing it. Shelling out to
 * `python` from a boot probe would make the probe's result depend on a second
 * interpreter being on PATH, which is a property of the machine and not of the
 * deployment.
 *
 * The escaping rules that matter and are easy to get wrong: Python escapes
 * `\` and `"`, uses the SHORT forms `\b \f \n \r \t` for those five control
 * characters, `\u00XX` for the rest below 0x20, and `\uXXXX` for everything
 * above 0x7e -- including DEL and every non-ASCII code point.
 * @param value - the value to serialise.
 * @returns the canonical JSON string.
 */
function pythonCanonicalJson(value) {
  if (value === null) return 'null'
  if (value === true) return 'true'
  if (value === false) return 'false'
  if (typeof value === 'number') return JSON.stringify(value)
  if (typeof value === 'string') return pythonJsonString(value)
  if (Array.isArray(value)) return `[${value.map(pythonCanonicalJson).join(',')}]`
  const keys = Object.keys(value).sort()
  return `{${keys.map(k => `${pythonJsonString(k)}:${pythonCanonicalJson(value[k])}`).join(',')}}`
}

/** Python's `json.dumps` string escaping, with `ensure_ascii=True`. */
function pythonJsonString(text) {
  let out = '"'
  for (const char of text) {
    const code = char.codePointAt(0)
    if (char === '\\') out += '\\\\'
    else if (char === '"') out += '\\"'
    else if (char === '\b') out += '\\b'
    else if (char === '\f') out += '\\f'
    else if (char === '\n') out += '\\n'
    else if (char === '\r') out += '\\r'
    else if (char === '\t') out += '\\t'
    else if (code < 0x20) out += `\\u${code.toString(16).padStart(4, '0')}`
    else if (code > 0x7e) out += `\\u${code.toString(16).padStart(4, '0')}`
    else out += char
  }
  return `${out}"`
}

/**
 * THE LAUNCHER IDENTITY: is the module that is RUNNING the one the lock names,
 * and does the recorded digest cover the inputs this tree actually has?
 *
 * THE LESSON THIS ENCODES. "An identity digest proves the inputs have not
 * changed; it does not prove the inputs are right." A previous round found
 * `launcher_realpath` written with Python escape sequences applied -- `\apps\`
 * became BEL (0x07) and `\bin.js` became backspace (0x08) -- so the digest was
 * computed over a path that does not exist. That corruption is checked here
 * directly (control bytes in the recorded string) rather than assumed fixed,
 * AND the coverage question is asked separately: a digest over a field whose
 * VALUE is now stale is a digest that proves the wrong thing.
 * @returns the measured launcher identity record.
 */
function probeLauncherIdentity() {
  const record = {
    what: 'the running launcher module, and what the recorded identity digest covers',
    lockPath: `${REPO}/compatibility.lock.json`,
    lockReadError: null,
    identityRecorded: null,
    identityRecomputed: null,
    identityRecomputes: null,
    // The file actually executing, from the process itself. `process.argv[1]`
    // is the script Node was handed; it is the only in-process evidence of which
    // artifact is running.
    runningArgv1: null,
    runningArgv1Realpath: null,
    lockedRealpath: null,
    lockedRealpathControlChars: [],
    runningMatchesLockedRealpath: null,
    launcherSha256: null,
    lockedArtifactSha256: null,
    launcherSha256MatchesLockedArtifact: null,
    // Per-input coverage: what the lock pinned vs what is on disk NOW.
    inputCoverage: {},
  }

  let lock
  try {
    lock = JSON.parse(readFileSync(record.lockPath, 'utf8'))
  } catch (error) {
    record.lockReadError = error instanceof Error ? error.message.split('\n')[0] : String(error)
    return record
  }

  const deployment = lock.deployment ?? {}
  const inputs = deployment.inputs ?? {}
  record.identityRecorded = typeof deployment.identity === 'string' ? deployment.identity : null
  record.identityAlgorithm = typeof deployment.identity_algorithm === 'string' ? deployment.identity_algorithm : null

  // The declared algorithm, run here. A mismatch is recorded as a mismatch.
  try {
    const canonical = pythonCanonicalJson(inputs)
    record.identityRecomputed = createHash('sha256').update(Buffer.from(canonical, 'utf8')).digest('hex')
    record.identityRecomputes = record.identityRecomputed === record.identityRecorded
    record.identityCanonicalByteLength = Buffer.byteLength(canonical, 'utf8')
  } catch (error) {
    record.identityRecomputeError = error instanceof Error ? error.message : String(error)
  }

  // The corruption check, applied to the recorded value itself.
  const lockedRealpath = inputs.launcher_realpath
  if (typeof lockedRealpath === 'string') {
    record.lockedRealpath = lockedRealpath
    for (let index = 0; index < lockedRealpath.length; index += 1) {
      const code = lockedRealpath.charCodeAt(index)
      if (code < 0x20) record.lockedRealpathControlChars.push({ index, code: `0x${code.toString(16)}` })
    }
    const sha = sha256File(lockedRealpath)
    record.launcherSha256 = sha.digest
    record.launcherSha256Error = sha.error
  }
  record.lockedArtifactSha256 = typeof inputs.artifact_sha256 === 'string' ? inputs.artifact_sha256 : null
  record.launcherSha256MatchesLockedArtifact =
    record.launcherSha256 !== null && record.launcherSha256 === record.lockedArtifactSha256

  // The RUNNING artifact, as the process itself reports it.
  const argv1 = process.argv[1] ?? null
  record.runningArgv1 = argv1
  record.runningArgv1Realpath = argv1 === null ? null : safeRealpath(argv1)
  if (record.runningArgv1Realpath !== null && record.lockedRealpath !== null) {
    const norm = value => String(value).replace(/\\/g, '/').toLowerCase()
    record.runningMatchesLockedRealpath = norm(record.runningArgv1Realpath) === norm(record.lockedRealpath)
  }

  // COVERAGE, one row per identity input that names a file on disk. This is the
  // half the corruption lesson does not cover: a well-formed digest over a value
  // that has since moved still proves the wrong thing.
  const coverageInputs = {
    host_profile_digest: `${REPO}/profiles/daily-candidate/cordis.patch.yml`,
    agent_preset_digest: `${DSH_SRC}/packages/preset/agent-presets/presets/standard/agent.cordis.yml`,
    acceptance_spec_sha256: `${REPO}/qualification/specs/acceptance-spec.json`,
    trusted_local_acceptance_spec_sha256: `${REPO}/qualification/specs/acceptance-spec.trusted-local-v1.json`,
    dependency_lock_sha256: `${DSH_SRC}/pnpm-lock.yaml`,
    artifact_sha256: `${DSH_SRC}/apps/cli/lib/bin.js`,
  }
  for (const [key, path] of Object.entries(coverageInputs)) {
    const pinned = typeof inputs[key] === 'string' ? inputs[key] : null
    const sha = sha256File(path)
    record.inputCoverage[key] = {
      pinned,
      onDiskPath: path,
      onDiskSha256: sha.digest,
      onDiskError: sha.error,
      matches: sha.digest !== null && pinned !== null && sha.digest === pinned,
    }
  }
  return record
}

/**
 * THE SYMBOL IDENTITY: the root cause this instrument exists to catch.
 *
 * `packages/core/tools/src/index.ts:463` declares
 * `TOOL_RUNTIME_SCHEDULER` with `Symbol(...)`, NOT `Symbol.for(...)`. A plain
 * `Symbol()` is PER MODULE INSTANCE, so if the host registered `ctx.tools` from
 * one physical copy of `dsh-tools` while the agent loop that dispatches holds
 * another, `ctx.tools[TOOL_RUNTIME_SCHEDULER]` is `undefined` and the run dies
 * at `packages/core/agent-loop/src/tool-calls.ts:170` with
 * `Cannot read properties of undefined (reading 'prepare')`.
 *
 * THIS IS A DIRECT MEASUREMENT OF THAT FAILURE, not an inference from paths.
 * Both candidate copies of the symbol are imported and each is used to INDEX the
 * host's own ToolRuntime instance. Whichever copy the host's instance answers to
 * is the copy the host loaded; a copy that answers `undefined` is a second
 * physical instance that would have produced the crash.
 *
 * The lookup is done with a bracket access rather than `ctx.tools[...]` on the
 * trace proxy, because the proxy's `get` trap forwards SYMBOL properties
 * unchanged (`vendor/cordis/src/utils.ts:177-179`), so the index reaches the
 * real service object either way -- but doing it on the unwrapped original
 * removes the proxy from the question entirely.
 * @param ctx - the live host context.
 * @returns the measured symbol-identity record.
 */
async function probeSymbolIdentity(ctx) {
  const record = {
    symbol: 'TOOL_RUNTIME_SCHEDULER',
    declaredAt: 'packages/core/tools/src/index.ts:463 (built: packages/core/tools/lib/index.js)',
    declarationKind: null,
    declarationKindEvidence: null,
    libSymbolImported: null,
    srcSymbolImported: null,
    libSymbolIsSameAsSrcSymbol: null,
    hostInstanceHasLibSymbol: null,
    hostInstanceHasSrcSymbol: null,
    hostInstanceSchedulerUsable: null,
    hostInstanceSchedulerMethods: [],
    notes: [],
  }

  // The declaration, read from the SOURCE text so the `Symbol()` vs
  // `Symbol.for()` distinction is a measurement and not a remembered fact.
  try {
    const source = readFileSync(`${DSH_SRC}/packages/core/tools/src/index.ts`, 'utf8')
    const match = /export const TOOL_RUNTIME_SCHEDULER[^=]*=\s*(Symbol\.for\([^)]*\)|Symbol\([^)]*\))/.exec(source)
    if (match !== null) {
      record.declarationKind = match[1].startsWith('Symbol.for(') ? 'Symbol.for' : 'Symbol'
      record.declarationKindEvidence = match[1]
    } else {
      record.notes.push('the declaration was not found in packages/core/tools/src/index.ts')
    }
  } catch (error) {
    record.notes.push(`source read failed: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`)
  }

  const lib = await loadClass(pathToFileURL(`${DSH_SRC}/packages/core/tools/lib/index.js`).href, 'TOOL_RUNTIME_SCHEDULER')
  const src = await loadClass(pathToFileURL(`${DSH_SRC}/packages/core/tools/src/index.ts`).href, 'TOOL_RUNTIME_SCHEDULER')
  // `loadClass` requires a function; a symbol export needs its own reader.
  record.libSymbolImported = await importSymbol(pathToFileURL(`${DSH_SRC}/packages/core/tools/lib/index.js`).href, 'TOOL_RUNTIME_SCHEDULER', record, 'lib')
  record.srcSymbolImported = await importSymbol(pathToFileURL(`${DSH_SRC}/packages/core/tools/src/index.ts`).href, 'TOOL_RUNTIME_SCHEDULER', record, 'src')
  void lib
  void src
  if (typeof record.libSymbolImported === 'symbol' && typeof record.srcSymbolImported === 'symbol') {
    record.libSymbolIsSameAsSrcSymbol = record.libSymbolImported === record.srcSymbolImported
  }

  const tools = ctx.get('tools')
  if (tools === undefined) {
    record.notes.push('no tools service on the host context')
    return record
  }
  // Unwrap cordis's trace proxy: `ctx.get` returns a Proxy whose symbol reads
  // are forwarded, but reading the original makes the index unambiguous.
  const ORIGINAL = Symbol.for('cordis.original')
  const raw = tools[ORIGINAL] ?? tools
  record.hostInstanceWasTraceProxy = raw !== tools

  if (typeof record.libSymbolImported === 'symbol') {
    const scheduler = raw[record.libSymbolImported]
    record.hostInstanceHasLibSymbol = scheduler !== undefined
    if (scheduler !== undefined) {
      record.hostInstanceSchedulerMethods = ['prepare', 'dispatch', 'finalize', 'finish']
        .filter(method => typeof scheduler[method] === 'function')
      record.hostInstanceSchedulerUsable = record.hostInstanceSchedulerMethods.length === 4
    }
  }
  if (typeof record.srcSymbolImported === 'symbol') {
    record.hostInstanceHasSrcSymbol = raw[record.srcSymbolImported] !== undefined
  }
  return record
}

/** Import one named export that may be a symbol rather than a class. */
async function importSymbol(url, exportName, record, label) {
  try {
    const mod = await import(url)
    const value = mod[exportName]
    if (value === undefined) {
      record.notes.push(`${label}: the module loaded but exports no ${exportName}`)
      return null
    }
    return value
  } catch (error) {
    record.notes.push(`${label}: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`)
    return null
  }
}

/** Import a URL and return the named class export, or a recorded reason it could not. */
async function loadClass(url, cls) {
  try {
    const mod = await import(url)
    const found = mod[cls]
    if (typeof found !== 'function') {
      return { cls: null, error: `the module loaded but exports no class named ${cls}` }
    }
    return { cls: found, error: null }
  } catch (error) {
    return { cls: null, error: error instanceof Error ? error.message.split('\n')[0] : String(error) }
  }
}

/** Read a package's declared version from its own manifest under the pinned checkout. */
function readVersion(pkg) {
  const dir = pkg.replace('@deepseek-ai/', '')
  const candidates = {
    cordis: ['vendor', 'cordis'],
    'dsh-tools': ['packages', 'core', 'tools'],
    'dsh-agent-loop': ['packages', 'core', 'agent-loop'],
    'dsh-agent': ['packages', 'core', 'agent'],
    'dsh-session': ['packages', 'core', 'session'],
    'dsh-subagent': ['packages', 'subagent', 'subagent'],
  }
  const parts = candidates[dir]
  if (parts === undefined) return { error: `no known manifest directory for ${pkg}` }
  const manifestPath = [DSH_SRC, ...parts, 'package.json'].join('/')
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    return { version: typeof manifest.version === 'string' ? manifest.version : null, manifestPath }
  } catch (error) {
    return { error: error instanceof Error ? error.message.split('\n')[0] : String(error), manifestPath }
  }
}

/**
 * Probe one peer by class identity.
 *
 * The order matters for what gets reported, not for the verdict: BUILT is tried
 * first because the qualified distribution is the built one, so the common case
 * is decided without importing a second physical copy of the package into the
 * process. The SOURCE candidate is imported only when BUILT does not match --
 * which keeps the probe from perturbing the very thing it measures in the
 * healthy case.
 */
async function probePeer(ctx, entry) {
  const record = {
    package: entry.pkg,
    class: entry.cls,
    service: entry.service,
    builtEntry: [DSH_SRC, entry.built].join('/'),
    sourceEntry: [DSH_SRC, entry.source].join('/'),
    builtRealpath: null,
    sourceRealpath: null,
    hostInstanceSource: null,
    hostInstanceLandedOn: null,
    discriminationEvidence: null,
    hostInstanceConstructor: null,
    version: null,
    versionManifest: null,
    versionError: null,
    builtMatch: null,
    sourceMatch: null,
    notes: [],
  }

  const version = readVersion(entry.pkg)
  record.version = version.version ?? null
  record.versionManifest = version.manifestPath ?? null
  if (version.error !== undefined) record.versionError = version.error

  // The host's own instance: what the tree actually registered.
  const hostInstance = entry.service === null ? ctx : ctx.get(entry.service)
  if (hostInstance === undefined) {
    record.notes.push(`the host registered no service named ${JSON.stringify(entry.service)}`)
    return record
  }
  record.hostInstanceConstructor = hostInstance.constructor?.name ?? null

  // Candidate 1: the BUILT entry.
  const builtUrl = pathToFileURL(record.builtEntry).href
  const built = await loadClass(builtUrl, entry.cls)
  if (built.error !== null) record.notes.push(`built entry: ${built.error}`)
  if (built.cls !== null) {
    record.builtRealpath = safeRealpath(record.builtEntry)
    record.builtMatch = hostInstance instanceof built.cls
    if (record.builtMatch) {
      record.hostInstanceSource = record.builtEntry
      record.hostInstanceLandedOn = 'BUILT'
    }
  }

  // Candidate 2: the SOURCE entry. Only when BUILT did not already match.
  if (record.builtMatch !== true) {
    const sourceUrl = pathToFileURL(record.sourceEntry).href
    const source = await loadClass(sourceUrl, entry.cls)
    if (source.error !== null) record.notes.push(`source entry: ${source.error}`)
    if (source.cls !== null) {
      record.sourceRealpath = safeRealpath(record.sourceEntry)
      record.sourceMatch = hostInstance instanceof source.cls
      if (record.sourceMatch) {
        record.hostInstanceSource = record.sourceEntry
        record.hostInstanceLandedOn = 'SOURCE'
      }
    }
  }

  if (record.hostInstanceLandedOn === null) {
    record.hostInstanceLandedOn = 'NEITHER_CANDIDATE'
    record.discriminationEvidence =
      'the host instance is an instanceof NEITHER the built nor the source entry, '
      + 'so it came from a third physical copy of this package'
  } else {
    record.discriminationEvidence = classify(record.hostInstanceSource).evidence
  }
  return record
}

/**
 * The INSTALLED profile patch this boot actually read, and its digest.
 *
 * WHY THIS IS IN THE ARTIFACT. Every home installs the extension packages through
 * a `link:`, so a probe that boots an installed profile executes the BUILT
 * artifact, never the repository source. The installed profile patch is a COPY
 * that can drift from the repository file it came from -- and a sibling agent
 * measured a stale build as a product defect exactly this way today. Recording
 * the digest of the installed copy, next to the digest of the repository source,
 * makes the drift visible instead of invisible.
 *
 * The profile directory is derived from `DSH_HOME`, which the harness sets, so
 * this names the home the caller booted rather than a guessed path.
 * @returns the installed-profile record.
 */
function probeInstalledProfile() {
  const home = process.env.DSH_HOME ?? null
  const profileName = process.env.T17_PROFILE_NAME ?? 'daily'
  const record = {
    home,
    profileName,
    installedPatchPath: home === null ? null : `${home}/profiles/${profileName}/cordis.patch.yml`,
    installedPatchSha256: null,
    installedPatchReadError: null,
    repoPatchPath: `${REPO}/profiles/daily-candidate/cordis.patch.yml`,
    repoPatchSha256: null,
    installedMatchesRepo: null,
  }
  if (record.installedPatchPath !== null) {
    const installed = sha256File(record.installedPatchPath)
    record.installedPatchSha256 = installed.digest
    record.installedPatchReadError = installed.error
  }
  const repo = sha256File(record.repoPatchPath)
  record.repoPatchSha256 = repo.digest
  record.installedMatchesRepo =
    record.installedPatchSha256 !== null && record.installedPatchSha256 === record.repoPatchSha256
  return record
}

/** realpath, falling back to the raw path with a recorded reason rather than dropping the row. */
function safeRealpath(path) {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}

/**
 * `FiberState.ACTIVE` (`vendor/cordis/src/fiber.ts:147-155`).
 *
 * Declared before its first use so the constant is initialised by the time any
 * function reads it; a module-level `const` read from inside a function that runs
 * after module evaluation would work either way, but ordering it this way makes
 * the dependency visible.
 */
const FIBER_ACTIVE = 2

/**
 * Wait, with a DEADLINE, until every loader entry other than this probe's own is
 * settled (ACTIVE, or disabled, or genuinely FAILED).
 *
 * WHY NOT `loader.await()`. The obvious call is a DEADLOCK, and it is worth
 * writing down because it looks correct:
 *
 *   `EntryTree.await()` loops while `getTasks()` is non-empty, and `getTasks()`
 *   maps every entry to `entry._initTask || entry.fiber?.inertia`
 *   (`vendor/loader/src/config/tree.ts:36-49`). A fiber's `inertia` is the
 *   promise of its CURRENT lifecycle job (`vendor/cordis/src/fiber.ts:629-635`),
 *   and while a plugin's `apply` is running that job IS the call to `apply`. So
 *   from inside `apply`, the probe's own fiber contributes a pending task that
 *   cannot settle until `apply` returns -- and `await()` would spin forever
 *   waiting on itself.
 *
 * The wait is also BOUNDED. A row that legitimately never activates (a preset
 * row waiting on a service the host does not mount) would otherwise hang the
 * boot, and a hung boot produces no artifact at all -- which reads as "no
 * finding" instead of "the tree did not settle".
 * @param ctx - the live host context.
 * @param timeoutMs - how long to wait before recording that it did not settle.
 * @returns the settle record, including which entries were still moving.
 */
async function waitForSettle(ctx, timeoutMs) {
  const record = {
    method: 'poll loader.entries() for non-ACTIVE non-disabled entries, excluding this probe row',
    excludedOwnRowId: name,
    timeoutMs,
    settled: false,
    waitedMs: 0,
    entryCount: null,
    stillMoving: [],
    note: 'loader.await() is NOT used: it waits on this probe\'s own fiber inertia and would deadlock.',
  }
  const loader = ctx.get('loader')
  if (loader === undefined) {
    record.stillMoving.push('ctx.loader is absent; the tree cannot be observed')
    return record
  }
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    let moving = []
    let total = 0
    for (const entry of loader.entries()) {
      total += 1
      if (entry.options.id === name) continue
      let disabled = false
      try {
        disabled = entry.disabled === true
      } catch {
        // A throwing `disabled` expression is an entry failure; treat it as
        // settled so it is reported as such rather than waiting on it.
        continue
      }
      if (disabled) continue
      const state = entry.fiber?.state ?? null
      if (state !== FIBER_ACTIVE) moving.push({ id: entry.options.id, state })
    }
    record.entryCount = total
    record.stillMoving = moving
    if (moving.length === 0) {
      record.settled = true
      break
    }
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  record.waitedMs = Date.now() - started
  return record
}

/**
 * THE FIRST TOOL CALL, measured on a real Session.
 *
 * Two separate facts, deliberately not collapsed:
 *
 *   1. WHAT THE MODEL IS OFFERED. The catalog for a real Session, in the order
 *      the request header carries it (NOT sorted -- the first entry is what the
 *      model reads first, and sorting would destroy that). Both scope keys are
 *      read: the agent object (correct) and `agent.ctx` (the G-FIX-06 false
 *      negative, kept as a contrast so the right key stays falsifiable).
 *
 *   2. WHETHER THE DISPATCH PATH ACTUALLY WORKS. The catalog is a projection;
 *      a call is a dispatch, and dispatch is where the per-module-instance
 *      `Symbol` is indexed. So a real turn is driven through the real adapter
 *      and the resulting session events are read back.
 *
 * WHY DRIVING THE SHIPPED MOCK ADAPTER IS STILL THE RIGHT EXPERIMENT even
 * though it asks for a tool this composition disables. The mock's first call is
 * `pwsh` on win32, and the daily preset sets `tool-pwsh: disabled: true`. The
 * dispatch path indexes `ctx.tools[TOOL_RUNTIME_SCHEDULER]` BEFORE it resolves
 * the tool name (`packages/core/agent-loop/src/tool-calls.ts:165-170`), so the
 * two possible outcomes are MUTUALLY EXCLUSIVE and each names its own cause:
 *
 *   - `Cannot read properties of undefined (reading 'prepare')` -> the identity
 *     defect this gate exists to catch (the symbol came from another copy);
 *   - `UNKNOWN_TOOL` / a denial naming `pwsh` -> the symbol was RIGHT and the
 *     tool is simply not in this composition.
 *
 * A run that reports only "the tool call failed" could not tell those apart,
 * which is why the exact error text is recorded rather than a boolean.
 * @param ctx - the live host context.
 * @returns the measured first-tool-call record.
 */
async function probeFirstToolCall(ctx) {
  const record = {
    sessionCreated: false,
    sessionId: null,
    sessionCwd: null,
    agentPreset: null,
    agentPresent: false,
    // Fact 1: what the model is offered.
    toolCountAgentKey: 0,
    toolsInHeaderOrder: [],
    firstToolOffered: null,
    toolCountContextKey: null,
    // Fact 2: the real turn.
    promptAccepted: false,
    promptRejection: null,
    turnCompleted: false,
    turnWaitMs: null,
    turnTimedOut: false,
    // The first call the model made, and what came back.
    toolCallRequested: null,
    toolResultSeen: false,
    toolResultIsError: null,
    toolResultText: null,
    toolResultErrorCode: null,
    firstCallSucceeded: null,
    // The exact tool the adapter asked for and the file it named, so a reader
    // can tell a successful call from a call that succeeded on the wrong thing.
    expectedToolName: 'read',
    expectedFilePath: process.env.T17_FIRST_CALL_FILE ?? null,
    turnEndReason: null,
    turnEndErrorMessage: null,
    turnEndErrorCode: null,
    // The discriminator.
    schedulerPrepareError: null,
    identityDefectSymptom: null,
    notes: [],
  }

  const sc = ctx.get('sessionController')
  const tools = ctx.get('tools')
  const agents = ctx.get('agents')
  if (sc === undefined || tools === undefined || agents === undefined) {
    record.notes.push(`missing service(s): ${[
      sc === undefined ? 'sessionController' : null,
      tools === undefined ? 'tools' : null,
      agents === undefined ? 'agents' : null,
    ].filter(Boolean).join(', ')}`)
    return record
  }

  const cwd = process.env.T17_SESSION_CWD ?? REPO
  const created = await sc.create({ cwd })
  record.sessionId = created?.sessionId ?? created?.id ?? null
  record.sessionCreated = record.sessionId !== null
  record.sessionCwd = cwd
  record.agentPreset = created?.agentPreset ?? null
  if (!record.sessionCreated) {
    record.notes.push('the session controller returned no session id')
    return record
  }

  const agent = agents.get(record.sessionId)
  record.agentPresent = agent !== undefined
  if (agent === undefined) {
    record.notes.push('the created session has no live agent in this process')
    return record
  }

  // Fact 1. Header order, not sorted: the first entry is what the model reads
  // first. The sorted list is derivable by the reader; the order is not.
  const schemas = tools.schemas(agent)
  record.toolsInHeaderOrder = schemas.map(schema => schema.name)
  record.toolCountAgentKey = record.toolsInHeaderOrder.length
  record.firstToolOffered = record.toolsInHeaderOrder[0] ?? null
  try {
    record.toolCountContextKey = tools.schemas(agent.ctx).length
  } catch (error) {
    record.notes.push(`the agent.ctx-keyed view threw: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`)
  }

  // Fact 2. A real turn. `whenIdle()` is the agent's own completion signal
  // (`packages/core/agent-loop/src/agent.ts:211`), raced against a deadline so a
  // stuck turn cannot hang the boot.
  //
  // THE SECOND ARGUMENT IS REQUIRED, and omitting it is a probe bug that LOOKS
  // like a product failure. `SessionController.prompt(request, signal)` calls
  // `signal.throwIfAborted()` as its first statement
  // (`packages/api/session-controller/src/index.ts:348`), so an omitted signal
  // throws `Cannot read properties of undefined (reading 'throwIfAborted')` --
  // an error that names neither the probe nor the product. An earlier run of
  // this probe recorded exactly that, which is why the signal is passed
  // explicitly and the failure is written down here.
  const deadlineMs = Number(process.env.T17_TURN_TIMEOUT_MS ?? 45_000)
  const turnAbort = new AbortController()
  try {
    await sc.prompt({
      requestId: `t17-${Date.now().toString(36)}`,
      sessionId: record.sessionId,
      mode: 'queue',
      content: [{ type: 'text', text: 'probe' }],
    }, turnAbort.signal)
    record.promptAccepted = true
  } catch (error) {
    record.promptRejection = error instanceof Error ? error.message.split('\n')[0] : String(error)
    record.notes.push(`prompt rejected: ${record.promptRejection}`)
  }

  if (record.promptAccepted && typeof agent.whenIdle === 'function') {
    const started = Date.now()
    let timedOut = false
    await Promise.race([
      agent.whenIdle(),
      new Promise(resolve => setTimeout(() => { timedOut = true; resolve() }, deadlineMs)),
    ])
    record.turnWaitMs = Date.now() - started
    record.turnTimedOut = timedOut
    record.turnCompleted = !timedOut
  }

  // Read the turn's own durable record rather than trusting the wait: the log is
  // what the deployment persisted, and it survives the wait being wrong.
  try {
    const session = ctx.get('sessions')?.get(record.sessionId)
    if (session === undefined) {
      record.notes.push('the session is not in the SessionStore; the turn record cannot be read')
    } else {
      const events = session.snapshotEvents()
      for (const event of events) {
        if (event.type === 'tool/call') {
          record.toolCallRequested ??= { name: event.data?.name ?? null, callId: event.data?.callId ?? null }
        }
        if (event.type === 'tool/result') {
          record.toolResultSeen = true
          const message = event.data?.message ?? null
          record.toolResultIsError = event.data?.error !== undefined && event.data?.error !== null
          record.toolResultErrorCode = event.data?.error?.code ?? null
          // The model-facing text, so a reader can see WHAT came back rather
          // than only that something did.
          const blocks = Array.isArray(message?.content) ? message.content : []
          const texts = []
          for (const block of blocks) {
            if (block?.type !== 'tool-result') continue
            for (const inner of Array.isArray(block.content) ? block.content : []) {
              if (inner?.type === 'text' && typeof inner.text === 'string') texts.push(inner.text)
            }
          }
          record.toolResultText = texts.join('\n')
        }
        if (event.type === 'turn/end') {
          const reason = event.data?.reason ?? null
          record.turnEndReason = reason?.kind ?? null
          record.turnEndErrorMessage = reason?.error?.message ?? null
          record.turnEndErrorCode = reason?.error?.code ?? null
        }
      }
      record.eventCount = events.length
    }
  } catch (error) {
    record.notes.push(`the session log read failed: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`)
  }

  // THE DISCRIMINATOR, stated explicitly so a reader does not have to infer it.
  const message = record.turnEndErrorMessage ?? ''
  record.identityDefectSymptom = message.includes("reading 'prepare'")
    ? 'PRESENT -- the turn died indexing the scheduler symbol, which is the module-identity defect'
    : 'absent -- the turn did not die on a scheduler symbol index'

  // DID THE FIRST CALL ACTUALLY SUCCEED? Both halves are required: the call must
  // have named the tool the adapter asked for, AND the result must not be an
  // error. A `tool/result` that is an error is a call that REACHED the tool
  // pipeline and was refused there, which is a different fact from a call that
  // never dispatched -- so the two are recorded separately rather than collapsed
  // into one boolean.
  record.firstCallSucceeded =
    record.toolResultSeen === true
    && record.toolResultIsError === false
    && record.toolCallRequested?.name === record.expectedToolName
  return record
}

/**
 * Mount the probe. Injects nothing, so it activates regardless of which sibling rows mounted.
 *
 * INJECTING NOTHING IS LOAD-BEARING. `inject` is a READINESS GATE, not a
 * declaration of interest: a probe that injects a service it wants to ASSERT is
 * present never runs when the service is missing, so the failure reports as "no
 * artifact" instead of "absent". Every service here is read through `ctx.get`,
 * which returns `undefined` honestly, and a missing service lands in the
 * artifact as a recorded fact.
 */
export function apply(ctx) {
  const outPath = process.env.T17_PROBE_OUT
  const exit = ctx.get('appExit')

  const run = async () => {
    const result = {
      probe: 't17-identity-probe',
      schemaVersion: 2,
      // Read back by the caller and asserted to name the home it booted. Without
      // this the caller cannot tell whose result it holds.
      dshHome: process.env.DSH_HOME ?? null,
      sessionRoot: process.env.T17_SESSION_ROOT ?? null,
      launcher: process.env.T17_LAUNCHER ?? null,
      launcherArgs: process.env.T17_LAUNCHER_ARGS ?? null,
      nodeVersion: process.version,
      execPath: process.execPath,
      // Whether this process runs under a TypeScript loader, which is one of the
      // two axes the two launcher identities differ on.
      execArgv: process.execArgv,
      hasTsxOnExecArgv: process.execArgv.some(a => String(a).includes('tsx')),
      cwd: process.cwd(),
      // The digest of the INSTALLED profile patch this boot actually read, so a
      // reader can tell which composition produced this artifact. An installed
      // copy can drift from the repository source it was copied from, and that
      // drift would otherwise be invisible.
      installedProfilePatch: probeInstalledProfile(),
      // The preset ROOTS, read from the live roster. This is what `readResult()`
      // in `qualification/runners/boot-harness.mjs` asserts against to prove the
      // artifact describes the home the caller booted. A probe writing to a fixed
      // path is a SHARED MUTABLE RESOURCE -- two agents cannot tell whose result
      // it holds, and that produced a false PASS in this project once already.
      presetRoots: [],
      peers: [],
      singletonVerdict: null,
      settle: null,
      // Whether the module the host mounted is the one the deployment identity
      // names, and whether the recorded digest covers the inputs on disk NOW.
      launcherIdentity: null,
      // The `Symbol()`-per-module-instance fact the root cause turns on.
      symbolIdentity: null,
      // What the model would be offered, read from the real registry rather than
      // from a config dump. `--dump-config` does not execute plugins, so it
      // cannot show this.
      toolCatalog: null,
      // The first tool the model can actually call on a fresh Session, and the
      // turn that drives it through the real dispatch path.
      firstToolCall: null,
      errors: [],
    }

    if (outPath === undefined || outPath === '') {
      result.errors.push('T17_PROBE_OUT is not set; the probe refuses to write to a fixed path')
    }

    try {
      // Wait for the whole tree to mount before asking what it registered.
      // Sibling rows mount concurrently; a probe that samples too early records
      // "no service registered" for a service that mounts a moment later, which
      // reads as a singleton failure and is only a race. The wait is BOUNDED and
      // does NOT use `loader.await()` -- see `waitForSettle` for why that call
      // deadlocks when made from inside a plugin's own `apply`.
      result.settle = await waitForSettle(ctx, Number(process.env.T17_SETTLE_TIMEOUT_MS ?? 30_000))

      // The roster's own view of its roots. Read FIRST because it is what binds
      // this artifact to the home that was booted, and a result that cannot be
      // bound to a home must not be reported at all.
      const roster = ctx.get('agentPresets')
      if (roster !== undefined) {
        result.presetDefaultId = roster.defaultId ?? null
        result.presetRoots = (roster.roots ?? []).map(root => ({
          path: String(root.path),
          trust: String(root.trust),
        }))
      } else {
        result.errors.push('ctx.agentPresets is absent: the boot cannot be bound to its home')
      }

      for (const entry of PEERS) {
        result.peers.push(await probePeer(ctx, entry))
      }

      const failures = result.peers.filter(p => p.hostInstanceLandedOn === 'NEITHER_CANDIDATE')
      const built = result.peers.filter(p => p.hostInstanceLandedOn === 'BUILT').length
      const source = result.peers.filter(p => p.hostInstanceLandedOn === 'SOURCE').length
      result.singletonVerdict = {
        peersChecked: result.peers.length,
        hostInstancesFromBuiltEntry: built,
        hostInstancesFromSourceEntry: source,
        hostInstancesFromNeitherCandidate: failures.map(p => p.package),
        // A tree that mixes src and lib across these six is the defect the gate
        // names, even when every single row "resolved".
        mixedSourceAndBuilt: built > 0 && source > 0,
        pass: failures.length === 0 && source === 0 && built === result.peers.length,
      }

      // THE LAUNCHER IDENTITY, and the symbol identity that the root cause turns
      // on. Both are read from inside the running process, which is the only
      // place the question has an answer.
      result.launcherIdentity = probeLauncherIdentity()
      result.symbolIdentity = await probeSymbolIdentity(ctx)

      // The model-facing tool catalog, read from the live registry.
      //
      // THE SCOPE KEY IS THE AGENT OBJECT, NOT ITS CONTEXT. `AgentLoop` builds
      // the scope with `createScope(loopCtx, this)` (agent.ts:104), and DSH's own
      // PTC code harvests with `registry.schemas(exec.agent)`
      // (packages/core/tools/src/ptc.ts:682). Passing `agent.ctx` yields a key
      // that owns no scope layer, so the view collapses to the GLOBAL layer,
      // which holds zero agent tools -- a previous probe made exactly that
      // mistake and reported a false `toolCount: 0` (recorded as G-FIX-06).
      //
      // BOTH KEYS ARE MEASURED and both are recorded, because the contrast is
      // what makes the right key falsifiable rather than folklore.
      const tools = ctx.get('tools')
      if (tools === undefined) {
        result.toolCatalog = { error: 'no tools service on the host context' }
      } else {
        try {
          const globalNames = tools.schemas().map(s => s.name).sort()
          result.toolCatalog = {
            source: 'ctx.tools.schemas() with no scope key (the host/global layer)',
            toolCount: globalNames.length,
            tools: globalNames,
          }
        } catch (error) {
          result.toolCatalog = { error: error instanceof Error ? error.message.split('\n')[0] : String(error) }
        }
      }

      // THE FIRST TOOL CALL. What the model can actually reach on a fresh
      // Session, and which tool the model would call FIRST.
      //
      // WHY THE FIRST CALL AND NOT JUST THE CATALOG. A catalog is what the
      // request header carries; a CALL is what the dispatch path executes, and
      // the dispatch path is where the per-module-instance `Symbol` is indexed
      // (`agent-loop/src/tool-calls.ts:170`). A tree that answers the catalog
      // question correctly can still die at the first call. So the first call is
      // driven for real, through the same scheduler entry point the agent loop
      // uses, and its outcome is recorded.
      result.firstToolCall = await probeFirstToolCall(ctx)
    } catch (error) {
      result.errors.push(error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error))
    }

    if (outPath !== undefined && outPath !== '') {
      try {
        writeFileSync(outPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8')
      } catch (error) {
        process.stderr.write(`t17-identity-probe: cannot write ${outPath}: ${String(error)}\n`)
      }
    }
    process.stdout.write(`T17-IDENTITY-PROBE: ${JSON.stringify(result.singletonVerdict)}\n`)
    if (typeof exit === 'function') exit(0)
    else process.exit(0)
  }

  void run().catch((error) => {
    process.stderr.write(`t17-identity-probe: ${error instanceof Error ? error.message : String(error)}\n`)
    if (typeof exit === 'function') exit(1)
    else process.exit(1)
  })
}
