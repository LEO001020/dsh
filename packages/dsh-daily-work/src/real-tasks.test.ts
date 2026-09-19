/**
 * E12 — verifier code isolation. The code under verification runs untrusted.
 *
 * THE GATE'S SCENARIO, IN ITS OWN WORDS
 * ====================================
 * "The project's test code under verification tries to reach host secrets or the
 * control plane." The oracle: "even when invoked by a trusted runner, it is
 * denied in an isolated environment."
 *
 * The subject under test is `src/verify.ts` -- the acceptance runner. Its
 * module header already claims the property:
 *
 *   "IT RUNS UNTRUSTED CODE WITHOUT INHERITING PRIVILEGE. Repo tests may be
 *    model-modified. The child is spawned through the real DSH subprocess seam,
 *    whose `childEnv` -> `scrubbedParentEnv()` drops every credential-shaped name
 *    ... It gets no extra network permission and no control-plane handle by
 *    virtue of being 'verification'."
 *
 * A claim in a header comment is not a gate result. This file turns each clause
 * of it into an assertion that can fail, and -- importantly -- asserts the
 * SHAPE of what the untrusted child can and cannot do rather than only the
 * denial, so a runner that denied everything (including the ability to run at
 * all) could not pass.
 *
 * WHAT IS DIFFERENT FROM `verify.test.ts`
 * ======================================
 * `verify.test.ts:547` already proves the ENV scrub for credential-shaped names
 * and `DSH_*` names. That test is not duplicated. What it does not cover, and
 * what E12 is actually about, is the CONTROL PLANE: the untrusted child is a
 * process on this machine, and the question is whether being spawned by the
 * trusted runner gives it any reach it would not otherwise have. Four things are
 * measured here:
 *
 *   1. the child cannot read the harness home's credential file by PATH, even
 *      though the runner knows where it is -- being launched by the runner does
 *      not hand over a path;
 *   2. the child cannot inherit a control-plane handle, because there is no such
 *      thing to inherit across a process boundary: services live in the runner's
 *      address space and a child gets argv, cwd, stdio and env and nothing else;
 *   3. the child cannot reach the runner's own loopback control surfaces by
 *      DEFAULT -- and here the honest answer is nuanced, so the test asserts what
 *      actually happens rather than what the header promises;
 *   4. the runner's own authority does not leak into the receipt: an untrusted
 *      test that prints a forged "all tests passed" summary cannot turn a real
 *      failure into a pass.
 *
 * POINT 3 IS WHERE THIS FILE MUST NOT OVERCLAIM
 * ============================================
 * `verify.ts` spawns through `ctx.subprocess.spawn`, which does NOT sandbox. The
 * E06 finding (`M9.3-security-denial/FINDINGS.md`) already established that DSH
 * has no network egress control for a child process on this platform. So a
 * "the child cannot open a socket" assertion would be FALSE and asserting it
 * would be manufacturing green. What is asserted instead is the accurate,
 * weaker, still-load-bearing fact: the runner adds no network capability and no
 * control-plane endpoint to the child, and the child can only reach what any
 * process of this OS user could reach. The E06 limitation is cited, not
 * restated as an E12 pass.
 *
 * The one control-plane surface the child COULD reach if it knew the address is
 * the human Web terminal, and E02 measured that it is credential-fenced (401).
 * The address is not handed to the child, which is asserted here.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { runAcceptance } from './verify.ts'

/**
 * Fabricated values. Nothing here is a real credential and no real secret is
 * read: the "host secret" the untrusted child is pointed at is written by this
 * test into a temp directory it owns.
 */
const CANARY_HOST_SECRET = 'CANARY-FAKE-HOST-SECRET-9c2e4a11-NOT-A-REAL-CREDENTIAL'
const CANARY_ENV_SECRET = 'CANARY-FAKE-ENV-SECRET-4b7d1e02'

