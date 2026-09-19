/**
 * M9.2: the three terminal gates M6 left open — T05, T06, T08.
 *
 * M6 established that a PTY keeps state across sends. These gates are about what
 * the terminal CANNOT promise, which is where a daily driver gets hurt:
 *
 *   T05  an interrupt must reach a running cell on its own control path, and the
 *        state reported afterwards must be true.
 *   T06  in-memory terminal state does not cross a process boundary, and nothing
 *        in this project may silently resume a cell from a previous host.
 *   T08  a failure is not a success, and the terminal's own framing is evidence
 *        about READINESS, never proof that a cell did what it claimed.
 *
 * The rig is the one from terminal.test.ts, with the same three constraints it
 * documents: real Agents are required because the terminal service rejects a
 * forged owner, mount order is load-bearing, and `read-only` mode cannot be used
 * because spawn never resolves under it on this platform.
 *
 * CONFINEMENT: M6 qualified the terminal ONLY with the sandbox off, which is the
 * configuration a daily driver least wants. That limitation turns out to be
 * specific to `read-only`. `workspace-write` resolves (~940 ms) and enforces
 * (proven by a denied write outside the workspace), so the gates run under BOTH
 * modes here: unconfined in the three main blocks, and under a real ACL-wrapped
 * sandbox in the final block. `read-only` remains NOT_RUN and is not claimed.
 *
 * `ctx.terminals` ONLY. `ctx.terminalController` is the human Web terminal
 * running with system-user privilege; wrapping it would be privilege escalation
 * and is not touched by this file.
 *
 * WHAT IS REAL HERE: the terminal registry, the shell backend, ConPTY, the
 * readiness poller, the process inspector. WHAT IS NOT: the model. These are the
 * tool-level calls a model would issue, issued directly.
 */
import { spawn } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
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
import { runRecordSchema } from './record.ts'

const SRC_DIR = fileURLToPath(new URL('.', import.meta.url))
const PACKAGE_DIR = fileURLToPath(new URL('..', import.meta.url))

const IS_WINDOWS = process.platform === 'win32'
const DIALECT = IS_WINDOWS ? 'pwsh' : 'bash'
/** Registered backend TYPE, not the dialect; see terminal.test.ts for why. */
const BACKEND_TYPE = 'shell'

/** Every wait reason the send contract can report. None of them is success. */
const WAIT_REASONS = ['stdin_read', 'inferred_idle', 'timeout', 'session_exit'] as const

/** The sandbox modes this file exercises. */
type SandboxMode = 'danger-full-access' | 'workspace-write'

interface Rig {
  readonly ctx: Context
  agent(id: string): Promise<Agent>
  close(): Promise<void>
}

/**
 * Build the rig. The mount order and the `as never` casts are copied verbatim
 * from terminal.test.ts, which documents each trap; the short version is that a
 * plugin cannot see a service mounted BESIDE it, and that a plugin whose
 * injections are unsatisfied waits silently rather than failing.
 *
 * WHY THE MODE IS A PARAMETER: M6 recorded that `spawn` never resolves under a
 * confined mode and therefore qualified the terminal ONLY unconfined. That is
 * true of `read-only`, but NOT of `workspace-write`, which was measured at
 * ~940 ms on this machine. Since a gate closed with the sandbox ON is a
 * materially stronger result than one closed with it off, the mode is a
 * parameter and the confinement-sensitive gates run under BOTH. `read-only`
 * remains NOT_RUN because it still hangs (M6, re-confirmed by the coordinator).
 *
 * `danger-full-access` makes the backend skip `sandbox.confine` entirely
 * (terminal-bash/src/index.ts:102), so the unconfined arm exercises no ACL
 * wrapper at all; the `workspace-write` arm does.
 */
async function rig(mode: SandboxMode = 'danger-full-access'): Promise<Rig> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(SandboxPolicy as never, { mode } as never)
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

interface SettledSend {
  readonly waitReason: string
  readonly viewport: string
  readonly sessionStatus: { kind: string }
  readonly elapsedMs: number
  /** Every field the result actually carries, so absence can be asserted. */
  readonly keys: readonly string[]
}

/** Start one send and report what the wait said, with how long it took. */
async function send(ctx: Context, owner: Agent, id: string, text: string): Promise<SettledSend> {
  const startedAt = Date.now()
  const result = await ctx.terminals.startSend(owner, id as never, { text, submit: true }).done
  return {
    waitReason: result.waitReason,
    viewport: result.viewport,
    sessionStatus: result.sessionStatus,
    elapsedMs: Date.now() - startedAt,
    keys: Object.keys(result).sort(),
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => { setTimeout(resolve, ms) })
}

/**
 * Report a measured value to the test output as well as to the assertions.
 *
 * The assertions are bounds (`signalMs < 1500`), and a bound is not a
 * measurement: "it was under 1.5 s" and "it was 9 ms" are different claims, and
 * only the second one can be checked against the finding written from it. Every
 * number quoted in FINDINGS.md is emitted here so it can be traced to a run
 * rather than to a recollection of one.
 */
