/**
 * Host-level service registration: `ctx.ipython`.
 *
 * WHY A SERVICE AND NOT A PER-CALL KERNEL. Kernel identity is
 * `Session + executionWorld + environmentDigest + kernelEpoch` (architecture
 * section 10). It is deliberately NOT the Agent object: a continuable child's
 * activation can end and release its AgentHandle while its Session stays usable,
 * so keying kernels by Agent would either leak a kernel per incarnation or
 * destroy a namespace that is still legitimately in use.
 *
 * This service is the only thing that maps a Session to its kernel. It is
 * mounted ONCE by the host profile: a second mount would be a second registry
 * over the same kernels, which is precisely the split-brain the identity rule
 * exists to prevent.
 *
 * KERNEL LIFECYCLE IS HOST POLICY, NOT MODEL POLICY. Nothing here is reachable
 * from the `ipython` tool except `runCell` and `currentEpoch`. Restart, evict,
 * and shutdown are host operations.
 *
 * ===========================================================================
 * THIS SERVICE ALSO OWNS THE NATIVE-TOOL BRIDGE (F2 / G-SEAM-34)
 * ===========================================================================
 *
 * WHY HERE AND NOT SOMEWHERE ELSE. The bridge is what lets a cell call a DSH
 * tool, and its capability must be valid for exactly as long as the kernel
 * namespace that holds it. That is the same lifetime rule as the kernel's, so the
 * component that already owns the kernel's lifetime owns the bridge's. The three
 * alternatives were each wrong for a reason worth recording:
 *
 *   - the HOST plugin (`host-plugin.ts`): it mounts once for the process and has
 *     no notion of a kernel epoch, so it could not rotate the bridge's capability
 *     identity on a restart, and a connection from a previous kernel would be
 *     accepted as if the namespace had survived.
 *   - the `ipython` TOOL: its lifetime is one cell, so a bridge minted there
 *     would be constructed halfway through the tool body -- the "ad hoc
 *     construction" V3 §J2 forbids -- and a Session whose first cell failed would
 *     have no bridge at all.
 *   - a process-global singleton: it would serve every Session from one
 *     capability, which is the cross-Session authority leak the authority rule in
 *     `bridge.ts` exists to prevent.
 *
 * ONE BRIDGE ENDPOINT PER LIVE KERNEL EPOCH. Not one per cell, not one per
 * process. The kernel record below therefore carries the bridge and its leases
 * alongside the process handles, so the whole capability is created, rotated and
 * disposed as ONE thing.
 *
 * THE CREATION TRANSACTION, IN THIS ORDER, WITH `READY` PUBLISHED LAST:
 *
 *   1. allocate the new kernel epoch;
 *   2. construct and start the BridgeServer;
 *   3. establish the endpoint, the per-kernel secret, and the protocol version;
 *   4. start the broker and the kernel;
 *   5. handshake;
 *   6. publish READY -- and only after every required component succeeded.
 *
 * A failure at any step disposes the bridge, terminates and awaits the owned
 * process range, and does NOT publish READY. There is no arm in which a kernel is
 * reported ready while its bridge is missing, because that is precisely the F2
 * defect: a mechanism that exists while the product's own health report says
 * nothing about whether it is wired.
 */
import type { Context } from '@deepseek-ai/cordis'
import { Service } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ToolExecutionToken } from '@deepseek-ai/dsh-tools'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash, randomUUID } from 'node:crypto'
import {
  DEFAULT_CELL_TIMEOUT_MS,
  DEFAULT_INTERRUPT_GRACE_MS,
  DEFAULT_OUTPUT_CAP_BYTES,
  KernelBindError,
  KernelHost,
  KernelTransportError,
  type KernelIdentity,
} from './kernel.ts'
import {
  BRIDGE_PROTOCOL_VERSION,
  BridgeLedgerWriteError,
  BridgeServer,
  bridgeClientDigest,
  canPrependPreamble,
  type BridgeEndpoint,
  type CellLease,
  type DataCallHandler,
  type LeaseCallDisposition,
} from './bridge.ts'
import { createNativeCallHandler, type EnclosingAuthority } from './native-call.ts'
import {
  MemoryBridgeLedger,
  openBridgeLedger,
  storageFacilityOf,
  type BridgeCloseReason,
  type BridgeLedger,
} from './bridge-ledger.ts'
import { DSH_BACKGROUND_ORIGIN, type CellResult, type KernelStatus, type LateOutput } from './protocol.ts'
import {
  LateNoticeQueue,
  type LateNotice,
  type LateNoticeAccount,
  type LateNoticeBounds,
} from './late-notice.ts'
import {
  defaultKernelRoot as runtimeDefaultKernelRoot,
  interpreterPathProblem,
  jupyterRuntimeDir,
  pythonConfigurationInstruction,
  resolveRuntimeDshHome,
  sessionScratchKey,
} from './runtime-root.ts'

/**
 * This package's own root directory, derived from the module's location.
 *
 * WHY THIS EXISTS. `cordis.patch.yml` named `brokerScript` and `root` as absolute
 * paths into one developer's checkout (`D:/DSH/work/dsh-native-daily/...`), while
 * this package's own comment claimed the broker was "resolved relative to the
 * package root so a relocated checkout still finds it". The comment described a
 * property the code did not have, and the gap is measurable: a SECOND checkout of
 * this repository -- a git worktree, which the multi-agent discipline requires --
 * boots with its own profile and its own built `lib/`, yet its kernel ran the
 * FIRST checkout's `broker.py`, because the patch travels with the package and
 * carried the other tree's absolute path. An experiment in a worktree would then
 * measure the main tree's Python: the stale-artifact trap (G-SEAM-29/36) in a new
 * costume, and the reason this was found at all is that the first worktree
 * provisioned for this round failed its own "does the boot name THIS tree" check.
 *
 * WHY ONE `..` IS CORRECT FOR BOTH LAYOUTS. The compiled entry is
 * `<pkg>/lib/x.js` and the source entry is `<pkg>/src/x.ts`, so the package root is
 * one level above either. No build-time substitution is needed, and `process.cwd()`
 * is deliberately NOT used: it is the launcher's directory, not this package's.
 */
const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

/** The broker script shipped inside this package. Python is never compiled, so it stays in `src/`. */
export const DEFAULT_BROKER_SCRIPT = join(PACKAGE_ROOT, 'src', 'broker.py')

/**
 * The environment manifest V5 §11.2 requires, and the ONLY input to the
 * environment digest.
 *
 * WHY A MANIFEST AND NOT A PATH STRING. The digest this replaces was
 * `sha256(pythonExecutable + platform + arch)`, truncated to 16 hex chars: a hash
 * of a PATH. Every one of the changes V5 §18's `ENV-DIGEST` case is about -- a
 * patch bump of Python, an IPython major upgrade, a different `ipykernel`, a
 * changed `broker.py` -- leaves that path string byte-identical, so the digest did
 * not move and a kernel whose namespace was built against the old environment was
 * served as if it were the same environment. Measured before the change:
 * `qualification/results/P11-env/before-weak-digest.json` shows the old digest
 * constant across a REAL `broker.py` content change whose own sha256 moved.
 *
 * WHY THE LOCAL FILES ARE IN HERE. The four package versions bind the INSTALLED
 * distribution; they cannot see the code this repository ships. `broker.py` is
 * the file the configured interpreter actually executes (`argv = [pythonExecutable,
 * brokerScript]` in `kernel.ts`), and the bridge client is injected into every
 * kernel namespace, so a change to either is a real environment change that a
 * package-version-only manifest would miss. Hashing them is what makes the
 * identity bind the CODE rather than only the path.
 *
 * EVERY FIELD IS A STRING OR NULL, AND NULL IS MEANINGFUL. A field that could not
 * be established is `null`, never omitted and never a placeholder: `null` says
 * "this was asked and could not be answered", which is a different fact from
 * "this was answered", and both are visible in the digest input.
 */
export interface EnvironmentManifest {
  /** `os.path.realpath(sys.executable)`, as the INTERPRETER reports it, not as configured. */
  readonly sys_executable_realpath: string | null
  /** `platform.python_implementation()`. */
  readonly python_implementation: string | null
  /** `platform.python_version()`. */
  readonly python_version: string | null
  /** The `ipython` distribution version. */
  readonly ipython: string | null
  /** The `ipykernel` distribution version. */
  readonly ipykernel: string | null
  /** The `jupyter_client` distribution version. */
  readonly jupyter_client: string | null
  /** The `pyzmq` distribution version. */
  readonly pyzmq: string | null
  /** sha256 of the broker script the host will spawn. LOCAL FILE. */
  readonly broker_sha256: string | null
  /** sha256 of the bridge Python client injected into the kernel. LOCAL FILE. */
  readonly bridge_python_client_sha256: string | null
  /**
   * sha256 of the `dsh.data` Python client, when the host can name it. LOCAL FILE.
   *
   * The file lives in `dsh-daily-work`, which this package does not depend on and
   * must not import: a kernel service that required the data plane in order to
   * compute its own identity would make the data plane a boot prerequisite of
   * every cell. So the path is HOST-SUPPLIED (see
   * {@link KernelServiceConfig.dataClientScript}) and this field is `null` when no
   * host supplies one. `null` is the honest value; inventing a path this package
   * guessed would put a fabricated fact into an identity.
   */
  readonly data_client_sha256: string | null
}

/**
 * How long the environment probe may take before the host refuses to activate.
 *
 * BOUNDED, AND THE BOUND IS THE POINT. The probe runs on the activation path, so a
 * probe that could hang would block every cell behind it. Measured cost of the
 * metadata-only probe on this host: 0.136 s wall. 10 s is ~70x that, which leaves
 * room for a cold filesystem and a slow antivirus scan while still failing inside
 * a user's patience.
 *
 * ON TIMEOUT THE HOST FAILS LOUD. There is no partial-manifest arm and no
 * fallback to the path-string digest: digesting a partial manifest would produce
 * an identity that is stable, plausible, and WRONG, and the entire defect being
 * fixed is an identity that cannot see a real change. A probe that cannot answer
 * is an environment this host cannot identify, which is a refusal, not a default.
 */
export const DEFAULT_ENV_PROBE_TIMEOUT_MS = 10_000

