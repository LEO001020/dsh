/**
 * P7 / UI-ACTIVE-RUN and UI-DEFAULT, at the CARD boundary.
 *
 * WHAT THIS FILE PROVES, and what it deliberately does not.
 *
 * It proves the card's action layer emits the right command line for each of the
 * four controls, addresses them to the session the card is showing, maps the
 * host's three outcome arms without collapsing them, and reads the display out of
 * the host's own status text. It does NOT prove a browser can render the card or
 * that a user can complete the flow — see the P7 report.
 *
 * THE AUTHORITY EDGE IS THE ORACLE. V5 section 13: "UI actions must use the same
 * human authority plane as slash commands: prefer
 * `ctx.remote.commands.execute(...)` ... No separate authorization RPC."
 *
 * So the strongest arm here is not "the card sends /work target 9". It is that
 * the card's ONLY capability is `execute`, asserted by giving it an `execute`
 * that records and by showing that the recorded line is a `/work` line the real
 * `/work` parser accepts. A card holding a second edge would have to be given
 * one, and this module's whole action surface takes one function.
 */
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { SessionId } from '@deepseek-ai/dsh-session'
import Storage from '@deepseek-ai/dsh-storage'
import * as storageDomainPlugin from '@deepseek-ai/dsh-storage-domain'
import * as storageJsonPlugin from '@deepseek-ai/dsh-storage-json'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { WorkService, type LaunchPort, type LaunchRequest } from './host.ts'
import { parseWorkCommand } from './command-work.ts'
import * as commandWork from './command-work.ts'
import {
  CARD_MAX_TARGET,
  CARD_MIN_TARGET,
  createWorkCardActions,
  commandLineFor,
  parseCardTarget,
  parseDeficit,
  parseStatusText,
  STATUS_FIELDS_NOT_REPORTED,
  type CommandExecuteOutcome,
} from './ui-card.ts'
import { MAX_TARGET_ACTIVE_CHILDREN, MIN_TARGET_ACTIVE_CHILDREN } from './target-setting.ts'

class ScriptedLaunchPort implements LaunchPort {
  readonly calls: LaunchRequest[] = []
  async launch(request: LaunchRequest): Promise<{ childId: string }> {
    this.calls.push(request)
    return { childId: request.childId }
  }
}

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  const errors: unknown[] = []
  for (const cleanup of cleanups.splice(0).reverse()) {
    try {
      await cleanup()
    } catch (error) {
      errors.push(error)
    }
  }
  if (errors.length > 0) throw new AggregateError(errors, 'cleanup failed')
})

// ---------------------------------------------------------------------------
// The line each control emits, against the host's OWN parser
// ---------------------------------------------------------------------------

describe('P7 card: every control emits a line the host parser accepts', () => {
  it('the four controls map to the four documented lines', () => {
    expect(commandLineFor({ kind: 'start' })).toBe('/work start')
    expect(commandLineFor({ kind: 'start', target: 9 })).toBe('/work start 9')
    expect(commandLineFor({ kind: 'applyTarget', target: 9 })).toBe('/work target 9')
    expect(commandLineFor({ kind: 'stop' })).toBe('/work stop')
    expect(commandLineFor({ kind: 'status' })).toBe('/work status')
  })

  it('CONTROL ARM: the host parser REJECTS a line the card does not produce', () => {
    // A gate that never fires proves nothing. This asserts the host parser
    // distinguishes a card-shaped line from a malformed one, so the arm above is
    // measuring agreement rather than a parser that accepts anything.
    const cardLines = [
      commandLineFor({ kind: 'start' }),
      commandLineFor({ kind: 'applyTarget', target: 9 }),
      commandLineFor({ kind: 'stop' }),
      commandLineFor({ kind: 'status' }),
    ]
    for (const line of cardLines) {
      const parsed = parseWorkCommand(line.slice('/work'.length))
      expect(parsed.kind, `${line} must parse to a known verb`).not.toBe('invalid')
    }
    // The same parser, on lines the card must never emit.
    for (const bad of ['/work frobnicate', '/work target', '/work start 0', '/work stop now']) {
      expect(parseWorkCommand(bad.slice('/work'.length)).kind, `${bad} must be refused`).toBe('invalid')
    }
  })

  it('the card\'s bounds EQUAL the host\'s, asserted rather than assumed', () => {
    // The constants are restated in `ui-card.ts` because the browser bundle
    // cannot import the host module. A restatement that drifts would make the
    // card refuse a value the host accepts (or worse, admit one it refuses), so
    // the drift is a test failure rather than a silent divergence.
    expect(CARD_MIN_TARGET).toBe(MIN_TARGET_ACTIVE_CHILDREN)
    expect(CARD_MAX_TARGET).toBe(MAX_TARGET_ACTIVE_CHILDREN)
  })

  it('the N input refuses the same inputs the host refuses, and never clamps', () => {
    for (const bad of ['0', '31', '2.5', 'twelve', '-1', '', '  ', 'NaN', 'Infinity', '1e2']) {
      const parsed = parseCardTarget(bad)
      expect('reason' in parsed, `${JSON.stringify(bad)} must be refused`).toBe(true)
    }
    // A clamp would return 30 for "50". It must not.
    const over = parseCardTarget('50')
    expect('reason' in over).toBe(true)
    for (const [text, expected] of [['1', 1], ['15', 15], ['30', 30], [' 7 ', 7]] as const) {
      expect(parseCardTarget(text)).toEqual({ target: expected })
    }
  })
})

