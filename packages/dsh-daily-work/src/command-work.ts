/**
 * The human `/work` command: the product's run-authorization entry point.
 *
 * WHY THIS FILE EXISTS, and it is the whole point of phase R4. `WorkService`
 * was complete, unit-tested and correct while NOTHING in the product called
 * `createRun`: its only non-test caller was a hand-run CLI in no production
 * import graph (docs/GAPS.md G-SEAM-31, reproduced by a real composed-profile
 * boot). The consequence was measured, not argued: the model's `work` tool
 * resolved the run FIRST and returned
 *
 *     this session has no active run; a run is created by user authorization
 *
 * so the mandatory N=10 rolling top-up could not be exercised by ANY user
 * action, and every N=10 result came from tests that called `createRun`
 * directly. This file is the missing entry point.
 *
 * WHY A COMMAND AND NOT A MODEL TOOL. `ctx.commands` is DSH's HUMAN command
 * registry: `CommandRuntime.execute` resolves the definition and calls the
 * handler directly, WITHOUT sending the line to the model, and it logs
 * `command/run` / `command/done` on the session with `source.kind === 'user'`.
 * That is a human-control seam that already exists, already carries the exact
 * receiving Agent, and already produces the audit trail. Adding `work.create` as
 * a model tool would instead require reconstructing human authority inside a
 * tool call, where `exec.agent` existing is NOT user authorization — a subagent,
 * a goal continuation, a synthetic system message or a resume replay would all
 * satisfy it. V3 section I says not to do that, and the honest reading is that
 * it is unnecessary: the human already has a command plane.
 *
 * WHAT THIS FILE IS NOT ALLOWED TO BE. It is an ADAPTER. Every branch below
 * parses input and calls ONE `WorkService` domain operation; no authorization
 * decision, no record mutation and no capacity arithmetic happens here. If this
 * file ever needs to know a rule the service does not enforce, the rule is in
 * the wrong place.
 *
 * THE `work` TOOL IS UNCHANGED by this phase, deliberately. It still resolves
 * the run and still refuses when there is none; what changed is that a human
 * action can now put a run there. Its authority model (a model call may submit
 * and finish, never authorize) is exactly what V3 section I3 asks for.
 *
 * @module command-work
 */
import type { Context } from '@deepseek-ai/cordis'
import { CommandDefinitionId } from '@deepseek-ai/dsh-commands/brand'
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import type { WorkService } from './host.ts'
import { HARD_CHILD_CAPACITY } from './capacity.ts'

export const name = 'dsh-daily-work-command'
export const inject = ['commands']

/** The registered command name, without the leading slash. */
export const WORK_COMMAND_NAME = 'work'

/** The verb that creates a run. Named once so the evidence and the grammar cannot drift. */
export const START_ACTION = 'start'

const USAGE = [
  'Usage: /work <start [N] | target N | stop | status>',
  '  start [N]  authorize a run for this session, with target N children (1-30)',
  '  target N   change the sustained child target of the active run',
  '  stop       stop admitting new children; running children keep their slots',
  '  status     show the current run and its counts',
].join('\n')

/** One parsed human intent. A closed union, so an unhandled verb cannot compile. */
type WorkCommand =
  | { readonly kind: 'status' }
  | { readonly kind: 'start'; readonly target: number | undefined }
  | { readonly kind: 'target'; readonly target: number }
  | { readonly kind: 'stop' }
  | { readonly kind: 'invalid'; readonly reason: string }

/** Fail loudly if this closed union gains an unhandled member. */
/* v8 ignore start -- closed-union backstop is unreachable without violating the TypeScript contract */
function assertNever(value: never, label: string): never {
  throw new TypeError(`unknown ${label}: ${String(value)}`)
}
/* v8 ignore stop */

/**
 * Parse an exact integer target in [1, HARD_CHILD_CAPACITY].
 *
 * A REFUSAL, never a clamp, and the reason is a real class of bug rather than
 * pedantry: a clamped target would record a number the human did not ask for, so
 * a user who typed `/work start 50` would get a run claiming N=30 and no
 * indication that their instruction was altered. Refusing makes the divergence
 * visible at the point where the human can correct it.
 */
