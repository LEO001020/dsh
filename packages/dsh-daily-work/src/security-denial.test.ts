/**
 * Denial fixtures for gates E01, E03 and E06 — the three that were NOT_RUN for
 * the honest reason "no designed fixture existed".
 *
 * WHAT THIS FILE IS FOR
 * =====================
 * E01 and E06 ask whether a real OS boundary denies something. The only way to
 * answer that is to build the thing, run it, and look. This file does that
 * against the REAL provider (`LocalSandboxProvider`), the REAL runner (the
 * built `sandbox-windows-acl` `lib/runner.js`), and the REAL composition the
 * product uses (`ctx.sandbox.confine()` -> `ctx.subprocess.spawn()`, which is
 * exactly what `@deepseek-ai/dsh-bash-sandbox` does).
 *
 * The assertions are written so that a PLATFORM LIMITATION is a passing
 * observation, not a hidden failure: where the platform does not deny, the test
 * asserts the observed non-denial and the gate status records it. Weakening an
 * assertion to manufacture green is the one thing this file must not do, so
 * every "the boundary did not hold" result is asserted as itself.
 *
 * WHAT WAS OBSERVED ON THIS HOST (Windows 11 26200, Node v24.18.0)
 * ==============================================================
 *   E01  enforcement is reported `partial`; a READ of a file OUTSIDE the
 *        workspace root SUCCEEDS under both read-only and workspace-write.
 *        WRITES outside are denied (EPERM) and writes inside are allowed only
 *        under workspace-write. So the boundary that exists is a WRITE
 *        boundary, and credential ISOLATION — which is a read claim — does not
 *        exist on this platform. E01 cannot be closed here.
 *   E03  the fence holds, and it is stronger than "it throws": the refusal
 *        leaves NO `sandbox/mode` event in the session log and `resolve()` keeps
 *        reporting the old mode, so a refused change is not partially applied.
 *        Proven against a REAL confined PTY (workspace-write). Under read-only
 *        no PTY can reach readiness at all, so there is nothing to fence there.
 *   E06  there is NO egress control. A confined child completes a real HTTP
 *        request to a loopback server, and a raw TCP connect to a public
 *        address, under both confined modes. `web-fetch-http`'s address guard
 *        is a TOOL-level SSRF check on URLs the model asks the fetch tool to
 *        retrieve; it is not a shell boundary and does not constrain a child
 *        process at all. E06's oracle ("an external boundary intercepts") is
 *        contradicted by observation.
 *
 * FIXTURES AND SAFETY
 * ===================
 * Every value is fabricated; see `qualification/fixtures/canary/README.md`.
 * `ctx.terminalController` is never touched anywhere in this file: it is the
 * human Web terminal and runs with system-user privilege, so reaching it from a
 * model-facing path would be escalation, not convenience. The test composition
 * below mounts no such service, and one test asserts that.
 *
 * The canary fixture is COPIED into a fresh temp directory per run rather than
 * pointed at in place: the Windows ACL rung materializes a STANDING,
 * inheritable ACE on the workspace root it is handed and never revokes it (that
 * ACE is the cross-session reuse cache, by design). Running this against the
 * checked-in fixture would leave standing ACEs on this repository.
 */
import { spawn } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import { unsupportedInbox } from '@deepseek-ai/dsh-agent-loop-testkit'
import type { SandboxPolicy } from '@deepseek-ai/dsh-sandbox'
import { LocalSandboxProvider } from '@deepseek-ai/dsh-sandbox-local'
import SandboxPolicyService, { setSandboxMode } from '@deepseek-ai/dsh-sandbox-policy'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { LocalSubprocessRuntime } from '@deepseek-ai/dsh-subprocess-local'
import TerminalSessionService from '@deepseek-ai/dsh-terminal'
import * as terminalBash from '@deepseek-ai/dsh-terminal-bash'
import { afterEach, describe, expect, it } from 'vitest'

/** The checked-in canary fixture, resolved from this file rather than from cwd. */
const FIXTURE = fileURLToPath(new URL('../../../qualification/fixtures/canary/', import.meta.url))

/**
 * The pinned DSH source root. `web-fetch-http` is not junctioned into this
 * package's `node_modules` (this project links only the packages it consumes),
 * so its `network.ts` is imported by path. `compatibility.lock.json` records
 * this checkout as the deployment's source of truth, so the default is the
 * recorded location and the override exists only for a relocated checkout.
 */
const DSH_SRC_ROOT = process.env.DSH_SRC_ROOT ?? 'D:/DSH/src/dsh-src'

