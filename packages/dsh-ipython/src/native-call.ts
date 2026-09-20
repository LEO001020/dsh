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
 * WHY THIS IS SERIAL, AND WHAT THAT DELIBERATELY GIVES UP. V3 §J1 is explicit and
 * it is a CORRECTION to an earlier plan, so it is restated here rather than left
 * in a document:
 *
 *   - `ctx.tools.execute()` runs ONE complete ToolRuntime call. It does NOT
 *     expose the native/PTC sibling scheduler to a downstream plugin.
 *   - `TOOL_RUNTIME_SCHEDULER` is a module-local `Symbol()`. A second physical
 *     copy of the `@deepseek-ai/dsh-tools` package makes it `undefined`, which is
 *     the crash upstream Discussion #6529 records. It is NEVER imported here.
 *   - `executionMode()` is a CLASSIFIER (`parallel | exclusive`), not a barrier,
 *     and this module does not use it as one.
 *
 * So the baseline is: ONE call at a time per lease, in bridge-accepted order.
 * The FIFO lives in `CellLease` (see `bridge.ts`) rather than here, because the
 * ORDER must be the order the bridge ACCEPTED the calls -- a queue inside this
 * handler would only see the calls that reached it, and a queued call the close
 * path abandons would have been reordered around without a record.
 *
 * WHAT THIS COSTS, STATED RATHER THAN HIDDEN. A cell that submits eight
 * independent reads gets them one after another instead of overlapped, so a
 * latency-bound fanout is slower than the previous concurrent handler. That
 * handler's overlap was real, but the property it claimed -- native scheduling
 * parity -- was not achievable over the public surface, and a fast wrong claim is
 * worse than a slower right one. High-throughput read fanout belongs in
 * `dsh.data` (V3 §K), which is a data plane over public capability seams rather
 * than a stream of exact ToolRuntime calls.
 *
 * THE ONE THING SERIAL EXECUTION BUYS FOR FREE. Composite semantics must reach
 * the outer `ipython` ToolRunContext IN SUBCALL ORDER (V3 §J4: "Do not let async
 * response order reorder deferred contexts"). With one call in flight at a time,
 * settlement order IS submission order, so the ferry below cannot reorder by
 * construction rather than by careful bookkeeping.
 *
 * WHY `parent` IS SET AND WHY THAT IS NOT DECORATION. `parent: exec.token` marks
 * every bridged call a transport SUB-DISPATCH. The registry's `collapses`
 * predicate denies a MODEL-DIRECT call that names a non-`run_code` tool when the
 * scope's presentation mode is `ptc`; a sub-dispatch is admitted. Today the
 * catalog contains no `run_code`, so `modeFor` is never `'ptc'` and the collapse
 * never fires -- which means a passing test today does NOT prove `parent` is set
 * correctly, only that its absence was not yet observable. It is set here so the
 * bridge keeps working the day PTC is enabled.
 */
import type { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ToolExecutionResult, ToolExecutionToken } from '@deepseek-ai/dsh-tools'
import type { BridgeArtifact, BridgeFailure, BridgeServer, NativeCallOutcome, NativeCallRequest } from './bridge.ts'

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
  /** Called for a nested call that produced policy context, so it can be ferried. */
  readonly onContext?: (context: unknown) => void
  /** Called when a nested call asked to conclude the turn. */
  readonly onConcludeTurn?: () => void
  /**
   * How a successful nested result whose content carries an IMAGE is treated.
   *
   * `defer` (the default) ferries it to the outer execution, which is PTC parity
   * (`ptc.ts` defers a successful image-bearing nested result as one user
   * message). `reference` records it and does NOT put it in model context, which
   * is what `programmatic-scope.ts` does by default. There is deliberately no
   * third arm that silently DROPS it: dropping a model-relevant image with no
   * record is the failure the brief names, and an option that did it would be an
   * option to be wrong.
   */
  readonly imageProjection?: 'defer' | 'reference'
  /** Called for each image-bearing result under `reference`, so the host can record it. */
  readonly onImageRetained?: (record: { callId: string, blockTypes: readonly string[], bytes: number }) => void
}

