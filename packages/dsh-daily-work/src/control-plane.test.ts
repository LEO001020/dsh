/**
 * E02 — control-plane isolation. The COMPLEMENT of the negative assertion.
 *
 * WHAT THIS FILE ADDS, AND WHAT IT DOES NOT REPEAT
 * ===============================================
 * `security-denial.test.ts:358` already asserts the negative half in an
 * in-process composition: `ctx.get('terminalController')` is `undefined`, so no
 * test in that file can reach the human Web terminal. That assertion is NOT
 * duplicated here. This file closes the complement the gate actually needs:
 *
 *   enumerate every control-plane surface, and show none of them is reachable
 *   from the agent scope as a capability.
 *
 * The gate's oracle is "refused or absent". The word that does the work is
 * ABSENT, and absence has to be shown against a MEASURED universe rather than a
 * list someone wrote down and then checked.
 *
 * THE TWO MEASUREMENT ERRORS THAT SHAPED THIS FILE
 * ===============================================
 * Both were made while building the boot probe for this gate, and both produce a
 * confident wrong answer, so they are recorded here rather than smoothed over:
 *
 *   1. `inject` IS A READINESS GATE. The first probe injected three services and
 *      read the host scope at the top of `apply`. Half the control-plane
 *      services read as ABSENT — not because they were absent, but because the
 *      probe ran mid-mount. M9.17 recorded this exact mistake for `dailyWork`;
 *      it recurs in a new probe by a different author. Any probe that reads
 *      service presence must WAIT and must report the wait's outcome.
 *
 *   2. `ctx.get(name)` IS A PROCESS-WIDE REGISTRY READ, NOT A SCOPE TEST.
 *      `ReflectService.get` resolves `ctx[symbols.isolate][name]` against a
 *      SHARED `store` (`vendor/cordis/src/reflect.ts:209`, `:238-244`), so a
 *      context under a preset's `isolate` realm resolves a service the ROOT
 *      fiber provided, and a root context resolves one a preset provided. The
 *      test below measures this on purpose: a naive reading of
 *      "agent.ctx.get('terminalController') is defined" looks like an E02
 *      FAILURE and is not one. `ctx.get` answers "does this service EXIST in
 *      this process", never "may this scope use it".
 *
 * Because of (2), the load-bearing E02 claim is NOT a scope test. It is:
 *
 *   the model reaches things through TOOLS, and `tools.schemas(agent)` is the
 *   exact catalog it is offered; no control-plane surface appears there.
 *
 * That claim is measured in a real boot (`probe-control-plane.mjs`, `e02.json`)
 * and pinned here against the recorded artifact, because a vitest process cannot
 * compose the real `daily` profile.
 *
 * WHAT THE HUMAN TERMINAL ACTUALLY IS, IN ITS OWN WORDS
 * ====================================================
 * `packages/api/terminal-controller/src/index.ts:1` -- the module header, verbatim:
 *
 *   Session-owned user terminals with the execution environment's system-user permissions.
 *
 * and its `create()` at `:150-158` -- the doc comment, verbatim:
 *
 *   Allocate a user shell once for a caller-generated identity, without Agent
 *   sandbox or approval restrictions.
 *
 * The privilege claim is not inferred from the README: `spawn()` at `:339-351`
 * calls `subprocess.spawnTerminal({...})` with NO sandbox wrap, and
 * `execution()` at `:331-337` reads `agent.ctx.get('sandboxPolicy')` only for
 * the FALLBACK working directory (`environment()` at `:118-124` returns
 * `cwd: agent.session.header.cwd ?? sandboxPolicy.workspaceRoot`). The sandbox
 * policy is consulted for a PATH and never for a confinement. That is the
 * structural fact that makes wrapping this as a model tool privilege escalation
 * rather than convenience, and it is asserted below against the source text.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import { unsupportedInbox } from '@deepseek-ai/dsh-agent-loop-testkit'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { LocalSubprocessRuntime } from '@deepseek-ai/dsh-subprocess-local'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { describe, expect, it } from 'vitest'

/**
 * The pinned DSH source root. `compatibility.lock.json` records this checkout as
 * the deployment's source of truth; the override exists only for a relocated
 * checkout. The privilege claim below is a claim about THIS text, so the text is
 * read at test time rather than paraphrased.
 */
