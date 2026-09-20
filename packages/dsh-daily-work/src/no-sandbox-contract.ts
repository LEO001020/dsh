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
 * The name of the context entry `sandbox-policy` contributes to the model's
 * runtime context (`packages/sandbox/sandbox-policy/src/index.ts:143-152`).
 *
 * This is the ONE place where the deployment's mode becomes a statement the
 * model reads about its own authority, so it is the exact subject of the exit
 * criterion "the model is never told `workspace-write` while execution is
 * trusted-local". Checking the resolved MODE is not the same check: a provider
 * that rendered the wrong sentence for the right mode, or a second provider that
 * added a conflicting sentence, would pass a mode-only check and still mislead
 * the model.
 */
export const POLICY_CONTEXT_NAME = 'sandbox:policy'

/**
 * The literal substring `renderPolicyContext` emits for a CONFINING mode
 * (`sandbox-policy/src/index.ts:46-47`). Matched as a substring rather than by
 * comparing the whole sentence, because the sentence interpolates the workspace
 * root and a whole-string comparison would be a second copy of upstream's prose
 * that drifts silently.
 */
export const CONFINING_NARRATION_MARKER = 'workspace-write'

/**
 * The literal substring for the unconfined mode (`:48-49`).
 */
export const UNCONFINED_NARRATION_MARKER = 'danger-full-access'

/**
 * One boundary at which the contract is checked. V3 F2 names three, and they are
 * distinct events rather than three spellings of "check it somewhere": a
 * deployment can be correct at startup and be changed by a later session, and a
 * session can be correct while the PTC path resolves a DIFFERENT policy for the
 * same call.
 */
export type ContractBoundary = 'startup' | 'session-resume' | 'ptc-execution'

/**
 * How a boundary reacts to a violation.
 *
 * `refuse` THROWS and is the default for every boundary that gates further
 * product execution. It is deliberately not "switch the mode back to full
 * access": that would MASK a real configuration change -- someone restoring a
 * confining mode on purpose would see a healthy boot and a silently ignored
 * edit. The requirement is that a mutation to a non-full mode becomes a LOUD
 * incompatible-state failure, so the operator learns the deployment is no longer
 * the one they configured.
 */