// ---------------------------------------------------------------------------
// The action face against a recording execute
// ---------------------------------------------------------------------------

describe('P7 card: the action face uses ONE authority edge', () => {
  /** A recorder that answers with a caller-supplied outcome. */
  function recorder(outcome: CommandExecuteOutcome) {
    const calls: Array<{ sessionId: string; line: string }> = []
    return {
      calls,
      execute: async (sessionId: string, line: string): Promise<CommandExecuteOutcome> => {
        calls.push({ sessionId, line })
        return outcome
      },
    }
  }

  it('each control calls execute exactly once, with its own line and the bound session', async () => {
    const r = recorder({ ok: true, value: { result: { kind: 'success', text: 'ok' } } })
    const card = createWorkCardActions('session-selected', r.execute)

    await card.start(4)
    await card.applyTarget(9)
    await card.stop()
    await card.status()

    expect(r.calls).toEqual([
      { sessionId: 'session-selected', line: '/work start 4' },
      { sessionId: 'session-selected', line: '/work target 9' },
      { sessionId: 'session-selected', line: '/work stop' },
      { sessionId: 'session-selected', line: '/work status' },
    ])
  })

  it('the session is CAPTURED at construction, so no action can address another one', async () => {
    // V5 section 13: "If multiple roots exist, card is scoped to selected/current
    // Session." A card that took the session per action could show session A's
    // counts and apply a target to session B, so this is a real requirement
    // rather than a tidiness one.
    const r = recorder({ ok: true, value: { result: { kind: 'success', text: 'ok' } } })
    const card = createWorkCardActions('session-A', r.execute)
    expect(card.sessionId).toBe('session-A')
    await card.applyTarget(5)
    // The action face exposes no way to name a different session.
    expect(Object.keys(card).sort()).toEqual(['applyTarget', 'sessionId', 'start', 'status', 'stop'])
    expect(r.calls.every(call => call.sessionId === 'session-A')).toBe(true)
  })

  it('the three host outcome arms stay DISTINCT rather than collapsing to a boolean', async () => {
    // 1. an execution with a result
    const ok = recorder({ ok: true, value: { result: { kind: 'success', text: 'Run authorized: r1' } } })
    expect(await createWorkCardActions('s', ok.execute).start(4))
      .toMatchObject({ ok: true, text: 'Run authorized: r1', unmatched: false })

    // 2. a command error result (the host executed it and it refused)
    const refused = recorder({ ok: true, value: { result: { kind: 'error', text: 'no active run' } } })
    expect(await createWorkCardActions('s', refused.execute).applyTarget(9))
      .toMatchObject({ ok: false, text: 'no active run', unmatched: false })

    // 3. the line matched NO registered command -- a COMPOSITION fact, not a
    //    refusal by the work service. Reported separately so a reader looks at
    //    the profile rather than at the run.
    const unmatched = recorder({ ok: true, value: undefined })
    expect(await createWorkCardActions('s', unmatched.execute).status())
      .toMatchObject({ ok: false, unmatched: true })

    // 4. a transport/refusal failure, which carries the host's error code
    const failed = recorder({ ok: false, error: { code: 'UNAUTHORIZED', message: 'denied' } })
    expect(await createWorkCardActions('s', failed.execute).stop())
      .toMatchObject({ ok: false, text: 'UNAUTHORIZED: denied', unmatched: false })
  })
})

// ---------------------------------------------------------------------------
// The display, read out of the host's own text
// ---------------------------------------------------------------------------