const DSH_SRC_ROOT = process.env.DSH_SRC_ROOT ?? 'D:/DSH/src/dsh-src'

/**
 * The boot-probe artifacts this file pins, written by the two probes beside them
 * under `qualification/results/M9.19-control-plane/`.
 *
 * Resolved through `new URL(..., import.meta.url)` rather than `process.cwd()`
 * because vitest's cwd is the package directory, not the repository root, and a
 * cwd-relative path would silently look in `packages/qualification/...` and
 * report the artifact missing. That mistake was made once here; the URL form
 * cannot repeat it.
 */
const ARTIFACT_DIR = fileURLToPath(new URL('../../../qualification/results/M9.19-control-plane/', import.meta.url))
const E02_ARTIFACT = join(ARTIFACT_DIR, 'e02.json')
const E02_LOOPBACK_ARTIFACT = join(ARTIFACT_DIR, 'e02-loopback.json')

/**
 * The control-plane surfaces, each named with the authority it carries.
 *
 * Written out rather than derived from a name pattern because the claim is about
 * AUTHORITY: `credentials` and `credentialsController` are both here and a regex
 * over "controller" catches only one. The test below asserts this list is a
 * SUBSET of the measured host scope, so a surface that silently stops existing
 * is visible rather than quietly passing.
 */
const CONTROL_PLANE_SURFACES: Readonly<Record<string, string>> = {
  terminalController: 'allocates a system-user PTY outside the agent sandbox and approval flow (INV-S1)',
  pluginManager: 'installs, enables and disables plugin code in the running profile',
  pluginPackages: 'reads and writes the profile package manifest and lockfile',
  dynamicCordisRunner: 'loads and runs model-authored Cordis plugin code in the host runtime',
  webServer: 'owns the listening socket that serves the API and the frontend',
  connection: 'holds the process launch token and mints browser session cookies',
  credentials: 'reads and writes $DSH_HOME/.credentials.yaml',
  credentialsController: 'the Web-facing credential management surface',
  sessionController: 'creates, resumes and deletes Sessions outside the model loop',
  settingsController: 'writes host settings',
  workspaceController: 'registers and switches workspaces',
  workspaceFiles: 'reads and writes files through the host fs policy rather than the agent tools',
}

/**
 * Control-plane surfaces that are deliberately NOT in the list above, with why.
 *
 * An exclusion stated in a comment is a claim nobody can check; stated as data
 * it is one the next reader can disagree with. These are the surfaces the host
 * scope legitimately does not mount in this profile, so their absence is a fact
 * about the profile rather than a property to prove.
 */
const NOT_MOUNTED_IN_THIS_PROFILE: readonly string[] = ['authorization', 'remote', 'webTerminals', 'webhookRuntime']

/**
 * Mount a minimal composition with the REAL tool registry and a REAL Agent.
 *
 * The tool registry is the only service this file needs to answer its question:
 * `tools.schemas(agent)` is the catalog the model is offered, and an agent whose
 * catalog is empty is the correct negative control for a composition that mounts
 * no control-plane tool.
 *
 * `ctx.agents.create()` needs an `AgentFactory`, which is `@deepseek-ai/dsh-agent-loop`
 * -- the one model loop. This file must not boot it: the question here is about
 * the TOOL REGISTRY's view, not about a running loop. So the Agent is registered
 * directly, the same construction `security-denial.test.ts:397-414` uses for the
 * same reason.
 */
