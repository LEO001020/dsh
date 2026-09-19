/**
 * M9.1 acceptance-runner tests.
 *
 * Every case here runs a REAL child process through the REAL DSH subprocess
 * seam. Nothing is mocked, because the whole point of this file is to show that
 * the runner reports what actually happened rather than what it was told. A
 * stubbed spawn would let a broken classification pass.
 *
 * The negative cases carry the weight. A verifier that says PASS is only worth
 * something if it refuses to say PASS for: a missing command, a failing
 * command, a timeout, an all-skipped suite and a suite that ran nothing at all.
 * Each of those is a separate test below, because they are separate ways for a
 * green-looking result to mean nothing.
 *
 * Where a case needs a real test runner, it uses the vitest that is already
 * installed rather than a fake reporter. That is deliberate: the summary
 * grammar being parsed is vitest's actual output, including its ANSI colouring,
 * so a parser that only works on hand-written strings would fail here.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  acceptanceDefinitionDigest,
  digestInputs,
  parseTestCounts,
  receiptFreshness,
  runAcceptance,
  runAcceptanceWithBudget,
  serializeReceipt,
  type AcceptanceDefinition,
} from './verify.ts'

/**
 * A real vitest, invoked as `node <path>` so the definition's argv does not
 * depend on a shell resolving a `.cmd` shim. Measured on this machine: the
 * `.bin/vitest` shim is a shell script, and spawning it without a shell fails,
 * which would make every case here fail for a reason unrelated to the runner.
 */
const VITEST_ENTRY = 'D:/DSH/src/dsh-src/node_modules/vitest/vitest.mjs'

const roots: string[] = []

/** Create an isolated candidate directory. Never the repo itself. */
function makeRoot(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `dsh-verify-${prefix}-`))
  roots.push(dir)
  return dir
}

/** Write a file, creating parent directories. */
function write(dir: string, relPath: string, content: string): void {
  const target = join(dir, relPath)
  mkdirSync(join(target, '..'), { recursive: true })
  writeFileSync(target, content, 'utf8')
}

/**
 * Scaffold a directory that can run real vitest: a config, a package.json
 * declaring ESM, and a node_modules junction to the installed toolchain.
 */
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
      execFileSync('cmd', ['/c', 'mklink', '/J', destination.replace(/\//g, '\\'), source.replace(/\//g, '\\')], { stdio: 'ignore' })
    } catch {
      // A missing optional link is fine; the vitest entry itself is enough.
    }
  }
}

/** A definition whose command runs real vitest over one file. */
function vitestDefinition(dir: string, file: string, overrides: Partial<AcceptanceDefinition> = {}): AcceptanceDefinition {
  return {
    id: 'vitest-case',
    command: [process.execPath, VITEST_ENTRY, 'run', file],
    cwd: dir,
    inputs: ['src', 'vitest.config.ts', 'package.json'],
    testReporter: 'vitest',
    timeoutMs: 60_000,
    ...overrides,
  }
}

beforeAll(() => {
  if (!existsSync(VITEST_ENTRY)) throw new Error(`the real vitest entry is missing at ${VITEST_ENTRY}`)
})

afterAll(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
})

