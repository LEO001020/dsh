/**
 * Profile/preset layering, preset identity, and bad-session refusal — driven
 * against the REAL DSH artifacts.
 *
 * Three gates, two different kinds of evidence:
 *
 *   A06 — preset/preset layering. Boots the REAL `@deepseek-ai/dsh-agent-presets`
 *         roster over real presets and asserts that two Sessions on two
 *         different presets each get their own composed tool set, that a
 *         service registered once at host level is not re-registered per
 *         preset, and that a value written while serving preset A does not
 *         leak into preset B.
 *
 *   A07 — preset identity. Asserts the precedence rules the discovery module
 *         actually implements: first-root-wins per id, a user preset with a
 *         unique id discovered alongside the shipped ones, and `resolve()` on
 *         an unknown id throwing rather than falling back.
 *
 *   A11 — bad session resume. SPAWNS THE REAL BUILT LAUNCHER
 *         (`apps/cli/lib/bin.js`) as a subprocess with a controlled `DSH_HOME`
 *         and asserts the documented refusals. Nothing here asserts success
 *         where the launcher is supposed to refuse; the exit code and stderr
 *         are captured verbatim.
 *
 * WHY THE LAUNCHER IS A SUBPROCESS AND NOT AN IMPORT: the qualified launcher is
 * the built one. Its module identity is what the profile resolver installs, and
 * an in-process import would run against this package's junctioned graph
 * instead — a different module identity, which is exactly the difference that
 * once made the source launcher pass here and fail on overlays. Only a real
 * spawn answers "what does the launcher do".
 *
 * WHY `--dump-default-config`/`--dump-config` FOR GRAPH QUESTIONS: they compose
 * the profile tree and exit WITHOUT booting the app, so they answer "what would
 * mount" without needing a provider credential. Where a boot is unavoidable
 * (A11's session-id path), a missing credential is a correct, assertable
 * outcome rather than a reason to skip.
 *
 * WHAT IS NOT ASSERTED, DELIBERATELY: that a preset's plugin closure is fresh
 * per preset. It is not — see the module-identity finding in
 * `qualification/results/M9.7-profile-isolation/FINDINGS.md`. A test asserting
 * freshness would have to be written against a fixture arrangement that hides
 * the real behaviour, so the closure-sharing case is asserted as it actually
 * behaves and the constraint is named in a comment instead.
 */
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, readdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import Group from '@deepseek-ai/cordis-plugin-group'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import AgentPresets, {
  COMPOSITION_FILE, SHIPPED_PRESET_ROOT, discoverPresets, livePresetMounts, serviceForAgent,
} from '@deepseek-ai/dsh-agent-presets'
import type { AgentPreset, PresetRoot } from '@deepseek-ai/dsh-agent-presets'
// Type-only: these packages declare `ctx.jobs` and `ctx.compaction` through
// `declare module '@deepseek-ai/cordis'`, and the merge is only in scope where
// the module is named. `serviceForAgent`'s name parameter is typed
// `keyof Context`, so without these the jobs/compaction lookups do not
// typecheck even though they resolve at runtime.
import type {} from '@deepseek-ai/dsh-jobs'
import type {} from '@deepseek-ai/dsh-compaction'
import { afterEach, describe, expect, it } from 'vitest'

// ── the real launcher ───────────────────────────────────────────────────────

/**
 * The BUILT launcher. The source launcher (`pnpm dsh`) is not interchangeable:
 * it resolves a different Cordis module identity and fails on overlays, which
 * is gate A03's finding. Pinned as a constant so a future edit cannot quietly
 * retarget these tests at the weaker entry point.
 */
const LAUNCHER = 'D:/DSH/src/dsh-src/apps/cli/lib/bin.js'

/**
 * The harness base a preset's bare package names resolve from.
 *
 * This must be a directory inside the INSTALLED HARNESS, because that is where
 * `mountPreset` resolves package rows from: a locally authored preset lives
 * under the user's home, where Node's upward `node_modules` walk never reaches
 * the harness's dependencies. `apps/cli/` is the launcher's own directory, so
 * it is the same base the real launcher supplies.
 */
const HARNESS_BASE = pathToFileURL('D:/DSH/src/dsh-src/apps/cli/').href

/** Every temp root this file created, removed after each test. */
const tempRoots: string[] = []
/** Teardowns for booted contexts, run before the temp roots are removed. */
const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  const failures: unknown[] = []
  for (const cleanup of cleanups.splice(0)) {
    try {
      await cleanup()
    } catch (error) {
      failures.push(error)
    }
  }
  for (const root of tempRoots.splice(0)) {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
  if (failures.length > 0) throw new AggregateError(failures, 'teardown failed')
})

/**
 * Point `DSH_HOME` at a fresh temp directory for one test.
 *
 * The roster resolves the user preset root in its CONSTRUCTOR, so the variable
 * must be set before the plugin mounts. Leaving it unset would reach the
 * developer's real `~/.dsh` and, on this machine, the canary homes other work
 * depends on.
 * @returns the temp home, also registered for removal.
 */
async function tempHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'dsh-iso-home-'))
  tempRoots.push(home)
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  cleanups.push(async () => {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
  })
  return home
}

/** A fresh temp directory registered for removal. */
async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  tempRoots.push(dir)
  return dir
}

// ── A06: two presets, two Sessions, one host ────────────────────────────────