describe('P7 card: the display reads the host text and names what it cannot show', () => {
  it('parses every count the command plane reports, and the deficit with its reason', async () => {
    // The REAL text, produced by the real renderer. Driving it from a live run
    // rather than hand-writing a string means a wording change in `renderStatus`
    // fails this arm instead of leaving the parser and the renderer disagreeing.
    const r = await rig()
    const card = createWorkCardActions(r.sessionId, async (_sessionId, line) => {
      const execution = await r.ctx.commands.execute(r.agent, line, [], new AbortController().signal)
      return execution === undefined
        ? { ok: true, value: undefined }
        : { ok: true, value: { result: { kind: execution.result.kind, text: execution.result.text ?? '' } } }
    })
    await card.start(7)
    const outcome = await card.status()
    expect(outcome.ok).toBe(true)

    const view = parseStatusText(outcome.text)
    expect(view.noRun).toBe(false)
    expect(view.phase).toBe('open')
    expect(view.target).toBe(7)
    // Every count line the renderer emits is present and NUMERIC.
    const labels = view.fields.map(field => field.label)
    expect(labels).toEqual([
      'Durably admitted', 'Launching', 'Active assignments', 'Stopping',
      'Quarantined (unknown)', 'Confirmed',
    ])
    for (const field of view.fields) {
      expect(field.value, `${field.label} must be a number`).toBeTypeOf('number')
    }

    const deficit = parseDeficit(outcome.text)
    expect(deficit.deficit).toBeTypeOf('number')
    expect(deficit.reason).toBe('insufficient_ready_tasks')
  })

  it('names the V5 display fields the command plane does NOT report, rather than showing 0', async () => {
    // THE HONEST PART OF THIS SLICE. V5 section 13 lists `ready` among the fields
    // to display. `renderStatus` does not emit it, and `readyTasks` in `Counts`
    // is populated by `setReadyTasks` -- the durable READY queue is writer P5's
    // concurrent work this round. So the card must not invent a value: it
    // reports the field as unreported.
    const r = await rig()
    const card = cardOver(r)
    await card.start(4)
    const view = parseStatusText((await card.status()).text)
    expect(view.unreported.map(entry => entry.label)).toContain('ready')
    expect(view.unreported.map(entry => entry.label)).toContain('global hard-cap occupancy')
    // And NOT reported as zero: an absent field has no value at all.
    expect(view.fields.map(field => field.label)).not.toContain('Ready')
  })

  it('THE LIST CANNOT GO STALE: no unreported entry is actually a rendered line', async () => {
    // A hand-kept list of "what the host does not report" is exactly the kind of
    // claim this project records going stale. So the list is CHECKED against real
    // host output rather than trusted: if writer P5 (or anyone) adds a `Ready:`
    // line to `renderStatus`, this arm fails and the list must shrink.
    //
    // It is the mirror of the arms above: those assert the card does not invent
    // fields, this one asserts the card does not keep claiming a field is missing
    // after it arrives.
    const r = await rig()
    const card = cardOver(r)
    await card.start(4)
    const text = (await card.status()).text
    const lines = text.split('\n').map(line => line.trim())
    for (const { label, probe } of STATUS_FIELDS_NOT_REPORTED) {
      const rendered = lines.some(line => line.toLowerCase().startsWith(`${probe.toLowerCase()}:`))
      expect(rendered, `"${label}" is listed unreported but "${probe}:" IS a rendered line in:\n${text}`).toBe(false)
    }
    // CONTROL ARM: the same check DOES find a field that is reported. Without it,
    // a probe list full of typos would pass by matching nothing.
    expect(lines.some(line => line.startsWith('Target:'))).toBe(true)
  })

  it('distinguishes "no run" from a run with zero counts', async () => {
    const r = await rig()
    const card = createWorkCardActions(r.sessionId, async (_sessionId, line) => {
      const execution = await r.ctx.commands.execute(r.agent, line, [], new AbortController().signal)
      return execution === undefined
        ? { ok: true, value: undefined }
        : { ok: true, value: { result: { kind: execution.result.kind, text: execution.result.text ?? '' } } }
    })
    // Before any run exists: a SUCCESS whose text says there is no run.
    const before = await card.status()
    expect(before.ok).toBe(true)
    const view = parseStatusText(before.text)
    expect(view.noRun).toBe(true)
    expect(view.runId).toBeUndefined()
    expect(view.target).toBeUndefined()
    // With no run there is nothing to call unreported, so the list is empty
    // rather than blaming the renderer for counts it was never asked for.
    expect(view.unreported).toEqual([])
  })

  it('an absent field is undefined, never 0', () => {
    // The property that makes `unreported` meaningful: if a missing line parsed
    // as 0, the card could not tell "the host said zero" from "the host said
    // nothing", which is the distinction `counting.ts` makes between
    // `capacityDeficit` and `heldReservations`.
    const view = parseStatusText('Phase: open\nTarget: 5\n')
    expect(view.fields.every(field => field.value === undefined)).toBe(true)
    expect(parseDeficit('Phase: open').deficit).toBeUndefined()
    expect(parseDeficit('Phase: open').reason).toBeUndefined()
  })

  it('the deficit reason survives the round trip, including target_exceeded', () => {
    // `target_exceeded` is the reason that matters: `capacityDeficit` clamps at
    // zero, so an overshoot and a healthy full wave read identically and only the
    // reason distinguishes them (counting.ts's CAP-10 note).
    const exceeded = parseDeficit('Capacity deficit: 0 (target_exceeded)')
    expect(exceeded).toEqual({ deficit: 0, reason: 'target_exceeded' })
    expect(STATUS_FIELDS_NOT_REPORTED.map(entry => entry.label)).toContain('ready')
  })
})

