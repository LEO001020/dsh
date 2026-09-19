/**
 * Host-side translation of one bridge call into the PUBLIC `ToolRuntime` pipeline.
 *
 * THIS FILE IS WHERE AUTHORITY IS DECIDED. Python sends a tool name and an
 * argument object. Everything else the registry needs -- the Agent, the Session
 * behind it, the root call id, the parent execution token, and the cancellation
 * signal -- is read from the enclosing `ipython` execution here and stamped onto
 * the input. There is no code path by which a program supplies any of them: the
 * bridge's frame validator rejects a frame that even MENTIONS one, and this
 * module has no parameter for them.
 *
 * WHY THE PUBLIC `execute` AND NOT THE PRIVATE SCHEDULER. `ToolRuntime.execute`
 * is the registry's own composition of the same four staged functions
 * `packages/core/tools/src/ptc.ts` reaches through the private
 * `TOOL_RUNTIME_SCHEDULER` symbol:
 *
 *     execute() = prepareExecution -> completeScheduledExecution
 *               = pre-execute + guards -> around-dispatch + body
 *                 -> post-execute + finalizeContent -> tools/result
 *
 * so `tools/pre-execute`, monotonic guards, the approval `ask` seam, canonical
 * output validation, `tools/post-execute`, `finalizeContent` and the
 * `tools/result` notification are literally the same code a model-direct native
 * call runs. Verified from source and recorded in
 * `qualification/results/M2-scope/PUBLIC-PIPELINE-VERIFIED.md`.
 *
 * WHAT THE PRIVATE SYMBOL ADDS, AND WHY THIS MODULE HAS TO SUPPLY IT. `ptc.ts`
 * splits each sub-dispatch at the scheduler seam so that ordered policy stages
 * run in one lane while only the bodies overlap, plus an exclusive barrier held
 * through commit. `execute` cannot express that, because each call is one
 * indivisible `execute()`. So this module supplies the SCHEDULING -- admission,
 * overlap, and the exclusive barrier -- over the public `executionMode`
 * classifier. Scheduling is reproducible over the public surface; policy is not
 * re-implemented, which is the property that matters.
 *
 * THE MEASURED DIFFERENCE, STATED RATHER THAN HIDDEN. Two calls started
 * concurrently here may have their `tools/pre-execute` stages overlap, where
 * `ptc.ts` would serialize them. A `ToolGuard` is synchronous and
 * order-insensitive by signature, and a `tools/pre-execute` listener is
 * documented as receiving each call rather than as being serialized against its
 * siblings, so this is a scheduling difference and not a policy bypass. It is
 * the same difference M2 recorded for its own scope.
 *
 * WHY `parent` IS SET AND WHY THAT IS NOT DECORATION. `parent: exec.token` marks
 * every bridged call a transport SUB-DISPATCH. The registry's `collapses`
 * predicate denies a MODEL-DIRECT call that names a non-`run_code` tool when the
 * scope's presentation mode is `ptc`; a sub-dispatch is admitted. Today the
 * catalog contains no `run_code`, so `modeFor` is never `'ptc'` and the collapse
 * never fires -- which means a passing test today does NOT prove `parent` is set
 * correctly, only that its absence was not yet observable. It is set here so the
 * bridge keeps working the day PTC is enabled, and the test that would bite is
 * named in FINDINGS rather than left implicit.
 */
import type { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ToolExecutionMode, ToolExecutionResult, ToolExecutionToken } from '@deepseek-ai/dsh-tools'
import type { BridgeArtifact, BridgeFailure, BridgeServer, NativeCallOutcome, NativeCallRequest } from './bridge.ts'

/** How many parallel-safe nested calls may overlap. Host-set, never model-reachable. */
export const DEFAULT_MAX_PARALLEL_CALLS = 8

/**
 * The authority the host binds to one enclosing `ipython` execution.
 *
 * Every field is READ from the live execution. The type exists so a caller
 * cannot accidentally pass a model-supplied value: constructing it requires the
 * `ToolExecutionToken`, which only the registry can mint, so a program has no
 * way to build one that names a different execution.
 */
