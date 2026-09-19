/**
 * The agent-scoped `work` tool.
 *
 * ONE tool with three actions, not three tools. The model gets a single entry
 * point and a typed canonical JSON answer; ids and states are never buried in
 * prose the model has to guess at.
 *
 * The schema is declared ONCE. Native calls and PTC calls are generated from the
 * same definition, so there is no second protocol that could drift.
 *
 * What the model may do: submit work, ask for status, propose that the run is
 * finished.
 * What the model may NOT do: lower the target N, raise the budget, widen its own
 * permissions, install plugins. Those are host configuration, set by the user
 * through trusted control. A tool that let the model edit its own resource
 * ceiling would not be a resource ceiling.
 *
 * This consumer is mounted in the AGENT PRESET. It holds no cross-session
 * mutable state: every call resolves the exact live Agent and the run it belongs
 * to. A `currentRun` field here would be a cross-session contamination bug,
 * because a preset's composition is standing, not per-session.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import type { WorkService } from './host.ts'

export const name = 'dsh-daily-work-tools'
export const inject = ['tools']

/** The single model-facing entry point. */
export const WORK_TOOL_NAME = 'work'

/**
 * Resolve the calling Agent.
 *
 * A tool invoked without an agent has no owner and therefore no authority. We
 * throw rather than guess, because guessing here would mean picking a run for
 * someone who never asked for one.
 */
function requireAgent(exec: ToolExecution): Agent {
  if (exec.agent === undefined) {
    throw new Error('the work tool requires an Agent-backed session')
  }
  return exec.agent
}

/** The run a root owns, if any. Read from the service, never cached here. */
function findRunFor(service: WorkService, agent: Agent): string | undefined {
  const sessionId = agent.session.header.id
  // The service is the authority on which runs exist; this consumer only maps
  // a live session to its run. Scanning is fine because a host holds few runs.
  for (const runId of service.listRunIds()) {
    const record = service.getRun(runId)
    if (record?.rootSessionId === sessionId) return runId
  }
  return undefined
}

export function apply(ctx: Context): void {
  ctx.tools.register(
    defineTool({
      name: WORK_TOOL_NAME,
      description: [
        'Manage rolling child work for this session.',
        'Actions:',
        '  status  - read the precise counts for the current run.',
        '  submit  - propose one task to run as a child. The host decides whether',
        '            it is admitted; admission is not execution.',
        '  finish  - declare the semantic work complete. This is a REQUEST: the',
        '            host still runs acceptance before anything is called verified.',
        'The target number of concurrent children, the budget and the permission',
        'ceiling are set by the user, not by this tool.',
      ].join('\n'),
      parameters: {
        action: {
          type: 'string',
          required: true,
          enum: ['status', 'submit', 'finish'],
          description: 'Which work action to perform.',
        },
        taskId: {
          type: 'string',
          description: 'Stable id for the task. Required for submit; required for status of one task.',
        },
        goal: {
          type: 'string',
          description: 'Short statement of what the task must achieve. Required for submit.',
        },
        childId: {
          type: 'string',
          description: 'Pre-reserved child id. Optional; the host reserves one when omitted.',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            action: { type: 'string', required: true },
            runId: { type: 'string' },
            // Counts are reported individually and never reduced to one number.
            desiredTarget: { type: 'integer' },
            readyTasks: { type: 'integer' },
            durablyAdmitted: { type: 'integer' },
            launching: { type: 'integer' },
            activeAssignments: { type: 'integer' },
            waitingOwnedTool: { type: 'integer' },
            providerWaiting: { type: 'integer' },
            stopping: { type: 'integer' },
            quarantinedUnknown: { type: 'integer' },
            confirmed: { type: 'integer' },
            cancelled: { type: 'integer' },
            capacityDeficit: { type: 'integer' },
            deficitReason: { type: 'string' },
            accepted: { type: 'boolean' },
            reason: { type: 'string' },
            taskState: { type: 'string' },
          },
        },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
      },
      async execute(args, exec) {
        const agent = requireAgent(exec)
        const service = ctx.get('dailyWork')
        if (service === undefined) {
          throw new Error('the work service is not mounted in this host profile')
        }
        const runId = findRunFor(service, agent)
        if (runId === undefined) {
          throw new Error('this session has no active run; a run is created by user authorization')
        }

        if (args.action === 'status') {
          const counts = service.counts(runId)
          return {
            action: 'status',
            runId,
            desiredTarget: counts.desiredTarget,
            readyTasks: counts.readyTasks,
            durablyAdmitted: counts.durablyAdmitted,
            launching: counts.launching,
            activeAssignments: counts.activeAssignments,
            waitingOwnedTool: counts.waitingOwnedTool,
            providerWaiting: counts.providerWaiting,
            stopping: counts.stopping,
            quarantinedUnknown: counts.quarantinedUnknown,
            confirmed: counts.confirmed,
            cancelled: counts.cancelled,
            capacityDeficit: counts.capacityDeficit,
            deficitReason: counts.deficitReason,
          }
        }

        if (args.action === 'submit') {
          const taskId = args.taskId
          const goal = args.goal
          if (taskId === undefined || taskId === '') throw new Error('submit requires a taskId')
          if (goal === undefined || goal === '') throw new Error('submit requires a goal')
          const childId = args.childId ?? `child-${taskId}`
          const outcomes = await service.drain(
            runId,
            [{ taskId, childId, prompt: goal, reservedCost: 1 }],
            exec.signal,
          )
          const outcome = outcomes[0]
          const record = service.getRun(runId)
          return {
            action: 'submit',
            runId,
            accepted: outcome?.accepted ?? false,
            ...(outcome?.reason === undefined ? {} : { reason: outcome.reason }),
            ...(record?.tasks[taskId] === undefined ? {} : { taskState: record.tasks[taskId].state }),
          }
        }

        // action === 'finish'
        //
        // A semantic end request. It does NOT confirm anything: the run moves to
        // `closing` and the acceptance runner decides what is actually verified.
        // Reporting "complete" from here would make the model the oracle for its
        // own work, which is precisely what the verification gate forbids.
        await service.beginClosing(runId)
        const counts = service.counts(runId)
        return {
          action: 'finish',
          runId,
          accepted: true,
          reason: 'closing requested; acceptance still runs before anything is verified',
          desiredTarget: counts.desiredTarget,
          activeAssignments: counts.activeAssignments,
          stopping: counts.stopping,
          quarantinedUnknown: counts.quarantinedUnknown,
        }
      },
      presentCall: args => ({ card: 'generic', title: `work: ${args.action}`, kind: 'other' }),
    }),
  )
}
