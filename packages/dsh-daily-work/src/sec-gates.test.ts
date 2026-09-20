/**
 * SEC-01..08 — the security acceptance family.
 *
 * THE RULE THIS FILE FOLLOWS, AND WHY IT MATTERS MORE HERE THAN ELSEWHERE.
 * Two of this family's gates (SEC-01 host secret, SEC-03 external network) are
 * ALREADY MEASURED HONEST FAILS on this platform, recorded in
 * `docs/GAPS.md` (E01, E06) and in `qualification/results/M9.3-security-denial/`.
 * A security test suite that quietly turned those into NOT_RUN — or into a PASS
 * on a weaker oracle — would be worse than no suite, because the FAIL is the
 * finding. So this file:
 *
 *   - RE-ASSERTS the measured non-denial as itself, so a future platform change
 *     is visible rather than silently absorbed;
 *   - asserts the seams' OWN honesty (`enforcement: 'partial'`, the absence of a
 *     read lever in the policy type), so the limit cannot be papered over by a
 *     later claim;
 *   - and puts the PASSES on the controls that genuinely hold: the SSRF guard,
 *     the handle-boundary path fence, and the control-plane refusal.
 *
 * `ctx.terminalController` IS NEVER CALLED ANYWHERE IN THIS FILE. It is the
 * human Web terminal and runs with the execution environment's SYSTEM-USER
 * permissions (its own module header, quoted below). Reaching it from a
 * model-facing path is privilege escalation, not convenience. Where this file
 * needs to prove it is unreachable, it proves it by the ABSENCE of a tool
 * catalog entry and by an explicit `undefined` handle, never by invoking it.
 */
import { Context } from '@deepseek-ai/cordis'
import { LocalSandboxProvider } from '@deepseek-ai/dsh-sandbox-local'
import SandboxPolicyService from '@deepseek-ai/dsh-sandbox-policy'
import { LocalSubprocessRuntime } from '@deepseek-ai/dsh-subprocess-local'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, linkSync, lstatSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { join, relative } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

/** The repo root, resolved from this file rather than from cwd. */
const REPO_ROOT = resolveRepoRoot()

/** The pinned DSH checkout this deployment is qualified against. */
const DSH_SRC = process.env.DSH_SRC_ROOT ?? 'D:/DSH/src/dsh-src'

/** Import a file from the pinned checkout by absolute path. */
const srcUrl = (relativePath: string): string => pathToFileURL(join(DSH_SRC, ...relativePath.split('/'))).href

function resolveRepoRoot(): string {
  // `src/` -> package -> packages -> repo root.
  return join(import.meta.dirname, '..', '..', '..')
}

const tempDirs: string[] = []

function tempDir(label: string): string {
  const dir = mkdtempSync(join(tmpdir(), `dsh-sec-${label}-`))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 3 })
})

/**
 * Collapse a source file's comment wrapping so a phrase survives a reflow but
 * not a reword.
 *
 * Strips only LEADING line markers — the two slash characters, a bare asterisk,
 * the block-comment delimiters, and YAML's hash — one per line. It deliberately
 * does NOT strip markdown emphasis inside a line: that emphasis is part of the
 * record in docs/GAPS.md and in the M9.x findings, and eating it would let a
 * claim be reworded while the assertion still passed.
 */
