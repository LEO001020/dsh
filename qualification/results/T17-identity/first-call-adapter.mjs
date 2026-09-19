/**
 * A probe-local keyless LLM adapter whose FIRST tool call names a tool the daily
 * composition actually carries.
 *
 * WHY A SECOND ADAPTER EXISTS AT ALL.
 * The shipped in-tree fixture (`packages/test-support/loader-smoke/tests/
 * fixtures/cli-mock-llm.ts`) always calls the platform shell -- `pwsh` on
 * win32 -- and the daily preset sets `tool-pwsh: disabled: true` as a deliberate
 * architecture decision. So the shipped fixture's first call is REFUSED with
 * `UNKNOWN_TOOL`, and the identity gate's oracle -- "the first tool call
 * actually succeeds" -- cannot be met by it. MEASURED: that fixture produced a
 * `tool/result` carrying `Error: unknown tool "pwsh"` with
 * `turnEndReason: "completed"`. That outcome is a PASS for the composition and a
 * FAIL for the oracle, and the two must not be confused.
 *
 * WHY `read` AND NOT `work`, THE ACTUAL FIRST CATALOG ENTRY.
 * The catalog order is measured and recorded separately
 * (`firstToolOffered: "work"`), so nothing is hidden by choosing a different
 * tool here. `work` is unusable as the FIRST CALL for a reason that has nothing
 * to do with identity: its handler requires an active run
 * (`packages/dsh-daily-work/src/tools.ts:133-138`), and a run is created only by
 * user authorization, so every `work` call on a fresh Session fails in the tool
 * BODY -- an outcome that would mask the dispatch-path question this gate asks.
 *
 * `read` is the right instrument instead, and it is a STRONGER one: it crosses
 * the filesystem provider the composition is built on (`ctx.fs`, mounted from
 * the `fs-local` row), so a successful `read` proves the dispatch path, the tool
 * registry, the schema, and the mounted backend in one call.
 *
 * WHY THIS FILE IMPORTS NOTHING.
 * The first version imported `ToolCallId` from `@deepseek-ai/dsh-llm` by bare
 * specifier and FAILED TO LOAD: `failed to import`, reported as
 * "1 entry did not activate". The reason is the resolution rule, not a typo.
 * The Loader resolves a bare specifier from the FILE's directory
 * (`vendor/loader/src/config/tree.ts:112-127`), and this file lives under
 * `qualification/results/T17-identity/`, which has no `node_modules` ancestor --
 * so no bare specifier resolves from here at all. The same rule is why the
 * overlay's shipped fixture must live INSIDE the checkout, whose package
 * directories carry the `@deepseek-ai/*` symlinks.
 *
 * An earlier agent in this project hit the mirror-image bug and anchored
 * `createRequire` at a directory with no `node_modules` ancestor, then reported
 * every peer unresolvable. The fix here is the honest one: this adapter needs no
 * import. `ToolCallId` is a branded string at runtime (a plain string), and the
 * registry does not `instanceof`-check the adapter -- it reads methods off the
 * object (`packages/llm/llm/src/index.ts:434,439,671,697,922,962`). Every method
 * it reads is therefore implemented below as a duck-typed member, and the set is
 * enumerated from the call sites rather than guessed.
 * @module t17-first-call-adapter
 */

/** Stable Cordis plugin name. */
export const name = 't17-first-call-adapter'

/** The provider route this adapter serves. Distinct from `cli-mock` on purpose. */
const PROVIDER = 't17-mock'

/** The tool the first call names. See the module doc for why this one. */
const FIRST_TOOL = 'read'

/**
 * The tool arguments.
 *
 * An ABSOLUTE path, read from the environment at module load, so the call cannot
 * depend on the session's cwd resolving the same way twice. The driver writes
 * the file before booting and records the text, so the result is checkable by a
 * reader rather than merely non-empty.
 */
const FIRST_ARGS = JSON.stringify({ file_path: process.env.T17_FIRST_CALL_FILE ?? '' })

/**
 * The keyless adapter, duck-typed.
 *
 * The method set is exactly what `LlmRuntime` reads from a registration:
 * `providerInfo` and `providerRetryPolicy` at registration
 * (`packages/llm/llm/src/index.ts:434,439`), `imageRequestPricing` and
 * `listModels` for catalog and pricing queries (`:671,697`), and
 * `prepareCall`/`stream` for dispatch (`:922,962`).
 */
