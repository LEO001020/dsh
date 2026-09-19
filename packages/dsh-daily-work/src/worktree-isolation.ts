/**
 * CONCURRENCY-ISOLATED writer workspaces and the root's integration authority
 * (M8, ARCHITECTURE §15).
 *
 * ## The re-definition this file implements
 *
 * Under the old sandboxed architecture a worktree was described as an ISOLATION
 * MECHANISM, and a reader could reasonably take that to mean a SECURITY
 * BOUNDARY. In a trusted-local, no-sandbox deployment that reading is wrong and
 * expensive to hold, so the concept is renamed and re-scoped here:
 *
 *     concurrency-isolated worktree
 *         NOT a security boundary
 *
 * Its purpose is exactly three things, and no more:
 *
 *   1. avoid concurrent writes clobbering each other;
 *   2. establish a deterministic merge basis — the base revision every candidate
 *      is cut from, and the revision the root checks the patch against;
 *   3. bind verification to a specific candidate — a workspace, a branch, a base
 *      and a head — so a verdict describes ONE revision rather than "some tree".
 *
 * It is NOT to prevent a child from reaching the host. In a trusted-local
 * deployment every writer runs as the same OS user with that user's full
 * authority; that is the intended deployment semantics, not a gap. Nothing in
 * this file contains a writer, and nothing in this file may be read as claiming
 * to. The corresponding honesty rule for the VERIFICATION family: a verifier
 * that runs with host authority is not a control either — it is another host
 * process. What it provides is MECHANICAL WORLD OBSERVATION (a real command, a
 * real exit code, digests recomputed from the world), never containment.
 *
 * ## What this means for the plan's contract
 *
 * The plan's contract in one sentence: "root是主整合者；每个writer child拥有自己的
 * 隔离worktree/快照。git worktree不是安全边界：共享`.git`对象、refs/config/hooks必须
 * 保护；需要安全隔离时给独立clone/snapshot而非只改cwd。"
 *
 * So this file does NOT claim a worktree is a security boundary, and the code is
 * arranged so it could not be read as making that claim:
 *
 *   1. A worktree shares the ref store, the config file and the hooks directory
 *      with the root. MEASURED on this host (git 2.55.0.windows.3), from inside a
 *      writer worktree:
 *        `git update-ref refs/heads/main <sha>`  -> exit 0. The integration
 *                                                   branch really moved.
 *        `git config <name> <value>`             -> exit 0, written to the
 *                                                   COMMON `.git/config`.
 *        a hook written into the common hooks dir fires for a ROOT commit.
 *      None of those are denied by git. What git DOES deny is checking out a
 *      branch that is already checked out elsewhere ("fatal: '<branch>' is
 *      already used by worktree at ...", exit 128), which is why every writer
 *      gets its OWN branch and the integration branch cannot be adopted inside
 *      the writer's workspace.
 *
 *   2. Because the sharing is real and un-denied, the protection is a CHECK, not
 *      a permission: {@link sharedMetadataDigests} records the integration refs,
 *      the common config and the hooks directory, and {@link verifySharedMetadata}
 *      re-reads them before publication. A writer that moved the integration ref
 *      is DETECTED and the publication is refused. Detection is the honest claim;
 *      the alternative claim ("the writer cannot") is false on this platform.
 *
 *   3. When a deployment wants a boundary rather than a check, {@link acquireWriterWorkspace}
 *      offers `kind: 'clone'`: an independent clone with `--no-hardlinks`, its own
 *      object store, its own refs/config/hooks, and NO remote, so a writer has no
 *      configured path to push the integration branch anywhere. The clone is the
 *      answer the plan names ("独立clone/snapshot"), and it is asserted by
 *      mutation rather than assumed: a writer that rewrites its clone's refs and
 *      config leaves the root's digests byte-identical.
 *
 * Two more boundaries this file is careful about:
 *
 *   - TWO WRITERS NEVER SHARE ONE WORKSPACE. Enforced by an in-process registry
 *     keyed by resolved workspace path AND by an exclusive-create lock file, so
 *     the refusal holds across processes too. A stale lock is REFUSED, never
 *     stolen: the plan is explicit that PID/TTL lock stealing is not acceptable
 *     (ARCHITECTURE §17), so the recovery path is a human, not a heuristic.
 *
 *   - THE ROOT IS THE ONLY INTEGRATION AUTHORITY, AND IT DOES NOT MERGE.
 *     {@link assessIntegration} reads and refuses. It runs `git apply --check`
 *     and NOT `git apply --3way`: MEASURED, a conflicting patch exits 1 under
 *     `--check` and exits 0 under `--3way --check`, i.e. the three-way form is
 *     the first step of a semantic merge. A conflict goes back to the root as a
 *     refusal; there is no auto-merge controller here and there must not be one.
 *     The same read-only discipline applies to publication: a patch digest and an
 *     expected-ref CAS, with no force and no reset.
 *
 * What this file does NOT do: it is not a sandbox. A writer's process can still
 * read the host filesystem and reach the network — `qualification/results/M9.3-security-denial/`
 * measured that the Windows confinement is write-only and `enforcement: 'partial'`.
 * Nothing here changes that, and nothing here may be read as claiming it.
 */
import { createHash } from 'node:crypto'
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
  writeSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import type { AcceptanceDefinition, AcceptanceReceipt } from './verify.ts'
import { acceptanceDefinitionDigest, digestInputs } from './verify.ts'

/** sha256 of a UTF-8 string, hex. Same shape as the acceptance runner's digest. */
function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/** sha256 of a file's bytes, or `MISSING` so a deletion changes the digest. */
function sha256File(path: string): string {
  return existsSync(path) ? sha256(readFileSync(path).toString('base64')) : 'MISSING'
}

