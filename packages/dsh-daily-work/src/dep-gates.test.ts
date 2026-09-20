/**
 * DEP-01..08 — the deployment/integration acceptance family.
 *
 * WHERE THESE GATES COME FROM. `qualification/specs/acceptance-spec.json`
 * (`schema_version: 2`, 112 mandatory cases) is the NEW spec. Its DEP rows are:
 *
 *   DEP-01 identity lock       DEP-05 missing provider
 *   DEP-02 old-evidence isolation  DEP-06 home-lock race
 *   DEP-03 public exports      DEP-07 lock release stability
 *   DEP-04 SSH path consistency    DEP-08 full build coverage
 *
 * WHAT THIS FILE IS, AND IS NOT. It is the REPRODUCIBLE MECHANISM for the parts
 * of each gate that a test can hold. Where a gate's oracle is a claim about the
 * machine rather than about this code — "a real tool call succeeded on the built
 * launcher", "the platform refuses a read" — this file asserts the OBSERVATION
 * (including the negative one) and `FINDINGS.md` records the status. Weakening
 * an assertion to make a gate greener is the one thing this file must not do.
 *
 * TWO FALSE PASSES THIS FAMILY EXISTS TO CATCH, both measured in this project:
 *
 *   DEP-03 — `tsc -p tsconfig.json` EXCLUDES `src/**\/*.test.ts`, so it exits 0
 *            with or without a test file present. A gate whose oracle is "the
 *            tests type-check" would pass while every test had a type error.
 *            The check config exists for this reason and DEP-03 asserts the
 *            difference by measuring BOTH.
 *
 *   DEP-08 — the same defect, from the other side: this test INJECTS a real
 *            type error into a real test file and requires the typecheck to go
 *            RED. A gate that cannot fail is not a gate. The injection happens
 *            in a COPY of the tree, so no source file is ever left mutated.
 */
import { Context } from '@deepseek-ai/cordis'
import { LocalSubprocessRuntime } from '@deepseek-ai/dsh-subprocess-local'
import Storage from '@deepseek-ai/dsh-storage'
import * as storageDomainPlugin from '@deepseek-ai/dsh-storage-domain'
import * as storageJsonPlugin from '@deepseek-ai/dsh-storage-json'
import { createHash } from 'node:crypto'
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import {
  cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { HomeLockHeldError, acquireHomeLock } from './homelock.ts'
import { WorkService } from './host.ts'

// ---------------------------------------------------------------------------
// Fixture plumbing
// ---------------------------------------------------------------------------

/** The repo root, resolved from this file rather than from cwd. */
const REPO_ROOT = resolve(import.meta.dirname, '..', '..', '..')

/**
 * The cwd every spawned child is given, derived from THIS FILE rather than from
 * `process.cwd()`.
 *
 * WHY NOT `process.cwd()`. The DEP-06/DEP-07 children below are started with
 * `--import tsx/esm` and import `@deepseek-ai/*` and `./host.ts` by bare
 * specifier, so they resolve through this package's `node_modules` junction
 * farm. `tsx` is loaded as an ESM loader BEFORE any module exists, so its own
 * resolution falls back to the process cwd: run the documented way
 * (`cd packages/dsh-daily-work && vitest run ...`) that is this package and it
 * works, but run from the repository root it is the repo root, whose
 * `node_modules` is EMPTY, and every child dies immediately with
 * `ERR_MODULE_NOT_FOUND: Cannot find package 'tsx'`.
 *
 * WHY THIS FILE'S SYMPTOM LOOKED LIKE SOMETHING ELSE. DEP-06 and DEP-07 do not
 * capture their child's stderr (unlike `durability-advanced.test.ts`, which
 * reports it), so a child that died in milliseconds was indistinguishable from
 * a child that hung. It surfaced as `timed out waiting for ...holder.json` at
 * 60090 ms and as `the holder exited before acquiring` -- both read as a lock
 * or teardown problem, and neither was one. Measured directly: the same
 * `node --import tsx/esm` child prints `ERR_MODULE_NOT_FOUND` from the repo
 * root and runs from this package's directory.
 *
 * Anchoring to this file makes the child's resolution independent of the launch
 * directory, which is the property the assertions below actually depend on.
 */
const CHILD_CWD = resolve(import.meta.dirname, '..')

/** The pinned DSH checkout this deployment is qualified against. */
const DSH_SRC = process.env.DSH_SRC_ROOT ?? 'D:/DSH/src/dsh-src'

/** The audit delivery package holding the NEW acceptance spec. */
const AUDIT_SPEC = 'C:/Users/hzq00/Downloads/DSH_NATIVE_IPYTHON_ARCHITECTURE_AUDIT_2026-09-20/dsh-audit-2026-09-20/delivery/acceptance-spec.json'

/** The installed copy of that spec, which is what the repo actually consumes. */
const INSTALLED_SPEC = join(REPO_ROOT, 'qualification', 'specs', 'acceptance-spec.json')

/** The OLD gate spec, whose 104 PASS results must not migrate. */
const OLD_SPEC = join(REPO_ROOT, 'qualification', 'specs', 'gate-spec.json')
const OLD_RESULTS = join(REPO_ROOT, 'qualification', 'gates.json')

const tempDirs: string[] = []
const spawnedChildren: ChildProcess[] = []

function tempDir(label: string): string {
  const dir = mkdtempSync(join(tmpdir(), `dsh-dep-${label}-`))
  tempDirs.push(dir)
  return dir
}

afterEach(async () => {
  for (const child of spawnedChildren.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL')
      await new Promise<void>((settle) => {
        const timer = setTimeout(settle, 5_000)
        child.once('exit', () => { clearTimeout(timer); settle() })
      })
    }
  }
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 3 })
})

/** A recursive sha256 map of a directory's regular files, keyed by relative path. */
function hashTree(root: string, skip: (rel: string) => boolean = () => false): Record<string, string> {
  const out: Record<string, string> = {}
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      const rel = relative(root, full).split(sep).join('/')
      if (skip(rel)) continue
      if (entry.isDirectory()) walk(full)
      else if (entry.isFile()) out[rel] = createHash('sha256').update(readFileSync(full)).digest('hex')
    }
  }
  walk(root)
  return out
}

/**
 * Run a command and capture its exit code without throwing.
 *
 * `timeoutMs` is generous because a full typecheck of this package's 70-odd
 * source files takes seconds, not milliseconds, and a timeout would be
 * indistinguishable from a type error in the exit code.
 */
function run(command: string, args: readonly string[], cwd: string, timeoutMs = 600_000): { code: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync(command, [...args], { cwd, encoding: 'utf8', timeout: timeoutMs, stdio: ['ignore', 'pipe', 'pipe'] })
    return { code: 0, stdout, stderr: '' }
  } catch (error) {
    const failure = error as { status?: number | null; stdout?: string; stderr?: string }
    return { code: failure.status ?? -1, stdout: failure.stdout ?? '', stderr: failure.stderr ?? '' }
  }
}

/**
 * Invoke the pinned TypeScript compiler.
 *
 * Deliberately `node <bin/tsc>` and NOT the `tsc.CMD` shim: `execFileSync` on
 * Windows cannot execute a `.CMD` without a shell, and the failure mode is a
 * silent `-1` that looks exactly like a type error. Resolving the compiler
 * through the pinned checkout is also what makes the version a deployment fact
 * rather than whatever `npx` happens to find.
 */
function tsc(args: readonly string[], cwd: string): { code: number; stdout: string; stderr: string } {
  const compiler = join(DSH_SRC, 'node_modules', 'typescript', 'bin', 'tsc')
  expect(existsSync(compiler), 'the pinned checkout must provide the TypeScript compiler').toBe(true)
  return run(process.execPath, [compiler, ...args], cwd)
}

/**
 * Collapse a source file's comment wrapping so a phrase can be matched across
 * line breaks and comment markers.
 *
 * Needed because these assertions pin PHRASES, and a reflow that changes only
 * the wrapping must not read as a changed claim — while a reflow that changes
 * the WORDS must still fail. Handles `//`, `*`-prefixed block comments and
 * YAML's `#`, and drops the block delimiters themselves.
 */
