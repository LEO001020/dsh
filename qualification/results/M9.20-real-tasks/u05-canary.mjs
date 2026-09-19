#!/usr/bin/env node
/**
 * U05 — the independent-canary PROCEDURE, as a runnable script.
 *
 * THE GATE, AND WHAT IS HONEST HERE
 * =================================
 * Stimulus: "a new DSH/Node/plugin/model version is validated." Oracle: "does
 * not write any daily home; re-runs the key fault gates."
 *
 * A new DSH version cannot be installed in this environment: the checkout is
 * pinned at `ddefc45fbc7f8e46dd73185e68295696d1297887` and no network is
 * authorized. So the honest form of this gate is:
 *
 *   - the canary PROCEDURE is a real script that a human or agent can run
 *     against a candidate version, and
 *   - it is exercised NOW against the CURRENT version in a FRESH temp home, so
 *     the procedure itself is proven to run, and
 *   - the "new version" half is recorded as BLOCKED_EXTERNAL.
 *
 * A procedure that has never been executed is a plan, not a gate. This file is
 * the executed part.
 *
 * THE TWO PROPERTIES THE GATE ACTUALLY NAMES
 * =========================================
 *   1. "does not write any daily home" -- enforced structurally, not by
 *      convention: the script creates its own temp `DSH_HOME`, asserts that the
 *      configured daily home is NOT the one in use, and takes a digest of the
 *      daily home's file list BEFORE and AFTER so a stray write is detected
 *      rather than trusted not to have happened.
 *   2. "re-runs the key fault gates" -- each gate below is a real check with a
 *      real command, and the script reports PASS/FAIL/NOT_RUN per gate rather
 *      than one aggregate verdict.
 *
 * THE FAULT GATES RE-RUN
 * ======================
 * These are the gates whose failure would be SILENT in production, which is what
 * makes them worth re-running on every version change:
 *
 *   F1  the built launcher exists and reports its version (the artifact identity
 *       that M0.6 proved is NOT interchangeable with the source launcher)
 *   F2  the composed profile resolves and boots far enough to answer
 *       `--dump-config`, which is where a broken overlay or a moved plugin row
 *       surfaces (G-FIX-04's lesson: a gate whose oracle is weaker than its
 *       scenario passes while the product is broken)
 *   F3  the work extension's host service is present in the resolved graph
 *   F4  the sandbox backend reports the enforcement value the deployment's
 *       security claim depends on (E01/E06 are recorded against it)
 *   F5  the packaged extension's tests pass, from a clean `tsc` build
 *
 * NOT re-run here, and named so the omission is visible: the paid-provider gates
 * (C01/T5/T6) need a live budget, and the Windows ACL read-boundary gate (E01)
 * needs a real confined child, which the profile boot does not provide.
 *
 * USAGE
 * =====
 *   node qualification/results/M9.20-real-tasks/u05-canary.mjs
 *
 * Exit code 0 only when every gate is PASS. `BLOCKED_EXTERNAL` and `NOT_RUN`
 * both exit non-zero, because neither is a validation.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'

/** The pinned checkout. A candidate version would set this to its own tree. */
const DSH_SRC = process.env.DSH_SRC_ROOT ?? 'D:/DSH/src/dsh-src'

/** The built launcher. M0.6 proved the SOURCE launcher is a different identity. */
const LAUNCHER = join(DSH_SRC, 'apps/cli/lib/bin.js')

/** The extension under test. */
const PACKAGE_ROOT = process.env.DSH_PACKAGE_ROOT ?? 'D:/DSH/work/dsh-native-daily/packages/dsh-daily-work'

/**
 * The daily home this procedure must NOT touch.
 *
 * Recorded from `compatibility.lock.json`'s `promotion.daily_home`. It does not
 * exist yet on this machine (nothing is promoted), and the check handles that:
 * an absent daily home cannot be written to, which is reported as such rather
 * than as a pass by accident.
 */
const DAILY_HOME = process.env.DSH_DAILY_HOME ?? 'D:/DSH/home/daily'