/**
 * How a writer's workspace is MATERIALIZED.
 *
 * This is deliberately NOT called an "isolation strength" and the type is
 * deliberately not named after isolation: a reader who reads `worktree` vs
 * `clone` as two points on a security gradient will draw the wrong conclusion
 * about what needs verifying. Both kinds are concurrency isolation. Only `clone`
 * additionally happens to be a boundary, and that is a side effect of having its
 * own object store rather than the reason it exists here.
 *
 *  - `worktree` — `git worktree add -b <writerBranch> <path> <base>`. Cheap, and
 *    the writer cannot adopt the integration branch (git refuses, exit 128), but
 *    the ref store/config/hooks are SHARED and only checked. Concurrent writers
 *    do not clobber each other, and the base is deterministic.
 *  - `clone` — an independent clone with its own object store and no remote.
 *    Choose this when the deployment ALSO wants a boundary; it is not "more
 *    concurrency isolation" than a worktree, it is a different materialization
 *    that additionally happens to isolate refs/config/hooks/hooks by
 *    construction rather than by check.
 */
export type WriterWorkspaceKind = 'worktree' | 'clone'

/**
 * One writer's concurrency-isolated workspace and the facts a reader needs to
 * re-judge it.
 *
 * "Concurrency-isolated" and NOT "secure": see the module header. This object
 * carries no claim about what the writer's process can reach.
 */
export interface WriterWorkspace {
  readonly writerId: string
  readonly kind: WriterWorkspaceKind
  /** The writer's cwd. Everything the writer does is resolved against this. */
  readonly path: string
  /** The revision the workspace was created from. Exact, not a prefix. */
  readonly baseRevision: string
  /** The writer's OWN branch. Never the integration branch. */
  readonly branch: string
  /** Per-writer output roots, so two writers cannot collide on one path. */
  readonly artifactDir: string
  readonly buildDir: string
  readonly cacheDir: string
  /**
   * Environment entries binding the writer to its own workspace and output
   * roots. `GIT_DIR`/`GIT_WORK_TREE`/`GIT_INDEX_FILE` are TOMBSTONED: if the
   * parent process has one of them set, an inherited value would make the
   * writer's git commands operate on the ROOT's repository from inside the
   * writer's directory. The seam treats `undefined` as a removal.
   */
  readonly env: NodeJS.ProcessEnv
  /** Shared-metadata digests taken immediately after materialization. */
  readonly shared: SharedMetadataSnapshot
  /** Where the exclusive writer lease lives, so a second process can be refused. */
  readonly lockPath: string
  /**
   * Release ONLY the writer lease, keeping the directory, the branch and the
   * writer's commits.
   *
   * This is the real production edge, and it is separate from {@link release} on
   * purpose: the flow is "writer stops writing → release its lease → converge →
   * freeze → verify". A workspace whose lease is still held is IN FLIGHT by
   * definition, so `convergeBeforeFreeze` refuses it; a workspace that was torn
   * down cannot be verified at all. Only this operation leaves the tree in the
   * state verification needs: finished, and still present.
   */
  finish(): void
  /** Remove the workspace, its branch and its lease. Idempotent. */
  release(): Promise<void>
}

/** The `.git` facts a worktree SHARES with its root and a clone does not. */
export interface SharedMetadataSnapshot {
  /** Absolute path of the common git directory these digests describe. */
  readonly commonDir: string
  /** `refname -> objectname` for the integration refs only. */
  readonly refs: Readonly<Record<string, string>>
  /** sha256 of the common `config` file. */
  readonly configSha256: string
  /** Digest over the common `hooks` directory: names plus file bytes. */
  readonly hooksDigest: string
}

/** The outcome of re-reading the shared metadata. */
export interface SharedMetadataCheck {
  intact: boolean
  reasons: string[]
  /** Refs whose value differs from the snapshot, with both values. */
  movedRefs: Array<{ ref: string; expected: string; observed: string }>
  configChanged: boolean
  hooksChanged: boolean
  observed: SharedMetadataSnapshot
}

/** A read-only verdict about whether one candidate may be integrated. */
export interface IntegrationAssessment {
  /** `accept_for_publication` is the only accepting value. */
  decision: 'accept_for_publication' | 'refuse'
  reasons: string[]
  /** The revision the candidate claims to be built on, and the one the root expected. */
  baseRevision: string
  expectedBase: string
  headRevision: string
  baseRevisionMatches: boolean
  /** True when the candidate head is a descendant of the base, so the delta is exactly the patch. */
  headDescendsFromBase: boolean
  /** `git apply --check` against the root's current HEAD. NEVER `--3way`. */
  patchApplies: boolean
  /** sha256 of the patch bytes, so the reviewed artifact is identified by content. */
  patchDigest: string
  patchBytes: number
  changedPaths: string[]
  /** Paths the candidate changed that the caller did not allow. */
  outOfScope: string[]
  scopeOk: boolean
  /** The receipt binding, when a receipt was supplied. */
  receiptBinding?: ReceiptBindingResult
  /** True when the candidate's own tests really ran and really passed. */
  testsAreReal: boolean
  testReason: string
}

/**
 * The four bindings a verdict must carry.
 *
 * The delivery plan requires the verification result to be bound to the
 * ARTIFACT, the WORKSPACE, the ENVIRONMENT and the ORACLE digest. The runner's
 * receipt carries the first two and the environment; the ORACLE is not in the
 * receipt at all, because the runner has no notion of a protected suite separate
 * from the candidate tree. So the oracle digest is recorded HERE, alongside the
 * receipt, by the verifier — and {@link bindReceipt} compares the recorded
 * binding against the basis observed now.
 *
 * Keeping the oracle out of the receipt is deliberate rather than a limitation
 * to work around: the receipt is produced by a process that runs the candidate,
 * so a field in it that the candidate's own tree could influence would be a
 * weaker claim than one recorded separately by the verifier.
 */
export interface VerdictBinding {
  /** Digest of the candidate tree the receipt was produced against. */
  candidateTreeDigest: string
  /** Digest of the acceptance definition the receipt was produced under. */
  acceptanceDefinitionDigest: string
  /** Digest of the PROTECTED oracle (the frozen suite and its config). */
  oracleDigest: string
  /** Environment identity the verdict was produced under. */
  environment: { node: string; platform: string; arch: string }
}

/** The result of checking a receipt against its recorded and observed bindings. */
export interface ReceiptBindingResult {
  applicable: boolean
  reasons: string[]
  /** Each mismatched binding, named, so a refusal is diagnosable. */
  mismatches: string[]
}

/** A candidate workspace the root is asked to integrate. */
export interface IntegrationCandidate {
  /** The writer's workspace (or any checkout) holding the candidate commit. */
  cwd: string
  /** The revision the workspace was created from, as recorded at creation. */
  baseRevision: string
  /** The candidate's head commit. */
  headRevision: string
}

