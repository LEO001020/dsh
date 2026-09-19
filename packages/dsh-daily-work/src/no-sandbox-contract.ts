/**
 * The deployment self-check for the Windows trusted-local, no-sandbox
 * composition: `ctx.noSandboxContract`.
 *
 * WHY THIS FILE EXISTS
 * ====================
 * This project MEASURED a silent-degradation mode, and it is the worst one it
 * has: deleting the `sandbox` + `sandbox-policy` rows left **7 entries
 * `pending`**, which cascaded so `shell`/`fs`/`ptcRuntime` never published,
 * which failed the preset mount, which took the model's tool face to
 * **`toolCount: 0`** -- while the process still started and printed only a
 * warning (`docs/decisions/AUDIT-REQUEST-nosandbox.md`, fact F). A deployment
 * that LOOKS alive with an empty tool face is the worst outcome available,
 * because every downstream gate would then be measuring nothing.
 *
 * The architecture decision (Windows trusted-local; the OS user account IS the
 * execution authority boundary) is only correct if the composed graph really is
 * the intended graph. This service is how that is checked, and it fails loudly
 * when it is not.
 *
 * WHAT THIS IS NOT
 * ================
 * It adds **no model tool, no scheduling, and no permission decision**. It is a
 * pure READ of the live graph plus a report. It cannot grant, widen, or deny
 * anything: every method either returns an observation or throws. There is no
 * method that mutates the graph, and none that a model can reach -- it
 * registers no `ctx.tools` entry and no preset row.
 *
 * WHY IT MUST NOT HARD-`inject`
 * =============================
 * `inject` is a READINESS GATE, not a declaration of interest: a plugin whose
 * `inject` names a service that never activates stays `pending` forever, and
 * `ctx.x` throws for a service the fiber did not declare. Both directions are
 * traps here, and this project has recorded the second one already: a probe
 * that declared a hard inject won the activation race and reported a **false
 * absence** (see `docs/GAPS.md` G-FIX-06's family, and `history-plugin.ts`'s
 * own comment on `export const inject: string[] = []`).
 *
 * So this plugin declares `inject: []` and reads every service through
 * `ctx.get('x')`, which returns `undefined` for an absent service instead of
 * throwing. The subject of this guard is a graph where services are LEGITIMATELY
 * absent (`ssh`, `sandbox` in a no-sandbox deployment, and `ptcRuntime` once
 * PTC leaves the daily), so a hard inject would make the guard unable to
 * observe the very states it exists to report.
 *
 * THE THREE-VALUE DISTINCTION THIS GUARD DEPENDS ON
 * =================================================
 * `packages/sandbox/sandbox-policy/src/index.ts:164-171` resolves:
 *
 *     explicit call mode  >  session override  >  deployment default
 *
 * so `defaultMode === 'danger-full-access'` is NOT sufficient. A Session
 * carrying an old `read-only` or `workspace-write` override still resolves to a
 * CONFINED mode while the deployment claims to be trusted-local. Checking the
 * deployment default alone would report a healthy deployment for a session that
 * is actually fenced. {@link NoSandboxContractService.session} therefore reports
 * all three values separately.
 *
 * HONEST LIMIT -- the `defaultMode` observability gap. `Config`'s schema default
 * is `'read-only'` (`:113`, `z.union([...]).default('read-only')`), and
 * `defaultMode` is a plain `SandboxMode` with no provenance. So **"mode was
 * never configured" and "mode was explicitly configured as `read-only`" are
 * INDISTINGUISHABLE from this service**. The guard reports `modeSource:
 * 'unobservable'` rather than guessing, and the deployment-level check is
 * therefore "the value is `danger-full-access`", never "the value was declared".
 * Closing this gap needs a provenance marker upstream (a config catalog read, or
 * a `modeSource` field on the service) -- not something this guard can invent.
 *
 * @module dsh-daily-work/no-sandbox-contract
 */
import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SandboxMode } from '@deepseek-ai/dsh-sandbox'
// TYPE-ONLY, so it is erased and adds no runtime edge. The real `Session` is
// required rather than a structural stand-in because `overrideOf` and `resolve`
// take the branded type, and a shim that merely LOOKS like a Session would let a
// caller pass something the projection registry cannot fold.
import type { Session } from '@deepseek-ai/dsh-session'