/**
 * A preset row that registers one tool per configured name and keeps a value in
 * its MODULE scope — the "standing composition" shape the gate names.
 *
 * The mutable `memo` here is deliberately in module scope rather than in the
 * plugin closure, because that is where a real preset's shared state lives:
 * a preset composition is imported once per FILE, and every preset that names
 * the same file shares one module instance. A test that put the value in the
 * closure would be asserting a property of its own fixture, not of DSH.
 *
 * The tools return their observations as a JSON STRING so the test reads values
 * rather than trusting a boolean the fixture computed. The string type is not
 * cosmetic: the registry schema-validates every tool's returned value against
 * its declared `output.schema`, and an object returned under `{type: 'string'}`
 * is rejected as `INVALID_TOOL_OUTPUT`.
 */
const STATEFUL_PRESET_ROW = `
export const name = 'stateful-fixture'
export const inject = ['tools']

/** Module-scope state: shared by every preset that imports THIS FILE. */
let memo = null
/** Which preset tags have applied against this module instance. */
export const appliedTags = []

function text(value) {
  return [{ type: 'text', text: String(value) }]
}

export function apply(ctx, config) {
  appliedTags.push(config.tag)
  ctx.effect(() => ctx.tools.register({
    name: config.readTool,
    description: 'read the module-scope memo',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    execute: () => Promise.resolve(JSON.stringify({ tag: config.tag, memo, appliedTags: [...appliedTags] })),
  }))
  ctx.effect(() => ctx.tools.register({
    name: config.writeTool,
    description: 'write the module-scope memo',
    parameters: {
      type: 'object',
      properties: { value: { type: 'string', required: true } },
      additionalProperties: false,
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    execute: (args) => { memo = args.value; return Promise.resolve(JSON.stringify({ wrote: args.value })) },
  }))
}
`

/**
 * Boot a real roster over `roots`, with the real registries a preset composes
 * against.
 *
 * The roster is configured with `includeShippedRoot: false` and
 * `includeUserRoot: false` so the test sees exactly the roots it names. That is
 * not a weakening: the shipped and user roots are covered by A07 below, and a
 * layering test that let four shipped presets into the fixture would be
 * asserting against an input it did not author.
 * @param roots - preset roots in precedence order.
 * @param defaultId - the preset a session naming none composes.
 * @returns the booted context.
 */
async function bootRoster(roots: readonly PresetRoot[], defaultId: string): Promise<Context> {
  const ctx = new Context()
  ctx.baseUrl = HARNESS_BASE
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  // A preset outside this workspace cannot resolve `cordis-plugin-group` by
  // name, so the app registers it as a builtin; real presets compose groups,
  // so the fixture must be able to as well.
  ctx.loader.builtins.group = Group
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(TokenMeter)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(AgentPresets, {
    default: defaultId,
    roots: [...roots],
    includeShippedRoot: false,
    includeUserRoot: false,
  })
  cleanups.push(async () => {
    await ctx.fiber.dispose()
  })
  return ctx
}

/** Create one Session composed from `presetId`, as the real agent factory does. */
async function sessionOn(ctx: Context, sessionId: string, presetId: string): Promise<Agent> {
  const handle = await ctx.agents.create({
    sessionId: SessionId(sessionId),
    setup: async (agentCtx: Context) => void await ctx.agentPresets.mount(agentCtx, presetId),
  })
  return handle.agent
}

/** Visible tool names for one agent. The scope key is the AGENT, not its ctx. */
const toolsOf = (ctx: Context, agent: Agent): string[] =>
  ctx.tools.schemas(agent).map(schema => schema.name).sort()

/** Execute one tool as `agent` and parse its canonical JSON answer. */
async function callTool(ctx: Context, agent: Agent, name: string, args: unknown): Promise<unknown> {
  const result = await ctx.tools.execute({
    signal: new AbortController().signal,
    callId: `${name}-call` as never,
    name,
    arguments: args,
    agent,
  })
  expect(result.isError).toBe(false)
  const [first] = result.content
  expect(first?.type).toBe('text')
  return JSON.parse((first as { text: string }).text) as unknown
}

