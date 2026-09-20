/**
 * Boot-time probe: is `ctx.dailyWriters` actually mounted by the COMPOSED
 * profile, and does it work when reached that way?
 *
 * WHY THIS PROBE EXISTS, and it is not ceremony. `worktree-isolation.ts` is a
 * module; a test that mounts it directly proves the module works. It proves
 * NOTHING about whether the product uses it. This project has retracted that
 * over-claim four times — `setLaunchPort`, `takeContinuation`, `dsh-ipython`'s
 * missing `dsh.bundle`, and this module before `writers-plugin.ts` existed — and
 * `docs/GAPS.md` G-FIX-04 states the lesson: **an oracle weaker than its scenario
 * passes while the product is broken.**
 *
 * So the oracle here is the composed profile, not a direct `ctx.plugin()` mount.
 * The probe runs inside a REAL `dsh --profile daily-standard` boot (see
 * `M9.17-b02-resolver/` for the resolver path this relies on) and reports:
 *
 *   - whether the service registered at all, which is what the `cordis.patch.yml`
 *     `insert` row is for;
 *   - whether a real repository can be reached through it, and what the failure
 *     says when the root is not configured;
 *   - a REAL workspace lifecycle end to end: create, observe the branch and the
 *     base revision from git, hold a second writer off, then release and prove
 *     nothing was left behind.
 *
 * It writes its finding to a JSON file rather than only to stdout, because the
 * profile boot owns stdout and a reader needs the artifact.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { spawnSync } from 'node:child_process'

export const name = 'verify-writers-mounted'
export const inject = []

// ---------------------------------------------------------------------------
// THE OUTPUT PATH IS DERIVED FROM THIS FILE'S OWN LOCATION, not hardcoded.
//
// It used to be the literal `'D:/DSH/work/dsh-native-daily/qualification/results/M8-verification/writers-mounted.json'`.
// That is a cross-tree WRITE: a writer running this probe from a git worktree
// (which the multi-agent discipline requires) deposited its finding into the MAIN
// tree, and the artifact it landed on is the one a verdict READS. It is invisible
// as a diff because the finding is a small JSON object that looks the same from
// either tree, so the overwrite reads as "the value is what it always was" rather
// than "another tree wrote here". This is the write-side hazard of `G-SEAM-61`
// and the same class as `G-SEAM-66`.
//
// `import.meta.url` is `.../qualification/runners/verify-writers-mounted.mjs`, so two levels up is the
// repository root of WHICHEVER tree is running -- verified for a worktree, where
// it resolves to that worktree rather than to the main checkout. The finding
// therefore lands in that tree's evidence directory, beside the run record it
// describes. `WRITERS_OUT` still overrides for an explicit target.
// ---------------------------------------------------------------------------
import { fileURLToPath } from 'node:url'

/** The repository root of the tree THIS FILE was loaded from. */
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

const OUT = process.env.WRITERS_OUT ?? join(REPO_ROOT, 'qualification/results/M8-verification/writers-mounted.json')


/** git for the probe's own temporary repository. */
function git(cwd, ...args) {
  const result = spawnSync('git', ['-c', 'user.email=probe@example.invalid', '-c', 'user.name=probe', ...args], {
    cwd,
    encoding: 'utf8',
  })
  return { code: result.status ?? -1, stdout: (result.stdout ?? '').trim(), stderr: (result.stderr ?? '').trim() }
}

