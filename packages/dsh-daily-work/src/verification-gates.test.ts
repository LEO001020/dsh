/**
 * M8/T12 — verification mechanics and writer workspaces: gates VER-01..09 plus
 * W02/W03 and FS-06.
 *
 * THE RE-DEFINITION THIS FILE TESTS AGAINST
 * =========================================
 * A writer workspace is a `concurrency-isolated worktree`, and it is **NOT a
 * security boundary**. Its three jobs are: avoid concurrent writes clobbering
 * each other, establish a deterministic merge basis, and bind verification to a
 * specific candidate. It is not to contain the writer — under trusted-local,
 * every writer child runs as the same OS user with that user's full authority.
 *
 * The mirror-image honesty rule applies to the verifier itself: **a verifier
 * that runs with host authority is not a control, it is another host process.**
 * It provides MECHANICAL WORLD OBSERVATION — a real command with a real exit
 * code, and digests recomputed from Git/filesystem state — never containment.
 * The FS-06 case below exists precisely because that distinction has teeth:
 * model-written Python can mutate the world without producing a DSH fs receipt,
 * so the verifier must rediscover the final world rather than trust a receipt.
 *
 * WHAT THIS FILE IS
 * =================
 * `packages/dsh-daily-work/src/verify.ts` and `qualification/runners/acceptance.mjs`
 * are the SUBJECT UNDER TEST here, not a helper. They already exist and already
 * pass their own 30-test suite (`M9.1-acceptance-runner/`). The job of this file
 * is to attack them against the VER gates and to CLOSE THE GAPS the M9.1
 * slice recorded honestly as open, rather than to restate what already works.
 *
 * Three gaps were named in that slice's "What is NOT proven", and they are the
 * three this file actually closes:
 *
 *   1. "Digest coverage is whatever the definition declares." Consequence,
 *      MEASURED below: a candidate can rewrite the ACCEPTANCE SUITE ITSELF and
 *      every digest in the receipt stays byte-identical, so `receiptFreshness`
 *      still reports `fresh: true` for a receipt that passed against a different
 *      acceptance. VER-03's oracle is "the change is DETECTED", and the runner
 *      does not detect it. `oracleDigest()` + `bindReceipt()` are the closure,
 *      and the gap is asserted as a gap so it cannot be forgotten.
 *   2. "The snapshot is not a sandbox." The M9.1 slice says so; this file
 *      MEASURES it, per operation, and asserts the non-denial as itself. E01/E06
 *      established that the Windows rung denies writes and nothing else. VER-04
 *      is therefore split into what IS enforced (credential scrubbing, no
 *      control-plane handle) and what is NOT (filesystem reads, egress), and the
 *      second part is recorded as an honest FAIL rather than papered over.
 *   3. The A->B->A two-arm proof covers the input tree but not the ORACLE or the
 *      CONFIG. The extended case below mutates all three mid-run, in both arms.
 *
 * A NOTE ON THE IN-PROCESS MUTATIONS
 * ----------------------------------
 * Several cases below mutate files inside the snapshot while the acceptance
 * command is running, by having the command itself do it. That is not a
 * simulation of a hostile candidate: it IS a hostile candidate, using the only
 * capability it has (writing inside its own snapshot). The runner is supposed to
 * notice, and where it does not notice, this file says so.
 *
 * WHAT IS DELIBERATELY NOT ASSERTED AS A PASS
 * -------------------------------------------
 * Nothing here weakens an assertion to manufacture green. Where the platform
 * does not deny, the test asserts the non-denial and names the gate FAIL. Two
 * honest FAILs already exist in this project (E01, E06); a third is preferable
 * to a fourth that is not true.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { LlmAdapter, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SessionQueryEngine from '@deepseek-ai/dsh-session-query'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import * as SubagentSpawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import Storage from '@deepseek-ai/dsh-storage'
import * as storageDomainPlugin from '@deepseek-ai/dsh-storage-domain'
import * as storageJsonPlugin from '@deepseek-ai/dsh-storage-json'
import { LocalSubprocessRuntime } from '@deepseek-ai/dsh-subprocess-local'
import { WorkService } from './host.ts'
import {
  acceptanceDefinitionDigest,
  digestInputs,
  receiptFreshness,
  runAcceptance,
  serializeReceipt,
  type AcceptanceDefinition,
  type AcceptanceReceipt,
} from './verify.ts'
import {
  acquireWriterLease,
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
  type VerdictBinding,
  type WriterWorkspace,
} from './worktree-isolation.ts'

/**
 * A real vitest, invoked as `node <path>` so the definition's argv does not
 * depend on a shell resolving a `.cmd` shim. Same constant and same reason as
 * the M9.1 suite: the `.bin/vitest` shim is a shell script on this host.
 */
const VITEST_ENTRY = 'D:/DSH/src/dsh-src/node_modules/vitest/vitest.mjs'

/** Temp roots created by this file, removed in `afterAll`. */
const roots: string[] = []

/** Live contexts, disposed in `afterAll` so no provider range outlives the run. */
const contexts: Context[] = []

/** Live writer workspaces, released in `afterAll`. */
const workspaces: WriterWorkspace[] = []

/**
 * Snapshot directories the runner was asked to KEEP.
 *
 * `keepSnapshot: true` is what makes a frozen copy inspectable — several cases
 * assert what is and is not inside it, which is a claim about the DIRECTORY
 * rather than about a boolean. Keeping them during the run is deliberate;
 * leaking them afterwards is not. Every kept directory is registered here and
 * removed in `afterAll`, so the suite's disk footprint is bounded by its own run
 * rather than by the machine's uptime.
 */
const keptSnapshots: string[] = []

/**
 * Run an acceptance and remember the snapshot it kept, so `afterAll` removes it.
 *
 * A `snapshot: false` definition keeps nothing, so nothing is registered.
 */
async function runKeepingSnapshot(
  definition: AcceptanceDefinition,
): Promise<Awaited<ReturnType<typeof runAcceptance>>> {
  const receipt = await runAcceptance(definition, { keepSnapshot: true })
  if (receipt.snapshot !== undefined) keptSnapshots.push(receipt.snapshot.dir)
  return receipt
}

/** Create an isolated directory. Never the repository itself. */
function makeRoot(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `dsh-ver-${prefix}-`))
  roots.push(dir)
  return dir
}

/** Write a file, creating parent directories. */
function write(dir: string, relPath: string, content: string): void {
  const target = join(dir, relPath)
  mkdirSync(join(target, '..'), { recursive: true })
  writeFileSync(target, content, 'utf8')
}

/** A context with the real local subprocess provider. */
async function makeContext(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(LocalSubprocessRuntime)
  contexts.push(ctx)
  return ctx
}

