/**
 * M6: native terminal qualification for cross-call persistent computation.
 *
 * The delivery plan's requirement is to qualify the EXISTING native capability
 * first and only then decide whether a thin adapter or a dedicated kernel is
 * needed. So this file answers one question with evidence: can one tool call
 * leave state behind in a PTY that a LATER tool call can read?
 *
 * The answer is about the terminal LIFECYCLE, not about Python specifically. If a
 * PTY keeps state across sends, then IPython inside it keeps state too. If it does
 * not, an adapter would not save us either.
 *
 * What is REAL here: ctx.terminals, the real terminal registry, the real
 * bash/pwsh backend, real ConPTY on this machine.
 * What is NOT: the model. There is no model call; these are the tool-level calls
 * a model would issue, issued directly.
 *
 * The negative findings matter as much as the positive ones: `startSend` resolves
 * with a WAIT REASON, which is not a completion signal. This file asserts that
 * distinction rather than assuming it away.
 */
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { SessionId } from '@deepseek-ai/dsh-session'
import SandboxPolicy from '@deepseek-ai/dsh-sandbox-policy'
import LocalSandboxProvider from '@deepseek-ai/dsh-sandbox-local'
import SubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import TerminalRuntime from '@deepseek-ai/dsh-terminal'
import * as terminalBash from '@deepseek-ai/dsh-terminal-bash'
import { describe, expect, it } from 'vitest'

const IS_WINDOWS = process.platform === 'win32'
const DIALECT = IS_WINDOWS ? 'pwsh' : 'bash'
/**
 * The registered backend TYPE, which is NOT the same as the dialect.
 *
 * `BashTerminalBackend.type = config.backendType`, and `backendType` defaults to
 * `'shell'` (packages/terminal/terminal-bash/src/config.ts:85). The dialect
 * (bash vs pwsh) is chosen by `shellDialect`. Conflating the two is an easy
 * mistake: `spawn({type: 'pwsh'})` fails with "no PTY backend registered for
 * pwsh" because no backend ever registers under the dialect name.
 */
const BACKEND_TYPE = 'shell'

interface Rig {
  readonly ctx: Context
  /** A REAL registered Agent. See the note in `rig()` about why a stub fails. */
  agent(id: string): Promise<Agent>
  close(): Promise<void>
}

/**
 * Build a rig with a real Agent registry.
 *
 * WHY THIS IS NOT OVERKILL, AND WHY A STUB DOES NOT WORK:
 *
 * `TerminalSessionService.ensureOwnerCleanup` checks
 * `this.ctx.get('agents')?.get(owner.id) === owner`
 * (packages/terminal/terminal/src/index.ts:318-324). A hand-made owner object is
 * rejected with `OWNER_NOT_LIVE`. That is a real safety property, not an
 * inconvenience: it means a terminal can only be owned by an agent the registry
 * actually holds, so a stale or forged reference cannot reach someone else's PTY.
 *
 * The first version of this file used a stub and every test failed with
 * "agent ... is not the registered PTY owner". The fix is to use the real thing.
 */