/** Values that appear ONLY in the fabricated fixture. A hit means a boundary leaked. */
const CANARY_SECRET = 'CANARY-FAKE-SECRET-7f3a91c4-NOT-A-REAL-CREDENTIAL'
const CANARY_MARKER = 'CANARY-HARMLESS-MARKER-INSIDE-WORKSPACE'

/**
 * Collect-mode output cap for one confined child. The subprocess seam has NO
 * default disposition: every stdio field is explicit, so the caller's own
 * configuration decides it. A collect object (not `'pipe'`) is what makes the
 * output readable AFTER the child exits, through the offset-based reader.
 */
const COLLECT_MAX_BYTES = 4 * 1024 * 1024

/** Temp directories created by this file, removed after each test. */
const tempDirs: string[] = []
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/**
 * A private copy of the canary fixture: `<base>/workspace` (the policy root,
 * holding the harmless marker) and `<base>/outside` (holding the canary secret).
 * `outside` is a SIBLING of `workspace`, never a child, so it sits on the far
 * side of the only boundary `workspace-write` draws.
 */
function stageCanary(): { workspace: string; outside: string; secretPath: string; markerPath: string } {
  const base = mkdtempSync(join(tmpdir(), 'dsh-canary-'))
  tempDirs.push(base)
  const workspace = join(base, 'workspace')
  const outside = join(base, 'outside')
  mkdirSync(workspace, { recursive: true })
  cpSync(join(FIXTURE, 'outside'), outside, { recursive: true })
  cpSync(join(FIXTURE, 'workspace'), workspace, { recursive: true })
  return {
    workspace,
    outside,
    secretPath: join(outside, 'canary-secret.txt'),
    markerPath: join(workspace, 'canary-marker.txt'),
  }
}

/** A context with the real subprocess provider and the real sandbox provider mounted. */
async function mountSandbox(): Promise<{ ctx: Context; sandbox: LocalSandboxProvider }> {
  const ctx = new Context()
  await ctx.plugin(LocalSubprocessRuntime)
  await ctx.plugin(LocalSandboxProvider)
  return { ctx, sandbox: ctx.sandbox as LocalSandboxProvider }
}

/** One confined process's observed facts. */
interface ConfinedRun {
  exitCode: number | null
  stdout: string
  stderr: string
}

/**
 * Run `argv` confined under `policy` through the REAL composition the product
 * uses. `@deepseek-ai/dsh-bash-sandbox` calls `ctx.sandbox.confine()` and hands
 * the resulting argv to `ctx.subprocess.spawn()`; this is that path, with the
 * child's observations on stdout so a read-only run (which cannot write a file)
 * reports them the same way.
 */
async function runConfined(
  ctx: Context,
  sandbox: LocalSandboxProvider,
  argv: readonly string[],
  policy: SandboxPolicy,
): Promise<ConfinedRun> {
  const confined = await sandbox.confine(argv, policy)
  const handle = ctx.subprocess.spawn({
    argv: confined.argv,
    cwd: policy.workspaceRoot,
    stdio: { stdin: 'ignore', stdout: { maxBytes: COLLECT_MAX_BYTES }, stderr: { maxBytes: COLLECT_MAX_BYTES } },
    graceMs: 20_000,
  })
  const outcome = await handle.done
  const stdout = await handle.collected.stdout!.readFrom(0)
  const stderr = await handle.collected.stderr!.readFrom(0)
  return { exitCode: outcome.exitCode, stdout: stdout.text, stderr: stderr.text }
}

/** A Node one-liner the confined child runs; prints one JSON object on stdout. */
function probeScript(body: string): string[] {
  return [process.execPath, '-e', body]
}

/**
 * Wait for one child process WITHOUT blocking the event loop. `spawnSync` would
 * deadlock the loopback test: the server answering the confined child lives in
 * THIS process, and a synchronous wait starves it.
 */
function runAsync(argv: readonly string[], timeoutMs: number): Promise<ConfinedRun & { timedOut: boolean }> {
  return new Promise((resolve) => {
    const child = spawn(argv[0]!, argv.slice(1), { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8') })
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8') })
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      resolve({ exitCode: null, stdout, stderr, timedOut: true })
    }, timeoutMs)
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ exitCode: code, stdout, stderr, timedOut: false })
    })
  })
}

// ---------------------------------------------------------------------------
// E01 — credential isolation
// ---------------------------------------------------------------------------