function measured(label: string, value: string | number): void {
  console.log(`[measured] ${label} = ${value}`)
}

/** Scrollback text for an owner's session, or '' if the session is gone. */
function scrollback(ctx: Context, owner: Agent, id: string): string {
  try {
    return ctx.terminals.read(owner, id as never, { offset: 0, count: 400 }).text
  } catch {
    return ''
  }
}

/**
 * A token the ECHO of the command line cannot contain.
 *
 * The PTY echoes what was typed, so a plain literal would appear in scrollback
 * before the command ran and every "did the command produce this" check would be
 * true for the wrong reason. Assembling the string inside the shell keeps the
 * literal out of the echoed text, which is what makes the assertion meaningful.
 */
const TOKEN = (marker: string): string => `('${marker.slice(0, 4)}'+'${marker.slice(4)}')`

describe('T05: interrupt on an independent control path', () => {
  it('T05: SIGINT resolves while the cell is running, and the cell is not a success', async () => {
    // The gate's oracle is two claims: the control request is NOT blocked by the
    // execution path, and the state reported afterwards is true. Both are
    // measured here against one another, in the same moment.
    const r = await rig()
    const owner = await r.agent('owner-t05')
    const session = await r.ctx.terminals.spawn(owner, { type: BACKEND_TYPE })
    const id = session.sessionId
    const lateToken = 'LATE-TOKEN'

    const cellStartedAt = Date.now()
    const cell = r.ctx.terminals.startSend(owner, id, {
      text: `Start-Sleep -Seconds 12; Write-Output ${TOKEN(lateToken)}`,
      submit: true,
    })
    // Let the command be genuinely mid-flight. Signalling before the shell has
    // started it would prove nothing about contention.
    await sleep(2_500)

    // THE SEPARATION. `startSend` is serialized: the send path refuses a second
    // occupant with SEND_ACTIVE. If `signal` were gated the same way it would be
    // blocked behind the running cell. It is not, and the two calls below happen
    // in the same instant on the same session.
    let sendPathDuringCell = 'NOT_REFUSED'
    try {
      r.ctx.terminals.startSend(owner, id, { text: 'contender', submit: true })
    } catch (error: unknown) {
      sendPathDuringCell = (error as { code?: string }).code ?? String(error)
    }
    expect(sendPathDuringCell).toBe('SEND_ACTIVE')

    const signalStartedAt = Date.now()
    const signalResult = await r.ctx.terminals.signal(owner, id, 'SIGINT')
    const signalMs = Date.now() - signalStartedAt

    // The command still had ~9.5s of sleep left. A control path that waited for
    // the execution path would have taken that long, not milliseconds.
    measured('T05 signalMs (cell had ~9.5s of sleep left)', signalMs)
    measured('T05 signalResult', JSON.stringify(signalResult))
    expect(signalMs).toBeLessThan(1_500)

    // The REAL result shape, reported rather than assumed: `delivered` is the
    // backend's claim that it handed the signal to the process, and `targetPgid`
    // is the group it named. See FINDINGS.md for why targetPgid is 0 on Windows
    // and what that does and does not mean.
    expect(signalResult.delivered).toBe(true)
    expect(typeof signalResult.targetPgid).toBe('number')

    const settled = await cell.done
    const settleMs = Date.now() - cellStartedAt

    // HONEST STATE. The interrupt ends the WAIT, and the shell is still running;
    // neither of those is a statement that the cell succeeded.
    expect(WAIT_REASONS).toContain(settled.waitReason)
    expect(settled.waitReason).not.toBe('session_exit')
    expect(settled.sessionStatus.kind).toBe('running')
    // Nothing in the result says the cell did anything.
    expect(settled).not.toHaveProperty('exitCode')
    expect(settled).not.toHaveProperty('succeeded')
    // It settled because of the interrupt, not because the sleep expired.
    expect(settleMs).toBeLessThan(6_000)
    measured('T05 settled', `${settled.waitReason} ${JSON.stringify(settled.sessionStatus)} in ${settleMs}ms`)
    // The real field list, read off the live result rather than from the type.
    measured('T05 result fields', Object.keys(settled).sort().join(','))

    await r.ctx.terminals.kill(owner, id, 'test cleanup')
    await r.close()
  }, 60_000)

  it('T05: the interrupt really stops the command, not just the wait', async () => {
    // `delivered: true` is the backend saying it wrote the byte. It is NOT proof
    // that the command stopped. The proof is the command's own trailing output:
    // a 12-second sleep interrupted at 2.5s must never print its token, even
    // after the full 12 seconds have elapsed. If the signal had been swallowed,
    // the sleep would finish and the token would appear.
    const r = await rig()
    const owner = await r.agent('owner-t05b')
    const session = await r.ctx.terminals.spawn(owner, { type: BACKEND_TYPE })
    const id = session.sessionId
    const lateToken = 'INTERRUPTED-TOKEN'

    const cell = r.ctx.terminals.startSend(owner, id, {
      text: `Start-Sleep -Seconds 12; Write-Output ${TOKEN(lateToken)}`,
      submit: true,
    })
    await sleep(2_500)
    await r.ctx.terminals.signal(owner, id, 'SIGINT')
    const settled = await cell.done
    expect(settled.waitReason).not.toBe('session_exit')

    // Past the point the command would have finished on its own.
    await sleep(11_000)
    const after = scrollback(r.ctx, owner, id)
    expect(after).not.toContain(lateToken)

    // And the shell survived: the interrupt killed the foreground command, not
    // the session. A follow-up cell must still run.
    //
    // Read from SCROLLBACK after the cell has had time to produce output, not
    // from the settle viewport. The viewport at settle can still be showing the
    // interrupted cell's leftovers — which is the same wait-reason-is-not-
    // completion point one layer down, and reading it here would make this
    // assertion fail for a reason that has nothing to do with the interrupt.
    const followUp = await send(r.ctx, owner, id, 'Write-Output ALIVE-AFTER-INTERRUPT')
    expect(WAIT_REASONS).toContain(followUp.waitReason)
    await sleep(1_000)
    expect(scrollback(r.ctx, owner, id)).toContain('ALIVE-AFTER-INTERRUPT')

    await r.ctx.terminals.kill(owner, id, 'test cleanup')
    await r.close()
  }, 60_000)

  it('T05: SIGINT needs a live owned session, and a dead one is refused', async () => {
    // The control path is authorized, not open. This matters because an
    // unauthenticated interrupt would be a way to reach another owner's PTY.
    const r = await rig()
    const ownerA = await r.agent('owner-t05c-a')
    const ownerB = await r.agent('owner-t05c-b')
    const session = await r.ctx.terminals.spawn(ownerA, { type: BACKEND_TYPE })

    /**
     * Capture a refusal without assuming how it arrives.
     *
     * `TerminalSessionService.signal` is NOT async: it returns
     * `this.expectOwned(...).session.signal(...)` directly
     * (packages/terminal/terminal/src/index.ts:274-276), so the authorization
     * check runs BEFORE any promise exists and a refusal is a SYNCHRONOUS throw.
     * `expect(...).rejects` would fail on it, and so would a bare `await`. This
     * catches both shapes so the assertion is about the refusal, not about
     * which of the two it happens to be.
     */
    const refusal = async (owner: Agent): Promise<string> => {
      try {
        await r.ctx.terminals.signal(owner, session.sessionId, 'SIGINT')
      } catch (error: unknown) {
        return (error as Error).message
      }
      return 'NO-REFUSAL'
    }

    // A different owner cannot signal A's session.
    expect(await refusal(ownerB)).toMatch(/belongs to another agent/)

    await r.ctx.terminals.kill(ownerA, session.sessionId, 'test cleanup')
    // After the kill there is no record to authorize against, so the signal is
    // refused rather than delivered to whatever now holds that name.
    expect(await refusal(ownerA)).toMatch(/unknown PTY session/)

    await r.close()
  }, 60_000)
})

