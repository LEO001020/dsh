/**
 * The programmatic-call-scope host service.
 *
 * WHY THIS FILE EXISTS, AND WHY IT IS NOT JUST A LIBRARY. A scope that only a
 * test can construct proves the scope works; it does NOT prove anything uses it.
 * This project has already shipped that defect three times (GAPS.md G-FIX-04,
 * G-FIX-05): `setLaunchPort` and `takeContinuation` both had zero production
 * callers while their tests passed, and a plugin with no `dsh.bundle` never
 * reached the model at all. So the scope is exposed here as a HOST SERVICE that
 * the profile can load, and the intended consumer is named:
 *
 *     M3's `python_exec` cell. When the IPython kernel's native-tool callback
 *     arrives, the cell handler asks this service for a scope bound to the
 *     enclosing execution and routes every `tools.<name>(...)` call through it.
 *     `observations.call` in the architecture's Python SDK is the same call with
 *     `delivery: 'reference'`.
 *
 * WHY IT IS A SERVICE AND NOT A TOOL. It adds no model-facing schema. The
 * model's execution surface stays exactly what the profile already composes; a
 * second tool that could call tools would be the "second tool-bridge engine" the
 * plan forbids (MASTER_EXECUTION_PLAN M2: "不做第二工具桥引擎").
 *
 * WHAT THE SERVICE BINDS, AND WHAT IT REFUSES TO TAKE FROM A CALLER. The
 * authority-bearing facts — the exact Agent, the enclosing execution's parent
 * token, the enclosing signal, and the control sinks — are construction inputs.
 * `open()` takes them from the HOST call site (the transport tool's own
 * `ToolRunContext`), never from anything a model authored. There is deliberately
 * no method that accepts an agent id, a session id, or a policy override.
 */
import type { Context } from '@deepseek-ai/cordis'
import { Service } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import type { ToolExecutionToken } from '@deepseek-ai/dsh-tools'
import {
  createMemoryReferenceStore,
  createProgrammaticCallScope,
  type ProgrammaticCallScopeHandle,
  type ScopeCallDisposition,
  type ScopeJobHandoff,
  type ScopeReferenceStore,
} from './programmatic-scope.ts'

export const name = 'dsh-daily-programmatic-scope'
export const inject = ['tools']

/** Plugin configuration. Bounds only; no authority is configurable here. */
export interface Config {
  /** Top-level overlap cap for one scope. Default 10, matching the registry's own default. */
  readonly maxParallel?: number
  /** Byte budget for one `value` delivery. Default 64 KiB. */
  readonly valueBudgetBytes?: number
  /** Per-notice character bound for control contexts. Default 4096. */
  readonly noticeChars?: number
  /** Direct control notices before the rest are coalesced. Default 64. */
  readonly noticeLimit?: number
  /**
   * Content projection for non-text payloads. `reference` (the default) keeps
   * bulk payloads out of model context; `defer-images` reproduces stock
   * `run_code` behaviour. See `ProgrammaticCallScopeOptions.contentProjection`.
   */
  readonly contentProjection?: 'reference' | 'defer-images'
}

/**
 * Everything a scope needs that only the HOST can supply, read from the
 * enclosing transport tool's own execution context.
 */
export interface OpenScopeRequest {
  /** The exact Agent on whose behalf the program runs; undefined for an ownerless call. */
  readonly agent?: Agent
  /** The enclosing execution's own token. It marks each call a transport sub-dispatch. */
  readonly parent: ToolExecutionToken
  /** The enclosing execution's root call id, for correlation. */
  readonly rootCallId?: string
  /** The enclosing execution's cancellation. The scope follows it and drains on it. */
  readonly signal: AbortSignal
  /** Prefix for generated sub-call ids, normally the enclosing call id. */
  readonly callIdPrefix: string
  /** Attach a context to the enclosing execution's own result. */
  readonly deferContext: (context: UserMessage) => void
  /** Mark the enclosing execution's successful result as terminal for the turn. */
  readonly concludeTurn: () => void
  /** Optional host handoff for calls still queued at close. */
  readonly handoffToJobs?: ScopeJobHandoff
  /** Optional host-owned disposition sink, so the enclosing log records the drain. */
  readonly onDisposition?: (disposition: ScopeCallDisposition) => void
  /** Optional store; the service's own is used when omitted. */
  readonly references?: ScopeReferenceStore
}

/**
 * The host service. Owns the reference store (one per host, so a reference
 * minted by one scope can be read by the host after that scope has closed) and
 * mints scopes on request.
 */