describe('E01: credential isolation at the real OS boundary', () => {
  it('reports the enforcement the Windows ACL rung actually achieves, and its denial dialect', async () => {
    // The rung's OWN claim. `partial` is not a test artefact: the restricted
    // token must keep Everyone in its restricting lists (process init) and NTFS
    // hard links alias one file object across paths, so the backend refuses to
    // advertise an absolute promise. Pinning the reported value here means a
    // future change to that claim cannot pass unnoticed.
    const { ctx, sandbox } = await mountSandbox()
    const { workspace } = stageCanary()
    const confined = await sandbox.confine(['node', '--version'], { mode: 'read-only', workspaceRoot: workspace })
    expect(confined.enforcement).toBe('partial')
    // The dialect a consumer matches denials against. A denial is only counted
    // when the child's stderr carries one of THESE strings, so the list is part
    // of the contract, not decoration.
    expect(confined.denialSignatures).toEqual([
      'access is denied',
      'access to the path',
      'permission denied',
      'operation not permitted',
    ])
    // The argv really is wrapped, and by the built runner — not passed through.
    expect(confined.argv.length).toBeGreaterThan(2)
    expect(confined.argv[0]).toBe(process.execPath)
    expect(confined.argv[1]).toMatch(/runner\.js$/)
    expect(confined.argv).toContain('--mode')
    await ctx.fiber.dispose()
  })

  it('THE LIMITATION: a READ of the canary secret OUTSIDE the workspace SUCCEEDS under every confined mode', async () => {
    // This is the finding E01 exists to produce, and it is negative.
    // Enforcement is a WRITE boundary: the restricted token intersects only
    // write accesses, so an outside read is not merely un-denied, it is outside
    // the mechanism. Asserting the leak (rather than asserting a denial that
    // does not happen) is the only honest form of this test.
    const { ctx, sandbox } = await mountSandbox()
    const { workspace, secretPath } = stageCanary()
    expect(readFileSync(secretPath, 'utf8')).toContain(CANARY_SECRET)

    for (const mode of ['read-only', 'workspace-write'] as const) {
      const run = await runConfined(
        ctx,
        sandbox,
        probeScript(`process.stdout.write(require('node:fs').readFileSync(${JSON.stringify(secretPath)}, 'utf8'))`),
        { mode, workspaceRoot: workspace },
      )
      // The confined child ran, exited cleanly, and returned the secret verbatim.
      expect(run.exitCode, `mode=${mode} stderr=${run.stderr}`).toBe(0)
      expect(run.stdout, `mode=${mode}: an outside read was NOT denied`).toContain(CANARY_SECRET)
      // And it was not a "denial we misread as success": no denial signature appears.
      for (const signature of ['access is denied', 'permission denied', 'operation not permitted']) {
        expect(run.stderr.toLowerCase()).not.toContain(signature)
      }
    }
    await ctx.fiber.dispose()
  })

  it('the boundary that DOES hold is writes: outside is denied in both modes, inside only under workspace-write', async () => {
    // The positive half, so the negative finding above is precise rather than
    // "the sandbox does nothing". One probe reports all four outcomes, and the
    // child reports them on stdout because under read-only it cannot write the
    // file it would otherwise have used.
    const { ctx, sandbox } = await mountSandbox()
    const { workspace, outside, markerPath } = stageCanary()
    const outsideTarget = join(outside, 'attempted-write.txt')
    const insideTarget = join(workspace, 'attempted-write.txt')

    const script = (): string[] => probeScript(`
const fs = require('node:fs'); const o = {};
const attempt = (key, fn) => { try { fn(); o[key] = 'allowed' } catch (e) { o[key] = e.code || 'error' } };
attempt('readOutside', () => { o.readOutsideValue = fs.readFileSync(${JSON.stringify(join(outside, 'canary-secret.txt'))}, 'utf8').trim() });
attempt('readInside', () => { o.readInsideValue = fs.readFileSync(${JSON.stringify(markerPath)}, 'utf8').trim() });
attempt('writeOutside', () => fs.writeFileSync(${JSON.stringify(outsideTarget)}, 'x'));
attempt('writeInside', () => fs.writeFileSync(${JSON.stringify(insideTarget)}, 'x'));
process.stdout.write(JSON.stringify(o));
`)

    const readOnly = await runConfined(ctx, sandbox, script(), { mode: 'read-only', workspaceRoot: workspace })
    expect(readOnly.exitCode, readOnly.stderr).toBe(0)
    const ro = JSON.parse(readOnly.stdout) as Record<string, string>
    // Reads pass in both directions — the E01 limitation, restated as a fact.
    expect(ro.readOutside).toBe('allowed')
    expect(ro.readOutsideValue).toBe(CANARY_SECRET)
    expect(ro.readInside).toBe('allowed')
    expect(ro.readInsideValue).toBe(CANARY_MARKER)
    // Writes are denied EVERYWHERE under read-only, including inside the workspace.
    expect(ro.writeOutside).toBe('EPERM')
    expect(ro.writeInside).toBe('EPERM')
    expect(existsSync(outsideTarget)).toBe(false)
    expect(existsSync(insideTarget)).toBe(false)

    const workspaceWrite = await runConfined(ctx, sandbox, script(), { mode: 'workspace-write', workspaceRoot: workspace })
    expect(workspaceWrite.exitCode, workspaceWrite.stderr).toBe(0)
    const ww = JSON.parse(workspaceWrite.stdout) as Record<string, string>
    // workspace-write widens exactly one thing: the workspace root.
    expect(ww.writeOutside).toBe('EPERM')
    expect(ww.writeInside).toBe('allowed')
    expect(existsSync(outsideTarget)).toBe(false)
    expect(existsSync(insideTarget)).toBe(true)
    // The read leak is unchanged by the wider mode — it was never gated on mode.
    expect(ww.readOutsideValue).toBe(CANARY_SECRET)

    await ctx.fiber.dispose()
  })

  it('the ONE credential control that exists is an environment-name scrub in the subprocess seam, not the sandbox', async () => {
    // Worth pinning precisely, because it is easy to mistake for sandbox
    // behaviour: `@deepseek-ai/dsh-subprocess` drops credential-SHAPED names
    // (`/KEY|PASSWORD|SECRET|TOKEN/i`) and every `DSH_*` name from the ambient
    // parent environment before a child is spawned. It is a name heuristic in
    // trusted code, it runs in the subprocess seam (NOT the sandbox), and it
    // constrains nothing else — a credential stored in a FILE is still readable
    // (see the limitation test above), and an explicitly supplied `env` entry
    // survives the scrub by design.
    const { ctx } = await mountSandbox()
    const { workspace } = stageCanary()
    process.env.CANARY_FAKE_API_KEY = 'CANARY-FAKE-API-KEY-VALUE-0000-not-real'
    process.env.CANARY_HARMLESS_MARKER = CANARY_MARKER
    process.env.DSH_CANARY_INTERNAL = 'dsh-internal-must-not-leak'
    try {
      const handle = ctx.subprocess.spawn({
        argv: probeScript(`process.stdout.write(JSON.stringify({ key: process.env.CANARY_FAKE_API_KEY ?? null, marker: process.env.CANARY_HARMLESS_MARKER ?? null, dsh: process.env.DSH_CANARY_INTERNAL ?? null }))`),
        cwd: workspace,
        stdio: { stdin: 'ignore', stdout: { maxBytes: COLLECT_MAX_BYTES }, stderr: { maxBytes: COLLECT_MAX_BYTES } },
        graceMs: 10_000,
      })
      await handle.done
      const out = await handle.collected.stdout!.readFrom(0)
      const observed = JSON.parse(out.text) as { key: string | null; marker: string | null; dsh: string | null }
      // Credential-shaped name: scrubbed. Non-credential-shaped name: survives.
      expect(observed.key).toBeNull()
      expect(observed.marker).toBe(CANARY_MARKER)
      // Harness identity: scrubbed, so a child cannot learn the host's DSH state.
      expect(observed.dsh).toBeNull()
    } finally {
      delete process.env.CANARY_FAKE_API_KEY
      delete process.env.CANARY_HARMLESS_MARKER
      delete process.env.DSH_CANARY_INTERNAL
    }
    await ctx.fiber.dispose()
  })

  it('the sandbox vocabulary cannot express a credential or read policy — it is file-effect only', async () => {
    // Structural, not behavioural: `SandboxPolicy` carries exactly mode +
    // workspaceRoot (+ sessionId). There is no field a caller could set to
    // restrict reads, so E01 has no lever in this seam even in principle.
    const { ctx, sandbox } = await mountSandbox()
    const { workspace } = stageCanary()
    const policy: SandboxPolicy = { mode: 'read-only', workspaceRoot: workspace }
    const confined = await sandbox.confine(['node', '--version'], policy)
    expect(Object.keys(confined).sort()).toEqual(['argv', 'denialSignatures', 'enforcement', 'runnerFailureRules'])
    // No network, read, credential, or egress term anywhere in the wrap's facts.
    const serialized = JSON.stringify(confined).toLowerCase()
    for (const term of ['egress', 'network', 'credential', 'readonlypaths', 'denyread', 'secret']) {
      expect(serialized).not.toContain(term)
    }
    await ctx.fiber.dispose()
  })

  it('mounts no terminalController, so no test here can reach the human Web terminal', async () => {
    // The constraint stated in this file's header, asserted rather than trusted:
    // `ctx.terminalController` is the human Web terminal and runs with
    // system-user privilege. Nothing in this file names it, and the composition
    // under test cannot obtain it.
    const { ctx } = await mountSandbox()
    expect(ctx.get('terminalController' as never)).toBeUndefined()
    await ctx.fiber.dispose()
  })
})