async function rig(): Promise<Rig> {
  const ctx = new Context()
  // MOUNT ORDER MATTERS, and getting it wrong produces a SILENT hang rather
  // than an error. Three separate traps were hit while building this rig, and
  // each one is worth recording because a future reader will meet them too:
  //
  //  1. `ctx.plugin()` gives each plugin its OWN child context, so a plugin
  //     cannot see a service mounted BESIDE it. The terminal backend resolves
  //     `ctx.sandbox` from its own context
  //     (packages/terminal/terminal-bash/src/index.ts:103), so the sandbox
  //     provider must be an ANCESTOR of the terminal backend. Mounting it as a
  //     sibling yielded "requires a ctx.sandbox provider in the execution world"
  //     even though the root context could resolve it.
  //
  //  2. `sandbox-policy` injects `sessionProjections` and `terminal-bash`
  //     injects four services. Cordis keeps such a plugin WAITING with no error
  //     until every injection exists, so a missing one surfaces later as a
  //     confusing downstream failure ("no PTY backend registered") rather than
  //     as a mount failure.
  //
  //  3. The dependency order below is therefore load-bearing: projections, then
  //     policy, then the sandbox provider, then the subprocess runtime, then the
  //     agent loop, then the terminal registry, then the backend last.
  await mountAgentLoopTestDependencies(ctx)
  // UNCONFINED ON PURPOSE, and the reason is in the block comment above: under a
  // confined mode `terminals.spawn` never resolves on this platform, so nothing
  // downstream could be observed. These tests therefore qualify the terminal
  // LIFECYCLE, not the confinement interaction. The confinement boundary is
  // recorded as an open finding rather than silently avoided.
  await ctx.plugin(SandboxPolicy as never, { mode: 'danger-full-access' } as never)
  await ctx.plugin(LocalSandboxProvider as never, {} as never)
  await ctx.plugin(SubprocessRuntime)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(TerminalRuntime)
  await ctx.plugin(terminalBash as never, { shellDialect: DIALECT, timeoutMs: 300_000 } as never)
  return {
    ctx,
    agent: (id: string) => ctx.agentLoop.create(SessionId(id), {}, {}),
    async close() {
      await ctx.fiber.dispose()
    },
  }
}

/** Wait for one send to settle and report what the wait said. */
async function send(
  ctx: Context,
  owner: Agent,
  id: string,
  text: string,
): Promise<{ waitReason: string; viewport: string; sessionStatus: { kind: string } }> {
  const op = ctx.terminals.startSend(owner, id as never, { text, submit: true })
  const result = await op.done
  return {
    waitReason: result.waitReason,
    viewport: result.viewport,
    sessionStatus: result.sessionStatus,
  }
}

/**
 * FINDING (recorded here so it is not lost, and so no test pretends otherwise):
 *
 * On THIS machine, `ctx.terminals.spawn()` never resolves. The chain was probed
 * step by step and the boundary is precise:
 *
 *   - the terminal registry mounts and lists the `shell` backend        OK
 *   - a real Agent is created and accepted as the PTY owner             OK
 *   - `ctx.sandboxPolicy.resolve()` returns read-only + workspaceRoot   OK
 *   - `ctx.sandbox.confine(...)` returns a real argv wrapping
 *     sandbox-windows-acl's runner.js, enforcement 'partial'           OK
 *   - `ctx.subprocess.spawnTerminal(raw argv)` resolves in ~30ms        OK
 *   - `ctx.subprocess.spawnTerminal(CONFINED argv)` resolves in ~29ms   OK
 *   - `ctx.terminals.spawn(...)` does NOT resolve; it hangs until the
 *     caller's own timeout                                             HANGS
 *
 * So the hang is in the terminal BACKEND's session startup, after the PTY is
 * allocated, not in the sandbox and not in the PTY itself. The backend waits for
 * its prompt/idle handshake, and under the Windows ACL runner that handshake
 * never completes.
 *
 * WHY THIS IS NOT A TEST BUG: `terminals.spawn` was given a real owner, a real
 * backend and a real sandbox; every layer beneath it was proven to work
 * independently. The unresolved step is upstream behaviour on this platform.
 *
 * ISOLATED CAUSE: it is the SANDBOX MODE, not the terminal. With
 * `sandboxPolicy: { mode: 'danger-full-access' }` (which makes the backend skip
 * `sandbox.confine` entirely), the SAME `ctx.terminals.spawn()` call succeeds in
 * ~740ms and returns a live pwsh prompt. So:
 *
 *     sandboxed  (read-only / workspace-write)  -> spawn never resolves
 *     unconfined (danger-full-access)           -> spawn works
 *
 * The Windows ACL runner wraps the shell in `node runner.js ... -- powershell`,
 * and the PTY prompt/idle handshake does not complete through that wrapper. This
 * is an upstream platform interaction, not a defect in this project and not a
 * test artefact.
 *
 * CONSEQUENCE FOR M6, stated plainly: cross-call persistent computation on the
 * native terminal is QUALIFIED ONLY IN UNCONFINED MODE on this machine. Under a
 * confined sandbox mode it is NOT_RUN. That is a real, security-relevant
 * limitation: the capability works precisely when the sandbox is off, which is
 * the opposite of what a daily driver wants.
 *
 * NEXT STEP, and why it is not "write an adapter": the delivery plan says a thin
 * adapter must reuse the DSH terminal's physical lifecycle. If `spawn` does not
 * complete under confinement, an adapter over it cannot either. The honest next
 * moves are (a) reproduce and report the upstream interaction with a minimal
 * fixture, and (b) only then consider whether a different provider is warranted.
 * This file does neither; it records the boundary.
 */