export class ProgrammaticScopeService extends Service {
  /**
   * The registry this service mints scopes over.
   *
   * DECLARED ON THE CLASS, not only on the plugin module. Cordis refuses a bare
   * `ctx.tools` read from a context that did not inject it ("cannot get property
   * \"tools\" without inject"), and the SERVICE's context is a different context
   * from the plugin function's. The module-level `inject` gates when `apply`
   * runs; this one is what makes `this.ctx.tools` legal inside `open()`.
   * Measured: without it, a real profile boot mounted the service, listed its
   * whole interface, and then failed on the first `open()`.
   */
  static readonly inject = ['tools']

  private readonly config: Config
  private readonly references: ScopeReferenceStore
  /** Live scopes, so teardown can close every one of them rather than leak a drain. */
  private readonly live = new Set<ProgrammaticCallScopeHandle>()

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'programmaticScope')
    this.config = config
    this.references = createMemoryReferenceStore()
    // Teardown closes every live scope. A scope left open at unload would keep
    // in-flight native calls running with no owner, which is exactly the
    // "silently left running in the background" outcome BRG-07 forbids.
    ctx.effect(() => () => this.closeAll(), 'dsh-daily-programmatic-scope: live scopes')
  }

  /**
   * Mint one scope over the registry's public pipeline.
   *
   * The registry is read from the live context HERE, so a scope always uses the
   * current registry rather than one captured at service construction.
   * @param request - host-supplied authority and sinks.
   * @returns the scope handle; the caller owns its `close()`.
   */
  open(request: OpenScopeRequest): ProgrammaticCallScopeHandle {
    const scope = createProgrammaticCallScope({
      registry: this.ctx.tools,
      ...request.agent === undefined ? {} : { agent: request.agent },
      parent: request.parent,
      ...request.rootCallId === undefined ? {} : { rootCallId: request.rootCallId },
      signal: request.signal,
      callIdPrefix: request.callIdPrefix,
      control: {
        deferContext: request.deferContext,
        concludeTurn: request.concludeTurn,
      },
      references: request.references ?? this.references,
      ...this.config.maxParallel === undefined ? {} : { maxParallel: this.config.maxParallel },
      ...this.config.valueBudgetBytes === undefined ? {} : { valueBudgetBytes: this.config.valueBudgetBytes },
      ...this.config.noticeChars === undefined ? {} : { maxNoticeChars: this.config.noticeChars },
      ...this.config.noticeLimit === undefined ? {} : { maxNotices: this.config.noticeLimit },
      ...this.config.contentProjection === undefined ? {} : { contentProjection: this.config.contentProjection },
      ...request.handoffToJobs === undefined ? {} : { handoffToJobs: request.handoffToJobs },
      ...request.onDisposition === undefined ? {} : { onDisposition: request.onDisposition },
    })
    this.live.add(scope)
    return scope
  }

  /**
   * Close one scope and forget it.
   * @param scope - a handle from {@link open}.
   * @param reason - the close classification.
   */
  async close(scope: ProgrammaticCallScopeHandle, reason: 'completed' | 'aborted' | 'error'): Promise<void> {
    try {
      await scope.close(reason)
    } finally {
      this.live.delete(scope)
    }
  }

  /** Close every live scope. Called by the service's own teardown effect. */
  async closeAll(): Promise<void> {
    const scopes = [...this.live]
    this.live.clear()
    await Promise.allSettled(scopes.map(scope => scope.close('aborted')))
  }

  /** How many scopes are open right now, for a host that wants to assert quiescence. */
  openCount(): number {
    return this.live.size
  }

  /** The host-wide reference store, readable after the minting scope has closed. */
  get store(): ScopeReferenceStore {
    return this.references
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    programmaticScope: ProgrammaticScopeService
  }
}

/**
 * Mount the service.
 *
 * WHY AN `apply` AND NOT ONLY THE CLASS. A profile row names a package export
 * (`dsh-daily-work/programmatic-scope`) and the loader calls the module's
 * `apply`, exactly as `dsh-daily-work/host` does for the work service. Without
 * this the package would export a class that no declarative row can mount — and
 * a capability that nothing can load is the G-FIX-04 defect this project has
 * already shipped three times.
 *
 * The construction mirrors `host-plugin.ts`: `new Service(ctx, config)` is what
 * registers it under its service key, so `await ctx.plugin(...)` is a real
 * activation edge and `ctx.programmaticScope` is available immediately after.
 * @param ctx - the host context carrying `ctx.tools`.
 * @param config - bounds only; no authority is configurable here.
 */
export function apply(ctx: Context, config: Config = {}): void {
  new ProgrammaticScopeService(ctx, config)
}

export default ProgrammaticScopeService