export class T17FirstCallAdapter {
  /**
   * The provider metadata the registry validates on registration
   * (`packages/llm/llm/src/index.ts:434-437`): the returned `id` must equal the
   * route being registered and `name` must be non-empty.
   * @param provider - the route being described.
   * @returns display metadata for that route.
   */
  providerInfo(provider) {
    return { id: provider, name: 'T17 identity first-call adapter' }
  }

  /**
   * The provider-owned retry policy.
   * @returns `undefined`, so the runtime's normal defaults apply.
   */
  providerRetryPolicy() {
    return undefined
  }

  /**
   * Provider-side request-image pricing.
   * @returns `undefined`, declaring none rather than guessing.
   */
  imageRequestPricing() {
    return undefined
  }

  /**
   * Discoverable models for the route. Advisory only.
   * @param provider - the registered route.
   * @returns one entry naming the route itself.
   */
  async listModels(provider) {
    return [{ provider, id: provider, name: provider }]
  }

  /**
   * Exact model metadata.
   *
   * THE `reasoning` BLOCK IS DECLARED, and declaring it is load-bearing rather
   * than decorative. MEASURED: with no `reasoning` block the turn ended with
   * `provider "t17-mock" model "t17-mock" does not support reasoning effort
   * "off"`. The effort is requested by another row's own `agent/request`
   * middleware, so an adapter that declares no efforts is refused before it can
   * stream -- an outcome that has nothing to do with module identity.
   *
   * `off` is included because that is the effort a request-level hook asks for,
   * and `high` is the default so the first call does not depend on which effort
   * a caller happens to name.
   * @param provider - the registered route.
   * @param model - the exact model id.
   * @returns model identity, a context window, and the reasoning efforts.
   */
  async resolveModel(provider, model) {
    return {
      provider,
      id: model,
      name: model,
      context: { contextWindow: 131072 },
      reasoning: {
        efforts: [
          { id: 'off', name: 'Off' },
          { id: 'high', name: 'High' },
        ],
        defaultEffort: 'high',
      },
    }
  }

  /**
   * Bind model metadata and the eventual stream to one generation, which is the
   * contract `LlmRuntime.prepareCall` relies on (`:920-923`). The default
   * implementation in `LlmAdapter` does exactly this, and it is restated here
   * because this adapter deliberately does not extend that class.
   * @param provider - the registered route.
   * @param model - the exact model id.
   * @returns the model metadata and a one-generation stream entry point.
   */
  async prepareCall(provider, model) {
    return {
      model: await this.resolveModel(provider, model),
      stream: options => this.stream(options),
    }
  }

  /**
   * The stream. One tool call, then a final text answer once the result arrives.
   * @param options - the assembled request.
   * @returns the chunk stream.
   */
  async * stream(options) {
    const toolResult = options.messages
      .at(-1)?.content.find(block => block.type === 'tool-result')

    if (toolResult === undefined) {
      const reasoning = 'Calling the first tool the composition carries.'
      yield { type: 'block-start', index: 0, blockType: 'reasoning' }
      yield { type: 'reasoning-delta', index: 0, text: reasoning }
      yield { type: 'block-end', index: 0, block: { type: 'reasoning', text: reasoning } }
      yield { type: 'block-start', index: 1, blockType: 'tool-call' }
      yield {
        type: 'tool-call-delta',
        index: 1,
        // A branded string at runtime; no import is needed to produce one.
        id: 't17-first-call',
        name: FIRST_TOOL,
        argumentsDelta: FIRST_ARGS,
      }
      yield {
        type: 'block-end',
        index: 1,
        block: { type: 'tool-call', id: 't17-first-call', name: FIRST_TOOL, arguments: FIRST_ARGS },
      }
      yield { type: 'usage', usage: { inputTokens: 11, outputTokens: 3, cacheReadTokens: 2 } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }

    const text = toolResult.content
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('')
    const reply = `T17 first tool call round trip: ${text.trim()}`
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: reply }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: reply } }
    yield { type: 'usage', usage: { inputTokens: 7, outputTokens: 5, reasoningTokens: 1 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

/**
 * Register the adapter on the `t17-mock` route.
 *
 * `inject: ['llm']` IS correct here, unlike in the identity probe: this plugin
 * genuinely cannot do anything without the registry, and a missing `llm` service
 * would make it a no-op rather than an honest absence. The distinction matters
 * because `inject` is a readiness gate -- for a plugin whose subject is a service
 * that may legitimately be absent, injecting it would hide the finding.
 * @param ctx - the host context.
 */
export const inject = ['llm']

export function apply(ctx) {
  ctx.llm.registerAdapter([PROVIDER], new T17FirstCallAdapter())
}
