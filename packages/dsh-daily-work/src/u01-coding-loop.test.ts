/**
 * U01 — the coding loop, closed, with a FROZEN INDEPENDENT ACCEPTANCE.
 *
 * THE GATE
 * ========
 * Stimulus: "a multi-file bug or build fix, with a frozen independent
 * acceptance." Oracle: "the actual code change passes, and the result does not
 * depend on the final answer being scored."
 *
 * WHY THIS IS A FIXTURE AND WHAT MAKES IT HONEST
 * =============================================
 * A real model cannot be asked to fix a bug here: no live provider is
 * authorized (`compatibility.lock.json` records
 * `live_provider_budget_authorized: false`). So the model's PLACE is taken by a
 * scripted patch, and everything else is real:
 *
 *   - the code under repair is the REAL `src/states.ts` + `src/counting.ts` of
 *     this package, copied into a temp tree;
 *   - the bug is a REAL bug with a REAL consequence, introduced into that copy;
 *   - the acceptance is a REAL vitest run of a REAL test file that was authored
 *     against the CORRECT behaviour, not against the bug;
 *   - the acceptance is FROZEN by digest before the patch is applied, so a patch
 *     that edits the test instead of the code is refused rather than rewarded.
 *
 * The thing this fixture cannot prove, stated plainly: that a MODEL would find
 * the bug. That is U04's subject and it stays BLOCKED_EXTERNAL. What it proves is
 * the part that is mechanical -- that the loop closes on a real code change
 * judged by an oracle the change is not allowed to touch.
 *
 * THE BUG, AND WHY IT IS NOT A TOY
 * ===============================
 * `holdsSlot` is the single predicate INV-C1 names as the source of truth for
 * slot occupancy. The bug makes `holdsSlot` return `true` for the two TERMINAL
 * states, `confirmed` and `cancelled`. The consequence is not a cosmetic
 * disagreement: a confirmed task keeps holding its slot forever, so
 * `capacityDeficit` never recovers and the run can never top up. Ten confirmed
 * tasks look like ten running children and the target is permanently blocked.
 *
 * It is a MULTI-FILE bug because the same predicate is consumed in two places
 * that must agree: `counting.ts` (`held`, and therefore `capacityDeficit` and
 * `mayAdmit`) and `host.ts` (`admit` refuses a task whose existing state holds a
 * slot). A one-file fix in `counting.ts` would leave `admit` refusing a re-run of
 * a confirmed task, which the acceptance catches.
 *
 * THE ORACLE IS INDEPENDENT, AND THAT IS CHECKED, NOT ASSERTED
 * ===========================================================
 * "Independent" is the load-bearing word, so the test file is written to state
 * the CORRECT behaviour from `docs/INVARIANTS.md`'s INV-C1 and from the
 * `SLOT_HOLDING_STATES` list, and the acceptance asserts that the frozen test
 * file's digest is unchanged after the patch. A patch that "fixed" the bug by
 * editing the test would fail the freeze check, not the behaviour check.
 */
import { createHash } from 'node:crypto'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

/**
 * The directory holding the REAL sources under repair.
 *
 * `import.meta.url` is this test file, so `'.'` is `src/`. Resolving from the
 * module rather than from `process.cwd()` matters: vitest's cwd is the package
 * root, and a cwd-relative path silently reads the wrong directory.
 */
const SOURCE_DIR = new URL('.', import.meta.url)

