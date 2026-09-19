/**
 * Protected acceptance runner (M9.1).
 *
 * This is a VERIFICATION AUTHORITY, so its job is to be unable to lie. It runs
 * one acceptance definition in a child process and emits a receipt binding the
 * candidate tree digest, the acceptance-definition digest, the environment
 * identity, the exact command, the observed exit/signal, the observed test
 * counts and the bounded output.
 *
 * The three properties that make it worth trusting:
 *
 *  1. NO CLAIM IS AN ORACLE. Nothing a model says is an input. The verdict is
 *     derived from the child's real exit code and real runner output. A missing
 *     command, a skipped suite, a runner that never started, a timeout, an
 *     interrupt and "we could not tell" are all NON-PASS.
 *
 *  2. THE VERDICT IS BOUND TO AN IMMUTABLE INPUT SNAPSHOT. The inputs the check
 *     covers are copied to a temp directory and the command runs THERE. An
 *     A->B->A mutation of the live tree during verification therefore cannot
 *     reach the command at all. Before/after digests of the live tree are
 *     recorded for staleness detection only; they are explicitly NOT the basis
 *     of the verdict, because A->B->A leaves them equal.
 *
 *  3. IT RUNS UNTRUSTED CODE WITHOUT INHERITING PRIVILEGE. Repo tests may be
 *     model-modified. The child is spawned through the real DSH subprocess
 *     seam, whose `childEnv` -> `scrubbedParentEnv()` drops every
 *     credential-shaped name (`/KEY|PASSWORD|SECRET|TOKEN/i`) and every `DSH_*`
 *     name, and whose managed range terminates descendants rather than only the
 *     direct child. It gets no extra network permission and no control-plane
 *     handle by virtue of being "verification".
 *
 * What this runner deliberately does NOT do: it is not an effect WAL, it does
 * not claim exactly-once semantics for anything the acceptance command does,
 * and it does not decide whether a candidate may be merged. It reports one
 * command's observed result.
 *
 * Real DSH seam used below, quoted from
 * `packages/subprocess/subprocess/src/index.ts:153` at the pinned commit:
 *   abstract spawn(spec: SubprocessSpawnSpec): SubprocessHandle
 * and `src/types.ts:77`:
 *   interface SubprocessSpawnSpec { argv, cwd, stdio, graceMs, signal?, env? }
 * with `SubprocessHandle.done: Promise<SubprocessOutcome>` (`types.ts:181`)
 * resolving `{ exitCode: number | null, signal: NodeJS.Signals | null }`, and
 * `SubprocessHandle.waitForExit(signal?): Promise<boolean>` (`types.ts:195`)
 * which waits for the whole managed RANGE, not just the direct child.
 *
 * The seam's own comment on `signal` states the division of labour this file
 * relies on: "The caller owns deadlines and cause classification; this seam
 * only reacts to the abort." That is why `timedOut` is our own flag and is
 * never inferred from the child's exit code or signal: measured on this
 * machine, aborting a running child through the local provider settles as
 * `{ exitCode: 1, signal: null }` — a plain non-zero code with no signal at
 * all — so a signal-based timeout test would report every timeout as an
 * ordinary failure and hide the fact that the outcome is unknown.
 */
import { createHash } from 'node:crypto'
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  symlinkSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { SubprocessExecutableNotFoundError } from '@deepseek-ai/dsh-subprocess'
import type { SubprocessHandle } from '@deepseek-ai/dsh-subprocess'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'

/** Receipt schema tag. A reader that does not know this tag must refuse the file. */
export const RECEIPT_SCHEMA = 'dsh-daily-work/acceptance-receipt@1'

/** Digest-algorithm tag, so a tree digest can never be compared across versions. */
const TREE_DIGEST_TAG = 'dsh-daily-work/tree@1'

/** Default per-stream output cap. Overflow keeps the TAIL, where runner summaries live. */
const DEFAULT_OUTPUT_CAP_BYTES = 64 * 1024

/** Default hard deadline for one acceptance command. */
const DEFAULT_TIMEOUT_MS = 120_000

/** Path fragments never copied into a snapshot, whatever the definition says. */
const ALWAYS_EXCLUDED = ['.git', 'node_modules'] as const

/**
 * Every terminal classification this runner can reach.
 *
 * Only `pass` is a PASS. The rest are listed rather than collapsed so a reader
 * can tell "the tests failed" from "no tests ran" from "we could not tell".
 */
export type AcceptanceOutcome =
  /** Real exit code equalled the expected one AND every declared count matched. */
  | 'pass'
  /** The command really ran and really exited off the expected code. */
  | 'fail'
  /** The executable could not be resolved. Nothing ran. */
  | 'command_not_found'
  /** Our deadline fired. The result is UNKNOWN and the reservation is held. */
  | 'timeout'
  /** An external stop aborted the run. The result is UNKNOWN. */
  | 'interrupted'
  /** A runner reported a total of zero executed tests. */
  | 'zero_tests'
  /** A runner reported tests, and none of them passed or failed. */
  | 'all_skipped'
  /** Counts were declared but no runner summary appeared at all. */
  | 'runner_never_ran'
  /** A runner ran, and its counts disagree with the declared ones. */
  | 'count_mismatch'
  /** The observed facts support none of the above, e.g. there is no exit code at all. */
  | 'unknown'
  /** The definition's digest does not match the authorized one. Refused to run. */
  | 'acceptance_definition_changed'

/** Observed test counts, as the runner itself reported them. */
export interface TestCounts {
  total: number
  passed: number
  failed: number
  skipped: number
  todo: number
}

