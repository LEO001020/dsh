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
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash, randomUUID } from 'node:crypto'
import {
  DEFAULT_CELL_TIMEOUT_MS,
  DEFAULT_INTERRUPT_GRACE_MS,
  DEFAULT_OUTPUT_CAP_BYTES,
  KernelHost,
  KernelTransportError,
  type KernelIdentity,
} from './kernel.ts'
import {
  BRIDGE_PROTOCOL_VERSION,
  BridgeLedgerWriteError,
  BridgeServer,
  canPrependPreamble,
  type BridgeEndpoint,
  type CellLease,
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
import type { CellResult, KernelStatus, LateOutput } from './protocol.ts'

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
 * Default kernel scratch root: inside the package, so a second checkout gets its
 * own kernels instead of sharing the first one's.
 *
 * A host that wants them elsewhere (a temp volume, a shared scratch disk) still
 * sets `root` explicitly; this is only the default. It is `.gitignore`d, because a
 * runtime directory must not appear as an untracked change in a tree where
 * untracked files have meant real defects twice (G-SEAM-30, G-SEAM-42).
 */
export const DEFAULT_KERNEL_ROOT = join(PACKAGE_ROOT, '.ipython-kernels')

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

/** Output that belonged to no live cell, kept per Session so it cannot cross. */
export interface UnattributedOutput extends LateOutput {
  readonly epoch: number
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
 * Owns one kernel per Session.
 *
 * The Session is the authorization subject (architecture section 10: "host以
 * Session/kernel作为最小授权主体"), so the map is keyed by Session id, and an
 * Agent that is not the live one for that Session is refused rather than
 * silently given the namespace.
 */
export class KernelService extends Service {
  private readonly entries = new Map<string, Entry>()

  constructor(ctx: Context, config: KernelServiceConfig) {
    super(ctx, 'ipython')
    this.config = config
  }

  private config: KernelServiceConfig

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
   */
  reconfigure(config: KernelServiceConfig): void {
    this.config = config
  }

  /** Kernel identity for one Session. Stable for the Session's lifetime. */
  identityFor(agent: Agent): KernelIdentity {
    const sessionId = agent.session.header.id
    return {
      sessionId,
      executionWorld: this.config.executionWorld ?? 'local',
      environmentDigest: this.config.environmentDigest ?? this.defaultEnvironmentDigest(),
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
   * The kernel scratch root: the configured one, or this package's own directory.
   *
   * WHY A DEFAULT AND NOT A REQUIRED FIELD. A required field means every profile
   * patch must name an absolute path, and a profile patch is shared by every
   * checkout that installs this package -- so the second checkout inherits the
   * first one's directory. That is not hypothetical: it is why a git worktree's
   * kernel wrote its connection files into the main checkout until this changed.
   */
  private kernelRoot(): string {
    return this.config.root ?? DEFAULT_KERNEL_ROOT
  }

  /**
   * A digest of the interpreter identity, so a kernel built against a different
   * Python is not reused as if it were the same environment.
   */
  private defaultEnvironmentDigest(): string {
    return createHash('sha256')
      .update(`${this.config.pythonExecutable}\u0000${process.platform}\u0000${process.arch}`)
      .digest('hex')
      .slice(0, 16)
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
    const identity = this.identityFor(agent)
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

    const workingDirectory = join(this.kernelRoot(), sanitize(identity.sessionId))
    mkdirSync(workingDirectory, { recursive: true })
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
    const bridge = new BridgeServer({
      artifactDirectory: join(bridgeDirectory, 'artifacts'),
      clientDirectory: bridgeDirectory,
      ...this.config.inlineValueBytes === undefined ? {} : { inlineValueBytes: this.config.inlineValueBytes },
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
        // be attached to whichever cell happens to run next.
        onLateOutput: output => { unattributed.push(output) },
      })
      await host.start()

      // ---- STEP 6: publish READY --------------------------------------------
      // The ledger is opened here too, and it is the LAST thing before the insert
      // for the same reason as the bridge: a Session whose kernel is published
      // must have somewhere to record what its cells did.
      const opened = this.config.durableLedger === false
        ? undefined
        : await openBridgeLedger(storageFacilityOf(this.ctx)).catch(() => undefined)
      const entry: Entry = {
        host,
        identity,
        bridge: capability,
        ledger: opened?.ledger ?? new MemoryBridgeLedger(),
        ledgerDurable: opened?.durable === true,
        lifecycle: 'READY',
        pendingGenerationNotice: undefined,
        unattributed,
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
   * dispatched and closed when it settles -- not before, and not after. A caller
   * that supplies no authority gets a cell with NO bridge: `dsh` is simply absent
   * from its namespace, which is the honest outcome for a cell dispatched by a
   * host that is not a model `ipython` execution (an internal probe, a test).
   * Inventing an authority there would give an unowned cell the ability to call
   * tools as somebody else.
   */
  async runCell(agent: Agent, code: string, signal?: AbortSignal, authority?: CellAuthority): Promise<CellResult> {
    const entry = await this.entryFor(agent)
    if (signal?.aborted) {
      throw new KernelTransportError('the cell was cancelled before it was sent to the kernel')
    }
    if (authority === undefined) {
      // No bridge for this cell. The preamble is not prepended, so `dsh` does not
      // exist in the namespace and a cell that tries to use it gets `NameError`
      // rather than a stale capability from a previous cell.
      const result = await entry.host.execute(code, { identity: entry.identity })
      if (result.generation !== undefined) entry.pendingGenerationNotice = result.generation.reason
      return result
    }

    const lease = this.mintCellLease(entry, authority, signal)
    entry.bridge.leases.add(lease)
    const dispatched = canPrependPreamble(code)
      ? [entry.bridge.server.preamble(lease), code].join('\n')
      : code
    let result: CellResult
    let ledgerFailure: BridgeLedgerWriteError | undefined
    try {
      result = await entry.host.execute(dispatched, { identity: entry.identity })
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
   * receives an opaque lease id in the preamble and nothing else.
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
    })
  }

  /** The current epoch for one Session, without starting a kernel. */
  currentEpoch(agent: Agent): number {
    const sessionId = agent.session.header.id
    return this.entries.get(sessionId)?.host.currentEpoch ?? 0
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
    return await entry.host.status()
  }

  /** Output that belonged to no live cell. Draining it is how it is delivered. */
  drainUnattributed(agent: Agent): UnattributedOutput[] {
    const entry = this.entries.get(agent.session.header.id)
    if (entry === undefined) return []
    return entry.unattributed.splice(0, entry.unattributed.length)
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

/** Keep one Session's files inside its own directory. */
function sanitize(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120)
}