describe('F01: only a real runner is an oracle', () => {
  it('a real command that passes yields PASS with the real exit code recorded', async () => {
    const dir = makeRoot('pass')
    scaffoldVitest(dir)
    write(dir, 'src/ok.test.ts', `
import { describe, expect, it } from 'vitest'
describe('candidate', () => {
  it('adds', () => { expect(1 + 1).toBe(2) })
  it('subtracts', () => { expect(2 - 1).toBe(1) })
})
`)

    const receipt = await runAcceptance(vitestDefinition(dir, 'src/ok.test.ts', { expectTests: { passed: 2, failed: 0 } }))

    expect(receipt.outcome).toBe('pass')
    expect(receipt.passed).toBe(true)
    // The exit code is the child's own, not a default we filled in.
    expect(receipt.exit.code).toBe(0)
    expect(receipt.exit.expectedCode).toBe(0)
    expect(receipt.observedTests).toMatchObject({ total: 2, passed: 2, failed: 0 })
    expect(receipt.environment.node).toBe(process.version)
    expect(receipt.environment.platform).toBe(process.platform)
    expect(receipt.holdReservation).toBe(false)
    expect(receipt.reasons.join(' ')).toContain('exit code 0 matched the expected 0')
  }, 90_000)

  it('a real command that fails yields FAIL, and the failure is visible in the receipt', async () => {
    const dir = makeRoot('fail')
    scaffoldVitest(dir)
    write(dir, 'src/bad.test.ts', `
import { describe, expect, it } from 'vitest'
describe('candidate', () => {
  it('is wrong', () => { expect(1 + 1).toBe(3) })
})
`)

    const receipt = await runAcceptance(vitestDefinition(dir, 'src/bad.test.ts', { expectTests: { passed: 1 } }))

    expect(receipt.outcome).toBe('fail')
    expect(receipt.passed).toBe(false)
    // vitest exits 1 when a test fails; that real code must be recorded.
    expect(receipt.exit.code).toBe(1)
    expect(receipt.reasons.join(' ')).toContain('exit code 1 did not match the expected 0')
    // The failure is visible in the retained output, not summarised away.
    const combined = `${receipt.output.stdout.text}${receipt.output.stderr.text}`
    expect(combined).toContain('is wrong')
    expect(receipt.observedTests).toMatchObject({ total: 1, passed: 0, failed: 1 })
  }, 90_000)

  it('a command that does not exist is NOT a pass', async () => {
    const dir = makeRoot('missing')
    write(dir, 'src/marker.test.ts', 'export const x = 1\n')

    const receipt = await runAcceptance({
      id: 'missing-command',
      command: ['dsh-definitely-not-a-real-command-xyz', '--help'],
      cwd: dir,
      inputs: ['src'],
      timeoutMs: 30_000,
    })

    expect(receipt.outcome).toBe('command_not_found')
    expect(receipt.passed).toBe(false)
    // Nothing ran, so there is no exit code to report. A fabricated 0 here
    // would be exactly the "fake exitCode=0" this gate exists to reject.
    expect(receipt.exit.code).toBeNull()
    expect(receipt.reasons.join(' ')).toContain('nothing ran')
    expect(receipt.limitations).toContain('the acceptance command was never executed')
  }, 60_000)

  it('a command that times out is NOT a pass and is classified as a timeout', async () => {
    const dir = makeRoot('timeout')
    write(dir, 'src/slow.mjs', 'setInterval(() => {}, 1000)\nconsole.log("started")\n')

    const receipt = await runAcceptance({
      id: 'timeout-case',
      command: [process.execPath, 'src/slow.mjs'],
      cwd: dir,
      inputs: ['src'],
      timeoutMs: 1_500,
    })

    expect(receipt.outcome).toBe('timeout')
    expect(receipt.passed).toBe(false)
    expect(receipt.exit.timedOut).toBe(true)
    expect(receipt.reasons.join(' ')).toContain('timeout is unknown, not a pass')
    // INV: a timeout means UNKNOWN, so its resources are not treated as free
    // even though the managed range was observed to quiesce.
    expect(receipt.holdReservation).toBe(true)
    // The child did start, so its output is real evidence that it ran.
    expect(receipt.output.stdout.text).toContain('started')
  }, 60_000)

  it('an external stop is reported as interrupted, never as a pass', async () => {
    const dir = makeRoot('interrupt')
    write(dir, 'src/slow.mjs', 'setInterval(() => {}, 1000)\n')
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 1_200)

    const receipt = await runAcceptance(
      {
        id: 'interrupt-case',
        command: [process.execPath, 'src/slow.mjs'],
        cwd: dir,
        inputs: ['src'],
        timeoutMs: 60_000,
      },
      { signal: controller.signal },
    )

    expect(receipt.outcome).toBe('interrupted')
    expect(receipt.passed).toBe(false)
    expect(receipt.exit.interrupted).toBe(true)
    expect(receipt.holdReservation).toBe(true)
  }, 60_000)
})

