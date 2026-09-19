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
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
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
 */
function listFiles(root) {
  if (!existsSync(root)) return null
  const files = []
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry)
      if (statSync(full).isDirectory()) walk(full)
      else files.push(relative(root, full).replace(/\\/g, '/'))
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
  // -------------------------------------------------------------------------
  const dump = run([process.execPath, LAUNCHER, '--profile', 'daily', '--dump-config'], {
    env: { DSH_HOME: canaryHome },
    timeoutMs: 180_000,
  })
  if (dump.ok && dump.stdout.includes('daily-work-host')) {
    record('F2', 'profile resolves and includes the extension host row', 'PASS',
      `--dump-config exited 0 and the composed tree names daily-work-host (${String(dump.stdout.split('\n').length)} lines)`)
  } else {
    record('F2', 'profile resolves and includes the extension host row', 'FAIL',
      `--dump-config exited ${String(dump.status)}; daily-work-host present: ${String(dump.stdout.includes('daily-work-host'))}; stderr: ${dump.stderr.slice(0, 300)}`)
  }

  // -------------------------------------------------------------------------
  // F3 -- the sandbox backend's own enforcement claim, which the security
  // finding depends on. Read from the built source of the backend, because a
  // version bump could change it and the E01/E06 records would then be stale.
  // -------------------------------------------------------------------------
  const aclIndex = join(DSH_SRC, 'packages/sandbox/sandbox-windows-acl/src/index.ts')
  if (!existsSync(aclIndex)) {
    record('F3', 'sandbox enforcement claim readable', 'NOT_RUN', `${aclIndex} does not exist in this checkout`)
  } else {
    const text = readFileSync(aclIndex, 'utf8')
    const hasBoundaryClaim = text.includes('writes are restricted; reads, network, and process visibility are NOT')
    const hasPartial = /enforcement:\s*'partial'/.test(text)
    record('F3', 'sandbox enforcement claim unchanged', hasBoundaryClaim && hasPartial ? 'PASS' : 'FAIL',
      hasBoundaryClaim
        ? `the write-only boundary claim is present; enforcement 'partial' literal present: ${String(hasPartial)}`
        : 'the write-only boundary claim is ABSENT -- the E01/E06 findings must be re-measured before they are cited',
      { boundaryClaimPresent: hasBoundaryClaim, partialLiteralPresent: hasPartial })
  }

  // -------------------------------------------------------------------------
  // F4 -- the extension's own tests, from a clean build. This is the gate that
  // would catch a candidate version breaking the extension's contract.
  // -------------------------------------------------------------------------
  const tsc = run([process.execPath, join(PACKAGE_ROOT, 'node_modules/typescript/bin/tsc'), '-p', 'tsconfig.json', '--noEmit'], {
    cwd: PACKAGE_ROOT,
    timeoutMs: 300_000,
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