/**
 * The probe, as the interpreter receives it.
 *
 * WHY `importlib.metadata` AND NOT `import ipykernel`. Importing `ipykernel` costs
 * ~0.5 s and pulls in zmq, tornado and IPython; `importlib.metadata.version` reads
 * the distribution's own metadata and costs nothing. More importantly, a probe
 * that IMPORTED the packages could not report them missing -- the import failure
 * would take the probe down and the host would learn "the probe crashed" instead
 * of "ipykernel is not installed", which are different facts with different fixes.
 *
 * WHY EVERY FIELD IS INDIVIDUALLY GUARDED. One unreadable distribution must not
 * erase the other five facts. A field that cannot be established becomes `null`
 * and stays `null` in the digest input, so "unknown" is a recorded value rather
 * than a missing key.
 *
 * WHY IT PRINTS ONE LINE OF SORTED JSON. The host parses a single value and never
 * has to reason about ordering; `sort_keys=True` makes the text itself
 * deterministic, so two runs in the same environment produce identical bytes.
 */
const ENVIRONMENT_PROBE_SOURCE = [
  'import json, os, platform, sys',
  'from importlib.metadata import version as _dist_version',
  'def _dist(name):',
  '    try:',
  '        return _dist_version(name)',
  '    except Exception:',
  '        return None',
  'def _call(fn):',
  '    try:',
  '        return fn()',
  '    except Exception:',
  '        return None',
  'executable = _call(lambda: os.path.realpath(sys.executable)) if sys.executable else None',
  'manifest = {',
  '    "sys_executable_realpath": executable or None,',
  '    "python_implementation": _call(platform.python_implementation),',
  '    "python_version": _call(platform.python_version),',
  '    "ipython": _dist("ipython"),',
  '    "ipykernel": _dist("ipykernel"),',
  '    "jupyter_client": _dist("jupyter_client"),',
  '    "pyzmq": _dist("pyzmq"),',
  '}',
  'print(json.dumps(manifest, sort_keys=True))',
].join('\n')

/** The manifest keys, in one place so the parser and the type cannot drift. */
const ENVIRONMENT_MANIFEST_KEYS = [
  'sys_executable_realpath',
  'python_implementation',
  'python_version',
  'ipython',
  'ipykernel',
  'jupyter_client',
  'pyzmq',
] as const

/**
 * Canonical JSON for the manifest: keys sorted, no insignificant whitespace.
 *
 * V5 §11.2 says "Canonical JSON hash = environmentDigest", and canonicality is
 * load-bearing rather than stylistic: the digest is compared for EQUALITY across
 * processes, so two hosts that computed the same manifest must produce the same
 * bytes. A serializer that emitted keys in insertion order would make the digest
 * depend on the order this file happens to list its fields.
 *
 * Every value is a string or null, so no nested structure has to be canonicalized
 * and no number formatting question arises. The key list is sorted explicitly
 * rather than trusted to be sorted in the source.
 */
function canonicalManifestJson(manifest: EnvironmentManifest): string {
  const entries = Object.entries(manifest).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
  return `{${entries.map(([key, value]) => `${JSON.stringify(key)}:${JSON.stringify(value)}`).join(',')}}`
}

/**
 * sha256 of a file's bytes, or `null` when it cannot be read.
 *
 * NULL RATHER THAN A THROW, because the two failures are different and only one of
 * them is fatal. A missing `broker.py` is fatal (the kernel cannot start at all)
 * and the start will fail loudly on its own; a missing OPTIONAL client is a fact
 * to record. Returning `null` for both lets the caller decide, and keeps the
 * distinction visible in the manifest instead of collapsing it into an exception.
 */
function fileDigestOrNull(path: string | undefined): string | null {
  if (path === undefined || path === '') return null
  try {
    return createHash('sha256').update(readFileSync(path)).digest('hex')
  } catch {
    return null
  }
}

/** Largest probe stdout/stderr the host retains. A probe needing more is not a probe. */
const ENVIRONMENT_PROBE_OUTPUT_CAP_BYTES = 256 * 1024

/** How long the probe process is given to die after termination is requested. */
const PROBE_TERMINATION_GRACE_MS = 5_000

/**
 * Parse the probe's stdout into a manifest, or explain why it is not one.
 *
 * WHY A THROW AND NOT A BEST-EFFORT PARSE. A probe that printed nothing, printed
 * two lines, or printed a JSON object missing a key has NOT established the
 * environment. Returning a manifest with `null`s in it would make an unreadable
 * probe indistinguishable from an interpreter with no `ipykernel` installed, and
 * the host would digest a value that describes neither. So the output must be
 * exactly one line of JSON carrying every key.
 *
 * A NULL VALUE IS ACCEPTED AND KEPT. `{"ipykernel": null}` means the probe ran and
 * could not read that distribution; that is a real, recorded fact about the
 * environment and it belongs in the digest. A MISSING key is different: it means
 * the probe did not answer the question at all.
 */
function manifestFromProbeOutput(
  stdout: string,
  diagnostics: { truncated: boolean, stderr: string },
): EnvironmentManifest {
  if (diagnostics.truncated) {
    throw new KernelTransportError(
      `the environment probe wrote more than ${String(ENVIRONMENT_PROBE_OUTPUT_CAP_BYTES)} bytes to stdout; `
      + 'its output is not a manifest and the environment cannot be identified',
    )
  }
  const lines = stdout.split(/\r?\n/u).filter(line => line.trim() !== '')
  if (lines.length !== 1) {
    throw new KernelTransportError(
      `the environment probe printed ${String(lines.length)} non-empty lines; exactly one JSON object is required. `
      + `${diagnostics.stderr.trim() === '' ? '' : `stderr: ${diagnostics.stderr.trim().slice(-500)}`}`,
    )
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(lines[0] ?? '')
  } catch (error) {
    throw new KernelTransportError(`the environment probe's output is not JSON: ${String(error)}`)
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new KernelTransportError('the environment probe did not print a JSON object')
  }
  const record = parsed as Record<string, unknown>
  const values: Record<string, string | null> = {}
  for (const key of ENVIRONMENT_MANIFEST_KEYS) {
    if (!(key in record)) {
      throw new KernelTransportError(
        `the environment probe's manifest is missing ${key}; a manifest that did not answer every question `
        + 'cannot identify an environment',
      )
    }
    const value = record[key]
    if (value !== null && typeof value !== 'string') {
      throw new KernelTransportError(`the environment probe's ${key} is neither a string nor null`)
    }
    values[key] = value
  }
  // Written out field by field rather than spread from `values`, so a key renamed
  // in one place and not the other is a COMPILE error instead of a silently
  // dropped input. The three local-file fields are attached by the caller from
  // paths the HOST owns; the probe cannot know them and must not be asked to guess.
  return {
    sys_executable_realpath: values['sys_executable_realpath'] ?? null,
    python_implementation: values['python_implementation'] ?? null,
    python_version: values['python_version'] ?? null,
    ipython: values['ipython'] ?? null,
    ipykernel: values['ipykernel'] ?? null,
    jupyter_client: values['jupyter_client'] ?? null,
    pyzmq: values['pyzmq'] ?? null,
    broker_sha256: null,
    bridge_python_client_sha256: null,
    data_client_sha256: null,
  }
}

/**
 * Default kernel scratch root: `$DSH_HOME/runtime/ipython`, NOT the package.
 *
 * WHY THIS MOVED (V5 §11.4 / finding O). It used to be
 * `join(PACKAGE_ROOT, '.ipython-kernels')`, and the reasoning recorded here for
 * that was that "a second checkout gets its own kernels instead of sharing the
 * first one's". That property is real, but it was bought with two worse ones:
 * runtime state inside an INSTALLED package, which may be read-only, and inside a
 * SOURCE checkout, which must not accumulate untracked files. MEASURED, by
 * running one real cell and walking the tree: nine new entries under
 * `packages/dsh-ipython/` and none under `$DSH_HOME`
 * (`qualification/results/P12-runtime/before-default-root.json`).
 *
 * The per-checkout separation is now provided by `$DSH_HOME` instead, which is
 * the boundary that actually isolates deployments -- every writer, every
 * profile install and every real user already has a distinct one. A second
 * checkout that shares one `$DSH_HOME` is not two deployments; it is one
 * deployment whose code was recompiled, and sharing scratch is correct there.
 *
 * A host that wants scratch elsewhere (a temp volume, a shared scratch disk)
 * still sets `root` explicitly; this is only the default.
 *
 * This is a GETTER rather than a constant because `$DSH_HOME` is read at CALL
 * time: a constant would capture whatever the environment held when the module
 * was first imported, and a test or a host that sets `DSH_HOME` after import
 * would silently get the old value. `DEFAULT_KERNEL_ROOT` remains exported for
 * readers that want the value, and it is now documented as a snapshot.
 */
export function defaultKernelRoot(): string {
  return runtimeDefaultKernelRoot()
}

/**
 * The default kernel root, as a value.
 *
 * Kept exported because callers outside this package read it (the runtime-location
 * probe does, and a host that logs its scratch location should). Prefer
 * {@link defaultKernelRoot} in code that runs after the environment can change.
 */
export const DEFAULT_KERNEL_ROOT = defaultKernelRoot()

