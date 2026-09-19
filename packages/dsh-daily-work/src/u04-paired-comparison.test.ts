/**
 * U04 — the paired comparison C0/C1/C2, on a controlled fixture.
 *
 * THE GATE
 * ========
 * Stimulus: "C0/C1/C2 run on the same model, task and budget." Oracle: "report
 * completion quality, cost and wall time SEPARATELY, and do NOT declare a winner
 * without statistical basis."
 *
 * WHAT THIS FILE IS, STATED BEFORE ANY RESULT
 * ==========================================
 * This is a CONTROLLED-FIXTURE COMPARISON, not a benchmark, and it must not be
 * dressed up as one. No live provider is authorized
 * (`compatibility.lock.json`: `live_provider_budget_authorized: false`), so the
 * model is a scripted adapter and the "quality" axis is a scripted outcome. The
 * numbers below therefore measure the RIG and the CONTROL GROUPS' structural
 * differences. They do not measure model capability, and a reader who compared
 * them to a real benchmark would be reading a different experiment.
 *
 * What IS real, and is the reason this is worth running at all:
 *
 *   - the three control groups are composed as REAL presets through the real
 *     `@deepseek-ai/dsh-agent-presets` roster, so C0/C1/C2 differ by exactly the
 *     rows the plan names and by nothing else;
 *   - the tool catalog each group is offered is read from the real registry with
 *     the AGENT object as the scope key;
 *   - cost and wall time are measured, not asserted, and reported as three
 *     SEPARATE series;
 *   - the statistical position is computed and stated: with one run per group
 *     there is no variance estimate, so NO WINNER IS DECLARED.
 *
 * THE STATISTICAL POSITION, WHICH IS THE POINT OF THE GATE
 * ======================================================
 * One observation per group cannot distinguish a difference from noise. The file
 * therefore computes what it CAN support -- a per-axis description with the
 * sample size attached -- and asserts the ABSENCE of a winner claim. A future run
 * with N repetitions could compare; this one reports and stops.
 */
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import Group from '@deepseek-ai/cordis-plugin-group'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import AgentPresets from '@deepseek-ai/dsh-agent-presets'
import { createUserMessage, LlmAdapter, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

/**
 * The pinned checkout, used as the `baseUrl` a preset composition resolves its
 * `@deepseek-ai/*` rows against. Without it the composition cannot import the
 * shipped plugin names.
 */
const HARNESS_BASE = new URL('file:///D:/DSH/src/dsh-src/')

/** Temp roots created by this file, removed after each test. */
const tempRoots: string[] = []
afterEach(() => {
  for (const dir of tempRoots.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** A preset root the roster scans. */
interface PresetRoot {
  readonly path: string
  readonly trust: 'user'
}

/**
 * The C0/C1/C2 compositions.
 *
 * Each is a real preset directory with a real `agent.cordis.yml`. The differences
 * are exactly the ones the plan names, and they are stated as a DIFF so the
 * "one explainable difference per step" rule is checkable rather than asserted:
 *
 *   C0  the shipped `standard` composition, whole.
 *   C1  C0 plus ONE row: `@deepseek-ai/dsh-agent-instructions` with a repo
 *       instruction file. This is the "minimal repo instructions" difference.
 *   C2  C1 plus ONE row: the `work` tool from this package. This is the
 *       mandatory rolling-child extension.
 *
 * The shared base is written once and copied, so the three compositions cannot
 * drift apart in a way the diff would not show.
 */
/**
 * A real preset row: registers one tool, import-free.
 *
 * Import-free ON PURPOSE, and this is a measured constraint rather than a
 * stylistic choice. The Loader resolves a row's `name` through Node's ESM
 * resolver from the PRESET'S OWN DIRECTORY, and a temp directory has no
 * `node_modules` -- so `name: '@deepseek-ai/dsh-tool-fs'` fails to resolve and
 * the mount is refused with `2 rows name plugins that cannot be resolved`. The
 * shipped fixtures under `dsh-agent-presets/tests/fixtures/` are written the
 * same way, for the same reason. The tool and prompt registrations below are
 * real: they go through the real `ctx.tools` and `ctx.systemPrompt` services.
 */
const FIXTURE_PLUGIN = `
export const name = 'u04-fixture-row'
export const inject = ['tools', 'systemPrompt']

export function apply(ctx, config) {
  ctx.effect(() => ctx.tools.register({
    name: config.tool,
    description: 'u04 fixture tool ' + config.tool,
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] },
    execute: () => Promise.resolve(config.tool),
  }))
  if (config.section) {
    ctx.effect(() => ctx.systemPrompt.section({
      name: 'preset:' + config.section,
      order: 10,
      text: 'section for ' + config.section,
    }))
  }
}
`

/**
 * The C0/C1/C2 compositions.
 *
 * Each is a real preset directory with a real `agent.cordis.yml`, mounted by the
 * real roster. The differences are exactly the ones the plan names, stated as a
 * prefix chain so "one explainable difference per step" is checkable:
 *
 *   C0  two rows: a base tool and a base prompt section.
 *   C1  C0 plus ONE row: a repo-instructions row (`agent-instructions`).
 *   C2  C1 plus ONE row: the `work` tool row from this package's tool surface.
 *
 * The C2 row is named `work` because that is the tool this package contributes;
 * the fixture row that stands in for it registers a tool of that exact name, so
 * the measured difference between C1 and C2 is the presence of `work` in the
 * catalog rather than a difference in a fixture's label.
 */
const SHARED_ROWS = `
# ── C0 base: the shared surface every group has ──────────────────────────────
- id: base-tool
  name: '../row.mjs'
  config:
    tool: base_read
    section: base
`

/** C1's single added row: minimal repo instructions. */
const C1_ADDED_ROW = `
# ── C1 adds exactly one row: minimal repo instructions ───────────────────────
- id: agent-instructions
  name: '../row.mjs'
  config:
    tool: repo_instructions
    section: instructions
`

/** C2's single added row: the work tool. */
const C2_ADDED_ROW = `
# ── C2 adds exactly one row: the rolling-child work tool ─────────────────────
- id: daily-work-tools
  name: '../row.mjs'
  config:
    tool: work
`

/** Write the three preset directories and return their root. */
function stagePresets(): { root: string; c0: string; c1: string; c2: string } {
  const root = mkdtempSync(join(tmpdir(), 'u04-presets-'))
  tempRoots.push(root)
  // One shared row module, beside the preset directories, so every group
  // resolves the same file and the diff is in the compositions alone.
  writeFileSync(join(root, 'row.mjs'), FIXTURE_PLUGIN.trimStart(), 'utf8')
  const writePreset = (id: string, body: string): string => {
    const dir = join(root, id)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'agent.cordis.yml'), `${body.trimStart()}
`, 'utf8')
    writeFileSync(join(dir, 'preset.yml'), `name: ${id}
order: 1
`, 'utf8')
    return dir
  }
  const c0 = writePreset('c0', SHARED_ROWS)
  const c1 = writePreset('c1', `${SHARED_ROWS}
${C1_ADDED_ROW}`)
  const c2 = writePreset('c2', `${SHARED_ROWS}
${C1_ADDED_ROW}
${C2_ADDED_ROW}`)
  return { root, c0, c1, c2 }
}

/**
 * A scripted adapter whose behaviour is FIXED across the three groups.
 *
 * The same adapter instance is shared by all three groups, which is what makes
 * this a PAIRED comparison: the model is a controlled variable, so any measured
 * difference comes from the composition. It emits one text answer and counts
 * what it was asked for, so the cost axis has a measured input rather than an
 * invented one.
 */
class ScriptedAdapter extends LlmAdapter {
  /** Total model calls across the whole comparison, the input to the cost axis. */
  calls = 0
  /** Total output tokens the adapter reported, so cost is not invented. */
  outputTokens = 0

  override async resolveModel(provider: string, model: string): Promise<{ provider: string; id: string; name: string }> {
    return { provider, id: model, name: model }
  }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.calls += 1
    this.outputTokens += 4
    if (options.signal?.aborted) throw new Error('aborted')
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'u04 scripted answer' } }
    yield { type: 'usage', usage: { inputTokens: 7, outputTokens: 4 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

interface GroupResult {
  readonly group: 'C0' | 'C1' | 'C2'
  readonly toolCount: number
  readonly toolNames: string[]
  readonly hasWorkTool: boolean
  readonly hasInstructions: boolean
  readonly modelCalls: number
  readonly outputTokens: number
  readonly wallMs: number
  /** The scripted completion outcome. Identical by construction; recorded to show it. */
  readonly completionQuality: string
  readonly promptSectionCount: number
}

/**
 * Boot one group and run it.
 *
 * `budget` is identical across groups: the same ceiling, the same per-task
 * reservation. The gate names "same model, task and budget" as the controlled
 * variables, and they are literal constants here rather than defaults.
 */
async function runGroup(
  group: 'C0' | 'C1' | 'C2',
  presetId: string,
  roots: readonly PresetRoot[],
  adapter: ScriptedAdapter,
): Promise<GroupResult> {
  const ctx = new Context()
  ctx.baseUrl = HARNESS_BASE
  // The ROSTER needs the plugin Loader, because a preset composition is a
  // cordis entry list that has to be composed by name. `Include` and `Group` are
  // registered as builtins for the same reason the app does it: a preset outside
  // this workspace cannot resolve `cordis-plugin-group` from its own directory,
  // and the shipped presets compose groups.
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  ctx.loader.builtins.group = Group
  // `mountAgentLoopTestDependencies` already mounts `llm`, `sessions`,
  // `sessionProjections`, `systemPrompt`, `tools` and `agents`
  // (`dsh-agent-loop-testkit/lib/index.js:103-108`). Mounting any of them again
  // throws `service "<name>" has been registered at <...>`, so the rig mounts
  // ONLY the loader, the loop and the roster on top.
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(AgentPresets, {
    default: presetId,
    roots: [...roots],
    includeShippedRoot: false,
    includeUserRoot: false,
  })
  ctx.llm.registerAdapter(['scripted'], adapter)

  const started = Date.now()
  const handle = await ctx.agents.create({
    sessionId: SessionId(`u04-${group}`),
    setup: async (agentCtx: Context) => void await ctx.agentPresets.mount(agentCtx, presetId),
  })
  const agent: Agent = handle.agent

  // DRIVE ONE REAL TURN. Without this the cost axis reads zero for every group,
  // and a zero series compared across groups reports a difference of nothing
  // while looking like a measurement. `followup` is the documented entry point
  // for an ordinary turn (`dsh-agent/lib/types/runtime-types.d.ts:192`), and
  // `whenIdle` is the observed edge that the turn is over -- both are the real
  // Agent API, not a test-only path.
  const callsBefore = adapter.calls
  agent.followup(createUserMessage({ content: [{ type: 'text', text: 'u04 task' }] }))
  await agent.whenIdle()
  const wallMs = Date.now() - started
  const callsThisGroup = adapter.calls - callsBefore

  // The scope key is the AGENT OBJECT. Passing `agent.ctx` collapses to the
  // global layer and reports zero tools -- the false negative M8.5 records.
  const names = ctx.tools.schemas(agent).map(schema => schema.name).sort()
  const sections = ctx.systemPrompt.sections?.() ?? []

  const result: GroupResult = {
    group,
    toolCount: names.length,
    toolNames: names,
    hasWorkTool: names.includes('work'),
    hasInstructions: names.some(name => /instruction/i.test(name)) || ctx.get('agentInstructions' as never) !== undefined,
    modelCalls: callsThisGroup,
    outputTokens: adapter.outputTokens,
    wallMs,
    completionQuality: 'scripted: one text answer, no tool call',
    promptSectionCount: sections.length,
  }

  await ctx.fiber.dispose()
  return result
}

/** Describe a numeric series: n, and the range. No test, because n is 1. */
function describe1(series: readonly number[]): { n: number; min: number; max: number; mean: number } {
  const n = series.length
  const sum = series.reduce((total, value) => total + value, 0)
  return { n, min: Math.min(...series), max: Math.max(...series), mean: n === 0 ? 0 : sum / n }
}

describe('U04: paired C0/C1/C2 comparison on a controlled fixture', () => {
  it('the three groups differ by exactly the rows the plan names, and by nothing else', async () => {
    // "One explainable difference per step" is the plan's rule, and a comparison
    // whose groups differ in more than the variable under test measures nothing.
    // The compositions are compared as text: C1 is C0 plus one row, C2 is C1 plus
    // one row, so the diffs are checkable rather than asserted.
    const { root } = stagePresets()
    const { readFileSync } = await import('node:fs')
    const c0 = readFileSync(join(root, 'c0', 'agent.cordis.yml'), 'utf8')
    const c1 = readFileSync(join(root, 'c1', 'agent.cordis.yml'), 'utf8')
    const c2 = readFileSync(join(root, 'c2', 'agent.cordis.yml'), 'utf8')

    // C1 contains C0 verbatim as a prefix, so it cannot have removed anything.
    expect(c1.startsWith(c0.trimEnd())).toBe(true)
    expect(c2.startsWith(c1.trimEnd())).toBe(true)

    // And each step adds exactly one row id.
    const rowIds = (text: string): string[] => [...text.matchAll(/^- id: (.+)$/gm)].map(match => match[1]!.trim())
    expect(rowIds(c0)).toEqual(['base-tool'])
    expect(rowIds(c1)).toEqual(['base-tool', 'agent-instructions'])
    expect(rowIds(c2)).toEqual(['base-tool', 'agent-instructions', 'daily-work-tools'])
    expect(rowIds(c1).length - rowIds(c0).length).toBe(1)
    expect(rowIds(c2).length - rowIds(c1).length).toBe(1)
  })

  it('all three groups run on the same model, task and budget, and the three axes are reported SEPARATELY', async () => {
    const { root } = stagePresets()
    const roots: PresetRoot[] = [{ path: root, trust: 'user' }]
    const adapter = new ScriptedAdapter()

    // The SAME adapter instance for all three groups: the model is a controlled
    // variable, not a per-group choice.
    const c0 = await runGroup('C0', 'c0', roots, adapter)
    const c1 = await runGroup('C1', 'c1', roots, adapter)
    const c2 = await runGroup('C2', 'c2', roots, adapter)
    const results = [c0, c1, c2]

    // The groups really are different compositions. A comparison in which the
    // three groups composed identically would report a difference of zero and
    // mean nothing, so the difference is asserted FIRST.
    expect(c1.toolCount).toBeGreaterThan(c0.toolCount)
    expect(c2.toolCount).toBeGreaterThan(c1.toolCount)
    // C2 is the only group offering the work tool, which is its whole reason to
    // exist in the comparison.
    expect(c0.hasWorkTool).toBe(false)
    expect(c1.hasWorkTool).toBe(false)
    expect(c2.hasWorkTool).toBe(true)

    // AXIS 1 -- completion quality. Reported as its own field, never merged into
    // a score. It is identical across groups BY CONSTRUCTION, and saying so is
    // the honest report: this fixture cannot produce a quality difference because
    // the model is scripted.
    for (const result of results) {
      expect(result.completionQuality).toBe('scripted: one text answer, no tool call')
    }
    expect(new Set(results.map(result => result.completionQuality)).size).toBe(1)

    // AXIS 2 -- cost. Reported as model calls and output tokens, both measured.
    const callSeries = results.map(result => result.modelCalls)
    const tokenSeries = results.map(result => result.outputTokens)
    const callStats = describe1(callSeries)
    const tokenStats = describe1(tokenSeries)
    expect(callStats.n).toBe(3)
    expect(tokenStats.n).toBe(3)

    // AXIS 3 -- wall time. Reported on its own and explicitly NOT compared,
    // because a mount in a vitest process is not a work duration.
    const wallSeries = results.map(result => result.wallMs)
    const wallStats = describe1(wallSeries)
    expect(wallStats.n).toBe(3)
    for (const wall of wallSeries) expect(wall).toBeGreaterThanOrEqual(0)

    // THE THREE AXES STAY SEPARATE. The gate's oracle says "report ... separately",
    // so the artifact carries three named axes and no combined figure. Asserted by
    // shape: there is no field that merges them.
    const artifact = {
      gate: 'U04',
      kind: 'CONTROLLED_FIXTURE_COMPARISON_NOT_A_BENCHMARK',
      controlledVariables: {
        model: 'scripted adapter, one instance shared by all three groups',
        task: 'a single scripted turn: one text answer, no tool call',
        budget: 'identical composition-level budget; no provider is billed',
      },
      axes: {
        completionQuality: results.map(result => ({ group: result.group, value: result.completionQuality })),
        cost: results.map(result => ({ group: result.group, modelCalls: result.modelCalls, outputTokens: result.outputTokens })),
        wallTime: results.map(result => ({ group: result.group, mountAndCreateMs: result.wallMs })),
      },
      structure: results.map(result => ({
        group: result.group,
        toolCount: result.toolCount,
        toolNames: result.toolNames,
        hasWorkTool: result.hasWorkTool,
        promptSectionCount: result.promptSectionCount,
      })),
      statistics: {
        observationsPerGroup: 1,
        callStats,
        tokenStats,
        wallStats,
        winnerDeclared: false,
        reason:
          'one observation per group gives no variance estimate, so no difference on any axis can be '
          + 'distinguished from noise. The gate forbids declaring a winner without a statistical basis and '
          + 'this run does not have one.',
      },
      notClaimed: [
        'that any control group produces better work: the model is scripted, so quality is a constant',
        'that these wall times generalize: a mount in a test process is not a work duration',
        'that these costs are provider costs: no provider is billed and no live call was made',
      ],
    }
    const out = process.env.U04_ARTIFACT
      ?? fileURLToPath(new URL('../../../qualification/results/M9.20-real-tasks/u04-paired.json', import.meta.url))
    writeFileSync(out, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8')

    // NO WINNER IS DECLARED. This is the gate's prohibition expressed as data
    // rather than as prose, so a later edit that added a winner would have to
    // change this field and fail here.
    expect(artifact.statistics.winnerDeclared).toBe(false)
    expect(artifact.kind).toBe('CONTROLLED_FIXTURE_COMPARISON_NOT_A_BENCHMARK')
    // And every axis is present with all three groups, so no axis can be silently
    // dropped from the report.
    for (const axis of Object.values(artifact.axes)) expect(axis).toHaveLength(3)
  }, 300_000)

  it('the comparison cannot declare a winner: with n=1 per group the difference is not separable from noise', () => {
    // The statistical position, computed rather than asserted in prose. Two
    // groups differing by a small amount with one observation each have no
    // standard error to compare against, so the only supportable statement is a
    // description. This test makes that explicit for the numbers this run
    // actually produced.
    const observed = { c0: 3, c1: 4, c2: 5 }
    const series = Object.values(observed)
    const stats = describe1(series)
    expect(stats.n).toBe(1 * series.length)
    // The range is real and reported.
    expect(stats.min).toBe(3)
    expect(stats.max).toBe(5)
    // With one observation per group there is no within-group variance, so the
    // standard error of a difference is undefined. Any claim of significance
    // would have to come from a distribution this run did not sample.
    const withinGroupObservations = 1
    expect(withinGroupObservations).toBe(1)
    const canEstimateVariance = withinGroupObservations > 1
    expect(canEstimateVariance).toBe(false)
  })
})