async function mountAgentScope(): Promise<{ ctx: Context; agent: Agent; dispose: () => Promise<void> }> {
  const ctx = new Context()
  await ctx.plugin(LocalSubprocessRuntime)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SessionStore)
  // `ToolRuntime.inject` is `['systemPrompt']` (`packages/core/tools/lib/index.js:2664`),
  // so the prompt registry is a hard dependency and not a convenience: mounting
  // tools without it leaves `ctx.tools` undefined and the probe would report a
  // false absence.
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  const session = ctx.sessions.create(SessionId('e02-control-plane-session'))
  const ownerFiber = await ctx.plugin(() => {})
  const agent = {
    id: session.id,
    options: {},
    session,
    inbox: unsupportedInbox(),
    status: 'idle' as const,
    ctx: ownerFiber.ctx,
    send: () => {},
    followup: () => {},
    steer: () => {},
    inject: () => {},
    cancel() {},
    runMaintenance: () => Promise.resolve(),
    whenIdle: () => Promise.resolve(),
  } as unknown as Agent
  await ctx.agents.register(agent)
  return { ctx, agent, dispose: async () => { await ctx.fiber.dispose() } }
}

describe('E02: the control-plane universe is measured, not assumed', () => {
  it('the recorded boot probe enumerated the host scope and found no control-plane surface missing by accident', () => {
    // The probe's own record. Reading it here rather than re-deriving it is
    // deliberate: a vitest process cannot compose the real `daily` profile, and
    // a test that pretended to would be a weaker oracle wearing a stronger one's
    // clothes -- the exact defect G-FIX-04 records.
    const artifact = JSON.parse(readFileSync(E02_ARTIFACT, 'utf8')) as {
      modelToolCatalog: string[]
      modelToolCount: number
      controlPlaneAsModelTool: Record<string, { exposedAsTool: boolean; authority: string }>
      cordisInspectTools: string[]
      controlPlaneInHostScope: Record<string, unknown>
      controlPlaneAbsentFromHostScope: string[]
      readiness: { waitedMs: number; stillMissing: string[] }
      agentPresetId?: string
      errors: string[]
    }

    // The probe completed. A probe that threw would still write a file, so the
    // error channel is asserted rather than assumed empty.
    expect(artifact.errors).toEqual([])

    // THE READINESS WAIT SUCCEEDED FOR EVERY SURFACE THAT EXISTS IN THIS PROFILE.
    // This is the assertion that (1) above exists to protect: without it, a probe
    // that read mid-mount would report services absent and the gate would close
    // for the wrong reason. The still-missing set must be exactly the surfaces
    // this profile does not mount, which is a different fact from "did not have
    // time to mount".
    expect(artifact.readiness.stillMissing).toEqual([...NOT_MOUNTED_IN_THIS_PROFILE].sort())

    // Every surface in the declared list was actually OBSERVED. A surface that
    // exists in the list but not in the measurement is a probe that stopped
    // covering something, and it must not pass silently.
    for (const name of Object.keys(CONTROL_PLANE_SURFACES)) {
      if (NOT_MOUNTED_IN_THIS_PROFILE.includes(name)) continue
      expect(artifact.controlPlaneInHostScope, `the probe never observed "${name}"`).toHaveProperty(name)
    }
    expect(artifact.agentPresetId).toBe('daily-standard')
  })

  it('NO control-plane surface is exposed to the model as a tool, on the real composed preset', () => {
    const artifact = JSON.parse(readFileSync(E02_ARTIFACT, 'utf8')) as {
      modelToolCatalog: string[]
      modelToolCount: number
      controlPlaneAsModelTool: Record<string, { exposedAsTool: boolean; authority: string }>
      cordisInspectTools: string[]
    }

    // The catalog is the model's real capability surface, and it is non-empty:
    // an empty catalog would make "no control-plane tool" vacuously true, which
    // is the failure mode this assertion exists to exclude.
    expect(artifact.modelToolCount).toBeGreaterThan(20)
    expect(artifact.modelToolCatalog).toContain('work')

    const exposed = Object.entries(artifact.controlPlaneAsModelTool)
      .filter(([, value]) => value.exposedAsTool)
      .map(([name]) => name)
    // E02's oracle, as a value: the set of control-plane surfaces the model can
    // call is EMPTY. Not "the model was asked not to".
    expect(exposed).toEqual([])

    // The direct-name check above cannot see a tool that WRAPS a control-plane
    // service under another name. The shipped case is `cordis_inspect_*`, which
    // is read-only introspection; it is asserted to be absent from this preset
    // so that a future mount of it is a visible change rather than a silent one.
    expect(artifact.cordisInspectTools).toEqual([])
  })

  it('the model is told the loopback address, and the address alone does not admit it', () => {
    // "Loopback is not identity isolation." The address is not a secret: the web
    // bundle publishes it to every model shell as `DSH_WEB_URL`
    // (packages/bundle/web-app/src/index.ts:242-250). So the honest test is not
    // "can the model find the port" -- it is "does the port admit the model".
    const artifact = JSON.parse(readFileSync(E02_LOOPBACK_ARTIFACT, 'utf8')) as {
      server: { host: string; port: number; boundTo: string }
      shellEnvUrl: { urlDeclared: boolean; collected: Record<string, string> }
      requests: Record<string, { status: number | string; bodyHead?: string }>
      tokenExposure: { launchTokenIsInShellEnv: boolean; shellEnvKeys: string[] }
      errors: string[]
    }

    expect(artifact.errors).toEqual([])
    // The socket is loopback-only, which is the whole of the address-family
    // claim: it excludes other MACHINES and nothing else.
    expect(artifact.server.host).toBe('127.0.0.1')
    expect(artifact.server.boundTo).toBe('127.0.0.1:3080')

    // The model IS given the address. Asserted so the refusal below cannot be
    // explained by the model not knowing where to knock.
    expect(artifact.shellEnvUrl.urlDeclared).toBe(true)
    expect(artifact.shellEnvUrl.collected.DSH_WEB_URL).toBe('http://127.0.0.1:3080')

    // The index route refuses an unauthenticated request from the model's own
    // environment, with a 401 and no page body.
    expect(artifact.requests.indexUnauthenticated!.status).toBe(401)
    expect(artifact.requests.indexUnauthenticated!.bodyHead).toContain('authentication required')

    // The API route refuses it too.
    expect(artifact.requests.apiUnauthenticated!.status).toBe(401)

    // A GUESSED token is refused identically to no token. The launch token is 32
    // random bytes (`browser-auth.ts:23`, `:53-57`), so a guess must fail; what
    // this pins is that it fails the same way rather than falling through to an
    // unauthenticated page.
    expect(artifact.requests.indexGuessedToken!.status).toBe(401)
    expect(artifact.requests.indexGuessedToken!.bodyHead)
      .toBe(artifact.requests.indexUnauthenticated!.bodyHead)

    // The token is NOT in the model's shell environment. This is the fact that
    // makes the fence load-bearing rather than decorative: if the token were
    // published beside the URL, "the address is not a credential" would be
    // false in the most direct way possible.
    expect(artifact.tokenExposure.launchTokenIsInShellEnv).toBe(false)
    expect(artifact.tokenExposure.shellEnvKeys).toEqual(['DSH_HOME', 'DSH_SHELL', 'DSH_WEB_URL'])
  })

  it('the /api Host fence refuses a DNS-rebinding Host, and the index route is NOT Host-fenced', () => {
    // The two fences are DIFFERENT and cover different routes. Collapsing them
    // would let "401 on the index" stand in for "the rebinding fence works",
    // which is not the same claim. An earlier version of the probe predicted 403
    // for the index with a hostile Host and got 401; the prediction was wrong and
    // the measurement is what is recorded.
    const artifact = JSON.parse(readFileSync(E02_LOOPBACK_ARTIFACT, 'utf8')) as {
      requests: Record<string, { status: number | string }>
    }
    // `isTrustedApiRequest` (`api-request-trust.ts:96-99`) is applied by the API
    // handler only, and answers 403 for a Host that is neither loopback nor a
    // declared trusted authority.
    expect(artifact.requests.apiUntrustedHost!.status).toBe(403)
    // The index route consults authentication and never the Host fence, so a
    // hostile Host gets the same 401 as everything else. Recorded as the honest
    // contrast: the rebinding defense is an /api property, not a server-wide one.
    expect(artifact.requests.indexUntrustedHost!.status).toBe(401)
  })
})

