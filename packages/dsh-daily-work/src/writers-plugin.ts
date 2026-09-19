/**
 * The host-profile entry point for CONCURRENCY-ISOLATED writer workspaces and
 * the root's integration authority (M8, ARCHITECTURE §15).
 *
 * NAMING, because it decides what a reader thinks needs verifying: a writer
 * workspace is a `concurrency-isolated worktree`, and it is NOT a security boundary.
 * Its jobs are to stop concurrent writes clobbering each other, to give every
 * candidate a deterministic merge basis, and to bind a verification to one
 * specific candidate. In this trusted-local deployment all writers share
 * the invoking user's full authority, so no claim of containment is made or
 * implied anywhere in this file. What the service offers instead is DETECTION
 * (`verifyShared`) plus a real boundary only where one is constructed
 * (`kind: 'clone'`).
 *
 * The phrase `NOT a security boundary` is kept CONTIGUOUS ON ONE LINE on
 * purpose, and a future editor should not re-wrap it. `verification-gates.test.ts`
 * pins it with a literal `toContain`, which is what makes the disclaimer
 * greppable in the source rather than merely implied by a paragraph; a cosmetic
 * re-wrap silently defeats that pin. `worktree-isolation.ts` states the same
 * sentence the same way, so the two files read as one claim.
 *
 * WHY THIS FILE EXISTS. `worktree-isolation.ts` was, until this entry point
 * existed, a TEST-ONLY module: mounting it directly in a test proved it WORKS
 * and proved nothing about whether the PRODUCT uses it. That is the defect class
 * this project has now been bitten by four times:
 *
 *   1. `setLaunchPort` had no production caller, so the shipped profile launched
 *      nothing and every `submit` became `unknown` (fixed in `2d4534f`).
 *   2. `takeContinuation` had no production caller, so a managed run never
 *      disarmed the Goal round-driver and TWO continuation owners could drive one
 *      root while `goal.test.ts` passed (fixed in `982e82b`).
 *   3. `dsh-ipython` declared no `dsh.bundle`, so the package would never reach
 *      the model even with green tests.
 *   4. This module, before this file: `verify.ts` is reached through
 *      `qualification/runners/acceptance.mjs`, but the writer path had no
 *      production entry at all.
 *
 * `docs/GAPS.md` G-FIX-04 names the lesson: **an oracle weaker than its scenario
 * passes while the product is broken.** So this is a real Cordis plugin with a
 * real service name, declared in `cordis.patch.yml` as an `insert` row, loadable
 * by the profile resolver with no test in the loop. `ctx.dailyWriters` is the
 * handle.
 *
 * WHAT IT DOES NOT DO
 *
 * It does not run git at mount time, does not create any workspace, and does not
 * require a repository to exist. A workspace is created only when a caller asks
 * for one, against a root the caller names, so a deployment whose root is not a
 * git checkout boots normally and reports the failure at the call that needed it.
 *
 * It also does not merge, rebase, cherry-pick, push or force anything. The only
 * mutating git commands it can reach are workspace-lifecycle operations
 * (`worktree add/remove/prune`, `branch -D`, `clone`, `checkout`, `remote
 * remove`) — all of them scoped to the workspace this service created. Every
 * other operation is a read or a refusal, which is what makes "the root is the
 * single integration authority" a property of the code rather than a policy
 * statement.
 *
 * THE AUTHORIZATION SEAM
 *
 * A writer workspace is a capability. `open()` returns a lease; the lease's
 * `env` is what binds a child process to the workspace, and `release()` is what
 * gives it back. The service refuses a second `open()` on a workspace that is
 * already held, in this process or on disk, so a caller cannot obtain two
 * capabilities over one tree.
 */
import { Context, Service } from '@deepseek-ai/cordis'
import {
  acquireWriterWorkspace,
  assessIntegration,
  bindReceipt,
  convergeBeforeFreeze,
  observedBasis,
  oracleDigest,
  publicationPrecondition,
  sharedMetadataDigests,
  testsAreReal,
  verifySharedMetadata,
  writerLeaseHeld,
  type AssessIntegrationOptions,
  type ConvergenceResult,
  type IntegrationAssessment,
  type PublicationPrecondition,
  type PublicationRequest,
  type ReceiptBindingResult,
  type SharedMetadataCheck,
  type SharedMetadataSnapshot,
  type VerdictBinding,
  type WriterWorkspace,
  type WriterWorkspaceOptions,
} from './worktree-isolation.ts'
import type { AcceptanceDefinition, AcceptanceReceipt } from './verify.ts'