/** One bounded output stream. `text` is the TAIL when `truncated` is true. */
export interface BoundedOutput {
  text: string
  /** True when bytes were dropped; the retained text is then the stream's tail. */
  truncated: boolean
  /** Total bytes the child emitted on this stream, counted before truncation. */
  totalBytes: number
}

/** Declared test counts a PASS must match. */
export interface ExpectedTests {
  passed: number
  failed?: number
  skipped?: number
}

/** One acceptance definition: what to run, where, and what counts as done. */
export interface AcceptanceDefinition {
  /** Stable id, carried into the receipt. */
  id: string
  /**
   * argv. Never shell-interpreted: a shell would turn "command not found" into
   * an ordinary non-zero exit and make the two indistinguishable.
   */
  command: readonly string[]
  /** The directory the command is resolved against and, by default, run in. */
  cwd: string
  /** Expected exit code. Default 0. */
  expectedExitCode?: number
  /** Hard deadline in milliseconds. A timeout is UNKNOWN, never PASS. */
  timeoutMs?: number
  /**
   * Paths, relative to `cwd`, that make up the candidate tree this check
   * covers. They are hashed and copied into the snapshot. Listing a directory
   * covers it recursively.
   */
  inputs: readonly string[]
  /** Path fragments to skip while walking `inputs`. Merged with `.git`/`node_modules`. */
  exclude?: readonly string[]
  /**
   * Declared test counts. When present a PASS additionally requires the
   * observed counts to match, which is what makes "all skipped" and "runner
   * never ran" non-PASS rather than a green exit code.
   */
  expectTests?: ExpectedTests
  /** Which summary grammar to read the counts from. Default 'vitest'. */
  testReporter?: 'vitest' | 'node-test'
  /**
   * Verify inside a copy of `inputs` instead of the live tree. Default true.
   * Setting this to false is allowed, but the receipt is then marked limited
   * because an A->B->A mutation during the run is not excluded.
   */
  snapshot?: boolean
  /**
   * When the snapshot is used, junction the real `node_modules` into it so the
   * toolchain can resolve. `node_modules` is NOT part of the candidate digest
   * and the receipt says so.
   */
  linkNodeModules?: boolean
  /** Per-stream output cap in bytes. Default 64 KiB. */
  outputCapBytes?: number
  /** Extra environment entries for the child, merged after the seam's credential scrub. */
  env?: Readonly<Record<string, string>>
  /**
   * The digest this definition is authorized to have. When present, a mismatch
   * refuses the run rather than silently producing a green result for a
   * weakened acceptance.
   */
  authorizedDigest?: string
}

/** The machine-readable result. Everything a later reader needs to re-judge it. */
export interface AcceptanceReceipt {
  schema: typeof RECEIPT_SCHEMA
  definitionId: string
  outcome: AcceptanceOutcome
  /** The single boolean a caller should gate on. True iff outcome === 'pass'. */
  passed: boolean
  /** Why the outcome is what it is. Never empty. */
  reasons: string[]
  command: readonly string[]
  /** The command as resolved and actually spawned, for a diffable record. */
  spawnedArgv: readonly string[]
  commandText: string
  /** The directory the command actually ran in (the snapshot when one was used). */
  ranIn: string
  requestedCwd: string
  /** Hash of the files the check covers, taken from the tree it ran against. */
  candidateTreeDigest: string
  /** What the digest is a digest OF. 'live' is not snapshot-equivalent. */
  candidateTreeDigestScope: 'snapshot' | 'live'
  /** Hash of the acceptance definition, so a weakened threshold changes the receipt. */
  acceptanceDefinitionDigest: string
  /** Set when the definition declared an authorized digest. */
  authorizedDigest?: string
  environment: {
    node: string
    platform: string
    arch: string
    runnerPid: number
    /** Platform the subprocess provider reported for this execution world. */
    providerPlatform?: string
  }
  exit: {
    code: number | null
    signal: string | null
    timedOut: boolean
    interrupted: boolean
    expectedCode: number
  }
  output: { stdout: BoundedOutput; stderr: BoundedOutput }
  observedTests?: TestCounts
  expectedTests?: ExpectedTests
  /** How the counts were read, so an unparsed summary is visible rather than assumed. */
  testSummarySource?: 'vitest' | 'node-test'
  /**
   * Whether the terminated run's managed process range was observed empty.
   * `'unknown'` is a real value: the range could not be observed to quiesce.
   */
  managedRangeEmpty: boolean | 'unknown'
  /**
   * True when the caller must keep holding this acceptance's reservation.
   * A timeout is UNKNOWN, so its resources are not free even when the range
   * happened to look empty.
   */
  holdReservation: boolean
  snapshot?: {
    dir: string
    /** Digest of the declared inputs as they were copied into the snapshot. */
    digest: string
    /** Re-digested after the run over the SAME path set: false means an input moved under the run. */
    stableDuringRun: boolean
    /** Digest of the live tree before the copy. Recorded for staleness, not for the verdict. */
    liveDigestAtStart: string
    /** Digest of the live tree after the run. */
    liveDigestAtEnd: string
    /**
     * True when the live tree differs across the run. False does NOT prove the
     * tree was untouched (A->B->A lands here too); it only means the endpoints
     * agree. The snapshot is what excludes ABA, not this flag.
     */
    liveDriftDetected: boolean
    /** Files the command created in the snapshot that are not declared inputs. */
    extraPathsCreated: number
    /** True when node_modules was junctioned in and is therefore outside the digest. */
    toolchainLinked: boolean
    /** Plain statement of what the digest does and does not cover. */
    coverage: string
    retained: boolean
  }
  /** Set when the run could not provide the coverage the receipt would imply. */
  limitations: string[]
  startedAt: string
  finishedAt: string
  durationMs: number
}