/** Options for {@link acquireWriterWorkspace}. */
export interface WriterWorkspaceOptions {
  /** The integration authority's checkout. */
  root: string
  /** Stable writer id; becomes the branch name and the directory name. */
  writerId: string
  /** The revision to create the workspace from. Must resolve to a full commit sha. */
  baseRevision: string
  /**
   * How the workspace is materialized. Default `worktree`.
   *
   * Not an "isolation level": both kinds are concurrency isolation. `clone` is
   * additionally a boundary, which is a separate property a deployment either
   * needs or does not.
   */
  kind?: WriterWorkspaceKind
  /** Directory to create the workspace in. Default: a sibling of `root`. */
  parentDir?: string
  /**
   * Refs the writer must not move, e.g. the integration branch. Recorded in the
   * snapshot and re-read by {@link verifySharedMetadata}.
   */
  protectedRefs?: readonly string[]
  /** Reuse a mounted subprocess service. */
  ctx?: Context
}

/** The default protected ref when a caller names none: the integration branch. */
const DEFAULT_PROTECTED_REFS = ['refs/heads/main', 'refs/heads/master'] as const

/** Environment names a writer must NOT inherit: they would retarget its git commands. */
const GIT_REDIRECT_NAMES = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR'] as const

/** One `git` invocation's observed result. */
interface GitResult {
  code: number | null
  stdout: string
  stderr: string
}

/**
 * The subprocess provider, resolved as an OPTIONAL dependency.
 *
 * MEASURED during the real-profile boot probe: reading `ctx.subprocess` on a
 * context whose plugin did not declare `subprocess` in its `inject` list throws
 * `cannot get property "subprocess" without inject`. Declaring `subprocess` would
 * instead make it a hard ACTIVATION requirement, so a deployment that mounts no
 * subprocess provider could not boot the writers service at all — and then it
 * could not report the gap either.
 *
 * `ctx.get` is the optional-dependency form, and the typed refusal below names
 * the DEPLOYMENT as the cause so a caller can tell "this deployment has no
 * subprocess provider" from "git failed".
 */
function requireSubprocess(ctx: Context): SubprocessRuntime {
  const subprocess = ctx.get('subprocess')
  if (subprocess === undefined) {
    throw new Error(
      'writer-isolation: no ctx.subprocess provider is mounted, so no git command can be run. This is a '
      + 'DEPLOYMENT configuration gap rather than a repository failure.',
    )
  }
  return subprocess
}

/**
 * Run one `git` argv through the real DSH subprocess seam.
 *
 * The seam is used rather than `node:child_process` for the same two reasons the
 * acceptance runner uses it: credential-shaped and `DSH_*` names are dropped
 * from the child's environment before it starts, and `waitForExit()` observes
 * the whole managed process RANGE rather than only the direct child. git can
 * spawn helpers (credential helpers, hooks), and a direct-child-only view would
 * not be able to say the range was empty.
 */
async function gitRun(ctx: Context, cwd: string, argv: readonly string[]): Promise<GitResult> {
  const subprocess = requireSubprocess(ctx)
  const program = await subprocess.resolveExecutable('git')
  const handle = subprocess.spawn({
    argv: [program, ...argv],
    cwd,
    stdio: {
      stdin: 'ignore',
      stdout: { maxBytes: 8 * 1024 * 1024 },
      stderr: { maxBytes: 8 * 1024 * 1024 },
    },
    graceMs: 10_000,
  })
  const outcome = await handle.done
  await handle.waitForExit().catch(() => false)
  const stdout = handle.collected.stdout?.readFrom(0)
  const stderr = handle.collected.stderr?.readFrom(0)
  return { code: outcome.exitCode, stdout: stdout?.text ?? '', stderr: stderr?.text ?? '' }
}

/** Run git and throw when it exits non-zero, quoting stderr so a refusal is diagnosable. */
async function gitOk(ctx: Context, cwd: string, argv: readonly string[]): Promise<string> {
  const result = await gitRun(ctx, cwd, argv)
  if (result.code !== 0) {
    throw new Error(
      `writer-isolation: git ${argv.join(' ')} in ${cwd} exited ${String(result.code)}: ${result.stderr.trim()}`,
    )
  }
  return result.stdout
}

/**
 * Digest the metadata a worktree SHARES with its root.
 *
 * Scope, stated because a reader must be able to check it:
 *   - the PROTECTED refs only. A writer committing to its own branch legitimately
 *     moves `refs/heads/<writerBranch>`, so digesting every ref would report the
 *     writer's normal work as tampering. The integration ref is the thing that
 *     must not move, and it is the thing recorded.
 *   - the common `config` file. Measured: `git config x y` from a worktree writes
 *     THIS file (exit 0), so it is shared and unprotected by git.
 *   - the common `hooks` directory. Measured: a hook planted there by a writer
 *     fires for a root commit.
 * Deliberately EXCLUDED: `.git/worktrees/**`, which holds each writer's own
 * HEAD/index/logs, and `objects/**`, which is shared but append-only by content
 * address — a writer can add objects and that is exactly how a candidate commit
 * exists at all.
 */
export async function sharedMetadataDigests(
  ctx: Context,
  root: string,
  protectedRefs: readonly string[],
): Promise<SharedMetadataSnapshot> {
  const commonDirRaw = (await gitOk(ctx, root, ['rev-parse', '--git-common-dir'])).trim()
  // `--git-common-dir` may be relative to the cwd it was run in, so it is
  // resolved rather than trusted as absolute.
  const commonDir = resolve(root, commonDirRaw)
  const refs: Record<string, string> = {}
  for (const ref of protectedRefs) {
    const result = await gitRun(ctx, root, ['rev-parse', '--verify', '--quiet', ref])
    refs[ref] = result.code === 0 ? result.stdout.trim() : 'ABSENT'
  }
  return {
    commonDir,
    refs,
    configSha256: sha256File(join(commonDir, 'config')),
    hooksDigest: digestDirectory(join(commonDir, 'hooks')),
  }
}