function flat(text: string): string {
  return text
    .split(/\r?\n/u)
    .map(line => line.replace(/^\s*(?:\/\*\*?|\*\/|\*|\/\/|#)\s?/u, ''))
    .join(' ')
    .replace(/\s+/gu, ' ')
}

// ---------------------------------------------------------------------------
// DEP-01 — identity lock
// ---------------------------------------------------------------------------

describe('DEP-01: the launcher is locked by identity, and a REAL tool call proves it', () => {
  /**
   * The gate's oracle is "a real first tool succeeds; record the module graph;
   * NOT merely `--help` success". The real first tool call was already measured
   * on this deployment and its evidence is cited rather than re-run here,
   * because re-running it means booting the whole launcher — and a re-run would
   * still be the same two launchers.
   *
   * The three evidence files, and what each contributes:
   *
   *   M0.4-first-toolcall/A03-first-toolcall.txt
   *     A real tool round trip through the real host + real AgentLoop with the
   *     PRODUCTION shell tool, asserting the tool/result carries
   *     `CLI_TOOL_ROUND_TRIP` and that the turn is persisted as zstd JSONL.
   *     Exit 0. NOTE it says in its own text that this does NOT prove
   *     `apps/cli/lib/bin.js`; the launcher is proven separately below.
   *
   *   M8.5-c2-real-boot/e2e-tool.json
   *     A REAL Session created on the composed `daily-standard` preset,
   *     reporting the tool catalog the model is offered: 27 tools including
   *     `work`. This is the "first native call is possible at all" half, and it
   *     is what makes the identity claim non-vacuous.
   *
   *   M0.6-launcher-identity/A03-launcher-identity.txt
   *     The identity half: the built and source launchers are DIFFERENT
   *     distribution identities, reproduced 3/3.
   */
  const FIRST_TOOLCALL = join(REPO_ROOT, 'qualification', 'results', 'M0.4-first-toolcall', 'A03-first-toolcall.txt')
  const E2E_TOOL = join(REPO_ROOT, 'qualification', 'results', 'M8.5-c2-real-boot', 'e2e-tool.json')
  const LAUNCHER_IDENTITY = join(REPO_ROOT, 'qualification', 'results', 'M0.6-launcher-identity', 'A03-launcher-identity.txt')

  it('cites a REAL tool round trip, not a --help success', () => {
    const evidence = readFileSync(FIRST_TOOLCALL, 'utf8')
    // The tool actually executed and its result was correlated back.
    expect(evidence).toContain('CLI_TOOL_ROUND_TRIP')
    expect(evidence).toContain('tool/call event names the platform shell')
    expect(evidence).toContain('exit_code: 0')
    // The evidence's own scope limit is pinned, so a later reader cannot read
    // this file as proving the built launcher when it says it does not.
    expect(evidence).toContain('does NOT prove the built apps/cli/lib/bin.js launcher')
  })

  it('cites a real Session on the composed preset whose catalog contains the work tool', () => {
    const finding = JSON.parse(readFileSync(E2E_TOOL, 'utf8')) as {
      created: boolean; sessionId: string | null; toolCountAgentKey: number; toolCountContextKey: number
      workToolPresent: boolean; tools: string[]; error: string | null
    }
    expect(finding.error).toBeNull()
    expect(finding.created).toBe(true)
    expect(finding.sessionId).toMatch(/^session-/)
    // A NON-EMPTY catalog is what stops "no control-plane tool" from being vacuous.
    expect(finding.toolCountAgentKey).toBe(27)
    expect(finding.tools).toContain('work')
    // The scope-key contrast is retained as evidence rather than folklore: the
    // agent object is the correct key, and the context key owns no layer.
    expect(finding.toolCountContextKey).toBe(0)
  })

  it('records that the two launchers are different identities, reproduced 3/3', () => {
    const evidence = readFileSync(LAUNCHER_IDENTITY, 'utf8')
    expect(evidence).toContain('REPRODUCIBILITY: 3/3 runs')
    expect(evidence).toContain('Cannot read properties of undefined')
    expect(evidence).toContain('QUALIFY AND USE THE BUILT ARTIFACT (apps/cli/lib/bin.js)')
  })

  it('the module graph is recorded as digests, and the built graph resolves to lib not src', () => {
    // The pinned checkout commit is the deployment's reference identity, and it
    // is recorded in the lock rather than inferred from a version string.
    const lock = JSON.parse(readFileSync(join(REPO_ROOT, 'compatibility.lock.json'), 'utf8')) as {
      observed_reference: { commit: string; tag: string }
      deployment: { status: string; identity: string }
      runtime_authorization: { live_provider_budget_authorized: boolean }
    }
    expect(lock.observed_reference.commit).toBe('ddefc45fbc7f8e46dd73185e68295696d1297887')
    expect(lock.observed_reference.tag).toBe('dsh-v0.1.6-alpha.2')
    // A version STRING is not an artifact identity, which is why the deployment
    // carries its own digest.
    expect(lock.deployment.identity).toMatch(/^[0-9a-f]{64}$/)
    // The budget lock is read here so the UPG-07 blocker has a single source.
    expect(lock.runtime_authorization.live_provider_budget_authorized).toBe(false)

    // The C0 resolved graph is captured and hashed, so the composition is
    // reproducible rather than asserted.
    const c0 = join(REPO_ROOT, 'qualification', 'results', 'M0.5-c0-resolved-graph')
    for (const name of ['dump-default-headless.yml', 'dump-default-sdk.yml', 'dump-default-web.yml']) {
      const path = join(c0, name)
      expect(existsSync(path), `${name} must be recorded`).toBe(true)
      expect(readFileSync(path, 'utf8').length).toBeGreaterThan(0)
    }
    // Each dump's sha is recorded beside it, which is what makes the graph an
    // identity rather than a snapshot someone happened to take.
    const digestFile = readFileSync(join(c0, 'C0-resolved-graph.md'), 'utf8')
    for (const name of ['dump-default-headless.yml', 'dump-default-sdk.yml', 'dump-default-web.yml']) {
      expect(digestFile).toMatch(new RegExp(`[0-9a-f]{64} \\*${name.replace('.', '\\.')}`))
    }

    // The extension's own peers resolve to exactly one path each, and to a
    // BUILT artifact. `.ts` would mean a src copy mixed into the built graph.
    const nm = join(REPO_ROOT, 'packages', 'dsh-daily-work', 'node_modules', '@deepseek-ai')
    const peers = ['cordis', 'dsh-tools', 'dsh-agent', 'dsh-subagent']
    for (const peer of peers) {
      const link = join(nm, peer)
      expect(existsSync(link), `${peer} must resolve from the extension`).toBe(true)
      const real = realpathSync(link)
      expect(real.toLowerCase()).toContain('dsh-src')
      expect(real.endsWith('.ts'), `${peer} must not resolve to a source file`).toBe(false)
    }
    // And the built launcher is a real artifact, not a source entry point.
    expect(existsSync(join(DSH_SRC, 'apps', 'cli', 'lib', 'bin.js'))).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// DEP-02 — old-evidence isolation
// ---------------------------------------------------------------------------

describe('DEP-02: the old 104-case evidence does not migrate into the new spec', () => {
  /**
   * The audit states its own rule in the spec's first line: "初始均为NOT_RUN ...
   * 旧91PASS不迁入" — all cases start NOT_RUN, and no old PASS is inherited.
   *
   * The failure mode is specific and worth stating: the old spec and the new one
   * share an ID SPACE for DEP/SEC/UPG (the old `gate-spec.json` uses A01..,
   * the new one DEP-01..), so an id-keyed migration would find no collision and
   * could "migrate" by counting 104 old PASSes as evidence for 112 new cases.
   * The tests below assert that the new spec reads NOT_RUN everywhere and that
   * nothing in the repo reads the old results into it.
   */
  it('installs the NEW spec at schema_version 2 with exactly 112 mandatory cases, all NOT_RUN', () => {
    const spec = JSON.parse(readFileSync(INSTALLED_SPEC, 'utf8')) as {
      schema_version: number
      hard_child_capacity: number
      cases: { id: string; tier: string; mandatory: boolean; status: string; evidence: unknown[] }[]
    }
    expect(spec.schema_version).toBe(2)
    expect(spec.hard_child_capacity).toBe(30)
    expect(spec.cases).toHaveLength(112)
    expect(spec.cases.every(c => c.mandatory)).toBe(true)
    // THE RULE. Every case is NOT_RUN; not one carries a PASS.
    expect(new Set(spec.cases.map(c => c.status))).toEqual(new Set(['NOT_RUN']))
    // And no case arrives with pre-attached evidence.
    expect(spec.cases.every(c => c.evidence.length === 0)).toBe(true)

    // The four TIERS and their sizes, so a truncated or padded spec cannot pass.
    // The tiers are the audit's own test-layer vocabulary (`integration`,
    // `fault_injection`, `security`, `evaluation`), not the ID prefixes.
    const tiers = new Map<string, number>()
    for (const c of spec.cases) tiers.set(c.tier, (tiers.get(c.tier) ?? 0) + 1)
    expect(Object.fromEntries([...tiers].sort())).toEqual({
      evaluation: 8, fault_injection: 16, integration: 72, security: 16,
    })
    // And 14 ID families of exactly 8, which is what the acceptance tables say.
    const families = new Map<string, number>()
    for (const c of spec.cases) families.set(c.id.split('-')[0]!, (families.get(c.id.split('-')[0]!) ?? 0) + 1)
    expect(families.size).toBe(14)
    expect([...families.values()].every(n => n === 8)).toBe(true)
    expect([...families.keys()].sort()).toEqual([
      'BRG', 'CAP', 'DAT', 'DEP', 'ECO', 'HIS', 'IPY', 'REC', 'RES', 'SEC', 'UI', 'UPG', 'VER', 'WEB',
    ])
  })

  it('the installed spec is byte-identical to the audit package copy', () => {
    const installed = createHash('sha256').update(readFileSync(INSTALLED_SPEC)).digest('hex')
    const audit = createHash('sha256').update(readFileSync(AUDIT_SPEC)).digest('hex')
    // A drifted copy is a different spec. Pinning the digest is what makes
    // "112 cases" a claim about the audit's text and not about a local edit.
    expect(installed).toBe(audit)
    expect(installed).toBe('2fe95835425eb98eb3bac9eead17985df5bf951669460c8d7a87b8887afb1e0b')
  })

  it('the OLD report still exists, still says PASS, and is NOT the new spec', () => {
    // The old report is deliberately left in place: deleting it would make
    // "the old PASS did not migrate" unverifiable rather than true.
    const old = JSON.parse(readFileSync(OLD_RESULTS, 'utf8')) as { id: string; status: string }[]
    expect(old).toHaveLength(104)
    const oldPasses = old.filter(g => g.status === 'PASS').map(g => g.id)
    expect(oldPasses.length).toBeGreaterThan(0)
    // The old IDs and the new IDs are DISJOINT, which is exactly why an id-keyed
    // migration cannot be trusted to notice the difference.
    const newIds = new Set((JSON.parse(readFileSync(INSTALLED_SPEC, 'utf8')) as { cases: { id: string }[] }).cases.map(c => c.id))
    for (const id of oldPasses) expect(newIds.has(id), `${id} must not collide with a new case id`).toBe(false)
    // The old spec is a different file with a different shape (bare array).
    expect(Array.isArray(JSON.parse(readFileSync(OLD_SPEC, 'utf8')))).toBe(true)
  })

  it('nothing in the qualification tooling reads old results into the new spec', () => {
    // The build script WRITES the old report from the old spec. If it ever
    // started writing the new spec, old PASSes would enter through it.
    const build = readFileSync(join(REPO_ROOT, 'qualification', 'runners', 'build-gates.py'), 'utf8')
    expect(build).toContain('gate-spec.json')
    expect(build).not.toContain('acceptance-spec.json')
    // And the new spec has exactly one producer: the audit package it was
    // copied from. Nothing generates it locally.
    //
    // The walk is RECURSIVE, and that is a strengthening rather than a
    // workaround. The first version listed `runners/` and read every entry as a
    // file, which broke the moment a probe subdirectory was added -- and the
    // tempting fix, skipping non-files, would have let a writer hide one level
    // down. Walking the whole tree keeps the invariant over every runner at any
    // depth, which is what the claim is actually about.
    const runnersDir = join(REPO_ROOT, 'qualification', 'runners')
    const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
      const full = join(dir, entry.name)
      return entry.isDirectory() ? walk(full) : [full]
    })
    const runners = walk(runnersDir)
    expect(runners.length, 'the walk must find files, or this is an empty negative').toBeGreaterThan(10)
    for (const file of runners) {
      const text = readFileSync(file, 'utf8')
      expect(text.includes('writeFileSync') && text.includes('acceptance-spec.json'),
        `${relative(REPO_ROOT, file)} must not write the acceptance spec`).toBe(false)
    }
  })
})

// ---------------------------------------------------------------------------
// DEP-03 — public exports
// ---------------------------------------------------------------------------

describe('DEP-03: all production packages AND tests compile, with no private bypass', () => {
  /**
   * THE FALSE PASS THIS GATE EXISTS FOR. `tsconfig.json` excludes
   * `src/**\/*.test.ts` so the build never emits test code. The consequence is
   * that `tsc -p tsconfig.json` exits 0 regardless of whether any test file
   * type-checks at all — and vitest transpiles without type-checking, so a
   * wrong import in a test compiles silently and fails only at runtime, if at
   * all. Both configs are measured here so the difference is evidence.
   *
   * ATTRIBUTION. This tree is under concurrent construction by other work, so a
   * whole-tree error count is not a stable statement about THIS gate. The
   * assertions below are therefore split by what they can attribute: the CONFIG
   * MECHANISM (deterministic), THIS family's own files (attributable), and the
   * whole-tree result (recorded, with its errors attributed by owner).
   */
  it('the two configs differ exactly in the test exclusion, and both keep strict', () => {
    const pkg = join(REPO_ROOT, 'packages', 'dsh-daily-work')
    const build = readFileSync(join(pkg, 'tsconfig.json'), 'utf8')
    const check = readFileSync(join(pkg, 'tsconfig.check.json'), 'utf8')
    // The build excludes tests; the check clears only that exclude.
    expect(build).toContain('"exclude": ["src/**/*.test.ts"]')
    expect(check).toContain('"exclude": []')
    expect(check).toContain('"include": ["src/**/*.ts"]')
    // It EXTENDS the build config, so the strict flags cannot drift apart.
    expect(check).toContain('"extends": "./tsconfig.json"')
    for (const flag of ['"strict": true', '"noUncheckedIndexedAccess": true', '"noImplicitOverride": true', '"verbatimModuleSyntax": true', '"erasableSyntaxOnly": true']) {
      expect(build, `the build config must keep ${flag}`).toContain(flag)
      expect(check, `the check config must keep ${flag}`).not.toContain(`${flag.slice(0, -1)},`) // inherited, not re-declared loosely
    }
    // The check config's stated reason, pinned so a later edit that removes the
    // file must also remove the claim it makes.
    expect(flat(check)).toContain('a false pass for any gate whose evidence is "the tests type-check"')
    expect(flat(check)).toContain('Vitest does not typecheck')
  })

  it('THIS family\'s own files typecheck clean under the check config', { timeout: 300_000 }, () => {
    // Attributable: these are the files this work owns. An error here is this
    // gate's regression, whatever else the tree is doing.
    const pkg = join(REPO_ROOT, 'packages', 'dsh-daily-work')
    const result = tsc(['-p', 'tsconfig.check.json', '--pretty', 'false'], pkg)
    const output = result.stdout + result.stderr
    const mine = output.split('\n').filter(line => /src\/(dep|sec|upg)-gates\.test\.ts/u.test(line))
    expect(mine, `this family's own files must be clean:\n${mine.join('\n')}`).toEqual([])
    // And the check config really does cover this family: the files are in its
    // include set and the config's exclude is empty, so "clean" is not vacuous.
    for (const file of ['dep-gates.test.ts', 'sec-gates.test.ts', 'upg-gates.test.ts']) {
      expect(existsSync(join(pkg, 'src', file)), `${file} must exist`).toBe(true)
    }
    expect(readFileSync(join(pkg, 'tsconfig.check.json'), 'utf8')).toContain('"exclude": []')
  })

  it('the WHOLE tree — production AND tests — compiles clean under the check config', { timeout: 300_000 }, () => {
    const pkg = join(REPO_ROOT, 'packages', 'dsh-daily-work')
    const result = tsc(['-p', 'tsconfig.check.json', '--pretty', 'false'], pkg)
    const errors = (result.stdout + result.stderr).split('\n').filter(line => /error TS\d+/u.test(line))
    // Errors are attributed by file so a failure names whose work it is rather
    // than reporting a bare count.
    const byFile = new Map<string, number>()
    for (const line of errors) {
      const file = line.split('(')[0]!.replace(/\\/gu, '/')
      byFile.set(file, (byFile.get(file) ?? 0) + 1)
    }
    // THE RECORD. Written on every run, clean or not, so a later reader sees the
    // measurement rather than having to re-run it.
    //
    // HISTORY, recorded because it is the reason this test exists in this shape:
    // an earlier run of this same command found 30+ errors across 18 files
    // (kernel-lifecycle.ts, target-setting.ts, capacity.ts, artifacts.ts,
    // observations.ts, several test files, and one pinned-checkout file that
    // could not resolve `@deepseek-ai/dsh-util-values`). Those files were under
    // concurrent construction in this tree. The count is now zero. The test
    // therefore asserts the ORACLE rather than pinning a count: the gate's claim
    // is "all production packages AND tests compile", and a non-zero count
    // falsifies it whenever it appears.
    writeFileSync(join(REPO_ROOT, 'qualification', 'results', 'M-DEP-SEC-UPG', 'typecheck-errors.txt'),
      `# tsc -p tsconfig.check.json (whole tree, tests included)\n# exit ${String(result.code)}, ${String(errors.length)} error(s) across ${String(byFile.size)} file(s)\n# run: ${new Date().toISOString()}\n#\n# DEP-03's oracle is "all production packages AND tests compile". A non-zero\n# count below falsifies it. The list is empty when the gate holds.\n#\n# For reference: an earlier run of this same command found 30+ errors across 18\n# files that belong to concurrent work in this tree (kernel-lifecycle.ts,\n# target-setting.ts, capacity.ts, artifacts.ts, observations.ts, several test\n# files, and pinned-checkout tool-fs-search/src/direct-call.ts). None was in a\n# file this work owns. That work has since settled.\n\n`
      + [...byFile].sort((a, b) => b[1] - a[1]).map(([file, count]) => `${String(count).padStart(3)}  ${file}`).join('\n')
      + (errors.length === 0 ? '(none)\n' : '\n'), 'utf8')

    // THE GATE. Both signals must agree: zero errors AND exit 0.
    expect(errors, `the whole tree must compile clean:\n${errors.join('\n')}`).toEqual([])
    expect(result.code, result.stdout + result.stderr).toBe(0)
    // Non-vacuous: the check config really does cover test files, which is the
    // difference from the build config that this gate exists to catch.
    expect(readFileSync(join(pkg, 'tsconfig.check.json'), 'utf8')).toContain('"exclude": []')
    const tests = readdirSync(join(pkg, 'src')).filter(f => f.endsWith('.test.ts'))
    expect(tests.length, 'the check config must have test files to cover').toBeGreaterThan(0)
  })

  it('no `any` bypass and no suppression directive in any production source', () => {
    const pkg = join(REPO_ROOT, 'packages', 'dsh-daily-work', 'src')
    const offenders: string[] = []
    for (const file of readdirSync(pkg)) {
      if (!file.endsWith('.ts') || file.endsWith('.test.ts')) continue
      const source = readFileSync(join(pkg, file), 'utf8')
      // COMMENTS ARE STRIPPED FIRST, because a comment that EXPLAINS why a
      // pattern is not a bypass would otherwise be reported as one. That is not a
      // hypothetical: `programmatic-scope.ts` carries a sentence beginning "This
      // is not the `as any` bypass the project forbids", and a line-based scan
      // flagged it. The claim is about CODE.
      const lines = source.split('\n')
      let inBlockComment = false
      lines.forEach((line, index) => {
        // Track block-comment state across lines, since a doc comment's body has
        // no marker of its own.
        const trimmed = line.trim()
        const wasInBlock = inBlockComment
        if (!inBlockComment && trimmed.startsWith('/*')) inBlockComment = !trimmed.includes('*/')
        else if (inBlockComment && trimmed.includes('*/')) inBlockComment = false
        // A line wholly inside a block comment, or a `//` line, is not code.
        if (wasInBlock || trimmed.startsWith('//')) return
        // Strip a TRAILING comment from an otherwise-code line.
        const code = line.replace(/\/\/.*$/u, '').replace(/\/\*.*?\*\//gu, '')
        if (code.trim().length === 0) return
        // The three ways the plan names for bypassing the compiler, each anchored
        // to real syntax so a mention in a string literal is not a hit.
        if (/@ts-(ignore|nocheck|expect-error)\b/u.test(code)) {
          offenders.push(`${file}:${String(index + 1)} suppression: ${code.trim()}`)
        }
        if (/[<:,(\[]\s*any\s*[>,)\];,]/u.test(code) || /:\s*any\s*[=;)]/u.test(code)) {
          offenders.push(`${file}:${String(index + 1)} any: ${code.trim()}`)
        }
        if (/\bas\s+any\b/u.test(code)) offenders.push(`${file}:${String(index + 1)} as any: ${code.trim()}`)
      })
    }
    expect(offenders).toEqual([])
  })

  it('the package exports only public entries, each pointing at a built artifact that exists', () => {
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'packages', 'dsh-daily-work', 'package.json'), 'utf8')) as {
      exports: Record<string, { types: string; default: string }>
      files: string[]
      dsh: { bundle: { patch: string } }
      main: string
    }
    // STRUCTURAL, not a frozen list: the tree is under concurrent construction
    // and a new public entry is a legitimate addition. What must hold is that
    // every key is a real subpath, no key reaches into `src`, and every target
    // is a file the build actually produced.
    for (const [name, entry] of Object.entries(pkg.exports)) {
      expect(name === '.' || name.startsWith('./'), `${name} must be a subpath export`).toBe(true)
      // A `src` target would ship TypeScript where a consumer expects JavaScript
      // and would bind the public surface to the source layout.
      expect(name.includes('/src/'), `${name} must not expose src`).toBe(false)
      if (name === './package.json') continue
      for (const key of ['types', 'default'] as const) {
        const target = join(REPO_ROOT, 'packages', 'dsh-daily-work', entry[key])
        expect(existsSync(target), `${name}.${key} -> ${entry[key]} must exist`).toBe(true)
        expect(entry[key].includes('/src/'), `${name}.${key} must point at built output`).toBe(false)
      }
    }
    // The entries a mounted profile depends on. These are the deployment
    // contract: removing one breaks a profile that names it.
    for (const required of ['./host', './service', './tools', './web-search', './tool-protocol-guards']) {
      expect(Object.keys(pkg.exports), `${required} must stay exported`).toContain(required)
    }
    // The package entry point is the host plugin, not a service module: the
    // profile mounts a plugin.
    expect(pkg.main).toBe('lib/host-plugin.js')
    // The bundle patch is what makes the package a BUNDLE. Without it the
    // resolver installs the code and activates NO layer (G-FIX-04).
    expect(pkg.dsh.bundle.patch).toBe('./cordis.patch.yml')
    expect(pkg.files).toContain('cordis.patch.yml')
    // `files` must cover every export target, or the published package would
    // name a file it does not ship.
    expect(pkg.files.some(glob => glob.startsWith('lib/'))).toBe(true)
  })

  it('no production source deep-imports a private path from a DSH peer', () => {
    // A deep import binds this package to an internal file the peer never
    // promised in its `exports` map, so a peer refactor breaks it silently.
    // Measured against each peer's OWN exports map rather than a hard-coded
    // list, so a peer that widens its exports is not reported as a violation.
    const pkgDir = join(REPO_ROOT, 'packages', 'dsh-daily-work')
    const offenders: string[] = []
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name)
        if (entry.isDirectory()) { walk(full); continue }
        // Production sources only: a TEST may reach a peer's test-support entry
        // point, and the gate's claim is about the shipped surface.
        if (!entry.name.endsWith('.ts') || entry.name.endsWith('.test.ts')) continue
        const text = readFileSync(full, 'utf8')
        for (const match of text.matchAll(/from\s+'(@deepseek-ai\/[^']+)'/gu)) {
          const specifier = match[1]!
          const segments = specifier.split('/')
          const name = segments.slice(0, 2).join('/')
          if (segments.length <= 2) continue
          const subpath = `./${segments.slice(2).join('/')}`
          const peerManifest = join(pkgDir, 'node_modules', ...name.split('/'), 'package.json')
          if (!existsSync(peerManifest)) { offenders.push(`${relative(pkgDir, full)} -> ${specifier} (peer not resolvable)`); continue }
          const peer = JSON.parse(readFileSync(peerManifest, 'utf8')) as { exports?: Record<string, unknown> }
          const keys = Object.keys(peer.exports ?? {})
          // `./src/*` is an explicit, declared escape hatch in the pinned
          // checkout, so an import landing on it is permitted rather than
          // private. Anything else must be named in the peer's exports.
          const permitted = keys.some(key => key === subpath || (key.endsWith('*') && subpath.startsWith(key.slice(0, -1))))
          if (!permitted) offenders.push(`${relative(pkgDir, full)} -> ${specifier} (peer exports: ${keys.join(', ')})`)
        }
      }
    }
    walk(join(pkgDir, 'src'))
    expect(offenders).toEqual([])
  })

  it('every DSH peer a PRODUCTION source imports is resolvable, and the declared/undeclared gap is recorded', () => {
    // Two distinct facts, kept distinct:
    //
    //   RESOLVABLE is the hard invariant. A production import of a peer that
    //   cannot resolve means the package fails to load — the gate's real subject.
    //
    //   DECLARED is the manifest contract. A production import of a peer that is
    //   not in `peerDependencies`/`devDependencies` resolves HERE (through the
    //   junction farm) and can fail in a real install. That gap is RECORDED
    //   rather than asserted to a fixed list, because the tree is under
    //   concurrent construction and a pinned list would churn without saying
    //   anything. `FINDINGS.md` carries the measured gap.
    const pkgDir = join(REPO_ROOT, 'packages', 'dsh-daily-work')
    const manifest = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>
      peerDependencies?: Record<string, string>
      devDependencies?: Record<string, string>
    }
    const declared = new Set([
      ...Object.keys(manifest.dependencies ?? {}),
      ...Object.keys(manifest.peerDependencies ?? {}),
      ...Object.keys(manifest.devDependencies ?? {}),
    ])
    const imported = new Set<string>()
    for (const entry of readdirSync(join(pkgDir, 'src'))) {
      if (!entry.endsWith('.ts') || entry.endsWith('.test.ts')) continue
      const text = readFileSync(join(pkgDir, 'src', entry), 'utf8')
      for (const match of text.matchAll(/from\s+'(@deepseek-ai\/[^'/]+)/gu)) imported.add(match[1]!)
    }
    expect(imported.size).toBeGreaterThan(0)

    // HARD: every imported peer resolves from this package.
    const unresolvable = [...imported].filter(name => !existsSync(join(pkgDir, 'node_modules', ...name.split('/')))).sort()
    expect(unresolvable, 'a production import that cannot resolve is a load failure').toEqual([])

    // RECORDED: the manifest gap. Written to evidence so it is a measurement.
    const undeclared = [...imported].filter(name => !declared.has(name)).sort()
    const evidenceDir = join(REPO_ROOT, 'qualification', 'results', 'M-DEP-SEC-UPG')
    writeFileSync(join(evidenceDir, 'declared-vs-imported.txt'),
      '# DEP-03: DSH peers imported by PRODUCTION sources vs declared in package.json\n'
      + '#\n# The gate\'s oracle is "no deep private import and no `any` bypass". A\n'
      + '# production import of an undeclared peer is the sibling defect: it resolves\n'
      + '# here through the junction farm and can fail in a real install.\n\n'
      + `imported (${String(imported.size)}):\n` + [...imported].sort().map(n => `  ${n}${declared.has(n) ? '' : '   <-- NOT DECLARED'}`).join('\n')
      + `\n\ndeclared (${String(declared.size)}):\n` + [...declared].sort().map(n => `  ${n}`).join('\n')
      + `\n\nUNDECLARED (${String(undeclared.length)}):\n` + undeclared.map(n => `  ${n}`).join('\n') + '\n', 'utf8')
    expect(existsSync(join(evidenceDir, 'declared-vs-imported.txt'))).toBe(true)
    // The peers a CONSUMER must mount are the declared ones, and the set is
    // pinned so a removal is a visible change to the deployment contract.
    for (const required of ['@deepseek-ai/cordis', '@deepseek-ai/dsh-agent', '@deepseek-ai/dsh-storage-domain', '@deepseek-ai/dsh-tools']) {
      expect(declared.has(required), `${required} must stay declared`).toBe(true)
    }
  })
})