/** Options for {@link runAcceptance}. */
export interface RunAcceptanceOptions {
  /** Reuse a mounted subprocess service instead of creating a private one. */
  ctx?: Context
  /** Parent directory for snapshots. Defaults to the OS temp dir. */
  tempRoot?: string
  /** Clock injection, so a test can assert timestamps deterministically. */
  now?: () => Date
  /** Keep the snapshot directory after the run, for inspection. */
  keepSnapshot?: boolean
  /**
   * An external stop. It outranks the deadline: an interrupted run is reported
   * as interrupted, never as a timeout, and never as a pass.
   */
  signal?: AbortSignal
}

/** sha256 of a UTF-8 string, hex. */
function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/**
 * Stable JSON for digesting: object keys sorted, `undefined` dropped.
 * `JSON.stringify` is not usable for this because key order would then decide
 * the digest, so two semantically identical definitions could disagree.
 */
function canonicalJson(value: unknown): string {
  if (value === undefined) return 'null'
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(',')}}`
}

/**
 * The digest a definition is authorized by. `authorizedDigest` is excluded so
 * the digest cannot refer to itself, which would make authorization impossible.
 */
export function acceptanceDefinitionDigest(definition: AcceptanceDefinition): string {
  const { authorizedDigest: _authorized, ...rest } = definition
  return sha256(`dsh-daily-work/acceptance-definition@1\n${canonicalJson(rest)}`)
}

/** True when `fragment` matches a whole path segment of `relPath`. */
function matchesFragment(relPath: string, fragment: string): boolean {
  const normalized = fragment.replace(/\\/g, '/')
  if (normalized.includes('/')) return relPath === normalized || relPath.startsWith(`${normalized}/`)
  return relPath.split('/').includes(normalized)
}

/**
 * Walk `roots` and hash every file.
 *
 * A symlink or junction is recorded by its target string and never followed.
 * Following one would let a link inside the candidate tree pull in bytes from
 * outside it, and the digest would then claim coverage it does not have.
 */
function walkAndHash(roots: readonly string[], baseDir: string, exclude: readonly string[]): Map<string, string> {
  const entries = new Map<string, string>()
  const visit = (absolute: string): void => {
    const relPath = relative(baseDir, absolute).replace(/\\/g, '/')
    if (relPath !== '' && exclude.some(fragment => matchesFragment(relPath, fragment))) return
    const stats = lstatSync(absolute)
    if (stats.isSymbolicLink()) {
      entries.set(relPath, sha256(`link:${readlinkSync(absolute)}`))
      return
    }
    if (stats.isDirectory()) {
      for (const child of readdirSync(absolute).sort()) visit(join(absolute, child))
      return
    }
    if (stats.isFile()) entries.set(relPath, sha256(readFileSync(absolute).toString('base64')))
  }
  for (const root of roots) {
    const absolute = isAbsolute(root) ? root : resolve(baseDir, root)
    if (existsSync(absolute)) visit(absolute)
  }
  return entries
}

/** Fold a path->hash map into one digest. Sorted, so walk order cannot matter. */
function treeDigest(entries: ReadonlyMap<string, string>): string {
  const lines = [...entries.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([path, hash]) => `${path}\n${hash}\n`)
  return sha256(`${TREE_DIGEST_TAG}\n${lines.join('')}`)
}

/**
 * Hash exactly `paths`, resolving each against `baseDir`.
 *
 * A declared input that no longer exists is recorded as MISSING rather than
 * dropped, so a deletion changes the digest instead of shrinking the path set.
 */
function hashExactPaths(baseDir: string, paths: readonly string[]): Map<string, string> {
  const entries = new Map<string, string>()
  for (const relPath of paths) {
    const absolute = join(baseDir, relPath)
    entries.set(relPath, existsSync(absolute)
      ? sha256(readFileSync(absolute).toString('base64'))
      : 'MISSING')
  }
  return entries
}

/** The exclusion list a definition actually implies. */
function exclusionsFor(definition: AcceptanceDefinition): string[] {
  return [...ALWAYS_EXCLUDED, ...(definition.exclude ?? [])]
}

/** Hash the candidate tree exactly as it exists on disk right now. */
export function digestInputs(definition: AcceptanceDefinition): string {
  return treeDigest(walkAndHash(definition.inputs, resolve(definition.cwd), exclusionsFor(definition)))
}

/**
 * Copy the candidate inputs into `snapshotRoot`, preserving relative layout.
 * Returns the relative paths of every file copied, which is the exact set the
 * snapshot digest covers.
 */
function copyInputs(
  roots: readonly string[],
  baseDir: string,
  snapshotRoot: string,
  exclude: readonly string[],
): string[] {
  const copied: string[] = []
  const copy = (absolute: string): void => {
    const relPath = relative(baseDir, absolute).replace(/\\/g, '/')
    if (relPath !== '' && exclude.some(fragment => matchesFragment(relPath, fragment))) return
    const stats = lstatSync(absolute)
    if (stats.isSymbolicLink()) {
      const destination = join(snapshotRoot, relPath)
      mkdirSync(dirname(destination), { recursive: true })
      symlinkSync(resolve(dirname(absolute), readlinkSync(absolute)), destination, 'junction')
      return
    }
    if (stats.isDirectory()) {
      mkdirSync(join(snapshotRoot, relPath), { recursive: true })
      for (const child of readdirSync(absolute).sort()) copy(join(absolute, child))
      return
    }
    if (stats.isFile()) {
      const destination = join(snapshotRoot, relPath)
      mkdirSync(dirname(destination), { recursive: true })
      copyFileSync(absolute, destination)
      copied.push(relPath)
    }
  }
  for (const root of roots) {
    const absolute = isAbsolute(root) ? root : resolve(baseDir, root)
    if (existsSync(absolute)) copy(absolute)
  }
  return copied.sort()
}

/** Strip ANSI SGR/CSI sequences so a summary line can be matched. */
function stripAnsi(text: string): string {
  // The escape byte is the thing being matched, hence the explicit \u001B.
  return text.replace(/\u001B\[[0-9;?]*[ -/]*[@-~]/g, '')
}

/**
 * Read a runner's own summary out of its output.
 *
 * Returns `undefined` when no summary is present at all, which is a different
 * fact from a summary that says zero: the first means the runner never
 * reported, the second means it reported that nothing ran. Both are non-PASS,
 * but they are different failures and the receipt must not conflate them.
 */
export function parseTestCounts(text: string, reporter: 'vitest' | 'node-test'): TestCounts | undefined {
  const clean = stripAnsi(text)
  if (reporter === 'vitest') {
    const summary = /^[^\S\n]*Tests[^\S\n]+(.+)$/m.exec(clean)
    if (summary === null) return undefined
    const body = summary[1]!
    if (/no tests/i.test(body)) return { total: 0, passed: 0, failed: 0, skipped: 0, todo: 0 }
    const counts: TestCounts = { total: 0, passed: 0, failed: 0, skipped: 0, todo: 0 }
    const segment = /(\d+)\s+(passed|failed|skipped|todo|pending)/g
    let match: RegExpExecArray | null
    let seen = false
    while ((match = segment.exec(body)) !== null) {
      seen = true
      const value = Number(match[1])
      const kind = match[2]!
      if (kind === 'passed') counts.passed += value
      else if (kind === 'failed') counts.failed += value
      else if (kind === 'todo' || kind === 'pending') counts.todo += value
      else counts.skipped += value
    }
    if (!seen) return undefined
    counts.total = counts.passed + counts.failed + counts.skipped + counts.todo
    return counts
  }
  // node:test prints either an "ℹ <field> <n>" spec summary or TAP "# <field> <n>" lines.
  const field = (name: string): number | undefined => {
    const pattern = new RegExp(`^[^\\S\\n]*(?:\\u2139|#)[^\\S\\n]+${name}[^\\S\\n]+(\\d+)`, 'm')
    const found = pattern.exec(clean)
    return found === null ? undefined : Number(found[1])
  }
  const total = field('tests')
  if (total === undefined) return undefined
  return {
    total,
    passed: field('pass') ?? 0,
    failed: field('fail') ?? 0,
    skipped: field('skipped') ?? 0,
    todo: field('todo') ?? 0,
  }
}