/**
 * The mode the trusted-local deployment must resolve to. Named as a constant so
 * the tests and the check share one spelling.
 */
export const TRUSTED_LOCAL_MODE: SandboxMode = 'danger-full-access'

/**
 * The escalation parameter names a CONFINING backend advertises on mutating
 * tools. Their presence on the model surface is the defect this guard exists to
 * catch, because it is invisible in the resolved graph: `dsh-tool-fs` gates them
 * on `ctx.fs.sandboxMode !== undefined` (`packages/fs/tool-fs/src/sandbox.ts:44-45`),
 * which is a property of the mounted BACKEND, not of the mode's value. A
 * deployment that sets `danger-full-access` and believes it is unconfined still
 * hands the model `sandbox_permissions` on `write`/`edit`.
 */
export const ESCALATION_PARAMETERS: readonly string[] = ['sandbox_permissions', 'justification']

/**
 * One check's outcome. `observed` is the value the check READ, so a reader sees
 * what the graph actually contained rather than only a verdict -- a bare boolean
 * cannot be audited after the fact, and this project has been bitten by exactly
 * that (an oracle weaker than its scenario).
 */
export interface ContractCheck {
  /** Stable check id, so a failure can be cited without quoting prose. */
  readonly id: string
  /** What this check establishes. */
  readonly subject: string
  /** The value observed on the live graph, rendered for a human reader. */
  readonly observed: string
  /** Whether the observation matches the intended trusted-local deployment. */
  readonly ok: boolean
  /**
   * Present when `ok` is false. Distinguishes "the graph is wrong" from "the
   * graph cannot be read", which are different facts and only one of them is
   * about the deployment.
   */
  readonly detail?: string
  /**
   * Present when the observation is correct but requires an action the guard
   * must not take itself. A Session override is the only such case today: the
   * override is legitimate history, and REWRITING it is a migration this guard
   * deliberately does not own.
   */
  readonly migrationRequired?: boolean
}

/** The complete report. `ok` is the conjunction; a caller that only reads `ok` still fails loudly. */
export interface ContractReport {
  /** Every check, in the order they were run. */
  readonly checks: readonly ContractCheck[]
  /** True only when every check is `ok`. */
  readonly ok: boolean
  /** The ids of the failing checks, in report order. */
  readonly violations: readonly string[]
  /** The ids of the checks that require a migration rather than a fix. */
  readonly migrationRequired: readonly string[]
}

/** The deployment-level half of the contract: everything readable without an Agent. */
export interface DeploymentObservation {
  /** `sandboxPolicy.defaultMode`, or `undefined` when the service is not mounted. */
  readonly defaultMode: SandboxMode | undefined
  /**
   * Where `defaultMode` came from. ALWAYS `'unobservable'` today, and stated
   * rather than inferred: the schema default and an explicit `read-only` are the
   * same value on the service (see the module header).
   */
  readonly modeSource: 'unobservable'
  /** `ctx.fs.sandboxMode` -- `undefined` means the mounted backend does not confine. */
  readonly fsSandboxMode: SandboxMode | undefined
  /** The `ctx.fs` provider's constructor name, so "local semantics" is a measurement. */
  readonly fsProvider: string | undefined
  /** `ctx.shell.sandboxMode`, or `undefined` when the shell is absent OR unconfining. */
  readonly shellSandboxMode: SandboxMode | undefined
  /** The `ctx.shell` provider's constructor name. */
  readonly shellProvider: string | undefined
  /** Whether a shell executor is mounted at all -- a separate fact from its mode. */
  readonly shellMounted: boolean
  /** `ctx.ptcRuntime.sandboxMode`, or `undefined` when PTC is not mounted. */
  readonly ptcSandboxMode: SandboxMode | undefined
  /** Whether a PTC runtime is mounted. */
  readonly ptcMounted: boolean
  /** Whether the `ipython` kernel service is mounted. */
  readonly ipythonMounted: boolean
  /** Whether an SSH connection service is mounted. */
  readonly sshMounted: boolean
  /** Whether an SSH-backed subprocess provider is mounted. */
  readonly sshSubprocessMounted: boolean
  /** Whether a WSL dependency is reachable from the composed services. */
  readonly wslMounted: boolean
}