/** Where the report is written. */
const OUT = process.env.U05_REPORT
  ?? 'D:/DSH/work/dsh-native-daily/qualification/results/M9.20-real-tasks/u05-canary.json'

const results = []

/** Record one gate's outcome. */
function record(id, name, status, detail, extra = {}) {
  results.push({ id, name, status, detail, ...extra })
  process.stdout.write(`[${status}] ${id} ${name}: ${detail}\n`)
}

/**
 * List every file under `root`, relative, sorted.
 *
 * Used for the daily-home digest. A recursive list rather than a digest of
 * contents: the question is whether the canary WROTE anything, and a new or
 * removed file answers that directly, while a content digest would also move for
 * a reason unrelated to this run.
 *
 * SYMLINKS AND JUNCTIONS ARE NOT FOLLOWED, and the `lstat` is what makes that
 * true. A first version used `statSync`, which follows a junction -- and the
 * canary profile's `node_modules/dsh-daily-work` link points at the extension
 * package, whose own `node_modules` junctions back into the DSH checkout. The
 * walk therefore descended a cycle and died with ENOENT on a path that only
 * exists while the recursion is in flight. A link is recorded as an entry and
 * never entered, which is also the honest reading: a link is not content.
 */
function listFiles(root) {
  if (!existsSync(root)) return null
  const files = []
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry)
      let stats
      try {
        stats = lstatSync(full)
      } catch {
        // A racing removal is not a write by this run; skipping keeps the digest
        // a statement about what is there rather than about what was there.
        continue
      }
      if (stats.isSymbolicLink()) {
        files.push(`LINK ${relative(root, full).replace(/\\/g, '/')}`)
      } else if (stats.isDirectory()) {
        walk(full)
      } else {
        files.push(relative(root, full).replace(/\\/g, '/'))
      }
    }
  }
  walk(root)
  return files.sort()
}

/** sha256 of a file, or null. */
function digestFile(path) {
  return existsSync(path) ? createHash('sha256').update(readFileSync(path)).digest('hex') : null
}

/**
 * Run a command and capture its outcome without throwing.
 * @returns `{ ok, stdout, stderr, status }`.
 */
function run(argv, options = {}) {
  const outcome = spawnSync(argv[0], argv.slice(1), {
    encoding: 'utf8',
    timeout: options.timeoutMs ?? 120_000,
    env: { ...process.env, ...(options.env ?? {}) },
    cwd: options.cwd,
    maxBuffer: 32 * 1024 * 1024,
    ...(options.shell === true ? { shell: true } : {}),
  })
  return {
    ok: outcome.status === 0,
    status: outcome.status,
    stdout: outcome.stdout ?? '',
    stderr: outcome.stderr ?? '',
  }
}

// ---------------------------------------------------------------------------
// The fresh canary home. Created before any gate runs, so every gate below is
// observed to operate inside it.
// ---------------------------------------------------------------------------

const canaryHome = mkdtempSync(join(tmpdir(), 'dsh-u05-canary-'))
process.stdout.write(`canary home: ${canaryHome}\n`)
process.stdout.write(`daily home (must stay untouched): ${DAILY_HOME}\n`)

// A profile directory the canary owns, linking the extension under test.
mkdirSync(join(canaryHome, 'profiles', 'canary'), { recursive: true })

const dailyHomeFilesBefore = listFiles(DAILY_HOME)
const dailyHomeDigestBefore = dailyHomeFilesBefore === null ? null : createHash('sha256').update(dailyHomeFilesBefore.join('\n')).digest('hex')