// ---------------------------------------------------------------------------
// DEP-04 — SSH path consistency
// ---------------------------------------------------------------------------

describe('DEP-04: read / grep / process / Web resolve the SAME execution world', () => {
  /**
   * THE HONEST ANSWER ON THIS MACHINE, determined from the source rather than
   * assumed: **there is no SSH execution world here at all.** The audit's
   * production path is "trusted DSH host + first-party SSH execution world +
   * dedicated Linux VM" (ARCHITECTURE §13), and this project deliberately does
   * NOT claim one. The tests below therefore establish the two facts the gate
   * can be answered with locally:
   *
   *   1. The pinned checkout DOES implement the one-world contract as a real
   *      property: `SshFileSystem` / `SshSubprocessRuntime` / `SshSandboxProvider`
   *      all `inject: ['ssh']` and route every operation through the SAME
   *      connection, and the local `FileSystem`/`SubprocessRuntime`/`Sandbox`
   *      trio is documented as one world. So the gate's oracle is satisfiable in
   *      principle by the provider set.
   *   2. On THIS deployment the mounted providers are the LOCAL ones, so the
   *      only world that exists is the host's — and a test asserts that, which
   *      is the honest local result. The gate's SSH half is NOT_RUN.
   *
   * The specific defect the gate targets — "不误读host同名文件" (do not
   * misread a same-named file on the host) — cannot even be expressed without a
   * second world to be confused with.
   */
  it('the pinned checkout implements the one-world contract: every SSH provider shares one connection', () => {
    const sshDir = join(DSH_SRC, 'packages', 'ssh')
    expect(existsSync(sshDir), 'the ssh package family must exist at the pinned checkout').toBe(true)

    const fsSsh = readFileSync(join(sshDir, 'fs-ssh', 'src', 'index.ts'), 'utf8')
    const subprocessSsh = readFileSync(join(sshDir, 'subprocess-ssh', 'src', 'index.ts'), 'utf8')
    const sandboxSsh = readFileSync(join(sshDir, 'sandbox-ssh', 'src', 'index.ts'), 'utf8')

    // All three capabilities bind to the SAME `ssh` service, which is what
    // makes them one world rather than three independent remote clients.
    expect(fsSsh).toContain("static inject = ['ssh', 'sandboxPolicy']")
    expect(subprocessSsh).toContain("static inject = ['ssh']")
    expect(sandboxSsh).toContain("static inject = ['ssh']")

    // The remote filesystem returns REMOTE identities, and the host path is a
    // separate, explicitly-derived value — the separation the gate is about.
    expect(fsSsh).toContain('processPath(target: FsTarget): string { return String(target.targetKey) }')
    // Containment is decided on the REMOTE spelling, using posix semantics,
    // because the remote platform is the execution world's, not the host's.
    expect(fsSsh).toContain('const path = posix.relative(')
    // A `file:` URI is derived from the REMOTE path, never from a host path.
    expect(fsSsh).toContain('pathToFileURL(this.processPath(target)).href')

    // The one-world decision is recorded in the checkout's own architecture note.
    const note = join(DSH_SRC, '.agents', 'notes', 'implemented', 'architecture', '2026-07-28-portable-execution-world-consumers.md')
    expect(existsSync(note)).toBe(true)
    expect(readFileSync(note, 'utf8')).toContain('`ctx.fs` and `ctx.subprocess` together define one execution world')
  })

  it('the filesystem seam carries the host/execution-world separation as a typed contract', () => {
    const fsSeam = readFileSync(join(DSH_SRC, 'packages', 'fs', 'fs', 'src', 'index.ts'), 'utf8')
    // `processPath` is the deliberate bridge, and the doc states the hazard the
    // gate names: a host consumer must not treat a target key as a host path.
    expect(flat(fsSeam)).toContain('Return the canonical absolute path a subprocess in this filesystem\'s execution world can open')
    expect(flat(fsSeam)).toContain('The path is deliberately separate from')
    // And the mapping is explicitly allowed to FAIL when the two worlds are
    // not the same filesystem — which is the honest alternative to a guess.
    expect(flat(fsSeam)).toContain('or undefined when this execution world cannot read that host file')
  })

  it('on THIS deployment the mounted providers are LOCAL, so no remote world exists to be consistent with', async () => {
    // The local providers register as the same three services. Mounting them is
    // what a daily host actually does here, and it is the measurement that makes
    // the SSH half NOT_RUN rather than PASS.
    const ctx = new Context()
    await ctx.plugin(LocalSubprocessRuntime)
    const localFs = await import('@deepseek-ai/dsh-fs-local')
    await ctx.plugin(localFs.default as never, { cwd: process.cwd() } as never)

    // One `fs`, one `subprocess`: the one-world property holds for the LOCAL
    // world, so the gate's oracle is met for the world that exists.
    expect(ctx.get('fs' as never)).toBeDefined()
    expect(ctx.get('subprocess' as never)).toBeDefined()
    // No SSH connection is mounted anywhere on this host.
    expect(ctx.get('ssh' as never)).toBeUndefined()

    // The local filesystem's own path bridge is the IDENTITY, which is only
    // sound because there is exactly one world here. A remote provider must
    // override it (measured above), so the difference is visible in the seam.
    const fsImpl = ctx.fs as never as { processPath(t: { targetKey: string }): string; processPathFromHostPath(p: string): string | undefined }
    expect(fsImpl.processPath({ targetKey: 'C:/x/y.txt' })).toBe('C:/x/y.txt')
    // And the host-path mapping exists on the local backend precisely because
    // host and world coincide; a remote backend returns undefined instead.
    expect(fsImpl.processPathFromHostPath('C:/x/y.txt')).toBeDefined()

    await ctx.fiber.dispose()
  })
})