/** The Agent-scoped half: the model's real capability surface. */
export interface SurfaceObservation {
  /** Every visible tool name, sorted. */
  readonly toolNames: readonly string[]
  /** The tools advertising `sandbox_permissions` and/or `justification`, with which fields. */
  readonly escalationTools: readonly { readonly name: string; readonly parameters: readonly string[] }[]
  /** Whether `pwsh` is on the surface. It must NOT be on the daily surface. */
  readonly pwshPresent: boolean
  /** Whether `ipython` is on the surface. It must be. */
  readonly ipythonPresent: boolean
  /** The `ipython` tool's input parameter names, exactly as advertised. */
  readonly ipythonParameters: readonly string[]
  /** Whether `run_code` (the PTC transport) is on the surface. Dormant is the intended state. */
  readonly ptcTransportPresent: boolean
}

/**
 * One Session's override observation -- the subtle half of the contract.
 *
 * A pure OBSERVATION carrying no verdict. Whether these three values are
 * acceptable is decided by {@link sessionChecks}, so the type cannot silently
 * encode a policy that a different caller would have set differently.
 */
export interface SessionObservation {
  /** The session's id, so a report names the session it is about. */
  readonly sessionId: string
  /** `sandboxPolicy.overrideOf(session)` -- the session's own logged mode, if any. */
  readonly override: SandboxMode | undefined
  /** What `resolve({ session })` actually returns -- the mode a confined call would run under. */
  readonly resolved: SandboxMode | undefined
}

/**
 * Read the deployment-level observation from a live context.
 *
 * Exported because it is the part that needs no Agent, and a boot probe or a
 * test may want it without mounting the service.
 *
 * @param ctx - the live context to read.
 * @returns the observed values. Absent services are reported as `undefined`,
 *   never thrown for: a missing service is one of the facts being measured.
 */
export function observeDeployment(ctx: Context): DeploymentObservation {
  // `ctx.get` rather than `ctx.fs`: this fiber declares no inject, so the
  // property read would throw for every absent service -- and the absent ones
  // are exactly what this guard is here to report.
  const policy = ctx.get('sandboxPolicy')
  const fs = ctx.get('fs')
  const shell = ctx.get('shell')
  const ptc = ctx.get('ptcRuntime')
  return {
    defaultMode: policy?.defaultMode,
    // Stated, not inferred. See the module header: the schema default and an
    // explicit `read-only` are the same value here, so this guard cannot and
    // does not claim to distinguish them.
    modeSource: 'unobservable',
    fsSandboxMode: fs?.sandboxMode,
    fsProvider: fs === undefined ? undefined : providerName(fs),
    shellSandboxMode: shell?.sandboxMode,
    shellProvider: shell === undefined ? undefined : providerName(shell),
    shellMounted: shell !== undefined,
    ptcSandboxMode: ptc?.sandboxMode,
    ptcMounted: ptc !== undefined,
    ipythonMounted: ctx.get('ipython') !== undefined,
    sshMounted: ctx.get('ssh') !== undefined,
    sshSubprocessMounted: ctx.get('sshSubprocess') !== undefined,
    wslMounted: ctx.get('wsl') !== undefined,
  }
}

/**
 * Read the model tool surface for one Agent.
 *
 * The scope key is the **Agent object**, not `agent.ctx`. That is measured, not
 * stylistic: `AgentLoop` builds the scope with `createScope(loopCtx, this)`
 * (`packages/core/agent-loop/src/agent.ts:104`) and DSH's own PTC harvests with
 * `registry.schemas(exec.agent)` (`packages/core/tools/src/ptc.ts:682`). Passing
 * `agent.ctx` yields a key owning no scope layer, so the view collapses to the
 * global layer -- the false `toolCount: 0` this project already recorded as
 * G-FIX-06. A guard that read the wrong key would report an empty surface for a
 * healthy deployment, which is a false alarm in the direction that destroys
 * trust in the guard.
 *
 * @param ctx - the live context.
 * @param agent - the Agent whose surface to read.
 * @returns the observation, or `undefined` when no tool registry is mounted --
 *   which is itself a finding, and distinct from an empty catalog.
 */