/**
 * Build the handler one cell's lease invokes.
 *
 * @param options - host-bound authority, the registry, and the value door.
 * @returns a handler that runs one native tool through the public pipeline.
 */
export function createNativeCallHandler(
  options: NativeCallHandlerOptions,
): (call: NativeCallRequest, context: { subCallId: string, sequence: number }) => Promise<NativeCallOutcome> {
  const { ctx, authority, bridge } = options

  return async (call: NativeCallRequest, context): Promise<NativeCallOutcome> => {
    // THE SUBCALL ID COMES FROM THE LEASE, NOT FROM A COUNTER HERE. The lease
    // mints it before the call is queued, so a call that is abandoned unstarted
    // still has the identity its ledger row was written under. A counter in this
    // function would only number the calls that actually ran, and the abandoned
    // ones -- exactly the calls BR-07 is about -- would have no id to record.
    const subCallId = ToolCallId(context.subCallId)
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

    const result = await ctx.tools.execute(input)
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
 *
 * THE COMPOSITE SEMANTICS ARE FERRIED, AND `concludesTurn` IS FERRIED AFTER THE
 * CONTEXTS. Only a successful nested result can carry the terminal marker
 * (`ToolExecutionFailure` types it `never`), so a policy-converted failure cannot
 * stop the turn through a recovering program -- the same rule `ptc.ts` states.
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

  if (!result.isError) {
    // NESTED IMAGE SEMANTICS, DEFINED RATHER THAN LEFT TO CHANCE. A successful
    // nested result whose content carries an image is model-relevant: PTC
    // forwards it, and silently dropping it here would mean a cell that produced
    // an image and a `run_code` program that produced the same image send
    // different things to the model. So it is either deferred (PTC parity, the
    // default) or explicitly retained-and-recorded -- never dropped.
    const imageBlocks = result.content.filter(block => block.type === 'image')
    if (imageBlocks.length > 0) {
      const bytes = imageBlocks.reduce((total, block) => total + imageBlockBytes(block), 0)
      if ((options.imageProjection ?? 'defer') === 'defer') {
        options.onContext?.({
          role: 'user',
          content: imageBlocks,
          source: { kind: 'plugin', plugin: 'dsh-ipython' },
        })
      } else {
        options.onImageRetained?.({
          callId,
          blockTypes: imageBlocks.map(block => block.type),
          bytes,
        })
      }
    }
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

/**
 * The decoded byte count of one image content block.
 *
 * A base64 block's DECODED size is what a reader means by "how many bytes were
 * involved", so the estimate is derived from the encoded length rather than
 * reporting the encoded length as if it were the payload. A block with no
 * measurable payload reports 0 rather than throwing: this feeds a record, and a
 * record that cannot be written because the thing it describes was unusual is
 * worse than a record with a stated zero.
 */
function imageBlockBytes(block: unknown): number {
  if (typeof block !== 'object' || block === null) return 0
  const record = block as Record<string, unknown>
  const source = record['source']
  if (typeof source === 'object' && source !== null) {
    const data = (source as Record<string, unknown>)['data']
    if (typeof data === 'string') return Math.floor((data.length * 3) / 4)
  }
  const data = record['data']
  if (typeof data === 'string') return Math.floor((data.length * 3) / 4)
  return 0
}

/** A structured refusal Python can branch on, built without a pipeline call. */
export function refusal(code: string, message: string): NativeCallOutcome {
  return { ok: false, error: { code, message } }
}

/** The reference a caller uses to read a value back, for audit records. */
export function artifactOf(outcome: NativeCallOutcome): BridgeArtifact | undefined {
  return outcome.ok && 'artifact' in outcome ? outcome.artifact : undefined
}
