/**
 * The exact-owner guard for the `work` tool.
 *
 * WHY THIS FILE EXISTS. `tools.ts` resolves a run for a calling Agent by string
 * comparison:
 *
 *     const sessionId = agent.session.header.id
 *     for (const runId of service.listRunIds()) {
 *       const record = service.getRun(runId)
 *       if (record?.rootSessionId === sessionId) return runId
 *     }
 *
 * A SessionId is reused across an agent's life. DSH's `AgentRegistry.resume`
 * loads a persisted session and publishes a NEW Agent object under the SAME id
 * (`packages/core/agent/src/index.ts`: `enter()` rejects a duplicate id, so a
 * resume cannot be the same object). MEASURED in tool-protocol.test.ts: after
 * `resume`, `ctx.agents.get(id) === oldAgent` is false while
 * `String(oldAgent.id) === String(newAgent.id)` is true. So the string test
 * admits a callback holding the PREVIOUS lifecycle's object, and that object
 * writes authoritative state into the run the new lifecycle now owns.
 *
 * The discipline this file mirrors is DSH's own, from
 * `packages/terminal/terminal/src/index.ts`:
 *
 *     private isLiveOwner(owner: Agent): boolean {
 *       return !this.disposedOwners.has(owner) && this.ctx.get('agents')?.get(owner.id) === owner
 *     }
 *
 *     private ensureOwnerCleanup(owner: Agent): void {
 *       if (!this.isLiveOwner(owner)) {
 *         throw new TerminalError(`agent "${owner.id}" is not the registered PTY owner`, 'OWNER_NOT_LIVE')
 *       }
 *       ...
 *
 * and `packages/jobs/jobs-local/src/index.ts`:
 *
 *     if (agents.get(ownerId) !== owner) {
 *       throw new Error(`agent "${ownerId}" is not the registered agent instance (background job owner must be live)`)
 *     }
 *
 * Both compare OBJECT IDENTITY against the registry, not ids. That is the whole
 * point: an id survives a replacement, an object does not.
 *
 * WHY A GUARD AND NOT A CHECK IN THE TOOL BODY. A `tools/pre-execute` listener
 * can be written to return `{ kind: 'allow' }` by a later listener, so a
 * permission expressed there is not monotonic. `ToolRuntime.guard` is the
 * monotonic slot — `packages/core/tools/src/index.ts`:
 *
 *     "A monotonic execution guard evaluated after every `tools/pre-execute`
 *      listener and before the tool body. Returning a reason denies the call;
 *      returning `undefined` leaves it unchanged. Because guards have no allow
 *      result, listener ordering cannot turn a denial back into permission."
 *
 *     export type ToolGuard = (execution: Readonly<ToolExecution>) => string | undefined
 *
 * A guard is synchronous by signature. An `async` guard returns a Promise, which
 * is not `undefined`, so the runtime treats it as a denial reason and the call
 * fails closed — MEASURED in tool-protocol.test.ts. That is the safe direction,
 * and it is why this guard is a plain function.
 *
 * WHAT THIS FILE DOES NOT DO. It does not make the run record's `epoch` field
 * meaningful. `record.ts` documents the field as "bumped when a run is
 * re-adopted by a new host generation", but no code reads or writes it after
 * `initialRunRecord` sets it to 1, so a caller cannot present a stale epoch to
 * be rejected. Object identity is the check that is mechanically enforceable
 * today; the epoch is an unused field and is reported as such in FINDINGS.md
 * rather than dressed up as an enforcement point.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import { WORK_TOOL_NAME } from './tools.ts'

export const name = 'dsh-daily-work-tool-protocol-guards'
export const inject = ['tools', 'agents']

/**
 * Whether `agent` is the exact object the live registry currently holds for its
 * id.
 *
 * Mirrors `TerminalSessionService.isLiveOwner` and the `jobs-local` owner check.
 * The `?.` is load-bearing and fails CLOSED: with no `agents` service the
 * optional call yields `undefined`, which is never `=== agent`, so liveness
 * cannot be established and the caller refuses. Absence of the registry is not
 * evidence that an owner is live.
 *
 * @param ctx - any context of the runtime whose agent registry is consulted.
 * @param agent - the exact object claiming authority.
 * @returns true only while that object is the registry's current entry for its id.
 */
export function isExactLiveOwner(ctx: Context, agent: Agent): boolean {
  return ctx.get('agents')?.get(agent.id) === agent
}

/**
 * The denial reason for one execution, or `undefined` to leave it unchanged.
 *
 * Exported so a test can assert the decision without mounting a context, and so
 * a future consumer can reuse the exact predicate rather than restating it.
 *
 * An execution with no `agent` returns `undefined` deliberately. An ownerless
 * call is already refused by the tool body's own `requireAgent`, which names the
 * missing owner far more precisely than a guard reason can; denying here would
 * replace a specific diagnostic with a generic one while refusing the same call.
 * This guard exists for the case the body CANNOT see: an agent that is present
 * but no longer live.
 *
 * @param ctx - the context whose registry decides liveness.
 * @param exec - the pending call, as `tools/pre-execute` and the guard stage see it.
 * @param toolName - the guarded tool; other tools are left alone.
 * @returns a final denial reason, or `undefined`.
 */
export function exactOwnerDenialReason(
  ctx: Context,
  exec: Readonly<ToolExecution>,
  toolName: string = WORK_TOOL_NAME,
): string | undefined {
  if (exec.name !== toolName) return undefined
  const agent = exec.agent
  if (agent === undefined) return undefined
  if (isExactLiveOwner(ctx, agent)) return undefined
  return `agent "${String(agent.id)}" is not the registered agent instance: the session was replaced by a newer `
    + 'lifecycle, so this call carries a stale owner and cannot write authoritative state'
}

/**
 * Install the guard.
 *
 * Registered through `ctx.tools.guard` rather than `ctx.on('tools/pre-execute')`
 * because only the guard slot is monotonic: it runs AFTER every pre-execute
 * listener, so no listener can restore permission the guard withheld.
 *
 * Registered from whatever context this plugin is mounted on. Mounted at the
 * host plane it applies to every agent; mounted through an `agent.ctx` it would
 * apply to that agent alone (`guardReason` walks the global layer first, then
 * the scope chain). The deployment choice belongs to the profile, not here.
 *
 * @param ctx - the mounting context; owns the guard's lifetime.
 */
export function apply(ctx: Context): void {
  ctx.tools.guard(exec => exactOwnerDenialReason(ctx, exec))
}