// ---------------------------------------------------------------------------
// E03 — permission change with a live PTY
// ---------------------------------------------------------------------------

/** One real PTY composition: registry + 'shell' backend + real sandbox + real subprocess. */
async function mountTerminal(mode: string, workspaceRoot: string, startupTimeoutMs = 8_000) {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SandboxPolicyService, { mode, workspaceRoot } as never)
  await ctx.plugin(TerminalSessionService)
  await ctx.plugin(LocalSubprocessRuntime)
  await ctx.plugin(LocalSandboxProvider)
  await ctx.plugin(terminalBash as never, {
    backendType: 'shell',
    // pwsh, not bash: `/bin/bash` from Git Bash is not a Windows executable
    // path the PTY allocator can start, so the bash dialect cannot produce a
    // live PTY here at all.
    shellDialect: 'pwsh',
    rows: 24,
    cols: 80,
    idleSilenceMs: 300,
    pollIntervalMs: 50,
    handoffGraceMs: 100,
    timeoutMs: startupTimeoutMs,
    disposeGraceMs: 1_000,
  } as never)
  const session = ctx.sessions.create(SessionId(`denial-${mode}-${String(startupTimeoutMs)}`))
  const ownerFiber = await ctx.plugin(() => {})
  const owner = {
    id: session.id,
    options: {},
    session,
    inbox: unsupportedInbox(),
    status: 'idle' as const,
    ctx: ownerFiber.ctx,
    send: () => {},
    followup: () => {},
    steer: () => {},
    inject: () => {},
    cancel() {},
    runMaintenance: () => Promise.resolve(),
    whenIdle: () => Promise.resolve(),
  } as unknown as Agent
  await ctx.agents.register(owner)
  return { ctx, owner, session }
}