// ---------------------------------------------------------------------------
// DEP-05 — missing provider
// ---------------------------------------------------------------------------

describe('DEP-05: a missing subprocess/sandbox provider fails EXPLICITLY, never as danger-full-access', () => {
  /**
   * The hazard is specific: a composition that cannot confine must not quietly
   * become an unconfined one. There are two halves — the seam must refuse when
   * its provider is absent, and the refusal must NAME the missing capability
   * rather than degrading.
   */
  it('a confining shell executor refuses to load without a ctx.sandbox provider', async () => {
    const ctx = new Context()
    await ctx.plugin(LocalSubprocessRuntime)
    // No sandbox provider is mounted.
    expect(ctx.get('sandbox' as never)).toBeUndefined()

    const bashSandbox = await import('@deepseek-ai/dsh-bash-sandbox')
    // `inject` is a readiness gate: the executor declares `sandbox` and
    // `sandboxPolicy`, so it cannot even activate without them. Cordis parks it
    // rather than running it unconfined — which is the refusal.
    const executor = bashSandbox as unknown as { SandboxBashExecutor: { inject?: readonly string[] } }
    expect(executor.SandboxBashExecutor.inject).toContain('sandbox')
    expect(executor.SandboxBashExecutor.inject).toContain('subprocess')
    expect(executor.SandboxBashExecutor.inject).toContain('sandboxPolicy')

    // The terminal consumer refuses AT SPAWN TIME with an explicit message,
    // rather than falling through to an unconfined PTY. This is the second,
    // independent refusal: even if a composition reached this point, a confined
    // mode with no provider throws instead of executing.
    const terminalBash = readFileSync(join(DSH_SRC, 'packages', 'terminal', 'terminal-bash', 'src', 'index.ts'), 'utf8')
    expect(terminalBash).toContain('requires a ctx.sandbox provider in the execution world')
    // The refusal is INSIDE the confined branch: `danger-full-access` returns
    // before the check, so an unconfined mode needs no provider — and a confined
    // one cannot proceed without it. The order is the guarantee.
    const guardIndex = terminalBash.indexOf("if (policy.mode === 'danger-full-access') return argv")
    const refuseIndex = terminalBash.indexOf('requires a ctx.sandbox provider')
    expect(guardIndex).toBeGreaterThan(-1)
    expect(refuseIndex).toBeGreaterThan(guardIndex)
    expect(terminalBash).toContain('return (await sandbox.confine(argv')

    await ctx.fiber.dispose()
  })

  it('a composition that cannot confine does NOT silently acquire an unconfined executor', async () => {
    const ctx = new Context()
    await ctx.plugin(LocalSubprocessRuntime)
    // Nothing mounts `shell`. A host that failed to mount a confining executor
    // therefore has NO shell at all, which fails closed: the model cannot run a
    // command through a service that does not exist.
    expect(ctx.get('shell' as never)).toBeUndefined()

    // The unconfined executor is a SEPARATE package, so acquiring it is a
    // composition change a reader can see, not a fallback. It is loaded from
    // the pinned checkout by path because this package does not junction it —
    // linking it would make an unconfined executor resolvable from here.
    const bashLocal = await import(pathToFileURL(join(DSH_SRC, 'packages', 'shell', 'bash-local', 'lib', 'index.js')).href) as {
      LocalBashExecutor: new (...args: never[]) => { sandboxMode?: string }
    }
    await ctx.plugin(bashLocal.LocalBashExecutor as never, {} as never)
    // Now there IS a shell — and it reports no sandbox mode, so the tool layer
    // does not advertise the escalation fields. The capability fact is
    // `undefined`, not `danger-full-access`.
    const shell = ctx.shell as never as { sandboxMode?: string }
    expect(shell.sandboxMode).toBeUndefined()

    await ctx.fiber.dispose()
  })

  it('the sandbox-policy default is the STRICTEST mode, so an unconfigured host is read-only', () => {
    const policy = readFileSync(join(DSH_SRC, 'packages', 'sandbox', 'sandbox-policy', 'src', 'index.ts'), 'utf8')
    // The schema default is `read-only`, not `danger-full-access`. A missing
    // configuration therefore narrows rather than widens.
    expect(policy).toContain(".default('read-only')")
    expect(policy).not.toMatch(/mode:[^\n]*default\('danger-full-access'\)/u)
    // `workspaceRoot` has no schema default, so its fallback is real branching
    // resolved absolute — never an empty string that would match everything.
    expect(flat(policy)).toContain('`workspaceRoot` has NO schema default')
    // The mode vocabulary itself, so the type cannot gain a looser default.
    expect(policy).toContain("z.union(['read-only', 'workspace-write', 'danger-full-access'] as const)")
  })

  it('a provider that cannot enforce depth is refused rather than silently accepted (the same fail-closed shape)', () => {
    // This project's own refusal, as the second instance of the pattern: a
    // provider that cannot enforce the deployment limit must not be used.
    const isolation = readFileSync(join(REPO_ROOT, 'packages', 'dsh-daily-work', 'src', 'isolation.test.ts'), 'utf8')
    expect(isolation).toContain('a provider that cannot enforce depth is REFUSED the request rather than accepting and ignoring it')
  })
})