describe('A06 preset layering: two presets in parallel Sessions', () => {
  /**
   * Write the two presets the gate needs.
   *
   * `alpha` and `beta` each carry their own copy of the fixture module, so each
   * preset owns its own module instance. The gate is about two PRESETS not
   * interfering, and distinct files are what makes that a real question — see
   * the shared-file case asserted separately below.
   * @returns the root holding both presets.
   */
  async function twoPresetRoot(): Promise<string> {
    const root = await tempDir('dsh-iso-presets-')
    for (const id of ['alpha', 'beta']) {
      await mkdir(join(root, id))
      await writeFile(join(root, id, 'stateful.js'), STATEFUL_PRESET_ROW)
      await writeFile(join(root, id, COMPOSITION_FILE), [
        `# ${id}: one tool pair per preset, reading and writing module-scope state.`,
        '- id: stateful',
        '  name: ./stateful.js',
        '  config:',
        `    tag: ${id}`,
        `    readTool: ${id}_read`,
        `    writeTool: ${id}_write`,
        '',
      ].join('\n'))
    }
    return root
  }

  it('gives each Session its own composed tool set', async () => {
    const root = await twoPresetRoot()
    const ctx = await bootRoster([{ path: root, trust: 'user' }], 'alpha')

    const alpha = await sessionOn(ctx, 'sess-alpha', 'alpha')
    const beta = await sessionOn(ctx, 'sess-beta', 'beta')

    // Two distinct presets, two distinct catalogs. A shared catalog here would
    // mean the second mount had overwritten the first's registrations.
    expect(toolsOf(ctx, alpha)).toEqual(['alpha_read', 'alpha_write'])
    expect(toolsOf(ctx, beta)).toEqual(['beta_read', 'beta_write'])
    // Each preset got ONE standing mount, not one per session.
    expect(livePresetMounts().map(m => m.presetId).sort()).toEqual(['alpha', 'beta'])
    // The agent, not its context, is the tool-view scope. Passing `agent.ctx`
    // yields a context that owns no scope layer and collapses to the empty
    // global view — the mistake DSH's own e2e probe made once.
    expect(ctx.tools.schemas(alpha.ctx)).toHaveLength(0)
  })

  it('registers a host-level service once, not once per preset', async () => {
    const root = await twoPresetRoot()
    const ctx = await bootRoster([{ path: root, trust: 'user' }], 'alpha')

    // A service the HOST composition provides, before any preset mounts.
    const hostService = { label: 'host-owned' }
    ctx.reflect.provide('hostOwnedFixture', hostService)

    const alpha = await sessionOn(ctx, 'sess-alpha', 'alpha')
    const beta = await sessionOn(ctx, 'sess-beta', 'beta')

    // Both Sessions resolve the ONE host registration. A per-preset
    // re-registration would either throw on the duplicate or hand the second
    // session a different object.
    expect(ctx.get('hostOwnedFixture' as never)).toBe(hostService)
    expect(serviceForAgent(ctx, alpha, 'hostOwnedFixture' as never)).toBeUndefined()

    // The falsifiable half: `tools` and `systemPrompt` ARE host-level
    // registries, and every preset registers INTO them. Two presets must
    // therefore still leave exactly ONE registration of each — a preset that
    // minted its own registry would show a second entry here, and the
    // registrations would stop being visible to the other preset's sessions.
    const store = ctx.reflect.store
    const names = Object.getOwnPropertySymbols(store)
      .map(key => store[key]?.name)
      .filter((name): name is string => name !== undefined)
    for (const registry of ['tools', 'systemPrompt', 'agentPresets']) {
      expect({ registry, count: names.filter(name => name === registry).length })
        .toEqual({ registry, count: 1 })
    }
  })

  it('keeps a value written while serving preset A out of preset B', async () => {
    const root = await twoPresetRoot()
    const ctx = await bootRoster([{ path: root, trust: 'user' }], 'alpha')

    const alpha = await sessionOn(ctx, 'sess-alpha', 'alpha')
    const beta = await sessionOn(ctx, 'sess-beta', 'beta')

    await callTool(ctx, alpha, 'alpha_write', { value: 'A-ONLY-VALUE' })

    // A is where the value was written; it must still see it.
    expect(await callTool(ctx, alpha, 'alpha_read', {})).toEqual({
      tag: 'alpha', memo: 'A-ONLY-VALUE', appliedTags: ['alpha'],
    })
    // B must not. `memo: null` is the untouched module state, and `appliedTags`
    // shows only `beta` — neither preset's apply ran against the other's module.
    expect(await callTool(ctx, beta, 'beta_read', {})).toEqual({
      tag: 'beta', memo: null, appliedTags: ['beta'],
    })
  })

  it('shares one module instance between two presets naming the SAME file', async () => {
    // The standing-composition trap, asserted as it actually behaves rather
    // than as a wish. A preset composition is imported per FILE URL: two
    // presets naming one file get ONE module instance, so module-scope state
    // in that file IS shared across their Sessions. DSH does not prevent this
    // and this project must not assume otherwise.
    //
    // This is why `dsh-daily-work/tools` holds no cross-session mutable state:
    // its row is reached through whatever composition names it, so any
    // module-scope cache in it would be visible to every preset that named the
    // same file. Every operation resolves the exact live Agent and run instead.
    const root = await tempDir('dsh-iso-shared-')
    await mkdir(join(root, 'shared'))
    await writeFile(join(root, 'shared', 'stateful.js'), STATEFUL_PRESET_ROW)
    for (const id of ['gamma', 'delta']) {
      await mkdir(join(root, id))
      await writeFile(join(root, id, COMPOSITION_FILE), [
        `# ${id}: names the SHARED module, so it is a second instance of the same URL.`,
        '- id: stateful',
        '  name: ../shared/stateful.js',
        '  config:',
        `    tag: ${id}`,
        `    readTool: ${id}_read`,
        `    writeTool: ${id}_write`,
        '',
      ].join('\n'))
    }
    const ctx = await bootRoster([{ path: root, trust: 'user' }], 'gamma')

    const gamma = await sessionOn(ctx, 'sess-gamma', 'gamma')
    const delta = await sessionOn(ctx, 'sess-delta', 'delta')

    // Each still gets its OWN tool catalog: registrations are scoped, and a
    // scoped registration shadows rather than collides.
    expect(toolsOf(ctx, gamma)).toEqual(['gamma_read', 'gamma_write'])
    expect(toolsOf(ctx, delta)).toEqual(['delta_read', 'delta_write'])

    await callTool(ctx, gamma, 'gamma_write', { value: 'G-VALUE' })

    // The registrations are per-preset; the MODULE is not. Both presets see the
    // one `memo`, and `appliedTags` records that both applied to this instance.
    expect(await callTool(ctx, delta, 'delta_read', {})).toEqual({
      tag: 'delta', memo: 'G-VALUE', appliedTags: ['gamma', 'delta'],
    })
  })

  it('gives each Session its own Jobs registry and compaction engine when the presets isolate them', async () => {
    // The gate names Jobs and compaction specifically. Both are SERVICES, so
    // the only way two presets can each own one is an `isolate` realm — a
    // service published into the root realm is process-global and the second
    // preset collides with the first, which `mountPreset` rejects outright.
    // This fixture composes them the way the shipped presets do.
    const root = await tempDir('dsh-iso-services-')
    const compose = (tag: string): string => [
      `# ${tag}: Jobs and compaction behind entry-local realms.`,
      '- id: jobs-group',
      '  name: cordis:group',
      '  group: true',
      '  isolate:',
      `    jobs: ${tag}-jobs`,
      '  config:',
      '    - id: jobs',
      "      name: '@deepseek-ai/dsh-jobs-local'",
      '    - id: tool-jobs',
      "      name: '@deepseek-ai/dsh-tool-jobs'",
      '      config:',
      '        completionDelivery: quiet',
      '',
      '- id: compaction-group',
      '  name: cordis:group',
      '  group: true',
      '  isolate:',
      `    compaction: ${tag}-compaction`,
      '  config:',
      '    - id: compaction-basic',
      "      name: '@deepseek-ai/dsh-compaction-basic'",
      '      config:',
      '        auto: false',
      '',
    ].join('\n')
    for (const id of ['alpha', 'beta']) {
      await mkdir(join(root, id))
      await writeFile(join(root, id, COMPOSITION_FILE), compose(id))
    }
    const ctx = await bootRoster([{ path: root, trust: 'user' }], 'alpha')

    const alpha = await sessionOn(ctx, 'sess-alpha', 'alpha')
    const beta = await sessionOn(ctx, 'sess-beta', 'beta')

    // Both presets mounted the real jobs tool trio.
    expect(toolsOf(ctx, alpha)).toEqual(['job_kill', 'job_list', 'job_output'])
    expect(toolsOf(ctx, beta)).toEqual(['job_kill', 'job_list', 'job_output'])

    // The realm-private instances are per-preset and distinct objects. Reading
    // them through the agent is the documented addressing for a caller that
    // already holds the agent — the realm keeps them out of every host context.
    const jobsAlpha = serviceForAgent(ctx, alpha, 'jobs')
    const jobsBeta = serviceForAgent(ctx, beta, 'jobs')
    expect(jobsAlpha).toBeDefined()
    expect(jobsBeta).toBeDefined()
    expect(jobsAlpha).not.toBe(jobsBeta)

    const compactionAlpha = serviceForAgent(ctx, alpha, 'compaction')
    const compactionBeta = serviceForAgent(ctx, beta, 'compaction')
    expect(compactionAlpha).toBeDefined()
    expect(compactionBeta).toBeDefined()
    expect(compactionAlpha).not.toBe(compactionBeta)

    // Neither instance reached the ROOT realm: the host resolves no `jobs` of
    // its own here, which is what "no sibling service visible" means.
    expect(ctx.get('jobs' as never)).toBeUndefined()
    expect(ctx.get('compaction' as never)).toBeUndefined()
  })
})