function parseTarget(raw: string): { readonly target: number } | { readonly reason: string } {
  const text = raw.trim()
  if (text.length === 0) return { reason: 'a target is required' }
  if (!/^\d+$/u.test(text)) {
    return { reason: `target ${JSON.stringify(text)} is not a whole number` }
  }
  const target = Number(text)
  if (!Number.isSafeInteger(target) || target < 1 || target > HARD_CHILD_CAPACITY) {
    return {
      reason: `target ${text} is outside 1..${String(HARD_CHILD_CAPACITY)}; `
        + `${String(HARD_CHILD_CAPACITY)} is the deployment's hard child capacity`,
    }
  }
  return { target }
}

/** Parse only the grammar this command owns. */
export function parseWorkCommand(rawInput: string): WorkCommand {
  const input = rawInput.trim()
  if (input.length === 0) return { kind: 'status' }
  const [verb = '', ...rest] = input.split(/\s+/u)
  const tail = rest.join(' ')
  switch (verb.toLowerCase()) {
    case 'status':
      return tail.length === 0
        ? { kind: 'status' }
        : { kind: 'invalid', reason: 'status takes no arguments' }
    case 'stop':
      return tail.length === 0
        ? { kind: 'stop' }
        : { kind: 'invalid', reason: 'stop takes no arguments' }
    case 'start': {
      if (tail.length === 0) return { kind: 'start', target: undefined }
      const parsed = parseTarget(tail)
      return 'reason' in parsed
        ? { kind: 'invalid', reason: parsed.reason }
        : { kind: 'start', target: parsed.target }
    }
    case 'target': {
      const parsed = parseTarget(tail)
      return 'reason' in parsed
        ? { kind: 'invalid', reason: parsed.reason }
        : { kind: 'target', target: parsed.target }
    }
    default:
      return {
        kind: 'invalid',
        reason: `unknown /work verb ${JSON.stringify(verb)}. ${USAGE}`,
      }
  }
}

/** Resolve the service, or report the composition gap as a command error. */
function requireService(ctx: Context): WorkService {
  const service = ctx.get('dailyWork')
  if (service === undefined) {
    throw new Error(
      'the work service is not mounted in this host profile, so no run can be authorized',
    )
  }
  return service
}

/**
 * Render one run for a human.
 *
 * The counts are listed INDIVIDUALLY and never collapsed to one number, for the
 * same reason the `work` tool does it: `desiredTarget` is what the human asked
 * for and `activeAssignments` is what is actually running, and a surface that
 * showed only their difference would hide which side moved.
 *
 * @param includeRunId - whether to emit the `Run:` line. A caller whose header
 *   already names the run passes `false` rather than printing it twice.
 */
function renderStatus(
  runId: string,
  phase: string,
  target: number,
  counts: {
    readonly durablyAdmitted: number
    readonly launching: number
    readonly activeAssignments: number
    readonly stopping: number
    readonly quarantinedUnknown: number
    readonly confirmed: number
    readonly capacityDeficit: number
    readonly deficitReason: string
  },
  authorization: string | undefined,
  includeRunId = true,
): string {
  return [
    ...includeRunId ? [`Run: ${runId}`] : [],
    `Phase: ${phase}`,
    `Target: ${String(target)}`,
    `Durably admitted: ${String(counts.durablyAdmitted)}`,
    `Launching: ${String(counts.launching)}`,
    `Active assignments: ${String(counts.activeAssignments)}`,
    `Stopping: ${String(counts.stopping)}`,
    `Quarantined (unknown): ${String(counts.quarantinedUnknown)}`,
    `Confirmed: ${String(counts.confirmed)}`,
    `Capacity deficit: ${String(counts.capacityDeficit)} (${counts.deficitReason})`,
    ...authorization === undefined ? [] : [`Authorized by: ${authorization}`],
  ].join('\n')
}

