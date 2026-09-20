/**
 * F11 / `ID-06` — the qualification source plane must be CLEAN before a launch.
 *
 * WHY THIS FILE EXISTS. `ID-06`'s oracle is "the working tree is clean and HEAD
 * equals the pinned commit". The V1 audit measured that tree and found three
 * entries, and filed FAIL. The audit's own judgement (V3 §G2) is not "make daily
 * development stricter" but "distinguish a DEVELOPER workspace from a
 * QUALIFICATION source plane":
 *
 *   - a developer workspace may be dirty -- that is what a workspace is for;
 *   - the qualification source plane may not be, and a run that starts on a
 *     dirty plane must FAIL BEFORE LAUNCH rather than produce a verdict whose
 *     source identity nobody can state.
 *
 * So this script is a PRECONDITION, not a verdict about the product. It answers
 * one question: "is the checkout I am about to qualify against the pinned
 * checkout, with nothing tracked-modified, nothing staged, and no generated
 * state written into it?"
 *
 * WHAT IT IS NOT. It is not an identity check, and this distinction is the
 * substance of the audit's finding rather than a nicety. The deployment
 * identity is the built launcher digest + lockfile + profile/preset digests +
 * the resolved graph, and `helpers/doctor.py` re-derives and verifies it. Git
 * cleanliness is an ENVIRONMENT PRECONDITION for a qualification run and is NOT
 * part of the artifact identity. A dirty checkout does not by itself make the
 * artifact a different artifact; it makes the run's provenance unstateable.
 * V1 conflated the two, and this file exists partly so the project stops doing
 * that.
 *
 * THE THREE ENTRY KINDS ARE NOT THE SAME KIND OF THING, so each is classified
 * and named rather than collapsed into "dirty":
 *
 *   CONTENT_MODIFICATION  a tracked file whose blob differs from HEAD's blob.
 *                         Real, and the thing this gate is about.
 *   STAGED_CHANGE         anything in the index that HEAD does not have.
 *   UNTRACKED_GENERATED   a path in the tree that the commit does not contain.
 *                         For this project that has meant DSH_HOME, an artifact
 *                         store, or a qualification output directory written
 *                         inside the checkout.
 *   EOL_STAT_DIRTY        a tracked file whose WORKTREE BYTES differ from
 *                         HEAD's but whose FILTERED BLOB ID is byte-identical.
 *                         This is a line-ending artifact of `core.autocrlf`
 *                         against the repo's `* text=auto eol=lf`, not an edit.
 *                         It is reported as its own class WITH the blob ids that
 *                         prove it, because "the tree is modified" is a
 *                         misleading sentence to hand an operator when the
 *                         content is provably unchanged. It still BLOCKS,
 *                         because the oracle's machine-checkable definition of
 *                         clean is an empty `git status --porcelain` and a gate
 *                         that quietly redefined that would be a weaker oracle.
 *
 * THE REMEDY FOR EOL_STAT_DIRTY IS DELIBERATELY NOT AUTOMATED HERE. The fix is
 * `git add --renormalize <path>`, which rewrites the shared index. That is a
 * write to a tree this qualification gate does not own, and this project has
 * already paid for five git accidents in a shared worktree (G-SEAM-35,
 * G-SEAM-42). The script therefore NAMES the remedy and refuses to run it.
 *
 * Exit codes, matching the other runners in this directory:
 *   0  the source plane is clean at the pinned commit
 *   1  it is not (every entry is printed with its class and its remedy)
 *   2  the invocation, the lock file, or the checkout is unusable -- which is
 *      NOT a verdict about the plane and must not be read as one
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

const REPO_ROOT = resolve(import.meta.dirname, '..', '..')
const LOCK_PATH = resolve(REPO_ROOT, 'compatibility.lock.json')

function fail(message) {
  process.stderr.write(`check-source-plane: ${message}\n`)
  process.exit(2)
}

/** Run git in the checkout and return stdout, or throw with git's own message. */
function git(checkout, args) {
  return execFileSync('git', ['-C', checkout, ...args], {
    encoding: 'utf8',
    // A checkout path with spaces or non-ASCII must not be re-split by a shell,
    // and `execFileSync` without a shell is what guarantees that.
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 32 * 1024 * 1024,
  })
}

function gitQuiet(checkout, args) {
  try {
    return { ok: true, stdout: git(checkout, args) }
  } catch (error) {
    return {
      ok: false,
      stdout: String(error.stdout ?? ''),
      stderr: String(error.stderr ?? ''),
      status: error.status ?? null,
    }
  }
}

function parseArgs(argv) {
  const options = { checkout: null, quiet: false, json: false }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--checkout') {
      options.checkout = argv[i + 1] ?? null
      if (options.checkout === null) fail('--checkout needs a path')
      i += 1
    } else if (arg === '--quiet') {
      options.quiet = true
    } else if (arg === '--json') {
      options.json = true
    } else {
      fail(`unrecognised argument: ${arg}`)
    }
  }
  return options
}