/** The upstream fence's refusal text, in the pieces the contract actually pins. */
const FENCE_PREFIX = 'cannot change sandbox mode from'
const FENCE_SUFFIX = 'while persistent terminal sessions are open or being created'

describe('E03: a sandbox-mode change is refused while a PTY is live', () => {
  it('refuses the change, and the refusal is TOTAL: no event is logged and the resolved mode is unchanged', async () => {
    // The oracle is "follow upstream's refusal, or close then change". A fence
    // that threw AFTER appending the event would still be a hole: the event is
    // the store, so a logged change is an applied change on replay. Asserting
    // only "it throws" would miss that, so the log and the resolved mode are
    // both checked.
    // The workspace root is a STAGED COPY, never the checked-in fixture: the
    // ACL rung materializes a standing inheritable ACE on the root it is given.
    const { ctx, owner, session } = await mountTerminal('workspace-write', stageCanary().workspace)
    const created = await ctx.terminals.spawn(owner, { type: 'shell' })
    try {
      expect(created.sessionId).toBeTruthy()
      // The fence keys on owner ACTIVITY, not on a session id, so this is the
      // predicate the refusal is built from.
      expect(ctx.terminals.hasOwnerActivity(owner)).toBe(true)
      expect(session.snapshotEvents().filter(event => event.type === 'sandbox/mode')).toHaveLength(0)

      expect(() => { setSandboxMode(session, 'read-only') }).toThrow(/cannot change sandbox mode from/u)
      expect(() => { setSandboxMode(session, 'read-only') }).toThrow(FENCE_PREFIX)
      expect(() => { setSandboxMode(session, 'read-only') }).toThrow(FENCE_SUFFIX)
      // Both mode names are in the message, so the operator sees what was refused.
      expect(() => { setSandboxMode(session, 'read-only') }).toThrow(/"workspace-write" to "read-only"/u)

      // The refusal did not half-apply.
      expect(session.snapshotEvents().filter(event => event.type === 'sandbox/mode')).toHaveLength(0)
      expect(ctx.sandboxPolicy.resolve({ session }).mode).toBe('workspace-write')
    } finally {
      await ctx.terminals.kill(owner, created.sessionId)
    }
    // Close, then change: the sanctioned path works, so the fence is a
    // sequencing requirement and not a lock on the mode.
    expect(ctx.terminals.hasOwnerActivity(owner)).toBe(false)
    expect(() => { setSandboxMode(session, 'read-only') }).not.toThrow()
    expect(ctx.sandboxPolicy.resolve({ session }).mode).toBe('read-only')
    expect(session.snapshotEvents().filter(event => event.type === 'sandbox/mode')).toHaveLength(1)
    await ctx.fiber.dispose()
  }, 120_000)

  it('fences only the owner with the live PTY: an unrelated session may change mode at will', async () => {
    // A fence that keyed on the deployment or on the terminal registry rather
    // than on the exact owner would be an availability bug, and the upstream
    // predicate is explicitly owner-scoped. Pin that it is not over-broad.
    const { ctx, owner, session } = await mountTerminal('workspace-write', stageCanary().workspace)
    const created = await ctx.terminals.spawn(owner, { type: 'shell' })
    try {
      const unrelated = ctx.sessions.create(SessionId('unrelated-owner'))
      expect(ctx.terminals.hasOwnerActivity(owner)).toBe(true)
      expect(() => { setSandboxMode(unrelated, 'read-only') }).not.toThrow()
      expect(() => { setSandboxMode(unrelated, 'read-only') }).not.toThrow()
      expect(ctx.sandboxPolicy.resolve({ session: unrelated }).mode).toBe('read-only')
      // The fenced session is untouched by its neighbour's change.
      expect(ctx.sandboxPolicy.resolve({ session }).mode).toBe('workspace-write')
    } finally {
      await ctx.terminals.kill(owner, created.sessionId)
    }
    await ctx.fiber.dispose()
  }, 120_000)

  it('closes the other half of the oracle: the widened capability is gone from the PTY the moment it is closed', async () => {
    // "The old PTY does not retain capability beyond the new authorization."
    // Because the fence forbids the change WHILE the PTY is live, the state
    // "a live PTY minted under workspace-write, with the session now read-only"
    // is unreachable. The reachable sequence is close-then-change, and after it
    // the NEXT confined execution must be read-only. Proven by running one.
    const { ctx, owner, session } = await mountTerminal('workspace-write', stageCanary().workspace)
    const created = await ctx.terminals.spawn(owner, { type: 'shell' })
    await ctx.terminals.kill(owner, created.sessionId)
    setSandboxMode(session, 'read-only')

    const { workspace } = stageCanary()
    const target = join(workspace, 'after-downgrade.txt')
    // Resolve through the SERVICE, so the mode that reaches the sandbox is the
    // session's folded override and not a value this test supplied.
    const policy = ctx.sandboxPolicy.resolve({ session })
    expect(policy.mode).toBe('read-only')
    const run = await runConfined(
      ctx,
      ctx.sandbox as LocalSandboxProvider,
      probeScript(`try { require('node:fs').writeFileSync(${JSON.stringify(target)}, 'x'); process.stdout.write('allowed') } catch (e) { process.stdout.write(e.code || 'error') }`),
      { ...policy, mode: 'read-only', workspaceRoot: workspace },
    )
    expect(run.exitCode, run.stderr).toBe(0)
    expect(run.stdout.trim()).toBe('EPERM')
    expect(existsSync(target)).toBe(false)
    await ctx.fiber.dispose()
  }, 120_000)

  it('THE LIMITATION: under read-only no PTY can reach readiness, so there is nothing to fence there', async () => {
    // E03's refusal is only reachable in a mode where a PTY can actually start.
    // On this host read-only cannot start one: the confined shell never
    // completes the prompt handshake, and the backend reports its own startup
    // timeout. This is a REAL boundary of the E03 evidence — the fence is
    // proven under workspace-write and is UNREACHABLE under read-only — and it
    // is also a user-visible capability limit worth recording: the strictest
    // mode has no persistent terminal.
    const { ctx, owner } = await mountTerminal('read-only', stageCanary().workspace, 5_000)
    await expect(ctx.terminals.spawn(owner, { type: 'shell' })).rejects.toThrow(/did not reach readiness/u)
    // The failure rolled back: no session was published for the failed spawn.
    expect(ctx.terminals.hasOwnerActivity(owner)).toBe(false)
    await ctx.fiber.dispose()
  }, 120_000)
})