describe('T06: host loss and terminal id reuse', () => {
  it('T06: a fresh context starts with no terminals and does not adopt a historical id', async () => {
    // Terminal ids are minted `pty-N` from a counter that starts at 0 in every
    // process, so a new host WILL mint an id a previous host also used. The
    // question the gate asks is whether the new host adopts the old one's state.
    // It cannot: the registry is an in-process Map that a new Context does not
    // share, and this asserts the consequence rather than the mechanism.
    const first = await rig()
    const firstOwner = await first.agent('same-owner-id')
    const firstSession = await first.ctx.terminals.spawn(firstOwner, { type: BACKEND_TYPE })
    const historicalId = firstSession.sessionId
    expect(first.ctx.terminals.list(firstOwner)).toHaveLength(1)

    // Put real content in the first generation's scrollback, so the "not carried
    // over" check below has something it could actually have carried. Asserting
    // the absence of a string that was never written would pass for the wrong
    // reason and prove nothing.
    const historicalMarker = 'HISTORICAL-CELL-MARKER'
    await first.ctx.terminals.startSend(firstOwner, historicalId, {
      text: `Write-Output ${TOKEN(historicalMarker)}`,
      submit: true,
    }).done
    await sleep(500)
    expect(scrollback(first.ctx, firstOwner, historicalId)).toContain(historicalMarker)

    await first.ctx.terminals.kill(firstOwner, historicalId, 'first generation teardown')
    await first.close()

    // A second context, with the SAME owner id, as a restarted host would have.
    const second = await rig()
    const secondOwner = await second.agent('same-owner-id')

    // NO terminals: in-memory state did not survive the boundary.
    expect(second.ctx.terminals.list(secondOwner)).toHaveLength(0)

    // The historical id is REFUSED, not silently adopted. This is the assertion
    // that would fail if the registry ever consulted a durable index.
    expect(() => second.ctx.terminals.read(secondOwner, historicalId, { offset: 0, count: 10 }))
      .toThrow(/unknown PTY session/)

    // And the reuse really happens, which is why the refusal above is the thing
    // that matters rather than the id being unique.
    const secondSession = await second.ctx.terminals.spawn(secondOwner, { type: BACKEND_TYPE })
    expect(String(secondSession.sessionId)).toBe(String(historicalId))
    measured('T06 generation-1 id / generation-2 id', `${historicalId} / ${secondSession.sessionId}`)

    // The reused id is a NEW process: none of the previous generation's state is
    // visible through it, and no cell from before is waiting to be resumed.
    const carried = scrollback(second.ctx, secondOwner, secondSession.sessionId)
    expect(carried).not.toContain('HISTORICAL-CELL-MARKER')
    expect(secondSession.motd).not.toContain('HISTORICAL-CELL-MARKER')

    await second.ctx.terminals.kill(secondOwner, secondSession.sessionId, 'second generation teardown')
    await second.close()
  }, 60_000)

  it('T06: a cell does not survive the host that owned it', async () => {
    // The in-process check above cannot show what happens to a cell that was
    // RUNNING when the host died. This runs a real second process: it boots the
    // same rig, starts a cell whose only job is to write a marker file after a
    // delay, reports READY, and is then SIGKILLed mid-cell. If the cell survived
    // its host, the marker would appear.
    //
    // The control file is what makes the negative meaningful. A cell that never
    // wrote anything because the write path itself is broken would produce the
    // same "marker absent" result as a cell that was correctly killed, so the
    // child proves its shell can write FIRST and only then starts the delayed
    // write that the kill must prevent.
    const marker = join(tmpdir(), `dsh-t06-orphan-${Date.now()}.txt`)
    const control = join(tmpdir(), `dsh-t06-control-${Date.now()}.txt`)
    rmSync(marker, { force: true })
    rmSync(control, { force: true })

    // Module resolution for `--eval` is relative to the child's cwd, so the child
    // must run from the package root to see the same DSH packages this file does.
    //
    // The commands are built HERE and interpolated as JSON literals, rather than
    // assembled inside the template literal. An earlier version nested the
    // escaping and the child died in 292ms printing nothing, because a `\\` in
    // the template became a single `\` in the child and its own string literal
    // then read that as an escape: a SyntaxError in source this test never sees.
    // Building each command at one level removes the question. The child's boot
    // and its control write are still asserted, because a child that failed to
    // start or failed to write would make the whole case vacuous.
    const asShellPath = (path: string): string => path.replace(/\\/g, '/')
    const writeControl = `Set-Content -Path '${asShellPath(control)}' -Value CONTROL-WRITTEN`
    const writeMarker = `Start-Sleep -Seconds 6; Set-Content -Path '${asShellPath(marker)}' -Value ORPHAN-SURVIVED`
    const childSource = `
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { SessionId } from '@deepseek-ai/dsh-session'
import SandboxPolicy from '@deepseek-ai/dsh-sandbox-policy'
import LocalSandboxProvider from '@deepseek-ai/dsh-sandbox-local'
import SubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import TerminalRuntime from '@deepseek-ai/dsh-terminal'
import * as terminalBash from '@deepseek-ai/dsh-terminal-bash'
const ctx = new Context()
await mountAgentLoopTestDependencies(ctx)
await ctx.plugin(SandboxPolicy, { mode: 'danger-full-access' })
await ctx.plugin(LocalSandboxProvider)
await ctx.plugin(SubprocessRuntime)
await ctx.plugin(AgentLoop, { agents: [] })
await ctx.plugin(TerminalRuntime)
await ctx.plugin(terminalBash, { shellDialect: ${JSON.stringify(DIALECT)}, timeoutMs: 300000 })
const owner = await ctx.agentLoop.create(SessionId('orphan-owner'), {}, {})
const session = await ctx.terminals.spawn(owner, { type: ${JSON.stringify(BACKEND_TYPE)} })
await ctx.terminals.startSend(owner, session.sessionId, { text: ${JSON.stringify(writeControl)}, submit: true }).done
ctx.terminals.startSend(owner, session.sessionId, { text: ${JSON.stringify(writeMarker)}, submit: true })
await new Promise(resolve => setTimeout(resolve, 1500))
console.log('READY ' + JSON.stringify({ sessionId: String(session.sessionId) }))
await new Promise(() => {})
`

    const child = spawn(process.execPath, ['--input-type=module', '--eval', childSource], {
      cwd: PACKAGE_DIR,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8') })
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8') })

    const deadline = Date.now() + 45_000
    while (!stdout.includes('READY') && Date.now() < deadline && child.exitCode === null) {
      await sleep(250)
    }
    // A child that never booted would make the rest of this test vacuous, so the
    // boot is an assertion, not a precondition to hope for.
    expect(stderr).not.toContain('ERR_MODULE_NOT_FOUND')
    expect(stderr).not.toContain('SyntaxError')
    expect(stdout).toContain('READY')
    // The control: this shell CAN write files, so the absent marker below means
    // the cell was killed rather than that writing never worked.
    expect(existsSync(control)).toBe(true)
    expect(existsSync(marker)).toBe(false)

    // Kill the host while the delayed cell is mid-sleep.
    child.kill('SIGKILL')
    await new Promise<void>(resolve => { child.once('exit', () => { resolve() }) })

    // Past the point the cell would have written its marker.
    await sleep(9_000)
    expect(existsSync(marker)).toBe(false)
    rmSync(marker, { force: true })
    rmSync(control, { force: true })
  }, 90_000)

  it('T06: this project has no code path that could replay a historical cell', async () => {
    // The gate says a historical cell must not be auto-replayed. The honest way
    // to test a negative is to look for the code that would have to exist for it
    // to be possible, and assert it is absent. This is a source-level check
    // against the package's own non-test sources: if a terminal call is ever
    // added to the production code, this fails and a human must decide why.
    const productionFiles = readdirSync(SRC_DIR)
      .filter(name => name.endsWith('.ts') && !name.endsWith('.test.ts'))
    expect(productionFiles.length).toBeGreaterThan(0)

    const terminalCallers: string[] = []
    for (const name of productionFiles) {
      const source = readFileSync(join(SRC_DIR, name), 'utf8')
      if (/ctx\.terminals|ctx\.terminalController|\bstartSend\b|terminalController/.test(source)) {
        terminalCallers.push(name)
      }
    }
    expect(terminalCallers).toEqual([])

    // The durable record is the only thing that crosses a restart, so it is the
    // only place a terminal identity could be stored for later replay. It has
    // none: `terminalTombstones` holds closed TASK ids (host.ts compares them
    // against `input.taskId`), not PTY sessions.
    const recordKeys = Object.keys(runRecordSchema.shape)
    expect(recordKeys.filter(key => /pty|kernel|cell/i.test(key))).toEqual([])
    expect(recordKeys.filter(key => /terminal/i.test(key))).toEqual(['terminalTombstones'])

    // And the reconciliation module states the rule this absence implements.
    const reconcileSource = readFileSync(join(SRC_DIR, 'reconcile.ts'), 'utf8')
    expect(reconcileSource).toContain('NEVER auto-replay')
  }, 60_000)
})

describe('T08: error and framing', () => {
  it('T08: a failed command is not reported as success', async () => {
    // The gate's oracle is that an error or an unknown is never mistaken for
    // success. The strongest form of that is structural: the send result carries
    // no verdict about the command at all, so there is no field that could be
    // wrong. This asserts the absence rather than trusting the wording.
    const r = await rig()
    const owner = await r.agent('owner-t08')
    const session = await r.ctx.terminals.spawn(owner, { type: BACKEND_TYPE })
    const id = session.sessionId

    const ok = await send(r.ctx, owner, id, 'Write-Output FRAMING-OK')
    const boom = await send(r.ctx, owner, id, "Write-Output BEFORE-BOOM; throw 'BOOM-TOKEN'")

    // The real shape, observed: viewport, waitReason, sessionStatus, truncated.
    expect(ok.keys).toEqual(boom.keys)
    for (const result of [ok, boom]) {
      expect(result.keys.filter(key => /exit|success|ok|fail|error/i.test(key))).toEqual([])
      expect(WAIT_REASONS).toContain(result.waitReason)
      expect(result.waitReason).not.toBe('session_exit')
    }

    // The failure is real and only visible as TEXT. A caller that reads the
    // waitReason learns nothing about it; a caller that reads the viewport has
    // to interpret prose, which is exactly why it is not a verification signal.
    expect(boom.viewport).toContain('BOOM-TOKEN')
    expect(boom.sessionStatus.kind).toBe('running')

    await r.ctx.terminals.kill(owner, id, 'test cleanup')
    await r.close()
  }, 60_000)

  it('T08: a forged completion marker is accepted as readiness, so framing is not proof', async () => {
    // The framing attack. The backend treats the shell's own OSC 133;D marker
    // followed by the printable prompt as readiness evidence, and a program can
    // simply print that sequence itself. The command below prints a forged
    // marker, then sleeps 12 seconds, then prints its token.
    //
    // A trustworthy completion signal would wait for the command. This one
    // settles in well under a second, while the command is still sleeping and
    // has produced nothing. That is the whole finding: framing is a READINESS
    // signal, and readiness is not verification.
    // Two FRESH sessions, one per measurement. An earlier version measured both
    // in one session with a SIGINT between them, and it flaked: the interrupt's
    // leftover output and the shell's recovery state made the second measurement
    // depend on how fast the shell settled down, not on framing. Each session
    // here has exactly one cell in it, so each number means one thing.
    const r = await rig()
    const baselineOwner = await r.agent('owner-t08b-honest')
    const baselineSession = await r.ctx.terminals.spawn(baselineOwner, { type: BACKEND_TYPE })
    const forgedOwner = await r.agent('owner-t08b-forged')
    const forgedSession = await r.ctx.terminals.spawn(forgedOwner, { type: BACKEND_TYPE })
    const lateToken = 'FORGED-LATE'

    // Baseline: the same command without the forged marker takes the full
    // duration to settle, because nothing claims readiness early.
    const honest = await send(
      r.ctx,
      baselineOwner,
      baselineSession.sessionId,
      `Start-Sleep -Seconds 3; Write-Output ${TOKEN('BASELINE-TOKEN')}`,
    )

    const forged = await send(
      r.ctx,
      forgedOwner,
      forgedSession.sessionId,
      `[Console]::Write([char]27+']133;D;0'+[char]7+'dsh> '); Start-Sleep -Seconds 12; Write-Output ${TOKEN(lateToken)}`,
    )

    // THE CLAIM UNDER TEST is that the forged marker causes a PREMATURE settle,
    // so the assertion is about timing, not about which reason string came back.
    //
    // The bound is derived from the mechanism rather than fitted to an
    // observation. Without the marker the ONLY path to a settle is the
    // idle-silence heuristic, which requires idleSilenceMs = 3000 ms of quiet
    // (terminal-bash/src/config.ts:104). The forged marker instead satisfies the
    // prompt-readiness branch. A settle under 1500 ms is therefore reachable only
    // by accepting the forged framing; a regression that stopped accepting it
    // would settle at ~3000 ms and fail this bound instead of quietly passing.
    // Observed on this machine: 166-170 ms, so the bound has ~9x headroom.
    expect(forged.elapsedMs).toBeLessThan(1_500)
    // Non-success, whatever it reported. The exact reason is recorded rather than
    // pinned: which non-success reason the poller picks is an implementation
    // detail the gate does not depend on.
    expect(WAIT_REASONS).toContain(forged.waitReason)
    expect(forged.waitReason).not.toBe('session_exit')
    // The A/B control: the baseline command has no forged marker, so nothing
    // claims readiness early and the poller really does wait out the command.
    // Without this, "settled fast" could just be a poller that never waits.
    expect(honest.elapsedMs).toBeGreaterThan(2_500)

    // The command had produced nothing at the moment it was reported ready.
    expect(scrollback(r.ctx, forgedOwner, forgedSession.sessionId)).not.toContain(lateToken)
    measured('T08 baseline (honest command) elapsedMs', honest.elapsedMs)
    measured('T08 baseline waitReason', honest.waitReason)
    measured('T08 forged-marker elapsedMs', forged.elapsedMs)
    measured('T08 forged waitReason', forged.waitReason)

    // And it was still running: the token arrives once the sleep really ends.
    await sleep(12_000)
    expect(scrollback(r.ctx, forgedOwner, forgedSession.sessionId)).toContain(lateToken)

    await r.ctx.terminals.kill(baselineOwner, baselineSession.sessionId, 'test cleanup')
    await r.ctx.terminals.kill(forgedOwner, forgedSession.sessionId, 'test cleanup')
    await r.close()
  }, 90_000)

  it('T08: a blocking read settles as a non-success reason while the cell is still running', async () => {
    // An input()-style read waits forever. The terminal must report that wait as
    // a wait, never as completion, and the proof that it had not completed is
    // that the NEXT cell is consumed by the still-waiting read.
    //
    // The REAL reason on this platform is reported, not the expected one: the
    // exact stdin-wait probe is unavailable on Windows
    // (windows-inspector.ts:101 returns false unconditionally), so the settle
    // comes from the idle-silence heuristic. Both are non-success reasons, and
    // FINDINGS.md records the difference rather than hiding it.
    const r = await rig()
    const owner = await r.agent('owner-t08c')
    const session = await r.ctx.terminals.spawn(owner, { type: BACKEND_TYPE })
    const id = session.sessionId

    const blocked = await send(
      r.ctx,
      owner,
      id,
      `python -c "import sys; sys.stdout.write('WAIT> '); sys.stdout.flush(); x=sys.stdin.readline(); print('RE'+'PLY-'+x.strip())"`,
    )

    // A wait reason, never a completion. `inferred_idle` is explicitly a
    // heuristic and `stdin_read` is the exact probe; neither says the cell ran.
    expect(['stdin_read', 'inferred_idle']).toContain(blocked.waitReason)
    expect(blocked.waitReason).not.toBe('session_exit')
    expect(blocked.sessionStatus.kind).toBe('running')
    expect(blocked.keys.filter(key => /exit|success|ok|fail|error/i.test(key))).toEqual([])
    measured('T08 blocking read waitReason', blocked.waitReason)
    measured('T08 blocking read elapsedMs', blocked.elapsedMs)

    // The read is genuinely blocked and has produced no answer.
    expect(blocked.viewport).toContain('WAIT>')
    expect(scrollback(r.ctx, owner, id)).not.toContain('REPLY-')

    // THE PROOF THAT IT HAD NOT COMPLETED. Text sent as the next cell never
    // becomes a command: the blocked read consumes it as its input. A caller
    // that treated the settle as completion would have lost this cell silently.
    const nextCell = await send(r.ctx, owner, id, 'NEXT-CELL-TEXT')
    expect(WAIT_REASONS).toContain(nextCell.waitReason)
    await sleep(1_500)
    const after = scrollback(r.ctx, owner, id)
    expect(after).toContain('REPLY-NEXT-CELL-TEXT')

    await r.ctx.terminals.kill(owner, id, 'test cleanup')
    await r.close()
  }, 90_000)

  it('T08: the only honest exit code is the shell\'s own', async () => {
    // `session_exit` is the one place a code appears, and it describes the
    // TOP-LEVEL process, not the command that happened to be running. Reporting
    // it as a cell verdict would attribute the shell's exit to the work.
    const r = await rig()
    const owner = await r.agent('owner-t08d')
    const session = await r.ctx.terminals.spawn(owner, { type: BACKEND_TYPE })
    const id = session.sessionId

    const exited = await send(r.ctx, owner, id, 'exit 3')
    expect(exited.waitReason).toBe('session_exit')
    expect(exited.sessionStatus.kind).toBe('exited')
    expect(exited.sessionStatus).toMatchObject({ exitCode: 3, signal: null })

    // The dead session is still listed, and honestly reports itself as exited
    // rather than disappearing into a success.
    const listed = r.ctx.terminals.list(owner)
    expect(listed).toHaveLength(1)
    expect(listed[0]?.status.kind).toBe('exited')

    // No further cell can be sent into it. This is the boundary that stops a
    // caller from writing the next cell into a process that no longer exists.
    expect(() => r.ctx.terminals.startSend(owner, id, { text: 'never', submit: true }))
      .toThrow(/PTY session has exited/)

    await r.ctx.terminals.kill(owner, id, 'test cleanup')
    await r.close()
  }, 60_000)
})

/**
 * The confinement arm.
 *
 * M6 qualified the terminal ONLY with the sandbox off, because `spawn` never
 * resolves under `read-only` on this machine. That left the whole M6/M9.2 result
 * resting on the configuration a daily driver LEAST wants: a capability proven
 * only when confinement is disabled.
 *
 * `workspace-write` is a different story. It resolves (~940 ms measured here),
 * so the same gates can be exercised with the Windows ACL runner actually
 * wrapping the shell. This block is what turns "qualified unconfined" into
 * "qualified under a real confinement mode" for the three gates in this file.
 *
 * WHAT THIS DOES AND DOES NOT COVER: `workspace-write` is a real sandbox mode
 * and the ACL wrapper is in the spawn path, which the write-denial assertion
 * below proves is ENFORCING rather than merely present. `read-only` is still
 * NOT_RUN and is not claimed. These are not the only two modes, and no
 * confinement claim is made about any mode not exercised here.
 */
describe('T05/T06/T08 under workspace-write confinement', () => {
  it('the confinement arm is real: writes are enforced, not merely configured', async () => {
    // Without this, the arm below could be running unconfined while claiming
    // otherwise, and every "under confinement" result would be meaningless.
    // A denied write outside the workspace and an allowed write inside it is
    // what proves the ACL runner is actually in the path.
    const r = await rig('workspace-write')
    const owner = await r.agent('owner-ww')
    const session = await r.ctx.terminals.spawn(owner, { type: BACKEND_TYPE })
    const id = session.sessionId

    const policy = r.ctx.sandboxPolicy.resolve({ session: owner.session })
    expect(policy.mode).toBe('workspace-write')
    measured('WW workspaceRoot', policy.workspaceRoot)

    const outside = join(tmpdir(), `dsh-ww-denied-${Date.now()}.txt`)
    const inside = join(policy.workspaceRoot, `dsh-ww-allowed-${Date.now()}.txt`)
    rmSync(outside, { force: true })
    rmSync(inside, { force: true })

    const asShell = (path: string): string => path.replace(/\\/g, '/')
    const denied = await send(r.ctx, owner, id, `Set-Content -Path '${asShell(outside)}' -Value DENIED`)
    await sleep(1_000)
    const allowed = await send(r.ctx, owner, id, `Set-Content -Path '${asShell(inside)}' -Value ALLOWED`)
    await sleep(1_000)

    // The sandbox refused the outside write and permitted the inside one. Both
    // halves matter: a denial alone could mean the write path is broken.
    expect(existsSync(outside)).toBe(false)
    expect(existsSync(inside)).toBe(true)
    measured('WW denied-write waitReason', denied.waitReason)
    measured('WW allowed-write waitReason', allowed.waitReason)

    rmSync(outside, { force: true })
    rmSync(inside, { force: true })
    await r.ctx.terminals.kill(owner, id, 'test cleanup')
    await r.close()
  }, 90_000)

  it('T05 under confinement: SIGINT still reaches a running cell on its own path', async () => {
    const r = await rig('workspace-write')
    const owner = await r.agent('owner-ww-t05')
    const session = await r.ctx.terminals.spawn(owner, { type: BACKEND_TYPE })
    const id = session.sessionId
    const lateToken = 'WW-LATE'

    const cell = r.ctx.terminals.startSend(owner, id, {
      text: `Start-Sleep -Seconds 12; Write-Output ${TOKEN(lateToken)}`,
      submit: true,
    })
    await sleep(2_500)

    const signalStartedAt = Date.now()
    const signalResult = await r.ctx.terminals.signal(owner, id, 'SIGINT')
    const signalMs = Date.now() - signalStartedAt
    expect(signalMs).toBeLessThan(1_500)
    expect(signalResult.delivered).toBe(true)

    const settled = await cell.done
    expect(WAIT_REASONS).toContain(settled.waitReason)
    expect(settled.waitReason).not.toBe('session_exit')
    expect(settled.sessionStatus.kind).toBe('running')
    measured('WW T05 signalMs', signalMs)
    measured('WW T05 signalResult', JSON.stringify(signalResult))
    measured('WW T05 settled', `${settled.waitReason} ${JSON.stringify(settled.sessionStatus)}`)

    // The command really stopped: its token never appears, even past the point
    // it would have finished on its own.
    await sleep(11_000)
    expect(scrollback(r.ctx, owner, id)).not.toContain(lateToken)

    await r.ctx.terminals.kill(owner, id, 'test cleanup')
    await r.close()
  }, 90_000)

  it('T06 under confinement: state does not cross a context boundary', async () => {
    // The id-reuse and non-adoption result, with the ACL wrapper in the path.
    const first = await rig('workspace-write')
    const firstOwner = await first.agent('ww-same-owner')
    const firstSession = await first.ctx.terminals.spawn(firstOwner, { type: BACKEND_TYPE })
    const historicalId = firstSession.sessionId
    const marker = 'WW-HISTORICAL-MARKER'
    await first.ctx.terminals.startSend(firstOwner, historicalId, {
      text: `Write-Output ${TOKEN(marker)}`,
      submit: true,
    }).done
    await sleep(800)
    expect(scrollback(first.ctx, firstOwner, historicalId)).toContain(marker)
    await first.ctx.terminals.kill(firstOwner, historicalId, 'first generation teardown')
    await first.close()

    const second = await rig('workspace-write')
    const secondOwner = await second.agent('ww-same-owner')
    expect(second.ctx.terminals.list(secondOwner)).toHaveLength(0)
    expect(() => second.ctx.terminals.read(secondOwner, historicalId, { offset: 0, count: 10 }))
      .toThrow(/unknown PTY session/)

    const secondSession = await second.ctx.terminals.spawn(secondOwner, { type: BACKEND_TYPE })
    expect(String(secondSession.sessionId)).toBe(String(historicalId))
    expect(scrollback(second.ctx, secondOwner, secondSession.sessionId)).not.toContain(marker)
    expect(secondSession.motd).not.toContain(marker)
    measured('WW T06 reused id', String(secondSession.sessionId))

    await second.ctx.terminals.kill(secondOwner, secondSession.sessionId, 'second generation teardown')
    await second.close()
  }, 90_000)

  it('T08 under confinement: a forged marker still settles early, and a failure is still not success', async () => {
    const r = await rig('workspace-write')
    const honestOwner = await r.agent('ww-t08-honest')
    const honestSession = await r.ctx.terminals.spawn(honestOwner, { type: BACKEND_TYPE })
    const forgedOwner = await r.agent('ww-t08-forged')
    const forgedSession = await r.ctx.terminals.spawn(forgedOwner, { type: BACKEND_TYPE })
    const lateToken = 'WW-FORGED-LATE'

    const honest = await send(
      r.ctx,
      honestOwner,
      honestSession.sessionId,
      `Start-Sleep -Seconds 3; Write-Output ${TOKEN('WW-BASELINE')}`,
    )
    const forged = await send(
      r.ctx,
      forgedOwner,
      forgedSession.sessionId,
      `[Console]::Write([char]27+']133;D;0'+[char]7+'dsh> '); Start-Sleep -Seconds 12; Write-Output ${TOKEN(lateToken)}`,
    )

    // Same bound and same reasoning as the unconfined arm: < 1500 ms is only
    // reachable by accepting the forged framing, since the honest path needs
    // idleSilenceMs = 3000 ms of quiet.
    expect(forged.elapsedMs).toBeLessThan(1_500)
    expect(honest.elapsedMs).toBeGreaterThan(2_500)
    expect(WAIT_REASONS).toContain(forged.waitReason)
    expect(forged.waitReason).not.toBe('session_exit')
    measured('WW T08 honest elapsedMs', honest.elapsedMs)
    measured('WW T08 forged elapsedMs', forged.elapsedMs)
    measured('WW T08 forged waitReason', forged.waitReason)
    expect(scrollback(r.ctx, forgedOwner, forgedSession.sessionId)).not.toContain(lateToken)

    // A failing command under confinement is still not a success.
    const boom = await send(r.ctx, honestOwner, honestSession.sessionId, "throw 'WW-BOOM'")
    expect(boom.keys.filter(key => /exit|success|ok|fail|error/i.test(key))).toEqual([])
    expect(WAIT_REASONS).toContain(boom.waitReason)
    expect(boom.waitReason).not.toBe('session_exit')
    expect(boom.sessionStatus.kind).toBe('running')

    await sleep(12_000)
    expect(scrollback(r.ctx, forgedOwner, forgedSession.sessionId)).toContain(lateToken)

    await r.ctx.terminals.kill(honestOwner, honestSession.sessionId, 'test cleanup')
    await r.ctx.terminals.kill(forgedOwner, forgedSession.sessionId, 'test cleanup')
    await r.close()
  }, 120_000)
})