export type BoundaryDisposition = 'refuse' | 'report'


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
   * `sandboxPolicy.workspaceRoot` -- the absolute fallback root.
   *
   * Reported because CMP-02's oracle names it: "its `workspaceRoot` resolves to
   * an absolute path". The service throws for a non-absolute value
   * (`sandbox-policy/src/index.ts:36-39`), so a non-absolute value here would
   * mean it arrived some other way -- which is exactly the kind of fact a
   * contract check should not assume away.
   */
  readonly workspaceRoot: string | undefined
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
 * What the MODEL is actually told about its own file authority.
 *
 * WHY THIS IS A SEPARATE OBSERVATION FROM THE RESOLVED MODE. The mode is a
 * mechanical value; the narration is the sentence that reaches the model. The
 * defect this guard was built for (G-SEAM-33 / spec case CMP-02) had BOTH wrong,
 * but they are independently wrong-able: a deployment could resolve
 * `danger-full-access` and still narrate confinement if a second contributor
 * added a conflicting sentence, or if the provider were replaced. Checking the
 * mode alone would pass that deployment while the model was still misled, which
 * is exactly the exit criterion ("the model is never told `workspace-write`
 * while execution is trusted-local") failing while the guard reported healthy.
 */
export interface NarrationObservation {
  /** Whether a `systemPrompt` registry is mounted at all. */
  readonly promptMounted: boolean
  /** Whether the assembly ran. False means the narration could not be read, which is itself a finding. */
  readonly assembled: boolean
  /** The error text when assembly threw, so "unreadable" is not reported as "absent". */
  readonly assembleError: string | undefined
  /** Whether the `sandbox:policy` context entry was contributed. */
  readonly policyContextPresent: boolean
  /** The exact rendered text of that entry, or `undefined` when it was not contributed. */
  readonly policyContextText: string | undefined
  /** Every contributed context entry name, so a second conflicting contributor is visible. */
  readonly contextNames: readonly string[]
  /** Whether the rendered narration contains the CONFINING marker. */
  readonly saysConfining: boolean
  /** Whether the rendered narration contains the UNCONFINED marker. */
  readonly saysUnconfined: boolean
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
    workspaceRoot: policy?.workspaceRoot,
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

/**
 * The model-facing workflow tool, whose ENGINE is the other producer of a PTC
 * execution.
 *
 * WHY THIS NAME IS IN THE GUARD, MEASURED RATHER THAN ASSUMED. Guarding only
 * `run_code` would have made this boundary UNREACHABLE in this composition, and
 * the reason is a composition fact that no amount of source reading replaces:
 *
 *   - the `tools` registry's presentation mode is its schema default `native`
 *     (`packages/bundle/web-app/cordis.patch.yml` sets `mode: !!js
 *     process.env.DSH_TOOLS_MODE`, which is unset here), so NO `run_code`
 *     transport is presented. MEASURED on a real boot: the daily preset's model
 *     surface is 27 tools and `run_code` is NOT among them
 *     (`qualification/results/R1-trusted-local/composition-after.json`,
 *     `ptc.runCodeOnSurface: false`).
 *   - the `workflow` tool IS on that surface, and its engine is
 *     `PtcWorkflowEngine`, which resolves
 *     `runCtx.sandboxPolicy.resolve({ session: request.parent.session })`
 *     (`packages/workflow/workflow-ptc/src/index.ts:164`) and hands that policy
 *     to the same `ptc-runtime-node` confine decision (`:224`).
 *
 * So the PTC execution boundary has TWO producers, and in this deployment only
 * the second is reachable. A guard that covered only `run_code` would have been
 * the exact defect this project has recorded more than twelve times: a mechanism
 * that is implemented, unit-tested, correct, and reached by nothing in the
 * product.
 */
const WORKFLOW_TOOL_NAME = 'workflow'

/** The tool names whose execution can reach a PTC confine decision. */
export const PTC_BOUNDARY_TOOL_NAMES: readonly string[] = [RUN_CODE_TOOL_NAME, WORKFLOW_TOOL_NAME]

/**
 * Whether a tool name can reach a PTC confine decision.
 *
 * @param name - the tool name from a pending execution.
 * @returns true for either PTC producer.
 */
function isPtcBoundaryTool(name: string): boolean {
  return name === RUN_CODE_TOOL_NAME || name === WORKFLOW_TOOL_NAME
}


/**
 * Read what the model is actually told about its own file authority.
 *
 * WHY THIS RUNS THE ASSEMBLY INSTEAD OF RESTATING THE SOURCE. The narration is a
 * `systemPrompt.context` PROVIDER -- a closure over the live policy
 * (`sandbox-policy/src/index.ts:143-152`), not a static string. Asserting
 * "the provider exists and renders the right sentence for the mode" would be the
 * weaker oracle this project keeps recording: it would still pass if the
 * provider were never registered, or if a second contributor prepended a
 * conflicting sentence. Running `assemble()` and reading the rendered text is
 * the same read `AgentLoop` performs (`agent-loop/src/agent.ts:246-249` calls
 * `assemble`, then `renderContextSections`/`joinContextSections`), so what is
 * checked here is the value that reaches the request.
 *
 * The scope argument is `{ agent, scope: agent }`, exactly
 * `assembleContextFor(agent)` (`packages/core/agent/src/dispatch.ts:174-176`).
 * Passing a bare `{}` would assemble only GLOBAL providers and could report a
 * missing narration for a deployment that contributes it per-agent -- a false
 * alarm in the direction that destroys trust in the guard.
 *
 * @param ctx - the live context.
 * @param agent - the Agent whose runtime context to assemble.
 * @returns the observation. A missing registry or a throwing assembly is
 *   REPORTED, never thrown for: "unreadable" and "absent" are different facts.
 */
export async function observeNarration(ctx: Context, agent: Agent): Promise<NarrationObservation> {
  const prompt = ctx.get('systemPrompt')
  if (prompt === undefined) {
    return {
      promptMounted: false,
      assembled: false,
      assembleError: undefined,
      policyContextPresent: false,
      policyContextText: undefined,
      contextNames: [],
      saysConfining: false,
      saysUnconfined: false,
    }
  }
  try {
    const assembly = await prompt.assemble({ agent, scope: agent })
    const contexts = assembly.contexts
    const entry = contexts.find(context => context.name === POLICY_CONTEXT_NAME)
    const text = entry?.text ?? ''
    return {
      promptMounted: true,
      assembled: true,
      assembleError: undefined,
      policyContextPresent: entry !== undefined,
      policyContextText: entry === undefined ? undefined : text,
      contextNames: contexts.map(context => context.name),
      saysConfining: text.includes(CONFINING_NARRATION_MARKER),
      saysUnconfined: text.includes(UNCONFINED_NARRATION_MARKER),
    }
  } catch (error) {
    return {
      promptMounted: true,
      assembled: false,
      assembleError: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
      policyContextPresent: false,
      policyContextText: undefined,
      contextNames: [],
      saysConfining: false,
      saysUnconfined: false,
    }
  }
}

/**
 * Build the model-facing narration checks.
 *
 * This is the check the exit criterion names in words: "the model is never told
 * `workspace-write` while execution is trusted-local". It is deliberately
 * separate from {@link deploymentChecks}, because a deployment can resolve the
 * right mode and still narrate the wrong one.
 *
 * @param observed - the narration observation.
 * @returns the checks, in report order.
 */
export function narrationChecks(observed: NarrationObservation): ContractCheck[] {
  if (!observed.promptMounted) {
    return [{
      id: 'narration.registry',
      subject: 'the system-prompt registry is mounted, so the model-facing narration can be read',
      observed: 'ctx.systemPrompt is NOT mounted',
      ok: false,
      detail: 'no prompt registry, so what the model is told about its own file authority cannot be established. This is a DEPLOYMENT fact (the registry plugin is not loaded), not "the model is told nothing".',
    }]
  }
  if (!observed.assembled) {
    return [{
      id: 'narration.assembled',
      subject: 'the runtime context could be assembled',
      observed: `assemble() threw: ${observed.assembleError ?? 'unknown error'}`,
      ok: false,
      detail: 'the assembly failed, so the narration is UNREADABLE rather than absent. Reporting this as "no confining sentence" would be the false negative this project recorded as G-FIX-06 in a new place.',
    }]
  }
  return [
    {
      id: 'narration.sandbox-policy',
      subject: `the model-facing runtime context says '${TRUSTED_LOCAL_MODE}', not a confining mode`,
      observed: observed.policyContextPresent
        ? `${POLICY_CONTEXT_NAME}: ${JSON.stringify(observed.policyContextText ?? '')}`
        : `no '${POLICY_CONTEXT_NAME}' context entry was contributed (contexts: ${observed.contextNames.join(', ') || '(none)'})`,
      // BOTH clauses are required. A missing entry is a violation rather than a
      // pass, because the sentence is the deployment's only statement to the
      // model about its own authority: its ABSENCE leaves the model uninformed,
      // and treating "no confining sentence" as success would let a deployment
      // pass by saying nothing.
      ok: observed.policyContextPresent && observed.saysUnconfined && !observed.saysConfining,
      ...observed.policyContextPresent && observed.saysUnconfined && !observed.saysConfining
        ? {}
        : observed.policyContextPresent && observed.saysConfining
          ? { detail: `the model is told '${CONFINING_NARRATION_MARKER}' about its own file authority while the deployment claims trusted-local. This is a FALSE STATEMENT ABOUT THE MODEL'S PERMISSIONS, not a cosmetic mismatch: the model plans around a fence that does not exist. The sentence is rendered from the SAME resolved policy the PTC confine decision reads (sandbox-policy/src/index.ts:42-56), so this and a confining mode are the same defect seen twice.` }
          : observed.policyContextPresent
            ? { detail: `the '${POLICY_CONTEXT_NAME}' entry rendered but does not name '${UNCONFINED_NARRATION_MARKER}'. The deployment's own sentence must state the mode it actually runs under; an unrecognised rendering means the text and the mode have drifted apart.` }
            : { detail: `no '${POLICY_CONTEXT_NAME}' context entry. The sandbox policy contributes the model's only statement about its own file authority; without it the model is UNINFORMED rather than correctly informed, and a reader cannot distinguish that from a policy row that failed to activate.` },
    },
    {
      id: 'narration.no-conflicting-policy-context',
      subject: 'no second context entry contradicts the sandbox policy',
      observed: observed.contextNames.length === 0
        ? 'no context entries at all'
        : `contributors: ${observed.contextNames.join(', ')}`,
      // The registry does not enforce uniqueness of the CONTRIBUTION (only of
      // the registration name), so two rows can each contribute a sentence
      // about permissions. A reader that only looked for the policy entry would
      // miss a conflicting one entirely.
      ok: observed.contextNames.filter(name => name === POLICY_CONTEXT_NAME).length <= 1,
      ...observed.contextNames.filter(name => name === POLICY_CONTEXT_NAME).length <= 1
        ? {}
        : { detail: `'${POLICY_CONTEXT_NAME}' was contributed more than once, so the model receives two statements about its own file authority. The later one does not win by construction -- both reach the request.` },
    },
  ]
}

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

/**
 * Build the policy-level checks: the deployment's OWN declaration.
 *
 * THESE ARE THE STARTUP SUBJECT, and the narrowness is deliberate. The startup
 * boundary runs the moment `sandboxPolicy` mounts, which is EARLIER than the rest
 * of the tree: `fs`, `shell` and `ipython` have not published yet. Running the
 * full contract there measured a half-mounted graph and reported three failures
 * for a correct deployment (the first attempt at this boundary did exactly that,
 * and the boot log is kept in
 * `qualification/results/R1-trusted-local/`). So this function carries only the
 * facts that are TRUE OF THE POLICY ROW ITSELF and are therefore knowable at
 * that instant -- which is also the precise subject of spec case CMP-02: the row
 * is present, its mode is `danger-full-access`, and its root is absolute.
 *
 * Everything about the mounted BACKENDS and the model SURFACE belongs to the
 * session-resume and PTC boundaries, where the tree has settled and an Agent
 * exists.
 *
 * @param observed - the deployment observation.
 * @returns the checks, in report order.
 */
export function startupPolicyChecks(observed: DeploymentObservation): ContractCheck[] {
  return [
    {
      id: 'startup.sandboxPolicy.present',
      subject: 'a sandbox-policy row is mounted (its absence is the tool-face-zeroing failure)',
      observed: observed.defaultMode === undefined
        ? 'ctx.sandboxPolicy is NOT mounted'
        : `ctx.sandboxPolicy is mounted, defaultMode '${observed.defaultMode}'`,
      ok: observed.defaultMode !== undefined,
      ...observed.defaultMode === undefined
        ? { detail: 'no ctx.sandboxPolicy service. Seven rows inject sandboxPolicy (pwsh-sandbox, ptc-runtime, terminal-controller, workspace-files, ui-deliverables, permission, workflow-ptc), so its absence leaves them pending, fails the preset mount and drives the tool face to zero -- measured, and named in CMP-02\'s oracle as the specific known failure.' }
        : {},
    },
    {
      id: 'startup.sandboxPolicy.mode',
      subject: `the deployment default sandbox mode is '${TRUSTED_LOCAL_MODE}'`,
      observed: observed.defaultMode === undefined ? '(no policy mounted)' : `'${observed.defaultMode}'`,
      ok: observed.defaultMode === TRUSTED_LOCAL_MODE,
      ...observed.defaultMode === undefined || observed.defaultMode === TRUSTED_LOCAL_MODE
        ? {}
        : { detail: `the deployment default is '${observed.defaultMode}', which CONFINES. Under trusted-local this is a FALSE STATEMENT ABOUT THE MODEL'S PERMISSIONS: the same resolved policy renders the model-facing sentence (sandbox-policy/src/index.ts:42-56) and gates the PTC confine decision (ptc-runtime-node/src/index.ts:224). Note the observability limit: 'read-only' here is indistinguishable from an unset config, because Config's schema default is 'read-only' (:113).` },
    },
    {
      id: 'startup.sandboxPolicy.workspaceRoot',
      subject: 'the policy workspace root resolved to an absolute path',
      observed: observed.workspaceRoot === undefined ? '(no policy mounted)' : JSON.stringify(observed.workspaceRoot),
      ok: observed.workspaceRoot !== undefined && isAbsolutePath(observed.workspaceRoot),
      ...observed.workspaceRoot === undefined || isAbsolutePath(observed.workspaceRoot)
        ? {}
        : { detail: `the policy workspace root is ${JSON.stringify(observed.workspaceRoot)}, which is not absolute. CMP-02's oracle requires an absolute root, and the service itself refuses a relative one (sandbox-policy/src/index.ts:36-39) -- so reaching here with a relative value means the value was produced some other way.` },
    },
  ]
}

/**
 * Whether a path is absolute in the execution world's terms.
 *
 * Both spellings are accepted because this deployment is Windows and the value
 * can arrive as `D:\...` or `D:/...`; a POSIX root is accepted so the predicate
 * does not silently report a false violation for a non-Windows boot of the same
 * profile. The check is deliberately structural rather than
 * `node:path.isAbsolute`, which is platform-dependent and would make the same
 * composed value pass or fail depending on which OS read it.
 *
 * @param path - the path to classify.
 * @returns true for a drive-letter or rooted path.
 */
function isAbsolutePath(path: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(path) || path.startsWith('/') || path.startsWith('\\\\')
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

/**
 * What one boundary last resolved to.
 *
 * Kept per boundary rather than as one "last report", because the question a
 * mutation check answers is "did this CHANGE between two boundaries", and a
 * single overwritten slot cannot answer it.
 */
export interface BoundaryRecord {
  /** The boundary this record is about. */
  readonly boundary: ContractBoundary
  /** Whether the contract was satisfied there. */
  readonly ok: boolean
  /** The failing check ids there. */
  readonly violations: readonly string[]
  /** `sandboxPolicy.defaultMode` as read at that boundary. */
  readonly defaultMode: SandboxMode | undefined
  /** When the boundary was checked, for ordering. */
  readonly checkedAt: number
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
 * session. {@link NoSandboxContractService.checkBoundary} can REFUSE (throw),
 * which is a refusal to proceed and never a repair.
 */
export class NoSandboxContractService extends Service {
  /** What each boundary last resolved to. Populated by {@link checkBoundary}. */
  private readonly boundaries = new Map<ContractBoundary, BoundaryRecord>()

  /**
   * Per-boundary dispositions. Empty means every boundary `refuse`s, which is
   * the deployment default; a caller adds an entry only to run the guard over a
   * graph it already knows is degraded.
   */
  private readonly dispositions = new Map<ContractBoundary, BoundaryDisposition>()

  constructor(ctx: Context) {
    super(ctx, 'noSandboxContract')
  }

  /**
   * Set how one boundary reacts to a violation.
   *
   * `report` is for a deliberate read of a known-degraded graph. It is NOT a way
   * to keep running under a confining mode: nothing here changes the mode, so a
   * `report` disposition leaves the deployment exactly as wrong as it was and
   * only stops the guard from throwing about it.
   *
   * @param boundary - the boundary to configure.
   * @param disposition - `refuse` (the default) or `report`.
   */
  setBoundaryDisposition(boundary: ContractBoundary, disposition: BoundaryDisposition): void {
    this.dispositions.set(boundary, disposition)
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
   * Check the contract at one boundary using only the SYNCHRONOUS half, and
   * refuse when it fails.
   *
   * The checks included depend on the boundary, and that is the fix for a real
   * false alarm rather than a convenience:
   *
   *   - `startup` runs the POLICY-level checks only
   *     ({@link startupPolicyChecks}). It fires when `sandboxPolicy` mounts,
   *     which is EARLIER than `fs`/`shell`/`ipython`; the full contract there
   *     reported three failures for a correct deployment because it read a
   *     half-mounted graph.
   *   - every other boundary runs the full deployment checks, because by then
   *     the tree has settled and a missing backend IS a finding.
   *
   * @param boundary - the boundary being checked.
   * @param subject - an Agent/Session, when the caller has one.
   * @returns the report, when the disposition is `report`.
   * @throws when the disposition is `refuse` and any check failed.
   */
  checkBoundarySync(
    boundary: ContractBoundary,
    subject: { readonly agent?: Agent; readonly session?: Session } = {},
  ): ContractReport {
    const observed = this.observe()
    const checks = boundary === 'startup'
      ? startupPolicyChecks(observed)
      : deploymentChecks(observed)
    if (subject.session !== undefined) checks.push(...this.checkSession(subject.session).checks)
    if (subject.agent !== undefined) checks.push(...surfaceChecks(observeSurface(this.ctx, subject.agent)))
    const result = report(checks)
    this.recordBoundary(boundary, result)
    if (!result.ok && this.boundaryDisposition(boundary) === 'refuse') {
      const lines = result.checks
        .filter(check => !check.ok)
        .map(check => `  ${check.id}: ${check.observed}${check.detail === undefined ? '' : ` -- ${check.detail}`}`)
      throw new Error(
        `trusted-local contract violated at the ${boundary} boundary: ${String(result.violations.length)} check(s) failed. `
        + 'This deployment is NOT the intended trusted-local graph, so product execution stops here '
        + 'rather than continuing under a mode nobody chose. The mode is NOT switched back automatically: '
        + 'that would hide a real configuration change.\n'
        + lines.join('\n'),
      )
    }
    return result
  }

  /**
   * Run the model-facing narration checks for one Agent.
   *
   * ASYNC, because the narration is only readable by RUNNING the assembly. That
   * is the point rather than an inconvenience: a synchronous check could only
   * restate the source, which is the weaker oracle this project keeps recording.
   *
   * @param agent - the Agent whose runtime context to assemble.
   * @returns the report.
   */
  async checkNarration(agent: Agent): Promise<ContractReport> {
    return report(narrationChecks(await observeNarration(this.ctx, agent)))
  }

  /**
   * Check the contract at one of the three boundaries V3 F2 names.
   *
   * THE BOUNDARIES ARE NOT THREE SPELLINGS OF "CHECK IT SOMEWHERE". Each one
   * catches a different way the composition can stop being true:
   *
   *   - `startup` -- the deployment booted with a confining mode, or with a
   *     narration that contradicts it. Caught before any model turn runs.
   *   - `session-resume` -- a session whose DURABLE LOG carries a confining
   *     `sandbox/mode` override. `resolve()` is
   *     `request.mode ?? overrideOf(session) ?? defaultMode`, so a correct
   *     deployment default does NOT migrate that session: it still resolves
   *     confined, and only the session-level read can see it.
   *   - `ptc-execution` -- the mode at the moment a PTC call would run. This is
   *     the boundary where a non-full mode has a BEHAVIOURAL consequence rather
   *     than a narrative one: `ptc-runtime-node` confines unless the mode is
   *     exactly `danger-full-access` (`:224`).
   *
   * `refuse` THROWS. It does NOT repair. See {@link BoundaryDisposition}: silently
   * restoring full access would mask the very configuration change the check
   * exists to surface.
   *
   * @param boundary - which boundary is being checked.
   * @param subject - the Agent and Session in play at that boundary, when any.
   * @returns the report, when the disposition is `report`.
   * @throws when the disposition is `refuse` and any check failed.
   */
  async checkBoundary(
    boundary: ContractBoundary,
    subject: { readonly agent?: Agent; readonly session?: Session } = {},
  ): Promise<ContractReport> {
    const checks = deploymentChecks(this.observe())
    if (subject.session !== undefined) checks.push(...this.checkSession(subject.session).checks)
    if (subject.agent !== undefined) {
      checks.push(...surfaceChecks(observeSurface(this.ctx, subject.agent)))
      checks.push(...narrationChecks(await observeNarration(this.ctx, subject.agent)))
    }
    const result = report(checks)
    this.recordBoundary(boundary, result)
    if (!result.ok && this.boundaryDisposition(boundary) === 'refuse') {
      const lines = result.checks
        .filter(check => !check.ok)
        .map(check => `  ${check.id}: ${check.observed}${check.detail === undefined ? '' : ` -- ${check.detail}`}`)
      throw new Error(
        `trusted-local contract violated at the ${boundary} boundary: ${String(result.violations.length)} check(s) failed. `
        + 'This deployment is NOT the intended trusted-local graph, so product execution stops here '
        + 'rather than continuing under a mode nobody chose. The mode is NOT switched back automatically: '
        + 'that would hide a real configuration change.\n'
        + lines.join('\n'),
      )
    }
    return result
  }

  /**
   * The disposition for one boundary.
   *
   * Every boundary refuses by default, because every boundary gates product
   * execution. `report` exists so a caller can deliberately run the guard over a
   * KNOWN-degraded graph (a probe measuring the failure direction, or an
   * operator's diagnostic) without the guard refusing the very read that was
   * asked for -- which is the same reason `inject` is empty.
   *
   * @param boundary - the boundary being checked.
   * @returns the disposition.
   */
  boundaryDisposition(boundary: ContractBoundary): BoundaryDisposition {
    return this.dispositions.get(boundary) ?? 'refuse'
  }

  /**
   * Record what the contract resolved to at one boundary, and warn when it is
   * not satisfied.
   *
   * The record is what makes a runtime MUTATION observable. `sandboxPolicy` has
   * no setter and no `setPolicy` method, so a mutation can only arrive by
   * replacing the service, by re-configuring the row, or by a session appending a
   * `sandbox/mode` event. Only the third is reachable from product code today
   * (`setSandboxMode` is called by `permission-presets`, which this deployment
   * disables) -- and that reachability, not any immutability, is what protects
   * the mode (recorded as G-SEAM-50). A boundary check that only ran ONCE at boot
   * would keep reporting the boot-time value for a graph that had since changed.
   *
   * @param boundary - the boundary just checked.
   * @param result - its report.
   */
  private recordBoundary(boundary: ContractBoundary, result: ContractReport): void {
    const observed = this.observe()
    const previous = this.boundaries.get(boundary)
    this.boundaries.set(boundary, {
      boundary,
      ok: result.ok,
      violations: [...result.violations],
      defaultMode: observed.defaultMode,
      checkedAt: Date.now(),
    })
    const logger = this.ctx.logger('no-sandbox-contract')
    if (result.ok) {
      logger.debug('trusted-local contract satisfied at the %s boundary (%d check(s))', boundary, result.checks.length)
      return
    }
    logger.error(
      'trusted-local contract VIOLATED at the %s boundary: %s',
      boundary,
      result.violations.join(', '),
    )
    // The MUTATION arm, stated separately because it is the case a single
    // boot-time assertion cannot see: the deployment was correct at an earlier
    // boundary and is not any more.
    if (previous !== undefined && previous.ok && previous.defaultMode !== observed.defaultMode) {
      logger.error(
        'sandbox policy CHANGED DURING THIS PROCESS: defaultMode was %s at the %s boundary and is now %s. '
        + 'Nothing in this deployment should change it; this is a real configuration change and the contract now fails.',
        String(previous.defaultMode),
        previous.boundary,
        String(observed.defaultMode),
      )
    }
  }

  /** What each boundary last resolved to, so a change between boundaries is observable. */
  boundaryHistory(): readonly BoundaryRecord[] {
    return [...this.boundaries.values()]
  }

  /**
   * Run every check that needs no Agent, plus the surface and session halves
   * when those are supplied.
   *
   * The narration half is NOT included here: it is async, and folding an async
   * read into a synchronous report would either drop it silently or make the
   * report's `ok` depend on a promise nobody awaited. {@link checkBoundary}
   * includes it, because that is the path product execution takes.
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
 * How long the startup boundary waits for `sandboxPolicy` before checking anyway.
 *
 * MEASURED, not guessed: on a real boot of the composed daily profile the service
 * was readable 193 ms after `apply` started (via the service announcement) and
 * 275 ms via an inject callback
 * (`qualification/results/R1-trusted-local/mount-latency.json`). This bound is an
 * order of magnitude above that, so it is a stall detector rather than a race
 * participant: on a healthy deployment it never elapses.
 *
 * WHY A BOUND IS REQUIRED RATHER THAN A PLAIN `await`. An `apply` that never
 * resolves stops `loader.await()` from returning, so `boot()` never reaches
 * `auditStartupEntries` and the process prints nothing on either stream --
 * MEASURED with a never-mounting dependency, and it suppressed the activation
 * audit for every sibling entry too. Timing out instead lets the check run and
 * report the absent service, which is the honest outcome.
 */
export const STARTUP_POLICY_WAIT_MS = 3_000

/**
 * Resolve once `sandboxPolicy` is readable, or when the bound elapses.
 *
 * The returned promise NEVER rejects and always settles: the caller's next step
 * is the contract check, which is what decides the verdict. A wait that rejected
 * would replace a readable report with one transport error, which is the
 * distinction this guard keeps making between "the graph is wrong" and "the graph
 * cannot be read".
 *
 * @param ctx - the live context to poll.
 * @param timeoutMs - the maximum wait, in milliseconds.
 * @returns after the service appears or the bound elapses.
 */
async function waitForPolicy(ctx: Context, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (ctx.get('sandboxPolicy') === undefined && Date.now() < deadline) {
    await new Promise<void>(resolve => { setTimeout(resolve, 25) })
  }
}

/**
 * Mount the deployment self-check, and wire the three boundaries V3 F2 names.
 *
 * `inject` is empty ON PURPOSE, and that is load-bearing rather than tidy: this
 * guard's subject is a graph where services are legitimately absent, and a hard
 * inject would leave the plugin `pending` on exactly the degraded graph it exists
 * to report. Every read goes through `ctx.get`, which returns `undefined` instead
 * of throwing.
 *
 * WHY THE WIRING IS HERE AND NOT LEFT TO A CALLER. A guard with no production
 * caller is the defect this project has recorded more than twelve times: the
 * mechanism exists, its unit tests pass, and nothing in the product reaches it.
 * So the boundaries are registered on the plugin's own mount, and each one is
 * reachable by a real product path:
 *
 *   - `startup`: `apply` itself is async and its rejection belongs to the
 *     ENTRY's own fiber, which is what DSH's activation audit reports. The check
 *     runs after a BOUNDED wait for `sandboxPolicy`, so it is evaluated against
 *     the composed graph rather than a partially-mounted one -- see the boundary
 *     comment in {@link apply} for why the wait is bounded and why a discarded
 *     child fiber made this boundary silent.
 *   - `session-resume`: `agent/created` carries `source`, whose value is
 *     `'resume'` for a persisted load (`packages/core/agent/src/runtime-types.ts:125`).
 *     That event is SERIAL (`:261`), so a throwing listener rejects the
 *     announce and the resume fails rather than proceeding.
 *   - `ptc-execution`: a `tools.guard` on the PTC transport's own name. Guards
 *     are the MONOTONIC slot -- they run after every `tools/pre-execute`
 *     listener and no guard can force-allow what another denied
 *     (`packages/core/tools/src/index.ts:1107-1123`), which is what makes the
 *     refusal hold even if a later listener would have allowed the call.
 *
 * WHAT THE PTC BOUNDARY DOES *NOT* DO. It does not call `ctx.sandbox.confine`
 * and it does not pre-empt the runtime's own decision; it refuses the CALL whose
 * resolved policy would confine. That keeps the guard a reader of the policy
 * rather than a second enforcement point that could disagree with the first.
 *
 * @param ctx - the host context that owns this extension.
 */
export async function apply(ctx: Context): Promise<void> {
  const service = new NoSandboxContractService(ctx)

  // ── boundary 1: STARTUP ───────────────────────────────────────────────────
  //
  // THE REFUSAL MUST BE RAISED FROM `apply`'s OWN BODY. That is a MEASURED
  // requirement, not a style choice, and the first version of this boundary got
  // it wrong in a way that made the guard SILENT.
  //
  // WHAT WAS WRONG. It was written as `ctx.inject(['sandboxPolicy'], cb)` with
  // the fiber DISCARDED, on the reasoning that a child fiber orders the check
  // after its dependency without making the row `pending`. The ordering half of
  // that is true; the loudness half is not. `ctx.inject` returns a CHILD fiber,
  // and DSH's activation audit classifies by the ENTRY's fiber state
  // (`packages/boot/app-boot/src/index.ts:769-802`: ACTIVE is fine, FAILED is
  // reported with its error, PENDING as "waiting for services"). A throw inside a
  // DISCARDED child leaves the entry ACTIVE, so the refusal reached NO process
  // channel at all. MEASURED, both in-process and on a real boot:
  //
  //   - in-process, `ctx.plugin` + `ctx.inject` with a throwing callback:
  //     parentEntryFiberState ACTIVE, no unhandled rejection, nothing logged.
  //   - on a real boot of the composed daily profile with NO probe in the tree:
  //     `qualification/results/R1-trusted-local/loudness-verdict.json` -- the
  //     reverted (`workspace-write`) boot produced the SAME EMPTY STDERR as the
  //     healthy control. `verdict` there states it as a boolean and `diagnosis`
  //     reads "SILENT".
  //
  // That is the exact defect class this guard exists to catch, reproduced inside
  // the guard: a deployment that LOOKS alive while the contract is violated. So
  // the check now runs in `apply`'s own async body and its rejection belongs to
  // the ENTRY's fiber. Re-measured after the change, on a real boot, with the
  // healthy arm as the control: the violating entry is named on stderr under
  // "N entries did not activate", and the healthy arm stays quiet
  // (`qualification/results/R1-trusted-local/loudness-after-fix.json`).
  //
  // WHY THE WAIT IS BOUNDED, AND WHY IT IS NOT A ROW-LEVEL `inject`. Two
  // constraints pull in opposite directions and both are load-bearing:
  //
  //   (a) the check must run AFTER `sandboxPolicy` mounts. Running it at `apply`
  //       time reads a half-mounted graph and reported THREE false violations for
  //       a CORRECT deployment; that boot log is kept as
  //       `qualification/results/R1-trusted-local/composition-after-first-attempt.*`.
  //   (b) the plugin's static `inject` must stay EMPTY, because `inject` is a
  //       READINESS GATE: naming `sandboxPolicy` there would leave this row
  //       `pending` on exactly the degraded graph it exists to report (and a
  //       pending row is the measured `toolCount: 0` precondition).
  //
  // So the ordering comes from a bounded wait inside `apply`, and the bound is
  // MEASURED rather than guessed: `sandboxPolicy` was readable 193 ms after
  // `apply` started, via the service announcement, and 275 ms via an inject
  // callback (`qualification/results/R1-trusted-local/mount-latency.json`). The
  // bound below is an order of magnitude above that.
  //
  // WHY IT MUST BE BOUNDED AT ALL. An `apply` that never resolves is not a
  // harmless wait: `EntryTree.getTasks()` includes the entry's in-flight apply
  // promise and `loader.await()` loops on those tasks (`vendor/loader/src/
  // config/tree.ts:43-51`), so `boot()` never reaches `auditStartupEntries` and
  // the process prints NOTHING on either stream. MEASURED: an arm that awaited a
  // never-mounting service produced empty stdout and empty stderr and never bound
  // its web port -- it suppressed the activation audit for EVERY entry, including
  // the healthy siblings. A timed-out wait instead falls through to the check,
  // which reports the missing service as the violation it is.
  await waitForPolicy(ctx, STARTUP_POLICY_WAIT_MS)

  // A refusal here THROWS, rejecting `apply` and failing the ENTRY, which is what
  // the loader's audit reports and what `installFailLoud` escalates. The mode is
  // never switched back: see {@link BoundaryDisposition}.
  service.checkBoundarySync('startup')
  ctx.logger('no-sandbox-contract').info(
    'startup contract satisfied: sandbox policy is %s, workspaceRoot %s',
    String(service.observe().defaultMode),
    String(service.observe().workspaceRoot),
  )

  // ── boundary 2: SESSION RESUME ────────────────────────────────────────────
  //
  // `agent/created` is `@mode serial` (`runtime-types.ts:259-261`), so returning
  // a rejected promise from this listener rejects `AgentRegistry.announce` and
  // the resume does not proceed. The check is scoped to `source === 'resume'`:
  // a fresh session has no durable override to migrate, and refusing every new
  // session would make the guard unusable for the case it is about.
  ctx.on('agent/created', async ({ agent, source }) => {
    if (source !== 'resume') return
    const result = await service.checkBoundary('session-resume', { agent, session: agent.session })
    if (!result.ok) {
      // Reached only under a `report` disposition, since `refuse` throws above.
      ctx.logger('no-sandbox-contract').error(
        'resuming session %s under a degraded trusted-local contract: %s',
        agent.session.id,
        result.violations.join(', '),
      )
    }
  }, { global: true })

  // ── boundary 3: THE PTC EXECUTION BOUNDARY ────────────────────────────────
  //
  // The guard is registered on `ctx.tools` and keyed on BOTH PTC producers (see
  // {@link PTC_BOUNDARY_TOOL_NAMES}): `run_code` when a PTC presentation mode is
  // selected, and `workflow`, whose engine is the one this deployment actually
  // reaches. Guarding only `run_code` would have left this boundary unreachable
  // here -- MEASURED, `ptc.runCodeOnSurface: false` on a real boot.
  //
  // Registering it through the host context makes it GLOBAL; a guard registered
  // through one agent's context would cover that agent only.
  ctx.inject(['tools', 'sandboxPolicy'], (scope: Context) => {
    scope.tools.guard((exec) => {
      if (!isPtcBoundaryTool(exec.name)) return undefined
      const policy = scope.get('sandboxPolicy')
      if (policy === undefined) {
        return `trusted-local contract: '${exec.name}' cannot be executed because ctx.sandboxPolicy is not mounted, so the mode this call would run under is unknown. Refusing rather than running unverified.`
      }
      const session = exec.agent?.session
      const resolved = policy.resolve(session === undefined ? {} : { session })
      if (resolved.mode === TRUSTED_LOCAL_MODE) return undefined
      const override = session === undefined ? undefined : policy.overrideOf(session)
      return `trusted-local contract: refusing '${exec.name}' because this call resolves to sandbox mode '${resolved.mode}' (defaultMode '${String(policy.defaultMode)}'${override === undefined ? '' : `, session override '${override}'`}), not '${TRUSTED_LOCAL_MODE}'. The PTC runtime confines unless the mode is exactly '${TRUSTED_LOCAL_MODE}', so this call would fence while the rest of the deployment does not. The mode is NOT switched back automatically -- that would hide a real configuration change.`
    })
  })
}

export const name = 'dsh-daily-work-no-sandbox-contract'
/** See the module header: a hard inject would make the guard blind to its own subject. */
export const inject: string[] = []