/** Configuration. Every bound is host-set; none of it is model-reachable. */
export interface KernelServiceConfig {
  /** Python interpreter that has jupyter_client and ipykernel. */
  readonly pythonExecutable: string
  /**
   * Absolute path to `broker.py`. OPTIONAL: omitted, the package's own shipped
   * broker is used (`DEFAULT_BROKER_SCRIPT`).
   *
   * It is optional because a path in a profile patch is a path in ONE checkout.
   * This package is installed by `link:` into a profile, so the patch file is
   * shared by every checkout that installs it, and an absolute path there silently
   * redirects a second checkout's kernel at the first checkout's Python. Leaving
   * it unset is the correct configuration for a normal deployment; a host that
   * ships a vendored broker elsewhere may still override it.
   */
  readonly brokerScript?: string
  /** Directory for per-session kernel working directories. Defaults to the package's own `.ipython-kernels`. */
  readonly root?: string
  /** Execution world label; part of the kernel identity. */
  readonly executionWorld?: string
  /** Environment digest; part of the kernel identity. Changing it invalidates every kernel. */
  readonly environmentDigest?: string
  /**
   * Absolute path to the `dsh.data` Python client, when the host has one.
   *
   * OPTIONAL, and its absence is recorded as `data_client_sha256: null` rather
   * than defaulted. The client belongs to `dsh-daily-work`; this package must not
   * import that package to identify itself, so the host that owns both names the
   * path here. A host with no data plane leaves it unset and gets the honest
   * `null`, not a guess.
   */
  readonly dataClientScript?: string
  /**
   * How long the environment probe may run before activation is refused.
   *
   * Defaults to {@link DEFAULT_ENV_PROBE_TIMEOUT_MS}. Exposed because a host on a
   * cold or instrumented filesystem may legitimately need longer, and because a
   * test needs to force the timeout arm without waiting 10 s.
   */
  readonly environmentProbeTimeoutMs?: number
  /**
   * How to build the environment manifest, when the host wants to control it.
   *
   * OMITTED, the host runs the bounded Python probe. A host that sets this takes
   * over the whole manifest -- including the local-file hashes -- and is
   * responsible for it being real. It exists because a composition-tier probe or
   * a test may need a deterministic manifest without paying for a probe, and
   * because an injected digest computed by a fake would be a fabricated identity.
   */
  readonly environmentManifest?: () => Promise<EnvironmentManifest>
  /** Per-cell output cap in bytes. */
  readonly outputCapBytes?: number
  /** Per-cell wall clock budget. */
  readonly cellTimeoutMs?: number
  /** How long an interrupt may take to settle before the outcome is `unknown`. */
  readonly interruptGraceMs?: number
  /**
   * Largest canonical tool value delivered INLINE to a cell, in bytes.
   *
   * At or above this the exact result is written once, by the host, and Python
   * receives a locator with paging helpers instead. There is NO silent
   * truncation arm: a value that cannot be delivered either way is an error the
   * cell sees. See `bridge.ts`'s `deliver` and `PYTHON_CLIENT_SOURCE`'s
   * `Artifact`.
   */
  readonly inlineValueBytes?: number
  /**
   * Whether to record the bridge ledger in the DSH storage domain when one is
   * mounted. Default true.
   *
   * A host that turns this off still gets the in-memory ledger, so the
   * dispositions are still reported; what it gives up is the durable record
   * across a process restart. Stated as a knob rather than hardwired because a
   * minimal test host has no storage facility, and refusing to bridge for want of
   * a ledger would turn a provenance gap into a capability outage.
   */
  readonly durableLedger?: boolean
  /**
   * How a successful exact result carrying an image reaches the model.
   *
   * `defer` (the default) is PTC parity: the image is ferried through the outer
   * `ipython` result as a user message, exactly as `ptc.ts` does for a nested
   * `run_code` sub-call. `reference` keeps it out of model context and reports it
   * through {@link CellAuthority.onImageRetained} instead. Neither arm drops it.
   */
  readonly imageProjection?: 'defer' | 'reference'
  /**
   * The host handoff for exact calls that had NOT started when their cell closed.
   *
   * ABSENT MEANS REFUSED. With no handoff, such a call is recorded
   * `abandoned-unstarted`, which is the truthful account; a fabricated
   * `handed-to-jobs` would name a job that does not exist. A deployment with a
   * Jobs service sets this to a function that starts the job and returns its id,
   * which is the same shape `programmatic-scope.ts` uses.
   */
  readonly jobHandoff?: (call: { subCallId: string, name: string, args: unknown }) => { jobId: string } | undefined
  /** Host-owned disposition sink, so the host's own log records the drain too. */
  readonly onLeaseDisposition?: (disposition: LeaseCallDisposition) => void
  /**
   * Bounds on the per-Session late-output notice queue (G-SEAM-78).
   *
   * Host policy, like every other bound in this config: the model has no path
   * that reaches this object, and a tool that let the model raise its own notice
   * budget would not be a budget. Defaults are in `late-notice.ts`.
   */
  readonly lateNoticeBounds?: LateNoticeBounds
}

/**
 * The authority one cell's bridge calls run under.
 *
 * BUILT BY THE CALLER FROM THE LIVE `ipython` ToolRunContext, never by a program.
 * `token` is the reason this cannot be forged: only the registry can mint a
 * `ToolExecutionToken`, so a value of this type that names a different execution
 * cannot be constructed outside the registry's own pipeline.
 *
 * A caller that has no live `ipython` execution (an internal probe, a test that
 * drives `runCell` directly) supplies no authority at all and gets a cell with no
 * bridge, which is the honest outcome. Inventing one here would give an unowned
 * cell the ability to call tools as somebody else.
 */
export interface CellAuthority {
  /** The outer `ipython` execution's own call id. Becomes the subcall-id prefix. */
  readonly callId: string
  /** The outer execution's root call id, propagated for correlation. */
  readonly rootCallId: string
  /** The outer execution's opaque token, stamped as every sub-dispatch's `parent`. */
  readonly token: ToolExecutionToken
  /** The exact Agent the outer call runs as. */
  readonly agent: Agent | undefined
  /** A host-chosen cell id, unique within the kernel epoch. */
  readonly cellId: string
  /** Attach a context to the outer execution's own result. */
  readonly onContext?: (context: unknown) => void
  /** Mark the outer execution's successful result as terminal for the turn. */
  readonly onConcludeTurn?: () => void
  /** Record an image-bearing result that was NOT put into model context. */
  readonly onImageRetained?: (record: { callId: string, blockTypes: readonly string[], bytes: number }) => void
}

/**
 * The environment identity as a status surface.
 *
 * `configuredByHost: true` means the host declared the digest itself and NO probe
 * ran, so `manifest` is undefined and the digest describes nothing this package
 * measured. That distinction is carried structurally because a reader that saw
 * only a digest could not tell a probed identity from a declared one, and those
 * are different claims.
 */
export interface EnvironmentStatus {
  readonly digest: string
  readonly configuredByHost: boolean
  readonly manifest: EnvironmentManifest | undefined
}

/**
 * Output that belonged to no live cell, kept per Session so it cannot cross.
 *
 * SUPERSEDED BY {@link LateNoticeQueue} AS THE DELIVERY PATH, and retained
 * because it is the record the classification gates assert against and removing
 * it would silently change what those gates measure. The difference is the
 * question each answers: this one answers "what did the kernel write after its
 * cell settled", while a `LateNotice` answers "what has the model not been told
 * yet", carrying the session id, the stream, the causal class and a timestamp
 * that the delivery record needs.
 */
export interface UnattributedOutput extends LateOutput {
  readonly epoch: number
}

/**
 * The `dsh.data` plane as THIS package needs it (V5 §5.1).
 *
 * A STRUCTURAL type, not an import. `dsh-daily-work` is a sibling package that
 * does not resolve from this one's realpath (MEASURED: `MODULE_NOT_FOUND`), so
 * importing the real `DataPlaneService` type would reintroduce at COMPILE time
 * the very dependency that cannot be satisfied at runtime. The two members below
 * are exactly what this file calls; `DataPlaneService.routeData` satisfies them.
 *
 * The same reasoning as `EnclosingDataAuthority` in `data-bridge.ts`, which is
 * structural for the mirror-image reason: the plane must stay loadable without a
 * kernel, and this package must stay loadable without a plane.
 */
interface DataPlaneLike {
  routeData(
    tool: string,
    rawArguments: unknown,
    enclosing: {
      readonly sessionId: string
      readonly cwd?: string
      readonly signal?: AbortSignal
      readonly callLabel?: string
    },
  ): Promise<{ readonly ok: boolean, readonly value?: unknown, readonly error?: { readonly code: string, readonly message: string } }>
  /**
   * Absolute path of the Python `dsh.data` client this plane's package ships.
   *
   * Published by the OWNER of the file, because this package cannot resolve the
   * sibling specifier to find it. See `DataPlaneService.dataClientPath`.
   */
  dataClientPath(): string
}

/**
 * The per-kernel-epoch bridge capability: everything V3 §J2 requires the kernel
 * record to carry.
 *
 * ONE of these exists per live kernel epoch, and it is created, rotated and
 * disposed with the kernel rather than alongside it. `endpoint` and
 * `protocolVersion` are recorded as values, not recomputed, so a reader can see
 * which capability a kernel epoch actually had rather than which one the current
 * code would mint.
 */
export interface BridgeCapability {
  /** The loopback listener this epoch's cells connect to. */
  readonly server: BridgeServer
  readonly endpoint: BridgeEndpoint
  readonly protocolVersion: number
  /** Where oversized exact results for this epoch are retained. */
  readonly artifactDirectory: string
  /** The leases minted against this epoch and not yet released. */
  readonly leases: Set<CellLease>
}

/**
 * The kernel record, as V3 §J2 names it.
 *
 * A Session's kernel and its bridge capability share ONE lifetime, so they are
 * recorded together: a reader that finds a kernel here can rely on the bridge
 * fields being present, and a disposal that clears this record has disposed of
 * both.
 */
export interface KernelRecord {
  readonly sessionId: string
  /** The kernel generation. A restart allocates a NEW epoch and a NEW bridge capability. */
  readonly kernelEpoch: () => number
  /** The bridge capability for this epoch, once the creation transaction published READY. */
  readonly bridge: BridgeCapability
  /** Lifecycle state, so a caller can tell READY from CREATING without inferring it. */
  readonly lifecycle: () => KernelLifecycleState
  /** The broker process handle, for a reader that wants the owned process range. */
  readonly brokerProcess: () => string
}

/**
 * The kernel's lifecycle state.
 *
 * `CREATING` is a real state and not an implementation detail: V3 §J2 requires
 * READY to be published only after every required component succeeds, and a
 * state that did not distinguish "still being created" from "ready" would make
 * that ordering unobservable.
 */
export type KernelLifecycleState = 'CREATING' | 'READY' | 'DISPOSING' | 'DISPOSED'

interface Entry {
  readonly host: KernelHost
  readonly identity: KernelIdentity
  /**
   * The bridge capability for THIS entry's kernel epoch.
   *
   * Created by the creation transaction in {@link KernelService.entryFor}. Set
   * only after `start()` and the handshake succeeded, so an entry that exists is
   * an entry whose bridge is real -- which is what makes the READY gate in
   * `runCell` meaningful rather than decorative.
   */
  readonly bridge: BridgeCapability
  /** The ledger every lease on this entry records to. */
  readonly ledger: BridgeLedger
  /** Whether `ledger` is the durable storage-domain ledger or the in-memory one. */
  readonly ledgerDurable: boolean
  lifecycle: KernelLifecycleState
  /** Set once the kernel has been observed dead or reset; reported on the next call. */
  pendingGenerationNotice: string | undefined
  readonly unattributed: UnattributedOutput[]
  /**
   * THE DELIVERY QUEUE (G-SEAM-78). ONE per Session, created and destroyed with
   * the kernel, exactly like `unattributed` above and for the same reason: a
   * notice is about THIS Session's kernel epoch, and a queue that outlived its
   * kernel would let a later generation deliver a dead one's output.
   */
  readonly lateNotices: LateNoticeQueue
  /**
   * Bridge-ledger writes that FAILED for this Session.
   *
   * Kept because a close that could not record its dispositions is exactly the
   * "continues with no record" outcome BR-07's oracle forbids, and a reader must
   * be able to ask rather than infer it from a healthy-looking CLOSED state. Empty
   * is the healthy value.
   */
  readonly ledgerFailures: BridgeLedgerWriteError[]
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    ipython: KernelService
  }
}