// ---------------------------------------------------------------------------
// The card's lines against the REAL registry and the REAL run record
// ---------------------------------------------------------------------------

interface Rig {
  readonly ctx: Context
  readonly service: WorkService
  readonly agent: Agent
  readonly sessionId: string
}

async function rig(): Promise<Rig> {
  const root = mkdtempSync(join(tmpdir(), 'dsh-p7-card-'))
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(CommandRuntime)
  await ctx.plugin(JsonlSessionPersistence, { root: join(root, 'sessions') })
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(Storage)
  await ctx.plugin(storageJsonPlugin as never, { root: join(root, 'store') } as never)
  await ctx.plugin(storageDomainPlugin as never, { backend: 'json' } as never)
  const service = new WorkService(ctx, {
    targetChildren: 6, maxDepth: 1, subagentProvider: 'spawn',
    budgetCeiling: 50, currency: 'USD', priceVersion: 'p7-card-test',
  })
  await service.open()
  service.setLaunchPort(new ScriptedLaunchPort())
  await ctx.plugin(commandWork)
  const sessionId = `p7c-${String(Math.random()).slice(2, 10)}`
  const handle = await ctx.agents.create({ sessionId: SessionId(sessionId) })
  cleanups.push(async () => {
    await handle.dispose()
    await service.close()
    await ctx.fiber.dispose()
    rmSync(root, { recursive: true, force: true, maxRetries: 5 })
  })
  return { ctx, service, agent: handle.agent, sessionId }
}

/** The card wired to the REAL command plane, the way the browser wires it. */
function cardOver(r: Rig) {
  return createWorkCardActions(r.sessionId, async (_sessionId, line) => {
    const execution = await r.ctx.commands.execute(r.agent, line, [], new AbortController().signal)
    return execution === undefined
      ? { ok: true, value: undefined }
      : { ok: true, value: { result: { kind: execution.result.kind, text: execution.result.text ?? '' } } }
  })
}

describe('P7 card: the controls reach the REAL command plane and move the REAL record', () => {
  it('Start Work, Apply Target and Stop each change the durable run the card shows', async () => {
    const r = await rig()
    const card = cardOver(r)

    // Start Work with N.
    const started = await card.start(5)
    expect(started.ok).toBe(true)
    expect(started.text).toContain('Run authorized')
    const runId = r.service.findRunForSession(r.sessionId)!.runId
    expect(r.service.getRun(runId)!.requestedTarget).toBe(5)

    // Apply Target moves the run's durable target -- UI-ACTIVE-RUN.
    const applied = await card.applyTarget(11)
    expect(applied.ok).toBe(true)
    expect(r.service.getRun(runId)!.requestedTarget).toBe(11)

    // Stop pauses the run.
    const stopped = await card.stop()
    expect(stopped.ok).toBe(true)
    expect(r.service.getRun(runId)!.phase).toBe('paused')

    // Status reports what the card just did, read back from the host.
    const view = parseStatusText((await card.status()).text)
    expect(view.runId).toBe(runId)
    expect(view.phase).toBe('paused')
    expect(view.target).toBe(11)
  })

  it('Start Work with NO N takes the default, and the card cannot set the default', async () => {
    // The split, seen from the card. V5 section 13 gives the card a "Start Work"
    // and an "Apply Target" and NO control that writes the global default: the
    // default is a settings-section write, and routing it through the card would
    // be the conflation this slice exists to remove.
    const r = await rig()
    const card = cardOver(r)
    await card.start()
    const runId = r.service.findRunForSession(r.sessionId)!.runId
    expect(r.service.getRun(runId)!.requestedTarget).toBe(6)

    // The card's action surface has no "set default" verb at all.
    expect(Object.keys(card)).not.toContain('setDefault')
    expect(Object.keys(card)).not.toContain('defaultTarget')
  })

  it('Apply Target on a session with no run is REFUSED, not silently promoted to a start', async () => {
    // The authority edge must not be a back door: only `/work start` creates a
    // run, and a card whose Apply Target created one would be an authorization
    // path the human never took.
    const r = await rig()
    const card = cardOver(r)
    const outcome = await card.applyTarget(9)
    expect(outcome.ok).toBe(false)
    expect(outcome.text).toContain('No active run for this session')
    expect(r.service.listRunIds()).toHaveLength(0)
  })
})