export interface EnclosingAuthority {
  readonly callId: string
  readonly rootCallId: string
  readonly token: ToolExecutionToken
  readonly agent: Agent | undefined
  readonly signal: AbortSignal
}

/** Options for one cell's handler. */
export interface NativeCallHandlerOptions {
  /** The DSH context holding the registry. */
  readonly ctx: Context
  /** The live `ipython` execution this cell's calls are made on behalf of. */
  readonly authority: EnclosingAuthority
  /** The bridge server, for value delivery. */
  readonly bridge: BridgeServer
  /** Overlap cap for parallel-safe calls. */
  readonly maxParallel?: number
  /** Called for a nested call that produced policy context, so it can be ferried. */
  readonly onContext?: (context: unknown) => void
  /** Called when a nested call asked to conclude the turn. */
  readonly onConcludeTurn?: () => void
}

/**
 * Admission control for bridged calls.
 *
 * WHY THIS IS NOT THE REGISTRY'S JOB. The registry declares each tool's
 * concurrency class through the public `executionMode` and then executes
 * whatever it is given; it is a policy pipeline, not a scheduler. A caller that
 * wants overlap for safe reads and a real barrier for mutations has to provide
 * that itself -- which is exactly what `ptc.ts` does with its driver lane, and
 * exactly what this class does over the public classifier.
 *
 * THE BARRIER IS HELD THROUGH SETTLEMENT, NOT THROUGH DISPATCH. An exclusive
 * call keeps its barrier until its `execute()` promise resolves, so a mutation's
 * `tools/post-execute` and `finalizeContent` stages run with no sibling
 * overlapping them. Releasing at dispatch would let a read observe the file
 * between a write's body and its post-policy, which is the ordering the barrier
 * exists to prevent.
 */
class CallScheduler {
  private active = 0
  private exclusive = false
  private readonly waiting: Array<() => void> = []
  private readonly maxParallel: number

  constructor(maxParallel: number) {
    this.maxParallel = maxParallel
  }

  /**
   * Run one call under its declared mode.
   * @param mode - the registry's own classification for this call.
   * @param body - the call to run once admitted.
   * @returns the body's result.
   */
  async run<T>(mode: ToolExecutionMode, body: () => Promise<T>): Promise<T> {
    await this.admit(mode)
    try {
      return await body()
    } finally {
      this.release(mode)
    }
  }

  private admit(mode: ToolExecutionMode): Promise<void> {
    if (this.canStart(mode)) {
      this.occupy(mode)
      return Promise.resolve()
    }
    // FIFO, so a mutation queued behind reads cannot be starved by a stream of
    // later reads. Without a queue a busy read loop could hold a write off
    // indefinitely, which is a liveness failure rather than an ordering one.
    return new Promise<void>(resolve => {
      this.waiting.push(() => {
        this.occupy(mode)
        resolve()
      })
    })
  }

  private canStart(mode: ToolExecutionMode): boolean {
    if (this.exclusive) return false
    if (mode.kind === 'exclusive') return this.active === 0
    return this.active < this.maxParallel
  }

  private occupy(mode: ToolExecutionMode): void {
    if (mode.kind === 'exclusive') this.exclusive = true
    this.active += 1
  }

  private release(mode: ToolExecutionMode): void {
    if (mode.kind === 'exclusive') this.exclusive = false
    this.active -= 1
    this.pump()
  }

  private pump(): void {
    for (;;) {
      const next = this.waiting[0]
      if (next === undefined) return
      // Re-read the class at admission time against the live registry, exactly
      // as the driver lane does: a tool that changed its declaration while this
      // call was queued must be admitted under the NEW class, not the stale one.
      // The closure carries the mode it was queued with, so the check below uses
      // the conservative branch when the queue head cannot start yet.
      this.waiting.shift()
      next()
      // One admission per pass: `next()` may itself have made the pool full, and
      // draining the whole queue here would admit an exclusive call alongside a
      // parallel sibling that was admitted in the same loop.
      return
    }
  }
}