/**
 * The checkout path is DERIVED from the lock, not typed here.
 *
 * The same discipline as `build-gates.py` reading the identity out of the lock:
 * a path duplicated in two places is a path that can disagree with itself, and
 * this project has already recorded a stale pin as a defect class (G-FIX-11,
 * G-FIX-14). `launcher_realpath` is `.../apps/cli/lib/bin.js`, so the checkout
 * is three directories up from the launcher's own directory.
 */
function resolveCheckout(override) {
  if (override !== null) return resolve(override)
  if (!existsSync(LOCK_PATH)) fail(`no lock file at ${LOCK_PATH}`)
  let lock
  try {
    lock = JSON.parse(readFileSync(LOCK_PATH, 'utf8'))
  } catch (error) {
    fail(`the lock file is unreadable: ${String(error.message)}`)
  }
  const launcher = lock?.deployment?.inputs?.launcher_realpath
  if (typeof launcher !== 'string' || launcher.length === 0) {
    fail('the lock records no deployment.inputs.launcher_realpath to derive the checkout from')
  }
  return resolve(dirname(dirname(dirname(dirname(launcher)))))
}

function expectedCommit() {
  if (!existsSync(LOCK_PATH)) fail(`no lock file at ${LOCK_PATH}`)
  const lock = JSON.parse(readFileSync(LOCK_PATH, 'utf8'))
  const commit = lock?.deployment?.inputs?.upstream_commit
  if (typeof commit !== 'string' || !/^[0-9a-f]{40}$/.test(commit)) {
    fail('the lock records no usable deployment.inputs.upstream_commit')
  }
  return commit
}

/**
 * Classify ONE `git status --porcelain` entry.
 *
 * `git status` is used rather than `git diff` because the oracle's stimulus
 * names `git status --porcelain`, and a gate that measured something else would
 * be answering a different question than the one that was filed.
 */
function classify(checkout, entry) {
  const { code, path } = entry

  if (code === '??') {
    return {
      kind: 'UNTRACKED_GENERATED',
      detail: 'the commit does not contain this path',
      remedy:
        'Move it OUT of the checkout (it is generated state: a DSH_HOME, an artifact store, or qualification output). ' +
        'Never delete it sight-unseen -- it may hold real sessions.',
    }
  }

  const staged = code[0]
  const worktree = code[1]

  if (staged !== ' ' && staged !== '?') {
    return {
      kind: 'STAGED_CHANGE',
      detail: `the index differs from HEAD (${code})`,
      remedy: 'Unstage it, or commit it in the tree that owns it. The qualification plane is not a branch.',
    }
  }

  if (worktree === 'D') {
    return {
      kind: 'CONTENT_DELETION',
      detail: 'the file is gone from the worktree',
      remedy: 'Restore it from the pinned commit in a tree you own; do not leave a deleted tracked file in the plane.',
    }
  }

  if (worktree === 'M' || worktree === 'T') {
    // The whole point of the EOL class: compare BLOBS, not bytes. `hash-object`
    // applies the repo's clean filter (and the `* text=auto eol=lf` attribute),
    // so a CRLF worktree file and an LF blob hash the same when the content is
    // the same -- which is exactly the distinction the operator needs.
    const worktreeBlob = gitQuiet(checkout, ['hash-object', path])
    const headBlob = gitQuiet(checkout, ['rev-parse', `HEAD:${path}`])
    if (worktreeBlob.ok && headBlob.ok) {
      const a = worktreeBlob.stdout.trim()
      const b = headBlob.stdout.trim()
      if (a.length === 40 && a === b) {
        return {
          kind: 'EOL_STAT_DIRTY',
          detail: `no content delta: worktree blob == HEAD blob (${a.slice(0, 12)}...)`,
          remedy:
            `git -C "${checkout}" add --renormalize -- "${path}"  # rewrites the shared index; run it deliberately, never from a gate`,
        }
      }
      return {
        kind: 'CONTENT_MODIFICATION',
        detail: `worktree blob ${a.slice(0, 12)}... != HEAD blob ${b.slice(0, 12)}...`,
        remedy: 'A real edit. The qualification plane must be the pinned commit, byte for byte.',
      }
    }
    return {
      kind: 'CONTENT_MODIFICATION',
      detail: 'worktree differs from HEAD and the blob comparison could not be made',
      remedy: 'Inspect it by hand; the gate could not prove the difference is cosmetic.',
    }
  }

  return {
    kind: 'OTHER_MODIFICATION',
    detail: `unclassified status code ${JSON.stringify(code)}`,
    remedy: 'Inspect it by hand and extend this classifier rather than ignoring it.',
  }
}

/**
 * Inspect a checkout and return the report. PURE with respect to the checkout:
 * it reads git state and returns a value, so a caller can use it as a
 * precondition without the module exiting the process under it.
 *
 * Throws only when the checkout or git is unusable -- which is deliberately NOT
 * the same as "the plane is dirty", because a broken rig must not be reported as
 * a verdict about the source plane.
 */