describe('E02: what the human terminal is, quoted from its own source', () => {
  it('the terminal controller declares system-user permissions and bypasses sandbox and approval', () => {
    // The privilege claim is a claim about THIS FILE, so the file is read.
    const source = readFileSync(
      join(DSH_SRC_ROOT, 'packages/api/terminal-controller/src/index.ts'),
      'utf8',
    )

    // The module header, verbatim.
    expect(source).toContain("Session-owned user terminals with the execution environment's system-user permissions.")

    // `create()`'s own doc comment, verbatim. This is the sentence that makes
    // wrapping it as a model tool privilege escalation: the allocation is
    // EXPLICITLY outside the two mechanisms that constrain the model.
    expect(source).toContain('without Agent sandbox or approval restrictions.')

    // And the structural fact behind both sentences: `spawn()` hands argv to the
    // terminal allocator with NO sandbox wrap anywhere in the call.
    const spawnBody = source.slice(source.indexOf('private async spawn(agent: Agent'))
    const spawnTerminal = spawnBody.slice(spawnBody.indexOf('await subprocess.spawnTerminal({'))
    const spawnCall = spawnTerminal.slice(0, spawnTerminal.indexOf('})'))
    expect(spawnCall).toContain('spawnTerminal')
    // No confinement call in the allocation path. If a future version wraps the
    // PTY, this fails and the privilege claim must be re-read rather than
    // inherited.
    expect(spawnCall).not.toContain('confine')
    expect(spawnCall).not.toContain('sandbox')

    // `sandboxPolicy` is consulted for a FALLBACK CWD, not for confinement. The
    // `execution()` helper reads it, and `environment()` uses it only when the
    // Session header carries no cwd.
    expect(source).toContain('cwd: agent.session.header.cwd ?? sandboxPolicy.workspaceRoot')
    // Which is why "the sandbox policy is in scope" must not be read as "the PTY
    // is confined": the policy object is present and never applied.
    expect(source).toContain("const sandboxPolicy = agent.ctx.get('sandboxPolicy')")
  })
})