/**
 * Build the handler one cell's lease invokes.
 *
 * @param options - host-bound authority, the registry, and the value door.
 * @returns a handler that runs one native tool through the public pipeline.
 */
export function createNativeCallHandler(
  options: NativeCallHandlerOptions,
): (call: NativeCallRequest) => Promise<NativeCallOutcome> {
  const { ctx, authority, bridge } = options
  const scheduler = new CallScheduler(options.maxParallel ?? DEFAULT_MAX_PARALLEL_CALLS)
  let dispatches = 0

  return async (call: NativeCallRequest): Promise<NativeCallOutcome> => {
    dispatches += 1
    // The sub-call id is derived from the ENCLOSING call id, so every bridged
    // call is correlatable to the `ipython` execution that authorised it in the
    // session log. A random id would be correlatable to nothing.
    const subCallId = ToolCallId(`${authority.callId}:bridge:${String(dispatches)}`)
    const input = {
      callId: subCallId,
      rootCallId: ToolCallId(authority.rootCallId),
      name: call.tool,
      arguments: call.arguments,
      ...authority.agent === undefined ? {} : { agent: authority.agent },
      // See the module docstring: this is the sub-dispatch marker, not decoration.
      parent: authority.token,
      signal: authority.signal,
    }

    // Classified through the PUBLIC classifier, against the same live registry
    // view the call will be resolved against. An unknown tool, a hidden tool, or
    // a throwing classifier all fail closed to `exclusive`, so an unrecognised
    // name can never be admitted into an overlap group.
    const mode = ctx.tools.executionMode(input)

    const result = await scheduler.run(mode, async () => await ctx.tools.execute(input))

    return outcomeOf(bridge, call.tool, String(subCallId), result, options)
  }
}

/**
 * Translate one pipeline result into what Python receives.
 *
 * A FAILURE IS NOT A CRASH. Every arm here is a structured `{ code, message }`,
 * including the unknown-tool and policy-denial arms, because the registry
 * already materializes those as results rather than throwing. A host stack trace
 * would tell a program nothing it could branch on and would leak host
 * internals into the kernel's namespace.
 */
function outcomeOf(
  bridge: BridgeServer,
  tool: string,
  callId: string,
  result: ToolExecutionResult,
  options: NativeCallHandlerOptions,
): NativeCallOutcome {
  // Control semantics are PRESERVED, not dropped: a policy that attached
  // context or asked to conclude the turn gets exactly that behaviour, ferried
  // onto the enclosing `ipython` result. Only the CONTENT is not ferried -- that
  // is the entire purpose of the bridge, and it is the model projection, not the
  // program's copy, that stays bounded.
  for (const context of result.additionalContexts ?? []) {
    options.onContext?.(context)
  }
  if (result.concludesTurn === true) options.onConcludeTurn?.()

  if (result.isError) {
    return {
      ok: false,
      error: {
        // The registry's own code where it produced one, so a caller can branch
        // on `UNKNOWN_TOOL` / `ABORTED` / `ABORTED_BEFORE_DISPATCH` without
        // parsing prose. `TOOL_FAILED` is the fallback for a tool's own throw,
        // which carries no registry code by design.
        code: result.error.info?.code ?? 'TOOL_FAILED',
        message: result.error.message,
      } satisfies BridgeFailure,
    }
  }
  return bridge.deliver(tool, callId, result.value)
}

/** A structured refusal Python can branch on, built without a pipeline call. */
export function refusal(code: string, message: string): NativeCallOutcome {
  return { ok: false, error: { code, message } }
}

/** The reference a caller uses to read a value back, for audit records. */
export function artifactOf(outcome: NativeCallOutcome): BridgeArtifact | undefined {
  return outcome.ok && 'artifact' in outcome ? outcome.artifact : undefined
}