export function observeSurface(ctx: Context, agent: Agent): SurfaceObservation | undefined {
  const tools = ctx.get('tools')
  if (tools === undefined) return undefined
  const schemas = tools.schemas(agent)
  const escalationTools: { name: string; parameters: readonly string[] }[] = []
  for (const schema of schemas) {
    const properties = schema.parameters['properties']
    if (properties === null || typeof properties !== 'object' || Array.isArray(properties)) continue
    const advertised = ESCALATION_PARAMETERS.filter(name => name in properties)
    if (advertised.length > 0) escalationTools.push({ name: schema.name, parameters: advertised })
  }
  const ipython = schemas.find(schema => schema.name === 'ipython')
  return {
    toolNames: schemas.map(schema => schema.name).sort(),
    escalationTools,
    pwshPresent: schemas.some(schema => schema.name === 'pwsh'),
    ipythonPresent: ipython !== undefined,
    ipythonParameters: ipython === undefined ? [] : parameterNames(ipython.parameters),
    ptcTransportPresent: schemas.some(schema => schema.name === RUN_CODE_TOOL_NAME),
  }
}

/**
 * The PTC mode transport's reserved tool name.
 *
 * Duplicated as a literal rather than imported: `RUN_CODE_NAME` is exported by
 * `@deepseek-ai/dsh-tools`, but this guard must remain readable when the tool
 * registry is NOT mounted (that is one of the states it reports), and a
 * module-level import of the registry to read one constant would make the guard
 * depend on the thing it is checking.
 */
const RUN_CODE_TOOL_NAME = 'run_code'

/** The constructor name of a service, for reporting "which provider" as a measurement. */
function providerName(service: object): string {
  const ctor: unknown = Reflect.get(service, 'constructor')
  return typeof ctor === 'function' ? ctor.name : 'unknown'
}

/** The advertised parameter names of a compiled tool schema, in declaration order. */
function parameterNames(parameters: Record<string, unknown>): readonly string[] {
  const properties = parameters['properties']
  if (properties === null || typeof properties !== 'object' || Array.isArray(properties)) return []
  return Object.keys(properties)
}

/**
 * Build the deployment-level checks.
 *
 * Every check reports its OBSERVED value alongside its verdict, so a reader can
 * see what the graph contained rather than only whether it passed.
 *
 * @param observed - the deployment observation.
 * @returns the checks, in report order.
 */