/**
 * Attach a hidden control request's generation notice to the user's cell result.
 *
 * WHY THIS EXISTS. A generation change is reported by the broker ON THE REQUEST
 * THAT OBSERVED IT (`broker.py:1080`, `:1105`), because that is the request whose
 * answer would otherwise be a lie about which kernel it came from. Since V5 §9
 * the host sends TWO requests per cell -- a hidden bind and then the user's own --
 * so when the kernel died between cells it is the BIND that observes the new
 * epoch, and the user's cell that follows runs cleanly against the replacement.
 *
 * Returning the user's result alone would therefore DROP the notice and tell the
 * model nothing about the lost namespace, which is precisely the defect IPY-14
 * exists to catch. It is MEASURED, not hypothesised: without this helper that arm
 * failed with `expected undefined to be defined` at
 * `v3-spec-gates.test.ts:1064`.
 *
 * THE USER'S RESULT WINS WHERE BOTH CARRY ONE. A control request cannot itself
 * be the interesting generation event when the user's cell also reports one, and
 * the user's cell is the request the model actually asked about. The control
 * notice is used only when the user's cell has none.
 */
function carryGeneration(control: CellResult, user: CellResult): CellResult {
  if (user.generation !== undefined || control.generation === undefined) return user
  return { ...user, generation: control.generation }
}

/**
 * Owns one kernel per Session.
 *
 * The Session is the authorization subject (architecture section 10: "host以
 * Session/kernel作为最小授权主体"), so the map is keyed by Session id, and an
 * Agent that is not the live one for that Session is refused rather than
 * silently given the namespace.
 */
export class KernelService extends Service {
  /**
   * The registry this service's bridge dispatches through.
   *
   * DECLARED ON THE CLASS, not only on the plugin module, and this is a MEASURED
   * requirement rather than a style choice. Cordis refuses a bare `ctx.tools`
   * read from a context that did not inject it:
   *
   *     BridgeError: BRIDGE_FAILED: cannot get property "tools" without inject
   *
   * THE SERVICE'S CONTEXT IS NOT THE PLUGIN FUNCTION'S CONTEXT. The module-level
   * `inject` in `host-plugin.ts` gates when `apply` runs and injects into the
   * context `apply` receives; `this.ctx` inside the service is a DIFFERENT
   * context, and a `ctx.tools.execute(...)` reached from there throws. The unit
   * tests did not catch it because they hand the service the TEST's context,
   * which had mounted `ToolRuntime` directly -- so the mechanism worked in every
   * test and the PRODUCT failed on the first real cell.
   *
   * That is the same defect shape as F2 itself, one layer down, and the same one
   * `ProgrammaticScopeService` documents for its own `inject`. It was found by
   * the composition-tier probe (`qualification/runners/r5-bridge-product.mjs`),
   * which is the only instrument here that runs the bridge out of a real boot's
   * own service context. The measurement is archived at
   * `qualification/results/R5-bridge/composition-tier.json`.
   */
  static readonly inject = ['tools']

  private readonly entries = new Map<string, Entry>()

  constructor(ctx: Context, config: KernelServiceConfig) {
    super(ctx, 'ipython')
    this.config = config
  }

  private config: KernelServiceConfig

  /**
   * The resolved manifest, cached for the process.
   *
   * WHY MEMOIZED. V5 §11.2 puts the probe at host ACTIVATION, and the identity it
   * feeds must be stable for a Session's lifetime -- `entryFor` compares the
   * identity a kernel was built with against the one the current configuration
   * produces, so a digest that changed between two calls in one process would
   * refuse a healthy kernel. Cleared by {@link KernelService.reconfigure}, which
   * is the documented way a host changes the interpreter.
   */
  private resolvedManifest: EnvironmentManifest | undefined
  /** The in-flight probe, so two concurrent first calls run ONE probe rather than two. */
  private manifestPromise: Promise<EnvironmentManifest> | undefined

  /**
   * Replace the configuration. A HOST operation; never model-reachable.
   *
   * It exists because the host can legitimately change the execution world or the
   * environment digest (a profile reload, a Python that moved). The identity
   * check in `entryFor` compares the identity a kernel was BUILT with against the
   * one the current configuration produces, so after this call any kernel whose
   * identity no longer matches is refused rather than served. Without a way to
   * change the configuration that check would be unreachable code, and a test of
   * it would be a test of nothing.
   *
   * THE CACHED MANIFEST IS DISCARDED HERE, and that is not incidental: a host that
   * points the service at a different interpreter and kept the old manifest would
   * have an identity that describes the previous environment. That is the defect
   * this method's own documentation warns about, one layer in.
   */
  reconfigure(config: KernelServiceConfig): void {
    this.config = config
    this.resolvedManifest = undefined
    this.manifestPromise = undefined
  }

  /**
   * Kernel identity for one Session. Stable for the Session's lifetime.
   *
   * ASYNC BECAUSE THE ENVIRONMENT IS NOW MEASURED, NOT ASSUMED. The digest comes
   * from a bounded probe at activation (V5 §11.2), so resolving an identity is
   * I/O the first time it happens and a cached read afterwards. The alternative --
   * hashing a path synchronously -- is exactly the weakness this replaces.
   */
  async identityFor(agent: Agent): Promise<KernelIdentity> {
    const sessionId = agent.session.header.id
    return {
      sessionId,
      executionWorld: this.config.executionWorld ?? 'local',
      environmentDigest: await this.resolveEnvironmentDigest(),
    }
  }

  /**
   * The directory the KERNEL process is started in, i.e. what `os.getcwd()` returns
   * inside a cell.
   *
   * THE SESSION'S PROJECT ROOT, NOT A SCRATCH DIRECTORY. `agent.session.header.cwd`
   * is the Session's own working directory (`SessionHeader.cwd`, the field the ACP
   * bridge and the terminal controller both read). A cell's relative paths must
   * resolve there, because a kernel rooted anywhere else makes `open("out.csv")`
   * silently write where the model will never look -- a correctness bug with no
   * symptom, and the reason IPY-15 exists.
   *
   * The fallbacks are ordered and deliberate. A Session header without a `cwd` is
   * possible (the field is optional in the Session format), so the configured
   * `root` is used rather than an arbitrary directory; that keeps a kernel in a
   * host-owned place instead of inheriting whatever directory the DSH process
   * happened to be launched from. The chosen value is reported back by the broker
   * as `kernelCwd`, so a caller can verify rather than assume.
   */
  private kernelWorkingDirectoryFor(agent: Agent): string {
    const declared = agent.session.header.cwd
    if (declared !== undefined && declared !== '') return declared
    return this.kernelRoot()
  }

  /**
   * The kernel scratch root: the configured one, or `$DSH_HOME/runtime/ipython`.
   *
   * WHY A DEFAULT AND NOT A REQUIRED FIELD. A required field means every profile
   * patch must name an absolute path, and a profile patch is shared by every
   * checkout that installs this package -- so the second checkout inherits the
   * first one's directory. That is not hypothetical: it is why a git worktree's
   * kernel wrote its connection files into the main checkout until this changed.
   *
   * The default is now resolved at CALL time (see `defaultKernelRoot`), so a host
   * or a test that sets `DSH_HOME` after this module is imported still gets the
   * value it set rather than the one captured at import.
   */
  private kernelRoot(): string {
    return this.config.root ?? defaultKernelRoot()
  }

  /**
   * The scratch directory for one Session, at the epoch the kernel was allocated
   * for (V5 §11.4: `$DSH_HOME/runtime/ipython/<session-hash>/<epoch>`).
   *
   * WHY THE SESSION IS HASHED RATHER THAN SANITIZED. `sanitize` is LOSSY --
   * `a/b` and `a\b` both become `a_b` -- so two distinct Sessions could be given
   * one scratch directory and one kernel could read another's connection file.
   * A truncated SHA-256 does not collide, and it stays stable across processes so
   * an orphaned directory is attributable to a Session after a crash.
   *
   * WHAT THE EPOCH COMPONENT DOES AND DOES NOT NAME. It names the ALLOCATION: a
   * kernel created for this Session gets `<epoch>` for the epoch it started at,
   * which is 0 for a fresh kernel. A `restart()` advances the host's epoch but
   * does NOT move these files, because the broker keeps its connection file and
   * ports across `restart_kernel` by design and a running broker has already
   * captured its scratch env. So this component is not a live-generation marker
   * for a restarted kernel, and reading it as one would be wrong.
   */
  private scratchDirectoryFor(sessionId: string, kernelEpoch: number): string {
    return join(this.kernelRoot(), sessionScratchKey(sessionId), String(kernelEpoch))
  }

  /**
   * A digest of the environment, so a kernel built against a different one is not
   * reused as if it were the same.
   *
   * REPLACES `sha256(pythonExecutable + platform + arch).slice(0,16)`. That value
   * was a hash of a PATH STRING and could not move when the thing at that path
   * changed -- a Python patch bump, an IPython major upgrade, a different
   * `ipykernel`, or an edit to `broker.py` all left it byte-identical. Measured
   * before the change: `qualification/results/P11-env/before-weak-digest.json`.
   *
   * THE DIGEST IS NOW THE CANONICAL JSON OF {@link EnvironmentManifest}, which is
   * V5 §11.2's field list, and it is returned IN FULL (64 hex chars).
   *
   * WHY NOT TRUNCATE TO 16. Nothing here requires a short digest, and this is
   * grep-verified rather than assumed: every reader compares it for EQUALITY
   * (`kernel-plugin.ts` `entryFor`, `kernel.ts` `assertIdentity`) and no path,
   * filename, or bounded field is built from it, so truncation bought nothing and
   * spent 192 bits of collision resistance on an identity value. 64 bits is
   * adequate for accidental collisions and is not adequate for a value whose whole
   * purpose is to be a boundary; the longer form costs 48 bytes in a log line.
   *
   * MEMOIZED, BECAUSE THE PROBE IS I/O. V5 §11.2 puts the probe at host
   * activation, so it runs once per service and the result is stable for the
   * process -- which is what makes a kernel's identity stable for a Session's
   * lifetime. {@link KernelService.reconfigure} clears it, because that is the
   * documented way a host changes the interpreter, and a memo that survived it
   * would make the identity check unreachable code.
   *
   * A HOST-CONFIGURED DIGEST WINS AND SKIPS THE PROBE. `config.environmentDigest`
   * predates this change and still means "the host takes responsibility for the
   * identity"; a host that sets it gets no probe and no manifest. That arm is kept
   * because removing it would break a deployment that already declares its own
   * environment, and because a probe that runs when its answer is discarded would
   * be a pure cost.
   */
  private async resolveEnvironmentDigest(): Promise<string> {
    const configured = this.config.environmentDigest
    if (configured !== undefined) return configured
    return createHash('sha256').update(canonicalManifestJson(await this.resolveEnvironmentManifest())).digest('hex')
  }