/** Execute one parsed human command against the domain that owns the record. */
async function executeWorkCommand(ctx: Context, invocation: CommandInvocation): Promise<CommandResult> {
  const command = parseWorkCommand(invocation.rawInput)
  const service = requireService(ctx)
  const rootSessionId = invocation.agent.session.header.id

  if (command.kind === 'invalid') return { kind: 'error', text: command.reason }

  if (command.kind === 'status') {
    const existing = service.findRunForSession(rootSessionId)
    if (existing === undefined) {
      return {
        kind: 'success',
        text: `No active run for this session.\n${USAGE}`,
      }
    }
    const view = service.authorizeReadStatus(existing.runId)
    return {
      kind: 'success',
      text: renderStatus(
        existing.runId,
        view.record.phase,
        view.record.requestedTarget,
        view.counts,
        view.evidence === undefined
          ? undefined
          : `${view.evidence.kind}${view.evidence.commandId === undefined ? '' : ` ${view.evidence.commandId}`}`,
      ),
    }
  }

  if (command.kind === 'start') {
    // THE AUTHORIZATION EDGE. The evidence names the human command and its
    // exact `CommandId`, which `CommandRuntime` has ALREADY written to this
    // session's log as a `command/run` event with `source.kind === 'user'`
    // before this handler ran. So the ref points at a durable host-attested
    // record of the human action rather than at a claim this code makes.
    const evidence = {
      kind: 'human-command' as const,
      action: START_ACTION,
      commandId: String(invocation.commandId),
      commandName: WORK_COMMAND_NAME,
      commandArgs: invocation.rawInput.trim(),
    }
    // `authorizeRun` returns `created: false` when the root already has a
    // non-closed run. That is the idempotence V3 I2 requires.
    //
    // WHERE IT IS ENFORCED, corrected after measuring the first version's claim.
    // This comment used to say the check was "enforced by the DOMAIN (the run id is
    // derived from the session), not by a check here that a second caller could
    // race". That was FALSE on both halves: the check lived in `authorizeRun`, and
    // it COULD race. The derived id made two concurrent calls name the SAME key,
    // so the second `put` overwrote the first — measured: both calls reported
    // `Run authorized`, and a run holding one admitted task came back with zero.
    // The check is now performed inside `WorkService.serializeAuthorization`, so a
    // second concurrent call for one session cannot enter it until the first has
    // written. This adapter does not enforce it and does not claim to.
    const settled = await service.authorizeRun({
      root: invocation.agent,
      evidence,
      ...command.target === undefined ? {} : { targetChildren: command.target },
    })
    const view = service.authorizeReadStatus(settled.record.runId)
    // The header already names the run, so `renderStatus` is not asked to repeat
    // it: a duplicate `Run:` line reads as two runs to a human skimming output.
    const header = settled.created
      ? `Run authorized: ${settled.record.runId}`
      : `A run is already active for this session; nothing was created: ${settled.record.runId}`
    return {
      kind: 'success',
      text: [
        header,
        renderStatus(
          settled.record.runId,
          view.record.phase,
          view.record.requestedTarget,
          view.counts,
          view.evidence === undefined
            ? undefined
            : `${view.evidence.kind} ${view.evidence.commandId ?? ''}`.trim(),
          settled.created,
        ),
      ].join('\n'),
    }
  }

  if (command.kind === 'target') {
    const existing = service.findRunForSession(rootSessionId)
    if (existing === undefined) {
      return {
        kind: 'error',
        text: `No active run for this session, so there is no target to change. ${USAGE}`,
      }
    }
    const record = await service.authorizeSetTarget(existing.runId, command.target)
    return {
      kind: 'success',
      text: `Target updated.\nRun: ${record.runId}\nTarget: ${String(record.requestedTarget)}`,
    }
  }

  if (command.kind === 'stop') {
    const existing = service.findRunForSession(rootSessionId)
    if (existing === undefined) {
      return { kind: 'error', text: `No active run for this session, so there is nothing to stop. ${USAGE}` }
    }
    const record = await service.authorizeStop(
      existing.runId,
      `stopped by human command ${String(invocation.commandId)}`,
    )
    return {
      kind: 'success',
      text: [
        'Run stopped: new admissions are refused.',
        `Run: ${record.runId}`,
        `Phase: ${record.phase}`,
        'Children already running keep their capacity slots until they settle; a stop does not',
        'free a slot, because a running child is still spending.',
      ].join('\n'),
    }
  }

  /* v8 ignore next 2 -- WorkCommand is closed and every member is handled above */
  return assertNever(command, 'work command')
}

/**
 * Register `/work` for every composed command adapter.
 *
 * Registered from the PRESET, not the host profile: `ctx.commands` layers are
 * keyed by the Agent object, so a host-level registration publishes into the
 * root realm where no agent's scope sees it. That is the same trap
 * `agent.cordis.yml` documents for tools.
 */
export function apply(ctx: Context): void {
  ctx.commands.register({
    definitionId: CommandDefinitionId('dsh-daily-work#work'),
    name: WORK_COMMAND_NAME,
    description: 'Authorize and control a managed work run for this session',
    input: { hint: '<start [N] | target N | stop | status>' },
    handler: invocation => executeWorkCommand(ctx, invocation),
  })
}