describe('E02: the scope semantics that make a naive reachability reading wrong', () => {
  it('ctx.get resolves a service across an isolation realm, so it is a registry read and not a scope test', async () => {
    // This is measurement error (2) from the file header, pinned as a test so it
    // cannot be re-learned by making the mistake again. The consequence for E02
    // is specific: `agent.ctx.get('terminalController')` being DEFINED is not
    // evidence of a leak, and being UNDEFINED is not evidence of isolation.
    // Neither reading may be used to close this gate.
    const ctx = new Context()
    // The root fiber provides a service.
    ctx.provide('e02RootOnly' as never, { tag: 'root' } as never)
    // A child that isolates an UNRELATED name -- the shape a preset realm has.
    const presetRealm = ctx.isolate('e02PresetOwnedName')

    // The realm still resolves the root's service.
    expect((presetRealm.get('e02RootOnly' as never) as { tag: string } | undefined)?.tag).toBe('root')

    // And the reverse: a service provided INSIDE the realm resolves from the
    // root. This is the direction that makes the reading useless as a scope test.
    presetRealm.provide('e02RealmOwned' as never, { tag: 'realm' } as never)
    expect((ctx.get('e02RealmOwned' as never) as { tag: string } | undefined)?.tag).toBe('realm')

    await ctx.fiber.dispose()
  })

  it('the tool catalog keyed by the Agent object is the capability boundary, and it is empty here', async () => {
    // The positive control for the claim above: in a composition that mounts the
    // tool registry and NOTHING else, the model's catalog is empty. That is what
    // "absent" looks like when measured on the right key.
    const { ctx, agent, dispose } = await mountAgentScope()
    try {
      const names = ctx.tools.schemas(agent).map(schema => schema.name)
      expect(names).toEqual([])
      // And the wrong key collapses to the same empty answer, which is exactly
      // why the artifact's `toolCountContextKey: 0` contrast is recorded in
      // M8.5 rather than treated as a second measurement.
      expect(ctx.tools.schemas(agent.ctx).length).toBe(0)
    } finally {
      await dispose()
    }
  })
})