/** Read one collected stream, mapping the seam's lossy flag onto `truncated`. */
function readStream(handle: SubprocessHandle, which: 'stdout' | 'stderr'): BoundedOutput {
  const reader = handle.collected[which]
  if (reader === undefined) return { text: '', truncated: false, totalBytes: 0 }
  const read = reader.readFrom(0)
  return { text: read.text, truncated: read.lossy, totalBytes: read.nextOffset }
}

/** A missing executable is its own outcome, not a generic failure. */
function isExecutableNotFound(error: unknown): boolean {
  if (error instanceof SubprocessExecutableNotFoundError) return true
  if ((error as Error | undefined)?.name === 'SubprocessExecutableNotFoundError') return true
  const code = (error as NodeJS.ErrnoException | undefined)?.code
  if (code === 'ENOENT') return true
  return /not found on PATH|is not an executable file/i.test(String((error as Error | undefined)?.message ?? ''))
}

/**
 * Rewrite a path inside the original cwd so it points at the same place inside
 * the snapshot. Without this, a command that is itself part of the candidate
 * tree would keep executing the LIVE copy while the receipt claims it verified
 * the snapshot.
 */
function remapToSnapshot(absolute: string, originalCwd: string, snapshotCwd: string): string {
  const rel = relative(originalCwd, absolute)
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return absolute
  return join(snapshotCwd, rel)
}

/**
 * Decide the outcome from observed facts only.
 *
 * Order matters and is deliberate: a run that was stopped is reported as
 * stopped, and a command that really failed is reported as a failure, before
 * any question about test counts is asked. Counts only ever downgrade a
 * would-be PASS; they are never used to explain away a real non-zero exit.
 */