// ---------------------------------------------------------------------------
// E06 — network egress
// ---------------------------------------------------------------------------

describe('E06: network egress from a confined command', () => {
  it('THE FINDING: a confined child completes a real HTTP request to a loopback server', async () => {
    // E06's oracle is "an external boundary intercepts". None does. The server
    // is started by THIS test on 127.0.0.1 and answered while the confined child
    // ran, so the request is a completed round trip, not a connection attempt.
    // The child is spawned asynchronously: a synchronous wait would block the
    // event loop that has to answer it, and that would look like a denial.
    const { ctx, sandbox } = await mountSandbox()
    const { workspace } = stageCanary()
    const server = createServer((_request, response) => { response.end('CANARY-LOOPBACK-ANSWER') })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as AddressInfo).port
    try {
      const script = `
const http = require('node:http');
const request = http.get({ host: '127.0.0.1', port: ${String(port)}, path: '/', timeout: 8000 }, (response) => {
  let body = '';
  response.on('data', (chunk) => { body += chunk });
  response.on('end', () => { process.stdout.write('HTTP_OK:' + body); process.exit(0) });
});
request.on('error', (error) => { process.stdout.write('HTTP_ERR:' + error.code); process.exit(0) });
request.on('timeout', () => { process.stdout.write('HTTP_TIMEOUT'); process.exit(0) });
`
      for (const mode of ['read-only', 'workspace-write'] as const) {
        const confined = await sandbox.confine(probeScript(script), { mode, workspaceRoot: workspace })
        const run = await runAsync(confined.argv, 30_000)
        expect(run.timedOut, `mode=${mode}: the confined request never settled`).toBe(false)
        // The request completed AND the loopback server's body came back.
        expect(run.stdout, `mode=${mode} stderr=${run.stderr}`).toContain('HTTP_OK:CANARY-LOOPBACK-ANSWER')
        expect(run.exitCode, `mode=${mode} stderr=${run.stderr}`).toBe(0)
        // No denial signature appeared: this is not a denied request read as success.
        for (const signature of confined.denialSignatures) {
          expect(run.stderr.toLowerCase()).not.toContain(signature)
        }
      }
    } finally {
      await new Promise<void>(resolve => { server.close(() => { resolve() }) })
    }
    await ctx.fiber.dispose()
  }, 120_000)

  it('a confined child also reaches a PUBLIC address: the loopback result is not an artefact of the local server', async () => {
    // The loopback case alone could be dismissed as "loopback is special". This
    // one leaves the machine. The network may legitimately be unavailable, so
    // the assertion is the deterministic part — the sandbox did not deny it,
    // and any failure came from the network layer — and the observed outcome is
    // asserted to be one of the two permitted shapes.
    const { ctx, sandbox } = await mountSandbox()
    const { workspace } = stageCanary()
    const script = `
const net = require('node:net');
const socket = net.connect({ host: '1.1.1.1', port: 443 });
socket.setTimeout(8000);
socket.on('connect', () => { process.stdout.write('PUBLIC_CONNECT_OK'); socket.destroy() });
socket.on('timeout', () => { process.stdout.write('PUBLIC_TIMEOUT'); socket.destroy() });
socket.on('error', (error) => { process.stdout.write('PUBLIC_ERR:' + error.code) });
`
    const confined = await sandbox.confine(probeScript(script), { mode: 'read-only', workspaceRoot: workspace })
    const run = await runAsync(confined.argv, 30_000)
    expect(run.timedOut).toBe(false)
    const observed = run.stdout.trim()
    // The child reported a transport outcome of its own: connected, timed out,
    // or an OS-level network error. Any of those means the attempt was MADE and
    // the network layer — not the sandbox — decided the result.
    expect(observed).toMatch(/^PUBLIC_(CONNECT_OK|TIMEOUT|ERR:[A-Z_]+)$/u)
    // The decisive part: whatever happened, it was NOT confinement refusing egress.
    for (const signature of confined.denialSignatures) {
      expect(run.stderr.toLowerCase()).not.toContain(signature)
    }
    expect(run.stderr).not.toContain('windows-acl-run:')
    // And the runner did not fail before the child ran (a runner failure would
    // mean the child never attempted anything, which would invalidate this test).
    expect(run.exitCode).not.toBe(127)
    await ctx.fiber.dispose()
  }, 120_000)

  it('the ONLY egress-adjacent control in DSH is web-fetch-http\'s SSRF guard, and it constrains the fetch TOOL, not a shell', async () => {
    // Read and exercised for real. The guard resolves a hostname once and
    // refuses the whole answer set if any address is not globally routable, then
    // pins the connection to the validated addresses. That is a genuine control
    // — and it applies to the URL the model hands the fetch tool. It has no
    // relationship to `ctx.sandbox`, which cannot express a network policy at
    // all, and a confined child bypasses it entirely (proven above).
    const networkModule = join(DSH_SRC_ROOT, 'packages/web/web-fetch-http/src/network.ts')
    expect(existsSync(networkModule), `network.ts not found at ${networkModule}`).toBe(true)
    // `/* @vite-ignore */` because the specifier is a runtime absolute path to a
    // file OUTSIDE this package: without it the bundler tries (and warns) to
    // resolve the template literal as a static asset.
    const network = await import(/* @vite-ignore */ pathToFileURL(networkModule).href) as {
      isPublicIpAddress: (address: string) => boolean
      isNonPublicIpLiteral: (hostname: string) => boolean
      resolvePublicAddresses: (hostname: string, signal: AbortSignal) => Promise<unknown>
    }
    // Private, loopback, and link-local (cloud metadata) destinations are refused.
    expect(network.isPublicIpAddress('127.0.0.1')).toBe(false)
    expect(network.isPublicIpAddress('::1')).toBe(false)
    expect(network.isPublicIpAddress('169.254.169.254')).toBe(false)
    expect(network.isPublicIpAddress('10.0.0.1')).toBe(false)
    // A public unicast address is permitted — the guard is a destination filter,
    // not an egress block, which is the distinction E06 turns on.
    expect(network.isPublicIpAddress('93.184.216.34')).toBe(true)
    expect(network.isNonPublicIpLiteral('127.0.0.1')).toBe(true)
    // The refusal is real, and it carries a structured code a caller can branch on.
    await expect(network.resolvePublicAddresses('127.0.0.1', new AbortController().signal))
      .rejects.toThrow(/resolves to a non-public IP address/u)
    await expect(network.resolvePublicAddresses('localhost', new AbortController().signal))
      .rejects.toThrow(/resolves to a non-public IP address/u)
  }, 60_000)

  it('the sandbox seam has no egress vocabulary to enforce: its wrap carries no network fact', async () => {
    // Same structural point as E01's vocabulary test, from the egress side. The
    // seam's own README states it: "File effects are the whole policy
    // vocabulary — the seam expresses no network, process, syscall, device, or
    // credential restrictions." Pinned here as an executable fact.
    const { ctx, sandbox } = await mountSandbox()
    const { workspace } = stageCanary()
    const confined = await sandbox.confine(['node', '--version'], { mode: 'workspace-write', workspaceRoot: workspace })
    expect(Object.keys(confined).sort()).toEqual(['argv', 'denialSignatures', 'enforcement', 'runnerFailureRules'])
    expect(JSON.stringify(confined).toLowerCase()).not.toContain('egress')
    // And the runner's argv carries only file-effect arguments.
    const modeIndex = confined.argv.indexOf('--mode')
    expect(modeIndex).toBeGreaterThan(-1)
    expect(['read-only', 'workspace-write']).toContain(confined.argv[modeIndex + 1])
    await ctx.fiber.dispose()
  })
})

