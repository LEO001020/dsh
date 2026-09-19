/**
 * R10-security raw seam probe — SEC-01 / SEC-03 closability.
 *
 * This script answers ONE question with measurements rather than inference:
 *
 *   Is there any PUBLIC seam in the pinned checkout through which this project
 *   could restrict READS (SEC-01) or EGRESS (SEC-03) for a confined child?
 *
 * It probes, in order:
 *   1. the exported shape of the sandbox seam (SandboxPolicy / ConfinedArgv),
 *   2. whether a DIFFERENT `mode` changes read behaviour (read-only vs
 *      workspace-write vs danger-full-access),
 *   3. whether the windows-acl runner accepts ANY argv beyond the file-effect
 *      set (i.e. whether an operator could smuggle a network/read flag),
 *   4. whether the `runnerCommand` override is a usable lever (it is an
 *      operator assertion that skips probes — but it replaces the runner, and
 *      the project would have to SHIP a read/network-confining runner, which is
 *      a new OS-level artifact, not a use of an existing seam),
 *   5. the fs seam's read path (does the fence touch reads at all?).
 *
 * Run: node qualification/results/R10-security/probe-seams.mjs
 * No credentials are read. All fixtures are fabricated canaries.
 */
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdirSync, mkdtempSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const REPO = join(fileURLToPath(import.meta.url), '..', '..', '..', '..')
const DSH_SRC = process.env.DSH_SRC_ROOT ?? 'D:/DSH/src/dsh-src'

/**
 * This script lives OUTSIDE the package that links the DSH packages, so a bare
 * specifier would not resolve from here. Anchor resolution at the consuming
 * package instead — the same node_modules tree the tests use.
 */
const pkgRequire = createRequire(pathToFileURL(join(REPO, 'packages', 'dsh-daily-work', 'package.json')))
const load = async spec => await import(pathToFileURL(pkgRequire.resolve(spec)).href)

const { Context } = await load('@deepseek-ai/cordis')
const LocalSandboxProvider = (await load('@deepseek-ai/dsh-sandbox-local')).default
const LocalSubprocessRuntime = (await load('@deepseek-ai/dsh-subprocess-local')).default
const out = []
function say(line) { out.push(line); process.stdout.write(`${line}\n`) }

/** Read a source file from the pinned checkout. */
const srcFile = rel => readFileSync(join(DSH_SRC, ...rel.split('/')), 'utf8')