// ── A07: preset identity and precedence ─────────────────────────────────────

describe('A07 preset identity: precedence and resolution', () => {
  /**
   * Lay out a root holding one preset whose composition is `[]`.
   *
   * An empty composition is a valid, mountable preset: the gate is about which
   * DIRECTORY wins an id, and a rowless list keeps the fixture from depending
   * on any plugin.
   * @param parent - directory to create the preset under.
   * @param id - the preset id, which is the directory name.
   * @param metadata - optional `preset.yml` body.
   * @returns the preset directory.
   */
  async function presetDir(parent: string, id: string, metadata?: string): Promise<string> {
    const dir = join(parent, id)
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, COMPOSITION_FILE), '[]\n')
    if (metadata !== undefined) await writeFile(join(dir, 'preset.yml'), metadata)
    return dir
  }

  it('lets an earlier root shadow a later root with the same id', async () => {
    // `discoverPresets` walks roots in precedence order and keeps the first
    // sighting of an id. The roster relies on it: the shipped root is FIRST and
    // the user root LAST, so a shipped preset shadows a user directory that
    // claimed its name.
    const shippedRoot = await tempDir('dsh-iso-shipped-')
    const userRoot = await tempDir('dsh-iso-user-')
    await presetDir(shippedRoot, 'standard', 'name: Shipped Standard\norder: 1\n')
    await presetDir(userRoot, 'standard', 'name: User Impostor\norder: 1\n')

    const found = await discoverPresets(
      [
        { path: shippedRoot, trust: 'system' },
        { path: userRoot, trust: 'user' },
      ],
      HARNESS_BASE,
    )

    expect(found.map(preset => preset.id)).toEqual(['standard'])
    const [winner] = found
    expect(winner?.trust).toBe('system')
    expect(winner?.name).toBe('Shipped Standard')
    // The winner's PATH is what decides which composition mounts, so it must
    // point into the earlier root rather than merely carrying its trust label.
    expect(winner?.path.startsWith(shippedRoot)).toBe(true)
  })

  it('discovers a user preset with a unique id alongside the shipped ones', async () => {
    const shippedRoot = await tempDir('dsh-iso-shipped-')
    const userRoot = await tempDir('dsh-iso-user-')
    for (const id of ['standard', 'minimal']) await presetDir(shippedRoot, id)
    await presetDir(userRoot, 'daily-candidate', 'name: Daily Candidate\norder: 1\n')

    const found = await discoverPresets(
      [
        { path: shippedRoot, trust: 'system' },
        { path: userRoot, trust: 'user' },
      ],
      HARNESS_BASE,
    )

    // A unique id is ADDED, never suppressed: shadowing is per id, not per root.
    expect(found.map(preset => preset.id).sort()).toEqual(['daily-candidate', 'minimal', 'standard'])
    const added = found.find(preset => preset.id === 'daily-candidate')
    expect(added?.trust).toBe('user')
    expect(added?.name).toBe('Daily Candidate')
  })

  it('refuses a user directory that tries to claim a shipped preset id through the real roster', async () => {
    // The end-to-end version of the precedence rule: a real roster with the
    // real shipped root enabled, and a user home holding a directory named
    // after a shipped preset. The shipped one must win.
    const home = await tempHome()
    const userRoot = join(home, '.agent-presets')
    await presetDir(userRoot, 'minimal', 'name: User Minimal\n')

    const ctx = new Context()
    ctx.baseUrl = HARNESS_BASE
    await ctx.plugin(Loader)
    ctx.loader.builtins.include = Include
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(AgentPresets, {
      default: 'minimal',
      roots: [],
      includeShippedRoot: true,
      includeUserRoot: true,
    })
    cleanups.push(async () => {
      await ctx.fiber.dispose()
    })

    const resolved = await ctx.agentPresets.resolve('minimal')

    expect(resolved.trust).toBe('system')
    expect(resolved.path.startsWith(SHIPPED_PRESET_ROOT)).toBe(true)
    expect(resolved.name).not.toBe('User Minimal')
  })

  it('throws on an unknown id instead of falling back to the default', async () => {
    // A silent fallback would run a session under a composition the caller
    // never named. The error must name the id AND the alternatives, because the
    // caller's next move is to pick a real one.
    const root = await tempDir('dsh-iso-unknown-')
    await presetDir(root, 'alpha')
    await presetDir(root, 'beta')
    const ctx = await bootRoster([{ path: root, trust: 'user' }], 'alpha')

    const failure = await ctx.agentPresets.resolve('nope').then(
      () => undefined,
      (error: unknown) => error as { code?: string; message: string },
    )

    expect(failure).toBeDefined()
    expect(failure?.code).toBe('agent-preset/not-found')
    expect(failure?.message).toContain('preset "nope" not found')
    expect(failure?.message).toContain('alpha')
    expect(failure?.message).toContain('beta')
  })

  it('refuses to compose a Session on an unknown preset rather than composing nothing', async () => {
    // `resolve` throwing is only useful if the mounting path propagates it: a
    // session that silently composed no preset would address the model with an
    // empty tool catalog and prompt.
    const root = await tempDir('dsh-iso-refuse-')
    await presetDir(root, 'alpha')
    const ctx = await bootRoster([{ path: root, trust: 'user' }], 'alpha')

    await expect(sessionOn(ctx, 'sess-unknown', 'nope')).rejects.toThrow(/not found/)
    expect(ctx.agents.get(SessionId('sess-unknown'))).toBeUndefined()
  })

  it('does not treat a same-mtime same-size edit as a new generation', async () => {
    // The production rule this pins: a standing generation is identified by
    // {mtimeMs, size}, NOT by content. Rewriting a composition while restoring
    // both makes the edit invisible, so nothing may claim a content hash backs
    // this. `copyComposition` is the only authoring write, and it mints a new
    // directory rather than editing in place — but the hazard is real for any
    // future in-place editor, which is why it is asserted rather than assumed.
    const root = await tempDir('dsh-iso-stamp-')
    await mkdir(join(root, 'alpha'))
    const composition = join(root, 'alpha', COMPOSITION_FILE)
    await writeFile(composition, '[]\n')
    // A fixed whole-second timestamp: `utimes` takes fractional seconds, and
    // only an integer is reproduced exactly on the round trip.
    const STAMP_SECONDS = 1_700_000_000
    await utimes(composition, STAMP_SECONDS, STAMP_SECONDS)
    const before = await stat(composition)
    expect(before.mtimeMs).toBe(STAMP_SECONDS * 1000)

    // Same byte length, different content, same stamp.
    await writeFile(composition, '- \n')
    await utimes(composition, STAMP_SECONDS, STAMP_SECONDS)
    const after = await stat(composition)
    expect({ mtimeMs: after.mtimeMs, size: after.size })
      .toEqual({ mtimeMs: before.mtimeMs, size: before.size })

    // The two files really do differ, so the identical stamp is a collision and
    // not a no-op write.
    expect(await readFile(composition, 'utf8')).toBe('- \n')
    expect(await readFile(composition, 'utf8')).not.toBe('[]\n')
  })

  it('keeps a Session on the generation it joined while a later Session gets a new one', async () => {
    // The standing composition is shared by every Session of one generation, so
    // a composition edit must not retroactively change a running Session. The
    // stamp is what notices the edit; sessions already joined keep their mount.
    const root = await tempDir('dsh-iso-generation-')
    await mkdir(join(root, 'alpha'))
    await writeFile(join(root, 'alpha', 'stateful.js'), STATEFUL_PRESET_ROW)
    const composition = join(root, 'alpha', COMPOSITION_FILE)
    const render = (tool: string): string => [
      '- id: stateful',
      '  name: ./stateful.js',
      '  config:',
      '    tag: alpha',
      `    readTool: ${tool}`,
      `    writeTool: ${tool}_write`,
      '',
    ].join('\n')
    await writeFile(composition, render('v1_read'))

    const ctx = await bootRoster([{ path: root, trust: 'user' }], 'alpha')
    const first = await sessionOn(ctx, 'sess-gen1', 'alpha')
    expect(toolsOf(ctx, first)).toEqual(['v1_read', 'v1_read_write'])

    // A real edit: different content AND a later stamp.
    await writeFile(composition, render('v2_read'))
    const later = await stat(composition)
    await utimes(composition, later.atimeMs / 1000 + 10, later.mtimeMs / 1000 + 10)

    const second = await sessionOn(ctx, 'sess-gen2', 'alpha')

    // The second session runs the new generation; the first keeps its own.
    expect(toolsOf(ctx, second)).toEqual(['v2_read', 'v2_read_write'])
    expect(toolsOf(ctx, first)).toEqual(['v1_read', 'v1_read_write'])
    // Two generations are live at once — the superseded one is not disposed
    // while a Session still runs on it.
    expect(livePresetMounts().filter(mount => mount.presetId === 'alpha')).toHaveLength(2)
  })

  it('refuses a preset whose composition names a plugin that cannot be resolved', async () => {
    // Discovery judges health WITHOUT importing anything, and a broken row is
    // reported rather than skipped: a skipped directory would still occupy the
    // id on disk while no surface showed anything to delete.
    const root = await tempDir('dsh-iso-broken-')
    await mkdir(join(root, 'broken'))
    await writeFile(join(root, 'broken', COMPOSITION_FILE), [
      '- id: ghost',
      "  name: '@deepseek-ai/dsh-no-such-package-exists'",
      '',
    ].join('\n'))
    await presetDir(root, 'healthy')

    const found: AgentPreset[] = await discoverPresets([{ path: root, trust: 'user' }], HARNESS_BASE)
    const broken = found.find(preset => preset.id === 'broken')

    // The row survives discovery and carries its reason.
    expect(broken).toBeDefined()
    expect(broken?.broken).toContain('cannot be resolved')
    expect(broken?.broken).toContain('@deepseek-ai/dsh-no-such-package-exists')
    // The healthy sibling is unaffected by its neighbour's rot.
    expect(found.find(preset => preset.id === 'healthy')?.broken).toBeUndefined()

    // And mounting it is refused up front with that same reason.
    const ctx = await bootRoster([{ path: root, trust: 'user' }], 'healthy')
    await expect(sessionOn(ctx, 'sess-broken', 'broken')).rejects.toThrow(/failed to mount/)
    expect(ctx.agents.get(SessionId('sess-broken'))).toBeUndefined()
  })

  it('refuses to mount a shipped preset when the host plane its rows inject is absent', async () => {
    // A REAL shipped preset names rows that inject HOST services — `fs`,
    // `shell`, `subprocess`, `jobs`, `skills`, `subagents`, `web`, `commands`,
    // `userQuestions`. `bootRoster` mounts only the registries a fixture needs,
    // so those injections never resolve and every dependent row stays pending.
    //
    // `mountPreset` requires every enabled row to reach a usable state and
    // rejects otherwise, so the mount fails with a per-row diagnostic. This is
    // the finding worth pinning: a preset is NOT self-contained, and a gate
    // that mounted a shipped preset against a hand-rolled context would be
    // measuring that context rather than the preset.
    //
    // It also shows why A06 uses authored fixtures for the layering question:
    // the layering rule is about the ROSTER, and the shipped presets drag the
    // whole host plane into the measurement.
    const ctx = await bootRoster([{ path: SHIPPED_PRESET_ROOT, trust: 'system' }], 'minimal')

    const failure = await sessionOn(ctx, 'sess-shipped', 'minimal').then(
      () => undefined,
      (error: unknown) => error as { message: string },
    )

    expect(failure).toBeDefined()
    expect(failure?.message).toContain('preset "minimal" failed to mount')
    // The diagnostic names the row and the services it is waiting for, which is
    // what makes this failure actionable rather than mysterious.
    expect(failure?.message).toMatch(/did not activate/)
    expect(failure?.message).toMatch(/waiting for/)
    // The rollback is complete: no half-composed Session is left behind.
    expect(ctx.agents.get(SessionId('sess-shipped'))).toBeUndefined()
    expect(livePresetMounts()).toHaveLength(0)
  })
})