export function deploymentChecks(observed: DeploymentObservation): ContractCheck[] {
  const checks: ContractCheck[] = []

  checks.push({
    id: 'sandboxPolicy.defaultMode',
    subject: 'the deployment default sandbox mode',
    observed: observed.defaultMode === undefined
      ? 'ctx.sandboxPolicy is NOT mounted'
      : `'${observed.defaultMode}'`,
    ok: observed.defaultMode === TRUSTED_LOCAL_MODE,
    ...observed.defaultMode === undefined
      ? { detail: 'no ctx.sandboxPolicy service is mounted, so no default mode exists. In this deployment that is also the tool-face-zeroing precondition: seven rows inject sandboxPolicy, and without it shell/fs/ptcRuntime never publish and the preset mount fails (measured: toolCount 0).' }
      : observed.defaultMode === TRUSTED_LOCAL_MODE
        ? {}
        : { detail: `the deployment default is '${observed.defaultMode}', which CONFINES. Note the observability limit: 'read-only' here is indistinguishable from an unset config, because Config's schema default is 'read-only' (sandbox-policy/src/index.ts:113).` },
  })

  checks.push({
    id: 'sandboxPolicy.defaultMode.provenance',
    subject: 'whether the default mode was explicitly declared or fell back to the schema default',
    observed: 'unobservable (the service carries the value, not its provenance)',
    // NOT a violation, because it cannot be one: this is a limit of what the
    // deployment exposes, and reporting it as a failure would make the guard
    // fail on a correct deployment. It is reported so no reader mistakes the
    // check above for a stronger claim than it is.
    ok: true,
    detail: "HONEST GAP. Config's schema default is 'read-only' and defaultMode is a plain SandboxMode, so 'never configured' and 'explicitly configured as read-only' are the SAME observation. This guard therefore checks the VALUE only; it cannot certify that the value was declared. Closing this needs an upstream provenance marker.",
  })

  checks.push({
    id: 'fs.provider',
    subject: 'the mounted filesystem backend has local (non-confining) semantics',
    observed: observed.fsProvider === undefined
      ? 'ctx.fs is NOT mounted'
      : `${observed.fsProvider} (sandboxMode: ${formatMode(observed.fsSandboxMode)})`,
    ok: observed.fsProvider !== undefined && observed.fsSandboxMode === undefined,
    ...observed.fsProvider === undefined
      ? { detail: 'no ctx.fs provider is mounted. The filesystem tools and the preset rows that need fs cannot activate, so the model surface is incomplete.' }
      : observed.fsSandboxMode === undefined
        ? {}
        : { detail: `the mounted filesystem is '${observed.fsProvider}', whose sandboxMode is '${observed.fsSandboxMode}' -- that is the sandbox FENCE, not local semantics. Swapping in the local backend (whose base getter returns undefined, fs/src/index.ts:103) is what removes it.` },
  })

  checks.push({
    id: 'shell.provider',
    subject: 'the mounted shell executor has local semantics',
    observed: observed.shellMounted
      ? `${observed.shellProvider ?? 'unknown'} (sandboxMode: ${formatMode(observed.shellSandboxMode)})`
      : 'ctx.shell is NOT mounted',
    // Conditioned on being mounted: a deployment may legitimately ship no shell
    // (this one disables the model-facing pwsh tool). What must NOT happen is a
    // mounted shell that confines.
    ok: !observed.shellMounted || observed.shellSandboxMode === undefined,
    ...observed.shellMounted && observed.shellSandboxMode !== undefined
      ? { detail: `the mounted shell executor '${observed.shellProvider ?? 'unknown'}' reports sandboxMode '${observed.shellSandboxMode}', so it would fence commands. Under trusted-local it must be the local executor (sandboxMode undefined).` }
      : {},
  })

  checks.push({
    id: 'ptcRuntime.sandboxMode',
    subject: 'the PTC runtime, when mounted, resolves to the trusted-local mode',
    observed: observed.ptcMounted
      ? `mounted, sandboxMode: ${formatMode(observed.ptcSandboxMode)}`
      : 'ctx.ptcRuntime is NOT mounted (PTC is absent from this surface)',
    // Conditioned: PTC leaving the daily surface is the INTENDED end state, so
    // its absence is not a violation. If it IS mounted it must not confine.
    ok: !observed.ptcMounted || observed.ptcSandboxMode === TRUSTED_LOCAL_MODE,
    ...observed.ptcMounted && observed.ptcSandboxMode !== TRUSTED_LOCAL_MODE
      ? { detail: `PTC is mounted and reports sandboxMode ${formatMode(observed.ptcSandboxMode)}; under trusted-local it must be '${TRUSTED_LOCAL_MODE}'. A missing provider would instead raise SANDBOX_UNAVAILABLE rather than run unconfined -- that fail-closed behaviour is the property DEP-05 preserves.` }
      : {},
  })

  checks.push({
    id: 'ipython.present',
    subject: 'the IPython kernel service is mounted',
    observed: observed.ipythonMounted ? 'ctx.ipython is mounted' : 'ctx.ipython is NOT mounted',
    ok: observed.ipythonMounted,
    ...observed.ipythonMounted
      ? {}
      : { detail: 'no ctx.ipython service. IPython is the PRIMARY execution surface of this architecture (the model reaches files and computation through it, not through a shell), so its absence removes the deployment\'s main capability -- not just one tool.' },
  })

  checks.push({
    id: 'ssh.absent',
    subject: 'no SSH execution provider is mounted',
    observed: `ssh: ${observed.sshMounted ? 'MOUNTED' : 'absent'}; sshSubprocess: ${observed.sshSubprocessMounted ? 'MOUNTED' : 'absent'}`,
    ok: !observed.sshMounted && !observed.sshSubprocessMounted,
    ...observed.sshMounted || observed.sshSubprocessMounted
      ? { detail: 'an SSH provider is mounted. It would be a SECOND execution world with a different filesystem identity, which is the confusion DEP-04 exists to prevent -- and trusted-local has exactly one world.' }
      : {},
  })

  checks.push({
    id: 'wsl.absent',
    subject: 'no WSL dependency is mounted',
    observed: observed.wslMounted ? 'a wsl service is MOUNTED' : 'no wsl service is mounted',
    ok: !observed.wslMounted,
    ...observed.wslMounted
      ? { detail: 'a WSL-backed service is mounted. The architecture decision turns WSL off and rebuilds everything natively on Windows; a WSL dependency would reintroduce the POSIX execution world whose read/network isolation was the reason it was rejected.' }
      : {},
  })

  return checks
}