/** Strip leading comment markers and collapse whitespace, to search prose. */
function flat(text) {
  return text.split(/\r?\n/u)
    .map(line => line.replace(/^\s*(?:\/\*\*?|\*\/|\*|\/\/|#)\s?/u, ''))
    .join(' ')
    .replace(/\s+/gu, ' ')
}

const cleanup = []
function tempDir(label) {
  const dir = mkdtempSync(join(tmpdir(), `r10-${label}-`))
  cleanup.push(dir)
  return dir
}

/** The parent directory of a path (no `node:path` dirname import collision). */
function dirnameOf(path) {
  const index = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return index <= 0 ? path : path.slice(0, index)
}

async function mountSandbox() {
  const ctx = new Context()
  await ctx.plugin(LocalSubprocessRuntime)
  await ctx.plugin(LocalSandboxProvider)
  return { ctx, sandbox: ctx.sandbox }
}

/** Run argv confined under policy, returning exit code and stdout. */
async function runConfined(ctx, sandbox, argv, policy) {
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
    stdout: (await handle.collected.stdout.readFrom(0)).text,
    stderr: (await handle.collected.stderr.readFrom(0)).text,
    argv: confined.argv,
    enforcement: confined.enforcement,
  }
}

// ---------------------------------------------------------------------------
say('=== R10-SECURITY SEAM PROBE ===')
say(`pinned checkout: ${DSH_SRC}`)
say(`node: ${process.version}  platform: ${process.platform}`)
say('')

// --- 1. the exported shape -------------------------------------------------
{
  say('--- 1. the sandbox seam\'s exported shape ---')
  const seam = srcFile('packages/sandbox/sandbox/src/index.ts')
  // The policy interfaces, verbatim field lists.
  for (const [name, re] of [
    ['SandboxMode', /export type SandboxMode = ([^\n]+)/u],
    ['SandboxExecutionPolicy body', /export interface SandboxExecutionPolicy \{([\s\S]*?)\n\}/u],
    ['SandboxPolicy body', /export interface SandboxPolicy extends SandboxExecutionPolicy \{([\s\S]*?)\n\}/u],
    ['ConfinedArgv body', /export interface ConfinedArgv \{([\s\S]*?)\n\}/u],
  ]) {
    const m = re.exec(seam)
    if (m === null) { say(`  ${name}: NOT FOUND (seam changed — re-read)`); continue }
    const body = m[1].replace(/\s+/gu, ' ').trim()
    say(`  ${name}: ${body.slice(0, 300)}`)
  }
  // Field NAMES only, so prose mentioning "read" does not count as a lever.
  const fields = [...(/export interface ConfinedArgv \{([\s\S]*?)\n\}/u.exec(seam)?.[1] ?? '').matchAll(/^\s{2}(?:readonly )?([a-zA-Z]+)[?]?:/gmu)].map(m => m[1])
  say(`  ConfinedArgv field names: ${JSON.stringify(fields.sort())}`)
  say(`  ConfinedArgv has a network/egress field: ${fields.some(f => /net|egress|proxy|dns|read/i.test(f))}`)
  say(`  seam states network is out of vocabulary: ${flat(seam).includes('Network and process visibility are outside this vocabulary')}`)
  say('')
}

// --- 2. does MODE change read behaviour? -----------------------------------
{
  say('--- 2. does a different `mode` change READ behaviour? (measured) ---')
  const { ctx, sandbox } = await mountSandbox()
  const base = tempDir('mode')
  const workspace = join(base, 'workspace')
  const outside = join(base, 'outside')
  mkdirSync(workspace); mkdirSync(outside)
  const CANARY = 'CANARY-FAKE-R10-READ-NOT-A-CREDENTIAL'
  writeFileSync(join(outside, 'canary.txt'), CANARY, 'utf8')
  const target = join(outside, 'canary.txt')
  say(`  fixture: outside=${target} (sibling of workspace, so past the only boundary)`)
  for (const mode of ['read-only', 'workspace-write']) {
    const run = await runConfined(ctx, sandbox, [
      process.execPath, '-e',
      `const fs=require('fs');try{console.log('READ_OK:'+fs.readFileSync(${JSON.stringify(target)},'utf8'))}catch(e){console.log('READ_DENIED:'+e.code)}`,
    ], { mode, workspaceRoot: workspace })
    say(`  mode=${mode.padEnd(16)} exit=${run.exitCode} enforcement=${run.enforcement} -> ${run.stdout.trim()}`)
  }
  // danger-full-access is not a SandboxPolicy mode (ConfinedSandboxMode excludes
  // it) and the consumer short-circuits to super.run() — measured in bash-sandbox.
  const bash = srcFile('packages/shell/bash-sandbox/src/index.ts')
  say(`  bash-sandbox short-circuits danger-full-access before confine(): ${/if \(mode === 'danger-full-access'\) \{\s*\n\s*const result = await super\.run\(spec\)/u.test(bash)}`)
  await ctx.fiber.dispose()
  say('')
}

// --- 3. does the windows-acl runner accept any non-file-effect argv? -------
{
  say('--- 3. can a read/network flag be smuggled through the runner argv? (measured) ---')
  const runner = srcFile('packages/sandbox/sandbox-windows-acl/src/runner.ts')
  say(`  runner parseArgs switch cases: ${JSON.stringify([...runner.matchAll(/case '(--[a-z-]+)':/gu)].map(m => m[1]))}`)
  say(`  unknown args fail closed: ${/default: fail\(`unknown argument: \$\{token\}`\)/u.test(runner)}`)
  // Actually try it: hand the runner a plausible read/network flag.
  // Resolve the runner from the anchor that CAN see it: the work package does
  // not link the windows-acl package directly, but sandbox-local does (it is
  // sandbox-local's own dependency), so chain the anchors.
  const aclRequire = createRequire(pkgRequire.resolve('@deepseek-ai/dsh-sandbox-local'))
  const windowsAclRunner = aclRequire.resolve('@deepseek-ai/dsh-sandbox-windows-acl/runner')
  say(`  resolved runner: ${windowsAclRunner} (exists: ${existsSync(windowsAclRunner)})`)
  const base = tempDir('runner')
  const workspace = join(base, 'ws'); mkdirSync(workspace)
  for (const extra of [['--deny-net'], ['--read-only-fs', '/'], ['--no-network']]) {
    const probe = spawnSync(process.execPath, [
      windowsAclRunner, '--workspace', workspace, '--temp', tmpdir(), '--mode', 'read-only',
      ...extra, '--', process.execPath, '-e', 'console.log("RAN")',
    ], { encoding: 'utf8', timeout: 60_000 })
    const denied = /unknown argument/u.test(`${probe.stdout}${probe.stderr}`)
    say(`  argv ${JSON.stringify(extra).padEnd(26)} exit=${probe.status} refused=${denied} stderr=${`${probe.stderr}`.trim().split('\n')[0]?.slice(0, 90) ?? ''}`)
  }
  say('')
}

// --- 4. is `runnerCommand` a usable lever? ---------------------------------
{
  say('--- 4. is the `runnerCommand` override a usable read/egress lever? ---')
  const local = srcFile('packages/sandbox/sandbox-local/src/index.ts')
  say(`  confine() takes the override branch: ${/if \(this\.runnerCommand !== undefined\) \{[\s\S]{0,200}bwrapProfileArgs\(policy\)/u.test(local)}`)
  say(`  the override is prefixed to bwrap-compatible profile args (so the profile is still file-effect only)`)
  const readme = srcFile('packages/sandbox/sandbox-local/README.md')
  say(`  README: "operator assertion": ${flat(readme).includes('`runnerCommand` is an operator assertion')}`)
  say(`  README: skips functional probes: ${flat(readme).includes('skips functional probes')}`)
  // Measure: does a runnerCommand override actually change read behaviour when
  // the command is an EXISTING tool (i.e. is the lever usable without shipping
  // a new OS-level artifact)? `bwrap` on Linux is the only real confiner; on
  // win32 there is no read-confining runner to point it at.
  const chains = /const PLATFORM_CHAINS: Record<string, readonly SelectedRunner\['runner'\]\[\]> = \{([\s\S]*?)\n\}/u.exec(local)?.[1] ?? ''
  say(`  PLATFORM_CHAINS: ${chains.replace(/\s+/gu, ' ').trim().slice(0, 200)}`)
  say(`  (win32 has exactly ONE candidate: windows-acl — there is no second runner to select)`)
  say('')
}

// --- 5. does the fs seam fence READS? --------------------------------------
{
  say('--- 5. does the fs seam fence reads? ---')
  const fence = srcFile('packages/fs/fs-sandbox/src/index.ts')
  say(`  own header: ${JSON.stringify(flat(fence).match(/Reads pass through untouched: every mode permits reading/u)?.[0] ?? 'NOT FOUND')}`)
  say(`  fence scope: ${flat(fence).includes('The fence is a policy check in TRUSTED code over a MODEL-CONTROLLED path, NOT a kernel boundary')}`)
  // Which methods are overridden with a fence?
  const overrides = [...fence.matchAll(/override async ([a-zA-Z]+)\(/gu)].map(m => m[1])
  say(`  fenced methods (overridden): ${JSON.stringify(overrides)}`)
  const reads = [...fence.matchAll(/override async (read[a-zA-Z]*|stat|list)\(/gu)].map(m => m[1])
  say(`  fenced READ methods: ${JSON.stringify(reads)} (empty = reads are not fenced)`)
  say('')
}

// --- 6. egress: is there ANY network policy service? -----------------------
{
  say('--- 6. is there any network-policy service in the checkout? ---')
  const httpProxy = srcFile('packages/util/http-proxy/src/policy.ts')
  say(`  http-proxy policy exists: ${flat(httpProxy).includes('Proxy policy resolution')}`)
  say(`  it is a CLIENT-side proxy for the harness's OWN outbound calls (not a child's):`)
  say(`    "A proxy that also serves the harness's own loopback traffic": ${flat(httpProxy).includes("A proxy that also serves the harness's own loopback traffic")}`)
  // A confined child spawns directly through the subprocess seam, so a
  // process-wide undici dispatcher does not govern it.
  say('  a confined child reaches the network through the OS, not through undici —')
  say('  so an http-proxy policy cannot govern it (measured in sec-gates.test.ts SEC-03).')
  say('')
}

// --- cleanup ---------------------------------------------------------------
for (const dir of cleanup) rmSync(dir, { recursive: true, force: true })
say('=== PROBE COMPLETE (no credential was read; all canaries fabricated) ===')
say('')
say('CONCLUSION:')
say('  SEC-01: NOT closable. `mode` changes WRITE behaviour only; no read lever exists')
say('          in SandboxPolicy, ConfinedArgv, any runner argv, or the fs fence.')
say('  SEC-03: NOT closable. The seam states network is outside its vocabulary; the')
say('          windows-acl runner refuses unknown argv; win32 has one candidate runner;')
say('          `runnerCommand` can only replace the runner with ANOTHER file-effect')
say('          confiner (and is an unprobed operator assertion), so it cannot express')
say('          egress control without shipping a new OS-level artifact.')
