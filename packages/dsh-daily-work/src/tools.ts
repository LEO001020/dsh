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
            /**
             * Whether the assignment is durably recorded (V5 §7.2).
             *
             * Separate from `accepted` on purpose, and the separation is the
             * point of the slice: a submission at a full target is `ready: true,
             * accepted: false`, and before this field existed that caller had no
             * way to tell "your work is safe and will run when a slot frees"
             * from "your work was discarded".
             */
            ready: { type: 'boolean' },
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
          // ---- SUBMISSION IS DURABLE, AND ADMISSION IS A SEPARATE QUESTION ----
          //
          // This used to be `service.drain(runId, [one request], signal)` and
          // nothing else. A refusal writes nothing (deliberately, so a refusal
          // storm is free), so when the target was full the GOAL THE MODEL HAD
          // JUST STATED was not persisted anywhere: it existed only in this
          // argument, and the root had to re-derive it after every completion.
          // That is V5 §7's defect — a mechanical target turned into model
          // polling — and the durable ready table is the fix.
          //
          // The two halves are now explicit and reported separately, because
          // "was my assignment recorded" and "is it running" are different
          // questions and a single `accepted` boolean conflates them. A caller
          // that sees `accepted: false, ready: true` knows the work is SAFE and
          // will run when a slot frees; before this change that caller could only
          // conclude it had lost the work.
          const submitted = await service.submitReady({
            runId,
            taskId,
            prompt: goal,
            reservedCost: 1,
            ...args.childId === undefined ? {} : { childId: args.childId },
            // The tool call's own identity, so a later report can correlate the
            // durable row with the model call that decided it (V5 §7.1). The
            // session id is part of it because a taskId is only unique within a
            // run, and two runs can be driven by one model loop.
            sourceCallId: `${agent.session.header.id}:${taskId}`,
          })
          // The wake. `requestDrain` is a wake rather than a request, so it takes
          // no work of its own; it looks at the durable table this call just
          // wrote. Awaiting it means the tool's answer reflects the admission
          // attempt that followed, which is what the caller is asking about.
          await service.requestDrain(runId)
          const record = service.getRun(runId)
          const task = record?.tasks[taskId]
          return {
            action: 'submit',
            runId,
            // WHETHER THE ASSIGNMENT IS DURABLE. Always true on this path, and
            // reported explicitly rather than inferred from `accepted`, because
            // the whole point is that these differ.
            ready: submitted.created || (record?.readyAssignments?.[taskId] !== undefined),
            // WHETHER A CHILD WAS STARTED NOW. This is the old `accepted`.
            accepted: task !== undefined && task.state !== 'prepared',
            ...task === undefined ? {} : { taskState: task.state },
            // The reason a run at its target did not start this now. `none` means
            // the run is full, which is a healthy reading and not an error.
            ...(task === undefined
              ? { reason: service.counts(runId).deficitReason }
              : {}),
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