/** Render a possibly-absent mode for the `observed` field. */
function formatMode(mode: SandboxMode | undefined): string {
  return mode === undefined ? 'undefined (does not confine)' : `'${mode}'`
}

/**
 * Build the model-surface checks for one Agent.
 *
 * @param observed - the surface observation, or `undefined` when no tool registry is mounted.
 * @returns the checks, in report order.
 */
export function surfaceChecks(observed: SurfaceObservation | undefined): ContractCheck[] {
  if (observed === undefined) {
    // A missing registry is NOT an empty catalog. Reporting it as one would be
    // the same false-negative this project recorded as G-FIX-06.
    return [{
      id: 'surface.registry',
      subject: 'the model tool registry is mounted',
      observed: 'ctx.tools is NOT mounted',
      ok: false,
      detail: 'no tool registry, so there is no model surface to read. This is a DEPLOYMENT fact (the registry plugin is not loaded), not "the model has no tools".',
    }]
  }

  const escalationNames = observed.escalationTools.map(tool => tool.name)
  return [
    {
      id: 'surface.escalation-parameters',
      subject: 'no tool advertises the sandbox escalation parameters',
      observed: observed.escalationTools.length === 0
        ? `none of ${String(observed.toolNames.length)} visible tools advertise ${ESCALATION_PARAMETERS.join('/')}`
        : observed.escalationTools
          .map(tool => `${tool.name} -> [${tool.parameters.join(', ')}]`)
          .join('; '),
      ok: observed.escalationTools.length === 0,
      ...observed.escalationTools.length === 0
        ? {}
        : {
          detail: `these tools advertise escalation: ${escalationNames.join(', ')}. The advertisement is gated on whether the mounted backend CONFINES (ctx.fs.sandboxMode !== undefined, tool-fs/src/sandbox.ts:44-45), NOT on the mode's value -- so a deployment that sets '${TRUSTED_LOCAL_MODE}' and believes it is unconfined still hands the model these fields, and a model that fills them in triggers an "already at maximum authority but still requesting escalation" retry loop. NOTHING in the resolved graph shows this; only the tool schema does.`,
        },
    },
    {
      id: 'surface.pwsh-absent',
      subject: 'the model-facing shell tool is absent from the daily surface',
      observed: observed.pwshPresent ? 'pwsh IS on the surface' : 'pwsh is absent',
      ok: !observed.pwshPresent,
      ...observed.pwshPresent
        ? { detail: 'pwsh is model-reachable. The daily surface is IPython-first: the shell is the tool the architecture decision demoted, and it is also one of the three that advertise escalation fields.' }
        : {},
    },
    {
      id: 'surface.ipython-present',
      subject: 'the IPython tool is on the surface with exactly one input parameter, `code`',
      observed: observed.ipythonPresent
        ? `ipython present, parameters: [${observed.ipythonParameters.join(', ')}]`
        : 'ipython is NOT on the surface',
      ok: observed.ipythonPresent
        && observed.ipythonParameters.length === 1
        && observed.ipythonParameters[0] === 'code',
      ...observed.ipythonPresent
        ? observed.ipythonParameters.length === 1 && observed.ipythonParameters[0] === 'code'
          ? {}
          : { detail: `the ipython tool advertises [${observed.ipythonParameters.join(', ')}]; the contract is EXACTLY one parameter, 'code'. A second parameter means the model gained a control the host is supposed to own (kernel lifecycle, output cap, timeout).` }
        : { detail: 'no ipython tool on the surface. Measured precedent: with the bundle mounted but the preset row absent, a real Session\'s catalog holds NO ipython entry -- and this is the tool-face-zeroing case, where the deployment starts and looks healthy while the model has nothing to execute with.' },
    },
    {
      id: 'surface.ptc-transport-absent',
      subject: 'the PTC transport (`run_code`) is absent from the daily surface',
      observed: observed.ptcTransportPresent ? 'run_code IS on the surface' : 'run_code is absent',
      ok: !observed.ptcTransportPresent,
      ...observed.ptcTransportPresent
        ? { detail: 'the PTC transport is model-visible. It is a second execution face over the same tools, and while it is present the PTC collapse is live (tools/src/index.ts:1330-1332 collapses non-run_code names when modeFor(scope) is ptc), so the catalog the model sees is not the catalog it can call by name.' }
        : {},
    },
  ]
}

