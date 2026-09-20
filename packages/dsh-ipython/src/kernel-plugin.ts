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
 */
import type { Context } from '@deepseek-ai/cordis'
import { Service } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import {
  DEFAULT_CELL_TIMEOUT_MS,
  DEFAULT_INTERRUPT_GRACE_MS,
  DEFAULT_OUTPUT_CAP_BYTES,
  KernelHost,
  KernelTransportError,
  type KernelIdentity,
} from './kernel.ts'
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
}

/** Output that belonged to no live cell, kept per Session so it cannot cross. */
export interface UnattributedOutput extends LateOutput {
  readonly epoch: number
}

interface Entry {
  readonly host: KernelHost
  readonly identity: KernelIdentity
  /** Set once the kernel has been observed dead or reset; reported on the next call. */
  pendingGenerationNotice: string | undefined
  readonly unattributed: UnattributedOutput[]
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

  /** The kernel for one Session, started on first use. */
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
    const unattributed: UnattributedOutput[] = []
    const host = new KernelHost({
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
    const entry: Entry = { host, identity, pendingGenerationNotice: undefined, unattributed }
    this.entries.set(identity.sessionId, entry)
    return entry
  }

  /**
   * Run one cell for one Agent.
   *
   * `signal` is the tool execution's own cancellation. It is observed BEFORE the
   * cell is sent: a cell that has already been dispatched is not abandoned by
   * dropping the promise, because the kernel would keep running it while the
   * model believed it had stopped. Abandoning is done by interrupting, which is
   * a real kernel operation.
   */
  async runCell(agent: Agent, code: string, signal?: AbortSignal): Promise<CellResult> {
    const entry = await this.entryFor(agent)
    if (signal?.aborted) {
      throw new KernelTransportError('the cell was cancelled before it was sent to the kernel')
    }
    const result = await entry.host.execute(code, { identity: entry.identity })
    if (result.generation !== undefined) {
      entry.pendingGenerationNotice = result.generation.reason
    }
    return result
  }

  /** The current epoch for one Session, without starting a kernel. */
  currentEpoch(agent: Agent): number {
    const sessionId = agent.session.header.id
    return this.entries.get(sessionId)?.host.currentEpoch ?? 0
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
   */
  async restart(agent: Agent): Promise<number> {
    const entry = await this.entryFor(agent)
    const status = await entry.host.restart()
    return status.epoch
  }

  /** Stop one Session's kernel. */
  async evict(agent: Agent): Promise<boolean> {
    const sessionId = agent.session.header.id
    const entry = this.entries.get(sessionId)
    if (entry === undefined) return false
    this.entries.delete(sessionId)
    await entry.host.shutdown()
    return true
  }

  /** Stop every kernel this service owns. */
  async close(): Promise<void> {
    const entries = [...this.entries.values()]
    this.entries.clear()
    const failures: unknown[] = []
    for (const entry of entries) {
      try {
        await entry.host.shutdown()
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