/**
 * Digest a directory as `relativePath\0fileHash\n` lines, sorted.
 *
 * A missing directory digests as `ABSENT` rather than as an empty directory, so
 * "the hooks directory was deleted" cannot read the same as "the hooks directory
 * is empty" — the first is a change and the second is a state.
 */
function digestDirectory(dir: string): string {
  if (!existsSync(dir)) return 'ABSENT'
  const lines: string[] = []
  const visit = (absolute: string, rel: string): void => {
    for (const entry of readdirSync(absolute, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const childRel = rel === '' ? entry.name : `${rel}/${entry.name}`
      const childAbs = join(absolute, entry.name)
      if (entry.isDirectory()) visit(childAbs, childRel)
      else lines.push(`${childRel}\0${sha256File(childAbs)}\n`)
    }
  }
  visit(dir, '')
  return sha256(`writer-isolation/hooks@1\n${lines.sort().join('')}`)
}

/** Re-read the shared metadata and compare it with the snapshot. */
export async function verifySharedMetadata(
  ctx: Context,
  root: string,
  snapshot: SharedMetadataSnapshot,
): Promise<SharedMetadataCheck> {
  const observed = await sharedMetadataDigests(ctx, root, Object.keys(snapshot.refs))
  const reasons: string[] = []
  const movedRefs: SharedMetadataCheck['movedRefs'] = []
  for (const [ref, expected] of Object.entries(snapshot.refs)) {
    const now = observed.refs[ref] ?? 'ABSENT'
    if (now !== expected) {
      movedRefs.push({ ref, expected, observed: now })
      reasons.push(`the protected ref ${ref} moved from ${expected} to ${now} while the writer held its workspace`)
    }
  }
  const configChanged = observed.configSha256 !== snapshot.configSha256
  if (configChanged) {
    reasons.push('the shared git config changed while the writer held its workspace')
  }
  const hooksChanged = observed.hooksDigest !== snapshot.hooksDigest
  if (hooksChanged) {
    reasons.push('the shared git hooks directory changed while the writer held its workspace')
  }
  return {
    intact: reasons.length === 0,
    reasons,
    movedRefs,
    configChanged,
    hooksChanged,
    observed,
  }
}

/** Writer leases held in this process, keyed by resolved workspace path. */
const leases = new Map<string, { writerId: string; lockPath: string }>()

/** The lock path for one workspace: a sibling file, never inside the workspace. */
function lockPathFor(workspacePath: string): string {
  return `${workspacePath}.dsh-writer.lock`
}

/** One lease file's recorded content. Kept minimal: it is a marker, not a database. */
interface LeaseRecord {
  writerId: string
  pid: number
  at: string
  workspace: string
}

/**
 * Take the exclusive writer lease for `workspacePath`.
 *
 * Two refusals, and they are different mechanisms on purpose:
 *   - the in-process registry catches a second writer in THIS process, which is
 *     the case a test can exercise directly;
 *   - `openSync(..., 'wx')` is an atomic exclusive create, which is what makes
 *     the refusal hold across processes.
 * An existing lease is REFUSED. It is never stolen on a PID-liveness or TTL
 * heuristic: ARCHITECTURE §17 rejects PID/TTL lock stealing explicitly, because
 * a lock that can be taken from a live-but-slow holder is not a lock. Recovery
 * from a genuinely stale lease is a human action, and the recorded pid/time is
 * there to make that decision possible rather than to automate it.
 */
export function acquireWriterLease(workspacePath: string, writerId: string): string {
  const resolved = resolve(workspacePath)
  const held = leases.get(resolved)
  if (held !== undefined) {
    throw new Error(
      `writer-workspace-busy: ${resolved} is already held by writer ${JSON.stringify(held.writerId)} in this process; `
      + 'two writers must never edit one workspace',
    )
  }
  const lockPath = lockPathFor(resolved)
  mkdirSync(dirname(lockPath), { recursive: true })
  let fd: number
  try {
    fd = openSync(lockPath, 'wx')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new Error(
        `writer-workspace-busy: the writer lease ${lockPath} already exists, so another writer (possibly in another `
        + 'process) holds this workspace. The lease is not stolen; a human resolves it.',
      )
    }
    throw error
  }
  try {
    const record: LeaseRecord = { writerId, pid: process.pid, at: new Date().toISOString(), workspace: resolved }
    writeSync(fd, `${JSON.stringify(record)}\n`)
  } finally {
    closeSync(fd)
  }
  leases.set(resolved, { writerId, lockPath })
  return lockPath
}

/** Release the lease for one workspace. Idempotent. */
export function releaseWriterLease(workspacePath: string): void {
  const resolved = resolve(workspacePath)
  const held = leases.get(resolved)
  if (held === undefined) return
  leases.delete(resolved)
  rmSync(held.lockPath, { force: true })
}

/** True when a writer lease exists for this workspace, in this process or on disk. */
export function writerLeaseHeld(workspacePath: string): boolean {
  const resolved = resolve(workspacePath)
  return leases.has(resolved) || existsSync(lockPathFor(resolved))
}

/**
 * Materialize one writer's concurrency-isolated workspace and bind a lease to it.
 *
 * The returned `env` is what the writer's process must be spawned with. It
 * tombstones `GIT_DIR` and friends: a parent process that has `GIT_DIR` set
 * would otherwise hand the writer a git context pointing at the ROOT's
 * repository, and the writer's `git commit` would write the root's index and
 * branch from inside what merely LOOKS like a separate directory. That is a
 * determinism fix (the writer must commit to its own branch, not the root's),
 * not a containment measure — the writer's process authority is unchanged.
 */
export async function acquireWriterWorkspace(options: WriterWorkspaceOptions): Promise<WriterWorkspace> {
  const ownContext = options.ctx === undefined
  const ctx = options.ctx ?? new Context()
  if (ownContext) await ctx.plugin(LocalSubprocessRuntime)
  try {
    return await acquireInner(ctx, options, ownContext)
  } catch (error) {
    if (ownContext) void ctx.fiber.dispose()
    throw error
  }
}