export function inspectSourcePlane(checkout, pinned) {
  if (!existsSync(checkout)) throw new Error(`the checkout does not exist: ${checkout}`)

  const inside = gitQuiet(checkout, ['rev-parse', '--is-inside-work-tree'])
  if (!inside.ok || inside.stdout.trim() !== 'true') {
    throw new Error(`not a git work tree: ${checkout}`)
  }

  const head = gitQuiet(checkout, ['rev-parse', 'HEAD'])
  if (!head.ok) throw new Error(`git rev-parse HEAD failed in ${checkout}`)
  const headCommit = head.stdout.trim()

  const status = gitQuiet(checkout, ['status', '--porcelain'])
  if (!status.ok) throw new Error(`git status --porcelain failed in ${checkout}`)

  const entries = []
  for (const raw of status.stdout.split('\n')) {
    if (raw.length === 0) continue
    // Porcelain v1: two status columns, a space, then the path. Renames carry
    // " -> ", and this gate does not need to follow them -- either way the path
    // is not what the commit says it should be.
    const code = raw.slice(0, 2)
    const rest = raw.slice(3)
    const path = rest.includes(' -> ') ? rest.split(' -> ')[1] : rest
    entries.push({ code, path, ...classify(checkout, { code, path }) })
  }

  const headMatches = headCommit === pinned
  return {
    checkout,
    head: headCommit,
    pinned,
    headMatches,
    clean: headMatches && entries.length === 0,
    entries,
  }
}

/**
 * The precondition, for a caller that is about to launch a qualification run.
 *
 * Returns the report. THROWS if the plane is not clean, so a caller cannot
 * ignore a false return by accident. This is the entry point a boot/qualification
 * path should use; `main` below is the CLI wrapper around the same code.
 */
export function assertCleanSourcePlane(options = {}) {
  const checkout = resolveCheckout(options.checkout ?? null)
  const report = inspectSourcePlane(checkout, options.pinned ?? expectedCommit())
  if (!report.clean) {
    const lines = report.entries.map(
      (e) => `  ${e.code} ${e.path}  [${e.kind}] -- ${e.remedy}`,
    )
    throw new Error(
      `the qualification source plane is NOT clean, so a run must not start.\n`
      + `  checkout: ${report.checkout}\n`
      + `  HEAD:     ${report.head}\n`
      + `  pinned:   ${report.pinned}\n`
      + (report.headMatches ? '' : '  HEAD IS MOVED\n')
      + (lines.length > 0 ? `${lines.join('\n')}\n` : '')
      + 'Run `node qualification/runners/check-source-plane.mjs` for the full classification.\n'
      + 'This is an ENVIRONMENT PRECONDITION, not part of the artifact identity:\n'
      + '`python helpers/doctor.py` verifies the identity and is the check that\n'
      + 'survives a dirty checkout. Neither substitutes for the other.',
    )
  }
  return report
}

export function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv)
  const checkout = resolveCheckout(options.checkout)
  const pinned = expectedCommit()

  let report
  try {
    report = inspectSourcePlane(checkout, pinned)
  } catch (error) {
    fail(String(error.message))
  }
  const { headCommit, entries, headMatches, clean } = {
    headCommit: report.head,
    entries: report.entries,
    headMatches: report.headMatches,
    clean: report.clean,
  }

  if (options.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
    process.exit(clean ? 0 : 1)
  }

  const say = (line) => {
    if (!options.quiet) process.stdout.write(`${line}\n`)
  }

  say('=== qualification source plane ===')
  say(`checkout: ${checkout}`)
  say(`HEAD:     ${headCommit}`)
  say(`pinned:   ${pinned}`)
  say(
    headMatches
      ? '[ok  ] HEAD equals the pinned commit'
      : `[FAIL] HEAD is MOVED: ${headCommit} != ${pinned}`,
  )

  if (entries.length === 0) {
    say('[ok  ] git status --porcelain is empty: nothing tracked-modified, nothing staged,')
    say('       and no generated state written into the checkout')
  } else {
    say(`[FAIL] git status --porcelain reports ${String(entries.length)} entry/entries:`)
    for (const entry of entries) {
      say('')
      say(`  ${entry.code} ${entry.path}`)
      say(`      class:  ${entry.kind}`)
      say(`      why:    ${entry.detail}`)
      say(`      remedy: ${entry.remedy}`)
    }
  }

  say('')
  if (clean) {
    say('source plane: CLEAN -- a qualification run may start.')
  } else {
    say('source plane: NOT CLEAN -- do not start a qualification run against it.')
    say('This is an ENVIRONMENT PRECONDITION. The artifact identity is separate:')
    say('`python helpers/doctor.py` re-derives and verifies it, and it is the check')
    say('that survives a dirty checkout. Neither check substitutes for the other.')
  }

  process.exit(clean ? 0 : 1)
}

/**
 * Run the CLI only when this file IS the entry point.
 *
 * Without this guard, importing the module for `assertCleanSourcePlane` runs the
 * whole CLI and calls `process.exit` -- which would take down the process of
 * whatever boot harness imported it. That is a real defect that this file had
 * for one revision, caught by importing it from `boot-harness.mjs` rather than
 * by reading it, which is why the import is exercised in the check below.
 */
const isEntryPoint = process.argv[1] !== undefined
  && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))

if (isEntryPoint) main()