/**
 * Build the Session-override checks.
 *
 * This is the subtle half. `resolve()` is
 * `request.mode ?? overrideOf(session) ?? defaultMode`
 * (`sandbox-policy/src/index.ts:164-171`), so a deployment whose DEFAULT is
 * `danger-full-access` still resolves a Session with an old `workspace-write`
 * override to `workspace-write` -- confined, while the deployment claims to be
 * trusted-local.
 *
 * The override is NOT rewritten here. It is logged session history, and
 * rewriting it is a migration with its own owner; this guard reports it as
 * `migrationRequired` so the condition is loud without being silently repaired.
 *
 * @param observed - the session observation.
 * @returns the checks, in report order.
 */
export function sessionChecks(observed: SessionObservation): ContractCheck[] {
  const acceptable = observed.override === undefined || observed.override === TRUSTED_LOCAL_MODE
  return [
    {
      id: 'session.override',
      subject: 'the session has no confining override',
      observed: `session ${observed.sessionId}: overrideOf = ${formatMode(observed.override)}, resolve() = ${formatMode(observed.resolved)}`,
      ok: acceptable,
      ...acceptable
        ? {}
        : {
          detail: `this session carries a '${observed.override ?? 'unknown'}' override, so resolve() returns '${observed.resolved ?? 'unknown'}' -- a CONFINED mode -- even though the deployment default is '${TRUSTED_LOCAL_MODE}'. The deployment is trusted-local; this session is not. The override is durable session history and must be MIGRATED (its owner's decision), not silently rewritten by a self-check.`,
          migrationRequired: true,
        },
    },
  ]
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    noSandboxContract: NoSandboxContractService
  }
}

/**
 * The deployment self-check service, reachable as `ctx.noSandboxContract`.
 *
 * Every method is a read. There is no `apply`-side effect beyond registering
 * this service, and no method that mutates the graph, the tool surface, or a
 * session.
 */
export class NoSandboxContractService extends Service {
  constructor(ctx: Context) {
    super(ctx, 'noSandboxContract')
  }

  /** The deployment-level observation of the live graph. */
  observe(): DeploymentObservation {
    return observeDeployment(this.ctx)
  }

  /**
   * Run the deployment-level checks.
   * @returns the report. Never throws for a degraded graph: a degraded graph is
   *   what it is FOR, and throwing would replace a readable report with one
   *   stack trace.
   */
  checkDeployment(): ContractReport {
    return report(deploymentChecks(this.observe()))
  }

  /**
   * Run the model-surface checks for one Agent.
   * @param agent - the Agent whose surface to read.
   * @returns the report.
   */
  checkSurface(agent: Agent): ContractReport {
    return report(surfaceChecks(observeSurface(this.ctx, agent)))
  }

  /**
   * Run the Session-override checks for one Session.
   * @param session - the session whose logged override to read.
   * @returns the report. A missing `sandboxPolicy` is reported as a violation
   *   rather than thrown for, because the caller may be running this on a
   *   degraded graph on purpose.
   */
  checkSession(session: Session): ContractReport {
    const policy = this.ctx.get('sandboxPolicy')
    if (policy === undefined) {
      return report([{
        id: 'session.policy',
        subject: 'the sandbox policy service is mounted',
        observed: 'ctx.sandboxPolicy is NOT mounted',
        ok: false,
        detail: 'without the policy service there is no override to read and no mode to resolve, so the session-level half of the contract cannot be established.',
      }])
    }
    return report(sessionChecks({
      sessionId: session.id,
      override: policy.overrideOf(session),
      resolved: policy.resolve({ session }).mode,
    }))
  }