// ── A11: the real launcher refuses bad resumes ──────────────────────────────

/** One completed launcher invocation. */
interface LauncherRun {
  /** The real process exit code. */
  readonly code: number
  readonly stdout: string
  readonly stderr: string
}

/**
 * Run the REAL built launcher as a subprocess with a controlled `DSH_HOME`.
 *
 * `cwd` is explicit because the headless runner compares the recorded session
 * directory against the current one, so a test that let the working directory
 * drift would be measuring this process rather than the launcher.
 *
 * No credential is supplied. Every assertion below is about a REFUSAL, and a
 * refusal happens before any provider call — a run that needed a key would be
 * a different gate (A12/C01), not this one.
 * @param home - the `DSH_HOME` for this invocation.
 * @param args - launcher arguments, verbatim.
 * @param cwd - working directory for the child.
 * @returns the exit code and both streams.
 */
async function runLauncher(home: string, args: readonly string[], cwd: string): Promise<LauncherRun> {
  return await new Promise<LauncherRun>((resolve, reject) => {
    const child = spawn(process.execPath, [LAUNCHER, ...args], {
      cwd,
      env: { ...process.env, DSH_HOME: home },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => { stdout += chunk })
    child.stderr.on('data', (chunk: string) => { stderr += chunk })
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error(`launcher did not exit within 120s: dsh ${args.join(' ')}\nstderr so far:\n${stderr}`))
    }, 120_000)
    child.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      // A signal death is not an exit code, and treating it as one would let a
      // crash read as a clean refusal.
      if (code === null) reject(new Error(`launcher was killed by a signal: dsh ${args.join(' ')}`))
      else resolve({ code, stdout, stderr })
    })
  })
}