describe('F02: no tests, skipped tests and a runner that never ran are all non-PASS', () => {
  it('a suite that is entirely skipped is NOT a pass, despite exit code 0', async () => {
    const dir = makeRoot('skipped')
    scaffoldVitest(dir)
    write(dir, 'src/skip.test.ts', `
import { describe, it } from 'vitest'
describe('candidate', () => {
  it.skip('never runs', () => { throw new Error('unreachable') })
  it.skip('also never runs', () => { throw new Error('unreachable') })
})
`)

    const receipt = await runAcceptance(vitestDefinition(dir, 'src/skip.test.ts', { expectTests: { passed: 2 } }))

    // The real exit code IS 0 here. That is the trap: a verifier that only
    // looks at the exit code would call this a pass.
    expect(receipt.exit.code).toBe(0)
    expect(receipt.outcome).toBe('all_skipped')
    expect(receipt.passed).toBe(false)
    expect(receipt.observedTests).toMatchObject({ passed: 0, failed: 0, skipped: 2 })
    expect(receipt.reasons.join(' ')).toContain('no test passed or failed')
  }, 90_000)

  it('a runner that executed zero tests is NOT a pass, despite exit code 0', async () => {
    const dir = makeRoot('zerotests')
    scaffoldVitest(dir)
    // A file vitest loads but finds no suite in. `--passWithNoTests` makes
    // vitest exit 0 and print "no tests": the honest zero-test shape, and the
    // one that would be reported as a pass by an exit-code-only verifier.
    write(dir, 'src/empty.test.ts', 'export const nothing = 1\n')

    const receipt = await runAcceptance(
      vitestDefinition(dir, 'src/empty.test.ts', {
        expectTests: { passed: 1 },
        command: [process.execPath, VITEST_ENTRY, 'run', 'src/empty.test.ts', '--passWithNoTests'],
      }),
    )

    expect(receipt.exit.code).toBe(0)
    expect(receipt.outcome).toBe('zero_tests')
    expect(receipt.passed).toBe(false)
    expect(receipt.observedTests).toMatchObject({ total: 0, passed: 0 })
    expect(receipt.reasons.join(' ')).toContain('the runner executed zero tests')
  }, 90_000)

  it('a runner that never reports a summary is NOT a pass, despite exit code 0', async () => {
    const dir = makeRoot('neverran')
    write(dir, 'src/quiet.mjs', 'console.log("I did nothing at all")\n')

    const receipt = await runAcceptance({
      id: 'never-ran',
      command: [process.execPath, 'src/quiet.mjs'],
      cwd: dir,
      inputs: ['src'],
      expectTests: { passed: 1 },
      timeoutMs: 30_000,
    })

    expect(receipt.outcome).toBe('runner_never_ran')
    expect(receipt.passed).toBe(false)
    expect(receipt.exit.code).toBe(0)
    expect(receipt.observedTests).toBeUndefined()
    expect(receipt.reasons.join(' ')).toContain('no runner summary appeared')
  }, 60_000)

  it('a declared count that does not match the observed count is NOT a pass', async () => {
    const dir = makeRoot('mismatch')
    scaffoldVitest(dir)
    write(dir, 'src/three.test.ts', `
import { describe, expect, it } from 'vitest'
describe('candidate', () => {
  it('a', () => { expect(1).toBe(1) })
  it('b', () => { expect(1).toBe(1) })
  it('c', () => { expect(1).toBe(1) })
})
`)

    // Declares four passing tests; the runner really reports three.
    const receipt = await runAcceptance(vitestDefinition(dir, 'src/three.test.ts', { expectTests: { passed: 4 } }))

    expect(receipt.outcome).toBe('count_mismatch')
    expect(receipt.passed).toBe(false)
    expect(receipt.exit.code).toBe(0)
    expect(receipt.observedTests?.passed).toBe(3)
    expect(receipt.reasons.join(' ')).toContain('passed 3 != declared 4')
  }, 90_000)

  it('a definition with an empty command is refused rather than run', async () => {
    const receipt = await runAcceptance({ id: 'empty', command: [], cwd: process.cwd(), inputs: [] })
    expect(receipt.outcome).toBe('command_not_found')
    expect(receipt.passed).toBe(false)
    expect(receipt.exit.code).toBeNull()
  })
})