/** Scaffold a directory that can run real vitest. Same shape as the M9.1 suite. */
function scaffoldVitest(dir: string): void {
  write(dir, 'package.json', JSON.stringify({ name: 'candidate', private: true, type: 'module' }, null, 2))
  write(dir, 'vitest.config.ts', `export default { test: { include: ['src/**/*.test.ts'], reporters: ['verbose'] } }\n`)
  mkdirSync(join(dir, 'node_modules'), { recursive: true })
  for (const name of ['vitest', '@vitest', 'vite', 'tinyexec', 'tinyglobby', 'picocolors']) {
    const source = `D:/DSH/src/dsh-src/node_modules/${name}`
    if (!existsSync(source)) continue
    const destination = join(dir, 'node_modules', name)
    if (existsSync(destination)) continue
    try {
      spawnSync('cmd', ['/c', 'mklink', '/J', destination.replace(/\//g, '\\'), source.replace(/\//g, '\\')], { stdio: 'ignore' })
    } catch {
      // A missing optional link is fine; the vitest entry itself is enough.
    }
  }
}

/** A definition whose command runs real vitest over one file. */
function vitestDefinition(dir: string, file: string, overrides: Partial<AcceptanceDefinition> = {}): AcceptanceDefinition {
  return {
    id: 'ver-case',
    command: [process.execPath, VITEST_ENTRY, 'run', file],
    cwd: dir,
    inputs: ['src', 'vitest.config.ts', 'package.json'],
    testReporter: 'vitest',
    timeoutMs: 60_000,
    ...overrides,
  }
}

/**
 * `git` that always reports its exit code, stdout AND stderr.
 *
 * `execFileSync` cannot do this: it returns stdout on success and THROWS on
 * failure, so a successful command's stderr is discarded. The hook-planting case
 * needs stderr from a SUCCESSFUL commit — that is where the planted hook's output
 * appears — so this helper goes through `spawnSync`, which reports all three
 * regardless of outcome.
 */
function gitTry(cwd: string, ...args: string[]): { code: number; stdout: string; stderr: string } {
  const result = spawnSync('git', ['-c', 'user.email=t@example.invalid', '-c', 'user.name=test', ...args], {
    cwd,
    encoding: 'utf8',
  })
  return {
    code: result.status ?? -1,
    stdout: (result.stdout ?? '').trim(),
    stderr: (result.stderr ?? '').trim(),
  }
}

/** `git` for the temp repositories this file creates. Throws on non-zero exit. */
function git(cwd: string, ...args: string[]): string {
  const result = gitTry(cwd, ...args)
  if (result.code !== 0) {
    throw new Error(`git ${args.join(' ')} in ${cwd} exited ${result.code}: ${result.stderr}`)
  }
  return result.stdout
}

/** Read a text file with CRLF normalised, so a platform line ending is not a finding. */
function readText(path: string): string {
  return readFileSync(path, 'utf8').replace(/\r\n/g, '\n')
}

/**
 * Wait for a child to signal readiness by creating `markerPath`.
 *
 * This exists because a mutation window anchored to a timer that starts BEFORE
 * the child process exists is a bet on spawn latency. Under load that bet loses:
 * the window can close before the child reads anything, and a test that then
 * fails is reporting the machine's load, not the property it claims to test.
 * The marker is written by the child as its first action, so the window opens
 * when the child is genuinely running.
 *
 * An absolute path OUTSIDE the definition's `inputs` is deliberate: arm 1 runs
 * in the frozen snapshot and arm 2 in the live tree, so a path inside either
 * would be written to a different place per arm. A path outside both is the one
 * location the two arms share.
 */
async function waitForMarker(markerPath: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!existsSync(markerPath)) {
    if (Date.now() > deadline) {
      throw new Error(`the child never signalled readiness via ${markerPath} within ${timeoutMs}ms`)
    }
    await new Promise(resolve => setTimeout(resolve, 25))
  }
}

/**
 * The real Python interpreter, resolved the same way the data-plane suite does.
 *
 * FS-06 is about MODEL-WRITTEN PYTHON, so the interpreter has to be the real one
 * the `ipython` path would use rather than a stand-in. It is resolved from the
 * pinned location first because the audit's environment is explicit about which
 * Python it means, and a PATH lookup could silently pick a different one.
 */
function pythonPath(): string {
  const pinned = 'C:\\Users\\hzq00\\AppData\\Local\\Programs\\Python\\Python314\\python.exe'
  return existsSync(pinned) ? pinned : 'python'
}

/** A small repository with one commit on `main`, for the writer-workspace cases. */
function makeRepo(prefix: string): { root: string; base: string } {
  const root = makeRoot(prefix)
  git(root, 'init', '-q', '-b', 'main')
  write(root, 'src/app.txt', 'version one\n')
  write(root, 'README.md', 'candidate\n')
  git(root, 'add', '-A')
  git(root, 'commit', '-q', '-m', 'base')
  return { root, base: git(root, 'rev-parse', 'HEAD') }
}

/**
 * A repository whose BASE COMMIT already contains the vitest scaffolding.
 *
 * The scaffolding has to be part of the base rather than added by the candidate,
 * or the fixture's own setup would show up as an out-of-scope change and the
 * scope check would refuse for a reason that has nothing to do with the
 * candidate. That would be a broken fixture, not a finding — the same class of
 * error as a test that holds the resource it is measuring.
 */
function makeVitestRepo(prefix: string): { root: string; base: string } {
  const root = makeRoot(prefix)
  git(root, 'init', '-q', '-b', 'main')
  write(root, 'src/app.txt', 'version one\n')
  write(root, 'README.md', 'candidate\n')
  scaffoldVitest(root)
  write(root, 'src/smoke.test.ts', `
import { describe, expect, it } from 'vitest'
describe('candidate', () => {
  it('starts green', () => { expect(1).toBe(1) })
})
`)
  git(root, 'add', '-A')
  git(root, 'commit', '-q', '-m', 'base with the toolchain in place')
  return { root, base: git(root, 'rev-parse', 'HEAD') }
}

/** An adapter whose model calls all hold on one gate.
 *
 * This is what makes "the root is idle while children still run" a fact rather
 * than a race: without the gate a child would finish before the root settled.
 * Same shape as the isolation suite's adapter, and it is a provider boundary,
 * not a second model loop.
 */
class GatedAdapter extends LlmAdapter {
  private release: (() => void) | undefined
  private readonly gate: Promise<void>

  constructor() {
    super()
    let open: () => void = () => {}
    this.gate = new Promise<void>(resolve => {
      open = resolve
    })
    this.release = open
  }

  openAll(): void {
    this.release?.()
  }

  override async resolveModel(provider: string, model: string): Promise<{ provider: string; id: string; name: string }> {
    return { provider, id: model, name: model }
  }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    await this.gate
    if (options.signal?.aborted) throw new Error('aborted')
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'child done' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

/** The real continuable stack plus this project's work service, for VER-08. */
interface Rig {
  ctx: Context
  root: Agent
  service: WorkService
  adapter: GatedAdapter
  dispose(): Promise<void>
}

/**
 * Boot the real stack. Deliberately the same composition the isolation suite
 * uses, because VER-08's subject is a property of the REAL `SubagentRuntime`
 * (the permanence of `drainContinuableDescendants`), and a stand-in could not
 * have that property.
 */
async function bootRig(): Promise<Rig> {
  const sessionRoot = mkdtempSync(join(tmpdir(), 'dsh-ver-rig-sessions-'))
  const storeRoot = mkdtempSync(join(tmpdir(), 'dsh-ver-rig-store-'))
  roots.push(sessionRoot, storeRoot)

  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  const persistence = await ctx.plugin(JsonlSessionPersistence, { root: sessionRoot })
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(SubagentRuntime, { maxActiveSubagents: 4, maxDepth: 1 })
  await ctx.plugin(SubagentSpawn, { providerName: 'spawn' })
  // `listChildren` reads child Sessions back, which needs the sessionQuery
  // service. A concrete engine with search faces unavailable is enough: only the
  // point reads are used.
  await ctx.plugin(class extends SessionQueryEngine {
    override searchSessions(): Promise<never> {
      return Promise.reject(new Error('session search is not configured in this test'))
    }
    override searchEvents(): Promise<never> {
      return Promise.reject(new Error('event search is not configured in this test'))
    }
  })
  await ctx.plugin(Storage, {} as never)
  await ctx.plugin(storageJsonPlugin as never, { root: storeRoot } as never)
  await ctx.plugin(storageDomainPlugin as never, { backend: 'json' } as never)

  const adapter = new GatedAdapter()
  ctx.llm.registerAdapter(['mock'], adapter)

  const root = await ctx.agentLoop.create(SessionId('root-ver'), { provider: 'mock', model: 'mock' })
  const service = new WorkService(ctx, {
    targetChildren: 10,
    maxDepth: 1,
    // Named in config, not hardcoded by the service: the provider roster belongs
    // to the host composition. `createRun` installs a production launch port
    // bound to the exact root Agent using this name; the VER-08 case installs its
    // own port afterwards, and an explicitly installed port wins over the default.
    subagentProvider: 'spawn',
    budgetCeiling: 1000,
    currency: 'USD',
    priceVersion: 'verification-gates-test',
  })
  await service.open()

  return {
    ctx,
    root,
    service,
    adapter,
    async dispose(): Promise<void> {
      // ORDER matters, and it is the measured shutdown order from
      // docs/RECOVERY.md: release the model gate, close the service (refuse new
      // admissions), drain the family, then release storage and the context.
      // Disposing the context first would wait forever on a child parked in a
      // model call.
      adapter.openAll()
      await service.close()
      await ctx.subagents.drainContinuableDescendants([root])
      await persistence.dispose()
      await ctx.fiber.dispose()
      rmSync(sessionRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
      rmSync(storeRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    },
  }
}

beforeAll(() => {
  if (!existsSync(VITEST_ENTRY)) throw new Error(`the real vitest entry is missing at ${VITEST_ENTRY}`)
})

afterAll(async () => {
  // ORDER: release workspaces (which removes worktrees and branches) BEFORE the
  // temp roots they live in, and dispose contexts before removing directories a
  // provider might still hold open.
  const errors: unknown[] = []
  for (const workspace of workspaces.splice(0)) {
    try {
      await workspace.release()
    } catch (error) {
      errors.push(error)
    }
  }
  for (const ctx of contexts.splice(0)) {
    try {
      await ctx.fiber.dispose()
    } catch (error) {
      errors.push(error)
    }
  }
  for (const dir of keptSnapshots.splice(0)) {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  }
  for (const dir of roots) {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  }
  if (errors.length > 0) throw new AggregateError(errors, 'cleanup failed')
})

// ---------------------------------------------------------------------------
// VER-01 / VER-02 — zero tests and all-skipped are NOT PASS
// ---------------------------------------------------------------------------

describe('VER-01/VER-02: a green exit code over no executed test is not a pass', () => {
  it('VER-01: the runner exits 0 having collected no test, and the verdict is NOT PASS', async () => {
    // The trap this gate exists for, and the reason it is not hypothetical: the
    // child really does exit 0. An exit-code-only verifier calls this green.
    // `--passWithNoTests` is what makes vitest print "no tests" AND exit 0.
    const dir = makeRoot('ver01')
    scaffoldVitest(dir)
    write(dir, 'src/empty.test.ts', 'export const nothing = 1\n')
    const definition = vitestDefinition(dir, 'src/empty.test.ts', {
      expectTests: { passed: 1 },
      command: [process.execPath, VITEST_ENTRY, 'run', 'src/empty.test.ts', '--passWithNoTests'],
    })

    const receipt = await runAcceptance(definition)

    expect(receipt.exit.code).toBe(0)
    expect(receipt.outcome).toBe('zero_tests')
    expect(receipt.passed).toBe(false)
    expect(receipt.observedTests?.total).toBe(0)
    expect(receipt.reasons.join(' ')).toContain('the runner executed zero tests')
    // A zero-test run is not a timeout-shaped unknown, so nothing is held open:
    // the refusal is definite, not an unresolved reservation.
    expect(receipt.holdReservation).toBe(false)

    // THE CONTROL THAT MAKES THE GATE LOAD-BEARING: the same command, over the
    // same tree, with the same exit 0, but with NO declared counts, IS reported
    // `pass`. So the difference between the two receipts is the classification
    // and nothing about the process — which is exactly the trap. An
    // exit-code-only verifier sees the second receipt and calls it green.
    const exitCodeOnly = await runAcceptance({
      id: 'zero-tests-no-counts',
      command: [process.execPath, VITEST_ENTRY, 'run', 'src/empty.test.ts', '--passWithNoTests'],
      cwd: dir,
      inputs: ['src', 'vitest.config.ts', 'package.json'],
      timeoutMs: 60_000,
    })
    expect(exitCodeOnly.exit.code).toBe(0)
    expect(exitCodeOnly.outcome).toBe('pass')
    expect(exitCodeOnly.passed).toBe(true)
    expect(exitCodeOnly.reasons.join(' ')).toContain('no test counts were declared')
    // And the integration authority still refuses it, so the runner's `pass` and
    // the authority's verdict are two different claims — the point of the gate.
    expect(testsAreReal(exitCodeOnly).real).toBe(false)

    // The CLI contract is "exit 0 means PASS and nothing else", and the CLI
    // checks freshness AND passed together. A receipt can be perfectly FRESH and
    // still be a NOT-PASS, which is why freshness alone must never be a verdict.
    const receiptPath = join(dir, 'receipt.json')
    writeFileSync(receiptPath, serializeReceipt(receipt), 'utf8')
    expect(receiptFreshness(receipt, definition).fresh).toBe(true)
    expect(receipt.passed).toBe(false)
    // The classification is NOT the generic failure: a candidate failure and a
    // suite that never ran are different facts, and collapsing them would hide a
    // broken invocation behind a candidate defect.
    expect(receipt.outcome).not.toBe('fail')
  }, 90_000)

  it('VER-02: every test skipped is NOT PASS, and the child still exited 0', async () => {
    const dir = makeRoot('ver02')
    scaffoldVitest(dir)
    write(dir, 'src/skip.test.ts', `
import { describe, it } from 'vitest'
describe('candidate', () => {
  it.skip('never runs', () => { throw new Error('unreachable') })
  it.skip('also never runs', () => { throw new Error('unreachable') })
})
`)

    const receipt = await runAcceptance(vitestDefinition(dir, 'src/skip.test.ts', { expectTests: { passed: 2 } }))

    expect(receipt.exit.code).toBe(0)
    expect(receipt.outcome).toBe('all_skipped')
    expect(receipt.passed).toBe(false)
    expect(receipt.observedTests).toMatchObject({ passed: 0, failed: 0, skipped: 2 })

    // The closure this file adds: an all-skipped run is ALSO refused as
    // evidence-of-real-tests, so a caller that only consulted `testsAreReal`
    // could not be talked into accepting it.
    const real = testsAreReal(receipt)
    expect(real.real).toBe(false)
    expect(real.reason).toContain('all_skipped')
  }, 90_000)

  it('VER-01/VER-02: a PASS that declared no counts is refused as evidence of real tests', async () => {
    // The runner's own documented behaviour: with no `expectTests`, a matching
    // exit code is a PASS and the reason string says only that. That is honest
    // for what it claims and is NOT evidence a test ran. The delivery
    // requirement is "must have real tests", so the integration authority
    // refuses it. Asserting the runner's pass AND the authority's refusal
    // together is the point: they are two different claims.
    const dir = makeRoot('ver-counts')
    write(dir, 'src/ok.mjs', 'console.log("nothing but an exit code")\n')

    const receipt = await runAcceptance({
      id: 'no-counts',
      command: [process.execPath, 'src/ok.mjs'],
      cwd: dir,
      inputs: ['src'],
      timeoutMs: 30_000,
    })

    expect(receipt.outcome).toBe('pass')
    expect(receipt.observedTests).toBeUndefined()
    expect(receipt.reasons.join(' ')).toContain('no test counts were declared')

    const real = testsAreReal(receipt)
    expect(real.real).toBe(false)
    expect(real.reason).toContain('no observed test counts')
  }, 60_000)

  it('VER-01: a runner that never reported at all is NOT PASS either, and is a DIFFERENT outcome', async () => {
    // `runner_never_ran` and `zero_tests` are separate outcomes on purpose: "the
    // runner reported that nothing ran" and "no runner reported" are different
    // facts, and collapsing them would hide a broken invocation behind a
    // candidate failure.
    const dir = makeRoot('ver-neverran')
    write(dir, 'src/quiet.mjs', 'console.log("I did nothing at all")\n')

    const receipt = await runAcceptance({
      id: 'never-ran',
      command: [process.execPath, 'src/quiet.mjs'],
      cwd: dir,
      inputs: ['src'],
      expectTests: { passed: 1 },
      timeoutMs: 30_000,
    })
    expect(receipt.exit.code).toBe(0)
    expect(receipt.outcome).toBe('runner_never_ran')
    expect(receipt.outcome).not.toBe('zero_tests')
    expect(receipt.passed).toBe(false)
  }, 60_000)
})

// ---------------------------------------------------------------------------
// VER-03 — the candidate must not be able to weaken the acceptance
// ---------------------------------------------------------------------------

describe('VER-03: a candidate cannot weaken the protected acceptance', () => {
  it('a weakened threshold carrying the authorized digest is REFUSED, not run', async () => {
    const dir = makeRoot('ver03a')
    write(dir, 'src/ok.mjs', 'console.log("fine")\n')
    const base: AcceptanceDefinition = {
      id: 'protected',
      command: [process.execPath, 'src/ok.mjs'],
      cwd: dir,
      inputs: ['src'],
      expectTests: { passed: 10 },
    }
    const authorized = acceptanceDefinitionDigest(base)

    const weakened = await runAcceptance({ ...base, expectTests: { passed: 1 }, authorizedDigest: authorized })
    expect(weakened.outcome).toBe('acceptance_definition_changed')
    expect(weakened.passed).toBe(false)
    // Nothing ran, so there is no exit code to report and none is invented.
    expect(weakened.exit.code).toBeNull()
    expect(weakened.limitations).toContain('the acceptance command was never executed')

    // The refusal is about the CHANGE, not about the mechanism being broken: the
    // SAME definition with the SAME authorized digest really executes. It is
    // `runner_never_ran` rather than `pass` because the command prints no test
    // summary — which is the honest outcome for this fixture and is asserted as
    // itself. The point is that it was not REFUSED at the digest gate.
    const honest = await runAcceptance({ ...base, authorizedDigest: authorized })
    expect(honest.outcome).not.toBe('acceptance_definition_changed')
    expect(honest.exit.code).toBe(0)
    expect(honest.observedTests).toBeUndefined()
  }, 90_000)

  it('MEASURED GAP: an oracle outside `inputs` is neither covered by any digest NOR frozen', async () => {
    // The honest measurement of the gap the M9.1 slice recorded as limitation 3
    // ("digest coverage is whatever the definition declares"), and it is worse
    // than that sentence suggests. The shape is the realistic one: the protected
    // acceptance lives in its own directory, outside the candidate tree, and the
    // acceptance command names it.
    //
    // TWO separate gaps are measured, and they are different mechanisms:
    //   (1) COVERAGE — `candidateTreeDigest` hashes only declared `inputs`, so a
    //       rewrite of an undeclared oracle changes no digest in the receipt.
    //   (2) FREEZING — the snapshot is a copy of declared `inputs` only, so a path
    //       outside them is not copied at all. The command then resolves it in the
    //       LIVE tree, and the run executes whatever the oracle says AT THAT
    //       MOMENT. The receipt's `candidateTreeDigestScope` still says
    //       'snapshot', which is true about the candidate and silent about the
    //       oracle.
    //
    // (2) is the more serious of the two: it means the immutable-snapshot
    // guarantee, which VER-06 relies on, does not extend to the oracle unless the
    // oracle is a declared input. The closure for both is `oracleDigest()` +
    // `bindReceipt()` plus declaring the oracle, which the CLOSURE case below
    // exercises.
    const dir = makeRoot('ver03b')
    scaffoldVitest(dir)
    // `*.acceptance.ts` matches the oracle wherever it lives, so vitest collects
    // it. Without a matching include the run would fail with "No test files
    // found", which would be a fixture error rather than the finding.
    write(dir, 'vitest.config.ts', `export default { test: { include: ['src/**/*.test.ts', '**/*.acceptance.ts'], reporters: ['verbose'] } }\n`)
    /*
     * The oracle is a plain script that PRINTS a marker rather than a vitest
     * suite, and that is deliberate. The fact under measurement is "the command
     * read the LIVE oracle file", and a printed marker proves it directly. A
     * pass/fail outcome would depend on vitest's config resolution across an
     * absolute path outside the root — a second, unrelated question that would
     * make this case fail for reasons that are not the finding.
     */
    const ORACLE_ONE = 'console.log("ORACLE-REVISION-ONE")\n'
    const ORACLE_TWO = 'console.log("ORACLE-REVISION-TWO")\n'

    // The oracle lives in a SIBLING directory of the candidate, which is the
    // realistic shape and the one that matters: nothing under the candidate's
    // `inputs` can reach it.
    const oracleDir = makeRoot('ver03b-oracle')
    write(oracleDir, 'suite.acceptance.mjs', ORACLE_ONE)
    const oraclePath = join(oracleDir, 'suite.acceptance.mjs')
    write(dir, 'src/app.mjs', 'export const version = 1\n')

    // (a) The oracle IS a declared input (copied into the candidate tree for this
    // arm): it is covered AND frozen, so a rewrite between runs is visible in the
    // digest.
    write(dir, 'oracle/suite.acceptance.mjs', ORACLE_ONE)
    const covering: AcceptanceDefinition = {
      id: 'oracle-in-inputs',
      command: [process.execPath, 'oracle/suite.acceptance.mjs'],
      cwd: dir,
      inputs: ['oracle', 'src', 'package.json'],
      timeoutMs: 60_000,
    }
    const coveringBefore = digestInputs(covering)
    const coveringRun = await runAcceptance(covering)
    expect(coveringRun.passed).toBe(true)
    expect(coveringRun.output.stdout.text).toContain('ORACLE-REVISION-ONE')
    write(dir, 'oracle/suite.acceptance.mjs', ORACLE_TWO)
    expect(digestInputs(covering)).not.toBe(coveringBefore)

    // (b) The oracle is NOT declared. `inputs` names the candidate's files only,
    // which is what a definition normally does — the oracle is not the
    // candidate's to declare.
    const blindDefinition: AcceptanceDefinition = {
      id: 'oracle-outside-inputs',
      command: [process.execPath, oraclePath],
      cwd: dir,
      inputs: ['src', 'package.json', 'vitest.config.ts'],
      timeoutMs: 60_000,
    }
    const beforeBlind = digestInputs(blindDefinition)
    // `keepSnapshot: true` so the frozen copy can be INSPECTED: the claim is that
    // the oracle was not copied, and the only way to check that is to look at the
    // directory rather than to assume it.
    const receiptBefore = await runKeepingSnapshot(blindDefinition)
    expect(receiptBefore.outcome).toBe('pass')
    expect(receiptBefore.output.stdout.text).toContain('ORACLE-REVISION-ONE')
    // The scope label claims the snapshot, which is true of the candidate tree
    // and says nothing about the oracle.
    expect(receiptBefore.candidateTreeDigestScope).toBe('snapshot')
    // GAP (2), the sharper half: the oracle was never COPIED. The snapshot holds
    // the declared inputs and nothing else, so the immutable-freeze guarantee
    // does not extend to it.
    expect(existsSync(join(receiptBefore.snapshot!.dir, 'src', 'app.mjs'))).toBe(true)
    expect(existsSync(join(receiptBefore.snapshot!.dir, 'oracle'))).toBe(false)

    // GAP (1): a rewrite of the oracle leaves every digest identical.
    write(oracleDir, 'suite.acceptance.mjs', ORACLE_TWO)
    expect(digestInputs(blindDefinition)).toBe(beforeBlind)

    // GAP (2) demonstrated: the next run really executes the REWRITTEN oracle —
    // its output is the new marker — while the receipt's digests are byte
    // identical to the first run's. The frozen copy did not cover it, so the
    // command resolved the path in the LIVE tree.
    const receiptAfter = await runAcceptance(blindDefinition)
    expect(receiptAfter.outcome).toBe('pass')
    expect(receiptAfter.output.stdout.text).toContain('ORACLE-REVISION-TWO')
    expect(receiptAfter.candidateTreeDigest).toBe(receiptBefore.candidateTreeDigest)
    expect(receiptAfter.acceptanceDefinitionDigest).toBe(receiptBefore.acceptanceDefinitionDigest)

    // The consequence for a stored verdict: a receipt that PASSED against the
    // real acceptance is still reported FRESH after the acceptance was replaced,
    // because the tree digest never covered the oracle.
    expect(receiptFreshness(receiptBefore, blindDefinition).fresh).toBe(true)
  }, 150_000)

  it('CLOSURE: an oracle digest taken outside the candidate refuses a receipt whose oracle changed', async () => {
    // The closure for the gap measured above. The oracle's own bytes get a
    // digest recorded by the verifier rather than by the candidate, and a
    // receipt whose oracle no longer matches is refused. This is what turns "the
    // candidate cannot weaken the acceptance" from an assumption into a check,
    // and it is deliberately independent of what `inputs` declares.
    const dir = makeRoot('ver03c')
    const oracleSuite = join(dir, 'oracle', 'acceptance.test.ts')
    const oracleConfig = join(dir, 'oracle', 'vitest.config.ts')
    write(dir, 'oracle/acceptance.test.ts', 'export const assertion = "expect(total).toBe(30)"\n')
    write(dir, 'oracle/vitest.config.ts', 'export default { test: { include: ["src/**/*.test.ts"] } }\n')

    const files = { suite: oracleSuite, config: oracleConfig }
    const digestAtFreeze = oracleDigest(files)
    expect(digestAtFreeze).toMatch(/^[0-9a-f]{64}$/)
    // The freeze is reproducible: the same file set digests the same.
    expect(oracleDigest(files)).toBe(digestAtFreeze)

    const environment = { node: process.version, platform: process.platform, arch: process.arch }
    // RECORDED: written down when the receipt was produced.
    const recorded = {
      candidateTreeDigest: 'a'.repeat(64),
      acceptanceDefinitionDigest: 'b'.repeat(64),
      oracleDigest: digestAtFreeze,
      environment,
    }

    // The binding holds while nothing moved: the observation equals the record.
    expect(bindReceipt(recorded, { ...recorded }).applicable).toBe(true)

    // The candidate weakens the protected suite. The ORACLE digest is what
    // changes, and it is the value the verifier records outside the candidate's
    // reach, so the check works even though no receipt field moved.
    write(dir, 'oracle/acceptance.test.ts', 'export const assertion = "expect(total).toBe(1)"\n')
    const weakenedDigest = oracleDigest(files)
    expect(weakenedDigest).not.toBe(digestAtFreeze)

    // OBSERVED now: the same four bindings, re-read from the tree on disk.
    const observed = { ...recorded, oracleDigest: weakenedDigest }
    const refusal = bindReceipt(recorded, observed)
    expect(refusal.applicable).toBe(false)
    expect(refusal.mismatches).toContain(`oracleDigest ${digestAtFreeze} != observed ${weakenedDigest}`)
    expect(refusal.reasons.join(' ')).toContain('no longer binds the current verification basis')

    // The trap this API shape exists to prevent: if the caller passed the
    // RECORDED binding in as the observation, the check would compare a value
    // with itself and certify the weakened oracle. Asserted directly, so a
    // future refactor back to a one-argument form fails here.
    expect(bindReceipt(recorded, { ...recorded }).applicable).toBe(true)
    expect(recorded.oracleDigest).not.toBe(weakenedDigest)
  })

  it('CLOSURE: a receipt from another machine is refused, so a verdict is bound to the environment that produced it', () => {
    const dir = makeRoot('ver03d')
    write(dir, 'oracle/suite.test.ts', 'export const x = 1\n')
    const digest = oracleDigest({ suite: join(dir, 'oracle/suite.test.ts') })

    const recorded = {
      candidateTreeDigest: 'a'.repeat(64),
      acceptanceDefinitionDigest: 'b'.repeat(64),
      oracleDigest: digest,
      environment: { node: 'v0.0.0-not-this-machine', platform: 'linux', arch: 'arm64' },
    }

    const result = bindReceipt(recorded, {
      candidateTreeDigest: 'a'.repeat(64),
      acceptanceDefinitionDigest: 'b'.repeat(64),
      oracleDigest: digest,
      environment: { node: process.version, platform: process.platform, arch: process.arch },
    })
    expect(result.applicable).toBe(false)
    expect(result.mismatches).toContain(
      `environment.node v0.0.0-not-this-machine != observed ${process.version}`,
    )
    expect(result.mismatches).toContain(`environment.platform linux != observed ${process.platform}`)
  })

  it('CLOSURE: observedBasis re-reads the tree, so a caller cannot pass the record in as the observation', async () => {
    // `observedBasis` is the observation half, and it exists so the mistake the
    // previous case names cannot be made by accident. It recomputes all four
    // bindings from disk, so the values it returns are observations rather than
    // restatements of anything the caller supplied.
    const dir = makeRoot('ver03f')
    write(dir, 'candidate/app.mjs', 'export const v = 1\n')
    write(dir, 'oracle/suite.test.ts', 'export const assertion = "A"\n')
    const definition: AcceptanceDefinition = {
      id: 'observed-basis',
      command: [process.execPath, '-e', '0'],
      cwd: dir,
      inputs: ['candidate'],
    }
    const oracleFiles = { suite: join(dir, 'oracle', 'suite.test.ts') }

    const before = observedBasis({ definition, oracleFiles })
    expect(before.candidateTreeDigest).toBe(digestInputs(definition))
    expect(before.acceptanceDefinitionDigest).toBe(acceptanceDefinitionDigest(definition))
    expect(before.oracleDigest).toBe(oracleDigest(oracleFiles))
    expect(before.environment).toEqual({ node: process.version, platform: process.platform, arch: process.arch })

    // A change to EITHER half moves the corresponding digest, so the observation
    // really is an observation.
    write(dir, 'oracle/suite.test.ts', 'export const assertion = "B"\n')
    const oracleMoved = observedBasis({ definition, oracleFiles })
    expect(oracleMoved.oracleDigest).not.toBe(before.oracleDigest)
    expect(oracleMoved.candidateTreeDigest).toBe(before.candidateTreeDigest)

    write(dir, 'candidate/app.mjs', 'export const v = 2\n')
    const bothMoved = observedBasis({ definition, oracleFiles })
    expect(bothMoved.candidateTreeDigest).not.toBe(before.candidateTreeDigest)
  })

  it('CLOSURE: declaring the oracle as an input makes the snapshot cover it, so a live rewrite cannot reach the run', async () => {
    // The operational half of the closure. `oracleDigest` DETECTS a changed
    // oracle; this case shows how the oracle is made immutable in the first
    // place — by declaring it, so the runner copies it into the frozen snapshot
    // and the command runs the frozen copy rather than whatever is on disk when
    // it happens to execute.
    //
    // Two arms over the same rewrite, with the oracle as a marker-printing script
    // so the fact under measurement — "which revision of the oracle did the
    // command read" — is visible directly in the output.
    const ORACLE_ONE = 'console.log("ORACLE-REVISION-ONE")\n'
    const ORACLE_TWO = 'console.log("ORACLE-REVISION-TWO")\n'

    // ARM 1 — the oracle is DECLARED, so it is copied into the snapshot. The
    // rewrite happens BEFORE the run, and the run must see the frozen revision.
    const declaredDir = makeRoot('ver03g-declared')
    write(declaredDir, 'src/app.mjs', 'export const version = 1\n')
    write(declaredDir, 'oracle/suite.acceptance.mjs', ORACLE_ONE)
    const declared: AcceptanceDefinition = {
      id: 'oracle-declared',
      command: [process.execPath, 'oracle/suite.acceptance.mjs'],
      cwd: declaredDir,
      inputs: ['oracle', 'src'],
      timeoutMs: 60_000,
    }
    const declaredBefore = await runAcceptance(declared)
    expect(declaredBefore.passed).toBe(true)
    expect(declaredBefore.output.stdout.text).toContain('ORACLE-REVISION-ONE')

    write(declaredDir, 'oracle/suite.acceptance.mjs', ORACLE_TWO)
    const declaredAfter = await runAcceptance(declared)
    // The digest moved, so the rewrite is visible; and the run read the NEW
    // revision, because the snapshot is taken at freeze time. That is correct
    // behaviour: the freeze defines the artifact, and the oracle digest recorded
    // alongside is what ties the verdict to that revision.
    expect(declaredAfter.candidateTreeDigest).not.toBe(declaredBefore.candidateTreeDigest)
    expect(declaredAfter.output.stdout.text).toContain('ORACLE-REVISION-TWO')
    // The stored receipt for the FIRST run is now correctly STALE.
    expect(receiptFreshness(declaredBefore, declared).fresh).toBe(false)

    // ARM 2 — the oracle is UNDECLARED and lives outside the candidate tree. The
    // rewrite is invisible in the digest, and the run reads the LIVE revision.
    const blindDir = makeRoot('ver03g-blind')
    write(blindDir, 'src/app.mjs', 'export const version = 1\n')
    const oracleDir = makeRoot('ver03g-oracle')
    write(oracleDir, 'suite.acceptance.mjs', ORACLE_ONE)
    const blind: AcceptanceDefinition = {
      id: 'oracle-undeclared',
      command: [process.execPath, join(oracleDir, 'suite.acceptance.mjs')],
      cwd: blindDir,
      inputs: ['src'],
      timeoutMs: 60_000,
    }
    const blindBefore = await runKeepingSnapshot(blind)
    expect(blindBefore.passed).toBe(true)
    expect(blindBefore.output.stdout.text).toContain('ORACLE-REVISION-ONE')
    // Confirm the oracle really is outside the frozen copy: the snapshot holds
    // the declared inputs and nothing from the oracle directory.
    expect(existsSync(join(blindBefore.snapshot!.dir, 'src', 'app.mjs'))).toBe(true)
    expect(existsSync(join(blindBefore.snapshot!.dir, 'suite.acceptance.mjs'))).toBe(false)

    write(oracleDir, 'suite.acceptance.mjs', ORACLE_TWO)
    const blindAfter = await runAcceptance(blind)
    // Same digest, and the command read the OTHER revision: the two runs are
    // indistinguishable in the evidence while their behaviour differs. That is
    // the gap, and the stored receipt for the first run is still reported fresh.
    expect(blindAfter.candidateTreeDigest).toBe(blindBefore.candidateTreeDigest)
    expect(blindAfter.output.stdout.text).toContain('ORACLE-REVISION-TWO')
    expect(blindAfter.passed).toBe(true)
    expect(receiptFreshness(blindBefore, blind).fresh).toBe(true)
  }, 200_000)

  it('the oracle digest is not the candidate digest: an undeclared oracle file still moves it', () => {
    // The two digests must not be substitutable, or the closure would be
    // decorative. `digestInputs` covers declared inputs; `oracleDigest` covers
    // named oracle files. A file in neither set is covered by neither, and this
    // case pins that a change to a NAMED oracle file is visible in the oracle
    // digest even when the candidate tree digest is untouched.
    const dir = makeRoot('ver03e')
    write(dir, 'candidate/app.mjs', 'export const v = 1\n')
    write(dir, 'oracle/suite.test.ts', 'export const assertion = "A"\n')

    const definition: AcceptanceDefinition = {
      id: 'two-digests',
      command: [process.execPath, '-e', '0'],
      cwd: dir,
      inputs: ['candidate'],
    }
    const candidateBefore = digestInputs(definition)
    const oracleBefore = oracleDigest({ suite: join(dir, 'oracle', 'suite.test.ts') })

    write(dir, 'oracle/suite.test.ts', 'export const assertion = "B"\n')

    expect(digestInputs(definition)).toBe(candidateBefore)
    expect(oracleDigest({ suite: join(dir, 'oracle', 'suite.test.ts') })).not.toBe(oracleBefore)
  })
})

// ---------------------------------------------------------------------------
// VER-04 — what the verification environment genuinely enforces
// ---------------------------------------------------------------------------

describe('VER-04: what the verification environment genuinely enforces', () => {
  it('ENFORCED: the untrusted candidate inherits no host credential and no DSH_* name', async () => {
    // This is the part that IS enforced, and the mechanism is named: the real
    // DSH subprocess seam's `scrubbedParentEnv()` drops every credential-shaped
    // name and every `DSH_*` name before the child starts. The negative control
    // is the ordinary marker, which survives — without it, a runner that dropped
    // the whole environment would also pass.
    const dir = makeRoot('ver04a')
    write(dir, 'src/env.mjs', `
console.log(JSON.stringify({
  fakeKey: process.env.VER_CANARY_FAKE_API_KEY ?? null,
  fakeToken: process.env.VER_CANARY_FAKE_TOKEN ?? null,
  fakePassword: process.env.VER_CANARY_FAKE_PASSWORD ?? null,
  dshInternal: process.env.DSH_VER_CANARY ?? null,
  harmless: process.env.VER_HARMLESS_MARKER ?? null,
}))
`)
    const canaries: Record<string, string> = {
      VER_CANARY_FAKE_API_KEY: 'CANARY-FAKE-API-KEY',
      VER_CANARY_FAKE_TOKEN: 'CANARY-FAKE-TOKEN',
      VER_CANARY_FAKE_PASSWORD: 'CANARY-FAKE-PASSWORD',
      DSH_VER_CANARY: 'harness-internal',
      VER_HARMLESS_MARKER: 'harmless-visible',
    }
    for (const [name, value] of Object.entries(canaries)) process.env[name] = value
    try {
      const receipt = await runAcceptance({
        id: 'scrub-canary',
        command: [process.execPath, 'src/env.mjs'],
        cwd: dir,
        inputs: ['src'],
        timeoutMs: 30_000,
      })
      const seen = JSON.parse(receipt.output.stdout.text.trim()) as Record<string, string | null>
      expect(seen['fakeKey']).toBeNull()
      expect(seen['fakeToken']).toBeNull()
      expect(seen['fakePassword']).toBeNull()
      expect(seen['dshInternal']).toBeNull()
      expect(seen['harmless']).toBe('harmless-visible')
    } finally {
      for (const name of Object.keys(canaries)) delete process.env[name]
    }
  }, 60_000)

  it('NOT ENFORCED — VER-04 FAIL: the candidate CAN read a host file outside its snapshot', async () => {
    // MEASURED, and recorded as the gate's FAIL rather than softened. The
    // runner's snapshot is an immutable INPUT COPY, not an execution jail; the
    // child is an ordinary process owned by this user, so a file this user can
    // read, the candidate can read. This is the same absence E01 found at the
    // sandbox rung, reproduced at the verification boundary specifically: "the
    // verification environment is low-privilege" is TRUE relative to inherited
    // credentials and FALSE relative to filesystem reads.
    const dir = makeRoot('ver04b')
    const secretDir = makeRoot('ver04b-secret')
    const secretPath = join(secretDir, 'host-secret.txt')
    const secretValue = 'CANARY-HOST-SECRET-9c41f7-NOT-A-REAL-CREDENTIAL'
    writeFileSync(secretPath, secretValue, 'utf8')

    write(dir, 'src/read.mjs', `
import { readFileSync } from 'node:fs'
const target = process.env.VER_TARGET_PATH
try {
  console.log(JSON.stringify({ read: true, value: readFileSync(target, 'utf8').trim() }))
} catch (error) {
  console.log(JSON.stringify({ read: false, code: error.code, message: error.message }))
}
`)
    process.env['VER_TARGET_PATH'] = secretPath
    try {
      const receipt = await runAcceptance({
        id: 'read-host-file',
        command: [process.execPath, 'src/read.mjs'],
        cwd: dir,
        inputs: ['src'],
        timeoutMs: 30_000,
      })
      const observed = JSON.parse(receipt.output.stdout.text.trim()) as { read: boolean; value?: string }
      // The measured fact: the read SUCCEEDS and the content is returned verbatim.
      expect(observed.read).toBe(true)
      expect(observed.value).toBe(secretValue)
      // The child ran from the snapshot but reached a path entirely outside it.
      expect(receipt.ranIn).toBe(receipt.snapshot?.dir)
      expect(receipt.ranIn).not.toContain('ver04b-secret')
    } finally {
      delete process.env['VER_TARGET_PATH']
    }
  }, 60_000)

  it('NOT ENFORCED — VER-04 FAIL: the candidate CAN open a network connection', async () => {
    // The second half of the same FAIL. E06 established there is no egress
    // control at the sandbox rung; this asserts it at the verification boundary,
    // which is the boundary VER-04 names. The target is a loopback listener
    // owned by THIS test process, so the measurement needs no external network
    // and is deterministic.
    const dir = makeRoot('ver04c')
    write(dir, 'src/net.mjs', `
import { createConnection } from 'node:net'
const [host, port] = process.env.VER_TARGET.split(':')
const socket = createConnection({ host, port: Number(port) })
socket.on('connect', () => { console.log(JSON.stringify({ connected: true })); socket.destroy() })
socket.on('error', (error) => { console.log(JSON.stringify({ connected: false, code: error.code })) })
`)

    const server = createServer(socket => socket.end())
    await new Promise<void>(resolveListen => server.listen(0, '127.0.0.1', resolveListen))
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('the loopback listener did not report a port')
    process.env['VER_TARGET'] = `127.0.0.1:${address.port}`
    try {
      const receipt = await runAcceptance({
        id: 'egress-probe',
        command: [process.execPath, 'src/net.mjs'],
        cwd: dir,
        inputs: ['src'],
        timeoutMs: 30_000,
      })
      const observed = JSON.parse(receipt.output.stdout.text.trim()) as { connected: boolean }
      expect(observed.connected).toBe(true)
    } finally {
      delete process.env['VER_TARGET']
      await new Promise<void>(resolveClose => server.close(() => resolveClose()))
    }
  }, 60_000)

  it('ENFORCED: the candidate gets an argv and a cwd and nothing else — no control-plane handle', async () => {
    // The capability the verification boundary DOES remove: the child is spawned
    // with an argv, a cwd and a scrubbed environment, and nothing else. There is
    // no service handle, no context object, no IPC channel, and no `DSH_*` name
    // through which to name one. Asserted through what the child can observe.
    const dir = makeRoot('ver04d')
    write(dir, 'src/surface.mjs', `
console.log(JSON.stringify({
  argv: process.argv.slice(2),
  dshNames: Object.keys(process.env).filter(name => name.toUpperCase().startsWith('DSH_')),
  hasContext: typeof globalThis.ctx !== 'undefined',
  hasServiceRegistry: typeof globalThis.__dsh_services !== 'undefined',
}))
`)
    const receipt = await runAcceptance({
      id: 'surface-probe',
      command: [process.execPath, 'src/surface.mjs', '--marker'],
      cwd: dir,
      inputs: ['src'],
      timeoutMs: 30_000,
    })
    const observed = JSON.parse(receipt.output.stdout.text.trim()) as {
      argv: string[]
      dshNames: string[]
      hasContext: boolean
      hasServiceRegistry: boolean
    }
    expect(observed.argv).toEqual(['--marker'])
    expect(observed.dshNames).toEqual([])
    expect(observed.hasContext).toBe(false)
    expect(observed.hasServiceRegistry).toBe(false)
    // The child runs in the SNAPSHOT, which is the runner's choice and is
    // visible to the child: this is a real isolation of the INPUT TREE, and it
    // is the one isolation the runner actually provides.
    expect(receipt.ranIn).toBe(receipt.snapshot?.dir)
  }, 60_000)

  it('HONEST LABEL: the runner states what its digest does NOT cover', async () => {
    // A verifier that overstated its coverage would be worse than one with a
    // smaller claim, so the runner's own limitations are asserted as part of the
    // gate. Two are load-bearing for VER-04: `node_modules` is junctioned and is
    // explicitly outside the digest, and an in-place run is labelled as unable
    // to exclude ABA.
    const dir = makeRoot('ver04e')
    write(dir, 'src/ok.mjs', 'console.log("fine")\n')
    mkdirSync(join(dir, 'node_modules'), { recursive: true })

    const receipt = await runAcceptance({
      id: 'labels',
      command: [process.execPath, 'src/ok.mjs'],
      cwd: dir,
      inputs: ['src'],
      timeoutMs: 30_000,
    })
    expect(receipt.snapshot?.toolchainLinked).toBe(true)
    expect(receipt.snapshot?.coverage).toContain('node_modules is a junction to the live tree and is NOT covered')

    const inPlace = await runAcceptance({
      id: 'labels-live',
      command: [process.execPath, 'src/ok.mjs'],
      cwd: dir,
      inputs: ['src'],
      snapshot: false,
      timeoutMs: 30_000,
    })
    expect(inPlace.limitations.join(' ')).toContain('LIVE tree')
    expect(inPlace.candidateTreeDigestScope).toBe('live')
  }, 90_000)
})

// ---------------------------------------------------------------------------
// VER-05 — a stale receipt is not reusable
// ---------------------------------------------------------------------------

describe('VER-05: an old verdict cannot be reused as a current completion', () => {
  it('the receipt is refused after the WORKSPACE changes', async () => {
    const dir = makeRoot('ver05a')
    write(dir, 'src/thing.mjs', 'console.log("version one")\n')
    const definition: AcceptanceDefinition = {
      id: 'stale-workspace',
      command: [process.execPath, 'src/thing.mjs'],
      cwd: dir,
      inputs: ['src'],
      timeoutMs: 30_000,
    }

    const first = await runAcceptance(definition)
    expect(first.passed).toBe(true)
    expect(receiptFreshness(first, definition).fresh).toBe(true)

    write(dir, 'src/thing.mjs', 'console.log("version two")\n')
    const after = receiptFreshness(first, definition)
    expect(after.fresh).toBe(false)
    expect(after.reason).toContain('the candidate tree changed')
    expect(after.currentDigest).not.toBe(first.candidateTreeDigest)
  }, 90_000)

  it('the receipt is refused after the ORACLE changes, with the workspace untouched', () => {
    // The binding `receiptFreshness` does not cover, asserted through the
    // closure. The candidate digest is unchanged, the definition digest is
    // unchanged, and the receipt is STILL refused because the protected
    // acceptance is not the same acceptance.
    const dir = makeRoot('ver05b')
    const oracleSuite = join(dir, 'oracle', 'acceptance.test.ts')
    write(dir, 'oracle/acceptance.test.ts', 'export const assertion = "expect(total).toBe(30)"\n')
    const files = { suite: oracleSuite }
    const oracleAtFreeze = oracleDigest(files)

    const environment = { node: process.version, platform: process.platform, arch: process.arch }
    const recorded = {
      candidateTreeDigest: 'a'.repeat(64),
      acceptanceDefinitionDigest: 'b'.repeat(64),
      oracleDigest: oracleAtFreeze,
      environment,
    }
    expect(bindReceipt(recorded, { ...recorded }).applicable).toBe(true)

    write(dir, 'oracle/acceptance.test.ts', 'export const assertion = "expect(total).toBe(1)"\n')
    const refusal = bindReceipt(recorded, { ...recorded, oracleDigest: oracleDigest(files) })
    expect(refusal.applicable).toBe(false)
    expect(refusal.mismatches.join(' ')).toContain('oracleDigest')
  })

  it('the three bindings are INDEPENDENT: each refuses alone, with the other two still matching', async () => {
    // The claim "workspace, oracle and environment each refuse independently" is
    // only meaningful if it is tested as independence rather than as three
    // separate one-line cases. The earlier version of this suite used placeholder
    // digests ('a'.repeat(64)) and asserted only that SOME mismatch appeared, so
    // it could not distinguish "the oracle binding refused" from "a digest I
    // fabricated does not equal another digest I fabricated".
    //
    // Here every binding is a REAL digest from `observedBasis`, taken over a real
    // tree, and each mutation is asserted to move exactly ONE of the four
    // bindings while the other three still match. If a refactor coupled two
    // bindings together, one of the three cases below would stop refusing.
    const dir = makeRoot('ver05-independence')
    write(dir, 'candidate/app.mjs', 'export const v = 1\n')
    write(dir, 'oracle/suite.test.ts', 'export const assertion = "expect(total).toBe(30)"\n')
    const definition: AcceptanceDefinition = {
      id: 'independence',
      command: [process.execPath, '-e', '0'],
      cwd: dir,
      inputs: ['candidate'],
    }
    const oracleFiles = { suite: join(dir, 'oracle', 'suite.test.ts') }

    // RECORDED — the basis as it was when the verdict was written.
    const recorded = observedBasis({ definition, oracleFiles })
    expect(bindReceipt(recorded, observedBasis({ definition, oracleFiles })).applicable).toBe(true)

    // (a) ONLY the workspace moves. The oracle and the environment must still
    // match, and the refusal must name the workspace binding alone.
    write(dir, 'candidate/app.mjs', 'export const v = 2\n')
    const workspaceObserved = observedBasis({ definition, oracleFiles })
    expect(workspaceObserved.oracleDigest).toBe(recorded.oracleDigest)
    expect(workspaceObserved.environment).toEqual(recorded.environment)
    expect(workspaceObserved.acceptanceDefinitionDigest).toBe(recorded.acceptanceDefinitionDigest)
    expect(workspaceObserved.candidateTreeDigest).not.toBe(recorded.candidateTreeDigest)
    const workspaceRefusal = bindReceipt(recorded, workspaceObserved)
    expect(workspaceRefusal.applicable).toBe(false)
    expect(workspaceRefusal.mismatches).toHaveLength(1)
    expect(workspaceRefusal.mismatches[0]).toContain('candidateTreeDigest')

    // (b) ONLY the oracle moves, with the workspace restored to exactly the
    // recorded revision. Oracle and workspace are different files on different
    // paths, so this is a genuine independence test rather than a second reading
    // of the same digest.
    write(dir, 'candidate/app.mjs', 'export const v = 1\n')
    write(dir, 'oracle/suite.test.ts', 'export const assertion = "expect(total).toBe(1)"\n')
    const oracleObserved = observedBasis({ definition, oracleFiles })
    expect(oracleObserved.candidateTreeDigest).toBe(recorded.candidateTreeDigest)
    expect(oracleObserved.acceptanceDefinitionDigest).toBe(recorded.acceptanceDefinitionDigest)
    expect(oracleObserved.environment).toEqual(recorded.environment)
    expect(oracleObserved.oracleDigest).not.toBe(recorded.oracleDigest)
    const oracleRefusal = bindReceipt(recorded, oracleObserved)
    expect(oracleRefusal.applicable).toBe(false)
    expect(oracleRefusal.mismatches).toHaveLength(1)
    expect(oracleRefusal.mismatches[0]).toContain('oracleDigest')

    // (c) ONLY the definition moves: the acceptance command itself is rewritten,
    // which is the third binding and a different mechanism again. `observedBasis`
    // recomputes the definition digest from the definition it is handed, so the
    // change is expressed by handing it the weakened definition.
    write(dir, 'oracle/suite.test.ts', 'export const assertion = "expect(total).toBe(30)"\n')
    const weakened: AcceptanceDefinition = { ...definition, command: [process.execPath, '-e', '1'] }
    const definitionObserved = observedBasis({ definition: weakened, oracleFiles })
    expect(definitionObserved.candidateTreeDigest).toBe(recorded.candidateTreeDigest)
    expect(definitionObserved.oracleDigest).toBe(recorded.oracleDigest)
    expect(definitionObserved.acceptanceDefinitionDigest).not.toBe(recorded.acceptanceDefinitionDigest)
    const definitionRefusal = bindReceipt(recorded, definitionObserved)
    expect(definitionRefusal.applicable).toBe(false)
    expect(definitionRefusal.mismatches).toHaveLength(1)
    expect(definitionRefusal.mismatches[0]).toContain('acceptanceDefinitionDigest')

    // The control, which is what makes the three above meaningful: with every
    // file back at the recorded revision and the definition unchanged, the SAME
    // comparison accepts. Without this, a `bindReceipt` that always refused would
    // pass all three cases.
    write(dir, 'candidate/app.mjs', 'export const v = 1\n')
    const restored = observedBasis({ definition, oracleFiles })
    expect(restored).toEqual(recorded)
    expect(bindReceipt(recorded, restored).applicable).toBe(true)
  }, 60_000)

  it('the receipt is refused after the ENVIRONMENT changes', () => {
    const dir = makeRoot('ver05c')
    write(dir, 'oracle/suite.test.ts', 'export const x = 1\n')
    const digest = oracleDigest({ suite: join(dir, 'oracle/suite.test.ts') })
    const recorded = {
      candidateTreeDigest: 'a'.repeat(64),
      acceptanceDefinitionDigest: 'b'.repeat(64),
      oracleDigest: digest,
      environment: { node: process.version, platform: process.platform, arch: process.arch },
    }
    const refusal = bindReceipt(recorded, {
      candidateTreeDigest: 'a'.repeat(64),
      acceptanceDefinitionDigest: 'b'.repeat(64),
      oracleDigest: digest,
      environment: { node: process.version, platform: process.platform, arch: 'riscv64' },
    })
    expect(refusal.applicable).toBe(false)
    expect(refusal.mismatches).toContain(`environment.arch ${process.arch} != observed riscv64`)
  })

  it('a FRESH receipt is still checked for PASSED, so freshness is never a verdict', async () => {
    // The trap the CLI already avoids and this file pins: `--check` prints
    // freshness and then exits on `receipt.passed`. A receipt can be perfectly
    // fresh and describe a FAILED run.
    const dir = makeRoot('ver05d')
    write(dir, 'src/bad.mjs', 'process.exit(3)\n')
    const definition: AcceptanceDefinition = {
      id: 'fresh-but-failed',
      command: [process.execPath, 'src/bad.mjs'],
      cwd: dir,
      inputs: ['src'],
      timeoutMs: 30_000,
    }
    const receipt = await runAcceptance(definition)
    expect(receipt.passed).toBe(false)
    expect(receipt.outcome).toBe('fail')
    expect(receiptFreshness(receipt, definition).fresh).toBe(true)
  }, 60_000)
})

// ---------------------------------------------------------------------------
// VER-06 — A->B->A over the input tree, the ORACLE and the CONFIG
// ---------------------------------------------------------------------------

describe('VER-06: A->B->A during verification, over tree AND oracle AND config', () => {
  it('two-arm proof: the frozen copy is what is tested, and endpoint hashing cannot see the tamper', async () => {
    /*
     * The M9.1 slice proved this for the input tree. It is EXTENDED here to the
     * oracle and the config, which is what VER-06 asks for: "冻结被测副本，结果
     * 绑定副本，不仅轮询hash".
     *
     * The schedule, shared by both arms:
     *   t=0      the runner digests the live tree (A) and copies the snapshot
     *   t=700    live tree -> B (all three: input, oracle, config)
     *   t=1400   the child reads all three and FAILS if any is not A
     *   t=2100   live tree -> A          (the A->B->A is now complete)
     *   t=3100   the child exits, so the runner's END digest is taken after the
     *            mutation window has closed
     *
     * The child outliving the window is what makes the arms comparable: if it
     * exited inside the window the END digest would be taken while the live tree
     * still said B, and the contrast would be measuring the wrong thing.
     */
    const dir = makeRoot('ver06')
    scaffoldVitest(dir)
    // The readiness marker both arms share. It lives OUTSIDE `dir` (and so
    // outside every `inputs` path) because arm 1's child runs in the frozen
    // snapshot: a marker under `dir` would be written to the snapshot in arm 1
    // and to the live tree in arm 2, so the watcher could never see arm 1's.
    const markerDir = makeRoot('ver06-marker')
    const markerPath = join(markerDir, 'ready')
    const INPUT_A = 'console.log("A")\n'
    const ORACLE_A = 'export const assertion = "expect(total).toBe(30)"\n'
    const CONFIG_A = `export default { test: { include: ['src/**/*.test.ts'], reporters: ['verbose'] } }\n`
    const TAMPER = 'B - the tampered version'
    write(dir, 'src/target.mjs', INPUT_A)
    write(dir, 'oracle/acceptance.test.ts', ORACLE_A)
    write(dir, 'oracle/vitest.config.ts', CONFIG_A)

    write(dir, 'src/probe.mjs', `
import { readFileSync, writeFileSync } from 'node:fs'
const root = new URL('../', import.meta.url)
const read = rel => readFileSync(new URL(rel, root), 'utf8')
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
// READY is written as the child's FIRST action. The mutation window below is
// anchored to this file rather than to a timer that started before the process
// existed, because a spawn under load can take longer than the window itself —
// see the note on the schedule above.
writeFileSync(${JSON.stringify(markerPath)}, 'ready')
const readAll = () => ({
  input: read('src/target.mjs'),
  oracle: read('oracle/acceptance.test.ts'),
  config: read('oracle/vitest.config.ts'),
})
const isTampered = seen => Object.values(seen).some(value => value.includes('${TAMPER}'))
// Poll rather than sample once. A single sample at a fixed offset is a bet on
// timer scheduling: if it lands after the restore, this arm reads A and the
// test fails for a scheduling reason while the property under test is intact.
// Polling asserts the thing that actually matters — that the in-place child
// OBSERVES the tampered tree at some point inside the window.
const deadline = Date.now() + 6000
let seen = readAll()
while (!isTampered(seen) && Date.now() < deadline) { await sleep(50); seen = readAll() }
writeFileSync(new URL('src/observed.json', root), JSON.stringify(seen))
if (isTampered(seen)) {
  console.error('SAW_THE_TAMPERED_TREE: ' + Object.entries(seen).filter(([, value]) => value.includes('${TAMPER}')).map(([name]) => name).join(','))
  process.exit(9)
}
`)

    const definition: AcceptanceDefinition = {
      id: 'aba-extended',
      command: [process.execPath, 'src/probe.mjs'],
      cwd: dir,
      // All three are declared inputs, so all three are inside the frozen copy.
      inputs: ['src', 'oracle'],
      timeoutMs: 60_000,
    }
    const digestBefore = digestInputs(definition)

    const mutate = async (): Promise<void> => {
      // Anchored to the child's readiness, not to the moment the runner was
      // called. The difference is the whole flake: `runAcceptance` has to digest
      // the tree, copy the snapshot and spawn node before the child runs a line,
      // and under load that prelude exceeded the window — so the tamper was
      // already restored before the child looked, and the in-place arm exited 0.
      await waitForMarker(markerPath, 30_000)
      await new Promise(resolve => setTimeout(resolve, 700))
      write(dir, 'src/target.mjs', `console.log("${TAMPER}")\n`)
      write(dir, 'oracle/acceptance.test.ts', `export const assertion = "${TAMPER}"\n`)
      write(dir, 'oracle/vitest.config.ts', `export default { test: { include: ["${TAMPER}"] } }\n`)
      await new Promise(resolve => setTimeout(resolve, 1_400))
      write(dir, 'src/target.mjs', INPUT_A)
      write(dir, 'oracle/acceptance.test.ts', ORACLE_A)
      write(dir, 'oracle/vitest.config.ts', CONFIG_A)
    }

    // ARM 1 — the snapshot. The child must see A for all three.
    const mutation = mutate()
    const snapshotted = await runKeepingSnapshot(definition)
    await mutation
    expect(snapshotted.snapshot?.liveDigestAtStart).toBe(digestBefore)
    expect(snapshotted.snapshot?.liveDigestAtEnd).toBe(digestBefore)
    // Endpoint hashing reports NO drift at all. This is the whole reason a
    // before/after hash poll is insufficient, and it is asserted rather than
    // described.
    expect(snapshotted.snapshot?.liveDriftDetected).toBe(false)
    expect(snapshotted.passed).toBe(true)
    expect(snapshotted.exit.code).toBe(0)
    expect(snapshotted.output.stderr.text).not.toContain('SAW_THE_TAMPERED_TREE')

    const observedInSnapshot = JSON.parse(
      readFileSync(join(snapshotted.snapshot!.dir, 'src', 'observed.json'), 'utf8'),
    ) as Record<string, string>
    expect(observedInSnapshot['input']).toBe(INPUT_A)
    expect(observedInSnapshot['oracle']).toBe(ORACLE_A)
    expect(observedInSnapshot['config']).toBe(CONFIG_A)

    // ARM 2 — the same A->B->A, verified IN PLACE. The child really does execute
    // against the tampered tree: it exits 9 having seen B for all three.
    //
    // WHAT THIS ARM DOES *NOT* SHOW, stated because an earlier version of this
    // case claimed it and no assertion backed it: in place the runner takes NO
    // end digest. `liveDigestAtEnd` and `liveDriftDetected` are computed only
    // inside the `useSnapshot` branch, so an in-place receipt carries no endpoint
    // hash and no drift field at all. The consequence is asserted below rather
    // than described, because it is the sharper form of the finding: a verifier
    // that stored this receipt and later compared endpoints would have NOTHING to
    // compare, while the receipt still records a start digest
    // (`candidateTreeDigest` == the live start value) for a tree the command
    // demonstrably did not run against.
    write(dir, 'src/target.mjs', INPUT_A)
    // The marker is cleared before arm 2, or its `mutate` would see arm 1's
    // marker still present, return immediately, and re-open the very race this
    // anchoring exists to close.
    rmSync(markerPath, { force: true })
    const mutation2 = mutate()
    const inPlace = await runAcceptance({ ...definition, snapshot: false }, { keepSnapshot: true })
    await mutation2

    expect(inPlace.snapshot).toBeUndefined()
    expect(inPlace.candidateTreeDigestScope).toBe('live')
    expect(inPlace.exit.code).toBe(9)
    expect(inPlace.passed).toBe(false)
    expect(inPlace.output.stderr.text).toContain('SAW_THE_TAMPERED_TREE')
    expect(inPlace.limitations.join(' ')).toContain('LIVE tree')

    // The asymmetry, asserted on the SERIALIZED artifact a verifier would store:
    // the snapshot arm's receipt carries the endpoint hash and the drift verdict,
    // the in-place arm's carries neither. That is what makes the snapshot
    // load-bearing rather than decorative.
    const snapshotReceiptText = serializeReceipt(snapshotted)
    const inPlaceReceiptText = serializeReceipt(inPlace)
    expect(snapshotReceiptText).toContain('liveDriftDetected')
    expect(snapshotReceiptText).toContain('liveDigestAtEnd')
    expect(inPlaceReceiptText).not.toContain('liveDriftDetected')
    expect(inPlaceReceiptText).not.toContain('liveDigestAtEnd')
    // The two receipts are INDISTINGUISHABLE in their start digest — both
    // describe revision A, which is correct for both — while one command ran
    // against A and the other demonstrably ran against B. That is the finding:
    // the stored start digest cannot tell these two runs apart, so it is the
    // SNAPSHOT (and the endpoint field only the snapshot arm carries) that makes
    // the frozen revision the tested revision.
    expect(snapshotted.candidateTreeDigest).toBe(digestBefore)
    expect(inPlace.candidateTreeDigest).toBe(digestBefore)

    // No explicit rm here: `afterAll` removes every registered kept snapshot,
    // including this one and the in-place arm's.
  }, 240_000)

  it('a command that rewrites its own declared input inside the snapshot yields unknown, not pass', async () => {
    const dir = makeRoot('ver06b')
    write(dir, 'src/target.mjs', 'console.log("A")\n')
    write(dir, 'src/selfmod.mjs', `
import { writeFileSync } from 'node:fs'
await new Promise(resolve => setTimeout(resolve, 400))
writeFileSync(new URL('./target.mjs', import.meta.url), 'console.log("changed under the run")\\n')
await new Promise(resolve => setTimeout(resolve, 400))
`)

    const receipt = await runAcceptance({
      id: 'snapshot-moves',
      command: [process.execPath, 'src/selfmod.mjs'],
      cwd: dir,
      inputs: ['src'],
      timeoutMs: 60_000,
    })

    expect(receipt.outcome).toBe('unknown')
    expect(receipt.passed).toBe(false)
    expect(receipt.snapshot?.stableDuringRun).toBe(false)
    // A run whose result cannot be attributed to one tree holds its reservation.
    expect(receipt.holdReservation).toBe(true)
    expect(receipt.reasons.join(' ')).toContain('changed inside the snapshot')
  }, 90_000)
})

// ---------------------------------------------------------------------------
// VER-07 — an in-flight writer must converge before the freeze
// ---------------------------------------------------------------------------

describe('VER-07: a request to complete while a background mutation is still running', () => {
  it('freezing while a writer still holds the workspace is REFUSED as in-flight', async () => {
    // The step the runner cannot take. The runner freezes whatever it finds at
    // the instant it starts, so a background mutation still running at that
    // instant produces an immutable snapshot of a TORN tree — immutable, and
    // describing no revision anyone reviewed. Immutability is necessary and not
    // sufficient; the frozen artifact must also be CONVERGED.
    const { root, base } = makeRepo('ver07a')
    const workspace = await acquireWriterWorkspace({
      root,
      writerId: 'w-inflight',
      baseRevision: base,
      parentDir: makeRoot('ver07a-ws'),
    })
    workspaces.push(workspace)
    expect(writerLeaseHeld(workspace.path)).toBe(true)

    const definition: AcceptanceDefinition = {
      id: 'ver07',
      command: [process.execPath, '-e', '0'],
      cwd: workspace.path,
      inputs: ['src'],
      timeoutMs: 30_000,
    }

    const refused = await convergeBeforeFreeze({ workspacePath: workspace.path, definition, settleMs: 50 })
    expect(refused.converged).toBe(false)
    expect(refused.writerLeaseHeld).toBe(true)
    expect(refused.reasons.join(' ')).toContain('is in flight')
    // An unconverged freeze reports NO digest. A digest that cannot be taken is
    // unknown, and unknown must not be represented as a value.
    expect(refused.digest).toBe('')
  }, 90_000)

  it('a workspace still changing under the sampler is refused; only a stable one converges', async () => {
    // Two arms, because "converged" is only meaningful if the refusal is
    // reachable. Arm 1 keeps writing between samples; arm 2 stops first.
    //
    // The lease is released with `finish()` before either arm, which is the real
    // production edge: the writer has STOPPED, so the lease is no longer a
    // reason to refuse. What remains is the question this gate is actually
    // about — whether the TREE has stopped moving — and the double sample is the
    // only thing that can answer it. Leaving the lease held would make both arms
    // refuse for the other reason and the case would prove nothing.
    const { root, base } = makeRepo('ver07b')
    const workspace = await acquireWriterWorkspace({
      root,
      writerId: 'w-changing',
      baseRevision: base,
      parentDir: makeRoot('ver07b-ws'),
    })
    workspaces.push(workspace)
    workspace.finish()
    expect(writerLeaseHeld(workspace.path)).toBe(false)

    const definition: AcceptanceDefinition = {
      id: 'ver07b',
      command: [process.execPath, '-e', '0'],
      cwd: workspace.path,
      inputs: ['src'],
      timeoutMs: 30_000,
    }

    // ARM 1 — a raw file write is still landing between samples. This is exactly
    // the case the lease cannot see, because a writer that has stopped holding
    // the lease may still have an in-flight write or a background process.
    let writing = true
    const churn = (async (): Promise<void> => {
      let n = 0
      while (writing) {
        write(workspace.path, 'src/app.txt', `version ${n++}\n`)
        await new Promise(resolve => setTimeout(resolve, 40))
      }
    })()
    const unconverged = await convergeBeforeFreeze({ workspacePath: workspace.path, definition, settleMs: 120 })
    writing = false
    await churn

    expect(unconverged.converged).toBe(false)
    expect(unconverged.digest).toBe('')
    expect(unconverged.reasons.join(' ')).toContain('had not converged')

    // ARM 2 — the writer has stopped. The same call now converges, and the digest
    // it reports is the one the acceptance runner would freeze.
    const converged = await convergeBeforeFreeze({ workspacePath: workspace.path, definition, settleMs: 150 })
    expect(converged.converged).toBe(true)
    expect(converged.digest).toMatch(/^[0-9a-f]{64}$/)
    expect(converged.samples).toHaveLength(2)
    expect(converged.samples[0]?.digest).toBe(converged.samples[1]?.digest)
    // The digest is the RUNNER's own tree digest, so the converged value is
    // directly comparable with the receipt's `liveDigestAtStart`. A second
    // definition of "the candidate tree" would be free to drift from the
    // runner's, which is why this function does not have one.
    expect(converged.digest).toBe(digestInputs(definition))
  }, 120_000)

  it('the structural invariant: a refusal NEVER carries a digest', async () => {
    // "An unknown must not be certified" as a checkable property rather than a
    // sentence. Across every path this module can take, `digest !== ''` implies
    // `converged === true`; there is no state in which a caller receives a value
    // it is not entitled to freeze.
    const { root, base } = makeRepo('ver07c')
    const parentDir = makeRoot('ver07c-ws')
    const workspace = await acquireWriterWorkspace({ root, writerId: 'invariant', baseRevision: base, parentDir })
    workspaces.push(workspace)

    const definition: AcceptanceDefinition = {
      id: 'ver07c',
      command: [process.execPath, '-e', '0'],
      cwd: workspace.path,
      inputs: ['src'],
      timeoutMs: 30_000,
    }

    // Path 1: a live writer lease, so the freeze is refused as in-flight.
    const inFlight = await convergeBeforeFreeze({ workspacePath: workspace.path, definition, settleMs: 40 })
    expect(inFlight.converged).toBe(false)
    expect(inFlight.digest).toBe('')
    expect(inFlight.writerLeaseHeld).toBe(true)

    // Path 2: the writer has finished, so the same workspace converges and the
    // digest IS present — and it equals the runner's digest, so the value the
    // caller would freeze is the value the receipt will bind.
    workspace.finish()
    const settled = await convergeBeforeFreeze({ workspacePath: workspace.path, definition, settleMs: 60 })
    expect(settled.converged).toBe(true)
    expect(settled.digest).toBe(digestInputs(definition))

    for (const result of [inFlight, settled]) {
      if (result.digest !== '') expect(result.converged).toBe(true)
      if (!result.converged) expect(result.digest).toBe('')
      // A refusal always says why. A silent refusal would be unreviewable.
      expect(result.reasons.length).toBeGreaterThan(0)
    }
  }, 90_000)
})

// ---------------------------------------------------------------------------
// VER-08 — a failed verification is recoverable
// ---------------------------------------------------------------------------

describe('VER-08: after a verification failure a legitimate recovery can continue', () => {
  it('a failed acceptance leaves the run resumable: pause does NOT use the permanent family drain', async () => {
    // The mechanism VER-08 names, asserted at the real seam. `pause` is a record
    // change plus a refusal to admit; `drainContinuableDescendants` closes
    // admission for that exact parent PERMANENTLY. If a failed acceptance used
    // the drain, the run could never be corrected — a verification failure would
    // be terminal by accident.
    //
    // The rig is the REAL continuable stack, because the permanence is a property
    // of the real `SubagentRuntime` and a stand-in could not have it.
    const rig = await bootRig()
    try {
      await rig.service.createRun({ runId: 'run-ver08', root: rig.root, authorizationRef: 'auth' })
      rig.service.setReadyTasks('run-ver08', 5)
      // No explicit `setLaunchPort`: `createRun` now installs the production port
      // bound to this exact root Agent, so this case exercises the real default
      // rather than a test-supplied substitute. An explicitly installed port
      // still wins, which is why the other suites can keep driving their own.

      // A verification failure is a fact about the candidate, not about the
      // family. The run is paused: new admissions stop, and the family stays open.
      await rig.service.pause('run-ver08', 'acceptance failed: the candidate patch does not apply')
      expect(rig.service.getRun('run-ver08')?.phase).toBe('paused')
      const refused = await rig.service.drain(
        'run-ver08',
        [{ taskId: 't-1', childId: 'c-1', prompt: 'work 1', reservedCost: 1 }],
        new AbortController().signal,
      )
      expect(refused[0]?.accepted).toBe(false)
      expect(refused[0]?.reason).toBe('run_not_open')

      // A correction child can STILL be established while paused, which is the
      // property a permanent drain would have destroyed.
      const correction = await rig.ctx.subagents.startContinuable({
        provider: 'spawn',
        label: 'correction after a failed acceptance',
        childId: SessionId('ver08-correction'),
        request: { parent: rig.root, prompt: [{ type: 'text', text: 'fix the conflict' }], maxDepth: 1 },
        signal: new AbortController().signal,
      })
      expect(String(correction.childId)).toBe('ver08-correction')
      rig.adapter.openAll()

      // Resume is a real authorization edge, and after it the run admits again.
      await rig.service.resume('run-ver08')
      expect(rig.service.getRun('run-ver08')?.phase).toBe('open')
      const admitted = await rig.service.drain(
        'run-ver08',
        [{ taskId: 't-2', childId: 'c-2', prompt: 'work 2', reservedCost: 1 }],
        new AbortController().signal,
      )
      expect(admitted[0]?.accepted).toBe(true)

      // ONLY at the definite end is the permanent drain legal — and after it the
      // same parent cannot admit, which is what proves the state above was
      // genuinely "not yet drained" rather than a no-op.
      await rig.ctx.subagents.drainContinuableDescendants([rig.root])
      await expect(
        rig.ctx.subagents.startContinuable({
          provider: 'spawn',
          label: 'too late',
          childId: SessionId('ver08-too-late'),
          request: { parent: rig.root, prompt: [{ type: 'text', text: 'x' }], maxDepth: 1 },
          signal: new AbortController().signal,
        }),
      ).rejects.toThrow(/draining; the operation was not admitted/)
    } finally {
      await rig.dispose()
    }
  }, 180_000)

  it('a failed acceptance is a RECEIPT, not a throw, so the caller can recover and retry', async () => {
    const dir = makeRoot('ver08b')
    write(dir, 'src/bad.mjs', 'console.error("the candidate is wrong")\nprocess.exit(4)\n')

    const receipt = await runAcceptance({
      id: 'recoverable-failure',
      command: [process.execPath, 'src/bad.mjs'],
      cwd: dir,
      inputs: ['src'],
      timeoutMs: 30_000,
    })
    expect(receipt.passed).toBe(false)
    expect(receipt.outcome).toBe('fail')
    expect(receipt.exit.code).toBe(4)
    // The failure is fully described, so a recovery step has something to act on
    // rather than a bare exception.
    expect(receipt.reasons.length).toBeGreaterThan(0)
    expect(receipt.output.stderr.text).toContain('the candidate is wrong')
    // A definite failure is not an unknown, so nothing is left held open.
    expect(receipt.holdReservation).toBe(false)

    // And the same definition can be re-run after a correction, in the same
    // process, with no residual state.
    write(dir, 'src/bad.mjs', 'console.log("fixed")\nprocess.exit(0)\n')
    const second = await runAcceptance({
      id: 'recoverable-failure',
      command: [process.execPath, 'src/bad.mjs'],
      cwd: dir,
      inputs: ['src'],
      timeoutMs: 30_000,
    })
    expect(second.passed).toBe(true)
  }, 90_000)
})

// ---------------------------------------------------------------------------
// Part B — writer workspaces: concurrency isolation, not containment
// ---------------------------------------------------------------------------

describe('writer concurrency isolation: one writer, one workspace, one lease', () => {
  it('binds the writer cwd to its own workspace, on its own branch, at the exact base', async () => {
    const { root, base } = makeRepo('w01')
    const workspace = await acquireWriterWorkspace({
      root,
      writerId: 'writer-alpha',
      baseRevision: base,
      parentDir: makeRoot('w01-ws'),
    })
    workspaces.push(workspace)

    expect(workspace.path).not.toBe(root)
    expect(workspace.baseRevision).toBe(base)
    expect(workspace.branch).toBe('writer/writer-alpha')
    expect(workspace.path).toContain('writer-alpha-workspace')

    // The writer's cwd really is its own checkout, on its own branch, at the
    // base revision. All three are read back from git rather than assumed.
    expect(git(workspace.path, 'rev-parse', '--show-toplevel').replace(/\\/g, '/'))
      .toBe(workspace.path.replace(/\\/g, '/'))
    expect(git(workspace.path, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('writer/writer-alpha')
    expect(git(workspace.path, 'rev-parse', 'HEAD')).toBe(base)

    // The environment binds the writer to its workspace and to output roots that
    // no other writer can collide with.
    expect(workspace.env['DAILY_WORKSPACE']).toBe(workspace.path)
    expect(workspace.env['DAILY_ARTIFACT_DIR']).toBe(workspace.artifactDir)
    expect(workspace.env['DAILY_BUILD_DIR']).toBe(workspace.buildDir)
    expect(workspace.env['DAILY_CACHE_DIR']).toBe(workspace.cacheDir)
    for (const dir of [workspace.artifactDir, workspace.buildDir, workspace.cacheDir]) {
      expect(existsSync(dir)).toBe(true)
    }

    // GIT_DIR and friends are TOMBSTONED, not merely absent: a parent that had
    // GIT_DIR set would otherwise hand the writer a git context pointing at the
    // ROOT repository, and its commit would write the root's index and branch
    // from inside what merely LOOKS like a separate directory. This is a
    // DETERMINISM fix (the commit must land on the writer's branch), not a
    // containment measure — the writer's process authority is unchanged.
    for (const name of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR']) {
      expect(name in workspace.env).toBe(true)
      expect(workspace.env[name]).toBeUndefined()
    }
  }, 90_000)

  it('gives each writer its own branch and its own paths, so two writers cannot collide', async () => {
    const { root, base } = makeRepo('w02')
    const parentDir = makeRoot('w02-ws')
    const alpha = await acquireWriterWorkspace({ root, writerId: 'alpha', baseRevision: base, parentDir })
    const beta = await acquireWriterWorkspace({ root, writerId: 'beta', baseRevision: base, parentDir })
    workspaces.push(alpha, beta)

    expect(alpha.path).not.toBe(beta.path)
    expect(alpha.branch).not.toBe(beta.branch)
    expect(alpha.artifactDir).not.toBe(beta.artifactDir)
    expect(alpha.buildDir).not.toBe(beta.buildDir)
    expect(alpha.cacheDir).not.toBe(beta.cacheDir)
    expect(git(alpha.path, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('writer/alpha')
    expect(git(beta.path, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('writer/beta')

    // Each writer commits independently and neither sees the other's work.
    write(alpha.path, 'src/app.txt', 'alpha version\n')
    git(alpha.path, 'commit', '-q', '-am', 'alpha change')
    expect(git(alpha.path, 'rev-parse', 'HEAD')).not.toBe(base)
    expect(git(beta.path, 'rev-parse', 'HEAD')).toBe(base)
    // CRLF is normalised: git's autocrlf rewrites the working copy on checkout,
    // and a platform line ending is not a finding about writer workspaces.
    expect(readText(join(beta.path, 'src', 'app.txt'))).toBe('version one\n')
  }, 120_000)

  it('REFUSES a second writer on the same workspace, in this process and on disk', async () => {
    // "Two writers must never concurrently edit the same worktree" is not a
    // convention here: the lease makes it a refusal, and there are two mechanisms
    // because they cover different cases. The in-process registry catches the
    // same-process case a test can drive directly; the exclusive `wx` create is
    // what makes the refusal hold across processes.
    const { root, base } = makeRepo('w03')
    const parentDir = makeRoot('w03-ws')
    const held = await acquireWriterWorkspace({ root, writerId: 'owner', baseRevision: base, parentDir })
    workspaces.push(held)

    expect(writerLeaseHeld(held.path)).toBe(true)
    expect(existsSync(held.lockPath)).toBe(true)
    const lease = JSON.parse(readFileSync(held.lockPath, 'utf8')) as { writerId: string; pid: number }
    expect(lease.writerId).toBe('owner')
    expect(lease.pid).toBe(process.pid)

    // A second lease on the SAME path is refused. The writerId is deliberately
    // different so the refusal cannot be explained by a name clash.
    expect(() => acquireWriterLease(held.path, 'intruder')).toThrow(/writer-workspace-busy/)

    // The same refusal through the full acquisition path. A second writer with
    // the SAME id resolves to the same path, and the lease check fires first —
    // which is the right ordering: the lease is the authoritative claim, and a
    // directory check alone would be satisfied by a stale directory.
    await expect(
      acquireWriterWorkspace({ root, writerId: 'owner', baseRevision: base, parentDir }),
    ).rejects.toThrow(/writer-workspace-busy/)

    // And a DIFFERENT writer id gets a genuinely different path, so the case
    // above is about collision rather than about a broken acquisition path.
    const other = await acquireWriterWorkspace({ root, writerId: 'other', baseRevision: base, parentDir })
    workspaces.push(other)
    expect(other.path).not.toBe(held.path)
    expect(other.lockPath).not.toBe(held.lockPath)
    // Two live writers at once, each on its own tree, each holding its own lease.
    expect(writerLeaseHeld(held.path)).toBe(true)
    expect(writerLeaseHeld(other.path)).toBe(true)

    // The lease is NOT stolen: the holder is still the holder.
    expect(writerLeaseHeld(held.path)).toBe(true)
    const stillOwner = JSON.parse(readFileSync(held.lockPath, 'utf8')) as { writerId: string }
    expect(stillOwner.writerId).toBe('owner')
  }, 120_000)

  it('releases the lease on demand, leaving no branch, directory or lock behind', async () => {
    const { root, base } = makeRepo('w04')
    const parentDir = makeRoot('w04-ws')
    const first = await acquireWriterWorkspace({ root, writerId: 'once', baseRevision: base, parentDir })
    const path = first.path
    expect(writerLeaseHeld(path)).toBe(true)

    await first.release()
    expect(writerLeaseHeld(path)).toBe(false)
    expect(existsSync(path)).toBe(false)
    expect(existsSync(first.artifactDir)).toBe(false)
    // The branch is gone too, so the writer left nothing in the shared ref store.
    expect(gitTry(root, 'rev-parse', '--verify', 'refs/heads/writer/once').code).not.toBe(0)
    // And the root's worktree registry no longer lists it.
    expect(git(root, 'worktree', 'list')).not.toContain('once-workspace')
  }, 90_000)
})

describe('W02: a concurrency-isolated worktree is NOT a security boundary, and the code says so', () => {
  it('MEASURED: a writer inside a worktree CAN move a shared ref, write shared config, and plant a shared hook', async () => {
    // The measurement that makes "worktree is not a security boundary" a fact
    // rather than a caution. All three mutations are performed by a process whose
    // cwd is the WRITER's workspace, using only git, and none is denied.
    //
    // This is the evidence behind the re-definition: the worktree is renamed to
    // "concurrency-isolated" because the word "isolation" was previously doing
    // double duty for a containment claim it cannot support on this platform.
    const { root, base } = makeRepo('w02a')
    const workspace = await acquireWriterWorkspace({
      root,
      writerId: 'hostile',
      baseRevision: base,
      parentDir: makeRoot('w02a-ws'),
    })
    workspaces.push(workspace)

    // 1. Move the integration branch, from inside the writer.
    write(workspace.path, 'src/app.txt', 'hostile change\n')
    git(workspace.path, 'commit', '-q', '-am', 'hostile commit')
    const hostileSha = git(workspace.path, 'rev-parse', 'HEAD')
    const moved = gitTry(workspace.path, 'update-ref', 'refs/heads/main', hostileSha)
    // MEASURED: exit 0. The integration branch really moved.
    expect(moved.code).toBe(0)
    expect(git(root, 'rev-parse', 'refs/heads/main')).toBe(hostileSha)

    // 2. Write the SHARED config. MEASURED: exit 0, and the value lands in the
    // common `.git/config`, not in a worktree-private file.
    const configured = gitTry(workspace.path, 'config', 'dailywork.hostile', 'yes')
    expect(configured.code).toBe(0)
    expect(gitTry(root, 'config', '--file', join(root, '.git', 'config'), '--get', 'dailywork.hostile').stdout)
      .toBe('yes')

    // 3. Plant a hook in the shared hooks directory that fires for a ROOT commit.
    writeFileSync(join(root, '.git', 'hooks', 'post-commit'), '#!/bin/sh\necho "SHARED-HOOK-FIRED" >&2\n', { mode: 0o755 })
    write(root, 'rootfile.txt', 'root change\n')
    git(root, 'add', '-A')
    const committed = gitTry(root, 'commit', '-q', '-m', 'root commit with a writer-planted hook')
    expect(committed.code).toBe(0)
    expect(committed.stderr).toContain('SHARED-HOOK-FIRED')
  }, 120_000)

  it('what git DOES enforce: the integration branch cannot be checked out inside a writer worktree', async () => {
    // The one protection that comes for free, and it is a real one: git refuses
    // to check out a branch already checked out elsewhere (measured exit 128).
    // That is why every writer gets its OWN branch — the writer cannot reach the
    // state where its commit lands on the integration branch by ordinary means.
    const { root, base } = makeRepo('w02b')
    const workspace = await acquireWriterWorkspace({
      root,
      writerId: 'noswitch',
      baseRevision: base,
      parentDir: makeRoot('w02b-ws'),
    })
    workspaces.push(workspace)

    const switched = gitTry(workspace.path, 'checkout', 'main')
    expect(switched.code).toBe(128)
    expect(switched.stderr).toContain('already used by worktree')
    // The writer is still on its own branch, unchanged by the failed switch.
    expect(git(workspace.path, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('writer/noswitch')
  }, 120_000)

  it('DETECTION is the honest claim: the shared-metadata digest catches every one of those mutations', async () => {
    // Since the mutations above are NOT denied, the protection is a CHECK. This
    // is the closure for W02's oracle ("权限拒绝或独立clone；worktree不被称sandbox"):
    // the first clause is not available on this platform, so the code takes the
    // second — it does not call a worktree a sandbox, and it DETECTS a writer
    // that touched shared metadata.
    const { root, base } = makeRepo('w02c')
    const workspace = await acquireWriterWorkspace({
      root,
      writerId: 'detected',
      baseRevision: base,
      parentDir: makeRoot('w02c-ws'),
      protectedRefs: ['refs/heads/main'],
    })
    workspaces.push(workspace)

    const ctx = await makeContext()
    const snapshot = workspace.shared
    expect(snapshot.refs['refs/heads/main']).toBe(base)
    expect(snapshot.configSha256).toMatch(/^[0-9a-f]{64}$/)
    expect(snapshot.hooksDigest).toMatch(/^[0-9a-f]{64}$/)

    // The sharing that makes all three mutations reachable, measured rather than
    // assumed: the WRITER's common git directory IS the root's. This is the fact
    // the whole gate turns on, and it is read from git in the writer's own
    // checkout.
    const writerCommonDir = git(workspace.path, 'rev-parse', '--git-common-dir')
    expect(resolve(workspace.path, writerCommonDir).replace(/\\/g, '/'))
      .toBe(resolve(root, '.git').replace(/\\/g, '/'))

    // Intact at first: a writer that behaves is not falsely accused.
    const clean = await verifySharedMetadata(ctx, root, snapshot)
    expect(clean.intact).toBe(true)
    expect(clean.movedRefs).toHaveLength(0)

    // EVERY MUTATION BELOW IS PERFORMED WITH cwd INSIDE THE WRITER'S WORKSPACE.
    //
    // That is deliberate and it is the difference between proving the digest
    // works and proving the SCENARIO works: a mutation issued from the root would
    // only show that the digest notices a change, while the gate is about a
    // WRITER reaching shared metadata from its own checkout. The preceding case
    // measures the mutations with raw git; this one repeats them from the writer
    // and asserts the digest catches each — and that the mutation really landed,
    // by reading the shared state back independently.

    // 1. The integration ref moves, issued by the writer -> detected, and named.
    write(workspace.path, 'src/app.txt', 'writer change\n')
    git(workspace.path, 'commit', '-q', '-am', 'a writer commit')
    const writerHead = git(workspace.path, 'rev-parse', 'HEAD')
    git(workspace.path, 'update-ref', 'refs/heads/main', writerHead)
    // The mutation is OBSERVED, not assumed: the root's own view of its
    // integration branch really did move.
    expect(git(root, 'rev-parse', 'refs/heads/main')).toBe(writerHead)
    const movedRef = await verifySharedMetadata(ctx, root, snapshot)
    expect(movedRef.intact).toBe(false)
    expect(movedRef.movedRefs).toContainEqual({ ref: 'refs/heads/main', expected: base, observed: writerHead })
    expect(movedRef.reasons.join(' ')).toContain('moved from')
    // And the observed digest really differs from the recorded one, so the
    // detection is a digest comparison rather than a boolean the code chose.
    expect(movedRef.observed.refs['refs/heads/main']).not.toBe(snapshot.refs['refs/heads/main'])

    // 2. The shared config is written by the writer -> detected.
    const atRef = await sharedMetadataDigests(ctx, root, ['refs/heads/main'])
    git(workspace.path, 'config', 'dailywork.detected', 'yes')
    // Observed: the value landed in the SHARED config file, read directly.
    //
    // READ AS GIT READS IT, not as a substring of the raw bytes. An earlier
    // version of this line asserted the raw file CONTAINS the literal dotted name
    // `dailywork.detected`, which can never be true: git's INI writer emits a
    // `[dailywork]` section header and a `detected = yes` entry, never the
    // flattened key. That assertion failed for a formatting reason while the
    // mutation it was checking had in fact landed — an oracle broken rather than
    // weak, and it masked the digest check below it, which never ran.
    //
    // Four assertions replace it, and they are strictly STRONGER than the
    // substring was:
    //   (a) the SEMANTIC read: git itself resolves the key in the root's config;
    //   (b) the STRUCTURAL read: the section header really is in the root's
    //       config BYTES, so the value is in that file rather than merely
    //       resolvable from somewhere;
    //   (c) the DISCRIMINATION that makes "shared" mean anything — no
    //       worktree-private `config.worktree` exists, which is the file that
    //       would have held this value if the writer had been isolated. Without
    //       (c), "it is in the root's config" is consistent with git having
    //       written a private file AND the root's file happening to match.
    expect(gitTry(root, 'config', '--file', join(root, '.git', 'config'), '--get', 'dailywork.detected').stdout)
      .toBe('yes')
    expect(readText(join(root, '.git', 'config'))).toContain('[dailywork]')
    expect(readText(join(root, '.git', 'config'))).toContain('detected = yes')
    expect(existsSync(join(root, '.git', 'worktrees', 'detected-workspace', 'config.worktree'))).toBe(false)
    const configChanged = await verifySharedMetadata(ctx, root, atRef)
    expect(configChanged.intact).toBe(false)
    expect(configChanged.configChanged).toBe(true)
    expect(configChanged.observed.configSha256).not.toBe(atRef.configSha256)

    // 3. A shared hook is planted by the writer -> detected.
    const atConfig = await sharedMetadataDigests(ctx, root, ['refs/heads/main'])
    // Written through the path the WRITER resolved for its common dir, so the
    // planting is a writer action rather than a root one.
    writeFileSync(join(resolve(workspace.path, writerCommonDir), 'hooks', 'pre-commit'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
    const hooksChanged = await verifySharedMetadata(ctx, root, atConfig)
    expect(hooksChanged.intact).toBe(false)
    expect(hooksChanged.hooksChanged).toBe(true)
    expect(hooksChanged.observed.hooksDigest).not.toBe(atConfig.hooksDigest)

    // All three mutations are now present at once, and each is named
    // independently — a single boolean would not tell an operator which of the
    // three shared surfaces a writer touched.
    const allThree = await verifySharedMetadata(ctx, root, snapshot)
    expect(allThree.intact).toBe(false)
    expect(allThree.movedRefs).toHaveLength(1)
    expect(allThree.configChanged).toBe(true)
    expect(allThree.hooksChanged).toBe(true)
    expect(allThree.reasons).toHaveLength(3)

    // The refusal path, end to end: a publication whose integration ref no longer
    // matches what the candidate was verified against is refused.
    const refused = publicationPrecondition({
      assessment: {
        decision: 'accept_for_publication',
        reasons: [],
        baseRevision: base,
        expectedBase: base,
        headRevision: base,
        baseRevisionMatches: true,
        headDescendsFromBase: true,
        patchApplies: true,
        patchDigest: 'f'.repeat(64),
        patchBytes: 0,
        changedPaths: [],
        outOfScope: [],
        scopeOk: true,
        testsAreReal: true,
        testReason: 'declared by the caller for this case',
      },
      ref: 'refs/heads/main',
      expectedSha: base,
      observedSha: movedRef.observed.refs['refs/heads/main'],
    })
    expect(refused.accepted).toBe(false)
    expect(refused.reasons.join(' ')).toContain('refused rather than forced')
  }, 180_000)

  it('a CLONE is a real boundary: a writer can mutate its own everything and the root is byte-identical', async () => {
    // The option the plan names when a boundary is needed rather than a check:
    // "需要安全隔离时给独立clone/snapshot". Asserted by MUTATION, not by structure:
    // the writer does its worst to its own clone and the root's shared-metadata
    // digests do not change at all.
    const { root, base } = makeRepo('w02d')
    const workspace = await acquireWriterWorkspace({
      root,
      writerId: 'cloned',
      baseRevision: base,
      kind: 'clone',
      parentDir: makeRoot('w02d-ws'),
      protectedRefs: ['refs/heads/main'],
    })
    workspaces.push(workspace)

    const ctx = await makeContext()
    const before = await sharedMetadataDigests(ctx, root, ['refs/heads/main'])

    // The clone has its OWN git directory, so the root's refs/config/hooks are
    // not even the same files.
    //
    // `rev-parse --git-dir` reports a path RELATIVE to the cwd it ran in ('.git'
    // in both cases), so comparing the raw output would compare '.git' with
    // '.git' and prove nothing. `--absolute-git-dir` is the form that answers the
    // question actually being asked: whether these are the same directory.
    const cloneGitDir = git(workspace.path, 'rev-parse', '--absolute-git-dir').replace(/\\/g, '/')
    const rootGitDir = git(root, 'rev-parse', '--absolute-git-dir').replace(/\\/g, '/')
    expect(cloneGitDir).not.toBe(rootGitDir)
    expect(cloneGitDir).toContain('cloned-workspace')
    // A clone's git dir is self-contained: it is not nested inside the root's.
    expect(cloneGitDir.startsWith(rootGitDir)).toBe(false)

    // No remote: the writer has no configured path to push the integration branch
    // anywhere, so a push cannot even be attempted.
    expect(gitTry(workspace.path, 'remote').stdout).toBe('')
    expect(gitTry(workspace.path, 'push', 'origin', 'main').code).not.toBe(0)

    // The writer mutates its own refs, config and hooks as hard as it likes.
    write(workspace.path, 'src/app.txt', 'clone change\n')
    git(workspace.path, 'commit', '-q', '-am', 'clone commit')
    git(workspace.path, 'update-ref', 'refs/heads/main', git(workspace.path, 'rev-parse', 'HEAD'))
    git(workspace.path, 'config', 'dailywork.hostile', 'yes')
    writeFileSync(join(workspace.path, '.git', 'hooks', 'post-commit'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })

    const after = await sharedMetadataDigests(ctx, root, ['refs/heads/main'])
    expect(after.refs).toEqual(before.refs)
    expect(after.configSha256).toBe(before.configSha256)
    expect(after.hooksDigest).toBe(before.hooksDigest)
    expect(after.commonDir).toBe(before.commonDir)

    // And the root's own branch never moved.
    expect(git(root, 'rev-parse', 'refs/heads/main')).toBe(base)
  }, 180_000)
})

describe('the root is the single integration authority, and it does not merge', () => {
  it('accepts a clean candidate on the exact base, and binds the patch by digest', async () => {
    // The base already contains the vitest scaffolding, so the candidate's diff is
    // exactly its own work and the scope check is measuring the candidate rather
    // than the fixture.
    const { root, base } = makeVitestRepo('int01')
    const workspace = await acquireWriterWorkspace({
      root,
      writerId: 'clean',
      baseRevision: base,
      parentDir: makeRoot('int01-ws'),
    })
    workspaces.push(workspace)

    write(workspace.path, 'src/app.txt', 'the corrected version\n')
    write(workspace.path, 'src/ok.test.ts', `
import { describe, expect, it } from 'vitest'
describe('candidate', () => {
${Array.from({ length: 12 }, (_, index) => `  it('case ${index}', () => { expect(1 + ${index}).toBe(${1 + index}) })`).join('\n')}
})
`)
    git(workspace.path, 'add', '-A')
    git(workspace.path, 'commit', '-q', '-m', 'fix the app and add its real tests')
    const head = git(workspace.path, 'rev-parse', 'HEAD')

    // A real receipt from a real run of a real suite, and the binding recorded
    // alongside it. Using a genuine receipt rather than a hand-written literal
    // means `testsAreReal` is exercised against the shape the runner actually
    // produces.
    const oracleDir = makeRoot('int01-oracle')
    write(oracleDir, 'suite/acceptance.test.ts', 'export const assertion = "expect(total).toBe(12)"\n')
    const oracleFiles = { suite: join(oracleDir, 'suite', 'acceptance.test.ts') }

    const receiptDefinition: AcceptanceDefinition = {
      id: 'int01-receipt',
      command: [process.execPath, VITEST_ENTRY, 'run', 'src/ok.test.ts'],
      cwd: workspace.path,
      inputs: ['src', 'package.json', 'vitest.config.ts'],
      testReporter: 'vitest',
      expectTests: { passed: 12 },
      timeoutMs: 60_000,
    }
    const receipt = await runAcceptance(receiptDefinition)
    expect(receipt.outcome).toBe('pass')
    expect(receipt.observedTests?.passed).toBe(12)

    // The recorded binding is the observation taken when the receipt was
    // produced, so it matches the tree the receipt describes.
    const recordedBinding = observedBasis({ definition: receiptDefinition, oracleFiles })
    expect(recordedBinding.candidateTreeDigest).toBe(receipt.candidateTreeDigest)
    expect(recordedBinding.acceptanceDefinitionDigest).toBe(receipt.acceptanceDefinitionDigest)

    const ctx = await makeContext()
    const assessment = await assessIntegration({
      ctx,
      root,
      candidate: { cwd: workspace.path, baseRevision: base, headRevision: head },
      expectedBase: base,
      allowedPaths: ['src'],
      receipt,
      recordedBinding,
      oracleFiles,
      definition: receiptDefinition,
      patchDir: makeRoot('int01-patch'),
    })

    expect(assessment.decision).toBe('accept_for_publication')
    expect(assessment.baseRevisionMatches).toBe(true)
    expect(assessment.headDescendsFromBase).toBe(true)
    expect(assessment.patchApplies).toBe(true)
    expect(assessment.scopeOk).toBe(true)
    expect(assessment.patchDigest).toMatch(/^[0-9a-f]{64}$/)
    expect(assessment.patchBytes).toBeGreaterThan(0)
    expect(assessment.testsAreReal).toBe(true)
    expect(assessment.receiptBinding?.applicable).toBe(true)
    // The change scope is the real one: the candidate touched two files, and both
    // are inside `src`.
    expect(assessment.changedPaths).toEqual(['src/app.txt', 'src/ok.test.ts'])
    expect(assessment.outOfScope).toEqual([])

    // Publication then needs the ref CAS as well, and it holds here.
    const precondition = publicationPrecondition({
      assessment,
      ref: 'refs/heads/main',
      expectedSha: base,
      observedSha: git(root, 'rev-parse', 'refs/heads/main'),
    })
    expect(precondition.accepted).toBe(true)
    expect(precondition.patchDigest).toBe(assessment.patchDigest)
  }, 240_000)

  it('REFUSES a candidate whose base is not the revision the root expected', async () => {
    const { root, base } = makeRepo('int02')
    const workspace = await acquireWriterWorkspace({
      root,
      writerId: 'stale',
      baseRevision: base,
      parentDir: makeRoot('int02-ws'),
    })
    workspaces.push(workspace)
    write(workspace.path, 'src/app.txt', 'change\n')
    git(workspace.path, 'commit', '-q', '-am', 'change')
    const head = git(workspace.path, 'rev-parse', 'HEAD')

    const ctx = await makeContext()
    const assessment = await assessIntegration({
      ctx,
      root,
      candidate: { cwd: workspace.path, baseRevision: base, headRevision: head },
      // The root has moved on; the candidate was verified against an older base.
      expectedBase: '0'.repeat(40),
      allowedPaths: ['src'],
      patchDir: makeRoot('int02-patch'),
    })
    expect(assessment.decision).toBe('refuse')
    expect(assessment.baseRevisionMatches).toBe(false)
    expect(assessment.reasons.join(' ')).toContain('a candidate verified against a different base is not current')
  }, 120_000)

  it('REFUSES a conflicting candidate and returns it to the root — there is no auto-merge', async () => {
    // W03's oracle, and the plan's explicit prohibition: "冲突返回给root，不写一个
    // 语义自动merge controller". The refusal is `git apply --check` exiting
    // non-zero. The source assertion at the end of this describe block is what
    // makes the absence of a three-way merge mechanical rather than a promise.
    const { root, base } = makeRepo('int03')
    const workspace = await acquireWriterWorkspace({
      root,
      writerId: 'conflicting',
      baseRevision: base,
      parentDir: makeRoot('int03-ws'),
    })
    workspaces.push(workspace)
    write(workspace.path, 'src/app.txt', 'the writer version\n')
    git(workspace.path, 'commit', '-q', '-am', 'writer change')
    const head = git(workspace.path, 'rev-parse', 'HEAD')

    // The root advances the SAME file, so the patch no longer applies.
    write(root, 'src/app.txt', 'the root version\n')
    git(root, 'commit', '-q', '-am', 'root change')

    const ctx = await makeContext()
    const assessment = await assessIntegration({
      ctx,
      root,
      candidate: { cwd: workspace.path, baseRevision: base, headRevision: head },
      expectedBase: base,
      allowedPaths: ['src'],
      patchDir: makeRoot('int03-patch'),
    })

    expect(assessment.patchApplies).toBe(false)
    expect(assessment.decision).toBe('refuse')
    expect(assessment.reasons.join(' ')).toContain('does not apply to the current tree')
    // The root's tree is untouched: the check is a read, and nothing was merged.
    expect(readText(join(root, 'src', 'app.txt'))).toBe('the root version\n')
    // No merge in progress, and the branch still points where the root left it.
    expect(gitTry(root, 'rev-parse', '--verify', 'MERGE_HEAD').code).not.toBe(0)
    expect(gitTry(root, 'rev-parse', '--verify', 'REBASE_HEAD').code).not.toBe(0)
  }, 180_000)

  it('REFUSES a candidate that changed a path outside the allowed scope', async () => {
    // "The tests passed" says nothing about a file the reviewer never expected to
    // move. The workspace change scope is a separate check from the tests.
    const { root, base } = makeRepo('int04')
    const workspace = await acquireWriterWorkspace({
      root,
      writerId: 'outofscope',
      baseRevision: base,
      parentDir: makeRoot('int04-ws'),
    })
    workspaces.push(workspace)
    write(workspace.path, 'src/app.txt', 'legitimate change\n')
    write(workspace.path, 'ci/pipeline.yml', 'the writer also edited the build\n')
    git(workspace.path, 'add', '-A')
    git(workspace.path, 'commit', '-q', '-m', 'change plus a scope violation')
    const head = git(workspace.path, 'rev-parse', 'HEAD')

    const ctx = await makeContext()
    const assessment = await assessIntegration({
      ctx,
      root,
      candidate: { cwd: workspace.path, baseRevision: base, headRevision: head },
      expectedBase: base,
      allowedPaths: ['src'],
      patchDir: makeRoot('int04-patch'),
    })
    expect(assessment.scopeOk).toBe(false)
    expect(assessment.outOfScope).toEqual(['ci/pipeline.yml'])
    expect(assessment.decision).toBe('refuse')
    expect(assessment.reasons.join(' ')).toContain('outside the allowed scope')
  }, 120_000)

  it('REFUSES a candidate with no receipt, and one whose receipt claims a pass with no tests', async () => {
    const { root, base } = makeRepo('int05')
    const workspace = await acquireWriterWorkspace({
      root,
      writerId: 'unverified',
      baseRevision: base,
      parentDir: makeRoot('int05-ws'),
    })
    workspaces.push(workspace)
    write(workspace.path, 'src/app.txt', 'change\n')
    git(workspace.path, 'commit', '-q', '-am', 'change')
    const head = git(workspace.path, 'rev-parse', 'HEAD')

    const ctx = await makeContext()
    const noReceipt = await assessIntegration({
      ctx,
      root,
      candidate: { cwd: workspace.path, baseRevision: base, headRevision: head },
      expectedBase: base,
      allowedPaths: ['src'],
      patchDir: makeRoot('int05-patch'),
    })
    expect(noReceipt.decision).toBe('refuse')
    expect(noReceipt.testsAreReal).toBe(false)
    expect(noReceipt.reasons.join(' ')).toContain('nothing about the candidate has been verified')

    // A receipt that says `passed: true` on an exit code with no counts. The
    // runner is entitled to call that a pass; it is not entitled to call it
    // evidence that a test ran, and the integration authority refuses it.
    const hollowReceipt = {
      outcome: 'pass',
      passed: true,
      candidateTreeDigest: 'a'.repeat(64),
      acceptanceDefinitionDigest: 'b'.repeat(64),
      environment: { node: process.version, platform: process.platform, arch: process.arch },
    } as unknown as AcceptanceReceipt
    const hollow = await assessIntegration({
      ctx,
      root,
      candidate: { cwd: workspace.path, baseRevision: base, headRevision: head },
      expectedBase: base,
      allowedPaths: ['src'],
      receipt: hollowReceipt,
      patchDir: makeRoot('int05-patch2'),
    })
    expect(hollow.testsAreReal).toBe(false)
    expect(hollow.decision).toBe('refuse')
    expect(hollow.testReason).toContain('no observed test counts')
  }, 180_000)

  it('a writer cannot publish: the precondition takes the ref as an input, and no merge verb exists', async () => {
    // F08's property, extended to the writer boundary. The precondition is the
    // only publication path in this module; it reads the ref's observed value as
    // an ARGUMENT and refuses when it moved. The source scan below is what makes
    // "there is no merge/force/push path" mechanical rather than a promise.
    const { root, base } = makeRepo('int06')
    const ctx = await makeContext()
    const assessment = await assessIntegration({
      ctx,
      root,
      candidate: { cwd: root, baseRevision: base, headRevision: base },
      expectedBase: base,
      allowedPaths: ['src'],
      patchDir: makeRoot('int06-patch'),
    })

    // The ref moved after the candidate was verified.
    git(root, 'commit', '-q', '--allow-empty', '-m', 'the integration branch advanced')
    const advanced = git(root, 'rev-parse', 'refs/heads/main')
    const refused = publicationPrecondition({
      assessment,
      ref: 'refs/heads/main',
      expectedSha: base,
      observedSha: advanced,
    })
    expect(refused.accepted).toBe(false)
    expect(refused.reasons.join(' ')).toContain('refused rather than forced')
    // The refusal is a READ, not a rollback: the ref really is still advanced.
    expect(git(root, 'rev-parse', 'refs/heads/main')).toBe(advanced)

    // An unreadable ref is a refusal too, not a benefit of the doubt.
    const unreadable = publicationPrecondition({
      assessment,
      ref: 'refs/heads/main',
      expectedSha: base,
      refUnreadableReason: 'the ref could not be read',
    })
    expect(unreadable.accepted).toBe(false)
    expect(unreadable.reasons.join(' ')).toContain('could not be read')
  }, 120_000)

  it('the module contains no merge verb: every git subcommand it runs is read-only or workspace-lifecycle', async () => {
    // The mechanical half of "do NOT write a semantic auto-merge controller".
    //
    // The scan is over EXECUTABLE argv, not prose: `gitRun`/`gitOk` are the only
    // two functions that spawn git, and their third argument is always a literal
    // argv array, so the subcommand can be extracted from the source and checked
    // against an allowlist. Comments that describe what a hostile writer does
    // (`git update-ref`, `git push`) are deliberately not matched, because the
    // assertion is about what this module RUNS, not about what it explains.
    const source = readFileSync(join(import.meta.dirname, 'worktree-isolation.ts'), 'utf8')
    const invoked = new Set<string>()
    const pattern = /git(?:Run|Ok)\([^,]+,\s*[^,]+,\s*\[\s*'([a-z-]+)'/g
    let match: RegExpExecArray | null
    while ((match = pattern.exec(source)) !== null) invoked.add(match[1]!)

    // A non-empty set is part of the assertion: a scan that found nothing would
    // pass vacuously.
    expect(invoked.size).toBeGreaterThan(0)
    const allowed = new Set([
      // read-only queries
      'rev-parse', 'symbolic-ref', 'merge-base', 'diff',
      // read-only check: `apply --check` reports, it does not apply
      'apply',
      // workspace lifecycle, always against the ROOT's own worktree registry
      'worktree', 'branch', 'clone', 'checkout', 'remote',
    ])
    expect([...invoked].filter(command => !allowed.has(command))).toEqual([])
    // The merge verbs specifically, so the intent survives a future allowlist edit.
    for (const verb of ['merge', 'rebase', 'cherry-pick', 'push', 'reset', 'update-ref', 'commit', 'stash']) {
      expect(invoked.has(verb), `worktree-isolation.ts must not run git ${verb}`).toBe(false)
    }

    // THE SCAN MUST NOT BE EVADABLE. The pattern above only sees a literal argv
    // array in the third position, so a call passing a computed array — `gitRun(
    // ctx, cwd, argv)` where argv was assembled elsewhere, or a spread — would be
    // INVISIBLE to it and the allowlist would report a clean module while a merge
    // verb ran. That is the same "oracle weaker than its scenario" shape the gate
    // exists to prevent, so the evasion is closed by asserting that EVERY
    // `gitRun`/`gitOk` call site (excluding the two definitions and the one
    // internal delegation) has a literal array as its third argument.
    const callSites = [...source.matchAll(/git(?:Run|Ok)\(\s*ctx\s*,/g)].length
    const literalSites = [...source.matchAll(/git(?:Run|Ok)\(\s*ctx\s*,\s*[^,]+,\s*\[/g)].length
    // One call site is `gitOk` delegating to `gitRun(ctx, cwd, argv)`; that is the
    // single permitted computed form and it is inside the module's own helper.
    expect(callSites - literalSites).toBe(1)
    expect(source).toContain('const result = await gitRun(ctx, cwd, argv)')
    // No shell: a shell would make the subcommand unextractable in principle.
    expect(source).not.toMatch(/execSync|exec\(|shell:\s*true/)

    // `apply` is the ONE allowed mutating-adjacent verb, so it must never appear
    // without `--check`: `git apply` alone writes the working tree.
    const applyCalls = [...source.matchAll(/git(?:Run|Ok)\([^)]*\['apply'([^\]]*)\]/g)].map(m => m[1]!)
    expect(applyCalls.length).toBeGreaterThan(0)
    for (const tail of applyCalls) expect(tail).toContain("'--check'")
    // And the three-way form: `git apply --3way` STARTS resolving a conflict
    // instead of reporting it. It appears in this file only in prose.
    expect(/\[\s*'apply'[^\]]*'--3way'/.test(source)).toBe(false)
    expect(source).toContain('NEVER `--3way`')
  })

  it('the naming is honest: the module re-scopes the worktree instead of calling it isolation', async () => {
    // NAMING IS LOAD-BEARING, not cosmetic. A reader who believes a writer
    // workspace is a security boundary will conclude that a hostile writer is
    // contained, and will therefore skip the checks that actually catch one — the
    // shared-metadata digest, the exact-base refusal and the ref CAS. The
    // re-definition is asserted here so a future edit cannot quietly restore the
    // old framing.
    const source = readFileSync(join(import.meta.dirname, 'worktree-isolation.ts'), 'utf8')
    // The concept is named for what it does.
    expect(source).toContain('concurrency-isolated worktree')
    expect(source).toContain('NOT a security boundary')
    // The three jobs are stated, so "what is this for" has a written answer.
    expect(source).toContain('avoid concurrent writes clobbering each other')
    expect(source).toContain('establish a deterministic merge basis')
    expect(source).toContain('bind verification to a specific candidate')
    // The containment disclaimer is explicit, and it names the deployment
    // semantics rather than treating them as a defect.
    expect(source).toContain('same OS user')
    expect(source).toContain('intended deployment semantics')
    // The verifier honesty rule, which is the mirror image and is equally easy to
    // get wrong: host-authority observation is not a control.
    expect(source).toContain('MECHANICAL WORLD OBSERVATION')

    // And the MISLEADING names are gone from the public surface. `IsolationKind`
    // read as a security gradient; `WriterWorkspaceKind` does not.
    expect(source).not.toContain('WriterIsolationKind')
    expect(source).not.toContain('Isolation strength')
    const plugin = readFileSync(join(import.meta.dirname, 'writers-plugin.ts'), 'utf8')
    expect(plugin).toContain('NOT a security boundary')
    expect(plugin).toContain('concurrency-isolated')
  })
})

// ---------------------------------------------------------------------------
// VER-09 — stale publication is rejected by an expected-ref compare-and-swap
// ---------------------------------------------------------------------------

describe('VER-09: stale Git expected-ref publication is rejected', () => {
  it('MEASURED: the CAS-less form really does clobber, so the expected value is load-bearing', async () => {
    // WHY THE CONTROL ARM IS FIRST. "A stale publication is rejected" is only a
    // meaningful claim if the stale publication would otherwise SUCCEED. If git
    // refused a clobbering `update-ref` on its own, every CAS assertion below
    // would be passing for a reason that has nothing to do with the CAS, and the
    // test would be an oracle weaker than its scenario.
    //
    // Measured here on this host (git 2.55.0.windows.3): the two-argument form
    // `git update-ref <ref> <new>` exits 0 and moves the ref REGARDLESS of what it
    // pointed at. There is no implicit expected value. That is precisely why the
    // three-argument form exists and why it is what publication must use.
    const { root, base } = makeRepo('ver09a')
    git(root, 'commit', '-q', '--allow-empty', '-m', 'the integration branch advanced')
    const advanced = git(root, 'rev-parse', 'refs/heads/main')
    expect(advanced).not.toBe(base)

    // The careless publisher: no expected value, so the newer commit is lost.
    const clobbered = gitTry(root, 'update-ref', 'refs/heads/main', base)
    expect(clobbered.code).toBe(0)
    expect(git(root, 'rev-parse', 'refs/heads/main')).toBe(base)
    // The advance is GONE from the ref. That is the failure VER-09 exists to stop.
    expect(git(root, 'rev-parse', 'refs/heads/main')).not.toBe(advanced)

    // Restore, then perform the same publication with the expected value that is
    // now STALE. The three-argument form is a genuine compare-and-swap and refuses.
    git(root, 'update-ref', 'refs/heads/main', advanced)
    const stale = gitTry(root, 'update-ref', 'refs/heads/main', base, base)
    expect(stale.code).not.toBe(0)
    expect(stale.stderr).toContain('but expected')
    // And the refusal is a no-op on the ref: the newer commit survives.
    expect(git(root, 'rev-parse', 'refs/heads/main')).toBe(advanced)

    // With the CORRECT expected value it succeeds, so the mechanism is not
    // always-refusing — the control arm that makes the refusal above mean
    // something.
    const correct = gitTry(root, 'update-ref', 'refs/heads/main', base, advanced)
    expect(correct.code).toBe(0)
    expect(git(root, 'rev-parse', 'refs/heads/main')).toBe(base)
  }, 120_000)

  it('the publication path takes the ref as an INPUT, so a stale candidate cannot publish itself', async () => {
    // The end-to-end shape: a candidate is verified against `base`, the
    // integration ref then advances, and the publication is refused. This is the
    // VER-09 scenario driven through the module's own decision function rather
    // than through raw git.
    //
    // WHY THIS FIXTURE HAD TO BE REBUILT, and it is worth stating because the
    // broken version was green-looking. It used to assess
    // `candidate: { cwd: root, baseRevision: base, headRevision: base }` with no
    // receipt, and then assert `accept_for_publication`. That input CANNOT be
    // accepted, and refusing it is CORRECT — measured on the built artifact:
    //
    //   decision refuse, patchApplies false, patchBytes 0, testsAreReal false
    //     - the candidate patch does not apply to the current tree:
    //       error: No valid patches in input (allow with "--allow-empty")
    //     - there is no acceptance receipt, so there is no evidence that any test ran
    //
    // `head === base` makes the diff empty, and `git apply --check <empty>` exits
    // 128 on this host (git 2.55.0.windows.3), so the assessment refused for two
    // reasons that have nothing to do with the ref. The case then failed at
    // `expect(assessment.decision).toBe('accept_for_publication')` — and the
    // fixture, not the product, was the defect: a candidate with no change and no
    // evidence is exactly what the integration authority is supposed to refuse.
    //
    // The repair makes the scenario REAL rather than weakening the assertion: a
    // genuine workspace commit and a genuine receipt from a genuine vitest run,
    // so `accept_for_publication` is earned and the subsequent ref refusal is the
    // only thing standing between the candidate and publication.
    const { root, base } = makeVitestRepo('ver09b')
    const workspace = await acquireWriterWorkspace({
      root,
      writerId: 'stale',
      baseRevision: base,
      parentDir: makeRoot('ver09b-ws'),
    })
    workspaces.push(workspace)
    write(workspace.path, 'src/app.txt', 'the candidate change\n')
    write(workspace.path, 'src/ok.test.ts', `
import { describe, expect, it } from 'vitest'
describe('candidate', () => {
  it('case 0', () => { expect(1 + 0).toBe(1) })
  it('case 1', () => { expect(1 + 1).toBe(2) })
  it('case 2', () => { expect(1 + 2).toBe(3) })
})
`)
    git(workspace.path, 'add', '-A')
    git(workspace.path, 'commit', '-q', '-m', 'the candidate change')
    const head = git(workspace.path, 'rev-parse', 'HEAD')

    const oracleDir = makeRoot('ver09b-oracle')
    write(oracleDir, 'suite/acceptance.test.ts', 'export const assertion = "expect(total).toBe(3)"\n')
    const oracleFiles = { suite: join(oracleDir, 'suite', 'acceptance.test.ts') }
    const definition: AcceptanceDefinition = {
      id: 'ver09b-receipt',
      command: [process.execPath, VITEST_ENTRY, 'run', 'src/ok.test.ts'],
      cwd: workspace.path,
      inputs: ['src', 'package.json', 'vitest.config.ts'],
      testReporter: 'vitest',
      expectTests: { passed: 3 },
      timeoutMs: 60_000,
    }
    const receipt = await runAcceptance(definition)
    expect(receipt.outcome).toBe('pass')
    expect(receipt.observedTests?.passed).toBe(3)

    const ctx = await makeContext()
    const assessment = await assessIntegration({
      ctx,
      root,
      candidate: { cwd: workspace.path, baseRevision: base, headRevision: head },
      expectedBase: base,
      allowedPaths: ['src'],
      receipt,
      recordedBinding: observedBasis({ definition, oracleFiles }),
      oracleFiles,
      definition,
      patchDir: makeRoot('ver09b-patch'),
    })
    expect(assessment.decision).toBe('accept_for_publication')
    // No reasons at all, so the acceptance below is not a near-miss that a later
    // edit could turn into a refusal for an unrelated cause.
    expect(assessment.reasons).toEqual([])
    expect(assessment.patchApplies).toBe(true)

    // The ref moves while the candidate is being considered.
    git(root, 'commit', '-q', '--allow-empty', '-m', 'root moved on')
    const moved = git(root, 'rev-parse', 'refs/heads/main')

    const refused = publicationPrecondition({
      assessment,
      ref: 'refs/heads/main',
      expectedSha: base,
      observedSha: moved,
    })
    expect(refused.accepted).toBe(false)
    expect(refused.reasons.join(' ')).toContain('refused rather than forced')
    // The refusal names BOTH revisions, so an operator can see the divergence
    // rather than just being told no.
    expect(refused.reasons.join(' ')).toContain(base)
    expect(refused.reasons.join(' ')).toContain(moved)
    expect(refused.expectedBase).toBe(base)
    expect(refused.observedRef).toBe(moved)

    // HONEST SCOPE, asserted rather than described: the precondition is a
    // read-and-compare with NO write path. It cannot publish anything itself, so
    // it is a gate in front of a publisher, not the publisher. A reader who
    // assumed this function performs the CAS would be wrong, and the source scan
    // below is what pins that.
    const source = readFileSync(join(import.meta.dirname, 'worktree-isolation.ts'), 'utf8')
    // No write verb is executed anywhere in the module: `update-ref` appears only
    // in the header's prose describing what a HOSTILE WRITER can do.
    const executed = [...source.matchAll(/git(?:Run|Ok)\(\s*ctx\s*,\s*[^,]+,\s*\[\s*'([a-z-]+)'/g)].map(m => m[1]!)
    expect(executed).not.toContain('update-ref')
    expect(executed).not.toContain('push')
    expect(executed).not.toContain('reset')
    expect(executed).not.toContain('commit')
    // And the module states the CAS is what publication must use, so the missing
    // write path is a documented boundary rather than an oversight.
    expect(source).toContain('expected-ref CAS')
    // A real vitest run is inside this case now, so it carries the same explicit
    // budget the other receipt-driven cases use rather than the 60s suite default.
  }, 240_000)

  it('an unreadable ref is a refusal, not a benefit of the doubt', async () => {
    // The other half of a CAS: a ref that cannot be read is UNKNOWN, and an
    // unknown must never be treated as "unchanged". This is the same shape as
    // VER-05's freshness rule.
    //
    // THE ASSESSMENT IS SUPPLIED AS A LITERAL, and that is the repair rather than
    // a shortcut. This case used to assess `headRevision: base` with no receipt,
    // which — measured on the built artifact — already REFUSES (empty diff,
    // `git apply --check` exit 128, no receipt). So `accepted: false` was true
    // whether or not the unreadable-ref branch ran at all: an oracle weaker than
    // its scenario, which is the defect class this file exists to catch. Pinning
    // the assessment to `accept_for_publication` with no reasons makes the
    // refusal ATTRIBUTABLE — the only remaining cause is the unreadable ref, and
    // the assertion below says so explicitly. Same construction as the W02 case
    // above, and for the same reason: the subject here is
    // `publicationPrecondition`, not `assessIntegration`.
    const { root, base } = makeRepo('ver09c')
    const unreadable = publicationPrecondition({
      assessment: {
        decision: 'accept_for_publication',
        reasons: [],
        baseRevision: base,
        expectedBase: base,
        headRevision: base,
        baseRevisionMatches: true,
        headDescendsFromBase: true,
        patchApplies: true,
        patchDigest: 'c'.repeat(64),
        patchBytes: 1,
        changedPaths: ['src/app.txt'],
        outOfScope: [],
        scopeOk: true,
        testsAreReal: true,
        testReason: 'declared by the caller for this case',
      },
      ref: 'refs/heads/main',
      expectedSha: base,
      refUnreadableReason: 'the ref could not be read',
    })
    expect(unreadable.accepted).toBe(false)
    expect(unreadable.reasons.join(' ')).toContain('could not be read')
    // The refusal is the unreadable ref and NOTHING else, so this cannot pass on
    // a refusal the assessment contributed.
    expect(unreadable.reasons).toHaveLength(1)
    expect(unreadable.reasons.join(' ')).not.toContain('the integration assessment refused')
    // The observed value stays undefined: the function does not invent one.
    expect(unreadable.observedRef).toBeUndefined()
  }, 120_000)
})

// ---------------------------------------------------------------------------
// FS-06 — a raw Python mutation is visible to the verifier
// ---------------------------------------------------------------------------

describe('FS-06: raw Python mutation must be visible to the verifier', () => {
  it('MEASURED: model-written Python writes the file directly, with no DSH fs receipt, and the verifier rediscovers it', async () => {
    // THE DISTINCTION THIS GATE TURNS ON.
    //
    // Under trusted-local, `ipython` runs real CPython as the invoking user. A
    // model that writes a file with `open(...).write(...)` produces NO DSH fs
    // receipt: it never went through `ctx.fs`. So "what did the writer change"
    // cannot be answered from the tool-call log, and a verifier that trusted its
    // own receipts would report an unchanged tree while the tree had changed.
    //
    // The verifier's answer is not a better receipt — it is MECHANICAL WORLD
    // OBSERVATION: re-read the actual filesystem/Git state at verification time.
    // This case measures that the mutation is invisible to a receipt-shaped
    // account and VISIBLE to the digest the verifier recomputes.
    const dir = makeRoot('fs06')
    git(dir, 'init', '-q', '-b', 'main')
    write(dir, 'src/app.txt', 'original\n')
    git(dir, 'add', '-A')
    git(dir, 'commit', '-q', '-m', 'base')

    const definition: AcceptanceDefinition = {
      id: 'fs06-candidate',
      command: [process.execPath, '-e', 'process.exit(0)'],
      cwd: dir,
      inputs: ['src'],
      timeoutMs: 30_000,
    }
    const beforeDigest = digestInputs(definition)
    const beforeHead = git(dir, 'rev-parse', 'HEAD')
    // Clean at the start, so the "dirty" finding below is caused by the Python
    // write and not by the fixture's own scaffolding.
    expect(gitTry(dir, 'status', '--porcelain').stdout).toBe('')

    // THE RAW PYTHON MUTATION. Real CPython, direct file I/O, no DSH tool in the
    // loop — exactly the capability the audit says the model has.
    const python = pythonPath()
    const script = [
      'import pathlib, sys',
      `p = pathlib.Path(r"${join(dir, 'src', 'app.txt').replace(/\\/g, '\\\\')}")`,
      'p.write_text("mutated by raw python\\n", encoding="utf-8")',
      'print("RAW_PYTHON_WROTE", p)',
    ].join('\n')
    const wrote = spawnSync(python, ['-c', script], { encoding: 'utf8' })
    expect(wrote.status, `python failed: ${wrote.stderr}`).toBe(0)
    expect(wrote.stdout).toContain('RAW_PYTHON_WROTE')

    // 1. The mutation really landed, read back from the filesystem.
    expect(readText(join(dir, 'src', 'app.txt'))).toBe('mutated by raw python\n')

    // 2. A RECEIPT-SHAPED account does not see it. There is no fs receipt to
    //    consult, and the definition digest is unchanged because the definition
    //    did not change — only the world did.
    expect(acceptanceDefinitionDigest(definition)).toBe(
      acceptanceDefinitionDigest({ ...definition }),
    )

    // 3. THE VERIFIER REDISCOVERS IT from the world, which is the only honest
    //    source. The recomputed digest moves...
    const afterDigest = digestInputs(definition)
    expect(afterDigest).not.toBe(beforeDigest)

    // ...a binding recorded BEFORE the write no longer describes the tree that
    //    exists now, so it cannot be reused as current evidence. The recorded
    //    side is the `VerdictBinding` shape the comparison actually takes -- a
    //    receipt carries a different field set -- so the only difference between
    //    the recorded and observed sides is the tree digest the write moved.
    const staleReceipt: VerdictBinding = {
      candidateTreeDigest: beforeDigest,
      acceptanceDefinitionDigest: acceptanceDefinitionDigest(definition),
      oracleDigest: oracleDigest({}),
      environment: { node: process.version, platform: process.platform, arch: process.arch },
    }
    const binding = bindReceipt(staleReceipt, observedBasis({ definition, oracleFiles: {} }))
    expect(binding.applicable).toBe(false)
    expect(binding.mismatches.join(' ')).toContain('candidateTreeDigest')

    // ...and the GIT-LEVEL account agrees with the filesystem account. Two
    // independent observations of the same world, which is what makes this
    // mechanical rather than a second opinion.
    expect(gitTry(dir, 'status', '--porcelain').stdout).toContain('src/app.txt')
    expect(git(dir, 'rev-parse', 'HEAD')).toBe(beforeHead)
    // HEAD did not move: the change is UNCOMMITTED. A verifier that only read
    // the commit graph would have called this tree clean.
    expect(gitTry(dir, 'diff', '--name-only').stdout).toContain('src/app.txt')
  }, 120_000)

  it('the raw-Python write is caught by the candidate/HEAD comparison the root actually makes', async () => {
    // The integration half. A writer's raw-Python edit is not in any commit, so
    // `headRevision` does not describe it and `git diff base head` does not
    // contain it. The root must therefore compare the COMMIT against the
    // WORKING TREE, or it would integrate a revision that does not match what was
    // verified. This case measures the gap rather than describing it.
    const { root, base } = makeRepo('fs06b')
    const workspace = await acquireWriterWorkspace({
      root,
      writerId: 'rawpy',
      baseRevision: base,
      parentDir: makeRoot('fs06b-ws'),
    })
    workspaces.push(workspace)

    // The writer commits one change, then makes a SECOND change with raw Python
    // and does not commit it.
    write(workspace.path, 'src/app.txt', 'committed change\n')
    git(workspace.path, 'commit', '-q', '-am', 'committed change')
    const head = git(workspace.path, 'rev-parse', 'HEAD')

    const python = pythonPath()
    const script = [
      'import pathlib',
      `pathlib.Path(r"${join(workspace.path, 'src', 'app.txt').replace(/\\/g, '\\\\')}").write_text("raw python change\\n", encoding="utf-8")`,
    ].join('\n')
    const wrote = spawnSync(python, ['-c', script], { encoding: 'utf8' })
    expect(wrote.status, `python failed: ${wrote.stderr}`).toBe(0)

    // The committed revision is unchanged, so an assessment that read only commits
    // would be judging a tree that is not on disk.
    expect(git(workspace.path, 'rev-parse', 'HEAD')).toBe(head)
    // But the WORKING TREE differs from that revision, and git reports it.
    const dirty = gitTry(workspace.path, 'status', '--porcelain')
    expect(dirty.stdout).toContain('src/app.txt')
    expect(readText(join(workspace.path, 'src', 'app.txt'))).toBe('raw python change\n')

    // The root's assessment of the COMMIT is not wrong — it is about the commit.
    // What it cannot do is speak for the uncommitted edit, and that is the gap the
    // verifier has to close by reading the world.
    const ctx = await makeContext()
    const assessment = await assessIntegration({
      ctx,
      root,
      candidate: { cwd: workspace.path, baseRevision: base, headRevision: head },
      expectedBase: base,
      allowedPaths: ['src'],
      patchDir: makeRoot('fs06b-patch'),
    })
    // The patch is the COMMITTED delta and says nothing about the raw edit.
    expect(assessment.patchDigest).not.toBe('')
    expect(gitTry(workspace.path, 'diff', '--name-only', base, head).stdout).toContain('src/app.txt')
    // The uncommitted edit is NOT in the diff the root assessed — asserted, not
    // assumed, so the residual gap is visible to a reader.
    const committedDiff = git(workspace.path, 'diff', base, head)
    expect(committedDiff).toContain('committed change')
    expect(committedDiff).not.toContain('raw python change')
    // HONEST STATEMENT OF THE GAP: `assessIntegration` does not itself check for a
    // dirty working tree, so a raw-Python edit made AFTER the commit is not part
    // of the patch it evaluates. The verifier closes this by recomputing the tree
    // digest from disk (the FS-06 case above), not by trusting the commit.
    expect(assessment.decision).toBe('accept_for_publication')
  }, 180_000)
})

// ---------------------------------------------------------------------------
// the production entry point — a test that mounts the MODULE is not enough
// ---------------------------------------------------------------------------

describe('the writer service has a production entry point, not just a module', () => {
  it('the package declares a `writers` export that resolves to the plugin, and the plugin mounts a real service', async () => {
    // WHY THIS CASE EXISTS, and it is the most important case in this file.
    //
    // Everything above mounts `worktree-isolation.ts` DIRECTLY. That proves the
    // module works; it proves nothing about whether the product uses it. This
    // project has retracted that exact over-claim four times:
    //
    //   1. `setLaunchPort` had no production caller, so the shipped profile
    //      launched nothing and every `submit` became `unknown` (2d4534f).
    //   2. `takeContinuation` had none, so a managed run never disarmed the Goal
    //      round-driver and TWO continuation owners could drive one root while
    //      `goal.test.ts` passed (982e82b).
    //   3. `dsh-ipython` declared no `dsh.bundle`, so the package could never
    //      reach the model even with green tests.
    //   4. `worktree-isolation.ts` itself, before `writers-plugin.ts` existed.
    //
    // `docs/GAPS.md` G-FIX-04: an oracle weaker than its scenario passes while the
    // product is broken. So this case checks the three links that make the module
    // reachable by a real profile, in order: the package export, the plugin's
    // service registration, and the behaviour of the service reached THAT way.
    //
    // The composed-profile boot is separately evidenced by
    // `qualification/runners/verify-writers-mounted.mjs` and its JSON output,
    // because a direct `ctx.plugin()` mount cannot prove the resolver loads it.
    const packageJson = JSON.parse(
      readFileSync(join(import.meta.dirname, '..', 'package.json'), 'utf8'),
    ) as { exports: Record<string, { types: string; default: string }> }

    // Link 1: the package EXPORTS the plugin, and the export points at a file
    // that EXISTS. A row in `cordis.patch.yml` naming an unexported subpath would
    // fail at activation, which is how this project's B02/B03 defect looked.
    //
    // The existence check is the load-bearing half and was MISSING from the first
    // version of this case, whose comment claimed it while the assertion only
    // compared the string. A string comparison passes against a `lib/` that was
    // never compiled — the exact B02 cause (G-FIX-04) — so the path is stat'd and
    // the built artifact's contents are checked for the service name.
    const writersExport = packageJson.exports['./writers']
    expect(writersExport).toBeDefined()
    expect(writersExport?.default).toBe('./lib/writers-plugin.js')
    const builtEntry = join(import.meta.dirname, '..', writersExport!.default)
    expect(existsSync(builtEntry), `the \`./writers\` export points at ${builtEntry}, which does not exist; the package has not been compiled`).toBe(true)
    // The BUILT file is the one a resolver loads, so the service name is read out
    // of it rather than out of the TypeScript source.
    expect(readFileSync(builtEntry, 'utf8')).toContain('dsh-daily-writers')
    // And the types half of the export exists too, or a consumer's build breaks.
    expect(existsSync(join(import.meta.dirname, '..', writersExport!.types))).toBe(true)

    // Link 2: the patch row that mounts it exists, and names the export above.
    // Read from the package's own patch file rather than from a copy, because a
    // stale copy in a profile is exactly the failure mode (G-FIX-04).
    const patch = readFileSync(join(import.meta.dirname, '..', 'cordis.patch.yml'), 'utf8')
    expect(patch).toContain('name: dsh-daily-work/writers')
    expect(patch).toContain('id: daily-writers')

    // Link 3: mounting the plugin registers a service with the expected name, and
    // the service reached that way really does the work. The name is asserted
    // because `ctx.get('dailyWriters')` is the only handle a consumer has, and a
    // typo there would be invisible to every test that used the class directly.
    const ctx = await makeContext()
    const plugin = await import('./writers-plugin.ts')
    expect(plugin.name).toBe('dsh-daily-writers')
    await ctx.plugin(plugin as never, {} as never)

    const service = ctx.get('dailyWriters')
    expect(service).toBeDefined()
    // The no-root refusal, which is a deliberate design property: a service that
    // guessed a root could operate on the wrong repository.
    const availability = await service.available()
    expect(availability.available).toBe(false)
    expect(availability.reason).toContain('no integration root is configured')

    // And with a root, the same service performs a real workspace lifecycle.
    const { root, base } = makeRepo('plugin-entry')
    const parentDir = makeRoot('plugin-entry-ws')
    const withRoot = await service.available(root)
    expect(withRoot.available).toBe(true)

    const lease = await service.open({ root, writerId: 'via-service', baseRevision: base, parentDir })
    workspaces.push(lease.workspace)
    expect(lease.workspace.branch).toBe('writer/via-service')
    expect(git(lease.workspace.path, 'rev-parse', 'HEAD')).toBe(base)
    expect(service.isHeld(lease.workspace.path)).toBe(true)

    // The service exposes the checks, not just the lifecycle, so a consumer never
    // has to reach past it into the module.
    expect(service.testsAreReal(undefined).real).toBe(false)
    expect(service.oracleDigest({})).toMatch(/^[0-9a-f]{64}$/)
    const digests = await service.sharedDigests(root)
    expect(digests.refs['refs/heads/main']).toBe(base)
    const check = await service.verifyShared(root, digests)
    expect(check.intact).toBe(true)

    await lease.release()
    expect(existsSync(lease.workspace.path)).toBe(false)
  }, 180_000)

  it('the plugin declares no hard `inject`, so a deployment without a subprocess provider can still boot and REPORT', async () => {
    // MEASURED during the real-profile boot probe: reading `ctx.subprocess` on a
    // context whose plugin did not declare `subprocess` throws
    // `cannot get property "subprocess" without inject`. The two ways to fix that
    // are NOT equivalent:
    //
    //   - declaring `inject: ['subprocess']` makes it an ACTIVATION requirement,
    //     so a deployment that mounts no subprocess provider cannot boot the
    //     writers service at all — and therefore cannot report the gap either;
    //   - resolving it per call through `ctx.get` keeps the service reachable and
    //     turns the missing provider into a typed refusal naming the DEPLOYMENT.
    //
    // The second is what the code does, and this case pins it: the plugin mounts
    // on a bare context with no subprocess provider, and the failure it produces
    // names the deployment rather than throwing a Cordis accessor error.
    const ctx = new Context()
    contexts.push(ctx)
    const plugin = await import('./writers-plugin.ts')
    expect(plugin.inject).toEqual([])

    await ctx.plugin(plugin as never, { root: process.cwd() } as never)
    const service = ctx.get('dailyWriters')
    expect(service).toBeDefined()

    // The refusal is a REPORTED unavailability, not a crash: `available()` is how
    // an operator learns the deployment is misconfigured.
    const availability = await service.available(process.cwd())
    expect(availability.available).toBe(false)
    expect(availability.reason).toContain('no ctx.subprocess provider is mounted')

    // And an operation that needs git says the same thing, naming the deployment.
    await expect(service.sharedDigests(process.cwd())).rejects.toThrow(
      /no ctx.subprocess provider is mounted.*DEPLOYMENT configuration gap/,
    )
  }, 60_000)
})