function classify(input: {
  interrupted: boolean
  timedOut: boolean
  executableMissing: boolean
  spawnFailed: boolean
  exitCode: number | null
  expectedCode: number
  observedTests: TestCounts | undefined
  expectedTests: ExpectedTests | undefined
  stdout: BoundedOutput
  stderr: BoundedOutput
}): { outcome: AcceptanceOutcome; reasons: string[] } {
  const reasons: string[] = []
  if (input.interrupted) {
    reasons.push('the run was interrupted by an external stop; the result is unknown')
    return { outcome: 'interrupted', reasons }
  }
  if (input.executableMissing) {
    reasons.push('the command could not be resolved to an executable, so nothing ran')
    return { outcome: 'command_not_found', reasons }
  }
  if (input.timedOut) {
    reasons.push('the deadline fired; a timeout is unknown, not a pass, and its resources are not released')
    return { outcome: 'timeout', reasons }
  }
  if (input.spawnFailed) {
    reasons.push('the child could not be started, so nothing ran')
    return { outcome: 'unknown', reasons }
  }
  if (input.exitCode === null) {
    reasons.push('the child ended on a signal with no exit code, so there is no exit code to judge')
    return { outcome: 'unknown', reasons }
  }

  const countsNote = (): void => {
    if (input.observedTests === undefined) return
    reasons.push(
      `runner reported total=${input.observedTests.total} passed=${input.observedTests.passed} `
      + `failed=${input.observedTests.failed} skipped=${input.observedTests.skipped} todo=${input.observedTests.todo}`,
    )
  }

  if (input.exitCode !== input.expectedCode) {
    reasons.push(`exit code ${input.exitCode} did not match the expected ${input.expectedCode}`)
    if (input.observedTests !== undefined && input.observedTests.total === 0) {
      reasons.push('the runner also executed zero tests, so the non-zero exit proves nothing about behaviour')
    }
    countsNote()
    return { outcome: 'fail', reasons }
  }
  reasons.push(`exit code ${input.exitCode} matched the expected ${input.expectedCode}`)

  if (input.expectedTests === undefined) {
    reasons.push('no test counts were declared, so only the exit code is claimed')
    return { outcome: 'pass', reasons }
  }
  if (input.observedTests === undefined) {
    if (input.stdout.truncated || input.stderr.truncated) {
      reasons.push('counts were declared but the output was truncated before any runner summary could be read')
      return { outcome: 'unknown', reasons }
    }
    reasons.push('counts were declared but no runner summary appeared in the output; the runner never reported')
    return { outcome: 'runner_never_ran', reasons }
  }
  const observed = input.observedTests
  countsNote()
  if (observed.total === 0) {
    reasons.push('the runner executed zero tests, so a green exit code proves nothing')
    return { outcome: 'zero_tests', reasons }
  }
  if (observed.passed === 0 && observed.failed === 0) {
    reasons.push(`no test passed or failed: ${observed.skipped} skipped, ${observed.todo} todo`)
    return { outcome: 'all_skipped', reasons }
  }
  const mismatches: string[] = []
  if (observed.passed !== input.expectedTests.passed) {
    mismatches.push(`passed ${observed.passed} != declared ${input.expectedTests.passed}`)
  }
  if (input.expectedTests.failed !== undefined && observed.failed !== input.expectedTests.failed) {
    mismatches.push(`failed ${observed.failed} != declared ${input.expectedTests.failed}`)
  }
  if (input.expectedTests.skipped !== undefined && observed.skipped !== input.expectedTests.skipped) {
    mismatches.push(`skipped ${observed.skipped} != declared ${input.expectedTests.skipped}`)
  }
  if (mismatches.length > 0) {
    reasons.push(`observed counts disagree with the declared ones: ${mismatches.join('; ')}`)
    return { outcome: 'count_mismatch', reasons }
  }
  reasons.push('observed counts matched the declared ones')
  return { outcome: 'pass', reasons }
}

/** A refused or pre-flight-failed run still produces a full, honest receipt. */
function refusedReceipt(
  definition: AcceptanceDefinition,
  outcome: AcceptanceOutcome,
  reason: string,
  now: Date,
  scope: 'snapshot' | 'live',
): AcceptanceReceipt {
  return {
    schema: RECEIPT_SCHEMA,
    definitionId: definition.id,
    outcome,
    passed: false,
    reasons: [reason],
    command: definition.command,
    spawnedArgv: definition.command,
    commandText: definition.command.join(' '),
    ranIn: definition.cwd,
    requestedCwd: definition.cwd,
    candidateTreeDigest: '',
    candidateTreeDigestScope: scope,
    acceptanceDefinitionDigest: acceptanceDefinitionDigest(definition),
    authorizedDigest: definition.authorizedDigest,
    environment: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      runnerPid: process.pid,
    },
    exit: {
      code: null,
      signal: null,
      timedOut: false,
      interrupted: false,
      expectedCode: definition.expectedExitCode ?? 0,
    },
    output: {
      stdout: { text: '', truncated: false, totalBytes: 0 },
      stderr: { text: '', truncated: false, totalBytes: 0 },
    },
    expectedTests: definition.expectTests,
    managedRangeEmpty: 'unknown',
    holdReservation: false,
    limitations: ['the acceptance command was never executed'],
    startedAt: now.toISOString(),
    finishedAt: now.toISOString(),
    durationMs: 0,
  }
}

/**
 * Run one acceptance definition and return the receipt.
 *
 * Never throws for a failed acceptance: a failure is a receipt with
 * `passed: false`. It throws only for a caller error, such as an `inputs` path
 * that escapes `cwd`.
 */