// ---------------------------------------------------------------------------
// DEP-06 — home-lock race
// ---------------------------------------------------------------------------

describe('DEP-06: exactly one host wins the store, including under the A/B interleaving', () => {
  /**
   * The interleaving, restated because it is the whole reason the protocol was
   * replaced:
   *
   *   A and B both read the lock and both observe the same dead holder.
   *   A: rename(stale aside) -> link(A) -> success.
   *   B: rename(...) -> moves A's LIVE lock aside -> link(B) -> success.
   *
   * The audit reproduced it in an extracted protocol
   * (`M10.0-audit-repro/stale_lock_windows.py`: both contenders returned success
   * and the final owner was the second). The 7 in-process tests in
   * `src/homelock.test.ts` are CITED here rather than duplicated; this file adds
   * the REAL two-process variant, because a race claim proven in one process is
   * a claim about one process.
   */
  const HOMELOCK_TEST = join(REPO_ROOT, 'packages', 'dsh-daily-work', 'src', 'homelock.test.ts')

  it('cites the in-process coverage: the kernel object excludes, the note does not', () => {
    const source = readFileSync(HOMELOCK_TEST, 'utf8')
    // The seven behaviours, each named so a deletion is visible.
    for (const behaviour of [
      'refuses a second acquire while the first is held, naming the holder',
      'releases on release, so the next generation is not locked out',
      'is idempotent on release',
      'excludes by RESOLVED path, so two spellings of one directory collide',
      'does not treat an unreadable advisory note as a free lock',
      'leaves a stale note behind without granting access on that basis',
      'refuses a second host over the same lock, then allows one after a clean close',
    ]) expect(source).toContain(behaviour)
  })

  it('cites the reproduced A/B interleaving on this machine, with the fix direction it implies', () => {
    const repro = JSON.parse(readFileSync(join(REPO_ROOT, 'qualification', 'results', 'M10.0-audit-repro', 'stale-lock-local.json'), 'utf8')) as {
      stale_lock_race_reproduced?: boolean
      both_contenders_return_success?: boolean
      second_contender_renamed_live_first_lock?: boolean
      stable_handle_lock_second_acquisition_rejected?: boolean
    }
    // The old protocol admits two winners; the control shows a stable HANDLE
    // refuses a second acquirer. That is the fix direction, measured.
    expect(repro.stale_lock_race_reproduced).toBe(true)
    expect(repro.both_contenders_return_success).toBe(true)
    expect(repro.second_contender_renamed_live_first_lock).toBe(true)
    expect(repro.stable_handle_lock_second_acquisition_rejected).toBe(true)
    // The script that produced it must not depend on `fcntl`, which does not
    // exist on the deployment platform: the audit's own probe does, so it could
    // not run here at all.
    expect(readFileSync(join(REPO_ROOT, 'qualification', 'results', 'M10.0-audit-repro', 'stale_lock_windows.py'), 'utf8')).not.toContain('import fcntl')
  })

  it('a REAL second process is refused while the first holds the lock, over one store', { timeout: 180_000 }, async () => {
    const dir = tempDir('dep06')
    const lockPath = join(dir, 'work-home.lock')
    const reportPath = join(dir, 'child.json')
    const goPath = join(dir, 'go')

    // The child is a real Node process that boots a real WorkService over the
    // real storage stack and reports what its own `open()` did. `--import tsx`
    // is how a .ts service is loaded by a plain Node process.
    const childSource = [
      "const [storeDir, lockPath, reportPath, goPath] = process.argv.slice(1)",
      "const { writeFileSync, existsSync } = await import('node:fs')",
      "const { Context } = await import('@deepseek-ai/cordis')",
      "const Storage = (await import('@deepseek-ai/dsh-storage')).default",
      "const storageJson = await import('@deepseek-ai/dsh-storage-json')",
      "const storageDomain = await import('@deepseek-ai/dsh-storage-domain')",
      "const { WorkService } = await import(" + JSON.stringify(new URL('./host.ts', import.meta.url).href) + ")",
      "const ctx = new Context()",
      "await ctx.plugin(Storage)",
      "await ctx.plugin(storageJson, { root: storeDir })",
      "await ctx.plugin(storageDomain, { backend: 'json' })",
      "const svc = new WorkService(ctx, { targetChildren: 2, maxDepth: 1, budgetCeiling: 10, currency: 'USD', priceVersion: 'dep06', subagentProvider: 'spawn', homeLockPath: lockPath })",
      "let opened = false, failure = null",
      "try { await svc.open(); opened = true } catch (e) { failure = { name: e.name, message: String(e.message).slice(0, 2000) } }",
      "writeFileSync(reportPath, JSON.stringify({ pid: process.pid, opened, failure }))",
      "if (!opened) { process.exit(0) }",
      "// Hold the store until the parent says go, then close cleanly.",
      "const deadline = Date.now() + 30000",
      "while (!existsSync(goPath) && Date.now() < deadline) await new Promise(r => setTimeout(r, 25))",
      "await svc.close(); await ctx.fiber.dispose(); process.exit(0)",
    ].join('\n')

    // The holder: a real child process holding the kernel lock.
    const holder = spawn(process.execPath, [
      '--import', 'tsx/esm', '--input-type=module', '--eval', childSource, '--',
      dir, lockPath, join(dir, 'holder.json'), goPath,
    ], { cwd: CHILD_CWD, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env } })
    spawnedChildren.push(holder)

    const waitForFile = async (path: string, timeoutMs = 60_000): Promise<void> => {
      const deadline = Date.now() + timeoutMs
      while (!existsSync(path)) {
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${path}`)
        await new Promise(resolve => setTimeout(resolve, 25))
      }
    }
    await waitForFile(join(dir, 'holder.json'))
    const holderReport = JSON.parse(readFileSync(join(dir, 'holder.json'), 'utf8')) as { pid: number; opened: boolean; failure: unknown }
    // The holder must actually hold; otherwise the contender's refusal below
    // would be measuring "no lock exists" rather than exclusion.
    expect(holderReport.failure).toBeNull()
    expect(holderReport.opened).toBe(true)

    // The contender: a DIFFERENT real process over the SAME store and lock.
    const contender = spawn(process.execPath, [
      '--import', 'tsx/esm', '--input-type=module', '--eval', childSource, '--',
      dir, lockPath, reportPath, join(dir, 'unused-go'),
    ], { cwd: CHILD_CWD, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env } })
    spawnedChildren.push(contender)
    await waitForFile(reportPath)
    const contenderReport = JSON.parse(readFileSync(reportPath, 'utf8')) as {
      opened: boolean; failure: { name: string; message: string } | null
    }

    // THE ASSERTION THE OLD PROTOCOL COULD NOT MAKE: the second host is REFUSED,
    // with the holder named, instead of both returning success.
    expect(contenderReport.opened).toBe(false)
    expect(contenderReport.failure?.name).toBe('HomeLockHeldError')
    expect(contenderReport.failure?.message).toContain(String(holderReport.pid))
    // The refusal explains WHY it is a refusal, so an operator is not left to
    // delete a lock file by hand.
    const refusal = contenderReport.failure?.message ?? ''
    expect(refusal).toContain('kernel')
    expect(refusal).toContain('no stale lock to delete by hand')
    // The reason names the property that makes a hand-deleted lock the wrong
    // fix: DSH storage has no cross-process write locking.
    expect(refusal).toContain('DSH storage has no cross-process write locking')

    // Release the holder and confirm the guard does not wedge the deployment.
    writeFileSync(goPath, 'go', 'utf8')
    await new Promise<void>((settle) => {
      if (holder.exitCode !== null) { settle(); return }
      holder.once('exit', () => { settle() })
      setTimeout(settle, 30_000)
    })
    expect(holder.exitCode).toBe(0)

    // After a clean close the SAME path is acquirable in this process, so the
    // refusal above was exclusion and not a broken lock.
    const after = await acquireHomeLock(lockPath)
    expect(after.identity.pid).toBe(process.pid)
    await after.release()
  })
})

// ---------------------------------------------------------------------------
// DEP-07 — lock release stability
// ---------------------------------------------------------------------------

describe('DEP-07: a crashed holder releases the kernel lock, and no PID/TTL theft occurs', () => {
  /**
   * The gate's oracle is "same-inode OS lock releases; do NOT steal a live lock
   * by PID or TTL". The second half is the one worth proving, because a TTL is
   * exactly the heuristic that would steal a live lock from a slow holder.
   */
  it('the release mechanism is the kernel handle, not a PID probe or a TTL', () => {
    const lock = readFileSync(join(REPO_ROOT, 'packages', 'dsh-daily-work', 'src', 'homelock.ts'), 'utf8')
    const prose = flat(lock)
    // The comment states the property; the code must not contradict it.
    expect(prose).toContain('A crashed holder therefore never blocks a successor, which is why no PID/TTL heuristic is needed')
    // A TTL is named only as the thing this protocol is NOT: the two
    // occurrences are both in comments that reject it, and there is no `ttl`
    // identifier, field or option anywhere.
    expect((lock.match(/\bTTL\b/gu) ?? []).length).toBe(2)
    expect(lock).not.toMatch(/\bttl\b/gu)
    expect(lock).not.toMatch(/ttlMs|TTL_MS|expiresAt/gu)
    // The old pid probe appears ONLY in the comment that records why it was
    // removed. A reintroduced probe would add a second occurrence — as an
    // identifier rather than inside a sentence about its removal.
    expect((lock.match(/holderProvenGone/gu) ?? []).length).toBe(1)
    expect(flat(lock)).toContain('why the old `holderProvenGone` pid probe is no longer part of the exclusion decision')
    // Windows: a named kernel semaphore, keyed by a hash of the RESOLVED path.
    expect(lock).toContain('CreateSemaphoreW')
    expect(lock).toContain('WaitForSingleObject')
    expect(lock).toContain("createHash('sha256').update(resolve(path).toLowerCase())")
    // POSIX: flock on a descriptor, then verify the locked inode is still the
    // file at the path. A lock on an orphaned inode proves nothing (the ABA case).
    expect(lock).toContain('tryLockExclusive')
    expect(lock).toContain('current.ino === held.ino && current.dev === held.dev')
    // The lock file is NOT removed on release, because keeping the inode stable
    // is what later lockers verify against.
    expect(lock).not.toMatch(/unlink\(/u)
    // The documented SCOPE limit, so the claim is not overread: same machine only.
    expect(prose).toContain('this excludes a second host on the SAME MACHINE')
    expect(prose).toContain('a store shared across machines (a network path) is not covered by either path')
  })

  it('the durability suite already kills a real holder process and confirms it is gone', () => {
    const durability = readFileSync(join(REPO_ROOT, 'packages', 'dsh-daily-work', 'src', 'durability-advanced.test.ts'), 'utf8')
    // The existing real child-process kill machinery, cited rather than rebuilt.
    expect(durability).toContain("host.process.kill('SIGKILL')")
    expect(durability).toContain('async function killAndConfirm(pid: number): Promise<boolean>')
    // And the guard that makes the probe sound: `process.kill(0, 0)` signals the
    // CALLER's process group, so pid <= 0 is rejected outright.
    expect(durability).toContain('process.kill(0, 0)` signals the CALLER')
  })

  it('a SIGKILLed holder frees the store for the next acquirer, with no stale-lock surgery', { timeout: 180_000 }, async () => {
    const dir = tempDir('dep07')
    const lockPath = join(dir, 'work-home.lock')
    const reportPath = join(dir, 'holder.json')

    // A real process that takes the lock and then waits to be killed.
    const childSource = [
      "const [lockPath, reportPath] = process.argv.slice(1)",
      "const { writeFileSync } = await import('node:fs')",
      "const { acquireHomeLock } = await import(" + JSON.stringify(new URL('./homelock.ts', import.meta.url).href) + ")",
      "const held = await acquireHomeLock(lockPath)",
      "writeFileSync(reportPath, JSON.stringify({ pid: process.pid, acquired: true, advisoryWritten: held.advisoryWritten }))",
      "// A live timer holds the event loop open so the process is genuinely alive",
      "// and killable, rather than exiting and releasing the lock by accident.",
      "setInterval(() => {}, 3_600_000)",
      "await new Promise(() => {})",
    ].join('\n')

    const holder = spawn(process.execPath, [
      '--import', 'tsx/esm', '--input-type=module', '--eval', childSource, '--', lockPath, reportPath,
    ], { cwd: CHILD_CWD, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env } })
    spawnedChildren.push(holder)

    const deadline = Date.now() + 60_000
    while (!existsSync(reportPath)) {
      if (holder.exitCode !== null) throw new Error('the holder exited before acquiring')
      if (Date.now() > deadline) throw new Error('timed out waiting for the holder to acquire')
      await new Promise(resolve => setTimeout(resolve, 25))
    }
    const report = JSON.parse(readFileSync(reportPath, 'utf8')) as { pid: number; acquired: boolean }
    expect(report.acquired).toBe(true)

    // While the holder is ALIVE the lock must refuse. This is the anti-theft
    // control: a TTL-based protocol would free the lock here if the holder were
    // merely slow, and this assertion would then fail.
    await expect(acquireHomeLock(lockPath)).rejects.toBeInstanceOf(HomeLockHeldError)
    await expect(acquireHomeLock(lockPath)).rejects.toBeInstanceOf(HomeLockHeldError)

    // The crash. SIGKILL is not catchable, so no cleanup handler runs: the ONLY
    // thing that can free the lock is the kernel closing the holder's handle.
    const killed = holder.kill('SIGKILL')
    expect(killed).toBe(true)
    await new Promise<void>((settle) => {
      if (holder.exitCode !== null || holder.signalCode !== null) { settle(); return }
      holder.once('exit', () => { settle() })
      setTimeout(settle, 30_000)
    })
    expect(holder.signalCode).toBe('SIGKILL')

    // The successor must now acquire WITHOUT any manual intervention — no lock
    // file deletion, no TTL wait, no PID probe. The advisory note from the dead
    // holder is still on disk, and it must not matter.
    const successor = await acquireHomeLock(lockPath)
    expect(successor.identity.pid).toBe(process.pid)
    expect(successor.advisoryWritten).toBe(true)
    // The note now names the LIVE successor, so a later refusal is accurate.
    const note = JSON.parse(readFileSync(lockPath, 'utf8')) as { pid: number }
    expect(note.pid).toBe(process.pid)
    await successor.release()
  })

  it('a stale advisory note from a dead holder does not lock out the next generation', async () => {
    const dir = tempDir('dep07b')
    const lockPath = join(dir, 'work-home.lock')
    // A note naming a pid that cannot exist, with NO kernel lock held. This is
    // the exact state a crashed holder leaves, and the state the old protocol
    // had to reason about and got wrong.
    writeFileSync(lockPath, JSON.stringify({ pid: 2147483647, hostname: 'ghost', startedAt: 'x', token: 't' }), 'utf8')
    const held = await acquireHomeLock(lockPath)
    expect(held.identity.pid).toBe(process.pid)
    await held.release()
  })
})