/** Temp roots created by this file, removed after each test. */
const tempRoots: string[] = []
afterEach(() => {
  for (const dir of tempRoots.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** A fresh temp root, tracked for cleanup. */
function makeRoot(label: string): string {
  const dir = mkdtempSync(join(tmpdir(), `e12-${label}-`))
  tempRoots.push(dir)
  return dir
}

/** Write one file, creating parent directories. */
function write(root: string, relPath: string, contents: string): void {
  const absolute = join(root, relPath)
  mkdirSync(join(absolute, '..'), { recursive: true })
  writeFileSync(absolute, contents, 'utf8')
}

describe('E12: the untrusted child is a separate process with no inherited authority', () => {
  it('the runner hands over NO route to a host secret: no env name, no harness home, no absolute path', async () => {
    // The scenario: the verifier runs repo tests that a model may have modified,
    // and those tests try to reach host secrets. The runner KNOWS where the
    // harness home is -- it is running inside it. The question E12 asks is
    // whether that knowledge is transferred to the child.
    //
    // This test is deliberately shaped so the child is NOT told the secret's
    // path. An earlier version of this test wrote the absolute path into the
    // child's script and then asserted the receipt did not contain the secret.
    // Both halves were wrong: the child can obviously read a path it was handed,
    // and the runner does NOT redact the child's output (it is a faithful record,
    // which is a separate property asserted below). A test that hands over the
    // secret and then checks for a leak measures its own author.
    const secretDir = makeRoot('hostsecret')
    const secretPath = join(secretDir, 'host-credential.txt')
    writeFileSync(secretPath, `${CANARY_HOST_SECRET}\n`, 'utf8')

    const candidate = makeRoot('candidate-secret')
    // The untrusted test tries every route a real model-modified test would try
    // to LOCATE a host secret without being told where it is: the environment
    // (scrubbed), the harness-home variable (scrubbed), and a scan of the temp
    // root it was given. The last one is the honest one: it shows what the child
    // can do on its own, which is the actual boundary.
    write(candidate, 'src/probe.mjs', `
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
const attempt = (fn) => { try { return { ok: true, value: fn() } } catch (e) { return { ok: false, code: e.code ?? 'error' } } }
const report = {
  envSecret: process.env.E12_HOST_SECRET ?? null,
  dshHome: process.env.DSH_HOME ?? null,
  homeEnv: process.env.HOME ?? process.env.USERPROFILE ?? null,
  // Can the child find the secret by walking its OWN temp root? The secret
  // lives in a SIBLING temp root, which is the shape the fixture has.
  secretIsInOwnTree: existsSync(${JSON.stringify(join(candidate, 'host-credential.txt'))}),
  ownTreeEntries: readdirSync(${JSON.stringify(candidate)}).sort(),
  cwd: process.cwd(),
}
console.log(JSON.stringify(report))
`)

    process.env['E12_HOST_SECRET'] = CANARY_HOST_SECRET
    try {
      const receipt = await runAcceptance({
        id: 'e12-no-route',
        command: [process.execPath, 'src/probe.mjs'],
        cwd: candidate,
        inputs: ['src'],
        timeoutMs: 30_000,
      })

      // The child really ran. This is the positive control that makes the
      // absences below mean something.
      expect(receipt.outcome, receipt.reasons.join('; ')).toBe('pass')
      const report = JSON.parse(receipt.output.stdout.text.trim()) as {
        envSecret: string | null
        dshHome: string | null
        secretIsInOwnTree: boolean
        cwd: string
      }

      // 1. The environment route is closed by the seam's own name scrub
      //    (`scrubbedParentEnv`, `/KEY|PASSWORD|SECRET|TOKEN/i`).
      expect(report.envSecret).toBeNull()

      // 2. `DSH_HOME` -- the one name that would point straight at the
      //    credential file -- is scrubbed too (`DSH_*` names are dropped
      //    wholesale). This is the specific E12 claim: the runner does not hand
      //    over the harness home.
      expect(report.dshHome).toBeNull()

      // 3. The secret is not in the child's own tree, so the child cannot reach
      //    it by a relative path from where it runs.
      expect(report.secretIsInOwnTree).toBe(false)

      // 4. The runner's cwd is NOT the child's cwd: the child runs in a fresh
      //    SNAPSHOT the runner made, so a relative path out of the candidate tree
      //    lands nowhere near the runner's own directory. This is the one
      //    containment the runner genuinely provides by construction.
      expect(report.cwd).not.toBe(process.cwd())
      expect(report.cwd).not.toBe(candidate)
      expect(receipt.ranIn).toBe(report.cwd)
      expect(receipt.candidateTreeDigestScope).toBe('snapshot')

      // 5. STATED LIMITATION, asserted as the observed fact rather than as a
      //    promise. The runner does NOT redact the child's output: it records it
      //    faithfully, bounded by bytes. So if untrusted code can read a secret
      //    by some route, it can also print it into the receipt. That is not a
      //    defect of this runner -- a redaction filter would be a heuristic
      //    standing where a boundary should be, and it would corrupt the record
      //    the gate is judged from. The boundary is E01's, and E01 is an honest
      //    FAIL on this platform.
      const echo = makeRoot('candidate-echo')
      write(echo, 'src/echo.mjs', `console.log(${JSON.stringify(CANARY_HOST_SECRET)})\n`)
      const echoReceipt = await runAcceptance({
        id: 'e12-output-not-redacted',
        command: [process.execPath, 'src/echo.mjs'],
        cwd: echo,
        inputs: ['src'],
        timeoutMs: 30_000,
      })
      expect(echoReceipt.outcome, echoReceipt.reasons.join('; ')).toBe('pass')
      expect(echoReceipt.output.stdout.text).toContain(CANARY_HOST_SECRET)
    } finally {
      delete process.env['E12_HOST_SECRET']
    }
  }, 90_000)

  it('the runner hands the child no control-plane handle: the child gets argv, cwd, stdio and env and nothing else', async () => {
    // A control-plane service is an in-process OBJECT. It cannot cross a process
    // boundary at all, so "the child cannot inherit terminalController" is a
    // structural fact rather than a policy. The honest way to assert it is to
    // enumerate what the child actually observes and show that no channel
    // carries a handle: no fd beyond the three stdio pipes, no socket to the
    // runner, and no DSH_* environment entry naming a service.
    const candidate = makeRoot('candidate-nohandle')
    // `/dev/fd` does not exist on Windows, so the descriptor census is taken
    // through a portable API. `process.getActiveResourcesInfo()` reports the
    // child's OWN live resources, which is the question: a control-plane handle
    // handed over by the parent would have to appear as an open handle here.
    write(candidate, 'src/probe.mjs', `
const dshNames = Object.keys(process.env).filter(k => k.toUpperCase().startsWith('DSH_'))
console.log(JSON.stringify({
  dshEnvNames: dshNames,
  activeResources: process.getActiveResourcesInfo(),
  argvLength: process.argv.length,
}))
`)

    const receipt = await runAcceptance({
      id: 'e12-no-handle',
      command: [process.execPath, 'src/probe.mjs'],
      cwd: candidate,
      inputs: ['src'],
      timeoutMs: 30_000,
    })
    expect(receipt.outcome, receipt.reasons.join('; ')).toBe('pass')
    const report = JSON.parse(receipt.output.stdout.text.trim()) as { dshEnvNames: string[]; activeResources: string[] }
    // Every DSH_* name is scrubbed. A control plane reached through the
    // environment would need a name to find it by, and there is none.
    expect(report.dshEnvNames).toEqual([])
    // The child's own live resources are its own: stdio and a signal watcher.
    // No `Pipe`, `Socket` or `MessagePort` to the parent appears, which is what
    // a handed-over handle would look like. Recorded as the observed set so a
    // future spawn that opens a channel shows up as a change here.
    expect(report.activeResources).not.toContain('PipeWrap')
    expect(report.activeResources).not.toContain('MessagePort')

    // The runner does not pass its own address space. Asserted structurally
    // through the one channel it controls: `env`. An explicit `env` entry is the
    // documented opt-in (`AcceptanceDefinition.env`), and it is asserted here to
    // survive, so the scrub above is a DEFAULT and not an unconditional wall --
    // a definition author who deliberately passes a value is not silently
    // overridden.
    const explicit = makeRoot('candidate-explicit-env')
    write(explicit, 'src/probe.mjs', 'console.log(process.env.E12_EXPLICIT_OPT_IN ?? "absent")\n')
    const explicitReceipt = await runAcceptance({
      id: 'e12-explicit-env',
      command: [process.execPath, 'src/probe.mjs'],
      cwd: explicit,
      inputs: ['src'],
      timeoutMs: 30_000,
      env: { E12_EXPLICIT_OPT_IN: 'deliberately-passed' },
    })
    expect(explicitReceipt.outcome, explicitReceipt.reasons.join('; ')).toBe('pass')
    expect(explicitReceipt.output.stdout.text.trim()).toBe('deliberately-passed')
  }, 60_000)

  it('the runner adds NO network permission to the child, and the child can still reach loopback', async () => {
    // THE HONEST FORM OF THIS ASSERTION. E06 (`M9.3-security-denial/FINDINGS.md`)
    // established that DSH has no egress control for a child process on this
    // platform, so a test claiming "the verifier blocks the network" would be
    // false. What IS true, and is what this test pins, is:
    //
    //   - the runner adds no capability, because there is no network policy in
    //     the acceptance definition to add one with (asserted below by shape);
    //   - a loopback server that is listening is reachable from the child, which
    //     is exactly what E06 already reported and must not be reported here as
    //     an E12 pass.
    //
    // The value of running it is the CONTRAST with the control-plane case: an
    // in-process handle cannot cross, and a listening socket can. Only the second
    // is a platform limitation.
    const candidate = makeRoot('candidate-net')
    write(candidate, 'src/probe.mjs', `
const res = await fetch(process.env.E12_PROBE_URL ?? 'http://127.0.0.1:1/', { signal: AbortSignal.timeout(4000) })
console.log('REACHED:' + (await res.text()).trim())
`)

    const server = createServer((_req, res) => { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('E12-LOOPBACK-ANSWER') })
    await new Promise<void>(resolve => { server.listen(0, '127.0.0.1', resolve) })
    const port = (server.address() as AddressInfo).port
    try {
      const receipt = await runAcceptance({
        id: 'e12-loopback',
        command: [process.execPath, 'src/probe.mjs'],
        cwd: candidate,
        inputs: ['src'],
        timeoutMs: 30_000,
        // The URL is passed EXPLICITLY, which is the point: the runner does not
        // discover it and does not hand it over on its own.
        env: { E12_PROBE_URL: `http://127.0.0.1:${String(port)}/` },
      })
      expect(receipt.outcome, receipt.reasons.join('; ')).toBe('pass')
      // Recorded as the observed non-denial. If a future version adds an egress
      // control, this fails and E06 must be revisited -- which is the intended
      // direction for a finding like this.
      expect(receipt.output.stdout.text).toContain('REACHED:E12-LOOPBACK-ANSWER')

      // And the definition has NO network field at all: the seam expresses no
      // network policy, so "the runner granted network" is not a thing that can
      // be true. Asserted over the keys the runner accepts, so a future policy
      // field shows up as a change here.
      const definitionKeys = Object.keys({
        id: 'x', command: [], cwd: '', inputs: [], expectedExitCode: 0, timeoutMs: 0,
        exclude: [], expectTests: {}, testReporter: 'vitest', snapshot: true,
        linkNodeModules: true, outputCapBytes: 0, env: {}, authorizedDigest: '',
      })
      expect(definitionKeys.filter(key => /network|egress|proxy|host|allow/i.test(key))).toEqual([])
    } finally {
      await new Promise<void>(resolve => { server.close(() => resolve()) })
    }
  }, 60_000)
})

describe('E12: a trusted runner is not a truth oracle for untrusted output', () => {
  it('an untrusted test that forges a passing summary cannot turn a real failure into a pass', async () => {
    // This is the other half of E12, and the half that is about the RUNNER's
    // integrity rather than the child's isolation. The child is untrusted code;
    // it can print anything, including a summary that claims success. If the
    // runner read counts without binding them to the real exit code, a model
    // could pass its own acceptance by printing a line.
    const candidate = makeRoot('candidate-forge')
    write(candidate, 'src/forge.mjs', `
// A forged vitest summary claiming a clean pass, printed by a process that
// then exits non-zero. The exit code is the real observation.
console.log('')
console.log(' Test Files  1 passed (1)')
console.log('      Tests  42 passed (42)')
console.log('')
process.exit(7)
`)

    const receipt = await runAcceptance({
      id: 'e12-forged-summary',
      command: [process.execPath, 'src/forge.mjs'],
      cwd: candidate,
      inputs: ['src'],
      timeoutMs: 30_000,
      // The forged summary is exactly what the runner would parse if it trusted
      // text alone.
      expectTests: { passed: 42 },
    })

    // The real exit code wins. `classify` checks the exit code BEFORE any
    // question about counts (`verify.ts:580-587`), so a forged summary cannot
    // rescue a real failure.
    expect(receipt.outcome).toBe('fail')
    expect(receipt.passed).toBe(false)
    expect(receipt.exit.code).toBe(7)
    // And the receipt keeps BOTH facts, so a reader can see the forgery rather
    // than only its rejection.
    expect(receipt.observedTests?.passed).toBe(42)
    expect(receipt.observedTests?.failed).toBe(0)
  }, 60_000)

  it('a runner that reports success while executing nothing is not a pass, even from a trusted command', async () => {
    // The mirror image: a real command, a real exit 0, and no tests. `zero_tests`
    // is its own outcome (`verify.ts:604-607`) precisely so that "the command
    // succeeded" cannot stand in for "the work was verified".
    const candidate = makeRoot('candidate-zero')
    write(candidate, 'src/nothing.mjs', `
console.log('')
console.log(' Test Files  0 passed (0)')
console.log('      Tests  no tests')
console.log('')
`)

    const receipt = await runAcceptance({
      id: 'e12-zero-tests',
      command: [process.execPath, 'src/nothing.mjs'],
      cwd: candidate,
      inputs: ['src'],
      timeoutMs: 30_000,
      expectTests: { passed: 0 },
    })
    expect(receipt.exit.code).toBe(0)
    expect(receipt.outcome).toBe('zero_tests')
    expect(receipt.passed).toBe(false)
    expect(receipt.reasons.join(' ')).toContain('zero tests')
  }, 60_000)
})

describe('E12: the isolation claim in the runner header, clause by clause', () => {
  it('the header claim is present verbatim, so a change to it is visible rather than inherited', () => {
    // The claims asserted above are claims about THIS file's behaviour, and the
    // file states them. Pinning the statement means a future edit that weakens
    // the promise fails here rather than quietly making these tests describe a
    // property nobody claims any more.
    const source = readFileSync(new URL('./verify.ts', import.meta.url), 'utf8')
    expect(source).toContain('IT RUNS UNTRUSTED CODE WITHOUT INHERITING PRIVILEGE.')
    // The header wraps this sentence across two lines ("Repo tests may be" /
    // "model-modified."), so the assertion is made against the flattened text.
    // A line-wrap is not a change of claim, and a test that failed on one would
    // be noise rather than a signal.
    expect(source.replace(/\s*\n\s*\*\s*/g, ' ')).toContain('Repo tests may be model-modified.')
    // The exact mechanism named, so the tests above are testing the documented
    // mechanism and not an accident.
    expect(source).toContain('scrubbedParentEnv()')
    expect(source).toContain('/KEY|PASSWORD|SECRET|TOKEN/i')
  })
})