describe('F03/F04: the receipt is bound to a snapshot of the inputs', () => {
  it('the receipt digest changes when the input tree changes', async () => {
    const dir = makeRoot('stale')
    write(dir, 'src/thing.mjs', 'console.log("version one")\n')

    const definition: AcceptanceDefinition = {
      id: 'staleness',
      command: [process.execPath, 'src/thing.mjs'],
      cwd: dir,
      inputs: ['src'],
      timeoutMs: 30_000,
    }

    const first = await runAcceptance(definition)
    expect(first.passed).toBe(true)
    const originalDigest = first.candidateTreeDigest

    // A stored receipt must not silently describe a tree that no longer exists.
    const beforeEdit = receiptFreshness(first, definition)
    expect(beforeEdit.fresh).toBe(true)

    write(dir, 'src/thing.mjs', 'console.log("version two")\n')

    const afterEdit = receiptFreshness(first, definition)
    expect(afterEdit.fresh).toBe(false)
    expect(afterEdit.reason).toContain('the candidate tree changed')
    expect(afterEdit.currentDigest).not.toBe(originalDigest)

    const second = await runAcceptance(definition)
    expect(second.candidateTreeDigest).not.toBe(originalDigest)
    expect(second.output.stdout.text).toContain('version two')
  }, 90_000)

  it('the acceptance-definition digest changes when a threshold is weakened', () => {
    const base: AcceptanceDefinition = {
      id: 'protected',
      command: [process.execPath, '-e', '0'],
      cwd: process.cwd(),
      inputs: ['src'],
      expectTests: { passed: 10 },
    }
    // F05: lowering a declared threshold must change the digest, so the
    // weakened acceptance cannot reuse the authorization of the real one.
    const weakened: AcceptanceDefinition = { ...base, expectTests: { passed: 1 } }
    expect(acceptanceDefinitionDigest(weakened)).not.toBe(acceptanceDefinitionDigest(base))
  })

  it('an unauthorized change to the acceptance definition refuses the run', async () => {
    const dir = makeRoot('authorized')
    write(dir, 'src/ok.mjs', 'console.log("fine")\n')
    const base: AcceptanceDefinition = {
      id: 'authorized-case',
      command: [process.execPath, 'src/ok.mjs'],
      cwd: dir,
      inputs: ['src'],
    }
    const authorized = acceptanceDefinitionDigest(base)

    const tampered: AcceptanceDefinition = {
      ...base,
      // The model weakened the acceptance by pointing it at a command that
      // always succeeds, while still claiming the authorized digest.
      command: [process.execPath, '-e', 'process.exit(0)'],
      authorizedDigest: authorized,
    }
    const receipt = await runAcceptance(tampered)
    expect(receipt.outcome).toBe('acceptance_definition_changed')
    expect(receipt.passed).toBe(false)
    expect(receipt.reasons.join(' ')).toContain('does not match the authorized')

    // The untampered definition still runs and still passes, so the refusal is
    // about the change and not about the mechanism being broken.
    const honest = await runAcceptance({ ...base, authorizedDigest: authorized })
    expect(honest.passed).toBe(true)
  }, 90_000)

  it('an A->B->A mutation during verification cannot fool the runner', async () => {
    const dir = makeRoot('aba')
    write(dir, 'src/target.mjs', 'console.log("A")\n')

    /*
     * The schedule, which both arms below share. Getting it wrong is easy and
     * instructive, so it is written out rather than implied:
     *
     *   t=0      the runner digests the live tree (A) and copies the snapshot
     *   t=700    live tree -> B
     *   t=1200   the child reads its target file and FAILS if it is not A
     *   t=1900   live tree -> A          (the A->B->A is now complete)
     *   t=2800   the child exits, so the runner's end digest is taken at ~2810
     *
     * The child deliberately outlives the mutation window. If it exited at
     * t=1210 the runner's END digest would be taken while the live tree still
     * said B, and the test would be measuring the wrong window rather than
     * demonstrating ABA.
     */
    write(dir, 'src/probe.mjs', `
import { readFileSync, writeFileSync } from 'node:fs'
const target = new URL('./target.mjs', import.meta.url)
await new Promise(resolve => setTimeout(resolve, 1200))
const observed = readFileSync(target, 'utf8').trim()
writeFileSync(new URL('./observed.txt', import.meta.url), observed)
if (observed !== 'console.log("A")') {
  console.error('SAW_THE_TAMPERED_TREE: ' + observed)
  process.exit(9)
}
await new Promise(resolve => setTimeout(resolve, 1600))
`)

    const definition: AcceptanceDefinition = {
      id: 'aba-case',
      command: [process.execPath, 'src/probe.mjs'],
      cwd: dir,
      inputs: ['src'],
      timeoutMs: 60_000,
    }
    const digestBefore = digestInputs(definition)

    /*
     * The mutation runs CONCURRENTLY with the acceptance. Awaiting the run
     * first and mutating afterwards would test nothing: the window being
     * probed is the one in which the command is executing.
     */
    const mutate = async (): Promise<void> => {
      await new Promise(resolve => setTimeout(resolve, 700))
      write(dir, 'src/target.mjs', 'console.log("B - the tampered version")\n')
      await new Promise(resolve => setTimeout(resolve, 1_200))
      write(dir, 'src/target.mjs', 'console.log("A")\n')
    }

    const mutation = mutate()
    const snapshotted = await runAcceptance(definition, { keepSnapshot: true })
    await mutation

    // The live tree ends where it started, so endpoint hashing reports no drift
    // at all. This is the whole reason before/after hashing is not sufficient.
    expect(snapshotted.snapshot?.liveDigestAtStart).toBe(digestBefore)
    expect(snapshotted.snapshot?.liveDigestAtEnd).toBe(digestBefore)
    expect(snapshotted.snapshot?.liveDriftDetected).toBe(false)

    // The snapshot is what excluded the tamper: the child ran in the copy, saw
    // A throughout, and the run is a real pass against one immutable tree.
    expect(snapshotted.passed).toBe(true)
    expect(snapshotted.exit.code).toBe(0)
    expect(snapshotted.candidateTreeDigestScope).toBe('snapshot')
    expect(snapshotted.snapshot?.stableDuringRun).toBe(true)
    expect(snapshotted.ranIn).toBe(snapshotted.snapshot?.dir)
    expect(snapshotted.output.stdout.text).not.toContain('B')
    expect(readFileSync(join(snapshotted.snapshot!.dir, 'src', 'observed.txt'), 'utf8')).toBe('console.log("A")')

    // CONTRAST, and the reason the snapshot is load-bearing rather than
    // decorative: the identical scenario verified IN PLACE really does execute
    // against the tampered tree, and its before/after digests STILL agree. A
    // verifier that trusted endpoint hashing would have recorded a clean result
    // for a tree the command never actually ran against.
    write(dir, 'src/target.mjs', 'console.log("A")\n')
    const mutation2 = mutate()
    const inPlace = await runAcceptance({ ...definition, snapshot: false }, { keepSnapshot: true })
    await mutation2

    expect(inPlace.snapshot).toBeUndefined()
    expect(inPlace.exit.code).toBe(9)
    expect(inPlace.passed).toBe(false)
    expect(inPlace.output.stderr.text).toContain('SAW_THE_TAMPERED_TREE')
    expect(inPlace.limitations.join(' ')).toContain('LIVE tree')

    rmSync(snapshotted.snapshot!.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  }, 180_000)

  it('a snapshot that moves under the run yields unknown, not pass', async () => {
    const dir = makeRoot('snapmove')
    write(dir, 'src/target.mjs', 'console.log("A")\n')
    // This command rewrites its OWN input inside the snapshot while it runs.
    // That is the one way a snapshot can stop describing one tree.
    write(dir, 'src/selfmod.mjs', `
import { writeFileSync } from 'node:fs'
await new Promise(resolve => setTimeout(resolve, 500))
writeFileSync(new URL('./target.mjs', import.meta.url), 'console.log("changed under the run")\\n')
await new Promise(resolve => setTimeout(resolve, 500))
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
    expect(receipt.reasons.join(' ')).toContain('changed inside the snapshot')
    expect(receipt.holdReservation).toBe(true)
  }, 90_000)

  it('verifying in place is allowed but the receipt says it is limited', async () => {
    const dir = makeRoot('inplace')
    write(dir, 'src/ok.mjs', 'console.log("fine")\n')

    const receipt = await runAcceptance({
      id: 'in-place',
      command: [process.execPath, 'src/ok.mjs'],
      cwd: dir,
      inputs: ['src'],
      snapshot: false,
      timeoutMs: 30_000,
    })

    expect(receipt.passed).toBe(true)
    expect(receipt.candidateTreeDigestScope).toBe('live')
    expect(receipt.snapshot).toBeUndefined()
    // The honest label matters more than the pass: an in-place run cannot
    // exclude ABA, and the receipt must not imply that it can.
    expect(receipt.limitations.join(' ')).toContain('LIVE tree')
  }, 60_000)

  it('the snapshot is removed afterwards unless the caller asks to keep it', async () => {
    const dir = makeRoot('cleanup')
    write(dir, 'src/ok.mjs', 'console.log("fine")\n')

    const receipt = await runAcceptance({
      id: 'cleanup-case',
      command: [process.execPath, 'src/ok.mjs'],
      cwd: dir,
      inputs: ['src'],
      timeoutMs: 30_000,
    })

    expect(receipt.snapshot?.retained).toBe(false)
    expect(existsSync(receipt.snapshot!.dir)).toBe(false)
  }, 60_000)
})

describe('the untrusted child does not inherit host privilege', () => {
  it('a credential-shaped variable in the runner is not visible to the acceptance command', async () => {
    const dir = makeRoot('scrub')
    write(dir, 'src/env.mjs', `
console.log(JSON.stringify({
  secret: process.env.VERIFY_CANARY_FAKE_API_KEY ?? null,
  token: process.env.VERIFY_CANARY_FAKE_TOKEN ?? null,
  harmless: process.env.VERIFY_HARMLESS_MARKER ?? null,
  dshInternal: process.env.DSH_VERIFY_INTERNAL_MARKER ?? null,
}))
`)

    process.env['VERIFY_CANARY_FAKE_API_KEY'] = 'CANARY-FAKE-API-KEY-VALUE'
    process.env['VERIFY_CANARY_FAKE_TOKEN'] = 'CANARY-FAKE-TOKEN-VALUE'
    process.env['VERIFY_HARMLESS_MARKER'] = 'harmless-visible'
    process.env['DSH_VERIFY_INTERNAL_MARKER'] = 'harness-internal-should-be-scrubbed'
    try {
      const receipt = await runAcceptance({
        id: 'scrub-case',
        command: [process.execPath, 'src/env.mjs'],
        cwd: dir,
        inputs: ['src'],
        timeoutMs: 30_000,
      })
      const seen = JSON.parse(receipt.output.stdout.text.trim()) as Record<string, string | null>
      // The denial path is the property under test: the seam's own
      // scrubbedParentEnv drops credential-shaped names and every DSH_* name
      // before the spawn, while ordinary ambient variables survive so the
      // command can still run normally.
      expect(seen['secret']).toBeNull()
      expect(seen['token']).toBeNull()
      expect(seen['dshInternal']).toBeNull()
      expect(seen['harmless']).toBe('harmless-visible')
    } finally {
      delete process.env['VERIFY_CANARY_FAKE_API_KEY']
      delete process.env['VERIFY_CANARY_FAKE_TOKEN']
      delete process.env['VERIFY_HARMLESS_MARKER']
      delete process.env['DSH_VERIFY_INTERNAL_MARKER']
    }
  }, 60_000)
})

describe('F07: the retry budget is bounded and ends blocked', () => {
  it('a candidate defect is not retried at all', async () => {
    const dir = makeRoot('budgetfail')
    write(dir, 'src/bad.mjs', 'console.log("failing")\nprocess.exit(7)\n')

    const result = await runAcceptanceWithBudget(
      {
        id: 'budget-fail',
        command: [process.execPath, 'src/bad.mjs'],
        cwd: dir,
        inputs: ['src'],
        timeoutMs: 30_000,
      },
      { maxAttempts: 3 },
    )

    expect(result.status).toBe('failed')
    expect(result.attempts).toHaveLength(1)
    expect(result.reason).toContain('not a transient environment fault')
  }, 60_000)

  it('an environment-shaped failure stops as blocked once the budget is spent', async () => {
    const dir = makeRoot('budgetblocked')
    write(dir, 'src/hang.mjs', 'setInterval(() => {}, 1000)\n')

    const result = await runAcceptanceWithBudget(
      {
        id: 'budget-blocked',
        command: [process.execPath, 'src/hang.mjs'],
        cwd: dir,
        inputs: ['src'],
        timeoutMs: 1_000,
      },
      { maxAttempts: 2 },
    )

    // The point of the gate: it stops. It does not keep going until it passes.
    expect(result.status).toBe('blocked')
    expect(result.attempts).toHaveLength(2)
    expect(result.receipt.passed).toBe(false)
    expect(result.reason).toContain('retry budget')
  }, 90_000)
})

describe('F08: the integration ref is accepted only by exact expected-ref CAS', () => {
  it('a moved ref refuses the publication, and an unchanged ref accepts it', async () => {
    const dir = makeRoot('gitcas')
    const git = (...args: string[]): string =>
      execFileSync('git', ['-c', 'user.email=t@example.invalid', '-c', 'user.name=test', ...args], {
        cwd: dir,
        encoding: 'utf8',
      }).trim()

    try {
      execFileSync('git', ['init', '-q'], { cwd: dir, stdio: 'ignore' })
    } catch {
      // No git on this machine: the gate cannot be exercised here, and the
      // honest response is to skip rather than to assert something untested.
      return
    }
    write(dir, 'file.txt', 'first\n')
    git('add', '.')
    git('commit', '-q', '-m', 'first')
    const verifiedBase = git('rev-parse', 'HEAD')

    const { refCas } = await import('./verify.ts')
    const unchanged = await refCas({ cwd: dir, ref: 'HEAD', expectedSha: verifiedBase })
    expect(unchanged.accepted).toBe(true)

    // The integration branch moves after verification.
    write(dir, 'file.txt', 'second\n')
    git('add', '.')
    git('commit', '-q', '-m', 'second')
    const movedTo = git('rev-parse', 'HEAD')
    expect(movedTo).not.toBe(verifiedBase)

    const stale = await refCas({ cwd: dir, ref: 'HEAD', expectedSha: verifiedBase })
    expect(stale.accepted).toBe(false)
    expect(stale.observedSha).toBe(movedTo)
    expect(stale.reason).toContain('refused rather than forced')

    // And a ref that cannot be read is a refusal too, not a benefit of the doubt.
    const unreadable = await refCas({ cwd: dir, ref: 'refs/heads/does-not-exist', expectedSha: verifiedBase })
    expect(unreadable.accepted).toBe(false)
    expect(unreadable.reason).toContain('could not be read')
  }, 90_000)
})

describe('the receipt is machine-readable and self-describing', () => {
  it('serializes to JSON that records every required binding', async () => {
    const dir = makeRoot('receipt')
    write(dir, 'src/ok.mjs', 'console.log("fine")\n')

    const receipt = await runAcceptance({
      id: 'receipt-case',
      command: [process.execPath, 'src/ok.mjs'],
      cwd: dir,
      inputs: ['src'],
      timeoutMs: 30_000,
    })

    const parsed = JSON.parse(serializeReceipt(receipt)) as Record<string, unknown>
    expect(parsed['schema']).toBe('dsh-daily-work/acceptance-receipt@1')
    // The five bindings the delivery plan requires, each actually present.
    expect(parsed['candidateTreeDigest']).toMatch(/^[0-9a-f]{64}$/)
    expect(parsed['acceptanceDefinitionDigest']).toMatch(/^[0-9a-f]{64}$/)
    expect(parsed['environment']).toBeTruthy()
    expect(parsed['command']).toBeTruthy()
    expect(parsed['exit']).toBeTruthy()
    expect((parsed['output'] as { stdout: { text: string } }).stdout.text).toContain('fine')
  }, 60_000)

  it('bounds the output it retains while recording how much there was', async () => {
    const dir = makeRoot('bounded')
    write(dir, 'src/loud.mjs', 'process.stdout.write("HEAD" + "x".repeat(200000) + "TAIL")\n')

    const receipt = await runAcceptance({
      id: 'bounded-case',
      command: [process.execPath, 'src/loud.mjs'],
      cwd: dir,
      inputs: ['src'],
      outputCapBytes: 4_096,
      timeoutMs: 30_000,
    })

    expect(receipt.passed).toBe(true)
    expect(receipt.output.stdout.truncated).toBe(true)
    expect(receipt.output.stdout.text.length).toBeLessThanOrEqual(4_096)
    // The retained text is the TAIL, which is where a runner's summary lives.
    expect(receipt.output.stdout.text.endsWith('TAIL')).toBe(true)
    // The full size is still recorded, so truncation is not confused with silence.
    expect(receipt.output.stdout.totalBytes).toBeGreaterThan(200_000)
  }, 60_000)

  it('refuses an input that escapes cwd instead of silently covering less', async () => {
    const dir = makeRoot('escape')
    await expect(runAcceptance({
      id: 'escape-case',
      command: [process.execPath, '-e', '0'],
      cwd: dir,
      inputs: ['../outside'],
    })).rejects.toThrow(/escapes cwd/)
  })
})

describe('summary parsing matches what the real runners print', () => {
  it('reads vitest counts through its ANSI colouring', () => {
    const line = '\u001B[2m      Tests \u001B[22m \u001B[1m\u001B[32m148 passed\u001B[39m\u001B[22m\u001B[90m (148)\u001B[39m'
    expect(parseTestCounts(line, 'vitest')).toMatchObject({ total: 148, passed: 148 })
  })

  it('reads a mixed vitest summary', () => {
    const line = '      Tests  3 failed | 12 passed | 2 skipped (17)'
    expect(parseTestCounts(line, 'vitest')).toMatchObject({ total: 17, passed: 12, failed: 3, skipped: 2 })
  })

  it('reads vitest "no tests" as a real zero rather than as unparsed', () => {
    expect(parseTestCounts('      Tests  no tests', 'vitest')).toMatchObject({ total: 0, passed: 0 })
  })

  it('reports no counts when there is no summary line at all', () => {
    expect(parseTestCounts('some ordinary output\nwith no summary', 'vitest')).toBeUndefined()
  })

  it('reads the node:test spec summary', () => {
    const text = ['ℹ tests 4', 'ℹ pass 3', 'ℹ fail 1', 'ℹ skipped 0', 'ℹ todo 0'].join('\n')
    expect(parseTestCounts(text, 'node-test')).toMatchObject({ total: 4, passed: 3, failed: 1 })
  })

  it('reads a node:test run in which every case was skipped', () => {
    const text = ['ℹ tests 2', 'ℹ pass 0', 'ℹ fail 0', 'ℹ skipped 2', 'ℹ todo 0'].join('\n')
    expect(parseTestCounts(text, 'node-test')).toMatchObject({ total: 2, passed: 0, skipped: 2 })
  })
})