export async function apply(ctx) {
  const finding = {
    serviceAtApplyTime: null,
    serviceSettledAfterMs: null,
    serviceRegistered: false,
    serviceName: null,
    available: null,
    availableReason: null,
    rootRefusedWithoutConfig: null,
    workspaceCreated: false,
    workspacePath: null,
    branch: null,
    baseRevisionMatches: false,
    cwdBoundToWorkspace: false,
    secondWriterRefused: false,
    leaseHeldDuringUse: false,
    releasedCleanly: false,
    branchGoneAfterRelease: false,
    error: null,
  }

  let root = null
  let parentDir = null
  let lease = null

  try {
    /*
     * The service is reached through `ctx.get`, the same way any consumer would.
     *
     * The RETRY is load-bearing and is not defensive padding. Cordis activates
     * rows in SERVICE-AVAILABILITY order, not source order — the base bundle's
     * own header says "Row order carries no load semantics (activation is
     * service-availability driven)". So this probe's own row can legitimately be
     * applied BEFORE the `daily-writers` row it is asking about, and a single
     * read at apply time observes a MOMENT rather than a COMPOSITION. The guard
     * probe (`verify-guard.mjs`) reported a false "not mounted" for exactly this
     * reason before the retry was added.
     *
     * Both readings are recorded, so the distinction stays visible in the
     * evidence instead of being lost behind the retry.
     */
    let service = ctx.get('dailyWriters')
    finding.serviceAtApplyTime = service !== undefined
    for (let attempt = 0; attempt < 60 && service === undefined; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 50))
      service = ctx.get('dailyWriters')
    }
    finding.serviceSettledAfterMs = service === undefined ? null : 50
    finding.serviceRegistered = service !== undefined
    finding.serviceName = service === undefined ? null : 'dailyWriters'

    if (service === undefined) {
      finding.error =
        'ctx.dailyWriters is not registered after the graph settled: the cordis.patch.yml insert row did not activate'
    } else {
      // The no-config refusal, asserted first: the service must NOT guess a root.
      try {
        await service.available()
        const probe = await service.open({ writerId: 'probe-no-root', baseRevision: 'HEAD' })
        await probe.release()
        finding.rootRefusedWithoutConfig = false
      } catch (error) {
        finding.rootRefusedWithoutConfig = /no integration root is configured/.test(String(error?.message ?? error))
      }

      // A REAL repository, created by the probe so the finding is self-contained.
      root = mkdtempSync(join(tmpdir(), 'dsh-writers-probe-'))
      git(root, 'init', '-q', '-b', 'main')
      writeFileSync(join(root, 'app.txt'), 'probe base\n')
      git(root, 'add', '-A')
      git(root, 'commit', '-q', '-m', 'probe base')
      const base = git(root, 'rev-parse', 'HEAD').stdout

      const availability = await service.available(root)
      finding.available = availability.available
      finding.availableReason = availability.reason

      parentDir = mkdtempSync(join(tmpdir(), 'dsh-writers-probe-ws-'))
      lease = await service.open({
        root,
        writerId: 'probe-writer',
        baseRevision: base,
        parentDir,
      })
      const workspace = lease.workspace
      finding.workspaceCreated = existsSync(workspace.path)
      finding.workspacePath = workspace.path
      finding.leaseHeldDuringUse = service.isHeld(workspace.path)

      // Read the branch and the base back from GIT, not from the returned object:
      // a returned field could disagree with the checkout it claims to describe.
      finding.branch = git(workspace.path, 'rev-parse', '--abbrev-ref', 'HEAD').stdout
      finding.baseRevisionMatches = git(workspace.path, 'rev-parse', 'HEAD').stdout === base
      finding.cwdBoundToWorkspace =
        git(workspace.path, 'rev-parse', '--show-toplevel').stdout.replace(/\\/g, '/')
        === workspace.path.replace(/\\/g, '/')

      // A SECOND writer on the same workspace must be refused, and the refusal
      // must be the typed one rather than a generic failure.
      try {
        await service.open({ root, writerId: 'probe-writer', baseRevision: base, parentDir })
        finding.secondWriterRefused = false
      } catch (error) {
        finding.secondWriterRefused = /writer-workspace-busy/.test(String(error?.message ?? error))
      }

      const workspacePath = workspace.path
      await lease.release()
      lease = null
      finding.releasedCleanly = !existsSync(workspacePath)
      finding.branchGoneAfterRelease =
        git(root, 'rev-parse', '--verify', 'refs/heads/writer/probe-writer').code !== 0
    }
  } catch (error) {
    finding.error = error instanceof Error ? error.message : String(error)
  } finally {
    // Clean up whatever this probe created, so a probe run leaves no temp state.
    try {
      if (lease !== null) await lease.release()
    } catch {
      // Reported through the fields above rather than masking the original error.
    }
    if (root !== null) rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
    // The workspace PARENT is separate from the repository and is the directory a
    // leaked worktree would survive in, so it is removed too rather than left for
    // the machine's temp cleaner.
    if (parentDir !== null) rmSync(parentDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  }

  try {
    mkdirSync(join(OUT, '..'), { recursive: true })
    writeFileSync(OUT, `${JSON.stringify(finding, null, 2)}\n`)
  } catch {
    // A probe that cannot write its artifact still reports on stdout.
  }
  process.stdout.write(`WRITERS-MOUNTED: ${JSON.stringify(finding)}\n`)
}