// ---------------------------------------------------------------------------
// DEP-08 — full build coverage
// ---------------------------------------------------------------------------

describe('DEP-08: the typecheck genuinely goes RED when a test file has a type error', () => {
  /**
   * THE ANTI-FALSE-PASS GATE. A gate that cannot fail is not a gate, so this
   * test injects a deliberate type error into a test file and requires the
   * typecheck to fail.
   *
   * WHY A CONTROLLED FILE SET RATHER THAN THE REAL TREE. The real tree is under
   * concurrent construction, so a whole-tree baseline is not clean and a
   * whole-tree failure could not be attributed to the injection. The fixture
   * below is therefore a minimal `src/` holding exactly one production file and
   * one test file, checked with the REAL, VERBATIM `tsconfig.json` and
   * `tsconfig.check.json` from this package. That is what makes the result
   * attributable: the only difference between the two runs is the test-file
   * exclusion those real configs declare.
   *
   * The fixture lives INSIDE the package directory so Node's module resolution
   * reaches the package's own `node_modules`, and it is removed in a `finally`.
   */
  it('injecting a type error into a TEST file fails the check config and passes the build config', { timeout: 300_000 }, () => {
    const pkg = join(REPO_ROOT, 'packages', 'dsh-daily-work')
    const fixture = join(pkg, `dep08-fixture-${String(process.pid)}-${Date.now().toString(36)}`)
    const src = join(fixture, 'src')
    try {
      mkdirSync(src, { recursive: true })
      // The REAL configs, copied verbatim. Not re-declared here: a synthetic
      // config would prove nothing about the ones this package actually uses.
      for (const name of ['tsconfig.json', 'tsconfig.check.json']) {
        cpSync(join(pkg, name), join(fixture, name))
      }
      // Sanity: the copied configs still say what the gate depends on.
      expect(readFileSync(join(fixture, 'tsconfig.json'), 'utf8')).toContain('"exclude": ["src/**/*.test.ts"]')
      expect(readFileSync(join(fixture, 'tsconfig.check.json'), 'utf8')).toContain('"exclude": []')

      // One production file and one test file. The test imports the production
      // file so a broken copy would fail loudly rather than silently pass.
      writeFileSync(join(src, 'subject.ts'), 'export const answer: number = 42\n', 'utf8')
      const testPath = join(src, 'subject.test.ts')
      const cleanTest = [
        "import { expect, it } from 'vitest'",
        "import { answer } from './subject.ts'",
        "it('reads the answer', () => { expect(answer).toBe(42) })",
        '',
      ].join('\n')
      writeFileSync(testPath, cleanTest, 'utf8')

      // CONTROL 1 — the fixture is clean under BOTH configs, so a later failure
      // can only be the injection.
      const baselineCheck = tsc(['-p', join(fixture, 'tsconfig.check.json'), '--pretty', 'false'], fixture)
      expect(baselineCheck.code, `baseline (check) must be clean:\n${baselineCheck.stdout}${baselineCheck.stderr}`).toBe(0)
      const baselineBuild = tsc(['-p', join(fixture, 'tsconfig.json'), '--noEmit', '--pretty', 'false'], fixture)
      expect(baselineBuild.code, `baseline (build) must be clean:\n${baselineBuild.stdout}${baselineBuild.stderr}`).toBe(0)

      // INJECT. A real type error the compiler can attribute to a named symbol.
      writeFileSync(testPath, `${cleanTest}\nexport const __dep08Injected: number = 'this is not a number'\n`, 'utf8')

      // CONTROL 2 — THE FALSE PASS, demonstrated. The build config excludes
      // `src/**\/*.test.ts`, so it exits 0 on a tree whose test file does not
      // compile. This is precisely why DEP-03's check config exists, and
      // asserting it here is what stops the gate from being satisfied by the
      // weaker config.
      const buildOnMutated = tsc(['-p', join(fixture, 'tsconfig.json'), '--noEmit', '--pretty', 'false'], fixture)
      expect(buildOnMutated.code, 'the build config excludes tests, so it must NOT see the injected error').toBe(0)
      expect(buildOnMutated.stdout + buildOnMutated.stderr).not.toContain('TS2322')

      // THE GATE: the check config goes RED and attributes the error to the
      // TEST file. The message names the TYPE mismatch, not the symbol — TS2322
      // is "Type 'string' is not assignable to type 'number'", so the assertion
      // is on the code and the location rather than on the variable name.
      const checkOnMutated = tsc(['-p', join(fixture, 'tsconfig.check.json'), '--pretty', 'false'], fixture)
      const output = checkOnMutated.stdout + checkOnMutated.stderr
      expect(checkOnMutated.code, 'the typecheck MUST fail on a test-file type error').not.toBe(0)
      expect(output).toContain('error TS2322')
      expect(output).toContain("Type 'string' is not assignable to type 'number'")
      // The error is in the TEST file, which is the file the build config skips.
      // That is the whole claim: the failing file is the one the build excludes.
      expect(output).toMatch(/subject\.test\.ts\(\d+,\d+\)/u)

      // CONTROL 3 — removing the injection restores exit 0 under the check
      // config. Without this, the failure above could be a broken fixture rather
      // than the injected error.
      writeFileSync(testPath, cleanTest, 'utf8')
      const restored = tsc(['-p', join(fixture, 'tsconfig.check.json'), '--pretty', 'false'], fixture)
      expect(restored.code, `restoring the file must restore exit 0:\n${restored.stdout}${restored.stderr}`).toBe(0)
    } finally {
      rmSync(fixture, { recursive: true, force: true, maxRetries: 5 })
    }
    // No source file was ever mutated: the fixture is gone.
    expect(existsSync(fixture)).toBe(false)
  })

  it('the real tree is unmodified by the injection test', () => {
    const pkg = join(REPO_ROOT, 'packages', 'dsh-daily-work')
    // A leftover fixture would be a compiled artifact in the package for no
    // reason, and would also mean the `finally` did not run.
    const leftovers = readdirSync(pkg).filter(f => f.startsWith('dep08-fixture-') || f.startsWith('src-tscheck-'))
    expect(leftovers).toEqual([])
    // And the real configs still say what the gate depends on.
    expect(readFileSync(join(pkg, 'tsconfig.json'), 'utf8')).toContain('"exclude": ["src/**/*.test.ts"]')
    expect(readFileSync(join(pkg, 'tsconfig.check.json'), 'utf8')).toContain('"exclude": []')
  })
})