export const name = 'dsh-daily-writers'

/**
 * `subprocess` is deliberately NOT listed here.
 *
 * `inject` makes a service a hard activation requirement. MEASURED during the
 * real-profile boot probe: reading `ctx.subprocess` without declaring it throws
 * `cannot get property "subprocess" without inject`, and declaring it would turn
 * a deployment that mounts no subprocess provider into a BOOT FAILURE. The
 * writers service must be reachable in such a deployment so it can REPORT the
 * gap — "no subprocess provider is mounted" is an operational fact a caller
 * needs, and a profile that refuses to start cannot report anything.
 *
 * So the dependency is resolved per call through `ctx.get('subprocess')`, which
 * is the optional-dependency form `dailyHistory` also uses for `sessionQuery`.
 * The helper below is the single place that resolution happens, so no method can
 * accidentally read the injected accessor and turn an optional dependency into a
 * hard one.
 */
export const inject: string[] = []

/** Config for the writer service. */
export interface Config {
  /**
   * The integration authority's checkout. Required for any call that touches a
   * repository, and deliberately not defaulted: a service that guessed a root
   * would be a service that could operate on the wrong repository.
   */
  readonly root?: string
  /**
   * Refs a writer must not move. Recorded in every workspace's shared-metadata
   * snapshot and re-read by `verifyShared()` before publication.
   */
  readonly protectedRefs?: readonly string[]
}

/** One workspace lease, as the service hands it out. */
export interface WriterLease {
  readonly workspace: WriterWorkspace
  /** Give the workspace back. Idempotent. */
  release(): Promise<void>
}

/**
 * The M8 host service, reachable as `ctx.dailyWriters`.
 *
 * The method set is deliberately small and every method is one of three things:
 * a workspace lifecycle operation, a READ, or a REFUSAL. There is no method that
 * writes to the integration branch, because this project does not merge.
 */