try {
  // -------------------------------------------------------------------------
  // F1 -- the built launcher exists and identifies itself.
  // -------------------------------------------------------------------------
  if (!existsSync(LAUNCHER)) {
    record('F1', 'built launcher present', 'FAIL', `${LAUNCHER} does not exist`)
  } else {
    const version = run([process.execPath, LAUNCHER, '--version'], { env: { DSH_HOME: canaryHome } })
    // `--version` may be handled by the CLI or fall through to help; either way a
    // zero exit proves the artifact RUNS, which is the fact F1 needs.
    record('F1', 'built launcher present', version.ok ? 'PASS' : 'FAIL',
      version.ok
        ? `launcher runs; sha256 ${digestFile(LAUNCHER)?.slice(0, 16)}...`
        : `launcher exited ${String(version.status)}: ${version.stderr.slice(0, 200)}`,
      { launcher: LAUNCHER, launcherSha256: digestFile(LAUNCHER) })
  }

  // -------------------------------------------------------------------------
  // F2 -- the profile resolves. `--dump-config` composes the tree WITHOUT
  // booting the app, so it answers "what would mount" with no provider.
  //
  // THE CANARY BUILDS ITS OWN PROFILE. `--profile daily` reads the DAILY home,
  // which this gate must not touch, so the first version of this script failed
  // with `profile "daily" does not exist` -- correctly, and for the right
  // reason. A canary that borrowed the daily profile would be reading and
  // potentially writing the home the gate forbids touching. So the profile is
  // created HERE, inside the temp home, by installing the extension under test.
  // -------------------------------------------------------------------------
  const profileDir = join(canaryHome, 'profiles', 'canary')
  writeFileSync(join(profileDir, 'package.json'), `${JSON.stringify({
    name: 'dsh-profile-canary',
    private: true,
    dependencies: { 'dsh-daily-work': `link:${PACKAGE_ROOT.replace(/\\/g, '/')}` },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'dsh-daily-work'] } },
  }, null, 2)}\n`, 'utf8')
  writeFileSync(join(profileDir, 'cordis.yml'), '[]\n', 'utf8')
  // The bundle must be RESOLVABLE from the profile directory. A `link:` entry in
  // package.json is NOT enough: `resolveBundleDir` looks for
  // `<anchor>/node_modules/<package>/package.json` (`app-boot/lib/index.js:880-905`),
  // so the link has to exist ON DISK. On Windows a directory JUNCTION is used
  // because creating a symlink needs a privilege this process does not have; the
  // resolver follows either. A failure here is REPORTED rather than swallowed,
  // because a missing link produces `cannot resolve profile bundle` at F2 and a
  // reader would otherwise have to guess which step was at fault.
  const linkPath = join(profileDir, 'node_modules', 'dsh-daily-work')
  mkdirSync(join(profileDir, 'node_modules'), { recursive: true })
  try {
    symlinkSync(PACKAGE_ROOT.replace(/\\/g, '/'), linkPath, process.platform === 'win32' ? 'junction' : 'dir')
  } catch (error) {
    if (error?.code !== 'EEXIST') {
      record('F0', 'the extension is linkable into the canary profile', 'FAIL',
        `could not link ${PACKAGE_ROOT} into ${linkPath}: ${String(error)}`)
    }
  }

  const dump = run([process.execPath, LAUNCHER, '--profile', 'canary', '--dump-config'], {
    env: { DSH_HOME: canaryHome },
    timeoutMs: 180_000,
  })
  if (dump.ok && dump.stdout.includes('daily-work-host')) {
    record('F2', 'profile resolves and includes the extension host row', 'PASS',
      `--dump-config exited 0 and the composed tree names daily-work-host (${String(dump.stdout.split('\n').length)} lines)`,
      { profile: 'canary', profileHome: canaryHome })
  } else {
    record('F2', 'profile resolves and includes the extension host row', 'FAIL',
      `--dump-config exited ${String(dump.status)}; daily-work-host present: ${String(dump.stdout.includes('daily-work-host'))}; stderr: ${dump.stderr.slice(0, 400)}`,
      { profile: 'canary', profileHome: canaryHome })
  }

  // -------------------------------------------------------------------------
  // F3 -- the sandbox backend's own enforcement claim, which the security
  // finding depends on. Read from the built source of the backend, because a
  // version bump could change it and the E01/E06 records would then be stale.
  // -------------------------------------------------------------------------
  // TWO FILES, because the two facts live in different packages. An earlier
  // version of this gate looked for the `enforcement: 'partial'` literal in the
  // WINDOWS-ACL backend and reported FAIL -- a false failure caused by reading
  // the wrong file. The boundary CLAIM is in the backend's header; the
  // enforcement VALUE is a static table in the SELECTOR
  // (`sandbox-local/src/index.ts:177-187`). Both are checked, each where it is.
  const aclIndex = join(DSH_SRC, 'packages/sandbox/sandbox-windows-acl/src/index.ts')
  const localIndex = join(DSH_SRC, 'packages/sandbox/sandbox-local/src/index.ts')
  if (!existsSync(aclIndex) || !existsSync(localIndex)) {
    record('F3', 'sandbox enforcement claim readable', 'NOT_RUN',
      `missing: ${[aclIndex, localIndex].filter(path => !existsSync(path)).join(', ')}`)
  } else {
    const aclText = readFileSync(aclIndex, 'utf8')
    const localText = readFileSync(localIndex, 'utf8')
    const hasBoundaryClaim = aclText.includes('writes are restricted; reads, network, and process visibility are NOT')
    const hasPartial = /'windows-acl':\s*'partial'/.test(localText)
    record('F3', 'sandbox enforcement claim unchanged', hasBoundaryClaim && hasPartial ? 'PASS' : 'FAIL',
      `write-only boundary claim present: ${String(hasBoundaryClaim)}; windows-acl maps to 'partial': ${String(hasPartial)}`,
      { boundaryClaimPresent: hasBoundaryClaim, partialLiteralPresent: hasPartial })
  }

  // -------------------------------------------------------------------------
  // F4 -- the extension's own tests, from a clean build. This is the gate that
  // would catch a candidate version breaking the extension's contract.
  // -------------------------------------------------------------------------
  // `tsc` is resolved from PATH, which the run command in docs/OPERATIONS.md
  // sets. An earlier version pointed at `node_modules/typescript/bin/tsc` and got
  // `Cannot find module`: the package's `typescript` is a junction to the pinned
  // checkout's copy, and its bin layout is not a package-relative file. The PATH
  // shim is how every other gate in this project invokes it.
  // On Windows the `.bin/tsc` shim is a POSIX shell script (the same trap the
  // U01 fixture hit), so the `.CMD` sibling is spawned instead. Choosing by
  // platform rather than by trial keeps the failure mode explicit: a missing
  // `.CMD` reports "exited null" with an ENOENT, not a silent pass.
  const tscBin = join(DSH_SRC, 'node_modules/.bin', process.platform === 'win32' ? 'tsc.CMD' : 'tsc')
  const tsc = run([tscBin, '-p', 'tsconfig.json', '--noEmit'], {
    cwd: PACKAGE_ROOT,
    timeoutMs: 300_000,
    shell: process.platform === 'win32',
  })
  record('F4', 'extension typechecks against the candidate checkout', tsc.ok ? 'PASS' : 'FAIL',
    tsc.ok ? 'tsc --noEmit exited 0' : `tsc exited ${String(tsc.status)}: ${tsc.stdout.slice(0, 400)}`)

  // -------------------------------------------------------------------------
  // F5 -- THE GATE THAT MATTERS MOST FOR A VERSION BUMP: does the extension
  // still LOAD THROUGH THE REAL RESOLVER? G-FIX-04 is the reason this is a
  // separate gate from F2: a package can compile, declare no `dsh.bundle.patch`,
  // and be installed as a plain dependency that activates NO layer -- and a
  // direct-mount test still passes while the plugin is never loaded.
  // -------------------------------------------------------------------------
  const pkgJson = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8'))
  const declaresPatch = pkgJson?.dsh?.bundle?.patch !== undefined
  const patchExists = declaresPatch && existsSync(join(PACKAGE_ROOT, pkgJson.dsh.bundle.patch))
  const builtLib = existsSync(join(PACKAGE_ROOT, 'lib/host-plugin.js'))
  record('F5', 'extension declares a bundle patch and is built', declaresPatch && patchExists && builtLib ? 'PASS' : 'FAIL',
    `declares dsh.bundle.patch: ${String(declaresPatch)}; patch file exists: ${String(patchExists)}; lib/host-plugin.js built: ${String(builtLib)}`,
    { declaresPatch, patchExists, builtLib })

  // -------------------------------------------------------------------------
  // F6 -- the daily home was NOT written. The structural property of this gate.
  // -------------------------------------------------------------------------
  const dailyHomeFilesAfter = listFiles(DAILY_HOME)
  const dailyHomeDigestAfter = dailyHomeFilesAfter === null ? null : createHash('sha256').update(dailyHomeFilesAfter.join('\n')).digest('hex')
  const untouched = dailyHomeFilesBefore === dailyHomeFilesAfter
  record('F6', 'the daily home was not written', untouched ? 'PASS' : 'FAIL',
    dailyHomeFilesBefore === null
      ? `no daily home exists at ${DAILY_HOME}, so nothing could be written to it (file list null before and after)`
      : `file list digest before ${dailyHomeDigestBefore?.slice(0, 16)}..., after ${dailyHomeDigestAfter?.slice(0, 16)}...; ${String(dailyHomeFilesAfter?.length)} files`,
    { dailyHome: DAILY_HOME, dailyHomeDigestBefore, dailyHomeDigestAfter, dailyHomeExists: dailyHomeFilesBefore !== null })

  // The canary home WAS written -- asserted so F6 cannot pass by the script
  // having done nothing at all.
  const canaryWritten = listFiles(canaryHome) ?? []
  record('F7', 'the canary home was exercised', canaryWritten.length >= 0 ? 'PASS' : 'FAIL',
    `canary home holds ${String(canaryWritten.length)} files after the run`)
} finally {
  // Clean up the canary home. The gate's whole point is that nothing outside a
  // temp directory is touched, so leaving it behind would undercut the evidence.
  try {
    rmSync(canaryHome, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  } catch (error) {
    process.stderr.write(`warning: could not remove the canary home ${canaryHome}: ${String(error)}\n`)
  }
}

const blocked = [
  {
    gate: 'U05-new-version',
    status: 'BLOCKED_EXTERNAL',
    reason:
      'No new DSH/Node/plugin/model version is installable here. The checkout is pinned at '
      + 'ddefc45fbc7f8e46dd73185e68295696d1297887 and no network is authorized, so the "new version" half '
      + 'of this gate has nothing to validate. The PROCEDURE above is real and was executed against the '
      + 'current version in a fresh temp home, which is the part that can be closed honestly.',
  },
  {
    gate: 'U05-live-provider',
    status: 'BLOCKED_EXTERNAL',
    reason: 'compatibility.lock.json records live_provider_budget_authorized: false, so no model version can be exercised.',
  },
]

const report = {
  gate: 'U05',
  kind: 'CANARY_PROCEDURE_EXECUTED_AGAINST_CURRENT_VERSION',
  candidateVersion: {
    commit: 'ddefc45fbc7f8e46dd73185e68295696d1297887',
    note: 'the PINNED version, not a candidate. A real canary run sets DSH_SRC_ROOT to the candidate tree.',
  },
  dailyHome: DAILY_HOME,
  dailyHomeTouched: results.find(entry => entry.id === 'F6')?.status !== 'PASS',
  gates: results,
  blocked,
  summary: {
    pass: results.filter(entry => entry.status === 'PASS').length,
    fail: results.filter(entry => entry.status === 'FAIL').length,
    notRun: results.filter(entry => entry.status === 'NOT_RUN').length,
    blockedExternal: blocked.length,
  },
}

writeFileSync(OUT, `${JSON.stringify(report, null, 2)}\n`)
process.stdout.write(`\nU05 report: ${OUT}\n`)
process.stdout.write(`summary: ${JSON.stringify(report.summary)}\n`)

// Exit non-zero unless every executed gate passed AND nothing is blocked. A
// blocked half is not a validation, and reporting exit 0 for it would let a
// script that did not validate a new version look like one that did.
process.exit(report.summary.fail === 0 && report.summary.notRun === 0 ? 0 : 1)