// ---------------------------------------------------------------------------
// Cross-gate: the launcher identity is a real artifact, not a path
// ---------------------------------------------------------------------------

describe('DEP cross-check: the qualified launcher exists and is not a source path', () => {
  it('the built launcher is present and is absolute in the source tree, not this repo', () => {
    const launcher = join(DSH_SRC, 'apps', 'cli', 'lib', 'bin.js')
    expect(existsSync(launcher), 'the built launcher is the qualified distribution identity').toBe(true)
    // It is a BUILT artifact: no `.ts` at that path, and the file is real JS.
    expect(readFileSync(launcher, 'utf8').length).toBeGreaterThan(0)
    expect(realpathSync(launcher)).toBe(launcher)
    // The launcher is deliberately NOT vendored into this repo: a copy would be
    // a second distribution identity and a second thing to qualify.
    expect(relative(REPO_ROOT, launcher).startsWith('..')).toBe(true)
    expect(isAbsolute(launcher)).toBe(true)
  })

  it('the local launcher resolution fix is present as a script rather than a hand-made junction set', () => {
    const linkAll = join(REPO_ROOT, 'packages', 'dsh-daily-work', 'link-all-dsh.ps1')
    expect(existsSync(linkAll), 'the junction set must be derivable, not hand-maintained').toBe(true)
    const text = readFileSync(linkAll, 'utf8')
    // It derives the install root rather than hard-coding it: a hard-coded path
    // is exactly what broke every junction when the install moved (M0.0 §2).
    expect(text).not.toMatch(/D:\\DSH\\src\\dsh-src/u)
    expect(text.toLowerCase()).toContain('$psscriptroot')
  })

  it('every junction the package depends on resolves to a real directory inside the pinned checkout', () => {
    const nm = join(REPO_ROOT, 'packages', 'dsh-daily-work', 'node_modules', '@deepseek-ai')
    const entries = readdirSync(nm)
    expect(entries.length).toBeGreaterThan(20)
    const broken: string[] = []
    for (const name of entries) {
      const target = join(nm, name, 'package.json')
      if (!existsSync(target)) { broken.push(name); continue }
      // A junction whose target moved leaves a dangling entry that only fails
      // at import time, which is how the whole install broke once already.
      const real = realpathSync(join(nm, name))
      if (!real.toLowerCase().includes(DSH_SRC.toLowerCase().replaceAll('/', '\\'))) {
        // Resolving outside the pinned checkout is a second distribution
        // identity, which is the thing the lock exists to prevent.
        broken.push(`${name} -> ${real}`)
      }
    }
    expect(broken).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// The store-level shape the DEP family shares
// ---------------------------------------------------------------------------

describe('DEP: the store is a single-writer resource, and the lock is what makes that true', () => {
  it('the host service takes the lock BEFORE it opens the domain', async () => {
    const dir = tempDir('depstore')
    const lockPath = join(dir, 'work-home.lock')
    const ctx = new Context()
    await ctx.plugin(Storage)
    await ctx.plugin(storageJsonPlugin as never, { root: dir } as never)
    await ctx.plugin(storageDomainPlugin as never, { backend: 'json' } as never)
    const service = new WorkService(ctx, {
      targetChildren: 2, maxDepth: 1, budgetCeiling: 10, currency: 'USD', priceVersion: 'dep',
      subagentProvider: 'spawn', homeLockPath: lockPath,
    })
    await service.open()
    // While open, the lock is held, so a bare acquire is refused.
    await expect(acquireHomeLock(lockPath)).rejects.toBeInstanceOf(HomeLockHeldError)
    await service.close()
    // After close, the lock is free.
    const after = await acquireHomeLock(lockPath)
    await after.release()
    await ctx.fiber.dispose()
  })

  it('an unconfigured host takes no lock, and that is stated rather than implied', async () => {
    const dir = tempDir('depstore2')
    const ctx = new Context()
    await ctx.plugin(Storage)
    await ctx.plugin(storageJsonPlugin as never, { root: dir } as never)
    await ctx.plugin(storageDomainPlugin as never, { backend: 'json' } as never)
    const service = new WorkService(ctx, {
      targetChildren: 2, maxDepth: 1, budgetCeiling: 10, currency: 'USD', priceVersion: 'dep', subagentProvider: 'spawn',
    })
    await service.open()
    // No `homeLockPath` means no deployment-boundary guard. That is the D02
    // measurement (two hosts both open, the loser's writes are lost) and it is
    // why the guard is a DEPLOYMENT requirement rather than an upstream lease.
    const unguarded = await acquireHomeLock(join(dir, 'other.lock'))
    expect(unguarded.identity.pid).toBe(process.pid)
    await unguarded.release()
    await service.close()
    await ctx.fiber.dispose()
  })

  it('the store directory is created by the lock path, so a fresh deployment does not need a manual mkdir', async () => {
    const dir = tempDir('depstore3')
    const lockPath = join(dir, 'nested', 'deeper', 'work-home.lock')
    const held = await acquireHomeLock(lockPath)
    expect(dirname(lockPath)).toBe(join(dir, 'nested', 'deeper'))
    expect(existsSync(lockPath)).toBe(true)
    await held.release()
  })
})