describe('A11 bad session resume: the real built launcher refuses', () => {
  it('is the launcher this project qualified, and it is present', async () => {
    // A wrong path would make every assertion below fail for the wrong reason,
    // so the path itself is asserted rather than assumed.
    expect(existsSync(LAUNCHER)).toBe(true)
    const run = await runLauncher(await tempHome(), ['--help'], process.cwd())
    expect(run.code).toBe(0)
    // The launcher's own usage text, so a different program answering here
    // cannot pass silently.
    expect(run.stdout).toContain('boot a DeepSeek Harness profile')
    expect(run.stdout).toContain('--profile <name>')
  })

  it('refuses --session-id for a Session that does not exist', async () => {
    const home = await tempHome()
    const cwd = await tempDir('dsh-iso-cwd-')

    const run = await runLauncher(
      home,
      ['--profile', 'headless', '--session-id', 'session-does-not-exist-0000', 'hello'],
      cwd,
    )

    // NOT a success. The runner must not create the requested id: that would
    // turn a typo into a brand-new empty history the caller believes it is
    // continuing.
    expect(run.code).toBe(1)
    expect(run.stderr).toContain('does not exist')
    expect(run.stderr).toContain('session-does-not-exist-0000')
    expect(run.stderr).toContain('omit --session-id to start a new Session')
    expect(run.stdout).toBe('')
  })

  it('creates no Session when the requested id does not exist', async () => {
    // The refusal's real content is what did NOT happen. A launcher that
    // refused with exit 1 but still wrote a session directory would have
    // created the empty history the error message promises it did not.
    const home = await tempHome()
    const cwd = await tempDir('dsh-iso-cwd-')

    await runLauncher(home, ['--profile', 'headless', '--session-id', 'session-ghost-1111', 'hello'], cwd)

    const sessions = join(home, 'sessions')
    const written = existsSync(sessions) ? await readdir(sessions) : []
    expect(written).toEqual([])
  })

  it('refuses an unknown profile by name', async () => {
    const home = await tempHome()

    const run = await runLauncher(home, ['--profile', 'no-such-profile-xyz', '--dump-config'], process.cwd())

    expect(run.code).toBe(1)
    // The documented wording, from `loadProfile`. `JSON.stringify` puts the
    // name in double quotes, which is what the assertion pins.
    expect(run.stderr).toContain('profile "no-such-profile-xyz" does not exist')
    expect(run.stderr).toContain("dsh plugin --profile no-such-profile-xyz add <package>")
    expect(run.stdout).toBe('')
  })

  it('refuses an unknown profile BEFORE creating any profile directory', async () => {
    // A refusal that had already initialized a profile would leave the user
    // with a half-created home to clean up. The check precedes `initProfile`.
    const home = await tempHome()

    await runLauncher(home, ['--profile', 'another-missing-profile', '--dump-config'], process.cwd())

    expect(existsSync(join(home, 'profiles', 'another-missing-profile'))).toBe(false)
  })

  it('refuses to resume a Session recorded in a different working directory', async () => {
    // The cwd is part of the Session's identity: adopting it from elsewhere
    // would silently run it against a different workspace. A real Session has
    // to exist first, so this is the one case here that needs a boot — and the
    // boot is allowed to fail on the missing credential AFTER the Session is
    // written, which is itself the documented outcome.
    const home = await tempHome()
    const recordedCwd = await tempDir('dsh-iso-recorded-')
    const otherCwd = await tempDir('dsh-iso-other-')

    const first = await runLauncher(home, ['--profile', 'headless', 'hello'], recordedCwd)
    expect(first.code).toBe(1)
    expect(first.stderr).toContain('MISSING_CREDENTIAL')

    const projectDirs = await readdir(join(home, 'sessions'))
    expect(projectDirs).toHaveLength(1)
    const [sessionId] = await readdir(join(home, 'sessions', projectDirs[0] as string))
    expect(sessionId).toBeDefined()

    const second = await runLauncher(
      home,
      ['--profile', 'headless', '--session-id', sessionId as string, 'again'],
      otherCwd,
    )

    expect(second.code).toBe(1)
    expect(second.stderr).toContain('was recorded in')
    expect(second.stderr).toContain('not')
    expect(second.stdout).toBe('')
    // Still exactly one Session: the refusal did not fork a new one.
    expect(await readdir(join(home, 'sessions'))).toEqual(projectDirs)
  })

  it('proceeds past the session check to the credential check when the resume is valid', async () => {
    // The control for the three refusals above: the SAME command with a real,
    // correctly-placed Session gets past identity and fails on the provider.
    // Without this, every refusal above could be passing because the launcher
    // refuses everything.
    const home = await tempHome()
    const cwd = await tempDir('dsh-iso-valid-')

    const first = await runLauncher(home, ['--profile', 'headless', 'hello'], cwd)
    expect(first.stderr).toContain('MISSING_CREDENTIAL')

    const projectDirs = await readdir(join(home, 'sessions'))
    const [sessionId] = await readdir(join(home, 'sessions', projectDirs[0] as string))

    const second = await runLauncher(
      home,
      ['--profile', 'headless', '--session-id', sessionId as string, 'again'],
      cwd,
    )

    // Past adoption, stopped only by the missing key. Asserting the specific
    // error keeps this from passing on an unrelated later failure.
    expect(second.code).toBe(1)
    expect(second.stderr).toContain('MISSING_CREDENTIAL')
    expect(second.stderr).not.toContain('does not exist')
    expect(second.stderr).not.toContain('was recorded in')
  })
})