export async function runAcceptance(
  definition: AcceptanceDefinition,
  options: RunAcceptanceOptions = {},
): Promise<AcceptanceReceipt> {
  const now = options.now ?? ((): Date => new Date())
  const started = now()
  const startedMs = Date.now()
  const useSnapshot = definition.snapshot !== false
  const scope: 'snapshot' | 'live' = useSnapshot ? 'snapshot' : 'live'

  if (definition.command.length === 0) {
    return refusedReceipt(definition, 'command_not_found', 'the definition has an empty command', started, scope)
  }

  // F05: a weakened acceptance must not go quietly green. The definition
  // carries the digest it is authorized to have; a mismatch refuses the run
  // instead of producing a result nobody authorized.
  const definitionDigest = acceptanceDefinitionDigest(definition)
  if (definition.authorizedDigest !== undefined && definition.authorizedDigest !== definitionDigest) {
    return refusedReceipt(
      definition,
      'acceptance_definition_changed',
      `the acceptance definition digest ${definitionDigest} does not match the authorized ${definition.authorizedDigest}; the run was refused rather than silently accepted`,
      started,
      scope,
    )
  }

  const originalCwd = resolve(definition.cwd)
  for (const input of definition.inputs) {
    const absolute = isAbsolute(input) ? input : resolve(originalCwd, input)
    const rel = relative(originalCwd, absolute)
    if (rel.startsWith('..') || isAbsolute(rel)) {
      throw new Error(`acceptance ${definition.id}: input ${JSON.stringify(input)} escapes cwd ${originalCwd}`)
    }
  }

  const ownContext = options.ctx === undefined
  const ctx = options.ctx ?? new Context()
  if (ownContext) await ctx.plugin(LocalSubprocessRuntime)

  const exclude = exclusionsFor(definition)
  const limitations: string[] = []
  let snapshotRoot: string | undefined
  let toolchainLinked = false
  let liveDigestAtStart = ''
  let liveDigestAtEnd = ''
  let snapshotDigest = ''
  let snapshotStable = true
  let extraPathsCreated = 0

  const cleanup = (): void => {
    if (snapshotRoot !== undefined && options.keepSnapshot !== true) {
      try {
        rmSync(snapshotRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
      } catch {
        // A retained snapshot is a disk-hygiene problem, not a verification
        // fact, and it must never change the receipt.
      }
    }
    if (ownContext) void ctx.fiber.dispose()
  }

  try {
    const missing = definition.inputs.filter(input => !existsSync(resolve(originalCwd, input)))
    if (missing.length > 0) {
      limitations.push(`declared inputs are absent and were not covered: ${missing.join(', ')}`)
    }

    let runCwd = originalCwd
    let copiedPaths: string[] = []
    if (useSnapshot) {
      liveDigestAtStart = digestInputs(definition)
      const tempRoot = options.tempRoot ?? tmpdir()
      snapshotRoot = mkdtempSync(join(tempRoot, `dsh-acceptance-${definition.id.replace(/[^\w.-]/g, '_')}-`))
      copiedPaths = copyInputs(definition.inputs, originalCwd, snapshotRoot, exclude)
      // The toolchain is deliberately NOT part of the candidate tree. Without
      // it the snapshot cannot resolve its own imports and every check would
      // fail for a reason unrelated to the candidate, which would be a
      // verification defect rather than a finding.
      if (definition.linkNodeModules !== false && existsSync(join(originalCwd, 'node_modules'))) {
        try {
          symlinkSync(join(originalCwd, 'node_modules'), join(snapshotRoot, 'node_modules'), 'junction')
          toolchainLinked = true
        } catch {
          limitations.push('node_modules could not be linked into the snapshot, so the command may fail to resolve dependencies')
        }
      }
      snapshotDigest = treeDigest(hashExactPaths(snapshotRoot, copiedPaths))
      runCwd = snapshotRoot
    } else {
      limitations.push('the command ran against the LIVE tree, so an A->B->A mutation during verification is not excluded')
      liveDigestAtStart = digestInputs(definition)
    }

    let program: string
    try {
      const requested = definition.command[0]!
      const resolved = isAbsolute(requested) || requested.includes('/') || requested.includes('\\')
        ? await ctx.subprocess.resolveExecutable(isAbsolute(requested) ? requested : resolve(originalCwd, requested), definition.env)
        : await ctx.subprocess.resolveExecutable(requested, definition.env)
      program = useSnapshot ? remapToSnapshot(resolved, originalCwd, runCwd) : resolved
    } catch (error) {
      if (!isExecutableNotFound(error)) throw error
      const receipt = refusedReceipt(
        definition,
        'command_not_found',
        `the executable ${JSON.stringify(definition.command[0])} was not found, so nothing ran: ${(error as Error).message}`,
        started,
        scope,
      )
      receipt.acceptanceDefinitionDigest = definitionDigest
      return receipt
    }

    const cap = definition.outputCapBytes ?? DEFAULT_OUTPUT_CAP_BYTES
    const controller = new AbortController()
    let timedOut = false
    let interrupted = false
    const timer = setTimeout(() => {
      timedOut = true
      controller.abort(new Error('ACCEPTANCE_TIMEOUT'))
    }, definition.timeoutMs ?? DEFAULT_TIMEOUT_MS)
    const onOuterAbort = (): void => {
      interrupted = true
      controller.abort(new Error('ACCEPTANCE_INTERRUPTED'))
    }
    // A human stop outranks the deadline, so it is classified separately. An
    // already-aborted signal never fires the event, so it is checked directly.
    if (options.signal?.aborted === true) onOuterAbort()
    else options.signal?.addEventListener('abort', onOuterAbort, { once: true })

    const handle = ctx.subprocess.spawn({
      argv: [program, ...definition.command.slice(1)],
      cwd: runCwd,
      stdio: {
        stdin: 'ignore',
        stdout: { maxBytes: cap },
        stderr: { maxBytes: cap },
      },
      graceMs: 5_000,
      signal: controller.signal,
      // No env override by default: the seam's own scrub is the isolation, and
      // adding entries is the definition author's explicit opt-in.
      ...(definition.env === undefined ? {} : { env: { ...definition.env } }),
    })

    let exitCode: number | null = null
    let exitSignal: string | null = null
    let spawnError: unknown
    try {
      const outcome = await handle.done
      exitCode = outcome.exitCode
      exitSignal = outcome.signal
    } catch (error) {
      spawnError = error
    }
    clearTimeout(timer)
    options.signal?.removeEventListener('abort', onOuterAbort)

    // Read the streams before any teardown: the collectors are sealed at
    // settlement, and a later read must not be confused with a live one.
    const stdout = readStream(handle, 'stdout')
    const stderr = readStream(handle, 'stderr')

    // Observe the managed range under a bound. A range that cannot be observed
    // to quiesce is `unknown`, which is not the same as released.
    let managedRangeEmpty: boolean | 'unknown' = 'unknown'
    try {
      const rangeWatch = new AbortController()
      const bound = setTimeout(() => rangeWatch.abort(), 10_000)
      managedRangeEmpty = await handle.waitForExit(rangeWatch.signal)
      clearTimeout(bound)
    } catch {
      managedRangeEmpty = 'unknown'
    }

    if (useSnapshot) {
      // Re-hash exactly the copied set. A build output or cache the command
      // creates is not an input and must not invalidate the run; a declared
      // input that moved under the run must.
      const after = treeDigest(hashExactPaths(snapshotRoot!, copiedPaths))
      snapshotStable = after === snapshotDigest
      const declared = new Set(copiedPaths)
      extraPathsCreated = [...walkAndHash([snapshotRoot!], snapshotRoot!, exclude).keys()]
        .filter(path => !declared.has(path) && !path.startsWith('node_modules/'))
        .length
      liveDigestAtEnd = digestInputs(definition)
    }

    const combined = `${stdout.text}\n${stderr.text}`
    const observedTests = definition.expectTests === undefined
      ? undefined
      : parseTestCounts(combined, definition.testReporter ?? 'vitest')

    const executableMissing = spawnError !== undefined && isExecutableNotFound(spawnError)
    const classified = classify({
      interrupted,
      timedOut,
      executableMissing,
      spawnFailed: spawnError !== undefined && !executableMissing,
      exitCode,
      expectedCode: definition.expectedExitCode ?? 0,
      observedTests,
      expectedTests: definition.expectTests,
      stdout,
      stderr,
    })
    const reasons = classified.reasons
    if (spawnError !== undefined && !executableMissing) {
      reasons.push(`the spawn itself failed: ${(spawnError as Error).message}`)
    }
    if (useSnapshot && !snapshotStable) {
      reasons.push('a declared input changed inside the snapshot while the command was running, so the result is not attributable to one tree')
    }
    if (managedRangeEmpty === 'unknown') {
      reasons.push('the managed process range could not be observed to quiesce, so its resources are not known to be released')
    }

    // A snapshot that moved under the run cannot support any verdict, however
    // clean the exit code looked.
    const outcome: AcceptanceOutcome = useSnapshot && !snapshotStable ? 'unknown' : classified.outcome
    const holdReservation = outcome === 'timeout' || outcome === 'interrupted' || outcome === 'unknown'

    let providerPlatform: string | undefined
    try {
      providerPlatform = (await ctx.subprocess.terminalEnvironment()).platform
    } catch {
      providerPlatform = undefined
    }

    const finished = now()
    const receipt: AcceptanceReceipt = {
      schema: RECEIPT_SCHEMA,
      definitionId: definition.id,
      outcome,
      passed: outcome === 'pass',
      reasons,
      command: definition.command,
      spawnedArgv: [program, ...definition.command.slice(1)],
      commandText: [program, ...definition.command.slice(1)].join(' '),
      ranIn: runCwd,
      requestedCwd: originalCwd,
      candidateTreeDigest: useSnapshot ? snapshotDigest : liveDigestAtStart,
      candidateTreeDigestScope: scope,
      acceptanceDefinitionDigest: definitionDigest,
      authorizedDigest: definition.authorizedDigest,
      environment: {
        node: process.version,
        platform: process.platform,
        arch: process.arch,
        runnerPid: process.pid,
        providerPlatform,
      },
      exit: {
        code: exitCode,
        signal: exitSignal,
        timedOut,
        interrupted,
        expectedCode: definition.expectedExitCode ?? 0,
      },
      output: { stdout, stderr },
      observedTests,
      expectedTests: definition.expectTests,
      testSummarySource: observedTests === undefined ? undefined : (definition.testReporter ?? 'vitest'),
      managedRangeEmpty,
      holdReservation,
      limitations,
      startedAt: started.toISOString(),
      finishedAt: finished.toISOString(),
      durationMs: Date.now() - startedMs,
    }
    if (useSnapshot && snapshotRoot !== undefined) {
      receipt.snapshot = {
        dir: snapshotRoot,
        digest: snapshotDigest,
        stableDuringRun: snapshotStable,
        liveDigestAtStart,
        liveDigestAtEnd,
        liveDriftDetected: liveDigestAtStart !== liveDigestAtEnd,
        extraPathsCreated,
        toolchainLinked,
        coverage: toolchainLinked
          ? 'the digest covers the declared inputs only; node_modules is a junction to the live tree and is NOT covered'
          : 'the digest covers the declared inputs only; nothing else was present in the snapshot',
        retained: options.keepSnapshot === true,
      }
    }
    return receipt
  } finally {
    cleanup()
  }
}

/** One attempt in a bounded retry sequence. */
export interface AcceptanceAttempt {
  attempt: number
  outcome: AcceptanceOutcome
  passed: boolean
  receipt: AcceptanceReceipt
}

/** The result of {@link runAcceptanceWithBudget}. */
export interface BudgetedAcceptanceResult {
  /** Terminal state: a real pass, or a bounded stop. Never an open-ended retry. */
  status: 'pass' | 'failed' | 'blocked'
  attempts: AcceptanceAttempt[]
  /** The last receipt, so the caller always has a full record. */
  receipt: AcceptanceReceipt
  /** Why the sequence stopped. */
  reason: string
}

/**
 * Classifications that say something about the ENVIRONMENT rather than about
 * the candidate. Retrying a candidate defect is pointless, and retrying until
 * it goes green is exactly the failure this gate exists to prevent.
 */
const RETRYABLE: ReadonlySet<AcceptanceOutcome> = new Set(['timeout', 'unknown', 'interrupted'])

/**
 * Run an acceptance under an explicit, finite retry budget (F07).
 *
 * The oracle for this gate is "bounded retry and blocked, not unlimited
 * continuation until it gets through". So the loop is bounded by `maxAttempts`
 * and the only retried classifications are the environment-shaped ones. When
 * the budget is spent the result is `blocked`, which is not a pass and does not
 * become one by waiting.
 */
export async function runAcceptanceWithBudget(
  definition: AcceptanceDefinition,
  budget: { maxAttempts: number },
  options: RunAcceptanceOptions = {},
): Promise<BudgetedAcceptanceResult> {
  const maxAttempts = Math.max(1, Math.floor(budget.maxAttempts))
  const attempts: AcceptanceAttempt[] = []
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const receipt = await runAcceptance(definition, options)
    attempts.push({ attempt, outcome: receipt.outcome, passed: receipt.passed, receipt })
    if (receipt.passed) {
      return {
        status: 'pass',
        attempts,
        receipt,
        reason: `passed on attempt ${attempt} of at most ${maxAttempts}`,
      }
    }
    if (!RETRYABLE.has(receipt.outcome)) {
      return {
        status: 'failed',
        attempts,
        receipt,
        reason: `${receipt.outcome} is a defect of the candidate, not a transient environment fault, so it is not retried`,
      }
    }
  }
  const receipt = attempts[attempts.length - 1]!.receipt
  return {
    status: 'blocked',
    attempts,
    receipt,
    reason: `the retry budget of ${maxAttempts} attempt(s) is spent and the last outcome was ${receipt.outcome}; the result stays unknown and the work is blocked rather than continued`,
  }
}