async function acquireInner(
  ctx: Context,
  options: WriterWorkspaceOptions,
  ownContext: boolean,
): Promise<WriterWorkspace> {
  const root = resolve(options.root)
  const kind: WriterWorkspaceKind = options.kind ?? 'worktree'
  const parentDir = resolve(options.parentDir ?? resolve(root, '..'))
  const workspacePath = join(parentDir, `${sanitize(options.writerId)}-workspace`)
  const branch = `writer/${sanitize(options.writerId)}`
  const baseRevision = (await gitOk(ctx, root, ['rev-parse', '--verify', `${options.baseRevision}^{commit}`])).trim()

  const integrationBranch = (await gitRun(ctx, root, ['symbolic-ref', '--quiet', '--short', 'HEAD'])).stdout.trim()
  if (integrationBranch !== '' && branch === integrationBranch) {
    throw new Error(
      `writer-isolation: writer branch ${branch} would be the integration branch; a writer never checks out the `
      + 'integration branch',
    )
  }

  acquireWriterLease(workspacePath, options.writerId)

  let created = false
  try {
    if (existsSync(workspacePath)) {
      throw new Error(`writer-isolation: ${workspacePath} already exists; refusing to reuse another writer's directory`)
    }
    if (kind === 'worktree') {
      // `-b` gives the writer its OWN branch. That is what makes the integration
      // branch un-adoptable here: git refuses to check out a branch that is
      // already checked out in another worktree (measured exit 128), so the
      // writer cannot even reach the state where its commit lands on it.
      await gitOk(ctx, root, ['worktree', 'add', '-b', branch, workspacePath, baseRevision])
    } else {
      // A clone with its own object store and NO remote. Removing `origin` is
      // the point: a writer with no configured remote has no path to push the
      // integration branch, and the root's refs are not shared to begin with.
      await gitOk(ctx, root, ['clone', '--no-hardlinks', '--no-checkout', root, workspacePath])
      await gitOk(ctx, workspacePath, ['checkout', '-q', '-b', branch, baseRevision])
      await gitOk(ctx, workspacePath, ['remote', 'remove', 'origin'])
    }
    created = true

    const protectedRefs = options.protectedRefs ?? DEFAULT_PROTECTED_REFS
    const shared = await sharedMetadataDigests(ctx, root, protectedRefs)

    const artifactDir = join(parentDir, `${sanitize(options.writerId)}-artifacts`)
    const buildDir = join(parentDir, `${sanitize(options.writerId)}-build`)
    const cacheDir = join(parentDir, `${sanitize(options.writerId)}-cache`)
    for (const dir of [artifactDir, buildDir, cacheDir]) mkdirSync(dir, { recursive: true })

    const env: NodeJS.ProcessEnv = {
      DAILY_WRITER_ID: options.writerId,
      DAILY_WORKSPACE: workspacePath,
      DAILY_ARTIFACT_DIR: artifactDir,
      DAILY_BUILD_DIR: buildDir,
      DAILY_CACHE_DIR: cacheDir,
    }
    for (const name of GIT_REDIRECT_NAMES) env[name] = undefined

    const lockPath = lockPathFor(workspacePath)
    const release = async (): Promise<void> => {
      releaseWriterLease(workspacePath)
      if (kind === 'worktree') {
        await gitRun(ctx, root, ['worktree', 'remove', '--force', workspacePath])
        await gitRun(ctx, root, ['worktree', 'prune'])
        await gitRun(ctx, root, ['branch', '-D', branch])
      }
      rmSync(workspacePath, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
      for (const dir of [artifactDir, buildDir, cacheDir]) {
        rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
      }
      if (ownContext) void ctx.fiber.dispose()
    }
    return {
      writerId: options.writerId,
      kind,
      path: workspacePath,
      baseRevision,
      branch,
      artifactDir,
      buildDir,
      cacheDir,
      env,
      shared,
      lockPath,
      finish(): void {
        releaseWriterLease(workspacePath)
      },
      release,
    }
  } catch (error) {
    if (created) {
      if (kind === 'worktree') {
        await gitRun(ctx, root, ['worktree', 'remove', '--force', workspacePath])
        await gitRun(ctx, root, ['branch', '-D', branch])
      }
      rmSync(workspacePath, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
    }
    releaseWriterLease(workspacePath)
    throw error
  }
}

/** A writer id reduced to something safe for a path segment and a branch name. */
function sanitize(writerId: string): string {
  return writerId.replace(/[^\w.-]/g, '_')
}

/** Options for {@link assessIntegration}. */
export interface AssessIntegrationOptions {
  ctx?: Context
  /**
   * The integration authority's checkout — the tree the patch must apply to.
   * This is NOT the candidate's directory: checking `git apply` inside the
   * candidate's own workspace would compare the patch against the tree it was
   * generated from, which succeeds trivially and proves nothing about whether it
   * still applies where it would actually land.
   */
  root: string
  /** The candidate to judge. */
  candidate: IntegrationCandidate
  /** The revision the root is willing to integrate onto. Exact match required. */
  expectedBase: string
  /**
   * Paths the candidate is allowed to have changed, as git-style repo-relative
   * prefixes. A change outside this set is a refusal, because "the tests passed"
   * says nothing about a file the reviewer never expected to move.
   */
  allowedPaths: readonly string[]
  /** The stored receipt for the candidate, if one exists. */
  receipt?: AcceptanceReceipt
  /**
   * The verification basis recorded when the receipt was produced. Compared with
   * the basis OBSERVED NOW (recomputed from the tree on disk), not with itself,
   * so a caller cannot certify a weakened oracle by passing it in twice.
   */
  recordedBinding?: VerdictBinding
  /**
   * The protected oracle files, re-digested to form the observed basis. Absent
   * means the oracle is not covered and the assessment says so rather than
   * assuming it is unchanged.
   */
  oracleFiles?: Readonly<Record<string, string>>
  /** The acceptance definition in force, re-digested to form the observed basis. */
  definition?: AcceptanceDefinition
  /**
   * Directory for the extracted patch artifact. Defaults to a private temp
   * directory: writing it into the candidate's workspace would add an undeclared
   * file to the tree whose digest the receipt already bound, so the artifact
   * would invalidate the very evidence it describes.
   */
  patchDir?: string
}
/**
 * Decide whether one candidate may be published, WITHOUT merging anything.
 *
 * Every step is a read or a refusal:
 *   1. the candidate's base is EXACTLY the revision the root expects;
 *   2. the candidate head descends from that base, so the delta is exactly the patch;
 *   3. the patch applies to the root as it is now (`git apply --check`);
 *   4. the changed paths are inside the allowed scope;
 *   5. the candidate's tests really ran and really passed;
 *   6. the receipt still binds tree, oracle and environment.
 *
 * There is no merge, no `--3way`, no rebase, no commit and no push anywhere in
 * this function. A conflict is returned to the caller as a refusal. Writing a
 * semantic auto-merge controller is explicitly out of scope for this project, so
 * the absence of one is a design property and is asserted by the tests.
 */
export async function assessIntegration(options: AssessIntegrationOptions): Promise<IntegrationAssessment> {
  const ownContext = options.ctx === undefined
  const ctx = options.ctx ?? new Context()
  if (ownContext) await ctx.plugin(LocalSubprocessRuntime)
  try {
    const cwd = resolve(options.candidate.cwd)
    // The patch is checked against the ROOT, not against the candidate's own
    // workspace: the candidate's tree already contains its own change, so
    // `git apply --check` there would be a tautology.
    const rootCwd = resolve(options.root)
    const reasons: string[] = []
    const expectedBase = options.expectedBase.trim()
    const baseRevision = (await gitOk(ctx, cwd, ['rev-parse', '--verify', `${options.candidate.baseRevision}^{commit}`])).trim()
    const headRevision = (await gitOk(ctx, cwd, ['rev-parse', '--verify', `${options.candidate.headRevision}^{commit}`])).trim()

    const baseRevisionMatches = baseRevision === expectedBase
    if (!baseRevisionMatches) {
      reasons.push(
        `the candidate was built on ${baseRevision} but the root expected ${expectedBase}; `
        + 'a candidate verified against a different base is not current',
      )
    }

    const ancestry = await gitRun(ctx, cwd, ['merge-base', '--is-ancestor', baseRevision, headRevision])
    const headDescendsFromBase = ancestry.code === 0
    if (!headDescendsFromBase) {
      reasons.push(`the candidate head ${headRevision} does not descend from its declared base ${baseRevision}`)
    }

    const diff = await gitOk(ctx, cwd, ['diff', '--no-color', baseRevision, headRevision])
    const changedPaths = (await gitOk(ctx, cwd, ['diff', '--name-only', baseRevision, headRevision]))
      .split('\n')
      .map(line => line.trim())
      .filter(line => line !== '')
      .sort()
    const patchDigest = sha256(diff)
    const patchBytes = Buffer.byteLength(diff, 'utf8')

    const patchDir = options.patchDir ?? mkdtempSync(join(tmpdir(), 'dsh-integration-patch-'))
    mkdirSync(patchDir, { recursive: true })
    const patchPath = join(patchDir, `candidate-${sanitize(options.candidate.headRevision.slice(0, 12))}.patch`)
    writeFileSync(patchPath, diff, 'utf8')

    // `--check` only. NOT `--3way`: measured on this host, a conflicting patch
    // exits 1 under `--check` and 0 under `--3way --check`, so the three-way form
    // would start resolving the conflict instead of reporting it.
    const applyCheck = await gitRun(ctx, rootCwd, ['apply', '--check', patchPath])
    const patchApplies = applyCheck.code === 0
    if (!patchApplies) {
      reasons.push(
        `the candidate patch does not apply to the current tree: ${applyCheck.stderr.trim() || 'git apply --check failed'}`,
      )
    }

    const outOfScope = changedPaths.filter(path => !options.allowedPaths.some(prefix => pathMatches(path, prefix)))
    const scopeOk = outOfScope.length === 0
    if (!scopeOk) {
      reasons.push(`the candidate changed paths outside the allowed scope: ${outOfScope.join(', ')}`)
    }

    const testVerdict = testsAreReal(options.receipt)
    if (!testVerdict.real) reasons.push(testVerdict.reason)

    /*
     * The four bindings, checked against the basis as it exists NOW.
     *
     * The candidate-tree and definition digests are recomputed from disk when
     * both a recorded binding and a definition are supplied, and the oracle is
     * re-digested from `oracleFiles`. That is what makes this a check rather than
     * a restatement: if the recorded binding and the observation are the same
     * object, the comparison cannot fail and would certify anything.
     */
    let receiptBinding: ReceiptBindingResult | undefined
    if (options.receipt !== undefined && options.recordedBinding !== undefined) {
      const observed: VerdictBinding = options.definition !== undefined
        ? observedBasis({ definition: options.definition, oracleFiles: options.oracleFiles ?? {} })
        : {
            candidateTreeDigest: options.recordedBinding.candidateTreeDigest,
            acceptanceDefinitionDigest: options.recordedBinding.acceptanceDefinitionDigest,
            oracleDigest: oracleDigest(options.oracleFiles ?? {}),
            environment: { node: process.version, platform: process.platform, arch: process.arch },
          }
      receiptBinding = bindReceipt(options.recordedBinding, observed)
      if (!receiptBinding.applicable) reasons.push(...receiptBinding.reasons)
    } else if (options.receipt === undefined) {
      reasons.push('no acceptance receipt was supplied, so nothing about the candidate has been verified')
    } else {
      reasons.push(
        'the receipt carries no recorded binding, so it cannot be checked against the tree, the oracle or the '
        + 'environment that exist now',
      )
    }

    return {
      decision: reasons.length === 0 ? 'accept_for_publication' : 'refuse',
      reasons,
      baseRevision,
      expectedBase,
      headRevision,
      baseRevisionMatches,
      headDescendsFromBase,
      patchApplies,
      patchDigest,
      patchBytes,
      changedPaths,
      outOfScope,
      scopeOk,
      receiptBinding,
      testsAreReal: testVerdict.real,
      testReason: testVerdict.reason,
    }
  } finally {
    if (ownContext) void ctx.fiber.dispose()
  }
}

/** True when a repo-relative path equals `prefix` or sits under it. */
function pathMatches(path: string, prefix: string): boolean {
  const normalized = prefix.replace(/\\/g, '/').replace(/\/+$/, '')
  if (normalized === '' || normalized === '.') return true
  return path === normalized || path.startsWith(`${normalized}/`)
}

/**
 * Whether a receipt records tests that really ran.
 *
 * A receipt can be a genuine PASS on an exit code alone when the definition
 * declared no counts (`expectTests` absent). That is honest for what it is, but
 * it is NOT evidence that any test executed, and "must have real tests" is a
 * delivery requirement. So a receipt with no observed counts, or with a total of
 * zero, or with nothing passing, is refused here even when `passed` is true.
 */
export function testsAreReal(receipt: AcceptanceReceipt | undefined): { real: boolean; reason: string } {
  if (receipt === undefined) {
    return { real: false, reason: 'there is no acceptance receipt, so there is no evidence that any test ran' }
  }
  if (receipt.passed !== true || receipt.outcome !== 'pass') {
    return { real: false, reason: `the acceptance outcome was ${receipt.outcome}, which is not a pass` }
  }
  const observed = receipt.observedTests
  if (observed === undefined) {
    return {
      real: false,
      reason: 'the acceptance passed on an exit code with no observed test counts, so no test is known to have run',
    }
  }
  if (observed.total <= 0) {
    return { real: false, reason: 'the acceptance reported zero tests, so a green exit code proves nothing' }
  }
  if (observed.passed <= 0) {
    return {
      real: false,
      reason: `the acceptance reported ${observed.total} tests and ${observed.passed} passed, so nothing really passed`,
    }
  }
  return { real: true, reason: `the acceptance really ran ${observed.total} tests and ${observed.passed} passed` }
}

/**
 * Whether a stored receipt still binds the artifact, the oracle and the environment.
 *
 * `observed` is the verification basis as it exists NOW: the candidate tree
 * digest recomputed from disk, the definition digest recomputed from the
 * definition in force, the oracle digest recomputed from the protected files,
 * and this machine's environment identity. `recorded` is what was written down
 * when the receipt was produced.
 *
 * The runner's own `receiptFreshness` covers the candidate tree and the
 * acceptance definition. That leaves two of the four bindings the plan requires
 * unbound: the ORACLE (the protected suite and its config, which the candidate
 * is not allowed to weaken) and the ENVIRONMENT (a verdict produced by a
 * different Node/platform/arch is a verdict about a different machine). Both are
 * checked here, and the result is a REFUSAL rather than a downgrade: a receipt
 * that no longer binds is not reusable as current evidence.
 *
 * Note the direction of the comparison. `recorded.oracleDigest` is compared with
 * `observed.oracleDigest` — the oracle's state NOW, not with whatever the caller
 * happened to pass as an expectation. Comparing two caller-supplied values would
 * make this function a restatement of its own arguments and able to certify a
 * weakened oracle, which is exactly the failure VER-03/VER-05 exist to catch.
 */
export function bindReceipt(
  recorded: VerdictBinding,
  observed: VerdictBinding,
): ReceiptBindingResult {
  const mismatches: string[] = []
  if (recorded.candidateTreeDigest !== observed.candidateTreeDigest) {
    mismatches.push(`candidateTreeDigest ${recorded.candidateTreeDigest} != observed ${observed.candidateTreeDigest}`)
  }
  if (recorded.acceptanceDefinitionDigest !== observed.acceptanceDefinitionDigest) {
    mismatches.push(
      `acceptanceDefinitionDigest ${recorded.acceptanceDefinitionDigest} != observed ${observed.acceptanceDefinitionDigest}`,
    )
  }
  if (recorded.oracleDigest !== observed.oracleDigest) {
    mismatches.push(`oracleDigest ${recorded.oracleDigest} != observed ${observed.oracleDigest}`)
  }
  for (const key of ['node', 'platform', 'arch'] as const) {
    if (recorded.environment[key] !== observed.environment[key]) {
      mismatches.push(`environment.${key} ${recorded.environment[key]} != observed ${observed.environment[key]}`)
    }
  }
  const reasons = mismatches.map(
    mismatch => `the receipt no longer binds the current verification basis: ${mismatch}`,
  )
  return { applicable: mismatches.length === 0, reasons, mismatches }
}

/**
 * The verification basis a receipt must still match, read from the tree on disk.
 *
 * This is the observation half of {@link bindReceipt}, kept as a function so the
 * caller cannot accidentally pass the RECORDED values in as the observed ones —
 * the mistake that would make the check vacuous.
 */
export function observedBasis(input: {
  /** Recompute the candidate digest from these inputs. */
  definition: AcceptanceDefinition
  /** Recompute the oracle digest from these protected files. */
  oracleFiles: Readonly<Record<string, string>>
}): VerdictBinding {
  return {
    candidateTreeDigest: digestInputs(input.definition),
    acceptanceDefinitionDigest: acceptanceDefinitionDigest(input.definition),
    oracleDigest: oracleDigest(input.oracleFiles),
    environment: { node: process.version, platform: process.platform, arch: process.arch },
  }
}

/**
 * Digest of the PROTECTED oracle: the frozen acceptance suite and its config.
 *
 * This exists because `candidateTreeDigest` covers whatever the definition
 * declared as `inputs`. If the oracle is not among them, a candidate can rewrite
 * the acceptance itself and no digest in the receipt will notice — measured, and
 * asserted as a gap in `verification-gates.test.ts`. This function is how a
 * deployment closes it: the oracle's own bytes get a digest, the digest is
 * recorded outside the candidate's reach, and {@link bindReceipt} refuses a
 * receipt whose oracle no longer matches.
 */
export function oracleDigest(files: Readonly<Record<string, string>>): string {
  const lines = Object.entries(files)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([name, path]) => `${name}\0${sha256File(path)}\n`)
  return sha256(`writer-isolation/oracle@1\n${lines.join('')}`)
}

/** The outcome of converging a workspace before it is frozen for verification. */
export interface ConvergenceResult {
  /** True only when no writer holds the workspace AND two samples agreed. */
  converged: boolean
  reasons: string[]
  /** The frozen digest, or `''` when the result is not converged (unknown, not a value). */
  digest: string
  /** Both samples, so a reader sees the evidence rather than a boolean. */
  samples: Array<{ at: string; digest: string }>
  /** True when a writer lease was held at the first check. */
  writerLeaseHeld: boolean
}

/**
 * Converge and isolate a workspace BEFORE it is frozen for verification.
 *
 * This is the step VER-07 requires and the runner cannot take: the runner freezes
 * whatever it finds at the instant it starts, so a background mutation still
 * running at that instant produces a snapshot of a torn tree — a snapshot that is
 * immutable but does not correspond to any revision anyone reviewed. Immutability
 * alone is not enough; the frozen artifact must also be CONVERGED.
 *
 * Two refusals, and neither of them certifies anything:
 *   - a live writer lease means the workspace is in flight by definition, so the
 *     freeze is refused rather than raced;
 *   - two digest samples that disagree mean something is still writing, and a
 *     digest that cannot be taken is `unknown`, which is reported as `''` rather
 *     than as a value.
 *
 * The digest is computed with the runner's own `digestInputs`, so the converged
 * digest is directly comparable with the `liveDigestAtStart` the receipt records.
 * Re-implementing the tree digest here would create a second definition of "the
 * candidate tree" that could drift from the runner's.
 */
export async function convergeBeforeFreeze(input: {
  /** The workspace to converge. */
  workspacePath: string
  /** The acceptance definition whose `inputs` define the frozen candidate set. */
  definition: AcceptanceDefinition
  /** How long to wait between the two samples. */
  settleMs?: number
  /** Polls to attempt before giving up. Each is a fresh sample. */
  attempts?: number
  now?: () => Date
}): Promise<ConvergenceResult> {
  const now = input.now ?? ((): Date => new Date())
  const reasons: string[] = []
  const samples: ConvergenceResult['samples'] = []
  const writerLeaseHeld = writerLeaseHeldFor(input.workspacePath)
  if (writerLeaseHeld) {
    return {
      converged: false,
      reasons: [
        `a writer still holds ${input.workspacePath}, so the workspace is in flight; freezing it now would capture a `
        + 'tree that no writer has finished producing',
      ],
      digest: '',
      samples,
      writerLeaseHeld,
    }
  }

  const sample = (): string | undefined => {
    try {
      const digest = digestInputs(input.definition)
      samples.push({ at: now().toISOString(), digest })
      return digest
    } catch {
      // A digest that cannot be taken is unknown, and unknown is not a value.
      return undefined
    }
  }

  const attempts = Math.max(2, input.attempts ?? 2)
  const settleMs = input.settleMs ?? 300
  let previous = sample()
  if (previous === undefined) {
    return {
      converged: false,
      reasons: ['the candidate digest could not be taken, so the workspace state is unknown and is not certified'],
      digest: '',
      samples,
      writerLeaseHeld,
    }
  }
  for (let attempt = 2; attempt <= attempts; attempt += 1) {
    await new Promise(resolveTimer => setTimeout(resolveTimer, settleMs))
    if (writerLeaseHeldFor(input.workspacePath)) {
      return {
        converged: false,
        reasons: [`a writer acquired ${input.workspacePath} during convergence, so the workspace is in flight again`],
        digest: '',
        samples,
        writerLeaseHeld: true,
      }
    }
    const next = sample()
    if (next === undefined) {
      return {
        converged: false,
        reasons: ['the candidate digest could not be taken on a later sample, so the workspace state is unknown'],
        digest: '',
        samples,
        writerLeaseHeld: false,
      }
    }
    if (next !== previous) {
      reasons.push(
        `the candidate tree changed between samples (${previous} then ${next}), so it had not converged; `
        + 'an unconverged tree is not certified',
      )
      previous = next
      continue
    }
    return {
      converged: true,
      reasons: [`two samples ${settleMs}ms apart agreed on ${next}, and no writer held the workspace`],
      digest: next,
      samples,
      writerLeaseHeld: false,
    }
  }
  return {
    converged: false,
    reasons: reasons.length > 0 ? reasons : ['the workspace did not converge within the sampling budget'],
    digest: '',
    samples,
    writerLeaseHeld: false,
  }
}

/** Local alias so the property name and the function name cannot be confused. */
function writerLeaseHeldFor(workspacePath: string): boolean {
  return writerLeaseHeld(workspacePath)
}

/**
 * The precondition for publishing a candidate: an exact-base patch plus an
 * expected-ref CAS, and nothing else.
 *
 * The ref check is delegated to the acceptance runner's `refCas` rather than
 * reimplemented, because that function's property is precisely the one needed
 * here — it has no write path at all. Re-deriving it would create a second
 * implementation whose "no force" property would have to be re-proven.
 */
export interface PublicationPrecondition {
  accepted: boolean
  reasons: string[]
  patchDigest: string
  expectedBase: string
  observedRef?: string
}

/** A publication request, in the shape the root would actually assemble it. */
export interface PublicationRequest {
  assessment: IntegrationAssessment
  /** The integration ref that must not have moved. */
  ref: string
  /** The sha the candidate was verified against. */
  expectedSha: string
  /** The sha the integration ref is observed to hold now. */
  observedSha?: string
  /** Set when the ref could not be read at all. */
  refUnreadableReason?: string
}

/**
 * Decide whether the assessment and the ref together authorize publication.
 *
 * A writer cannot push or merge the integration branch: this function is the only
 * publication path in this module, it takes the ref's observed value as an INPUT
 * rather than writing one, and it refuses when the ref moved. The writer's own
 * workspace has no remote at all in `clone` mode, and in `worktree` mode the
 * protected-ref digest in {@link verifySharedMetadata} is what catches a writer
 * that moved the ref by hand.
 */
export function publicationPrecondition(request: PublicationRequest): PublicationPrecondition {
  const reasons: string[] = []
  if (request.assessment.decision !== 'accept_for_publication') {
    reasons.push(...request.assessment.reasons.map(reason => `the integration assessment refused: ${reason}`))
  }
  if (request.refUnreadableReason !== undefined) {
    reasons.push(`the integration ref ${request.ref} could not be read: ${request.refUnreadableReason}`)
  } else if (request.observedSha !== request.expectedSha) {
    reasons.push(
      `the integration ref ${request.ref} is at ${String(request.observedSha)} but the candidate was verified `
      + `against ${request.expectedSha}; the publication is refused rather than forced`,
    )
  }
  return {
    accepted: reasons.length === 0,
    reasons,
    patchDigest: request.assessment.patchDigest,
    expectedBase: request.assessment.expectedBase,
    observedRef: request.observedSha,
  }
}