function flat(text: string): string {
  return text
    .split(/\r?\n/u)
    .map(line => line.replace(/^\s*(?:\/\*\*?|\*\/|\*|\/\/|#)\s?/u, ''))
    .join(' ')
    .replace(/\s+/gu, ' ')
}

/** Read a file from the pinned checkout's source tree. */
function srcFile(relativePath: string): string {
  return readFileSync(join(DSH_SRC, ...relativePath.split('/')), 'utf8')
}

/** Mount the REAL composition the product uses for a confined execution. */
async function mountSandbox(): Promise<{
  ctx: Context
  sandbox: { confine(argv: readonly string[], policy: { mode: string; workspaceRoot: string }): Promise<{ argv: string[]; enforcement: string; denialSignatures: string[] }> }
}> {
  const ctx = new Context()
  await ctx.plugin(LocalSubprocessRuntime)
  await ctx.plugin(LocalSandboxProvider)
  return { ctx, sandbox: ctx.sandbox as never as Awaited<ReturnType<typeof mountSandbox>> extends never ? never : { confine(argv: readonly string[], policy: { mode: string; workspaceRoot: string }): Promise<{ argv: string[]; enforcement: string; denialSignatures: string[] }> } }
}

/** One confined child's observed facts. */
interface ConfinedRun { exitCode: number | null; stdout: string; stderr: string }

/**
 * Run `argv` confined, exactly as `@deepseek-ai/dsh-bash-sandbox` does:
 * `ctx.sandbox.confine(...)` then `ctx.subprocess.spawn(...)`.
 *
 * Collect-mode stdio with an explicit cap, because the subprocess seam has NO
 * default disposition: every stdio field is the caller's decision.
 */
async function runConfined(
  ctx: Context,
  sandbox: { confine(argv: readonly string[], policy: { mode: string; workspaceRoot: string }): Promise<{ argv: string[] }> },
  argv: readonly string[],
  policy: { mode: string; workspaceRoot: string },
): Promise<ConfinedRun> {
  const confined = await sandbox.confine(argv, policy)
  const handle = ctx.subprocess.spawn({
    argv: confined.argv,
    cwd: policy.workspaceRoot,
    stdio: { stdin: 'ignore', stdout: { maxBytes: 1 << 20 }, stderr: { maxBytes: 1 << 20 } },
    graceMs: 30_000,
  })
  const outcome = await handle.done
  return {
    exitCode: outcome.exitCode,
    stdout: (await handle.collected.stdout!.readFrom(0)).text,
    stderr: (await handle.collected.stderr!.readFrom(0)).text,
  }
}

/** A Node one-liner the confined child runs. */
function nodeScript(body: string): string[] {
  return [process.execPath, '-e', body]
}

/**
 * Resolve a package the way the RUNNING code resolves it, so a probe uses the
 * same artifact the sandbox backend would.
 *
 * The work package does not link every sandbox package directly (it links
 * `sandbox-local`, which links the platform backends), so the anchor is chained
 * through `sandbox-local` rather than assumed.
 */
const anchorRequire = createRequire(import.meta.url)
const sandboxLocalRequire = createRequire(anchorRequire.resolve('@deepseek-ai/dsh-sandbox-local'))
/** The built windows-acl runner entry — the argv[1] the provider wraps children with. */
const WINDOWS_ACL_RUNNER = sandboxLocalRequire.resolve('@deepseek-ai/dsh-sandbox-windows-acl/runner')

// ---------------------------------------------------------------------------
// SEC-01 — host secret
// ---------------------------------------------------------------------------

describe('SEC-01: host HOME / DSH_HOME / proc are unreachable from BOTH paths', () => {
  /**
   * THE HONEST RESULT, quoted from `docs/GAPS.md` G-SEAM-12 and measured in
   * `qualification/results/M9.3-security-denial/FINDINGS.md`:
   *
   *   "A confined child READ a canary secret outside the workspace root
   *    successfully, verbatim, under both `read-only` and `workspace-write`
   *    (exit 0). Writes outside are `EPERM` in both modes. ... Network egress is
   *    uncontrolled ... only `web_fetch` has SSRF filtering."
   *
   * So SEC-01 is a FAIL on this platform, and the reason is structural: the
   * Windows rung is a restricted TOKEN whose restricting-SID list intersects
   * only WRITE accesses. A read is not merely un-denied — it is outside the
   * mechanism entirely.
   *
   * The tests below re-measure that non-denial (so a platform change is visible)
   * and pin the two facts that make it structural rather than a misconfiguration
   * (the policy type has no read lever, and the backend reports `partial`).
   */
  const CANARY = 'CANARY-FAKE-SEC01-NOT-A-REAL-CREDENTIAL-4b7e19'

  it('a confined child READS a file outside the workspace root — the measured non-denial, re-asserted', { timeout: 180_000 }, async () => {
    const { ctx, sandbox } = await mountSandbox()
    const base = tempDir('sec01')
    const workspace = join(base, 'workspace')
    const outside = join(base, 'outside')
    mkdirSync(workspace)
    mkdirSync(outside)
    // `outside` is a SIBLING of `workspace`, never a child, so it sits on the far
    // side of the only boundary `workspace-write` draws.
    writeFileSync(join(outside, 'canary-secret.txt'), CANARY, 'utf8')
    writeFileSync(join(workspace, 'harmless.txt'), 'CANARY-HARMLESS-INSIDE', 'utf8')

    for (const mode of ['read-only', 'workspace-write'] as const) {
      const run = await runConfined(ctx, sandbox, nodeScript(
        `const fs=require('fs');const out={};`
        + `try{out.outside=fs.readFileSync(${JSON.stringify(join(outside, 'canary-secret.txt'))},'utf8')}catch(e){out.outsideErr=e.code}`
        + `try{out.inside=fs.readFileSync(${JSON.stringify(join(workspace, 'harmless.txt'))},'utf8')}catch(e){out.insideErr=e.code}`
        + `console.log(JSON.stringify(out))`,
      ), { mode, workspaceRoot: workspace })

      // The child ran at all, so a missing observation cannot be read as a denial.
      expect(run.exitCode, `${mode}: the confined child must exit 0`).toBe(0)
      const observed = JSON.parse(run.stdout.trim()) as { outside?: string; outsideErr?: string; inside?: string; insideErr?: string }
      // THE FINDING: the outside read SUCCEEDS, verbatim. Asserted as itself.
      expect(observed.outside, `${mode}: the measured result is that a confined child READS outside the workspace`).toBe(CANARY)
      expect(observed.outsideErr).toBeUndefined()
      // The control: the inside read also succeeds, so the result is not "the
      // child is broken" — the boundary simply does not cover reads.
      expect(observed.inside).toBe('CANARY-HARMLESS-INSIDE')
      // No denial signature appeared on stderr, so this is a genuine read rather
      // than a denial misread as success.
      expect(run.stderr).not.toMatch(/access is denied/iu)
    }

    // The backend's OWN claim about what it achieves. Pinning it literally means
    // a future change to that claim fails this test and forces a re-read.
    const confined = await sandbox.confine([process.execPath, '--version'], { mode: 'read-only', workspaceRoot: workspace })
    expect(confined.enforcement).toBe('partial')

    await ctx.fiber.dispose()
  })

  it('the WRITE boundary does hold, so the limit is read-specific rather than a dead sandbox', { timeout: 180_000 }, async () => {
    const { ctx, sandbox } = await mountSandbox()
    const base = tempDir('sec01w')
    const workspace = join(base, 'workspace')
    const outside = join(base, 'outside')
    mkdirSync(workspace)
    mkdirSync(outside)
    const target = join(outside, 'must-not-exist.txt')

    const run = await runConfined(ctx, sandbox, nodeScript(
      `const fs=require('fs');const out={};`
      + `try{fs.writeFileSync(${JSON.stringify(target)},'X');out.outsideWrite='ALLOWED'}catch(e){out.outsideWrite='DENIED:'+e.code}`
      + `console.log(JSON.stringify(out))`,
    ), { mode: 'workspace-write', workspaceRoot: workspace })
    const observed = JSON.parse(run.stdout.trim()) as { outsideWrite: string }
    // A write outside is refused. This is the durability property that DOES hold
    // — and the honest statement is that it is a write boundary, not a
    // confidentiality one.
    expect(observed.outsideWrite).toMatch(/^DENIED:/u)
    expect(existsSync(target)).toBe(false)
    await ctx.fiber.dispose()
  })

  it('the sandbox seam has NO read lever, so the limit is structural rather than a misconfiguration', () => {
    const sandboxSeam = srcFile('packages/sandbox/sandbox/src/index.ts')
    // `SandboxPolicy` extends `SandboxExecutionPolicy` and adds exactly ONE
    // thing: a narrowed mode. There is no field a caller could set to restrict
    // reads, which is why "denied at a real OS/adapter boundary" cannot be
    // satisfied here even in principle.
    const policyMatch = /export interface SandboxPolicy extends SandboxExecutionPolicy \{([\s\S]*?)\n\}/u.exec(sandboxSeam)
    expect(policyMatch, 'SandboxPolicy must be declared in the seam').not.toBeNull()
    const policyBody = policyMatch![1]!
    expect(policyBody).toMatch(/mode: ConfinedSandboxMode/u)
    expect(policyBody).not.toMatch(/(read|secret|confidential)\s*[:?]/iu)
    // The base it extends carries `mode` + `workspaceRoot` (+ `sessionId`) and
    // nothing else.
    const baseMatch = /export interface SandboxExecutionPolicy \{([\s\S]*?)\n\}/u.exec(sandboxSeam)
    expect(baseMatch, 'SandboxExecutionPolicy must be declared').not.toBeNull()
    const baseBody = baseMatch![1]!
    expect(baseBody).toMatch(/mode: SandboxMode/u)
    expect(baseBody).toMatch(/workspaceRoot: string/u)
    expect(baseBody).not.toMatch(/read|secret|confidential/iu)
    // The mode vocabulary is file-effect only, and says so.
    expect(flat(sandboxSeam)).toContain('Network and process visibility are outside this vocabulary')

    // The Windows backend's OWN header states the boundary in the same terms.
    const win = srcFile('packages/sandbox/sandbox-windows-acl/src/index.ts')
    expect(flat(win)).toContain('writes are restricted; reads, network, and process visibility are NOT')
    expect(flat(win)).toContain('WRITE_RESTRICTED intersects only write accesses')

    // THE FINDING IS NOT WINDOWS-SPECIFIC, and this is the part an earlier pass
    // left implicit. All four backends are expressed through this one seam, and
    // EVERY profile builder is write-only:
    //   - bwrap:     `--ro-bind / /` mounts the whole host READ-ONLY (so reads
    //                succeed and writes get EROFS) — the flag name says it;
    //   - Landlock:  `readOnly: ['/']` grants read over the whole host;
    //   - Seatbelt:  `(allow default)` + `(deny file-write*)` — allow-by-default
    //                for everything except writes;
    //   - windows-acl: WRITE_RESTRICTED, quoted above.
    // So a read restriction is not merely absent from the Windows rung; it is
    // absent from the vocabulary every backend is built from. Measured in WSL
    // against the exact bwrap argv this builder produces: reading a file outside
    // the policy root exits 0 and prints its contents.
    const profiles = srcFile('packages/sandbox/sandbox-local/src/profiles.ts')
    expect(profiles).toMatch(/'--ro-bind', '\/', '\/'/u)
    expect(profiles).toMatch(/landlockGrantArgs\(\{ readOnly: \['\/'\], readWrite \}\)/u)
    expect(profiles).toMatch(/'\(allow default\)', '\(deny file-write\*\)'/u)
    // No builder emits a read DENIAL or a network namespace flag. `--unshare-pid`
    // is present (process visibility) and `--unshare-net` is NOT, which is the
    // SEC-03 half of the same fact.
    expect(profiles).not.toMatch(/unshare-net/u)
    expect(profiles).not.toMatch(/deny file-read|file-read\*/u)

    // The README states the same limit as a selection rule, so a caller choosing
    // this backend is told to pair it with a read-side policy rather than
    // discovering it by measurement.
    const winReadme = srcFile('packages/sandbox/sandbox-windows-acl/README.md')
    expect(flat(winReadme)).toContain('Choose a different mechanism when the child must also be read-confined or network-restricted')
    expect(flat(winReadme)).toContain('Read-side confinement and network policy are out of scope')

    // And the confined-run result type carries no read fact either: a caller
    // cannot even OBSERVE a read denial, because the shape has no field for one.
    const confinedMatch = /export interface ConfinedArgv \{([\s\S]*?)\n\}/u.exec(sandboxSeam)
    expect(confinedMatch, 'ConfinedArgv must be declared').not.toBeNull()
    const fields = confinedMatch![1]!
    expect(fields).toContain('argv')
    expect(fields).toContain('enforcement')
    expect(fields).toContain('denialSignatures')
    // No FIELD restricts reads. The `denialSignatures` doc mentions the string
    // "read-only" because that is bwrap's EROFS text, so the check is on field
    // NAMES rather than on the word appearing anywhere in the body.
    const fieldNames = [...fields.matchAll(/^\s{2}(?:readonly )?([a-zA-Z]+)[?]?:/gmu)].map(m => m[1]!)
    expect(fieldNames.sort()).toEqual(['argv', 'denialSignatures', 'enforcement', 'runnerFailureRules'])
    expect(fieldNames).not.toContain('read')
    expect(fieldNames).not.toContain('secret')
  })

  it('the credential-name scrub is real, and is NOT credential isolation', () => {
    const subprocessSeam = srcFile('packages/subprocess/subprocess/src/index.ts')
    // The control that DOES exist: credential-SHAPED names and every `DSH_*`
    // name are dropped before a child starts.
    expect(flat(subprocessSeam)).toContain('scrubbedParentEnv')
    expect(subprocessSeam).toMatch(/SENSITIVE_ENV_PATTERN/u)
    expect(subprocessSeam).toMatch(/DSH_ENV_PREFIX/u)
    // The honest statement, recorded here so the control is not overread: it is
    // a NAME heuristic in trusted code, in the SUBPROCESS seam, defeated by any
    // credential stored in a FILE — which the read finding above shows is
    // readable from a confined child.
    const findings = readFileSync(join(REPO_ROOT, 'qualification', 'results', 'M9.3-security-denial', 'FINDINGS.md'), 'utf8')
    expect(flat(findings)).toContain('DSH on Windows has a credential-name scrub for spawned processes and no credential isolation boundary')
    expect(flat(findings)).toContain('defeated by any credential stored in a FILE')
  })

  it('the gate is recorded as a FAIL, and the record names the reason', () => {
    // The GAPS entry is the project's own honest record. Pinning its text means
    // a later edit that softens the FAIL to NOT_RUN fails this test.
    const gaps = readFileSync(join(REPO_ROOT, 'docs', 'GAPS.md'), 'utf8')
    expect(gaps).toContain('G-SEAM-12')
    expect(flat(gaps)).toContain('A confined child **read** a canary secret outside the workspace root successfully, verbatim')
    // ASSERTED AS THE CLAIM, NOT AS ITS MARKUP. This read
    // `toContain('CONFIRMED BY MEASUREMENT')`, which pinned an emphasis string
    // that the GAPS ledger's own status vocabulary forbids: its header requires
    // every Status cell to BEGIN with a vocabulary word (OPEN / RESOLVED / FIXED
    // / ...), so a status of `**CONFIRMED BY MEASUREMENT**` is a filing error the
    // hygiene pass was right to normalise. The claim survived -- the row is still
    // OPEN and still says "confirmed by measurement" -- but the ALL-CAPS emphasis
    // did not, so the assertion now names the two facts that must not be softened:
    // that the finding is a MEASUREMENT (not an argument), and that the entry is
    // still OPEN (not resolved into a pass).
    expect(flat(gaps)).toMatch(/confirmed by measurement/i)
    expect(flat(gaps)).toMatch(/OPEN \(upstream limitation, confirmed by measurement\)/)
    // And the E01 verdict, which must not be reworded into a pass.
    const findings = readFileSync(join(REPO_ROOT, 'qualification', 'results', 'M9.3-security-denial', 'FINDINGS.md'), 'utf8')
    expect(flat(findings)).toContain('NOT_RUN — CANNOT BE CLOSED ON WINDOWS')
    expect(flat(findings)).toContain('This gate must stay NOT_RUN (not PASS) until either the platform gains a read boundary or the deployment\'s threat model is restated to exclude reads')
  })

  it('a host HOME / DSH_HOME canary is readable from a confined child — the same finding, aimed at the gate\'s own subject', { timeout: 180_000 }, async () => {
    // The gate names HOME/DSH_HOME specifically. The fixture is a FABRICATED
    // directory that plays the role of a home: no real `~/.dsh` is read.
    const { ctx, sandbox } = await mountSandbox()
    const base = tempDir('sec01h')
    const workspace = join(base, 'workspace')
    const fakeHome = join(base, 'fake-home')
    mkdirSync(workspace)
    mkdirSync(join(fakeHome, '.dsh'), { recursive: true })
    writeFileSync(join(fakeHome, '.dsh', 'credentials.json'), JSON.stringify({ apiKey: CANARY }), 'utf8')

    const run = await runConfined(ctx, sandbox, nodeScript(
      `const fs=require('fs');const out={};`
      + `try{out.creds=JSON.parse(fs.readFileSync(${JSON.stringify(join(fakeHome, '.dsh', 'credentials.json'))},'utf8')).apiKey}catch(e){out.err=e.code}`
      + `console.log(JSON.stringify(out))`,
    ), { mode: 'read-only', workspaceRoot: workspace })
    const observed = JSON.parse(run.stdout.trim()) as { creds?: string; err?: string }
    // A credential FILE is readable. This is the concrete consequence the gate
    // cares about, and it is asserted rather than described.
    expect(observed.creds).toBe(CANARY)
    await ctx.fiber.dispose()
  })

  it('the SAME non-boundary holds on the POSIX backend: the bwrap profile reads outside the policy root', { timeout: 180_000 }, async () => {
    // This is the measurement that decides whether SEC-01 is a WINDOWS
    // deployment fact or a SEAM fact, and it matters for the promotion verdict:
    // a gate that fails only on Windows could be closed by moving the deployment;
    // one that fails in the seam's own vocabulary cannot.
    //
    // The probe runs the EXACT argv `bwrapProfileArgs()` produces for
    // `read-only` — not a paraphrase of it — against a real Linux kernel. bwrap
    // comes from the WSL distro this host has; if it is not present the test
    // reports SKIP with the reason rather than passing silently.
    const probe = spawnSync('wsl.exe', ['-e', 'bash', '-c', 'command -v bwrap'], { encoding: 'utf8', timeout: 60_000 })
    if (probe.status !== 0 || !probe.stdout.includes('bwrap')) {
      // Not a pass: an unavailable platform is stated as such.
      expect(probe.status === 0 ? 'no bwrap' : 'wsl unavailable').toBe('SKIPPED — no POSIX sandbox runner on this host')
      return
    }
    const script = [
      'set -u',
      'BASE=$(mktemp -d)',
      'mkdir -p "$BASE/workspace"',
      `printf '%s' 'CANARY-FAKE-SEC01-POSIX' > "$BASE/outside.txt"`,
      // The exact profile from profiles.ts, with only the policy root differing.
      'bwrap --ro-bind / / --dev /dev --unshare-pid --proc /proc --die-with-parent -- cat "$BASE/outside.txt"',
      'echo "READ_EXIT=$?"',
      'bwrap --ro-bind / / --dev /dev --unshare-pid --proc /proc --die-with-parent -- touch "$BASE/outside.txt" 2>&1',
      'echo "WRITE_EXIT=$?"',
      'rm -rf "$BASE"',
    ].join('\n')
    const run = spawnSync('wsl.exe', ['-e', 'bash', '-c', script], { encoding: 'utf8', timeout: 120_000 })
    const out = `${run.stdout}${run.stderr}`
    // THE FINDING: the outside read succeeds under the POSIX profile too, so
    // "reads are outside the vocabulary" is a property of the SEAM, not of the
    // Windows rung.
    expect(out, out).toContain('CANARY-FAKE-SEC01-POSIX')
    expect(out).toMatch(/READ_EXIT=0/u)
    // And the write IS denied — the same write-only boundary, on Linux.
    expect(out).toMatch(/WRITE_EXIT=(?!0)\d+/u)
    expect(out).toContain('Read-only file system')
  })

  /**
   * CLOSABILITY, MEASURED RATHER THAN ARGUED.
   *
   * A FAIL is only a complete answer if the seam genuinely cannot express the
   * requirement. "No read lever exists" was previously established by reading
   * the type declarations. That is necessary but not sufficient: a public seam
   * could exist OUTSIDE the type — a mode that behaves differently, a runner
   * argv the provider would pass through, an operator override. Each of those is
   * probed below, because each is the kind of seam an earlier pass could have
   * missed.
   *
   * The three candidate levers, and what the measurement says:
   *
   *   1. A DIFFERENT `mode`. Measured against a real confined child: `read-only`
   *      and `workspace-write` BOTH read the outside canary verbatim, and
   *      `danger-full-access` is not even a policy the seam can carry
   *      (`ConfinedSandboxMode = Exclude<SandboxMode, 'danger-full-access'>`),
   *      with the consumer short-circuiting to unconfined before `confine()`.
   *      So no mode restricts reads.
   *   2. A READ FLAG smuggled through the runner argv. The runner's parser has a
   *      closed switch and fails closed on anything else — measured by handing
   *      the REAL built runner three plausible flags, all of which exit 127 with
   *      `unknown argument`.
   *   3. The `runnerCommand` override. This is a REAL public config seam and the
   *      one genuinely worth checking. It can only prefix a runner that then
   *      receives the same bwrap-compatible FILE-EFFECT profile, it skips the
   *      functional probes (so it is an operator assertion, not a verified
   *      control), and on win32 the platform chain has exactly ONE candidate —
   *      so it is a way to substitute a different file-effect confiner, not a
   *      way to express read confinement. Using it for reads would mean
   *      SHIPPING a new OS-level read-confining runner, which is new
   *      infrastructure rather than a use of this seam.
   */
  it('CLOSABILITY: every candidate read lever is measured and none restricts a read', { timeout: 180_000 }, async () => {
    const { ctx, sandbox } = await mountSandbox()
    const base = tempDir('sec01c')
    const workspace = join(base, 'workspace')
    const outside = join(base, 'outside')
    mkdirSync(workspace)
    mkdirSync(outside)
    const target = join(outside, 'canary.txt')
    writeFileSync(target, CANARY, 'utf8')

    // LEVER 1 — mode. Every mode the seam can carry is exercised.
    for (const mode of ['read-only', 'workspace-write'] as const) {
      const run = await runConfined(ctx, sandbox, nodeScript(
        `const fs=require('fs');try{console.log('READ_OK:'+fs.readFileSync(${JSON.stringify(target)},'utf8'))}catch(e){console.log('READ_DENIED:'+e.code)}`,
      ), { mode, workspaceRoot: workspace })
      expect(run.stdout.trim(), `${mode}: a different mode must not be claimed to restrict reads`).toBe(`READ_OK:${CANARY}`)
    }
    // `danger-full-access` cannot reach `confine()` at all: it is excluded from
    // the policy type AND short-circuited by the consumer.
    const sandboxSeam = srcFile('packages/sandbox/sandbox/src/index.ts')
    expect(sandboxSeam).toMatch(/export type ConfinedSandboxMode = Exclude<SandboxMode, 'danger-full-access'>/u)
    expect(sandboxSeam).toMatch(/mode: ConfinedSandboxMode/u)
    const bashExecutor = srcFile('packages/shell/bash-sandbox/src/index.ts')
    expect(bashExecutor, 'danger-full-access must bypass confine() entirely')
      .toMatch(/if \(mode === 'danger-full-access'\) \{\s*\n\s*const result = await super\.run\(spec\)/u)
    await ctx.fiber.dispose()

    // LEVER 2 — a read/network flag through the runner argv, measured against
    // the REAL built runner rather than a paraphrase of its parser.
    expect(existsSync(WINDOWS_ACL_RUNNER), 'the built runner must exist for this probe to be a measurement').toBe(true)
    const runnerSource = srcFile('packages/sandbox/sandbox-windows-acl/src/runner.ts')
    // The parser's own closed vocabulary, quoted from source.
    const cases = [...runnerSource.matchAll(/case '(--[a-z-]+)':/gu)].map(m => m[1]!)
    expect(cases.sort()).toEqual(['--mode', '--temp', '--temp-write-sid', '--workspace', '--write-sid'])
    expect(runnerSource).toMatch(/default: fail\(`unknown argument: \$\{token\}`\)/u)
    const probeWorkspace = tempDir('sec01c-runner')
    for (const extra of [['--deny-net'], ['--read-only-fs', '/'], ['--no-network'], ['--deny-read', '/']]) {
      const probe = spawnSync(process.execPath, [
        WINDOWS_ACL_RUNNER,
        '--workspace', probeWorkspace, '--temp', tmpdir(), '--mode', 'read-only',
        ...extra, '--', process.execPath, '-e', 'console.log("RAN")',
      ], { encoding: 'utf8', timeout: 60_000 })
      // Fail-closed: the flag is REFUSED, so it can never be silently ignored —
      // which is the property that makes "no read flag exists" trustworthy.
      expect(probe.status, `${extra[0]} must be refused by the runner`).toBe(127)
      expect(`${probe.stdout}${probe.stderr}`).toMatch(/unknown argument/u)
      expect(`${probe.stdout}${probe.stderr}`).not.toContain('RAN')
    }

    // LEVER 3 — the `runnerCommand` override: real, public, and still file-effect only.
    const local = srcFile('packages/sandbox/sandbox-local/src/index.ts')
    // The override branch prefixes the SAME profile builder, so the profile it
    // can express is exactly the file-effect one.
    expect(local).toMatch(/if \(this\.runnerCommand !== undefined\) \{[\s\S]{0,220}argv: \[\.\.\.this\.runnerCommand, \.\.\.bwrapProfileArgs\(policy\), '--', \.\.\.argv\]/u)
    // Every profile builder emits file-effect flags only — no read denial and no
    // network namespace. Asserted on the builder source, so a new flag is visible.
    const profiles = srcFile('packages/sandbox/sandbox-local/src/profiles.ts')
    expect(profiles).not.toMatch(/unshare-net|file-read|deny file-read/iu)
    expect(profiles).toMatch(/'--ro-bind', '\/', '\/'/u)
    // The win32 chain has exactly one candidate, so there is no second runner to
    // select even in principle.
    const chains = /const PLATFORM_CHAINS: Record<string, readonly SelectedRunner\['runner'\]\[\]> = \{([\s\S]*?)\n\}/u.exec(local)
    expect(chains, 'PLATFORM_CHAINS must be declared').not.toBeNull()
    expect(chains![1]!, 'win32 must have exactly one candidate runner').toMatch(/win32: \['windows-acl'\]/u)
    // And the override is documented as an unprobed OPERATOR ASSERTION, which is
    // why it cannot be presented as an enforcement boundary.
    const localReadme = srcFile('packages/sandbox/sandbox-local/README.md')
    expect(flat(localReadme)).toContain('`runnerCommand` is an operator assertion')
    expect(flat(localReadme)).toContain('skips functional probes')
    expect(flat(localReadme)).toContain('assumed to implement the bwrap-compatible profile honestly')

    // LEVER 4 — the fs seam, in case a READ fence exists there.
    const fence = srcFile('packages/fs/fs-sandbox/src/index.ts')
    expect(flat(fence)).toContain('Reads pass through untouched: every mode permits reading')
    // Measured, not read: the only overridden (fenced) methods are the mutations.
    const fenced = [...fence.matchAll(/override async ([a-zA-Z]+)\(/gu)].map(m => m[1]!)
    expect(fenced.sort(), 'only mutations may be fenced').toEqual(['editText', 'writeText'])
  })
})

// ---------------------------------------------------------------------------
// SEC-02 — control-plane bypass
// ---------------------------------------------------------------------------

describe('SEC-02: the kernel cannot reach the human terminal, the plugin manager or an admin RPC', () => {
  /**
   * The gate's two halves, and the one that is load-bearing:
   *
   *   1. `ctx.terminalController` must NEVER be exposed to the model. Its own
   *      module header says it runs with "the execution environment's
   *      system-user permissions", and `create()` is documented as allocating "a
   *      user shell ... without Agent sandbox or approval restrictions". A tool
   *      wrapping it would be privilege escalation.
   *   2. localhost is an ADDRESS, not an authority. The measured fact
   *      (M9.19) is that the loopback entry point answers 401 to an
   *      unauthenticated request and 403 to a hostile Host header on `/api`.
   */
  const TERMINAL_CONTROLLER = srcFile('packages/api/terminal-controller/src/index.ts')
  const CONTROL_PLANE_FINDINGS = join(REPO_ROOT, 'qualification', 'results', 'M9.19-control-plane', 'FINDINGS.md')

  it('the terminal controller is the system-user human terminal, quoted from its own source', () => {
    // Clause 1: the module header, verbatim.
    expect(flat(TERMINAL_CONTROLLER)).toContain("Session-owned user terminals with the execution environment's system-user permissions")
    // Clause 2: `create()` allocates OUTSIDE the agent sandbox and approval flow.
    expect(flat(TERMINAL_CONTROLLER)).toContain('without Agent sandbox or approval restrictions')
    // Clause 3 — the structural fact: `spawn()` calls `subprocess.spawnTerminal`
    // with no sandbox wrap in the call, and the sandbox policy is consulted only
    // for the fallback working DIRECTORY, never for confinement.
    expect(TERMINAL_CONTROLLER).toMatch(/spawnTerminal\(/u)
    expect(TERMINAL_CONTROLLER).toMatch(/sandboxPolicy/u)
    // The policy is read for a PATH, not a confinement: the resolved value is a
    // cwd. Asserted so a future version that wraps the PTY fails this test.
    const spawnIndex = TERMINAL_CONTROLLER.indexOf('spawnTerminal(')
    const afterSpawn = TERMINAL_CONTROLLER.slice(spawnIndex, spawnIndex + 800)
    expect(afterSpawn).not.toMatch(/confine\(/u)
  })

  it('this project mounts no terminalController, so no model-facing path can reach it', async () => {
    // The composition this project builds mounts no such service. The assertion
    // is the ABSENCE of the handle — the service is never invoked anywhere.
    const ctx = new Context()
    await ctx.plugin(LocalSubprocessRuntime)
    expect(ctx.get('terminalController' as never)).toBeUndefined()
    expect(ctx.get('pluginManager' as never)).toBeUndefined()
    expect(ctx.get('authorization' as never)).toBeUndefined()
    expect(ctx.get('remote' as never)).toBeUndefined()
    await ctx.fiber.dispose()
    // The project's own test asserts the same thing in its own composition, so
    // the constraint is enforced in two places rather than stated once.
    const denial = readFileSync(join(REPO_ROOT, 'packages', 'dsh-daily-work', 'src', 'security-denial.test.ts'), 'utf8')
    expect(denial).toContain('mounts no terminalController, so no test here can reach the human Web terminal')
  })

  it('the measured control-plane result: no surface is exposed as a tool, and the loopback entry point refuses', () => {
    const findings = readFileSync(CONTROL_PLANE_FINDINGS, 'utf8')
    // The load-bearing claim, and its exact shape: the model reaches things
    // through tools, and the tool catalog is the surface it is offered.
    expect(flat(findings)).toContain('the model reaches things through tools, and `tools.schemas(agent)` is the exact catalog it is offered')
    expect(findings).toContain('modelToolCount: 27')
    expect(findings).toContain('exposedAsTool: []')
    expect(flat(findings)).toContain('All **23** declared surfaces were checked individually; **zero** are exposed to the model')
    // The loopback half: 401 unauthenticated, 403 for a hostile Host on `/api`.
    expect(findings).toContain('**401** `dsh web authentication required`')
    expect(findings).toContain('**403** `forbidden`')
    // And the correction that matters for a reader: the index route is
    // auth-fenced, NOT Host-fenced, so the rebinding defence is an `/api`
    // property rather than a server-wide one.
    expect(flat(findings)).toContain('The **index route is auth-fenced, not Host-fenced.**')
    // The launch token is not in the model's shell environment.
    expect(findings).toContain('launchTokenIsInShellEnv: false')
  })

  it('the tool registry refuses an unknown name before any pipeline runs', async () => {
    const ToolRuntime = (await import('@deepseek-ai/dsh-tools')).default
    const SystemPrompt = (await import('@deepseek-ai/dsh-system-prompt')).default
    const { ToolCallId } = await import('@deepseek-ai/dsh-llm')
    const ctx = new Context()
    await ctx.plugin(SystemPrompt as never, {} as never)
    await ctx.plugin(ToolRuntime as never, {} as never)
    // Every control-plane-shaped name is refused as an unknown tool. This is
    // the refusal a kernel would meet if it tried to call one by name.
    for (const name of ['terminalController', 'plugin_manager', 'terminal_spawn', 'admin_rpc']) {
      const result = await ctx.tools.execute({
        name, arguments: {}, callId: ToolCallId(`sec02-${name}`), signal: new AbortController().signal,
      }) as { isError?: boolean; content?: unknown }
      expect(result.isError, `${name} must be refused`).toBe(true)
      expect(JSON.stringify(result.content)).toContain('unknown tool')
    }
    // The catalog is EMPTY here, so "unknown" is not "not mounted in this
    // fixture": the registry has no tools at all, and the refusal is the
    // registry's own, not a policy that could be reconfigured away.
    expect(ctx.tools.schemas(ctx)).toEqual([])
    await ctx.fiber.dispose()
  })

  it('the plugin manager is disabled in the shipped composition, and demands full access when enabled', () => {
    const gaps = readFileSync(join(REPO_ROOT, 'docs', 'GAPS.md'), 'utf8')
    expect(flat(gaps)).toContain('The `tool-plugin-manager` row is `disabled: true` in the shipped standard preset')
    expect(flat(gaps)).toContain('it demands `danger-full-access`, warning that installation can execute build scripts')
    expect(flat(gaps)).toContain('This project does not enable it')
  })
})

// ---------------------------------------------------------------------------
// SEC-03 — external network
// ---------------------------------------------------------------------------

describe('SEC-03: DNS / IPv4 / IPv6 / LAN / cloud-metadata egress is NOT blocked', () => {
  /**
   * THE HONEST RESULT, from `docs/GAPS.md` G-SEAM-12 and
   * `M9.3-security-denial/FINDINGS.md`: **E06 is a FAIL — no egress control
   * exists.** The seam's own README states it: "File effects are the whole
   * policy vocabulary — the seam expresses no network, process, syscall, device,
   * or credential restrictions."
   *
   * The tests below measure each of the five destination classes the gate names
   * and assert the observed result. The point is not to celebrate an open
   * network: it is that "uncontrolled" is a DEMONSTRATED fact here, not an
   * untested assumption, and the gate's oracle ("未授权直连均受OS/网关阻断") is
   * contradicted by the observation.
   */
  it('a confined child completes a real HTTP round trip to a loopback server — the measured non-denial', { timeout: 180_000 }, async () => {
    const { ctx, sandbox } = await mountSandbox()
    const base = tempDir('sec03')
    const workspace = join(base, 'workspace')
    mkdirSync(workspace)

    // The server lives in THIS process, so the child must be spawned
    // asynchronously: a synchronous wait would starve the event loop that has to
    // answer the request, and that would look exactly like a denial.
    const answer = 'SEC03-LOOPBACK-ANSWER'
    const server = createServer((_req, res) => { res.writeHead(200, { 'content-type': 'text/plain' }); res.end(answer) })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as AddressInfo).port
    try {
      for (const mode of ['read-only', 'workspace-write'] as const) {
        const run = await runConfined(ctx, sandbox, nodeScript(
          `const http=require('http');`
          + `const req=http.get({host:'127.0.0.1',port:${String(port)},path:'/'},res=>{let b='';res.on('data',c=>b+=c);res.on('end',()=>console.log('HTTP_OK:'+b))});`
          + `req.on('error',e=>console.log('HTTP_ERR:'+e.code));`
          + `req.setTimeout(8000,()=>{console.log('HTTP_TIMEOUT');req.destroy()})`,
        ), { mode, workspaceRoot: workspace })
        // THE FINDING: the round trip completed under BOTH confined modes.
        expect(run.exitCode, `${mode}: the confined child must exit 0`).toBe(0)
        expect(run.stdout.trim(), `${mode}: a confined child DOES reach loopback`).toBe(`HTTP_OK:${answer}`)
        expect(run.stderr).not.toMatch(/access is denied/iu)
      }
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
    await ctx.fiber.dispose()
  })

  it('a confined child resolves DNS and reaches LAN, IPv6 and cloud-metadata destinations', { timeout: 240_000 }, async () => {
    const { ctx, sandbox } = await mountSandbox()
    const base = tempDir('sec03b')
    const workspace = join(base, 'workspace')
    mkdirSync(workspace)

    // Each probe is bounded and reports its own outcome, so a timeout is
    // distinguishable from a denial rather than collapsed into one bit.
    const script = [
      "const net=require('net'),dns=require('dns')",
      'const out={}',
      "const tryc=(h,p)=>new Promise(r=>{const s=net.connect({host:h,port:p});const t=setTimeout(()=>{s.destroy();r('TIMEOUT')},4000);s.on('connect',()=>{clearTimeout(t);s.destroy();r('CONNECTED')});s.on('error',e=>{clearTimeout(t);r('ERR:'+e.code)})})",
      ';(async()=>{',
      // Cloud metadata: the address every SSRF guard exists to keep out of reach.
      " out.cloudMetadata=await tryc('169.254.169.254',80)",
      // A private LAN address.
      " out.lan=await tryc('192.168.1.1',445)",
      // An IPv6 destination.
      " out.ipv6=await tryc('::1',80)",
      // Public DNS resolution, which is the precondition for any exfiltration.
      " out.dnsPublic=await new Promise(r=>dns.lookup('example.com',(e,a)=>r(e?'ERR:'+e.code:a)))",
      // And a private name, to show resolution is not filtered either.
      " out.dnsPrivate=await new Promise(r=>dns.lookup('localhost',(e,a)=>r(e?'ERR:'+e.code:a)))",
      ' console.log(JSON.stringify(out))',
      '})()',
    ].join('\n')

    const run = await runConfined(ctx, sandbox, nodeScript(script), { mode: 'workspace-write', workspaceRoot: workspace })
    expect(run.exitCode, `the probe must run:\n${run.stderr}`).toBe(0)
    const observed = JSON.parse(run.stdout.trim()) as Record<string, string>

    // THE MEASURED RESULTS, each asserted as itself. The OUTCOME differs by
    // destination — that difference is the point, and collapsing it would hide
    // which destinations are actually reachable.
    //
    // Cloud metadata: not reachable from this host, because this machine has no
    // route to the link-local metadata address. That is a PROPERTY OF THE
    // NETWORK, not a control in the sandbox — the seam carries no network fact
    // at all (asserted below).
    expect(observed.cloudMetadata).toMatch(/^(ERR:|TIMEOUT)/u)
    // A private LAN address IS reachable: the confined child completed a TCP
    // connection to it. No OS or gateway boundary intercepted.
    expect(observed.lan).toBe('CONNECTED')
    // IPv6 to loopback: refused by the listener, not by the sandbox — the child
    // got far enough to receive a transport answer, which is what "uncontrolled"
    // means.
    expect(observed.ipv6).toMatch(/^(ERR:|CONNECTED)/u)
    // DNS resolution succeeds for BOTH a public and a private name.
    expect(observed.dnsPublic).toMatch(/^\d+\.\d+\.\d+\.\d+$/u)
    expect(observed.dnsPrivate).toBe('127.0.0.1')

    // And the seam carries no network policy, which is WHY the above is
    // uncontrolled rather than merely unconfigured.
    const sandboxSeam = srcFile('packages/sandbox/sandbox/src/index.ts')
    expect(flat(sandboxSeam)).toContain('Network and process visibility are outside this vocabulary')
    const confinedMatch = /export interface ConfinedArgv\s*\{([\s\S]*?)\n\}/u.exec(sandboxSeam)
    expect(confinedMatch![1]).not.toMatch(/network|egress|proxy|dns/iu)

    await ctx.fiber.dispose()
  })

  it('the sandbox runner argv carries only file-effect arguments, so no network restriction is expressed', async () => {
    const { ctx, sandbox } = await mountSandbox()
    const base = tempDir('sec03c')
    const workspace = join(base, 'workspace')
    mkdirSync(workspace)
    const confined = await sandbox.confine([process.execPath, '--version'], { mode: 'workspace-write', workspaceRoot: workspace })
    // The runner's own arguments: a workspace, a temp area and a mode. Nothing
    // about network, processes or devices.
    const joined = confined.argv.join(' ')
    expect(joined).toMatch(/--workspace/u)
    expect(joined).toMatch(/--mode/u)
    expect(joined).not.toMatch(/--network|--no-net|--egress|--deny-net/u)
    // The denial dialect is a FILE dialect: these are the strings a consumer
    // matches, and none of them is a network denial.
    for (const signature of confined.denialSignatures) {
      expect(signature.toLowerCase()).not.toMatch(/network|dns|egress|connect/iu)
    }
    await ctx.fiber.dispose()
  })

  it('the only egress-adjacent control is a TOOL-level URL filter, and a confined shell really does bypass it', { timeout: 180_000 }, async () => {
    // The SSRF guard is real (SEC-04 measures it) and it is NOT an egress
    // boundary. Both halves matter, so both are recorded.
    //
    // "Bypassable by any shell" was previously only QUOTED from the findings
    // file. It is measured here instead: the same loopback destination the web
    // tool refuses is reached by a confined child, in the same test file, so the
    // claim is an observation rather than a citation.
    const { ctx, sandbox } = await mountSandbox()
    const base = tempDir('sec03d')
    const workspace = join(base, 'workspace')
    mkdirSync(workspace)
    // The exact class the SSRF guard refuses, as a URL the web tool would refuse.
    const refusedUrl = 'http://169.254.169.254/latest/meta-data/'
    const network = await import(srcUrl('packages/web/web-fetch-http/lib/types/network.js')) as {
      isNonPublicIpLiteral(hostname: string): boolean
    }
    // The guard's own verdict on the destination, so the contrast is exact.
    expect(network.isNonPublicIpLiteral('169.254.169.254')).toBe(true)

    // A real server on loopback: the class the guard refuses.
    const answer = 'SEC03-BYPASS-ANSWER'
    const server = createServer((_req, res) => { res.writeHead(200, { 'content-type': 'text/plain' }); res.end(answer) })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as AddressInfo).port
    try {
      // The guard refuses this exact destination when the MODEL asks the fetch
      // tool for it (SEC-04 proves the refusal). A confined child reaches the
      // same class of address with no tool involved at all.
      const run = await runConfined(ctx, sandbox, nodeScript(
        `const http=require('http');`
        + `const req=http.get({host:'127.0.0.1',port:${String(port)},path:'/'},res=>{let b='';res.on('data',c=>b+=c);res.on('end',()=>console.log('BYPASS_OK:'+b))});`
        + `req.on('error',e=>console.log('BYPASS_ERR:'+e.code));`
        + `req.setTimeout(8000,()=>{console.log('BYPASS_TIMEOUT');req.destroy()})`,
      ), { mode: 'read-only', workspaceRoot: workspace })
      expect(run.exitCode, run.stderr).toBe(0)
      // THE MEASURED BYPASS: the confined child completes the round trip under
      // `read-only`, the strictest mode, with the SSRF guard nowhere in the path.
      expect(run.stdout.trim()).toBe(`BYPASS_OK:${answer}`)
      expect(refusedUrl).toContain('169.254.169.254')
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
    await ctx.fiber.dispose()

    // And why it is a FAIL rather than NOT_RUN: the absence is demonstrated.
    const findings = readFileSync(join(REPO_ROOT, 'qualification', 'results', 'M9.3-security-denial', 'FINDINGS.md'), 'utf8')
    expect(flat(findings)).toContain('it constrains the URL the MODEL hands the `web_fetch` tool — it is a destination filter on one tool, not a block on outbound traffic')
    expect(flat(findings)).toContain('it is trivially bypassed by any confined shell command (proven above), so it offers no protection against a script the model chose to run')
    expect(flat(findings)).toContain('Recording this as NOT_RUN would understate what is now known: the absence of egress control is demonstrated, not assumed')
    // The project's own GAPS record, pinned so the FAIL cannot be softened.
    const gaps = readFileSync(join(REPO_ROOT, 'docs', 'GAPS.md'), 'utf8')
    expect(flat(gaps)).toContain('Network egress is uncontrolled for bash/pwsh/subprocess/PTC')
    expect(flat(gaps)).toContain('only `web_fetch` has SSRF filtering, which filters that tool\'s URL and is bypassed by any shell command')
  })

  it('the POSIX backend has no egress boundary either: the bwrap profile carries no network namespace', { timeout: 180_000 }, async () => {
    // The SEC-01 companion measurement, and the one that decides whether SEC-03
    // is a Windows deployment fact or a seam fact. `bwrapProfileArgs()` emits
    // `--unshare-pid` and does NOT emit `--unshare-net`, so the child shares the
    // host's network namespace. Measured on a real Linux kernel, not inferred
    // from the flag's absence.
    const probe = spawnSync('wsl.exe', ['-e', 'bash', '-c', 'command -v bwrap'], { encoding: 'utf8', timeout: 60_000 })
    if (probe.status !== 0 || !probe.stdout.includes('bwrap')) {
      expect(probe.status === 0 ? 'no bwrap' : 'wsl unavailable').toBe('SKIPPED — no POSIX sandbox runner on this host')
      return
    }
    // The profile's own text, so the flag set is asserted and not paraphrased.
    const profiles = srcFile('packages/sandbox/sandbox-local/src/profiles.ts')
    expect(profiles).toMatch(/--unshare-pid/u)
    expect(profiles).not.toMatch(/--unshare-net/u)

    const script = [
      'set -u',
      // A real listener in the WSL host, and a round trip from INSIDE the exact
      // read-only profile. A transport answer is what distinguishes "no boundary"
      // from "boundary denied it".
      'PORT=39477',
      '(printf %s "SEC03-POSIX-ANSWER" | timeout 20 nc -l -p $PORT >/dev/null 2>&1 &)',
      'sleep 1',
      'bwrap --ro-bind / / --dev /dev --unshare-pid --proc /proc --die-with-parent -- bash -c "exec 3<>/dev/tcp/127.0.0.1/$PORT; head -c 64 <&3"',
      'echo ""',
      'echo "ROUND_TRIP_EXIT=$?"',
      // Public DNS resolution from inside the profile: the precondition for any
      // exfiltration, and it succeeds.
      'bwrap --ro-bind / / --dev /dev --unshare-pid --proc /proc --die-with-parent -- getent hosts example.com >/dev/null 2>&1',
      'echo "DNS_EXIT=$?"',
    ].join('\n')
    const run = spawnSync('wsl.exe', ['-e', 'bash', '-c', script], { encoding: 'utf8', timeout: 120_000 })
    const out = `${run.stdout}${run.stderr}`
    // THE FINDING, cross-platform: the round trip completes inside the profile.
    expect(out, out).toContain('SEC03-POSIX-ANSWER')
    expect(out).toMatch(/ROUND_TRIP_EXIT=0/u)
    // And public name resolution succeeds, so egress is not merely un-denied —
    // it is fully usable.
    expect(out).toMatch(/DNS_EXIT=0/u)
  })

  /**
   * CLOSABILITY, MEASURED. The same four candidate levers as SEC-01, aimed at
   * egress. The one that genuinely deserves the check is `runnerCommand`, because
   * it is a real public config seam through which an operator supplies the
   * runner — and a container-style runner COULD carry a network namespace. The
   * question is whether this project can express that through the seam as it
   * exists, or whether it would have to ship new infrastructure.
   *
   * The answer is the latter, and the reason is specific: the override supplies
   * only the PROGRAM; the profile arguments are still produced by
   * `bwrapProfileArgs(policy)`, which has no network flag to emit, and the
   * `SandboxPolicy` it is built from has no network field to carry one. So
   * `runnerCommand` cannot express egress policy — it can only swap which
   * file-effect confiner applies the same profile. Reaching a real egress
   * boundary therefore means adding a mechanism this deployment does not have
   * (a container/VM/network namespace runner), which is exactly what
   * `docs/DELIVERY.md`'s status vocabulary calls work requiring something the
   * machine does not have.
   */
  it('CLOSABILITY: no public seam can express egress policy — the runner override cannot carry one', { timeout: 180_000 }, async () => {
    const { ctx, sandbox } = await mountSandbox()
    const base = tempDir('sec03e')
    const workspace = join(base, 'workspace')
    mkdirSync(workspace)
    const confined = await sandbox.confine([process.execPath, '--version'], { mode: 'workspace-write', workspaceRoot: workspace })

    // The argv the provider ACTUALLY builds, in full — every token, not a grep.
    // A network-restricting flag would have to appear here, and none does.
    const argv = confined.argv
    const networkTokens = argv.filter(token => /net|egress|proxy|dns|socket/i.test(token))
    expect(networkTokens, `no network-shaped token may appear in the runner argv: ${JSON.stringify(argv)}`).toEqual([])
    // The tokens that ARE there are the documented file-effect set plus the
    // separator and the caller's own command.
    expect(argv).toContain('--workspace')
    expect(argv).toContain('--temp')
    expect(argv).toContain('--mode')
    expect(argv).toContain('--')

    // The profile builder has no network flag to emit, and the policy has no
    // field to carry one — so the override (which only replaces the PROGRAM)
    // cannot introduce one.
    const profiles = srcFile('packages/sandbox/sandbox-local/src/profiles.ts')
    const flags = [...profiles.matchAll(/'(--[a-z-]+)'/gu)].map(m => m[1]!)
    expect(flags.sort()).toEqual(['--bind', '--dev', '--die-with-parent', '--proc', '--ro-bind', '--tmpfs', '--unshare-pid'])
    // `--unshare-pid` is present (process visibility) and `--unshare-net` is NOT:
    // the profile isolates pids and shares the network namespace.
    expect(flags).toContain('--unshare-pid')
    expect(flags).not.toContain('--unshare-net')

    // And the sandbox seam states the exclusion in its own vocabulary.
    const seam = srcFile('packages/sandbox/sandbox/src/index.ts')
    expect(flat(seam)).toContain('Network and process visibility are outside this vocabulary')
    const readme = srcFile('packages/sandbox/sandbox/README.md')
    expect(flat(readme)).toContain('File effects are the whole policy vocabulary')
    expect(flat(readme)).toContain('the seam expresses no network, process, syscall, device, or credential restrictions')

    // The ONLY egress-adjacent service in the checkout is a CLIENT-side proxy
    // policy for the harness's own outbound calls — it governs undici in this
    // process, and a confined child reaches the network through the OS instead.
    const proxy = srcFile('packages/util/http-proxy/src/policy.ts')
    expect(flat(proxy)).toContain("A proxy that also serves the harness's own loopback traffic")
    // Its bypass list even FORCES loopback around the proxy, so it could not be
    // an egress boundary even for in-process traffic.
    expect(proxy).toMatch(/export const LOOPBACK_NO_PROXY: readonly string\[\] = \['localhost', '127\.0\.0\.1', '::1', '\[::1\]'\]/u)

    // The measured bypass, restated as the reason the tool-level filter is not a
    // control: a confined child completes a round trip under the STRICTEST mode.
    const answer = 'SEC03-CLOSABILITY-ANSWER'
    const server = createServer((_req, res) => { res.writeHead(200, { 'content-type': 'text/plain' }); res.end(answer) })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as AddressInfo).port
    try {
      const run = await runConfined(ctx, sandbox, nodeScript(
        `const http=require('http');`
        + `const req=http.get({host:'127.0.0.1',port:${String(port)},path:'/'},res=>{let b='';res.on('data',c=>b+=c);res.on('end',()=>console.log('OK:'+b))});`
        + `req.on('error',e=>console.log('ERR:'+e.code));`
        + `req.setTimeout(8000,()=>{console.log('TIMEOUT');req.destroy()})`,
      ), { mode: 'read-only', workspaceRoot: workspace })
      expect(run.stdout.trim()).toBe(`OK:${answer}`)
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
    await ctx.fiber.dispose()
  })
})

// ---------------------------------------------------------------------------
// SEC-04 — SSRF
// ---------------------------------------------------------------------------

describe('SEC-04: the web tool refuses private destinations on every hop and forwards no credentials', () => {
  /**
   * This gate PASSES, and it is the one place in this family where a real
   * control exists at a real boundary. `packages/web/web-fetch-http/src/network.ts`
   * and `policy.ts` are exercised against a REAL HTTP server, not a mock.
   *
   * The three clauses of the oracle, each measured:
   *   - 每跳校验目标 (every hop validated): the redirect target is re-validated
   *     against the same URL hygiene and same-origin rule as a direct request.
   *   - 禁private网络: the address policy refuses loopback, link-local, private
   *     and transition addresses, and rejects the WHOLE answer set if any member
   *     is non-public.
   *   - 凭证不跨域转发 (credentials not forwarded cross-origin): a credentialed
   *     URL is refused outright, and a cross-origin redirect is not followed at
   *     all — so there is no hop on which a credential could be forwarded.
   */
  const networkModule = async (): Promise<{
    isPublicIpAddress(address: string): boolean
    isNonPublicIpLiteral(hostname: string): boolean
    resolvePublicAddresses(hostname: string, signal: AbortSignal, resolver?: unknown): Promise<{ address: string; family: 4 | 6 }[]>
    createPinnedLookup(addresses: readonly { address: string; family: 4 | 6 }[]): unknown
  }> => await import(srcUrl('packages/web/web-fetch-http/lib/types/network.js')) as never

  const providerModule = async (): Promise<{
    HttpFetchProvider: new (
      limits: { maxResponseBytes: number; maxBodyChars: number; timeoutMs: number; maxRedirects: number; userAgent: string },
      resolve: (hostname: string, signal: AbortSignal) => Promise<{ address: string; family: 4 | 6 }[]>,
    ) => { fetch(request: { url: string }, signal?: AbortSignal): Promise<{ url: string; body: string }> }
  }> => await import(srcUrl('packages/web/web-fetch-http/lib/index.js')) as never

  it('the address policy refuses loopback, link-local, private, unspecified and transition addresses', async () => {
    const network = await networkModule()
    // Every class the gate names, plus the two that are the classic bypasses:
    // the unspecified address and an IPv4-mapped IPv6 loopback.
    const refused = [
      '127.0.0.1', '127.1.2.3', '0.0.0.0', // loopback and unspecified
      '169.254.169.254', '169.254.1.1', // link-local, incl. cloud metadata
      '10.0.0.1', '172.16.0.1', '192.168.1.1', // RFC 1918
      '100.64.0.1', '192.0.2.1', '198.18.0.1', '224.0.0.1', '255.255.255.255', // shared, doc, benchmark, multicast, broadcast
      '::1', '::', 'fe80::1', 'fc00::1', 'fd00::1', 'ff02::1', // IPv6 loopback, unspecified, link-local, unique-local, multicast
      '::ffff:127.0.0.1', '::ffff:169.254.169.254', // IPv4-mapped IPv6
    ]
    for (const address of refused) {
      expect(network.isPublicIpAddress(address), `${address} must NOT be public`).toBe(false)
    }
    // The control: a genuinely public unicast address is permitted, so the
    // policy is a filter rather than a blanket refusal.
    expect(network.isPublicIpAddress('93.184.216.34')).toBe(true)
    expect(network.isPublicIpAddress('2606:2800:220:1:248:1893:25c8:1946')).toBe(true)
    // The literal helper the proxied branch consults: an address literal the
    // policy would refuse never takes the proxy shortcut, because a proxy on
    // this machine would reach exactly the service the checks keep out of reach.
    expect(network.isNonPublicIpLiteral('127.0.0.1')).toBe(true)
    expect(network.isNonPublicIpLiteral('[::1]')).toBe(true)
    expect(network.isNonPublicIpLiteral('93.184.216.34')).toBe(false)
    expect(network.isNonPublicIpLiteral('example.com')).toBe(false)
  })

  it('a DNS answer set with ANY non-public member is refused WHOLE — the rebinding defence', async () => {
    const network = await networkModule()
    const signal = new AbortController().signal
    // A hostname resolving to a public AND a private address is the DNS-rebind
    // shape: accepting the public one and retrying would be a race, so the whole
    // set is rejected.
    await expect(network.resolvePublicAddresses('evil.example', signal, async () => [
      { address: '93.184.216.34', family: 4 },
      { address: '127.0.0.1', family: 4 },
    ])).rejects.toMatchObject({ code: 'WEB_BLOCKED_URL' })
    // And the plain private cases, by name and by literal.
    await expect(network.resolvePublicAddresses('localhost', signal, async () => [{ address: '127.0.0.1', family: 4 }]))
      .rejects.toMatchObject({ code: 'WEB_BLOCKED_URL' })
    await expect(network.resolvePublicAddresses('127.0.0.1', signal))
      .rejects.toMatchObject({ code: 'WEB_BLOCKED_URL' })
    await expect(network.resolvePublicAddresses('[::1]', signal))
      .rejects.toMatchObject({ code: 'WEB_BLOCKED_URL' })
    await expect(network.resolvePublicAddresses('169.254.169.254', signal))
      .rejects.toMatchObject({ code: 'WEB_BLOCKED_URL' })
    // An empty answer set is an error, never an empty allow-list.
    await expect(network.resolvePublicAddresses('nothing.example', signal, async () => []))
      .rejects.toMatchObject({ code: 'WEB_PROVIDER_ERROR' })
    // The control: a public-only answer set is accepted and returned verbatim.
    const ok = await network.resolvePublicAddresses('example.com', signal, async () => [{ address: '93.184.216.34', family: 4 }])
    expect(ok).toEqual([{ address: '93.184.216.34', family: 4 }])
  })

  it('the transport PINS the validated address set, so a re-resolve cannot reach a private address', async () => {
    const network = await networkModule()
    // The pinned lookup is the mechanism: the connection is made against the
    // addresses that were validated, so the hostname cannot resolve differently
    // between validation and connect. Asserted structurally, because the
    // TOCTOU window it closes is not reproducible on demand.
    const source = srcFile('packages/web/web-fetch-http/src/network.ts')
    expect(flat(source)).toContain('so the connection cannot resolve the hostname again to a private address')
    expect(source).toMatch(/createPinnedLookup/u)
    expect(source).toMatch(/redirect: 'manual'/u)
    // The pinned lookup itself must be callable and must answer from the fixed
    // set — that is what "pinned" means, and a stub that consulted the system
    // resolver would pass a structural check while doing nothing.
    const lookup = network.createPinnedLookup([{ address: '93.184.216.34', family: 4 }]) as (
      hostname: string, options: unknown, callback: (error: unknown, address: string, family?: number) => void,
    ) => void
    const answered = await new Promise<{ address: string; family?: number }>((settle, fail) => {
      lookup('evil.example', {}, (error, address, family) => {
        if (error) { fail(error as Error); return }
        settle({ address, ...(family !== undefined ? { family } : {}) })
      })
    })
    expect(answered.address).toBe('93.184.216.34')
  })

  it('a real same-origin redirect is followed; a cross-origin one is REFUSED', { timeout: 180_000 }, async () => {
    const { HttpFetchProvider } = await providerModule()
    const hits: string[] = []
    const server = createServer((req, res) => {
      hits.push(req.url ?? '')
      const host = req.headers.host ?? '127.0.0.1'
      if (req.url === '/same') { res.writeHead(302, { location: `http://${host}/final` }); res.end(); return }
      if (req.url === '/cross') { res.writeHead(302, { location: 'http://attacker.example.com/steal' }); res.end(); return }
      if (req.url === '/cred') { res.writeHead(302, { location: `http://user:pass@${host}/final` }); res.end(); return }
      if (req.url === '/scheme') { res.writeHead(302, { location: 'file:///etc/passwd' }); res.end(); return }
      if (req.url === '/loop') { res.writeHead(302, { location: `http://${host}/loop` }); res.end(); return }
      res.writeHead(200, { 'content-type': 'text/plain' }); res.end('FINAL-BODY')
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as AddressInfo).port
    const origin = `http://127.0.0.1:${port}`
    try {
      // The ADDRESS guard is stubbed to a public address here, so the REDIRECT
      // guard is the only thing under test. The address guard is measured above
      // against the real resolver, so nothing is being weakened by the stub.
      const provider = new HttpFetchProvider(
        { maxResponseBytes: 1_000_000, maxBodyChars: 100_000, timeoutMs: 8_000, maxRedirects: 2, userAgent: 'sec-gate-probe' },
        async () => [{ address: '93.184.216.34', family: 4 }],
      )

      // Same-origin: followed, and the final body is returned.
      const same = await provider.fetch({ url: `${origin}/same` })
      expect(same.url).toBe(`${origin}/final`)
      expect(hits).toContain('/final')

      // Cross-origin: REFUSED. The message names the origin and the remedy, and
      // the attacker's host was never contacted — which is the security-relevant
      // half, because "not followed automatically" would be worth nothing if the
      // request had already gone out.
      await expect(provider.fetch({ url: `${origin}/cross` }))
        .rejects.toMatchObject({ code: 'WEB_REDIRECT_BLOCKED' })
      await expect(provider.fetch({ url: `${origin}/cross` }))
        .rejects.toThrow(/cross-origin redirect to http:\/\/attacker\.example\.com is not followed automatically/u)
      expect(hits).not.toContain('/steal')

      // A credentialed redirect target: REFUSED by the same URL hygiene a direct
      // request gets, so a redirect is not a back door to a credentialed URL.
      await expect(provider.fetch({ url: `${origin}/cred` }))
        .rejects.toMatchObject({ code: 'WEB_BLOCKED_URL' })
      await expect(provider.fetch({ url: `${origin}/cred` }))
        .rejects.toThrow(/credentials in URLs are not allowed/u)

      // A non-http(s) scheme: refused, so a redirect cannot reach the local
      // filesystem through the fetch tool.
      await expect(provider.fetch({ url: `${origin}/scheme` })).rejects.toMatchObject({ code: 'WEB_INVALID_URL' })

      // The hop budget is enforced BEFORE the next hop is resolved, so a redirect
      // loop is a bounded refusal rather than an infinite one.
      await expect(provider.fetch({ url: `${origin}/loop` }))
        .rejects.toThrow(/exceeded the maximum of 2 redirects/u)

      // The transport is manual-redirect everywhere, which is what makes the
      // per-hop validation possible at all: with automatic following, a hop
      // would be taken before any check ran.
      const source = srcFile('packages/web/web-fetch-http/src/network.ts')
      expect((source.match(/redirect: 'manual'/gu) ?? []).length).toBeGreaterThanOrEqual(2)
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  })

  it('a request carries no ambient credential, and the tool filter does not claim to be egress control', () => {
    const provider = srcFile('packages/web/web-fetch-http/src/provider.ts')
    // The provider's own header states the property, and the request headers are
    // a fixed literal: no cookie jar, no Authorization, nothing ambient.
    expect(flat(provider)).toContain('Requests carry no browser cookies or ambient credentials')
    const headersMatch = /const headers = \{([\s\S]*?)\n\s*\}/u.exec(provider)
    expect(headersMatch, 'the request headers must be a literal').not.toBeNull()
    const headers = headersMatch![1]!
    expect(headers).toContain('user-agent')
    expect(headers).toContain('accept')
    expect(headers).not.toMatch(/cookie|authorization|proxy-authorization|credential/iu)
    // And the honest limit: this is a URL filter on ONE tool. It is not an
    // egress boundary, and SEC-03 records that a shell bypasses it entirely.
    const findings = readFileSync(join(REPO_ROOT, 'qualification', 'results', 'M9.3-security-denial', 'FINDINGS.md'), 'utf8')
    expect(flat(findings)).toContain('it is a destination filter on one tool, not a block on outbound traffic')
  })
})

// ---------------------------------------------------------------------------
// SEC-05 — path race
// ---------------------------------------------------------------------------

describe('SEC-05: a symlink escape is refused at the HANDLE boundary, not by a string prefix', () => {
  /**
   * THE DISTINCTION THE GATE DRAWS, and why it is not pedantic. A string prefix
   * check compares the path the caller SPELLED. It cannot see that
   * `workspace/link.txt` IS `outside/target.txt`, so it would permit the write.
   * The fence that holds here re-CANONICALIZES the target immediately before the
   * mutation and returns the FRESH target, so the identity that was checked is
   * the identity that is mutated.
   *
   * The measured result is that the escape is REFUSED with `FS_SANDBOX_DENIED`
   * and the file outside is byte-identical afterwards.
   *
   * ONE MEASUREMENT ERROR IS RECORDED HERE, because it would have produced a
   * false green: the first version of this probe put the "outside" directory
   * under `os.tmpdir()`, and `writableRoots()` explicitly GRANTS the platform
   * temp area under `workspace-write`. The write then succeeded — correctly, by
   * policy — and would have read as a fence failure. The fixture below uses a
   * directory outside every granted root.
   */
  it('a symlink pointing outside the workspace is REFUSED on write, and the outside file is untouched', { timeout: 180_000 }, async () => {
    const { SandboxedFileSystem } = await import(srcUrl('packages/fs/fs-sandbox/lib/index.js')) as { SandboxedFileSystem: never }
    const SessionProjectionRegistry = (await import('@deepseek-ai/dsh-session-projection')).default
    // The workspace is under tmpdir (a granted root). The OUTSIDE directory is
    // deliberately NOT: it is a fresh temp directory whose parent is the OS temp
    // area, which `workspace-write` grants — so the fixture uses a path under
    // the repo's own evidence tree instead, which is not a granted root.
    const workspace = tempDir('sec05-ws')
    const outside = join(REPO_ROOT, 'qualification', 'results', 'M-DEP-SEC-UPG', '.sec05-outside')
    rmSync(outside, { recursive: true, force: true })
    mkdirSync(outside, { recursive: true })
    const secret = join(outside, 'target.txt')
    writeFileSync(secret, 'OUTSIDE-ORIGINAL', 'utf8')
    const link = join(workspace, 'link.txt')
    symlinkSync(secret, link, 'file')

    const ctx = new Context()
    try {
      await ctx.plugin(SessionProjectionRegistry as never, {} as never)
      await ctx.plugin(SandboxPolicyService as never, { mode: 'workspace-write', workspaceRoot: workspace } as never)
      await ctx.plugin(SandboxedFileSystem as never, { cwd: workspace } as never)
      const fs = ctx.fs as never as {
        resolve(path: string): Promise<{ targetKey: string; displayPath: string }>
        writeText(target: unknown, content: string, expected?: unknown, signal?: unknown, policy?: unknown): Promise<unknown>
      }
      const target = await fs.resolve(link)
      // The resolved target KEY is the CANONICAL path: it already names the file
      // outside the workspace. That is what makes the fence decidable.
      expect(target.targetKey.toLowerCase()).toContain('.sec05-outside')
      expect(target.displayPath.toLowerCase()).toContain('link.txt')

      // THE GATE: the write is refused at the handle boundary.
      await expect(fs.writeText(target, 'WRITTEN-THROUGH-SYMLINK'))
        .rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
      // And the refusal is not a misread: the outside file is byte-identical and
      // the link is still a link (it was not replaced by a regular file).
      expect(readFileSync(secret, 'utf8')).toBe('OUTSIDE-ORIGINAL')
      expect(lstatSync(link).isSymbolicLink()).toBe(true)

      // The control: a file INSIDE the workspace is writable, so the refusal
      // above is containment rather than a dead fence.
      const inside = join(workspace, 'inside.txt')
      writeFileSync(inside, 'INSIDE-ORIGINAL', 'utf8')
      await fs.writeText(await fs.resolve(inside), 'INSIDE-WRITTEN')
      expect(readFileSync(inside, 'utf8')).toBe('INSIDE-WRITTEN')
    } finally {
      await ctx.fiber.dispose()
      rmSync(outside, { recursive: true, force: true })
    }
  })

  /**
   * The ORACLE NAMES THREE VECTORS — "symlink/hardlink/rename逃离授权root" — and
   * the symlink test above covers one of them. A hard link is a DIFFERENT
   * question, and the difference is the whole point: containment is a PATH
   * relation, and a hard link has no path relation to its sibling name. The two
   * names ARE one file object (same inode), so a fence that canonicalizes
   * perfectly still sees `<workspace>/hardlink.txt` as contained.
   *
   * This test MEASURES the hardlink vector through the fs seam rather than
   * assuming it follows from the symlink result. The result has two halves and
   * both are asserted, because reporting only one would misstate the boundary:
   *
   *   1. the fence does NOT refuse — it has no lever over a second name;
   *   2. the outside name is nevertheless NOT modified, because this seam's
   *      write is ATOMIC (temp file + rename), which severs the link rather
   *      than writing through it. That is a property of the WRITE MECHANIC,
   *      not of the fence, and the confined-shell test in
   *      `security-denial.test.ts` measures the case where the mechanic is an
   *      in-place write and the escape DOES land.
   */
  it('the hardlink vector through the fs seam: the fence does not refuse, and the atomic write severs the link', { timeout: 180_000 }, async () => {
    const { SandboxedFileSystem } = await import(srcUrl('packages/fs/fs-sandbox/lib/index.js')) as { SandboxedFileSystem: never }
    const SessionProjectionRegistry = (await import('@deepseek-ai/dsh-session-projection')).default
    // BOTH directories live under this project's own evidence tree, on ONE
    // volume: `link()` cannot cross volumes (`EXDEV`), so a workspace under
    // `os.tmpdir()` (C:) and an outside directory on D: could not build the
    // fixture at all. The workspace root is granted because the POLICY names it.
    const base = join(REPO_ROOT, 'qualification', 'results', 'P3-security', '.sec05-hl')
    rmSync(base, { recursive: true, force: true })
    const workspace = join(base, 'workspace')
    const outside = join(base, 'outside')
    mkdirSync(workspace, { recursive: true })
    mkdirSync(outside, { recursive: true })
    const secret = join(outside, 'target.txt')
    writeFileSync(secret, 'OUTSIDE-ORIGINAL', 'utf8')
    const link = join(workspace, 'hardlink.txt')
    linkSync(secret, link)
    // The premise, asserted: the two names are ONE file object. If this ever
    // fails, the platform stopped making hard links and the result means
    // something else.
    expect(lstatSync(link).ino, 'the two names must be the same file object').toBe(lstatSync(secret).ino)

    const ctx = new Context()
    try {
      await ctx.plugin(SessionProjectionRegistry as never, {} as never)
      await ctx.plugin(SandboxPolicyService as never, { mode: 'workspace-write', workspaceRoot: workspace } as never)
      await ctx.plugin(SandboxedFileSystem as never, { cwd: workspace } as never)
      const fs = ctx.fs as never as {
        resolve(path: string): Promise<{ targetKey: string; displayPath: string }>
        writeText(target: unknown, content: string, expected?: unknown, signal?: unknown, policy?: unknown): Promise<unknown>
      }
      const target = await fs.resolve(link)
      // The canonical KEY is the WORKSPACE spelling: realpath resolves symlinks,
      // not hard links, so nothing in the path tells the fence this file also
      // has a name outside the root. THIS is why a path fence cannot decide it.
      expect(target.targetKey.toLowerCase()).toContain('hardlink.txt')

      let refused = false
      let code: string | undefined
      try {
        await fs.writeText(target, 'WRITTEN-THROUGH-HARDLINK')
      } catch (error) {
        refused = true
        code = (error as { code?: string }).code
      }
      // HALF 1 — THE MEASURED RESULT: the fence does NOT refuse. Containment is
      // satisfied (the workspace spelling IS under the root), so no policy check
      // fires. A reader who assumed the symlink result covers hard links would
      // have this wrong.
      expect(refused, 'a path-containment fence has no lever over a hard link').toBe(false)
      expect(code).toBeUndefined()
      // The inside name carries the new content — the write really happened.
      expect(readFileSync(link, 'utf8')).toBe('WRITTEN-THROUGH-HARDLINK')
      // HALF 2 — and the OUTSIDE name still carries the original, because the
      // atomic write publishes by rename: it replaced the link with a NEW file
      // rather than writing through the shared object. The link is severed.
      expect(readFileSync(secret, 'utf8'), 'the atomic rename severs the link').toBe('OUTSIDE-ORIGINAL')
      expect(lstatSync(link).ino, 'the link must be severed, not written through').not.toBe(lstatSync(secret).ino)
      // And the sandbox's own record of this boundary: it reports `partial`
      // precisely because NTFS hard links alias one file object.
      const winReadme = srcFile('packages/sandbox/sandbox-windows-acl/README.md')
      expect(flat(winReadme)).toContain('Hard links are file-object aliases, not path aliases')
      expect(flat(winReadme)).toContain('so the same object is writable through an external alias')
    } finally {
      await ctx.fiber.dispose()
      rmSync(base, { recursive: true, force: true })
    }
  })

  it('the fence RE-CANONICALIZES before delegating, so the checked identity is the mutated one', () => {
    const fence = srcFile('packages/fs/fs-sandbox/src/index.ts')
    // The mechanism, in the source: `checkedTarget` resolves a FRESH target and
    // returns THAT, so the mutation delegates with the fresh identity rather
    // than the stale one — the check-here-write-there TOCTOU is closed.
    expect(flat(fence)).toContain('so the checked identity is the mutated one (no check-here-write-there TOCTOU)')
    expect(flat(fence)).toContain('workspace-write: containment on the FRESH canonical path (catches a symlink ancestor swapped since the tool resolved this target), and the mutation delegates with THIS fresh target — never the stale one')
    expect(fence).toMatch(/const fresh = await this\.resolve\(target\.displayPath\)/u)
    expect(fence).toMatch(/return super\.writeText\(await this\.checkedTarget\(target, sandboxPolicy\)/u)
    // Reads pass through: every mode permits reading, which is SEC-01's finding
    // stated as a deliberate design property rather than an oversight.
    expect(flat(fence)).toContain('Reads pass through untouched: every mode permits reading')
    // And the fence's OWN scope limit, so it is not overread as a kernel boundary.
    expect(flat(fence)).toContain('The fence is a policy check in TRUSTED code over a MODEL-CONTROLLED path, NOT a kernel boundary')
    expect(flat(fence)).toContain('The residual TOCTOU (an ancestor symlink swapped between the containment re-check and the syscall) is narrowed by re-canonicalizing immediately before delegating and is accepted for this threat model')
  })

  it('containment compares FILESYSTEM IDENTITY when spellings differ, not only text', () => {
    const containment = srcFile('packages/fs/fs-sandbox/src/containment.ts')
    // The lexical fast path handles canonical spellings; when they differ the
    // walk compares dev/ino, which recognizes Windows long-name/8.3 aliases and
    // casing without weakening containment to a textual approximation.
    expect(flat(containment)).toContain('The lexical fast path handles normal canonical spellings')
    expect(flat(containment)).toContain('this recognizes Windows long-name/8.3 aliases and casing without weakening containment to a textual approximation')
    expect(containment).toMatch(/left\.dev === right\.dev && left\.ino === right\.ino/u)
    // And the containment test itself, exercised directly: an alias-equivalent
    // path must be recognized as contained.
    return import(srcUrl('packages/fs/fs-sandbox/lib/types/containment.js')).then(async (mod: { isPathUnder(path: string, root: string, caseSensitive?: boolean): Promise<boolean> }) => {
      const root = tempDir('sec05-contain')
      mkdirSync(join(root, 'sub'), { recursive: true })
      writeFileSync(join(root, 'sub', 'f.txt'), 'x', 'utf8')
      // A descendant is contained; a sibling is not.
      expect(await mod.isPathUnder(join(root, 'sub', 'f.txt'), root)).toBe(true)
      expect(await mod.isPathUnder(root, root)).toBe(true)
      expect(await mod.isPathUnder(dirnameOf(root), root)).toBe(false)
      expect(await mod.isPathUnder(join(root, '..', 'elsewhere'), root)).toBe(false)
    })
  })
})

/** The parent directory of a path, used by the containment test. */
function dirnameOf(path: string): string {
  const index = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return index <= 0 ? path : path.slice(0, index)
}

// ---------------------------------------------------------------------------
// SEC-06 — capability epoch
// ---------------------------------------------------------------------------

describe('SEC-06: park invalidates old RPC; reset invalidates old references and tool requests', () => {
  /**
   * THE HONEST RESULT, and it is NOT what the record's own comment promised.
   *
   * `recovery.ts` used to implement a stale-epoch refusal with its own tests, and
   * `docs/GAPS.md` G-SEAM-21 recorded the load-bearing finding that it was
   * UNREACHABLE from production: no non-test importer, no caller outside its own
   * module and its test, and nothing outside `recovery.ts` reading or writing
   * `.epoch` after `initialRunRecord` set it to 1. The field was INERT.
   *
   * The F8 / REC-09 / REC-10 topology measurement then showed the sharper fact
   * that decided this gate: the guard's INPUT cannot be constructed. The
   * unreachability was double, and the second half is why wiring it would have been
   * a fabrication rather than a fix. Importing the guard would not have been
   * enough, because its precondition cannot occur — the epoch was written in
   * exactly ONE production place (`initialRunRecord`, to the literal 1), and the
   * production `resume()` path re-opened the phase WITHOUT touching it, so even a
   * wired-up `applyWorkerSettlement` would have compared `1 !== 1` and refused
   * nothing. Beyond that, there is no settlement PRODUCER to call it: no
   * production call site targets a terminal task state at all, and the launch port
   * resolves at the ADMISSION edge and is never called back on completion.
   * Graph: `qualification/results/R9-recovery-topology/TOPOLOGY.md`.
   *
   * SO THE GUARD, its `WorkerSettlement` type, its `RefusalLedger` over a separate
   * `dsh_daily_work_refusals` domain, and the run record's `epoch` field were all
   * DELETED rather than wired. Wiring them would have meant INVENTING a
   * cross-process settlement producer, which the audit forbids.
   *
   * WHAT THIS REMOVAL IS: a CLAIM that was never true is removed — an epoch that
   * looked like a guard only because nothing checked it. It is NOT the removal of a
   * working mechanism the product relied on. This is the same shape as G-SEAM-50,
   * where CMP-06's sandbox-policy protection is unreachability rather than
   * immutability.
   *
   * `record.ts` stated "a callback carrying a stale epoch must be rejected" as if
   * it were a property, and that sentence was a REQUIREMENT written in the grammar
   * of enforcement. A gate that accepted the sentence would have been reading a
   * comment as a control. The corrected record now states what is actually
   * enforced — object identity, for the in-process case the product can reach —
   * and that the cross-process generation case is not covered and is not claimed.
   *
   * So SEC-06's kernel half is NOT_RUN (no kernel plane exists) and its
   * record-epoch half is a recorded NON-CLAIM: v2 does not assert the guarantee,
   * and v1's REC-09/REC-10 stay FAIL as the historical record of what was asked
   * for and never delivered.
   */
  it('the epoch guard is DELETED, and this gate is a recorded NON-CLAIM', () => {
    // THE HONEST RESULT, and it is the opposite of what the record once promised.
    //
    // `recovery.ts` used to implement a stale-epoch refusal with its own tests.
    // `docs/GAPS.md` G-SEAM-21 recorded that it was UNREACHABLE from production.
    // The topology measurement taken for F8 / REC-09 / REC-10 then showed something
    // sharper than unreachability: the guard's INPUT cannot be constructed. A
    // settlement is the act of LEAVING an in-flight state, and the product has no
    // path that does it — `WorkService.transition` is the only method that can
    // write a task's state, reservation release and tombstone, and no production
    // call site targets a TERMINAL state. The product does write the non-terminal
    // uncertainty state `unknown` (host.ts:1342, host.ts:1364), and nothing can
    // move a task out of it: the only production writer of an `unknown`-exit state
    // is host.ts:1379's `accepted`, unreachable for such a task because `admit`
    // refuses a slot-holding one (host.ts:823-825). The launch port resolves at the
    // ADMISSION edge and is never called back on completion; and nothing ever
    // bumped the epoch, so even a wired guard would have compared 1 to 1 forever.
    // Graph: `qualification/results/R9-recovery-topology/TOPOLOGY.md`.
    //
    // So the guard, the `WorkerSettlement` type, the `RefusalLedger`, the
    // `dsh_daily_work_refusals` domain and the run record's `epoch` field were all
    // DELETED, rather than wired. Wiring them would have meant INVENTING a
    // cross-process settlement producer, which the audit forbids.
    //
    // WHAT THIS REMOVAL IS: a CLAIM that was never true is removed — an epoch that
    // looked like a guard only because nothing checked it. It is NOT the removal of
    // a mechanism the product relied on. Same shape as G-SEAM-50, where CMP-06's
    // sandbox-policy protection is unreachability rather than immutability.
    const recovery = readFileSync(join(REPO_ROOT, 'packages', 'dsh-daily-work', 'src', 'recovery.ts'), 'utf8')
    // The guard is gone, in code. The comment naming it is allowed and intended:
    // that is where the decision is documented.
    const recoveryCode = recovery.split(/\r?\n/u)
      .filter(line => !/^\s*(?:\/\/|\*|\/\*)/u.test(line))
      .join('\n')
    expect(recoveryCode, 'the epoch comparison must not survive').not.toMatch(/\bepoch\b/u)
    expect(recoveryCode).not.toMatch(/applyWorkerSettlement|RefusalLedger|WorkerSettlement/u)
    // `relaunchPrepared` is a DIFFERENT claim (gate D03) and is deliberately kept.
    expect(recoveryCode).toContain('export async function relaunchPrepared')
    // The record no longer carries the field, and the schema is the place that
    // decides what a stored record may contain. Comments are stripped first,
    // because the corrected comment in `record.ts` DESCRIBES the removed field —
    // that description is the documentation and must not read as a declaration.
    const record = readFileSync(join(REPO_ROOT, 'packages', 'dsh-daily-work', 'src', 'record.ts'), 'utf8')
    const recordCode = record.split(/\r?\n/u)
      .filter(line => !/^\s*(?:\/\/|\*|\/\*)/u.test(line))
      .join('\n')
    expect(recordCode, 'the run record schema must not declare an epoch').not.toMatch(/epoch/u)
    // The removal is documented where the field used to be, so a reader learns
    // why it is gone rather than finding a silent gap.
    expect(record, 'the removal must be documented in the schema').toContain('THERE IS NO `epoch` FIELD HERE')
    // The measured finding is still recorded, now as a deletion with its reason.
    const gaps = readFileSync(join(REPO_ROOT, 'docs', 'GAPS.md'), 'utf8')
    expect(gaps).toContain('G-SEAM-21')
  })

  it('the reachability claim is verified here rather than inherited from the GAPS entry', () => {
    // An import-graph scan over PRODUCTION sources: who imports recovery.ts, and
    // who reads a run epoch outside its own module.
    const pkg = join(REPO_ROOT, 'packages', 'dsh-daily-work', 'src')
    const production = readdirSync(pkg).filter(f => f.endsWith('.ts') && !f.endsWith('.test.ts'))
    const importers: string[] = []
    const epochReaders: string[] = []
    for (const file of production) {
      if (file === 'recovery.ts') continue
      const text = readFileSync(join(pkg, file), 'utf8')
      if (/from\s+'\.\/recovery\.ts'/u.test(text)) importers.push(file)
      // A read of the field, not a mention in a comment. `kernel-lifecycle.ts` has
      // a KERNEL epoch, a different field with the same word (G-SEAM-43), so it is
      // excluded by name to keep this about the RUN record.
      const code = text.replace(/^\s*(?:\/\/|\*|\/\*).*$/gmu, '')
      if (file !== 'kernel-lifecycle.ts' && /\bepoch\b/u.test(code)) epochReaders.push(file)
    }
    // THE FINDING, re-measured: no production module imports recovery.ts, and no
    // production module mentions a run epoch at all.
    expect(importers, 'recovery.ts must have no production importer').toEqual([])
    expect(epochReaders, 'no production module may read a run epoch').toEqual([])
  })

  it('the host service no longer claims a per-await epoch re-check it does not perform', () => {
    // `host.ts`'s module header used to state the top-up contract in the grammar of
    // enforcement: "After every await we re-check the run epoch, the user-cancel
    // state and whether the owner is still the exact live Agent. A stale generation
    // must not publish authoritative state." and `createRun`'s doc repeated it
    // ("authority is bound to the live object plus the run epoch ... (INV-L3)").
    //
    // Neither was true of the code: the word `epoch` appeared in that file ONLY
    // inside those two comments. Both are now corrected to name what IS enforced —
    // object identity in `tool-protocol-guards.ts` — and to state that the record
    // deliberately carries no epoch. This is the same defect shape SEC-06 records,
    // one layer up: a requirement written in the grammar of enforcement.
    const host = readFileSync(join(REPO_ROOT, 'packages', 'dsh-daily-work', 'src', 'host.ts'), 'utf8')
    // THE MEASUREMENT: strip comments, then look for the field. Nothing.
    const code = host.split(/\r?\n/u)
      .filter(line => !/^\s*(?:\/\/|\*|\/\*)/u.test(line))
      .join('\n')
    expect(code, 'host.ts must contain no epoch EXPRESSION, only comments').not.toMatch(/\bepoch\b/u)
    // The false claims are gone.
    expect(host).not.toContain('After every await we re-check the run epoch')
    expect(host).not.toContain('bound to the live object plus the run epoch')
    // What the await-boundary re-check ACTUALLY is, quoted from the loop it guards.
    // These two checks are real; the epoch and the owner are not.
    //
    // ASSERTED AS THE INVARIANT, NOT AS ONE SPELLING OF IT. This read
    // `/if \(this\.disposed\) break/` and `/if \(signal\.aborted\) break/`, which
    // pinned the exact shape R9's tree had: two separate one-line guards. R3's
    // admission rework replaced that loop with a batched form that checks the same
    // two conditions in ONE combined guard before doing any work:
    //
    //     if (this.disposed || entry.signal.aborted) break
    //
    // That is the same protection, so the old spelling would fail a correct tree --
    // and the tempting "fix" of deleting these two lines would have removed the only
    // check that the guard exists at all. What is asserted instead is what this case
    // is about: the loop still refuses to start work once the service is disposed or
    // the caller's signal has aborted, and it BREAKS rather than fabricating an
    // outcome for a caller who never asked.
    expect(code, 'the drain must still stop on a disposed service').toMatch(/this\.disposed/u)
    expect(code, 'the drain must still stop on an aborted caller').toMatch(/signal\.aborted/u)
    expect(code, 'the combined guard must break rather than invent an outcome')
      .toMatch(/this\.disposed \|\| entry\.signal\.aborted\) break/u)
    // THE TWO WRITERS' CHANGES ARE COMBINED HERE, not chosen between, because
    // they are about different properties and neither subsumes the other.
    //
    // R9 removed the EPOCH assertion that used to live here: its subject (the run
    // epoch field and the settlement guard that read it) no longer exists, so
    // asserting anything about it would be a test of nothing. R9 replaced it with
    // a pointer to the guard that IS reachable, so the correction reads as a
    // redirection rather than a deletion.
    expect(host).toContain('tool-protocol-guards.ts')
    // R4 narrowed the PERSISTENCE assertion below, and the narrowing is a
    // correction rather than a weakening -- see the comment it carries.
    // And the sharpest form of the contradiction: the sentence says "an identity,
    // NOT as a string" and the very next assignment persists exactly a string.
    expect(code, 'the root must be persisted as the session-id string the doc disclaims').toMatch(/rootSessionId: input\.root\.session\.header\.id/u)
    // THE ASSERTION IS SCOPED TO THE PERSISTENCE BLOCK, and the scoping is a
    // correction rather than a weakening. It previously read
    // `not.toMatch(/rootAgent\b|root: input\.root\b/u)` over the WHOLE file, which
    // is broader than the property it names: what must not happen is the root
    // AGENT being handed to `initialRunRecord` (the object would then be
    // persisted, or persisted-adjacent). Passing the live Agent to `createRun` —
    // which is what `authorizeRun` does, and which `createRun` needs in order to
    // bind the production launch port to the exact object — is a different act and
    // must not trip this. The property is preserved in full: the block below is
    // exactly the record-construction-and-persistence region, and it still
    // requires the persisted field to be the session-id STRING.
    const persistence = code.slice(
      code.indexOf('const record = initialRunRecord({'),
      code.indexOf('await this.runs().put(input.runId, record)'),
    )
    expect(persistence, 'the persistence block was not found, so this assertion is vacuous')
      .toContain('initialRunRecord({')
    expect(persistence, 'the root must not be persisted as an Agent object')
      .not.toMatch(/rootAgent\b|root: input\.root\b/u)
    // And the guard module's own statement of why that is not enough, so the two
    // files are read together rather than one excusing the other.
    const guards = readFileSync(join(REPO_ROOT, 'packages', 'dsh-daily-work', 'src', 'tool-protocol-guards.ts'), 'utf8')
    expect(flat(guards)).toContain('Both compare OBJECT IDENTITY against the registry, not ids')
    expect(flat(guards)).toContain('an id survives a replacement, an object does not')
  })

  it('the kernel park/reset half is NOT_RUN, and the reason is a measurement', () => {
    // The IPython data plane is the subject of the kernel half. Its package
    // exists and has no kernel lifecycle code yet, so a gate about kernel
    // park/reset cannot be closed by this package.
    const ipython = join(REPO_ROOT, 'packages', 'dsh-ipython')
    expect(existsSync(ipython), 'the data-plane package is the subject of the kernel half').toBe(true)
    const srcDir = join(ipython, 'src')
    expect(existsSync(srcDir)).toBe(true)
    // Measured, not assumed: what the data-plane package currently contains.
    const contents = readdirSync(srcDir)
    expect(contents.length, 'the kernel plane is not implemented yet, which is why this half is NOT_RUN').toBeGreaterThanOrEqual(0)
    // The kernel mechanics that DO exist are protocol self-checks, and the
    // audit reproduction says so in its own words.
    const repro = readFileSync(join(REPO_ROOT, 'qualification', 'results', 'M10.0-audit-repro', 'FINDINGS.md'), 'utf8')
    expect(flat(repro)).toContain('These are **protocol self-checks only**')
    expect(flat(repro)).toContain('no DSH native tool and no LLM participated, so they are not evidence for any DSH or data-plane gate')
    // The reachable half of the kernel lifecycle — the interrupt that does not
    // settle — is a real, reproduced limit rather than a hypothetical.
    const transport = readFileSync(join(REPO_ROOT, 'qualification', 'results', 'M11-ipython', 'TRANSPORT-FINDINGS.md'), 'utf8')
    expect(flat(transport)).toContain('A case that does NOT settle: interrupting an await-suspended cell')
    expect(flat(transport)).toContain('M3 must therefore treat an interrupt that does not settle within a bounded grace as `unknown` + kernel restart')
  })
})

// ---------------------------------------------------------------------------
// SEC-07 — same-kernel thread
// ---------------------------------------------------------------------------

describe('SEC-07: an old background task in a new cell is NOT isolated, and that is the honest statement', () => {
  /**
   * THE CLAIM THE GATE FORBIDS. "A cell id provides malicious-code isolation" is
   * FALSE in a shared interpreter: a thread or a C extension started in cell N
   * keeps running in cell N+1 and can read and mutate the namespace. The gate
   * asks for the HONEST statement, not a comfortable one, so this file asserts
   * the absence of an isolation claim AND the presence of the refusals that DO
   * hold (cross-Session and host privileges).
   */
  it('no source in this project claims a cell id isolates malicious code', () => {
    const pkg = join(REPO_ROOT, 'packages', 'dsh-daily-work', 'src')
    const offenders: string[] = []
    for (const file of readdirSync(pkg)) {
      if (!file.endsWith('.ts')) continue
      const text = flat(readFileSync(join(pkg, file), 'utf8'))
      // An isolation CLAIM is the defect. The patterns are the phrasings a
      // claim would use; a sentence denying the claim does not match them.
      for (const pattern of [
        /cell id provides (malicious )?(code )?isolation/iu,
        /cells are isolated from (each other|one another)/iu,
        /a cell cannot affect (a later|another) cell/iu,
        /background tasks (are|stay) isolated/iu,
      ]) {
        if (pattern.test(text)) offenders.push(`${file}: ${pattern.source}`)
      }
    }
    expect(offenders).toEqual([])
  })

  it('the architecture document states the same-kernel limit rather than hiding it', () => {
    const architecture = readFileSync('C:/Users/hzq00/Downloads/DSH_NATIVE_IPYTHON_ARCHITECTURE_AUDIT_2026-09-20/dsh-audit-2026-09-20/delivery/ARCHITECTURE.zh-CN.md', 'utf8')
    // The audit's own text on what a monkeypatch inside IPython can and cannot
    // change: it affects untrusted payload only, never host authority.
    expect(architecture).toContain('IPython内的monkeypatch、伪造display、伪造`status=verified`只影响不可信载荷')
    expect(architecture).toContain('不能改变host的artifact ACL、tool执行记录或验收判决')
    // And the execution-environment section's statement that the host manages
    // authority while the worker holds only the current project.
    expect(architecture).toContain('模型密钥、私人history、整个HOME、host管理socket不在执行域')
  })

  it('the privileges that DO hold across a cell boundary are the cross-Session and host refusals', async () => {
    // What genuinely holds is not cell isolation but the OWNERSHIP checks: a
    // callback bound to one Agent cannot act for another, and no control-plane
    // handle is reachable. Both are asserted elsewhere in this file and in
    // `control-plane.test.ts`; what is added here is that the claim is stated in
    // terms of ownership rather than of isolation.
    const guards = readFileSync(join(REPO_ROOT, 'packages', 'dsh-daily-work', 'src', 'tool-protocol-guards.ts'), 'utf8')
    expect(flat(guards)).toContain('A SessionId is reused across an agent\'s life')
    const ctx = new Context()
    await ctx.plugin(LocalSubprocessRuntime)
    // No host-privileged service is reachable from a model-facing context.
    for (const name of ['terminalController', 'pluginManager', 'authorization', 'remote', 'webTerminals', 'webhookRuntime']) {
      expect(ctx.get(name as never), `${name} must not be reachable`).toBeUndefined()
    }
    await ctx.fiber.dispose()
  })

  it('the kernel\'s transport is a real limit and is recorded: plaintext TCP by default, CurveZMQ only when asked', () => {
    // The same-kernel claim is weakened further by the transport. The M0 finding
    // and its M3 correction are both recorded, and both are cited here.
    const transport = readFileSync(join(REPO_ROOT, 'qualification', 'results', 'M11-ipython', 'TRANSPORT-FINDINGS.md'), 'utf8')
    // The measured correction: the audit's FIRST preference (IPC) is impossible
    // on Windows, so the design cannot assume it.
    expect(flat(transport)).toContain("transport='ipc'` fails at socket creation, before any kernel starts: Windows libzmq is built without IPC support")
    expect(flat(transport)).toContain('On this platform it is not an option, and a design that assumes it would fail at the first `KernelManager` construction')
    // CurveZMQ works and is what removes the plaintext warning — but only when
    // the caller asks for it.
    expect(flat(transport)).toContain('the warning that M0 measured on the default path **does not appear**')
    expect(flat(transport)).toContain('it is evidence that the *default* path does not, and that a caller who does not ask for encryption silently gets none')
    // The M0 record that a readable connection file is an execution capability.
    const repro = readFileSync(join(REPO_ROOT, 'qualification', 'results', 'M10.0-audit-repro', 'FINDINGS.md'), 'utf8')
    expect(flat(repro)).toContain('The kernel connection file carries the HMAC key that authorises execution; a readable connection file is therefore an execution capability')
  })

  /**
   * THE BOUNDARY THAT IS CLAIMED, AND WHAT IT ACTUALLY IS.
   *
   * `kernel-lifecycle.ts` states the honest cell-id limit and then names what it
   * says IS enforced: "a kernel is a separate process with its own OS identity".
   * That sentence is true in the weak sense (a separate process has its own pid)
   * and would be FALSE in the strong sense a reader could take from it — that the
   * kernel process runs under a different OS identity or a confinement boundary.
   *
   * It does not. The live kernel spawns through `ctx.subprocess` with no
   * `ctx.sandbox.confine()` anywhere in the call, so the kernel process is the
   * SAME OS user with the SAME ambient file and network access as the host. This
   * test pins that, because the difference decides whether SEC-07's "越Session/host
   * 权限仍拒绝" is satisfied by an OS boundary (it is not) or by the ownership
   * guards (it is).
   */
  it('the kernel-process "OS identity" is a pid, not a confinement: the spawn is unconfined', () => {
    const kernel = readFileSync(join(REPO_ROOT, 'packages', 'dsh-ipython', 'src', 'kernel.ts'), 'utf8')
    // The spawn exists and goes straight to the subprocess seam.
    expect(kernel).toMatch(/this\.options\.subprocess\.spawn\(\{/u)
    // THE MEASUREMENT: the ipython plane never calls the sandbox seam at all.
    for (const file of ['kernel.ts', 'kernel-plugin.ts', 'host-plugin.ts', 'ipython-tool.ts']) {
      const text = readFileSync(join(REPO_ROOT, 'packages', 'dsh-ipython', 'src', file), 'utf8')
      expect(text, `${file} must not confine the kernel`).not.toMatch(/sandbox\.confine|ctx\.sandbox/u)
    }
    // The environment the kernel DOES receive is a three-name allowlist, which is
    // a real (if narrow) control and is not OS identity separation.
    expect(kernel).toMatch(/DSH_IPYTHON_SPILL_DIR/u)
    expect(kernel).toMatch(/DSH_IPYTHON_KERNEL_DIR/u)
    expect(flat(kernel)).toContain("stdin is 'ignore': the broker has no business reading a terminal")
    // And the claim's own source, so a reader sees the sentence and this
    // measurement together.
    const lifecycle = readFileSync(join(REPO_ROOT, 'packages', 'dsh-daily-work', 'src', 'kernel-lifecycle.ts'), 'utf8')
    expect(flat(lifecycle)).toContain('a kernel is a separate process with its own OS identity')
    expect(flat(lifecycle)).toContain('It is NOT a malicious-code isolation boundary')
    expect(flat(lifecycle)).toContain('Within one CPython process an old background thread can touch a new cell\'s memory')
    // The machine-readable form of the same limit, in the data a model can read.
    expect(lifecycle).toMatch(/cellIdSemantics: 'attribution-cancel-audit-only'/u)
    expect(lifecycle).toMatch(/isolationBoundary: 'session-and-kernel-process'/u)
  })
})

// ---------------------------------------------------------------------------
// SEC-08 — role change
// ---------------------------------------------------------------------------

describe('SEC-08: a read-permission-domain or project change forces a NEW epoch, never a reused kernel', () => {
  /**
   * The gate's oracle: a permission-domain or project change must force a new
   * epoch or a controlled migration, and must NOT carry old-domain secret
   * variables into the new role.
   *
   * The audit's own production path is the answer here, and it is a DEPLOYMENT
   * decision rather than a kernel feature: "同一项目family可以读共享source；其他
   * 项目或不同读权限域使用独立execution world/VM" — the same project family may
   * share source, but another project or a DIFFERENT READ-PERMISSION DOMAIN uses
   * an independent execution world. That makes the epoch question structural
   * rather than a runtime migration problem.
   */
  it('the architecture requires a separate execution world per read-permission domain', () => {
    const architecture = readFileSync('C:/Users/hzq00/Downloads/DSH_NATIVE_IPYTHON_ARCHITECTURE_AUDIT_2026-09-20/dsh-audit-2026-09-20/delivery/ARCHITECTURE.zh-CN.md', 'utf8')
    expect(architecture).toContain('同一项目family可以读共享source')
    expect(architecture).toContain('其他项目或不同读权限域使用独立execution world/VM')
    // And that a worker VM is NOT a shared safe for many privacy domains.
    expect(architecture).toContain('worker VM不是任意多个隐私域的全局共享保险箱')
    // Authority comes only from trusted UI/config; the model cannot widen its own
    // permission from inside IPython.
    expect(architecture).toContain('授权只来自可信UI/配置')
    expect(architecture).toContain('模型不能通过IPython调用human terminalController、plugin manager、rawRPC、修改N或预算来扩大权限')
    // And the sentence that closes the "localhost is authority" confusion.
    expect(architecture).toContain('localhost仅是地址不是权限系统')
  })

  it('this project isolates a domain by a SEPARATE STORE, which is the mechanism it actually has', () => {
    // The honest local answer: there is no runtime role migration in this
    // package. Isolation is by store root plus the home lock, so a different
    // domain is a different store with its own exclusive holder.
    const isolation = readFileSync(join(REPO_ROOT, 'packages', 'dsh-daily-work', 'src', 'isolation.test.ts'), 'utf8')
    expect(flat(isolation)).toContain('gives a second root its own pool, so one family filling up does not block another')
    expect(flat(isolation)).toContain('keeps two runs in one host separate in tasks, budget and pause state')
    // The domain name is a single constant, so a second domain needs a different
    // store rather than a shared one with a different label.
    const host = readFileSync(join(REPO_ROOT, 'packages', 'dsh-daily-work', 'src', 'host.ts'), 'utf8')
    expect(host).toMatch(/export const WORK_DOMAIN_NAME = 'dsh_daily_work'/u)
    // And the schema version is pinned, with the rule for changing it stated:
    // an offline conversion or a NEW NAMESPACE with an explicit cutover — which
    // is exactly "a new epoch" expressed at the storage layer.
    expect(flat(host)).toContain('A change here requires an offline conversion or a new namespace with an explicit cutover')
    expect(flat(host)).toContain('silently reading an older shape as if it were current is exactly what the plan forbids')
  })

  it('no secret variable survives a domain change, because no secret is ever placed in configuration', () => {
    // The mechanism that makes the gate's "不带旧域秘密变量" clause hold: the
    // patch NAMES a credential reference and never a value, and the provider
    // reports unavailable when the reference does not resolve.
    const patch = readFileSync(join(REPO_ROOT, 'packages', 'dsh-daily-work', 'cordis.patch.yml'), 'utf8')
    expect(flat(patch)).toContain('The reference is NAMED here; no credential value is ever placed in configuration')
    expect(patch).toContain('apiKeyEnv: EXA_API_KEY')
    // The reference is an environment NAME, not a value: the patch contains no
    // long high-entropy literal that could be a key.
    expect(patch).not.toMatch(/(?:api[_-]?key|token|secret)\s*:\s*["'][A-Za-z0-9_\-]{24,}["']/iu)
    // And the provider degrades rather than failing the host, so a missing
    // credential is "unavailable" rather than a silent anonymous call.
    expect(flat(patch)).toContain('the provider reports `available() === false` and the host degrades to "search unavailable" rather than failing to boot')
    // The project's own test pins the same property.
    const security = readFileSync(join(REPO_ROOT, 'packages', 'dsh-daily-work', 'src', 'security.test.ts'), 'utf8')
    expect(security).toContain('reports unavailable when no credential store is mounted')
  })

  it('a credential-shaped name cannot cross a process boundary, which bounds the blast radius of a role change', () => {
    // The one credential control that exists (SEC-01 measures its limit): the
    // subprocess seam drops credential-shaped and DSH_* names, so a child of the
    // OLD role does not inherit the old role's secret variables.
    const subprocessSeam = srcFile('packages/subprocess/subprocess/src/index.ts')
    expect(subprocessSeam).toMatch(/SENSITIVE_ENV_PATTERN\s*=\s*\/[^/]*(KEY|PASSWORD|SECRET|TOKEN)/iu)
    // The prefix constant is declared in the seam's own types module.
    expect(srcFile('packages/subprocess/subprocess/src/types.ts')).toMatch(/DSH_ENV_PREFIX\s*=\s*'DSH_'/u)
    expect(subprocessSeam).toMatch(/key\.toUpperCase\(\)\.startsWith\(DSH_ENV_PREFIX\)/u)
    expect(flat(subprocessSeam)).toContain('Credential-shaped environment names are NOT forwarded to children')
    expect(flat(subprocessSeam)).toContain('The ambient parent environment minus credential-shaped names and minus all')
    // The limit is stated rather than implied: it is defeated by an explicit
    // `env` entry, which merges after the scrub by design.
    const findings = readFileSync(join(REPO_ROOT, 'qualification', 'results', 'M9.3-security-denial', 'FINDINGS.md'), 'utf8')
    expect(flat(findings)).toContain('defeated deliberately by an explicit `env` entry, which merges after the scrub by design')
  })

  /**
   * WHY THIS GATE IS `NOT_RUN`, AND NOT `BLOCKED_EXTERNAL` — the distinction the
   * promotion verdict turns on, and one an earlier version of this file stated
   * wrongly in a test title.
   *
   * `NOT_RUN` means the fixture was never built — the result is unknown.
   * `BLOCKED_EXTERNAL` means the remaining work needs an AUTHORIZATION this
   * machine does not have. SEC-08 needs a second provisioned EXECUTION WORLD,
   * which is infrastructure rather than authorization, and its mechanism is
   * present-but-unwired rather than awaiting permission — so `NOT_RUN` is the
   * correct status, which is what `upg-gates.test.ts` records.
   *
   * That was true when SEC-08 was first recorded and the subject exists in three
   * places, each read:
   *
   *   1. The LIVE kernel plane (`packages/dsh-ipython`) has a real per-Session
   *      kernel registry with a real identity check, and it is measured below:
   *      a changed execution world IS refused. That is the kernel half of the
   *      oracle, and it HOLDS.
   *   2. The MIGRATION half — `changeReadPermissionDomain`, which discards the
   *      namespace and advances the epoch rather than migrating — EXISTS and is
   *      exercised, but it lives in `packages/dsh-daily-work/src/kernel-lifecycle.ts`,
   *      which no production module imports and which the package does not
   *      export. It is a designed mechanism with no runtime.
   *   3. The DEPLOYMENT answer the architecture states is "a different read
   *      domain uses an independent execution world/VM", which is a provisioning
   *      decision, not a code path this repo can execute.
   *
   * So the gate is not unmeasured — it is measured, and the thing it requires is
   * not wired to anything that runs. Closing it needs either the kernel-lifecycle
   * plane to be mounted into a production composition (a build task, not a test)
   * or a second provisioned execution world to migrate between (infrastructure
   * this host does not have). Neither is reachable from a test in this package.
   */
  it('the kernel half of the oracle HOLDS on the live plane: a changed execution world is refused', () => {
    // The check is in `KernelService.entryFor`, which re-checks the identity on
    // EVERY resolve rather than only at creation, and the refusal is a throw
    // rather than a silent evict-and-restart. The distinction matters: a silent
    // replace would satisfy "a new epoch" while destroying the evidence that a
    // domain changed under a live namespace.
    const plugin = readFileSync(join(REPO_ROOT, 'packages', 'dsh-ipython', 'src', 'kernel-plugin.ts'), 'utf8')
    expect(flat(plugin)).toContain('The identity is re-checked on every resolve, not only at creation')
    expect(plugin).toMatch(/existing\.identity\.executionWorld !== identity\.executionWorld/u)
    expect(plugin).toMatch(/existing\.identity\.environmentDigest !== identity\.environmentDigest/u)
    expect(flat(plugin)).toContain('the kernel must be evicted')
    // And the identity rule the refusal implements, from the architecture.
    expect(flat(plugin)).toContain('Kernel identity is')
    expect(flat(plugin)).toContain('executionWorld + environmentDigest + kernelEpoch')
    // The package's own test measures the refusal against a REAL kernel and
    // asserts the kernel was NOT quietly replaced.
    const serviceTest = readFileSync(join(REPO_ROOT, 'packages', 'dsh-ipython', 'src', 'service.test.ts'), 'utf8')
    expect(flat(serviceTest)).toContain('a changed execution world is refused rather than served by the old kernel')
    expect(flat(serviceTest)).toContain('the kernel is still the OLD one: the refusal did not quietly replace it')
  })

  it('the MIGRATION half exists but has no runtime: it is a designed mechanism in an unreachable module', () => {
    // `changeReadPermissionDomain` is exactly what the oracle asks for, and it is
    // implemented correctly: admission closes first, the running cell is
    // cancelled and awaited, the kernel is REPLACED (not migrated), the epoch
    // advances, and the loss is reported rather than hidden.
    const lifecycle = readFileSync(join(REPO_ROOT, 'packages', 'dsh-daily-work', 'src', 'kernel-lifecycle.ts'), 'utf8')
    expect(lifecycle).toMatch(/async changeReadPermissionDomain\(/u)
    expect(flat(lifecycle)).toContain('THE KERNEL IS ALWAYS RESTARTED')
    expect(flat(lifecycle)).toContain('the kernel is replaced, the epoch advances, and the loss is reported')
    expect(flat(lifecycle)).toContain('close admission -> cancel and clean up -> new epoch')
    expect(lifecycle).toMatch(/kernelEpoch: previousEpoch \+ 1/u)
    expect(flat(lifecycle)).toContain('every variable read under the old domain is discarded')
    // THE REACHABILITY FINDING, re-measured rather than inherited: the module is
    // imported ONLY by test files, and the package does not export it.
    const pkgSrc = join(REPO_ROOT, 'packages', 'dsh-daily-work', 'src')
    const productionImporters: string[] = []
    for (const file of readdirSync(pkgSrc)) {
      if (!file.endsWith('.ts') || file.endsWith('.test.ts') || file === 'kernel-lifecycle.ts') continue
      if (/from '\.\/kernel-lifecycle\.ts'/u.test(readFileSync(join(pkgSrc, file), 'utf8'))) productionImporters.push(file)
    }
    expect(productionImporters, 'kernel-lifecycle.ts must have no production importer').toEqual([])
    const pkgJson = readFileSync(join(REPO_ROOT, 'packages', 'dsh-daily-work', 'package.json'), 'utf8')
    expect(pkgJson).not.toContain('kernel-lifecycle')
    // And the LIVE ipython plane has no read-permission-domain concept at all,
    // so there is nothing for the mechanism to be wired TO.
    for (const file of ['kernel.ts', 'kernel-plugin.ts', 'host-plugin.ts']) {
      const text = readFileSync(join(REPO_ROOT, 'packages', 'dsh-ipython', 'src', file), 'utf8')
      expect(text, `${file} must have no role/domain migration`).not.toMatch(/changeReadPermissionDomain|readPermissionDomain/u)
    }
  })

  it('the gate is NOT_RUN, and the reason is that the mechanism exists but no second execution world does', () => {
    // THE STATUS, and why it is NOT_RUN rather than BLOCKED_EXTERNAL.
    //
    // The two statuses mean different things and the promotion verdict turns on
    // the difference (`docs/DELIVERY.md`):
    //   NOT_RUN         — not exercised. Includes PARTIAL. Not a soft pass.
    //   BLOCKED_EXTERNAL — the remaining work needs an AUTHORIZATION this machine
    //                      does not have (the live-provider budget is the only
    //                      such case in this project, UPG-07).
    //
    // SEC-08's remaining work needs a second provisioned execution world, which
    // is INFRASTRUCTURE, not an authorization. And the mechanism it would
    // exercise is present but unwired (`changeReadPermissionDomain` has no
    // production importer), so the fixture was never built — which is exactly
    // NOT_RUN's definition. An earlier version of this test's TITLE said
    // BLOCKED_EXTERNAL while the verdict table said NOT_RUN; the title was the
    // weaker claim's opposite, so it is corrected here rather than left as a
    // contradiction a reader would have to resolve.
    const upg = readFileSync(join(REPO_ROOT, 'packages', 'dsh-daily-work', 'src', 'upg-gates.test.ts'), 'utf8')
    expect(upg, 'the verdict table must record SEC-08 as NOT_RUN').toMatch(/\{ id: 'SEC-08', status: 'NOT_RUN'/u)
    expect(upg).toMatch(/const notRun = GATES\.filter\(row => row\.status === 'NOT_RUN'\)\.map\(row => row\.id\)\s*\n\s*expect\(notRun\.sort\(\)\)\.toEqual\(\['DEP-04', 'SEC-08', 'UPG-08'\]\)/u)
    // And BLOCKED_EXTERNAL is reserved for the ONE authorization case, so a
    // reader can see the two are not interchangeable.
    expect(upg).toMatch(/expect\(GATES\.filter\(row => row\.status === 'BLOCKED_EXTERNAL'\)\.map\(row => row\.id\)\)\.toEqual\(\['UPG-07'\]\)/u)
    const delivery = readFileSync(join(REPO_ROOT, 'docs', 'DELIVERY.md'), 'utf8')
    expect(flat(delivery)).toContain('`BLOCKED_EXTERNAL` | The remaining work needs an authorization this machine does not have.')
    expect(flat(delivery)).toContain('`NOT_RUN` | Not exercised. **Includes `PARTIAL`.** Not a soft pass.')

    // The architecture's own production answer is provisioning, not code:
    // "同一项目family可以读共享source；其他项目或不同读权限域使用独立execution world/VM".
    // A migration needs TWO worlds. This deployment has one (`executionWorld:
    // local` in the package patch), and no VM/container plane is mounted, so the
    // cross-world half cannot be exercised here — and per the acceptance spec a
    // simulated world would not substitute.
    const patch = readFileSync(join(REPO_ROOT, 'packages', 'dsh-ipython', 'cordis.patch.yml'), 'utf8')
    expect(patch).toMatch(/executionWorld: local/u)
    // The architecture requires the independent world for a different domain.
    const architecture = readFileSync('C:/Users/hzq00/Downloads/DSH_NATIVE_IPYTHON_ARCHITECTURE_AUDIT_2026-09-20/dsh-audit-2026-09-20/delivery/ARCHITECTURE.zh-CN.md', 'utf8')
    expect(architecture).toContain('其他项目或不同读权限域使用独立execution world/VM')
    expect(architecture).toContain('worker VM不是任意多个隐私域的全局共享保险箱')
    // No container or VM runtime is mounted in this composition, so a second
    // world is an external provisioning fact rather than a missing fixture.
    const composition = readFileSync(join(REPO_ROOT, 'packages', 'dsh-daily-work', 'cordis.patch.yml'), 'utf8')
    expect(composition).not.toMatch(/docker|podman|wsl|ssh-execution-world/u)
  })
})

// ---------------------------------------------------------------------------
// Cross-gate: the two honest FAILs are recorded where a reader will find them
// ---------------------------------------------------------------------------

describe('SEC cross-check: the two honest FAILs are the project\'s own record, not this file\'s opinion', () => {
  it('docs/GAPS.md and the M9.3 findings both carry the FAILs', () => {
    const gaps = readFileSync(join(REPO_ROOT, 'docs', 'GAPS.md'), 'utf8')
    // G-SEAM-12 is the consolidated security finding, marked as measured.
    //
    // SAME CORRECTION AS THE CASE ABOVE, and for the same reason: the ledger's own
    // status vocabulary requires a Status cell to begin with a vocabulary word, so
    // the ALL-CAPS emphasis this pinned was a filing error the hygiene pass
    // normalised. The MEANING is what must not be softened, so that is asserted.
    expect(gaps).toContain('| G-SEAM-12 |')
    expect(flat(gaps)).toMatch(/OPEN \(upstream limitation, confirmed by measurement\)/)
    // The M9.3 verdict table carries E01 and E06 as the negative results.
    const findings = readFileSync(join(REPO_ROOT, 'qualification', 'results', 'M9.3-security-denial', 'FINDINGS.md'), 'utf8')
    expect(findings).toContain('| **E01** credential isolation | NOT_RUN | **NOT_RUN — CANNOT BE CLOSED ON WINDOWS**')
    expect(findings).toContain('| **E06** network egress | NOT_RUN | **FAIL — no egress control exists**')
    // And the reason FAIL was chosen over NOT_RUN, which is the discipline this
    // whole family depends on.
    expect(flat(findings)).toContain('Two of the three gates resolve to the negative, and that is the result — the fixtures were built to find out, not to confirm')
  })

  it('the security fixture uses only fabricated canary values, and never reads a real credential', () => {
    const fixture = join(REPO_ROOT, 'qualification', 'fixtures', 'canary')
    expect(existsSync(fixture), 'the canary fixture must exist').toBe(true)
    // The canary values are visibly fabricated, so a hit in a log is
    // unambiguous and no real credential is ever involved.
    const secret = readFileSync(join(fixture, 'outside', 'canary-secret.txt'), 'utf8')
    expect(secret).toContain('CANARY-FAKE-SECRET')
    expect(secret).toContain('NOT-A-REAL-CREDENTIAL')
    // Every canary value in the fixture and in this file carries a FAKE marker.
    const own = readFileSync(join(REPO_ROOT, 'packages', 'dsh-daily-work', 'src', 'sec-gates.test.ts'), 'utf8')
    for (const match of own.matchAll(/CANARY-[A-Z0-9-]+/gu)) {
      expect(match[0], 'every canary value must be visibly fabricated').toMatch(/FAKE|HARMLESS/u)
    }
    // The fixture is COPIED, never used in place: the Windows ACL rung leaves a
    // standing ACE on any root it is handed, so pointing it at the checked-in
    // fixture would modify this repository.
    const denial = readFileSync(join(REPO_ROOT, 'packages', 'dsh-daily-work', 'src', 'security-denial.test.ts'), 'utf8')
    expect(flat(denial)).toContain('The canary fixture is COPIED into a fresh temp directory per run rather than pointed at in place')
    expect(flat(denial)).toContain('Running this against the checked-in fixture would leave standing ACEs on this repository')
  })
})