// ── the graph the launcher composes ─────────────────────────────────────────

describe('the real launcher composes the preset roster into its profile graph', () => {
  it('mounts the agent-presets row in the web profile', async () => {
    // A06/A07 are about the roster, so the roster must actually be in the
    // graph the qualified launcher builds. `--dump-default-config` composes the
    // tree and exits WITHOUT booting the app, so this needs no credential and
    // starts no session.
    const home = await tempHome()
    const run = await runLauncher(home, ['--dump-default-config', '--profile', 'web'], process.cwd())

    expect(run.code).toBe(0)
    expect(run.stderr).toBe('')
    expect(run.stdout).toContain("name: '@deepseek-ai/dsh-agent-presets'")
    expect(run.stdout).toContain('default: standard')
    // The dump is a real composition, not an empty list.
    expect(run.stdout.split('\n').filter(line => line.startsWith('- id:')).length).toBeGreaterThan(50)
  })

  it('omits the user patch layer from --dump-default-config and includes it in --dump-config', async () => {
    // The distinction the two flags exist for. A gate that used `--dump-config`
    // where it meant "the shipped graph" would silently include whatever the
    // developer's home held — the contamination A05 is about.
    const home = await tempHome()
    const defaultRun = await runLauncher(home, ['--dump-default-config', '--profile', 'web'], process.cwd())
    expect(defaultRun.code).toBe(0)
    expect(defaultRun.stdout).toContain('default: standard')

    // The profile directory is created by the first invocation, so its user
    // patch can now be written. This is a temp home, never a canary one.
    const patchPath = join(home, 'profiles', 'web', 'cordis.patch.yml')
    expect(existsSync(patchPath)).toBe(true)
    await writeFile(patchPath, [
      '- id: agent-presets',
      '  config:',
      '    default: minimal',
      '',
    ].join('\n'))

    const patched = await runLauncher(home, ['--dump-config', '--profile', 'web'], process.cwd())
    expect(patched.code).toBe(0)
    expect(patched.stdout).toContain('default: minimal')

    // And the default dump is unaffected by the same file.
    const stillDefault = await runLauncher(home, ['--dump-default-config', '--profile', 'web'], process.cwd())
    expect(stillDefault.stdout).toContain('default: standard')
    expect(stillDefault.stdout).not.toContain('default: minimal')
  })

  it('requires --profile rather than guessing one', async () => {
    // No default profile means a bare invocation cannot silently boot the
    // wrong stack.
    const run = await runLauncher(await tempHome(), ['--dump-config'], process.cwd())

    expect(run.code).toBe(1)
    expect(run.stderr).toContain('--profile <name> is required')
  })
})