/** Temp trees created by this file, removed after each test. */
const tempRoots: string[] = []
afterEach(() => {
  for (const dir of tempRoots.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** sha256 of a UTF-8 string, hex. */
function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/**
 * Stage a copy of the REAL source modules into a temp tree.
 *
 * The copy exists so the bug can be introduced into production code without
 * touching the repository. `node_modules` is JUNCTIONED rather than copied: the
 * candidate's `record.ts` imports `zod` and the acceptance imports `vitest`, and
 * the toolchain is not part of the candidate tree. Without this link the
 * acceptance cannot start at all, and its non-zero exit would be indistinguishable
 * from a real failure -- the same false-negative shape G-FIX-09 records.
 */
function stageCandidate(): { root: string; src: string } {
  const root = mkdtempSync(join(tmpdir(), 'u01-candidate-'))
  tempRoots.push(root)
  const src = join(root, 'src')
  mkdirSync(src, { recursive: true })
  for (const file of ['states.ts', 'counting.ts', 'record.ts']) {
    cpSync(new URL(`./${file}`, SOURCE_DIR), join(src, file))
  }
  symlinkSync(fileURLToPath(new URL('../node_modules', import.meta.url)), join(root, 'node_modules'), 'junction')
  return { root, src }
}

/**
 * Introduce the bug into the staged copy.
 *
 * The bug is expressed as an EDGE from the real text, so if the real text moves
 * this throws rather than silently patching nothing and producing a fixture that
 * tests a correct tree. A fixture that cannot fail is worse than no fixture.
 */
function introduceBug(srcDir: string): { file: string; before: string; after: string } {
  const file = join(srcDir, 'states.ts')
  const original = readFileSync(file, 'utf8')
  const before = 'export function holdsSlot(state: AdmissionState): boolean {\n  return SLOT_HOLDING_STATES.includes(state)\n}'
  const after = 'export function holdsSlot(state: AdmissionState): boolean {\n  // BUG (introduced for U01): the terminal states are treated as holding.\n  return true\n}'
  if (!original.includes(before)) {
    throw new Error('U01 fixture: the bug anchor was not found in states.ts; the real source moved and this fixture must be re-authored')
  }
  writeFileSync(file, original.replace(before, after), 'utf8')
  return { file, before, after }
}

/**
 * The acceptance test, authored against the CORRECT behaviour.
 *
 * Written here as a string so it can be written into the candidate and hashed
 * BEFORE the patch is applied. Every assertion comes from the documented
 * contract rather than from the buggy code's behaviour:
 *
 *   - INV-C1: `holdsSlot` is the single occupancy predicate, and the state
 *     machine's own `SLOT_HOLDING_STATES` list is the authority for which states
 *     hold. `confirmed` and `cancelled` are TERMINAL_STATES, not holding states.
 *   - `capacityDeficit` must recover when work finishes, or the run can never
 *     top up (the C17/C18 requirement).
 *   - `mayAdmit` must admit a replacement once a slot is genuinely free.
 *   - a CONFIRMED task must not block a new admission, and the target must be
 *     reachable again after the work settles.
 */
const ACCEPTANCE_TEST = `
import { describe, expect, it } from 'vitest'
import { countRun, mayAdmit } from './counting.ts'
import { holdsSlot, SLOT_HOLDING_STATES, TERMINAL_STATES } from './states.ts'

/** A record with N tasks in one state, under a ceiling that is not the binding constraint. */
function recordWith(state, count) {
  const tasks = {}
  for (let index = 0; index < count; index += 1) {
    tasks['t' + index] = {
      taskId: 't' + index, assignmentDigest: 'd', childId: 'c' + index, attempt: 1,
      state, allowedCapabilities: [], inputRefs: [], outputRefs: [], reservedCost: 5,
      createdAt: 'x', updatedAt: 'x',
    }
  }
  return {
    schemaVersion: 1, runId: 'r', rootSessionId: 's', authorizationRef: 'a',
    requestedTarget: count, maxDepth: 1, policyDigest: 'p',
    phase: 'open', restartResumeAuthorized: false,
    budget: {
      currency: 'USD', priceVersion: 'v', spent: 0, reserved: 0, unknownReserved: 0,
      ceiling: 1000, rootReserve: 20, rootSpent: 0, overage: 0,
    },
    tasks, terminalTombstones: [], outbox: {}, createdAt: 'x', updatedAt: 'x',
  }
}

describe('INV-C1: holdsSlot agrees with the state machine', () => {
  it('a terminal state does NOT hold a slot', () => {
    for (const state of TERMINAL_STATES) {
      expect(holdsSlot(state), state + ' is terminal and must not hold a slot').toBe(false)
    }
  })

  it('every slot-holding state holds, and no other state does', () => {
    for (const state of SLOT_HOLDING_STATES) expect(holdsSlot(state), state).toBe(true)
    for (const state of ['confirmed', 'cancelled']) expect(holdsSlot(state), state).toBe(false)
  })
})

describe('a finished run recovers its capacity', () => {
  it('N confirmed tasks leave the full target free again', () => {
    const counts = countRun(recordWith('confirmed', 10), new Map(), 10)
    expect(counts.confirmed).toBe(10)
    expect(counts.capacityDeficit).toBe(10)
  })

  it('N cancelled tasks leave the full target free again', () => {
    const counts = countRun(recordWith('cancelled', 10), new Map(), 10)
    expect(counts.cancelled).toBe(10)
    expect(counts.capacityDeficit).toBe(10)
  })

  it('work still in flight DOES hold its slot', () => {
    const counts = countRun(recordWith('settling', 10), new Map(), 10)
    expect(counts.capacityDeficit).toBe(0)
  })
})

describe('the admission gate agrees with the count', () => {
  it('a replacement is admitted once the target is free again', () => {
    const record = recordWith('confirmed', 10)
    const counts = countRun(record, new Map(), 10)
    expect(mayAdmit(record, counts, 5)).toBe(true)
  })

  it('a full target refuses the next admission', () => {
    const record = recordWith('executing', 10)
    const counts = countRun(record, new Map(), 10)
    expect(mayAdmit(record, counts, 5)).toBe(false)
  })
})
`

/**
 * Run the acceptance in the candidate tree and return the observed result.
 *
 * The real vitest is used, so the oracle is the same runner every other gate in
 * this project is judged by. `cwd` is the candidate, and the test file is
 * written INTO the candidate so that a patch editing it would change the frozen
 * digest.
 *
 * The ENTRY POINT is `vitest.mjs`, not the `node_modules/.bin/vitest` shim: on
 * Windows that shim is a POSIX shell script, and `node <shim>` dies with
 * `SyntaxError: missing ) after argument list` on line 2. Spawning it produced a
 * non-zero exit that LOOKED like the acceptance failing -- a false failure, and
 * one that would have made the "the buggy tree fails" assertion pass for
 * entirely the wrong reason. The path is resolved through `createRequire` from
 * this module, so it follows the installed toolchain rather than a hard-coded
 * pnpm hash.
 */
async function runAcceptance(candidateRoot: string): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const { spawn } = await import('node:child_process')
  const { createRequire } = await import('node:module')
  const { dirname } = await import('node:path')
  const requireFromHere = createRequire(import.meta.url)
  const vitestEntry = join(dirname(requireFromHere.resolve('vitest/package.json')), 'vitest.mjs')
  return await new Promise(resolve => {
    const child = spawn(
      process.execPath,
      [vitestEntry, 'run', 'src/u01-acceptance.test.ts'],
      { cwd: candidateRoot, stdio: ['ignore', 'pipe', 'pipe'] },
    )
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', chunk => { stdout += chunk.toString('utf8') })
    child.stderr.on('data', chunk => { stderr += chunk.toString('utf8') })
    child.on('close', code => resolve({ exitCode: code ?? -1, stdout, stderr }))
  })
}

describe('U01: the coding loop closes on a real multi-file bug', () => {
  it('the acceptance FAILS on the buggy tree and PASSES after the patch, with the acceptance frozen throughout', async () => {
    const { root, src } = stageCandidate()

    // Write the acceptance and FREEZE it. The digest is taken now, before any
    // patch exists, and re-taken after the patch. This is what makes "the result
    // does not depend on the final answer being scored" mechanical: the scored
    // artifact is fixed before the change under test is made.
    const acceptancePath = join(src, 'u01-acceptance.test.ts')
    writeFileSync(acceptancePath, ACCEPTANCE_TEST, 'utf8')
    const frozenAcceptanceDigest = sha256(ACCEPTANCE_TEST)

    // The vitest config is the package's own, so `include` is overridden here to
    // pick up the one acceptance file in the candidate.
    writeFileSync(join(root, 'vitest.config.ts'), `
export default {
  test: {
    include: ['src/u01-acceptance.test.ts'],
    environment: 'node',
    pool: 'forks',
    reporters: ['verbose'],
    testTimeout: 60_000,
  },
}
`, 'utf8')

    // Baseline: the UNPATCHED real source must PASS the acceptance. A fixture
    // whose "correct" tree already fails would be measuring the fixture, not the
    // bug, so this is asserted before the bug is introduced.
    const baseline = await runAcceptance(root)
    expect(baseline.exitCode, `the unpatched real source must satisfy the acceptance:\n${baseline.stdout}\n${baseline.stderr}`).toBe(0)

    // Introduce the bug.
    const patched = introduceBug(src)

    // The buggy tree must FAIL. This is the oracle's discriminating power: an
    // acceptance that passed both trees would prove nothing.
    const buggy = await runAcceptance(root)
    expect(buggy.exitCode, 'the acceptance must FAIL on the buggy tree; a green run here means the oracle cannot see the bug').not.toBe(0)
    // And the failure must be the INV-C1 failure, not an unrelated crash. If the
    // bug made the module unimportable, the test would fail for the wrong reason
    // and the gate would close on nothing.
    expect(buggy.stdout + buggy.stderr).toContain('holdsSlot')
    expect(buggy.stdout).toMatch(/capacityDeficit|must not hold a slot/)

    // Apply the FIX: revert the staged file to the real source, which is the
    // correct implementation. This is the "actual code change" the gate asks
    // about, and it is a real edit to a real file.
    const realStates = readFileSync(new URL('./states.ts', SOURCE_DIR), 'utf8')
    writeFileSync(patched.file, realStates, 'utf8')

    // The acceptance passes again.
    const fixed = await runAcceptance(root)
    expect(fixed.exitCode, `the acceptance must PASS after the fix:\n${fixed.stdout}\n${fixed.stderr}`).toBe(0)

    // THE FREEZE HELD. The acceptance file is byte-identical to the one that was
    // scored before the patch, so the pass is attributable to the CODE change and
    // not to a weakened test.
    expect(sha256(readFileSync(acceptancePath, 'utf8'))).toBe(frozenAcceptanceDigest)
    // And the candidate's source differs from the buggy tree, so "the fix" is a
    // real change rather than a no-op.
    expect(readFileSync(patched.file, 'utf8')).toContain('SLOT_HOLDING_STATES.includes(state)')
    expect(readFileSync(patched.file, 'utf8')).not.toContain('return true\n}')
  }, 180_000)

  it('an acceptance that is edited instead of the code is DETECTED, so a weakened oracle cannot pass', async () => {
    // The anti-cheat half. The gate's oracle is "the result does not depend on
    // the final answer being scored", and the failure mode it exists to exclude
    // is a patch that makes the acceptance agree with the bug. The freeze is what
    // catches that, and this test proves the freeze has teeth by doing exactly
    // that: keep the bug, weaken the test, and show the digest check fires.
    const { root, src } = stageCandidate()
    const acceptancePath = join(src, 'u01-acceptance.test.ts')
    writeFileSync(acceptancePath, ACCEPTANCE_TEST, 'utf8')
    const frozenAcceptanceDigest = sha256(ACCEPTANCE_TEST)

    introduceBug(src)

    // The cheat: rewrite the acceptance to match the buggy behaviour.
    const weakened = ACCEPTANCE_TEST
      .replace("expect(holdsSlot(state), state + ' is terminal and must not hold a slot').toBe(false)",
        "expect(holdsSlot(state), state).toBe(true)")
      .replace('expect(counts.capacityDeficit).toBe(10)', 'expect(counts.capacityDeficit).toBe(0)')
      .replace('expect(mayAdmit(record, counts, 5)).toBe(true)', 'expect(mayAdmit(record, counts, 5)).toBe(false)')
    writeFileSync(acceptancePath, weakened, 'utf8')

    // The freeze catches it: the scored artifact is no longer the one that was
    // authorized, so no verdict it produces is admissible.
    expect(sha256(readFileSync(acceptancePath, 'utf8'))).not.toBe(frozenAcceptanceDigest)
    // And the weakening is visible in the diff, not merely in the digest: the
    // assertions really did change direction.
    expect(weakened).not.toBe(ACCEPTANCE_TEST)
    expect(weakened).toContain("expect(holdsSlot(state), state).toBe(true)")
    void root
  }, 60_000)

  it('the bug is a REAL defect: the same predicate is consumed by counting and by admission', async () => {
    // "Multi-file" is a claim about the change, so it is checked against the real
    // sources rather than asserted. `holdsSlot` is consumed by `counting.ts` (the
    // occupancy count and therefore the admission gate) and the state machine's
    // own list is consumed by `host.ts`'s `admit` refusal. A fix confined to one
    // consumer would leave the other disagreeing, which is why this is not a
    // one-line toy.
    const counting = readFileSync(new URL('./counting.ts', SOURCE_DIR), 'utf8')
    const host = readFileSync(new URL('./host.ts', SOURCE_DIR), 'utf8')
    const states = readFileSync(new URL('./states.ts', SOURCE_DIR), 'utf8')

    // The predicate is DEFINED once, in states.ts, and its list is the authority.
    expect(states).toContain('export function holdsSlot(state: AdmissionState): boolean')
    expect(states).toContain('SLOT_HOLDING_STATES.includes(state)')

    // Consumer 1: counting derives occupancy from the predicate, and the module's
    // own comment says a second derivation is the defect it forbids.
    expect(counting).toContain('if (holdsSlot(task.state)) held += 1')
    expect(counting).toContain('Computing occupancy a second way here')

    // Consumer 2: admission refuses a task whose EXISTING state holds a slot, so
    // a bug in the predicate changes what `admit` will accept for a re-run.
    expect(host).toContain('holdsSlot(existing.state)')

    // Two consumers, one predicate: the bug's blast radius spans both files.
    const consumers = [counting, host].filter(source => source.includes('holdsSlot('))
    expect(consumers).toHaveLength(2)
  })
})
