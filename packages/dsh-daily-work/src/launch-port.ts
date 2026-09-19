/**
 * The real launch port: a bridge from the work service to DSH's continuable
 * child machinery.
 *
 * This is the only file that touches `ctx.subagents`. Keeping it separate means
 * the top-up logic can be tested against a scripted port without a model
 * provider, while the production path uses the genuine DSH seam.
 *
 * The contract that matters, quoted from the DSH source
 * (`packages/subagent/subagent/src/index.ts:254-261`):
 *
 *   "Establish one durable continuable child and deliver its initial prompt.
 *    Resolves when the child's inbox ACCEPTS that prompt, without waiting for
 *    the turn to start or for the message to reach the Session log."
 *
 * So a resolved `startContinuable` is ADMISSION. It is not execution, and it is
 * certainly not completion. The port returns on that edge and no later, because
 * resolving later would make the work service believe a slot had become active
 * when nothing had started.
 *
 * Two refusals this port must NOT paper over:
 *
 *   - `DUPLICATE_CHILD` means the reserved childId already exists. That is a
 *     reconciliation trigger (query the existing child and its Session), NOT a
 *     reason to mint a fresh UUID and launch again. This port rethrows it
 *     unchanged so the caller cannot silently turn it into a double launch.
 *   - A launch that fails for an unknown reason leaves the child's existence
 *     unknown. The port throws; the work service records `unknown` and holds the
 *     reservation.
 */
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { ContinuableStartSpec, SubagentRuntime } from '@deepseek-ai/dsh-subagent'
import type { LaunchPort, LaunchRequest } from './host.ts'

/**
 * The slice of `ctx.subagents` this port uses.
 *
 * Typed as a structural subset of the real `SubagentRuntime` so the port can be
 * driven by a controlled stand-in in tests while still compiling against the
 * genuine interface. `Pick` rather than a hand-written interface, so a change to
 * the real signature breaks this file at compile time instead of at runtime.
 */
export type SubagentsLike = Pick<SubagentRuntime, 'startContinuable'>

/** What the port needs to launch. Narrow on purpose: no Context, no other service. */
export interface ContinuableLaunchDeps {
  readonly subagents: SubagentsLike
  /**
   * The exact live root Agent. Authority is bound to this object, not to a
   * session-id string, so a stale reference cannot launch work for a run whose
   * owner has been replaced.
   */
  readonly parent: Agent
  /** The provider that creates continuable children, e.g. 'spawn'. */
  readonly provider: string
  /** Max delegation depth. 1 forbids grandchildren, which is the first-version rule. */
  readonly maxDepth: number
  /** Optional provider/model route for children. Absent means inherit from the parent. */
  readonly agentOptions?: ContinuableStartSpec['request']['agentOptions']
}

/**
 * Build a LaunchPort over the real continuable seam.
 *
 * @param deps - the live parent, the provider name and the child route.
 * @returns a port whose `launch` resolves at the ADMISSION edge.
 */
export function createContinuableLaunchPort(deps: ContinuableLaunchDeps): LaunchPort {
  return {
    async launch(request: LaunchRequest, signal: AbortSignal): Promise<{ childId: string }> {
      const spec: ContinuableStartSpec = {
        provider: deps.provider,
        label: request.taskId,
        // The id is reserved and persisted BEFORE this call. Passing it here is
        // what makes a crash between reservation and launch recoverable: a retry
        // reconciles the same identity instead of inventing a new one.
        childId: SessionId(request.childId),
        request: {
          parent: deps.parent,
          // A continuable child takes ContentBlock[], never a bare string.
          prompt: [{ type: 'text', text: request.prompt }],
          maxDepth: deps.maxDepth,
          ...(deps.agentOptions === undefined ? {} : { agentOptions: deps.agentOptions }),
        },
        signal,
      }
      const started = await deps.subagents.startContinuable(spec)
      // The provider should echo the reserved id. If it ever allocated a
      // different one we must not silently accept it, because the record's
      // reconciliation relation is keyed on the reserved id.
      if (String(started.childId) !== request.childId) {
        throw new Error(
          `dailyWork: the provider admitted child "${started.childId}" for reserved id "${request.childId}"; refusing to record a mismatched identity`,
        )
      }
      return { childId: started.childId }
    },
  }
}