  /**
   * Run every check that needs no Agent, plus the surface and session halves
   * when those are supplied.
   *
   * @param subject - the Agent and Session to include, when available.
   * @returns one combined report.
   */
  checkAll(subject: { readonly agent?: Agent; readonly session?: Session } = {}): ContractReport {
    const checks = deploymentChecks(this.observe())
    if (subject.agent !== undefined) checks.push(...surfaceChecks(observeSurface(this.ctx, subject.agent)))
    if (subject.session !== undefined) checks.push(...this.checkSession(subject.session).checks)
    return report(checks)
  }

  /**
   * Fail loudly on a graph that is not the intended trusted-local graph.
   *
   * This is the method a boot-time assertion calls. It exists so a caller can
   * choose "refuse to start" over "start degraded", which is the whole point of
   * this guard -- a deployment that looks alive with an empty tool face is the
   * worst outcome available.
   *
   * @param subject - the Agent and Session to include, when available.
   * @throws when any check fails, naming every failing check and its observed value.
   */
  assert(subject: { readonly agent?: Agent; readonly session?: Session } = {}): void {
    const result = this.checkAll(subject)
    if (result.ok) return
    const lines = result.checks
      .filter(check => !check.ok)
      .map(check => `  ${check.id}: ${check.observed}${check.detail === undefined ? '' : ` -- ${check.detail}`}`)
    throw new Error(
      `no-sandbox contract violated: ${String(result.violations.length)} check(s) failed. `
      + 'This deployment is NOT the intended trusted-local graph.\n'
      + lines.join('\n'),
    )
  }

  /**
   * Log the report and return it.
   *
   * The log level is chosen from the result, so a healthy boot is quiet and a
   * degraded one is loud -- the exact opposite of the measured silent-degradation
   * mode, where the process started and printed only a warning.
   *
   * @param subject - the Agent and Session to include, when available.
   * @returns the report, so the caller can act on it.
   */
  report(subject: { readonly agent?: Agent; readonly session?: Session } = {}): ContractReport {
    const result = this.checkAll(subject)
    const logger = this.ctx.logger('no-sandbox-contract')
    if (result.ok) {
      logger.info('trusted-local contract satisfied: %d check(s) ok', result.checks.length)
      return result
    }
    logger.warn(
      'trusted-local contract VIOLATED: %d of %d check(s) failed: %s',
      result.violations.length,
      result.checks.length,
      result.violations.join(', '),
    )
    for (const check of result.checks) {
      if (check.ok) continue
      logger.warn('  %s: %s%s', check.id, check.observed, check.detail === undefined ? '' : ` -- ${check.detail}`)
    }
    if (result.migrationRequired.length > 0) {
      logger.warn('migration required (NOT auto-fixed): %s', result.migrationRequired.join(', '))
    }
    return result
  }
}

/**
 * Fold checks into a report.
 *
 * @param checks - the checks to fold.
 * @returns the report, with `ok` as the conjunction.
 */
function report(checks: ContractCheck[]): ContractReport {
  return {
    checks,
    ok: checks.every(check => check.ok),
    violations: checks.filter(check => !check.ok).map(check => check.id),
    migrationRequired: checks.filter(check => check.migrationRequired === true).map(check => check.id),
  }
}

/**
 * Mount the deployment self-check.
 *
 * `inject` is empty ON PURPOSE, and that is load-bearing rather than tidy: this
 * guard's subject is a graph where services are legitimately absent, and a hard
 * inject would leave the plugin `pending` on exactly the degraded graph it exists
 * to report. Every read goes through `ctx.get`, which returns `undefined` instead
 * of throwing.
 *
 * @param ctx - the host context that owns this extension.
 */
export function apply(ctx: Context): void {
  new NoSandboxContractService(ctx)
}

export const name = 'dsh-daily-work-no-sandbox-contract'
/** See the module header: a hard inject would make the guard blind to its own subject. */
export const inject: string[] = []