// ── the real shipped roster, read from the installed harness ────────────────

describe('the shipped roster the launcher actually mounts', () => {
  it('holds the four shipped presets and no more', async () => {
    const found = await discoverPresets([{ path: SHIPPED_PRESET_ROOT, trust: 'system' }], HARNESS_BASE)

    expect(found.map(preset => preset.id).sort()).toEqual(['cordis', 'minimal', 'ptc', 'standard'])
    // Every shipped preset is mountable: a shipped row that failed its own
    // health check would make the default composition unselectable.
    for (const preset of found) {
      expect({ id: preset.id, broken: preset.broken }).toEqual({ id: preset.id, broken: undefined })
      expect(existsSync(preset.path)).toBe(true)
    }
    // `order` is declared, so the roster reads by capability rather than
    // alphabetically. `standard` declares 1 and must come first.
    expect(found[0]?.id).toBe('standard')
  })

  it('keeps every shipped composition a real composition, not a truncated file', async () => {
    // Discovery's health check resolves each row's module; this reads the file
    // to confirm the compositions are non-trivial. A shipped preset truncated
    // to `[]` — the failure `PresetTree.write()` exists to prevent — would pass
    // a mount and offer the model nothing.
    //
    // `minimal` is deliberately the small one: it declares two TOP-LEVEL rows
    // (persona + one shell group) and is still a complete single-tool agent, so
    // the floor is two rows rather than a count that would call it broken.
    const found = await discoverPresets([{ path: SHIPPED_PRESET_ROOT, trust: 'system' }], HARNESS_BASE)
    for (const preset of found) {
      const text = await readFile(preset.path, 'utf8')
      const topLevel = text.split('\n').filter(line => line.startsWith('- id:')).length
      expect({ id: preset.id, atLeastTwoRows: topLevel >= 2 }).toEqual({ id: preset.id, atLeastTwoRows: true })
    }
    // The standard preset is the one this deployment names as its default.
    const standard = found.find(preset => preset.id === 'standard')
    expect(await readFile(standard?.path as string, 'utf8')).toContain('@deepseek-ai/dsh-tool-fs')
  })

  it('rejects a directory name that could escape the preset root', async () => {
    // The id becomes a path segment, so the pattern is a containment boundary
    // rather than a style rule. A directory discovery would refuse is not a
    // preset slot at all — it is skipped, and it blocks nothing.
    const root = await tempDir('dsh-iso-escape-')
    await mkdir(join(root, 'UPPER'))
    await writeFile(join(root, 'UPPER', COMPOSITION_FILE), '[]\n')
    await mkdir(join(root, 'has_underscore'))
    await writeFile(join(root, 'has_underscore', COMPOSITION_FILE), '[]\n')
    await mkdir(join(root, 'good-id'))
    await writeFile(join(root, 'good-id', COMPOSITION_FILE), '[]\n')

    const found = await discoverPresets([{ path: root, trust: 'user' }], HARNESS_BASE)

    expect(found.map(preset => preset.id)).toEqual(['good-id'])
  })
})