export class WriterIsolationService extends Service {
  private readonly _config: Config
  private readonly _leases = new Set<WriterWorkspace>()

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'dailyWriters')
    this._config = config
  }

  /** The configured integration authority, or a typed refusal naming the gap. */
  private root(explicit?: string): string {
    const root = explicit ?? this._config.root
    if (root === undefined || root === '') {
      throw new Error(
        'dailyWriters: no integration root is configured. The service refuses to guess one, because a service that '
        + 'guessed would be able to operate on the wrong repository. Set `root` in the plugin config or pass one '
        + 'explicitly.',
      )
    }
    return root
  }

  /**
   * Whether the configured root is usable: a git checkout whose common git
   * directory can be read.
   *
   * Reported rather than asserted, so a deployment can tell "the writer path is
   * configured and reachable" from "the writer path is configured but the root is
   * not a repository" — which are different operational facts.
   */
  async available(explicitRoot?: string): Promise<{ available: boolean; reason: string }> {
    let root: string
    try {
      root = this.root(explicitRoot)
    } catch (error) {
      return { available: false, reason: (error as Error).message }
    }
    if (this.ctx.get('subprocess') === undefined) {
      return { available: false, reason: 'no ctx.subprocess provider is mounted, so no git command can be run' }
    }
    try {
      await sharedMetadataDigests(this.ctx, root, this._config.protectedRefs ?? ['refs/heads/main'])
      return { available: true, reason: `the writer path can reach the integration root ${root}` }
    } catch (error) {
      return { available: false, reason: `the integration root is not usable: ${(error as Error).message}` }
    }
  }

  /**
   * Create one writer's concurrency-isolated workspace and hand back a lease.
   *
   * `root` may be passed explicitly so a caller can work against a repository
   * other than the configured one; the configured value is the default rather
   * than a hard constraint, because a deployment may legitimately have more than
   * one repository and the refusal that matters is the missing value, not a
   * mismatch.
   *
   * The lease is a CONCURRENCY capability, not a security capability: it makes
   * one-writer-per-workspace true and it binds the writer to a base revision. It
   * does not reduce the writer's process authority by any amount.
   */
  async open(options: Omit<WriterWorkspaceOptions, 'ctx'> & { root?: string }): Promise<WriterLease> {
    const workspace = await acquireWriterWorkspace({
      ...options,
      root: this.root(options.root),
      ctx: this.ctx,
      ...(this._config.protectedRefs === undefined ? {} : { protectedRefs: this._config.protectedRefs }),
    })
    this._leases.add(workspace)
    return {
      workspace,
      release: async (): Promise<void> => {
        this._leases.delete(workspace)
        await workspace.release()
      },
    }
  }

  /** Whether a writer currently holds this workspace, in this process or on disk. */
  isHeld(workspacePath: string): boolean {
    return writerLeaseHeld(workspacePath)
  }

  /**
   * Converge a workspace and take the digest the acceptance runner would freeze.
   *
   * The in-flight refusal lives here rather than in the runner because the runner
   * cannot make it: it freezes whatever it finds at the instant it starts.
   */
  async converge(workspacePath: string, definition: AcceptanceDefinition, settleMs?: number): Promise<ConvergenceResult> {
    return convergeBeforeFreeze({
      workspacePath,
      definition,
      ...(settleMs === undefined ? {} : { settleMs }),
    })
  }

  /**
   * Re-read the shared git metadata a workspace's snapshot recorded.
   *
   * This is the DETECTION half of "a worktree is not a security boundary": the
   * mutations a writer can make to shared refs/config/hooks are not denied by
   * git, so they are checked instead, and a moved ref refuses the publication.
   */
  async verifyShared(root: string, snapshot: SharedMetadataSnapshot): Promise<SharedMetadataCheck> {
    return verifySharedMetadata(this.ctx, root, snapshot)
  }

  /** Read the shared-metadata digests a workspace creation recorded. */
  async sharedDigests(root: string): Promise<SharedMetadataSnapshot> {
    return sharedMetadataDigests(this.ctx, root, this._config.protectedRefs ?? ['refs/heads/main'])
  }

  /** Digest the protected oracle files, so a verdict can be bound to them. */
  oracleDigest(files: Readonly<Record<string, string>>): string {
    return oracleDigest(files)
  }

  /** Observe the verification basis as it exists now, for a receipt comparison. */
  observedBasis(definition: AcceptanceDefinition, oracleFiles: Readonly<Record<string, string>>): VerdictBinding {
    return observedBasis({ definition, oracleFiles })
  }

  /** Whether a stored receipt still binds the current basis. */
  bindReceipt(recorded: VerdictBinding, observed: VerdictBinding): ReceiptBindingResult {
    return bindReceipt(recorded, observed)
  }

  /** Whether a receipt records tests that really ran. */
  testsAreReal(receipt: AcceptanceReceipt | undefined): { real: boolean; reason: string } {
    return testsAreReal(receipt)
  }

  /**
   * Judge one candidate. A READ-ONLY operation that ends in a refusal or an
   * acceptance decision; it never merges, and a conflict is returned to the
   * caller as a refusal.
   */
  async assess(options: Omit<AssessIntegrationOptions, 'ctx' | 'root'> & { root?: string }): Promise<IntegrationAssessment> {
    return assessIntegration({ ...options, root: this.root(options.root), ctx: this.ctx })
  }

  /** Decide whether an accepted assessment plus an unchanged ref authorize publication. */
  publicationPrecondition(request: PublicationRequest): PublicationPrecondition {
    return publicationPrecondition(request)
  }

  /** Release every lease this service still holds. Called by the plugin's disposer. */
  async releaseAll(): Promise<void> {
    const held = [...this._leases]
    this._leases.clear()
    for (const workspace of held) {
      try {
        await workspace.release()
      } catch {
        // A workspace that cannot be removed is a disk-hygiene problem, and
        // failing teardown over it would mask the leases that WERE released.
      }
    }
  }
}

/**
 * Mount the writer service.
 *
 * Synchronous on purpose: there is nothing to open, no domain to await, and no
 * git command to run at mount time. A deployment whose root is not a repository
 * must still boot; the failure belongs to the call that needed the repository,
 * not to activation.
 */
export function apply(ctx: Context, config: Config = {}): void {
  const service = new WriterIsolationService(ctx, config)
  ctx.effect(() => () => service.releaseAll(), 'dsh-daily-writers: workspace leases')
}

export { WriterIsolationService as default }
export type {
  ConvergenceResult,
  IntegrationAssessment,
  PublicationPrecondition,
  ReceiptBindingResult,
  SharedMetadataCheck,
  SharedMetadataSnapshot,
  VerdictBinding,
  WriterWorkspace,
}