/** Result of a git expected-ref check. */
export interface RefCasResult {
  /** True only when the ref was readable AND still equals the expected sha. */
  accepted: boolean
  ref: string
  expectedSha: string
  /** The sha actually observed, or undefined when the ref could not be read. */
  observedSha?: string
  reason: string
}

/**
 * Accept a candidate only if an integration ref still points where it did when
 * the candidate was verified (F08).
 *
 * This is deliberately a read-and-compare with no write path: there is no
 * force, no reset and no update. A moved ref is a REFUSAL, and the only
 * recovery is to re-verify against the new base. A candidate that cannot be
 * proven current is not published.
 */
export async function refCas(input: {
  /** Repository to inspect. */
  cwd: string
  /** Ref to read, e.g. `HEAD` or `refs/heads/main`. */
  ref: string
  /** The sha the candidate was verified against. */
  expectedSha: string
  /** Reuse a mounted subprocess service. */
  ctx?: Context
}): Promise<RefCasResult> {
  const ownContext = input.ctx === undefined
  const ctx = input.ctx ?? new Context()
  if (ownContext) await ctx.plugin(LocalSubprocessRuntime)
  try {
    const git = await ctx.subprocess.resolveExecutable('git')
    const handle = ctx.subprocess.spawn({
      argv: [git, 'rev-parse', '--verify', input.ref],
      cwd: input.cwd,
      stdio: {
        stdin: 'ignore',
        stdout: { maxBytes: 4096 },
        stderr: { maxBytes: 4096 },
      },
      graceMs: 5_000,
    })
    const outcome = await handle.done
    const stdout = readStream(handle, 'stdout')
    const stderr = readStream(handle, 'stderr')
    await handle.waitForExit().catch(() => false)
    if (outcome.exitCode !== 0) {
      return {
        accepted: false,
        ref: input.ref,
        expectedSha: input.expectedSha,
        reason: `the ref ${JSON.stringify(input.ref)} could not be read (exit ${String(outcome.exitCode)}): ${stderr.text.trim()}`,
      }
    }
    const observedSha = stdout.text.trim()
    if (observedSha !== input.expectedSha) {
      return {
        accepted: false,
        ref: input.ref,
        expectedSha: input.expectedSha,
        observedSha,
        reason: `the ref ${JSON.stringify(input.ref)} moved to ${observedSha} after the candidate was verified against ${input.expectedSha}; the publication is refused rather than forced`,
      }
    }
    return {
      accepted: true,
      ref: input.ref,
      expectedSha: input.expectedSha,
      observedSha,
      reason: `the ref ${JSON.stringify(input.ref)} still points at the verified base`,
    }
  } finally {
    if (ownContext) void ctx.fiber.dispose()
  }
}

/**
 * Whether a stored receipt still describes the tree in front of us (F03).
 *
 * A receipt is only ever a statement about the digest it recorded. Recomputing
 * that digest is what turns "this passed once" into "this passes for the tree
 * that exists now".
 */
export function receiptFreshness(
  receipt: AcceptanceReceipt,
  definition: AcceptanceDefinition,
): { fresh: boolean; reason: string; currentDigest: string } {
  const currentDigest = digestInputs(definition)
  if (receipt.candidateTreeDigest !== currentDigest) {
    return {
      fresh: false,
      reason: `the candidate tree changed since the receipt was written (receipt ${receipt.candidateTreeDigest}, now ${currentDigest})`,
      currentDigest,
    }
  }
  if (receipt.acceptanceDefinitionDigest !== acceptanceDefinitionDigest(definition)) {
    return {
      fresh: false,
      reason: 'the acceptance definition changed since the receipt was written',
      currentDigest,
    }
  }
  return { fresh: true, reason: 'the receipt still matches the candidate tree and the definition', currentDigest }
}

/** Serialize a receipt for storage. Trailing newline, so a diff is line-oriented. */
export function serializeReceipt(receipt: AcceptanceReceipt): string {
  return `${JSON.stringify(receipt, null, 2)}\n`
}