  /**
   * The environment manifest for this service, resolved once and cached.
   *
   * FAILURES ARE NOT CACHED. A probe that failed is retried on the next call
   * rather than pinning the service into a permanent error: a transient spawn
   * failure (a busy filesystem, an antivirus scan holding the interpreter) must
   * not make the deployment unbootable for the rest of its life.
   */
  private async resolveEnvironmentManifest(): Promise<EnvironmentManifest> {
    if (this.resolvedManifest !== undefined) return this.resolvedManifest
    if (this.manifestPromise === undefined) {
      const injected = this.config.environmentManifest
      this.manifestPromise = injected === undefined
        ? this.runEnvironmentProbe()
        : injected().then(probed => this.manifestWithLocalFiles(probed))
    }
    try {
      const manifest = await this.manifestPromise
      this.resolvedManifest = manifest
      return manifest
    } catch (error) {
      this.manifestPromise = undefined
      throw error
    }
  }

  /**
   * Run the bounded probe and combine it with the LOCAL FILE hashes.
   *
   * THE TIMEOUT IS THE BOUND, AND THERE IS NO PARTIAL ARM. `handle.done` races a
   * timer; on expiry the process is terminated and a `KernelTransportError` is
   * thrown, so activation fails loudly instead of digesting whatever happened to
   * have arrived. Digesting a partial manifest would produce an identity that is
   * stable, plausible and wrong -- which is the defect being fixed, not a
   * mitigation of it.
   */
  private async runEnvironmentProbe(): Promise<EnvironmentManifest> {
    const timeoutMs = this.config.environmentProbeTimeoutMs ?? DEFAULT_ENV_PROBE_TIMEOUT_MS
    // THE SPAWN IS INSIDE THE FAILURE BOUNDARY, and this is not defensive: an
    // interpreter path that is a real file but not an executable makes the
    // provider throw `spawn EFTYPE` synchronously, and a path that does not exist
    // makes it throw `ENOENT`. Both are the SAME fact the probe exists to report --
    // this environment cannot be identified -- so both must arrive as
    // `KernelTransportError` rather than as whatever the provider happens to
    // throw. Measured: without this, the failure arm leaked `Error: spawn EFTYPE`
    // and a caller could not tell an unidentifiable environment from a bug in this
    // package.
    let handle: ReturnType<typeof this.ctx.subprocess.spawn>
    try {
      handle = this.ctx.subprocess.spawn({
        argv: [this.config.pythonExecutable, '-c', ENVIRONMENT_PROBE_SOURCE],
        // An EXISTING directory, and one this package knows: `PACKAGE_ROOT` is the
        // directory this module was loaded from, so it exists by construction. The
        // probe reads no files, so its cwd is not load-bearing; what matters is that
        // it is not the launcher's directory and not a scratch root that may not
        // have been created yet.
        cwd: PACKAGE_ROOT,
        stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
        graceMs: PROBE_TERMINATION_GRACE_MS,
        env: { PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8' },
      })
    } catch (error) {
      throw new KernelTransportError(
        `the environment probe could not be started with ${this.config.pythonExecutable}: ${String(error)}. `
        + 'The environment cannot be identified, so no kernel may be built against it.',
      )
    }

    // Collected with a cap, so an interpreter that floods stdout cannot make the
    // host allocate without bound. A probe that needs more than this is not a
    // probe; the cap is reported rather than silently applied.
    let stdout = ''
    let stderr = ''
    let truncated = false
    const append = (chunk: Buffer, current: string): string => {
      if (current.length >= ENVIRONMENT_PROBE_OUTPUT_CAP_BYTES) {
        truncated = true
        return current
      }
      return current + chunk.toString('utf8')
    }
    handle.stdout?.on('data', (chunk: Buffer) => { stdout = append(chunk, stdout) })
    handle.stderr?.on('data', (chunk: Buffer) => { stderr = append(chunk, stderr) })

    // THE OUTPUT MUST BE DRAINED, NOT MERELY EXITED. `handle.done` settles on the
    // process 'exit' event, and Node can deliver 'exit' while bytes written by the
    // child are still in the pipe buffer -- so awaiting `done` alone is a race that
    // would read a TRUNCATED manifest and, worse, succeed intermittently. Both
    // readable streams are awaited to 'end' (or 'close', for a stream that errors)
    // so the manifest is parsed only after the child's last byte has arrived.
    const streamEnded = (stream: NodeJS.ReadableStream | undefined): Promise<void> =>
      stream === undefined
        ? Promise.resolve()
        : new Promise<void>(resolve => {
          stream.once('end', resolve)
          stream.once('close', resolve)
          stream.once('error', resolve)
        })

    let timer: NodeJS.Timeout | undefined
    try {
      await Promise.race([
        Promise.all([handle.done, streamEnded(handle.stdout), streamEnded(handle.stderr)]),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            reject(new KernelTransportError(
              `the environment probe did not finish within ${String(timeoutMs)} ms; the environment cannot be `
              + `identified, so no kernel may be built against it. The interpreter was ${this.config.pythonExecutable}.`,
            ))
          }, timeoutMs)
          // The host's own exit must not be delayed by a pending probe.
          timer.unref()
        }),
      ])
    } catch (error) {
      handle.terminate()
      await handle.waitForExit().catch(() => false)
      // EVERY failure of the probe is the SAME fact -- this environment cannot be
      // identified -- so it leaves here as one error type. The provider rejects
      // `handle.done` with its own vocabulary (`spawn EFTYPE` for a real file that
      // is not executable, `spawn ENOENT` for a path that is not there, and a plain
      // `Error` for a terminated range), and a caller that had to recognise those
      // would be depending on a provider's internals. Measured: without this, the
      // failure arm surfaced `Error: spawn EFTYPE` and an operator could not tell
      // an unidentifiable environment from a bug in this package.
      if (error instanceof KernelTransportError) throw error
      throw new KernelTransportError(
        `the environment probe could not be run with ${this.config.pythonExecutable}: ${String(error)}. `
        + 'The environment cannot be identified, so no kernel may be built against it.',
      )
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }

    const outcome = await handle.done.catch(() => undefined)
    if (outcome !== undefined && outcome.exitCode !== 0) {
      throw new KernelTransportError(
        `the environment probe exited with code ${String(outcome.exitCode)}`
        + `${stderr.trim() === '' ? '' : `: ${stderr.trim().slice(-500)}`}`,
      )
    }
    return this.manifestWithLocalFiles(manifestFromProbeOutput(stdout, { truncated, stderr }))
  }

  /**
   * Attach the three LOCAL FILE hashes to a manifest.
   *
   * THIS IS THE HALF THAT BINDS THE CODE. The probed fields describe the
   * interpreter and the installed distributions; they cannot see a changed
   * `broker.py` or a changed Python client, because those files are not
   * distributions. They are read here, by the host, from paths the host owns.
   *
   * `dataClientScript` is HOST-SUPPLIED and its absence is recorded as `null`
   * rather than guessed: the `dsh.data` client lives in another package that this
   * one must not import in order to identify itself.
   */
  private manifestWithLocalFiles(probed: EnvironmentManifest): EnvironmentManifest {
    return {
      ...probed,
      broker_sha256: fileDigestOrNull(this.config.brokerScript ?? DEFAULT_BROKER_SCRIPT),
      bridge_python_client_sha256: bridgeClientDigest(),
      data_client_sha256: fileDigestOrNull(this.config.dataClientScript),
    }
  }

  /**
   * The environment identity as a STATUS surface, for a host probe or a doctor.
   *
   * DOES NOT START A KERNEL and does not require one, so asking what environment
   * this host would build a kernel against cannot consume a kernel slot -- the same
   * rule {@link KernelService.status} follows. It returns the MANIFEST as well as
   * the digest, because V5 §14's rule applies here too: an identity must describe
   * the actual build, and a reader that can only see the digest cannot check that
   * any particular input was in it.
   */
  async environmentStatus(): Promise<EnvironmentStatus> {
    const configured = this.config.environmentDigest
    if (configured !== undefined) {
      return { digest: configured, configuredByHost: true, manifest: undefined }
    }
    const manifest = await this.resolveEnvironmentManifest()
    return { digest: await this.resolveEnvironmentDigest(), configuredByHost: false, manifest }
  }

  /**
   * The kernel for one Session, started on first use.
   *
   * THE CREATION TRANSACTION LIVES HERE, and the order below is V3 §J2's. The
   * important property is the LAST step: this entry is inserted into the table --
   * which is what publishes READY, because every reader resolves through that
   * table -- only after the bridge is listening AND the kernel has answered a
   * handshake. Any failure before that point disposes the bridge, terminates and
   * awaits the owned process range, and leaves the table unchanged, so a failed
   * creation cannot be observed as a usable kernel.
   */
  private async entryFor(agent: Agent): Promise<Entry> {
    const identity = await this.identityFor(agent)
    const existing = this.entries.get(identity.sessionId)
    if (existing !== undefined) {
      // The identity is re-checked on every resolve, not only at creation: a
      // configuration change that moved the execution world or the environment
      // must invalidate the kernel instead of letting it serve a namespace built
      // under different authority.
      if (existing.identity.executionWorld !== identity.executionWorld
        || existing.identity.environmentDigest !== identity.environmentDigest) {
        throw new KernelTransportError(
          `kernel for session ${identity.sessionId} was built for execution world ` +
          `${existing.identity.executionWorld}/${existing.identity.environmentDigest} but the current ` +
          `configuration is ${identity.executionWorld}/${identity.environmentDigest}; the kernel must be evicted`,
        )
      }
      return existing
    }

    // ---- THE INTERPRETER GATE, BEFORE ANYTHING IS CREATED ------------------
    // V5 §11.3: a deployment with no usable interpreter must fail LOUD with an
    // exact doctor instruction rather than starting against some other Python.
    // This is checked FIRST, before the scratch tree and the bridge, so a
    // misconfigured interpreter cannot leave a half-built kernel behind and
    // cannot be mistaken for a kernel-startup failure.
    //
    // The message is the SAME STRING the doctor prints
    // (`pythonConfigurationInstruction`), so the instruction and the failure
    // cannot drift apart. A configured path that is blank or relative is refused
    // here rather than passed to `spawn`, where the failure would be an opaque
    // ENOENT at the first cell.
    const interpreter = this.config.pythonExecutable
    const interpreterProblem = interpreterPathProblem(interpreter)
    if (interpreterProblem !== undefined) {
      throw new KernelTransportError(
        `${pythonConfigurationInstruction({ dshHome: resolveRuntimeDshHome() })}\n\n${interpreterProblem}`,
      )
    }

    // The scratch tree is `<root>/<session-hash>/0` for a NEW kernel: epoch 0 is
    // the allocation this creation is making. See `scratchDirectoryFor` for why
    // the epoch is a directory level and what it does NOT mean after a restart.
    const workingDirectory = this.scratchDirectoryFor(identity.sessionId, 0)
    mkdirSync(workingDirectory, { recursive: true })
    // The Jupyter connection file is written by `jupyter_client` through
    // `jupyter_core.paths.jupyter_runtime_dir()`, which is a THIRD location
    // outside both this package and `$DSH_HOME` unless it is pinned. It carries
    // the HMAC key that authorises execution on the kernel's sockets, so it is
    // pinned into this Session's scratch tree (see `runtime-root.ts`).
    mkdirSync(jupyterRuntimeDir(workingDirectory), { recursive: true })
    const kernelWorkingDirectory = this.kernelWorkingDirectoryFor(agent)
    // The kernel's directory is created if absent, so a Session whose project root
    // is new does not fail to start a kernel. A path that cannot be created is a
    // hard error rather than a silent fallback to the scratch directory: falling
    // back is exactly the wrong-directory defect this field exists to prevent.
    mkdirSync(kernelWorkingDirectory, { recursive: true })

    // ---- STEP 2 + 3: construct and start the bridge, establish its identity --
    // The bridge is created BEFORE the kernel process, because a kernel that
    // started against a bridge which then failed to bind would be a live kernel
    // whose cells cannot reach any tool -- F2's own shape, arrived at from the
    // other direction.
    const bridgeDirectory = join(workingDirectory, 'bridge')
    // THE DATA CLIENT'S PATH, from the package that owns the file (V5 §5.3).
    // Resolved HERE, at kernel start, rather than at cell time: a missing client
    // must fail the kernel's creation transaction loudly instead of producing a
    // kernel whose cells silently have no `dsh.data`.
    const dataClientPath = this.dataClientPathFromPlane()
    const bridge = new BridgeServer({
      artifactDirectory: join(bridgeDirectory, 'artifacts'),
      clientDirectory: bridgeDirectory,
      ...this.config.inlineValueBytes === undefined ? {} : { inlineValueBytes: this.config.inlineValueBytes },
      ...dataClientPath === undefined ? {} : { dataClientPath },
    })
    let capability: BridgeCapability
    let host: KernelHost | undefined
    try {
      const startup = await bridge.start()
      capability = {
        server: bridge,
        endpoint: startup.endpoint,
        protocolVersion: BRIDGE_PROTOCOL_VERSION,
        artifactDirectory: join(bridgeDirectory, 'artifacts'),
        leases: new Set(),
      }
      // ---- STEP 4 + 5: start the broker and the kernel, then handshake -------
      // `host.start()` is the handshake: it resolves only after the broker has
      // answered `start` and reported the epoch and transport it achieved.
      const unattributed: UnattributedOutput[] = []
      // G-SEAM-78's delivery queue. Created HERE, alongside `unattributed`, so it
      // shares the kernel's lifetime rather than the Session record's: a notice is
      // about one kernel epoch, and its spill directory is that epoch's own
      // artifact directory, which is disposed with the bridge.
      const lateNotices = new LateNoticeQueue({
        sessionId: identity.sessionId,
        backgroundOrigin: DSH_BACKGROUND_ORIGIN,
        spillDirectory: join(bridgeDirectory, 'artifacts'),
        ...this.config.lateNoticeBounds === undefined ? {} : { bounds: this.config.lateNoticeBounds },
      })
      host = new KernelHost({
        subprocess: this.ctx.subprocess,
        identity,
        brokerScript: this.config.brokerScript ?? DEFAULT_BROKER_SCRIPT,
        pythonExecutable: this.config.pythonExecutable,
        workingDirectory,
        kernelWorkingDirectory,
        outputCapBytes: this.config.outputCapBytes ?? DEFAULT_OUTPUT_CAP_BYTES,
        cellTimeoutMs: this.config.cellTimeoutMs ?? DEFAULT_CELL_TIMEOUT_MS,
        interruptGraceMs: this.config.interruptGraceMs ?? DEFAULT_INTERRUPT_GRACE_MS,
        // Late output is recorded against the ORIGINATING cell id, so it can never
        // be attached to whichever cell happens to run next. The SAME callback
        // feeds the delivery queue: one observation, two readers, so the notice
        // can never describe something the classification gates did not see.
        onLateOutput: output => {
          unattributed.push(output)
          lateNotices.push({
            kernelEpoch: output.epoch,
            cellId: output.cellId,
            stream: output.stream ?? 'unknown',
            text: output.text,
          })
        },
      })
      await host.start()

      // ---- STEP 6: publish READY --------------------------------------------
      // The ledger is opened here too, and it is the LAST thing before the insert
      // for the same reason as the bridge: a Session whose kernel is published
      // must have somewhere to record what its cells did.
      //
      // DURABILITY IS REQUIRED UNLESS IT WAS EXPLICITLY REFUSED (V5 §11.1). The
      // previous version of these lines was
      //
      //     const opened = this.config.durableLedger === false
      //       ? undefined
      //       : await openBridgeLedger(...).catch(() => undefined)
      //     ledger: opened?.ledger ?? new MemoryBridgeLedger(),
      //
      // and it was wrong in a way no test could see. The `.catch` swallowed every
      // failure and the `??` substituted memory, so a deployment that REQUESTED
      // durability silently ran on an in-memory ledger whose records die with the
      // process -- destroying exactly the evidence (`STARTED` with no `SETTLED`)
      // that decides whether an unknown external effect may be retried. The
      // project's standing constraint is that such an effect is NEVER auto-retried,
      // and the ledger is what distinguishes "never happened" from "may have
      // happened"; losing it silently removes the ground that constraint stands on.
      //
      // MEASURED, and it is why this is not merely defensive: the failure was
      // ROUTINE, not hypothetical. `openBridgeLedger` is called once per new
      // Session and the storage domain refuses a name that is already open, so the
      // SECOND kernel published in any process fell into the fallback. Two Sessions
      // in one host is ordinary product use. The one signal that would have made it
      // visible, `ledgerDurable` below, was computed honestly and read by nothing in
      // production -- see `ledgerIsDurable`.
      //
      // `durableLedger: false` remains the EXPLICIT unit/development arm V5 permits
      // and is the only configuration that gets an in-memory ledger. Everything
      // else must open one, and a failure is a capability activation failure: the
      // catch arm below disposes the bridge and the process range and publishes no
      // READY.
      let opened: { ledger: BridgeLedger, durable: boolean } | undefined
      if (this.config.durableLedger === false) {
        opened = undefined
      } else {
        const facility = storageFacilityOf(this.ctx)
        if (facility === undefined) {
          // The facility is ABSENT. A failure of the DEPLOYMENT rather than of the
          // medium: the base bundle mounts the storage row before this service, so
          // no facility means the composition lost it.
          throw new KernelTransportError(
            'the durable bridge ledger was requested but this deployment has no storage facility mounted, '
            + 'so this kernel is refused. Mount the storage domain (the base bundle does), or set '
            + '`durableLedger: false` to accept a non-durable ledger explicitly in a development host.',
          )
        }
        opened = await openBridgeLedger(facility).catch((error: unknown) => {
          throw new KernelTransportError(
            'the durable bridge ledger was requested but could not be opened, so this kernel is refused: '
            + 'a kernel whose cells cannot record what they did cannot establish whether an external effect '
            + 'may have happened, and the retry rule depends on that record. Cause: '
            + `${error instanceof Error ? error.message : String(error)}`,
          )
        })
      }
      const entry: Entry = {
        host,
        identity,
        bridge: capability,
        ledger: opened?.ledger ?? new MemoryBridgeLedger(),
        ledgerDurable: opened?.durable === true,
        lifecycle: 'READY',
        pendingGenerationNotice: undefined,
        unattributed,
        lateNotices,
        ledgerFailures: [],
      }
      this.entries.set(identity.sessionId, entry)
      return entry
    } catch (error) {
      // ---- THE FAILURE ARM: no READY, and nothing left running ---------------
      // Bridge first, then the process range. The bridge is disposed first so no
      // cell can be handed a capability for a kernel that is about to be killed.
      await bridge.close().catch(() => undefined)
      if (host !== undefined) await host.shutdown().catch(() => undefined)
      this.entries.delete(identity.sessionId)
      throw error
    }
  }

  /**
   * Run one cell for one Agent.
   *
   * `signal` is the tool execution's own cancellation. It is observed BEFORE the
   * cell is sent: a cell that has already been dispatched is not abandoned by
   * dropping the promise, because the kernel would keep running it while the
   * model believed it had stopped. Abandoning is done by interrupting, which is
   * a real kernel operation.
   *
   * THIS IS WHERE A CELLLEASE IS MINTED, and it is the reason `runCell` takes an
   * authority rather than only an Agent. A cell is the unit that holds DSH tool
   * authority (V3 §J3), so the lease is created immediately before the cell is
   * dispatched and closed when it settles -- not before, and not after.
   *
   * THE USER'S BYTES ARE NEVER REWRITTEN (V5 §9). The capability bind is a
   * SEPARATE HIDDEN EXECUTION: a `silent` execute_request that runs the bind
   * program, awaited to its own `execute_reply` AND its own `idle`, before the
   * user's cell is sent as its own request carrying exactly the bytes the caller
   * passed. Three measured consequences of the old prepend are gone with it:
   * traceback and SyntaxError line numbers are the user's own lines; a cell magic
   * works identically to ordinary code because it is still the first line of the
   * request that contains it; and the source the kernel records for a cell is the
   * source the model submitted. See `qualification/results/P8-bind/`.
   *
   * IF THE BIND FAILS, THE USER'S CELL DOES NOT RUN. A cell dispatched without a
   * live capability would be a cell whose `dsh` is either absent or STALE, and
   * either one is worse than a refused cell: the failure is reported as the cell's
   * own failure rather than being allowed to look like the user's error.
   *
   * A CALLER WITH NO AUTHORITY GETS A REVOKE, NOT AN OMISSION. The kernel
   * namespace is persistent, so once any bridged cell has run, `dsh` stays in it.
   * An unbridged cell therefore has `dsh` explicitly removed by a hidden control
   * request before it runs, so it cannot reach a capability from an earlier cell.
   * Measured before this existed: an authority-less cell saw `dsh` present with a
   * settled lease id and a call through it returned `LEASE_UNKNOWN` -- refused,
   * but with an error that did not explain that the capability was gone by design.
   */
  async runCell(agent: Agent, code: string, signal?: AbortSignal, authority?: CellAuthority): Promise<CellResult> {
    const entry = await this.entryFor(agent)
    if (signal?.aborted) {
      throw new KernelTransportError('the cell was cancelled before it was sent to the kernel')
    }
    if (authority === undefined) {
      // No bridge for this cell, and the capability is actively revoked rather
      // than merely not re-bound. The revoke is a hidden control request, so it
      // does not enter the input history and cannot itself become the source the
      // kernel records for the user's cell.
      const revoke = await entry.host.execute(entry.bridge.server.revoke(), {
        identity: entry.identity,
        silent: true,
      })
      const result = await entry.host.execute(code, { identity: entry.identity })
      const carried = carryGeneration(revoke, result)
      if (carried.generation !== undefined) entry.pendingGenerationNotice = carried.generation.reason
      return carried
    }

    const lease = this.mintCellLease(entry, authority, signal)
    entry.bridge.leases.add(lease)
    let result: CellResult
    let ledgerFailure: BridgeLedgerWriteError | undefined
    try {
      // PHASE 1 -- THE HIDDEN BIND. Its own request, its own reply, its own idle.
      // `storeHistory: false` keeps the bind out of IPython's input history, so
      // the user's cell is what a later reader finds recorded there.
      const bind = await entry.host.execute(entry.bridge.server.bind(lease), {
        identity: entry.identity,
        silent: true,
        storeHistory: false,
      })
      if (bind.outcome !== 'ok') {
        // THE BIND DID NOT TAKE. The user's code is NOT sent, and the failure is
        // reported as the cell's outcome rather than silently running unbridged.
        // The lease still closes through the same `finally` below, so the
        // capability it minted cannot outlive this refusal.
        throw new KernelBindError(
          `the per-cell bridge bind did not complete (outcome ${bind.outcome}`
          + `${bind.error === undefined ? '' : `: ${bind.error.ename}: ${bind.error.evalue}`}), `
          + 'so the cell was not run',
          bind,
        )
      }
      // PHASE 2 -- THE USER'S EXACT BYTES, as their own request. `storeHistory`
      // is explicitly true so the recorded source is this cell's own source.
      const user = await entry.host.execute(code, { identity: entry.identity, storeHistory: true })
      // THE HIDDEN PHASE MUST NOT SWALLOW A GENERATION NOTICE. The broker reports
      // a generation change ON THE REQUEST THAT OBSERVED IT, and the control
      // request is a request like any other -- so when the kernel died between
      // cells it is the BIND that learns the epoch moved, and the user's cell that
      // follows runs cleanly in the replacement kernel. Reporting only the user's
      // cell would tell the model nothing about the lost namespace.
      // MEASURED: without this, IPY-14 failed with `expected undefined to be
      // defined` -- the notice was consumed by the bind and dropped.
      result = carryGeneration(bind, user)
    } finally {
      // THE CELL SETTLED. Close the lease before returning, so by the time any
      // caller sees this cell's result, every exact call it authorised has
      // reached quiescence and carries a recorded disposition. `close` is the
      // five-step sequence in `bridge.ts`.
      //
      // A FAILED LEDGER WRITE IS NOT SWALLOWED. `close` throws
      // `BridgeLedgerWriteError` when a disposition could not be recorded
      // durably, and that is recorded on the entry so a reader can see the
      // record is INCOMPLETE. It is deliberately NOT rethrown out of `runCell`:
      // the cell's own outcome is a different fact, and replacing it with a
      // ledger error would misreport a successful cell as a failed one. What the
      // caller gets is the cell result PLUS a durable-record gap they can query.
      ledgerFailure = await lease.close('completed', 'the cell settled')
        .then(() => undefined)
        .catch((error: unknown) => error instanceof BridgeLedgerWriteError ? error : undefined)
      if (ledgerFailure !== undefined) entry.ledgerFailures.push(ledgerFailure)
      entry.bridge.leases.delete(lease)
      entry.bridge.server.releaseLease(lease)
    }
    if (result.generation !== undefined) {
      entry.pendingGenerationNotice = result.generation.reason
    }
    return result
  }

  /**
   * Mint the CellLease for one cell.
   *
   * Everything authority-bearing is read from `authority`, which the caller built
   * from the LIVE `ipython` ToolRunContext. Python never supplies any of it: it
   * receives an opaque lease id in the bind request and nothing else.
   *
   * THE CONTROLLER IS MINTED HERE, NOT BY THE LEASE. The signal a close must abort
   * is the one the registry call already holds, and that signal has to exist
   * before the handler is built -- which is before the lease exists, because the
   * handler is a construction input. So the host creates the controller, hands it
   * to the lease to abort at close, and stamps its signal onto every dispatch.
   * One signal, one abort path, no second signal that nothing is listening to.
   */
  private mintCellLease(entry: Entry, authority: CellAuthority, signal: AbortSignal | undefined): CellLease {
    const controller = new AbortController()
    return entry.bridge.server.mintLease({
      sessionId: entry.identity.sessionId,
      cellId: authority.cellId,
      epoch: entry.host.currentEpoch,
      outerCallId: authority.callId,
      rootCallId: authority.rootCallId,
      ledger: entry.ledger,
      controller,
      ...signal === undefined ? {} : { signal },
      ...this.config.jobHandoff === undefined ? {} : { handoffToJobs: this.config.jobHandoff },
      ...this.config.onLeaseDisposition === undefined ? {} : { onDisposition: this.config.onLeaseDisposition },
      handler: createNativeCallHandler({
        ctx: this.ctx,
        authority: {
          callId: authority.callId,
          rootCallId: authority.rootCallId,
          token: authority.token,
          agent: authority.agent,
          // The lease's controller, so a lease close aborts the registry call
          // itself rather than only refusing new ones.
          signal: controller.signal,
        },
        bridge: entry.bridge.server,
        ...authority.onContext === undefined ? {} : { onContext: authority.onContext },
        ...authority.onConcludeTurn === undefined ? {} : { onConcludeTurn: authority.onConcludeTurn },
        ...this.config.imageProjection === undefined ? {} : { imageProjection: this.config.imageProjection },
        ...authority.onImageRetained === undefined ? {} : { onImageRetained: authority.onImageRetained },
      }),
      // THE SECOND INTERNAL DISPATCHER (V5 §5.1). Same frame, same lease, same
      // authority checks -- a different plane.
      dataHandler: this.dataHandlerFor(entry, controller, authority.agent),
    })
  }

  /** The current epoch for one Session, without starting a kernel. */
  currentEpoch(agent: Agent): number {
    const sessionId = agent.session.header.id
    return this.entries.get(sessionId)?.host.currentEpoch ?? 0
  }

  /**
   * The mounted `dsh.data` plane, or undefined when the composition has none.
   *
   * `ctx.get(name)` is the documented inject-free read (`reflect.ts:233-235`) and
   * the same form `history-plane.ts:184` uses for `sessionQuery`. Naming
   * `dailyData` in this package's static `inject` would be wrong: the kernel
   * service is a valid product without a data plane, and a hard dependency would
   * turn "no data plane configured" into "no kernel at all".
   */
  private dataPlane(): DataPlaneLike | undefined {
    return this.ctx.get('dailyData') as DataPlaneLike | undefined
  }

  /**
   * The absolute path of the shipped Python data client, from its owning package.
   *
   * ABSENT WHEN NO PLANE IS MOUNTED, so the preamble installs no `dsh.data`
   * namespace -- consistent with the routing lane refusing `data:*` with
   * `DATA_NO_CAPABILITY`. A path that is reported but whose FILE is missing is
   * refused here rather than at cell time, because a kernel that starts and then
   * silently has no `dsh.data` is the reachability defect this slice exists to
   * close, one layer down.
   */
  private dataClientPathFromPlane(): string | undefined {
    const plane = this.dataPlane()
    if (plane === undefined) return undefined
    const path = plane.dataClientPath()
    if (!existsSync(path)) {
      throw new Error(
        `dsh-ipython: the data plane published its Python client at "${path}", but no such file exists. `
        + 'A kernel started against a missing client would silently have no dsh.data, so this is refused at '
        + 'kernel start. If this is a packed install, the owning package\'s "files" must include the client.',
      )
    }
    return path
  }

  /**
   * The `dsh.data` lane for one cell, or undefined when no plane is mounted
   * (V5 §5.1/§5.2).
   *
   * HOW THE PLANE IS FOUND, AND WHY THIS WAY. `dsh-ipython` must not depend on
   * `dsh-daily-work`: the two are siblings `link:`ed into a profile and the
   * sibling specifier does NOT resolve from this package's own realpath
   * (MEASURED: `MODULE_NOT_FOUND`). So the plane is resolved as a MOUNTED
   * SERVICE through `ctx.get('dailyData')`, which is the documented inject-free
   * read and the same form `history-plane.ts:184` uses for `sessionQuery`. A
   * deployment that mounts no data plane gets `undefined` here, and the lease
   * then refuses `data:*` with `DATA_NO_CAPABILITY` -- it does NOT fall through
   * to `ctx.tools.execute`.
   *
   * WHY A STRUCTURAL TYPE AND NOT AN IMPORTED ONE. The shape below names exactly
   * the two members this file uses. Importing the real type would reintroduce the
   * unresolvable dependency at COMPILE time, and a compile-time dependency on a
   * package this one cannot resolve is the defect, not the fix.
   *
   * THE CALLER IS BUILT FROM THE LEASE, NOT FROM THE FRAME. `sessionId` is the
   * lease's own (read from the kernel identity), `cwd` is the Session header's,
   * and `signal` is the LEASE'S controller -- the same one `close()` aborts. So a
   * revoked cell stops its reads through the one abort path that already exists
   * for tool calls, rather than through a second cancellation mechanism.
   */
  private dataHandlerFor(entry: Entry, controller: AbortController, agent: Agent | undefined): DataCallHandler | undefined {
    const plane = this.dataPlane()
    if (plane === undefined) return undefined
    // The Session's project root, which is the history authorization key. Read
    // from the SAME live Agent the tool lane dispatches as, so the two lanes
    // cannot disagree about which workspace the cell is in.
    const sessionCwd = agent?.session.header.cwd
    return async (call, context) => {
      const outcome = await plane.routeData(call.tool, call.arguments, {
        sessionId: entry.identity.sessionId,
        ...sessionCwd === undefined ? {} : { cwd: sessionCwd },
        // The LEASE's signal, so a lease close aborts the read itself.
        signal: controller.signal,
        callLabel: call.tool,
      })
      // A `DataRouteOutcome` IS a `NativeCallOutcome` (its `{ok:true,value}` and
      // `{ok:false,error}` arms are the same shape), so nothing is translated and
      // the value takes the SAME size door the tool lane uses: `deliver` decides
      // inline vs artifact by size, from this one execution, with no re-run.
      if (!outcome.ok) return { ok: false, error: outcome.error ?? { code: 'DATA_ERROR', message: 'the data plane refused the request without a reason' } }
      return entry.bridge.server.deliver(call.tool, context.subCallId, outcome.value)
    }
  }

  /**
   * The bridge capability for one Session, or undefined when it has no kernel.
   *
   * A HOST operation, and it does NOT start a kernel: this is the surface a
   * readiness probe reads to establish that a real Session's kernel has a real
   * bridge, which is the F2 question stated as a fact rather than as an
   * inference from the source graph.
   */
  bridgeFor(agent: Agent): BridgeCapability | undefined {
    return this.entries.get(agent.session.header.id)?.bridge
  }

  /** The kernel record for one Session, as V3 §J2 names it. Undefined when no kernel exists. */
  recordFor(agent: Agent): KernelRecord | undefined {
    const entry = this.entries.get(agent.session.header.id)
    if (entry === undefined) return undefined
    return {
      sessionId: entry.identity.sessionId,
      kernelEpoch: () => entry.host.currentEpoch,
      bridge: entry.bridge,
      lifecycle: () => entry.lifecycle,
      brokerProcess: () => entry.host.brokerDiagnostics === '' ? 'broker:diagnostics-empty' : 'broker:reporting',
    }
  }

  /**
   * The bridge ledger for one Session, or undefined when it has no kernel.
   *
   * Exposed because the ledger is the ANSWER to BR-07's oracle and a reader must
   * be able to read it without reaching into this service's internals. A host
   * probe reads this; so does a test that wants the dispositions of a real cell.
   */
  ledgerFor(agent: Agent): BridgeLedger | undefined {
    return this.entries.get(agent.session.header.id)?.ledger
  }

  /** Whether the Session's ledger is durable (storage-domain) or in-memory. */
  ledgerIsDurable(agent: Agent): boolean {
    return this.entries.get(agent.session.header.id)?.ledgerDurable === true
  }

  /**
   * Dispositions this Session's cells could NOT record durably.
   *
   * A reader that wants to know whether the BR-07 record is COMPLETE asks this
   * rather than trusting a healthy-looking kernel. Empty means every disposition
   * reached the ledger; a non-empty list names the subcalls that are missing.
   */
  ledgerFailures(agent: Agent): readonly BridgeLedgerWriteError[] {
    return Object.freeze([...(this.entries.get(agent.session.header.id)?.ledgerFailures ?? [])])
  }

  /** The lifecycle state of one Session's kernel, or undefined when no kernel exists. */
  lifecycleOf(agent: Agent): KernelLifecycleState | undefined {
    return this.entries.get(agent.session.header.id)?.lifecycle
  }

  /** True when a kernel exists for this Session. Never starts one. */
  hasKernel(agent: Agent): boolean {
    return this.entries.has(agent.session.header.id)
  }

  /**
   * The broker's report for one Session's kernel: transport, curve keys, and the
   * working directory the kernel was actually started in.
   *
   * A HOST operation, and it does NOT start a kernel -- a Session with no kernel
   * reports `undefined`, so a status read cannot consume a kernel slot. It exists
   * because the host must be able to OBSERVE the guarantees rather than infer them
   * from its own request: `kernelCwdEnforced: false` means the manager rejected the
   * directory and every relative path in a cell is resolving somewhere else.
   */
  async status(agent: Agent): Promise<KernelStatus | undefined> {
    const entry = this.entries.get(agent.session.header.id)
    if (entry === undefined) return undefined
    const reported = await entry.host.status()
    // THE LEDGER'S DURABILITY IS MERGED HERE, and the merge is why this method is
    // not a straight pass-through (V5 §11.1: "Status/doctor must show
    // `bridgeLedgerDurable: true`"). The broker reports on the kernel PROCESS; the
    // ledger is a storage-domain record the SERVICE holds, so the broker cannot
    // answer this and the host must not infer it. Reporting it from the entry
    // rather than from the configuration is deliberate: the configuration states
    // what was ASKED FOR, and this field must state what was OBTAINED.
    return { ...reported, bridgeLedgerDurable: entry.ledgerDurable }
  }

  /**
   * Output that belonged to no live cell. Draining it is how it is delivered.
   *
   * HOST-ONLY, and NOT the delivery path. It drains the raw classification
   * records the gates assert against; the model-facing delivery is
   * {@link drainLateNotices}, which is what the `ipython` tool calls. Two
   * accessors rather than one because they answer different questions and a
   * single drain would let one reader consume the other's evidence.
   */
  drainUnattributed(agent: Agent): UnattributedOutput[] {
    const entry = this.entries.get(agent.session.header.id)
    if (entry === undefined) return []
    return entry.unattributed.splice(0, entry.unattributed.length)
  }

  /**
   * Take this Session's pending late-output notices, and leave the queue empty.
   *
   * G-SEAM-78's DELIVERY ACCESSOR. It is called by the `ipython` tool's own
   * return path -- the same tool that promises the model this output will be
   * reported -- and the records it returns are surfaced through
   * `ToolRunContext.deferContext`, a SEPARATE deferred message, never inside the
   * cell's rendered text.
   *
   * WHY DRAINING IS THE DELIVERY. A notice is a fact the model has not been told
   * yet; telling it twice would make one write look like two. So the take is
   * destructive and the caller that takes is the caller that delivers. A Session
   * with no kernel returns an empty list rather than starting one: a drain must
   * not consume a kernel slot, and a notice for a kernel that does not exist is
   * not a fact about anything.
   */
  drainLateNotices(agent: Agent): LateNotice[] {
    return this.entries.get(agent.session.header.id)?.lateNotices.drain() ?? []
  }

  /**
   * What this Session's notice queue is holding and what it could not hold.
   *
   * A READ, never a drain. It exists because "no notices" and "every notice was
   * dropped by a bound" produce the same empty drain, and a reader that cannot
   * tell them apart would read a flood as silence -- which is the failure mode
   * the bounds exist to make visible rather than to hide.
   */
  lateNoticeAccount(agent: Agent): LateNoticeAccount | undefined {
    return this.entries.get(agent.session.header.id)?.lateNotices.account()
  }

  /** Interrupt the running cell for one Session. A host operation. */
  async interrupt(agent: Agent): Promise<{ interrupted: boolean, alive: boolean, epoch: number }> {
    const entry = await this.entryFor(agent)
    return await entry.host.interrupt()
  }

  /**
   * Restart the kernel. A host operation, always a new epoch.
   *
   * This is the escalation for a kernel that cannot be recovered: the audit
   * requires that a cell whose outcome cannot be established is reported
   * `unknown` and RESET rather than waited on forever.
   *
   * A RESTART ALLOCATES A NEW BRIDGE CAPABILITY IDENTITY (V3 §J2). The kernel
   * token is rotated, every lease from the old epoch is closed, and their recorded
   * dispositions say `cancelled`/`abandoned-unstarted` rather than being silently
   * forgotten -- so a program that held an old lease gets `CELL_LEASE_EXPIRED`
   * against a capability that no longer exists, instead of being served by a
   * bridge whose namespace was destroyed.
   */
  async restart(agent: Agent): Promise<number> {
    const entry = await this.entryFor(agent)
    entry.lifecycle = 'DISPOSING'
    await this.closeBridgeLeases(entry, 'aborted', 'the kernel was restarted')
    entry.bridge.server.rotateKernelToken()
    const status = await entry.host.restart()
    entry.lifecycle = 'READY'
    return status.epoch
  }

  /**
   * Stop one Session's kernel.
   *
   * THE DISPOSAL ORDER IS V3 §J2's, and every step is here rather than delegated:
   * refuse new leases, close the active ones, abort their owned exact calls, await
   * nested-call quiescence, close the bridge, then stop and await the broker and
   * kernel descendants.
   */
  async evict(agent: Agent): Promise<boolean> {
    const sessionId = agent.session.header.id
    const entry = this.entries.get(sessionId)
    if (entry === undefined) return false
    // The table is cleared FIRST, so a concurrent `entryFor` cannot resolve this
    // kernel while it is being torn down and mint a lease against a bridge that is
    // about to close. Publishing READY is what the table insert means, so removing
    // it is what stops new leases being created.
    this.entries.delete(sessionId)
    entry.lifecycle = 'DISPOSING'
    await this.disposeEntry(entry)
    return true
  }

  /** Close every lease, close the bridge, then stop and await the process range. */
  private async disposeEntry(entry: Entry): Promise<void> {
    try {
      await this.closeBridgeLeases(entry, 'aborted', 'the kernel was disposed')
      // The bridge closes AFTER the leases, so every disposition is recorded while
      // the capability that produced it is still identifiable.
      await entry.bridge.server.close()
    } finally {
      await entry.host.shutdown()
      entry.lifecycle = 'DISPOSED'
    }
  }

  /** Close every lease this epoch minted, recording each one's dispositions. */
  private async closeBridgeLeases(entry: Entry, reason: BridgeCloseReason, detail: string): Promise<void> {
    const leases = [...entry.bridge.leases]
    entry.bridge.leases.clear()
    await Promise.allSettled(leases.map(async lease => {
      await lease.close(reason, detail)
      entry.bridge.server.releaseLease(lease)
    }))
  }

  /** Stop every kernel this service owns. */
  async close(): Promise<void> {
    const entries = [...this.entries.values()]
    this.entries.clear()
    const failures: unknown[] = []
    for (const entry of entries) {
      entry.lifecycle = 'DISPOSING'
      try {
        await this.disposeEntry(entry)
      } catch (error) {
        failures.push(error)
      }
    }
    if (failures.length === 1) throw failures[0]
    if (failures.length > 1) throw new AggregateError(failures, 'ipython service teardown failed')
  }

  /** Session ids that currently hold a kernel. */
  listSessions(): string[] {
    return [...this.entries.keys()]
  }
}

// `sanitize()` lived here until P12. It turned a Session id into a directory name
// by replacing every character outside `[A-Za-z0-9._-]` with `_`, which is LOSSY:
// `a/b` and `a\b` both become `a_b`, so two distinct Sessions could be handed one
// scratch directory and one kernel could read another's connection file. Its only
// caller was the scratch-directory line in `entryFor`, which now uses
// `sessionScratchKey` (a truncated SHA-256) from `runtime-root.ts`. It was deleted
// rather than kept "for later", because a lossy path encoder left in a module
// whose whole subject is path identity is an invitation to reuse it.