// ---------------------------------------------------------------------------
// Fixture integrity — the tests above are only meaningful if the canary is real
// ---------------------------------------------------------------------------

describe('the canary fixture is fabricated and self-consistent', () => {
  it('ships the marker inside the workspace and the secret outside it', () => {
    expect(readFileSync(join(FIXTURE, 'workspace/canary-marker.txt'), 'utf8').trim()).toBe(CANARY_MARKER)
    expect(readFileSync(join(FIXTURE, 'outside/canary-secret.txt'), 'utf8').trim()).toBe(CANARY_SECRET)
    // The credential-shaped file exists for the scrub probe and is equally fake.
    const env = readFileSync(join(FIXTURE, 'outside/canary-credential-shaped.env'), 'utf8')
    expect(env).toContain('CANARY_FAKE_API_KEY=')
    expect(env).toContain('FABRICATED')
  })

  it('stages a copy rather than using the fixture in place, so no standing ACE lands on this repository', () => {
    // The Windows ACL rung writes a STANDING inheritable ACE on the workspace
    // root it is given and never revokes it. If the fixture path itself were
    // handed to the sandbox, this repository would carry that ACE afterwards.
    // Assert the staging helper produces paths outside the fixture.
    const staged = stageCanary()
    expect(staged.workspace).not.toContain('qualification')
    expect(staged.secretPath.startsWith(staged.outside)).toBe(true)
    // And the two are siblings: `outside` is never inside `workspace`.
    expect(staged.secretPath.startsWith(staged.workspace)).toBe(false)
    writeFileSync(join(staged.workspace, 'scratch.txt'), 'ok')
    expect(existsSync(join(FIXTURE, 'workspace/scratch.txt'))).toBe(false)
  })
})