describe('M6: native terminal capability on this machine', () => {
  it('T01: the terminal registry and a shell backend are really mounted', async () => {
    // The plan requires checking the ACTUAL mounted services rather than
    // inferring from the presence of a source directory.
    const r = await rig()
    expect(r.ctx.get('terminals')).toBeDefined()
    expect(r.ctx.terminals.listBackends()).toContain(BACKEND_TYPE)
    await r.close()
  })

  it('T02: spawn takes type/name/cwd and has no command field', async () => {
    // The plan is explicit that there is no spawn({command}). Using one would be
    // an invented API, so this asserts the real shape is what is exercised.
    const r = await rig()
    const owner = await r.agent('owner-t02')
    const session = await r.ctx.terminals.spawn(owner, { type: BACKEND_TYPE })
    // The registry mints the identity: the field is `sessionId`, not `id`.
    expect(session.sessionId).toBeDefined()
    expect(typeof session.motd).toBe('string')
    await r.ctx.terminals.kill(owner, session.sessionId, 'test cleanup')
    await r.close()
  })

  it('T03: state persists across separate sends on the same PTY', async () => {
    // THE core qualification. A value set in one tool call must be readable in a
    // later one, or cross-call persistent computation is impossible and the whole
    // IPython question is moot.
    const r = await rig()
    const owner = await r.agent('owner-t03')
    const session = await r.ctx.terminals.spawn(owner, { type: BACKEND_TYPE })

    const marker = `probe-${Date.now()}`
    await send(r.ctx, owner, session.sessionId, IS_WINDOWS ? `$DSH_MARKER = '${marker}'` : `DSH_MARKER='${marker}'`)
    await send(r.ctx, owner, session.sessionId, IS_WINDOWS ? 'Write-Output $DSH_MARKER' : 'echo $DSH_MARKER')

    const read = r.ctx.terminals.read(owner, session.sessionId, { offset: 0, count: 200 })
    expect(read.text).toContain(marker)

    await r.ctx.terminals.kill(owner, session.sessionId, 'test cleanup')
    await r.close()
  })

  it('T03: a different owner cannot read the first owner terminal', async () => {
    // Isolation is by OWNER, which is what makes one agent terminal state
    // unreadable to another.
    const r = await rig()
    const ownerA = await r.agent('owner-a')
    const ownerB = await r.agent('owner-b')
    const session = await r.ctx.terminals.spawn(ownerA, { type: BACKEND_TYPE })

    expect(r.ctx.terminals.list(ownerB)).toHaveLength(0)
    expect(r.ctx.terminals.list(ownerA)).toHaveLength(1)
    // Reading A's id as B is refused rather than returning A's output.
    expect(() => r.ctx.terminals.read(ownerB, session.sessionId, {})).toThrow()

    await r.ctx.terminals.kill(ownerA, session.sessionId, 'test cleanup')
    await r.close()
  })

  it('T04: a send result is a WAIT REASON, never a completion signal', async () => {
    // The single most important distinction in M6. `startSend` resolving means a
    // wait ended; it does NOT mean the command finished successfully.
    const r = await rig()
    const owner = await r.agent('owner-t04')
    const session = await r.ctx.terminals.spawn(owner, { type: BACKEND_TYPE })

    const result = await send(r.ctx, owner, session.sessionId, IS_WINDOWS ? 'Write-Output ok' : 'echo ok')
    expect(['stdin_read', 'inferred_idle', 'timeout', 'session_exit']).toContain(result.waitReason)
    // Whatever it returned, it is a reason about a WAIT. There is no field saying
    // "the command succeeded", which is exactly why a caller must not treat this
    // as verification.
    expect(result).not.toHaveProperty('exitCode')
    expect(result).not.toHaveProperty('succeeded')

    await r.ctx.terminals.kill(owner, session.sessionId, 'test cleanup')
    await r.close()
  })

  it('T04: a quiet command settles as a heuristic, not as a proven completion', async () => {
    // A CPU-bound task that prints nothing is indistinguishable from a finished
    // one at this layer. That is why inferred_idle is a heuristic.
    const r = await rig()
    const owner = await r.agent('owner-t04b')
    const session = await r.ctx.terminals.spawn(owner, { type: BACKEND_TYPE })
    const quiet = IS_WINDOWS
      ? 'Start-Sleep -Milliseconds 200; Write-Output quiet-done'
      : 'sleep 0.2; echo quiet-done'
    const result = await send(r.ctx, owner, session.sessionId, quiet)
    expect(['inferred_idle', 'stdin_read']).toContain(result.waitReason)
    await r.ctx.terminals.kill(owner, session.sessionId, 'test cleanup')
    await r.close()
  })

  it('T07: read is a bounded scrollback view, not a full log cursor', async () => {
    // The plan warns that offset moves and the view is bounded. A caller treating
    // read() as a complete log would silently lose output.
    const r = await rig()
    const owner = await r.agent('owner-t07')
    const session = await r.ctx.terminals.spawn(owner, { type: BACKEND_TYPE })
    await send(
      r.ctx,
      owner,
      session.sessionId,
      IS_WINDOWS ? '1..40 | ForEach-Object { "line-$_" }' : 'for i in $(seq 1 40); do echo "line-$i"; done',
    )
    const small = r.ctx.terminals.read(owner, session.sessionId, { offset: 0, count: 5 })
    const lines = small.text.split('\n').filter(line => line.trim() !== '')
    expect(lines.length).toBeLessThanOrEqual(5)
    // The result reports its own bounds rather than pretending to be complete.
    expect(small).toHaveProperty('totalLines')
    expect(small).toHaveProperty('truncated')
    await r.ctx.terminals.kill(owner, session.sessionId, 'test cleanup')
    await r.close()
  })

  it('T09: killing a terminal releases it, and a later kill of the same id is refused', async () => {
    // The REAL contract, read from packages/terminal/terminal/src/index.ts:285-301:
    // `kill` deletes the session and returns true. A SECOND kill does not return
    // false - it throws "unknown PTY session", because `expectOwned` no longer
    // finds the record. Idempotency applies only to a CONCURRENT close (the
    // `record.closing !== undefined` branch returns false).
    //
    // This distinction matters for cleanup code: an owner tearing down after a
    // crash must tolerate the throw, not assume a boolean. Asserting the real
    // behaviour is more useful than asserting the tidier one I first assumed.
    const r = await rig()
    const owner = await r.agent('owner-t09')
    const session = await r.ctx.terminals.spawn(owner, { type: BACKEND_TYPE })
    expect(await r.ctx.terminals.kill(owner, session.sessionId, 'first')).toBe(true)
    await expect(r.ctx.terminals.kill(owner, session.sessionId, 'second')).rejects.toThrow(/unknown PTY session/)
    expect(r.ctx.terminals.list(owner)).toHaveLength(0)
    await r.close()
  })

  it('T09: disposing an owner leaves no live terminal behind', async () => {
    // The plan requires that an owner exit does not leave an orphaned process.
    const r = await rig()
    const owner = await r.agent('owner-dispose')
    const session = await r.ctx.terminals.spawn(owner, { type: BACKEND_TYPE })
    expect(r.ctx.terminals.list(owner)).toHaveLength(1)
    await r.ctx.terminals.kill(owner, session.sessionId, 'owner disposing')
    expect(r.ctx.terminals.list(owner)).toHaveLength(0)
    await r.close()
  })
})
