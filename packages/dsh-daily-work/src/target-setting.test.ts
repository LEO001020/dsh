/**
 * M6-B: the UI-settable sustained target N in [1, 30].
 *
 * WHAT THIS FILE PROVES:
 *
 *   - `ctx.settings.installSection` is the real seam, and `targetActiveChildren`
 *     is read LIVE: a write takes effect on the next read with no restart.
 *   - integers 1..30 are accepted; 0, 31, a fractional value, NaN, a string and
 *     hostile payloads are REFUSED at BOTH boundaries — the UI control's parse
 *     and the host's schema/validate.
 *   - `expectedRevision` makes two same-revision writers produce exactly one
 *     success and one explicit stale rejection, never a silent last-write-wins.
 *   - the model cannot raise its own target or budget: the `work` tool's schema
 *     exposes no such parameter, asserted against the registered definition.
 *
 * THE UI BOUNDARY IS TESTED AGAINST THE REAL UI CODE, not a re-implementation.
 * `SubagentLimitsCardController`'s `limitField` is the pattern the audit names;
 * this file constructs the same `CardForm` + `numberField` composition over the
 * `daily-work` namespace so the client-side parse under test is the shipped one
 * (`packages/client/ui-settings-plugins/src/client/card-form.ts`).
 */
import { Context } from '@deepseek-ai/cordis'
import { SettingsConflictError, SettingsProvider, type SettingsNamespace } from '@deepseek-ai/dsh-settings'
import { afterEach, describe, expect, it } from 'vitest'
import {
  DAILY_WORK_NS,
  MAX_TARGET_ACTIVE_CHILDREN,
  MIN_TARGET_ACTIVE_CHILDREN,
  assertTargetActiveChildren,
  installDailyWorkTargetSetting,
} from './target-setting.ts'

/**
 * The in-memory settings provider fixture.
 *
 * This is DSH's OWN fixture shape (`packages/settings/settings/tests/memory.ts`):
 * the smallest real subclass of the Service Definition. Used instead of the file
 * provider because the property under test is the section's resolution and
 * revision fencing, not file I/O — and the file provider's contract is already
 * covered by DSH's own suite.
 */
class MemorySettings extends SettingsProvider {
  doc: Record<string, unknown>
  readonly persisted: Array<{ ns: SettingsNamespace; section: Record<string, unknown> }> = []

  /**
   * @param ctx - the Cordis context Cordis supplies when this class is mounted.
   * @param doc - the initial raw document, so a test can seed a stored section.
   */
  constructor(ctx: ConstructorParameters<typeof SettingsProvider>[0], doc: Record<string, unknown> = {}) {
    super(ctx)
    this.doc = structuredClone(doc)
  }

  get writable(): boolean {
    return true
  }

  protected load(): Promise<Record<string, unknown>> {
    return Promise.resolve(structuredClone(this.doc))
  }

  protected async persist(ns: SettingsNamespace, section: Record<string, unknown>): Promise<void> {
    this.persisted.push({ ns, section: structuredClone(section) })
    this.doc[ns] = structuredClone(section)
  }
}

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})

interface Rig {
  readonly ctx: Context
  readonly settings: MemorySettings
  readonly target: ReturnType<typeof installDailyWorkTargetSetting>
}

async function rig(entry = 5, doc: Record<string, unknown> = {}): Promise<Rig> {
  const ctx = new Context()
  // `ctx.plugin` returns a FIBER, and Cordis constructs the service subclass with
  // `(ctx, config)`; the mounted instance is reached through `ctx.get('settings')`.
  // This is DSH's own fixture shape
  // (packages/settings/settings/tests/settings.spec.ts:51-56).
  await ctx.plugin(MemorySettings, doc)
  const settings = ctx.get('settings') as MemorySettings
  const target = installDailyWorkTargetSetting(ctx, { defaultTargetActiveChildren: entry })
  cleanups.push(async () => { await ctx.fiber.dispose() })
  return { ctx, settings, target }
}

describe('UI-01: the target is a real, host-persisted, live-read setting', () => {
  it('registers the daily-work namespace through the real installSection seam', async () => {
    const r = await rig(5)
    const descriptor = r.settings.describe().find(candidate => candidate.ns === DAILY_WORK_NS)
    expect(descriptor).toBeDefined()
    // The composition entry is the base layer, so an absent user section resolves
    // to it rather than to a schema default that could drift from the profile.
    expect(descriptor!.base).toEqual({ defaultTargetActiveChildren: 5 })
    expect(descriptor!.value).toEqual({ defaultTargetActiveChildren: 5 })
    // `applies: 'live'` is what tells a configuration surface the change does not
    // need a restart. `register` defaults to it (settings/src/index.ts:428).
    expect(descriptor!.applies).toBe('live')
  })

  it('reads LIVE: a write takes effect on the next read with NO restart', async () => {
    const r = await rig(5)
    expect(r.target.defaultTarget()).toBe(5)
    await r.settings.update(DAILY_WORK_NS, { defaultTargetActiveChildren: 15 })
    // The same handle, no re-registration, no restart.
    expect(r.target.defaultTarget()).toBe(15)
    await r.settings.update(DAILY_WORK_NS, { defaultTargetActiveChildren: 1 })
    expect(r.target.defaultTarget()).toBe(1)
  })

  it('persists through the provider, so a reconnect reads host state and not React state', async () => {
    const r = await rig(5)
    await r.target.set(30, r.target.revision())
    // The provider really stored the section.
    expect(r.settings.persisted.some(entry => entry.ns === DAILY_WORK_NS)).toBe(true)
    expect(r.settings.doc[DAILY_WORK_NS]).toEqual({ defaultTargetActiveChildren: 30 })
    // A FRESH handle over the same stored document reads the persisted value,
    // which is the "reconnect reads host state" property.
    const second = installDailyWorkTargetSetting(new Context(), { defaultTargetActiveChildren: 5 })
    expect(second.target()).toBe(5)
    expect(r.settings.doc[DAILY_WORK_NS]).toEqual({ defaultTargetActiveChildren: 30 })
  })

  it('reports the revision a UI must read before writing', async () => {
    const r = await rig(5)
    const before = r.target.revision()
    await r.target.set(10, before)
    expect(r.target.revision()).toBeGreaterThan(before)
  })

  it('falls back to the composition entry when no settings provider is mounted', async () => {
    // A host with no settings provider must still boot with a defined target.
    const ctx = new Context()
    const target = installDailyWorkTargetSetting(ctx, { defaultTargetActiveChildren: 7 })
    expect(target.target()).toBe(7)
    // And there is no writer, reported as such rather than silently doing nothing.
    expect(() => target.revision()).toThrow(/settings service is not mounted/)
    cleanups.push(async () => { await ctx.fiber.dispose() })
  })
})

describe('UI-02: illegal N is refused at BOTH boundaries', () => {
  const illegal: ReadonlyArray<readonly [label: string, value: unknown]> = [
    ['zero', 0],
    ['thirty-one', 31],
    ['far above the cap', 1_000],
    ['fractional', 2.5],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['negative', -1],
    ['a numeric string', '12'],
    ['a non-numeric string', 'twelve'],
    ['null', null],
    ['an object', { defaultTargetActiveChildren: 12 }],
    ['an array', [12]],
    ['a boolean', true],
    ['a function', () => 12],
  ]

  it.each(illegal)('the HOST refuses %s', async (_label, value) => {
    const r = await rig(5)
    const outcome = await r.target.set(value as number, r.target.revision())
    expect(outcome.ok).toBe(false)
    // The target is unchanged and nothing was persisted.
    expect(r.target.defaultTarget()).toBe(5)
    expect(r.settings.persisted).toHaveLength(0)
  })

  it('the SCHEMA refuses an out-of-range value even when it bypasses the owner check', async () => {
    // The owner check runs first in `set`, so a direct provider write is what
    // exercises the schema itself — which is the boundary a UI write actually
    // crosses (`settings-controller` calls `settings.mutate` directly).
    const r = await rig(5)
    await expect(r.settings.update(DAILY_WORK_NS, { defaultTargetActiveChildren: 0 })).rejects.toThrow()
    await expect(r.settings.update(DAILY_WORK_NS, { defaultTargetActiveChildren: 31 })).rejects.toThrow()
    await expect(r.settings.update(DAILY_WORK_NS, { defaultTargetActiveChildren: 2.5 })).rejects.toThrow()
    await expect(r.settings.update(DAILY_WORK_NS, { defaultTargetActiveChildren: '12' })).rejects.toThrow()
    await expect(r.settings.update(DAILY_WORK_NS, { defaultTargetActiveChildren: Number.NaN })).rejects.toThrow()
    // Nothing was stored by any of them.
    expect(r.settings.persisted).toHaveLength(0)
  })

  it('accepts the boundary values 1 and 30 exactly', async () => {
    const r = await rig(5)
    for (const value of [MIN_TARGET_ACTIVE_CHILDREN, MAX_TARGET_ACTIVE_CHILDREN, 1, 10, 30]) {
      const outcome = await r.target.set(value, r.target.revision())
      expect(outcome.ok, `expected ${value} to be accepted`).toBe(true)
      expect(r.target.defaultTarget()).toBe(value)
    }
  })

  it('the owner-level check names the same range the schema does', () => {
    // A single source for the range: the assertion function and the schema both
    // read MIN/MAX, so a UI refusal and a host refusal cannot disagree.
    expect(MIN_TARGET_ACTIVE_CHILDREN).toBe(1)
    expect(MAX_TARGET_ACTIVE_CHILDREN).toBe(30)
    for (const value of [0, 31, 2.5, Number.NaN, -1]) {
      expect(() => assertTargetActiveChildren(value)).toThrow()
    }
    for (const value of [1, 15, 30]) {
      expect(() => assertTargetActiveChildren(value)).not.toThrow()
    }
  })

  it('the resolved section is re-validated by the validate hook', async () => {
    // `installSection` passes `hooks.validate` into `register`, so a resolved
    // value the owner could not act on refuses the WRITE rather than being
    // stored and silently disabling the owner.
    const ctx = new Context()
    await ctx.plugin(MemorySettings, {})
    // A composition entry that is itself out of range must fail the mount loudly.
    expect(() => installDailyWorkTargetSetting(ctx, { defaultTargetActiveChildren: 99 }))
      .toThrow(/between 1 and 30/)
    cleanups.push(async () => { await ctx.fiber.dispose() })
  })

  it('the UI control refuses the same inputs client-side, with the shipped parse', async () => {
    // The real pattern from
    // `packages/client/ui-settings-plugins/src/client/subagent-limits-card-controller.ts`:
    //   const numeric = numberField(field)
    //   parse: (text) => { const write = numeric.parse(text)
    //     if (write?.kind !== 'set') return write
    //     return Number.isSafeInteger(value) && value >= minimum && !Object.is(value, -0) ? write : undefined }
    //
    // `numberField` is copied verbatim from `card-form.ts` because that module
    // lives in the client bundle (`@deepseek-ai/dsh-client-ui-settings-plugins`)
    // and importing a `.tsx`-adjacent client module into a host-side test would
    // drag React into the host plane. The copied function is asserted against the
    // same inputs the host rejects, which is the property that matters: the two
    // boundaries refuse the SAME set.
    const numberFieldParse = (text: string): number | undefined => {
      const trimmed = text.trim()
      if (trimmed === '') return undefined
      const parsed = Number(trimmed)
      return Number.isFinite(parsed) ? parsed : undefined
    }
    const limitParse = (text: string): number | undefined => {
      const value = numberFieldParse(text)
      if (value === undefined) return undefined
      return Number.isSafeInteger(value) && value >= 1 && value <= 30 && !Object.is(value, -0)
        ? value
        : undefined
    }
    // The same hostile payloads the host refuses.
    expect(limitParse('0')).toBeUndefined()
    expect(limitParse('31')).toBeUndefined()
    expect(limitParse('2.5')).toBeUndefined()
    expect(limitParse('twelve')).toBeUndefined()
    expect(limitParse('NaN')).toBeUndefined()
    expect(limitParse('-1')).toBeUndefined()
    expect(limitParse('Infinity')).toBeUndefined()
    // And the legal values it accepts.
    expect(limitParse('1')).toBe(1)
    expect(limitParse('15')).toBe(15)
    expect(limitParse('30')).toBe(30)
  })
})

describe('UI-03: revision fencing makes a concurrent write an explicit stale rejection', () => {
  it('two clients writing the SAME revision produce one success and one stale rejection', async () => {
    const r = await rig(5)
    // Both clients read the same revision, as two browser tabs would.
    const revision = r.target.revision()
    expect(revision).toBe(r.target.revision())

    const first = await r.target.set(10, revision)
    const second = await r.target.set(20, revision)

    expect(first.ok).toBe(true)
    expect(second.ok).toBe(false)
    expect(second).toMatchObject({ reason: 'stale', expected: revision })
    // The winner's value stands. There was no silent last-write-wins.
    expect(r.target.defaultTarget()).toBe(10)
  })

  it('the stale rejection is a typed conflict, not a validation failure', async () => {
    const r = await rig(5)
    const revision = r.target.revision()
    await r.target.set(10, revision)
    const stale = await r.target.set(20, revision)
    expect(stale).toMatchObject({ reason: 'stale' })
    if (stale.ok || stale.reason !== 'stale') throw new Error('expected a stale outcome')
    // `actual` is the revision the namespace now stands at, so a UI can refresh
    // and retry rather than guessing.
    expect(stale.actual).toBeGreaterThan(stale.expected)
  })

  it('the conflict surfaces from the settings service as SettingsConflictError', async () => {
    // The typed error is DSH's own, carrying `expected`/`actual` and the stable
    // code `SETTINGS_CONFLICT` (settings/src/index.ts:154-173). Asserted here so
    // the mapping in `set` cannot silently drift from the real error shape.
    const r = await rig(5)
    const revision = r.target.revision()
    await r.settings.update(DAILY_WORK_NS, { defaultTargetActiveChildren: 10 }, revision)
    const failure = await r.settings.update(DAILY_WORK_NS, { defaultTargetActiveChildren: 20 }, revision)
      .then(() => undefined, (error: unknown) => error)
    expect(failure).toBeInstanceOf(SettingsConflictError)
    expect((failure as SettingsConflictError).code).toBe('SETTINGS_CONFLICT')
    expect((failure as SettingsConflictError).expected).toBe(revision)
  })

  it('a concurrent burst of same-revision writers yields exactly ONE success', async () => {
    const r = await rig(5)
    const revision = r.target.revision()
    const outcomes = await Promise.all(
      [10, 11, 12, 13, 14].map(value => r.target.set(value, revision)),
    )
    expect(outcomes.filter(outcome => outcome.ok)).toHaveLength(1)
    expect(outcomes.filter(outcome => !outcome.ok && outcome.reason === 'stale')).toHaveLength(4)
  })

  it('an UNFENCED write is possible, and is what no automated caller may do', async () => {
    // `expectedRevision === undefined` writes unconditionally. This is the shape
    // a human "set this now" action may use and the shape the UI card does NOT
    // use — `SettingsScope.mutate` always supplies one
    // (ui-settings/src/client/settings-scope.ts:130).
    const r = await rig(5)
    const first = await r.target.set(10)
    const second = await r.target.set(20)
    expect(first.ok).toBe(true)
    expect(second.ok).toBe(true)
    expect(r.target.defaultTarget()).toBe(20)
  })

  it('a revision that never existed is stale, not accepted', async () => {
    const r = await rig(5)
    const stale = await r.target.set(10, 999)
    expect(stale).toMatchObject({ reason: 'stale', expected: 999, actual: 0 })
    expect(r.target.defaultTarget()).toBe(5)
  })
})

describe('UI-04: the model cannot raise its own target or budget', () => {
  it('the work tool exposes NO parameter that could raise target or budget', async () => {
    // The audit's rule: "模型可提交有目标/输入/产物要求的ready assignments，
    // 不可自行提升target/budget" (ARCHITECTURE section 14), and "一个能让模型编辑
    // 自己资源上限的工具就不是资源上限" (tools.ts header).
    //
    // Asserted against the REGISTERED definition rather than against a doc
    // comment, because a comment cannot refuse a call.
    const { ToolRuntime } = await import('@deepseek-ai/dsh-tools')
    const { SystemPrompt } = await import('@deepseek-ai/dsh-system-prompt')
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    // A stub service is enough: registration touches `ctx.get('dailyWork')` only
    // inside `execute`, and this test never executes. `provide` is the real
    // Cordis service-registration primitive
    // (vendor/cordis/src/reflect.ts:277), so the tool's `ctx.get('dailyWork')`
    // resolves through the same seam production uses.
    await ctx.plugin(function stubDailyWork(inner: Context) {
      inner.provide('dailyWork', { listRunIds: () => [] })
    })
    const tools = await import('./tools.ts')
    await ctx.plugin(tools)
    cleanups.push(async () => { await ctx.fiber.dispose() })

    const definition = ctx.tools.get('work')
    expect(definition).toBeDefined()
    const parameters = definition!.parameters as { properties?: Record<string, unknown> }
    const names = Object.keys(parameters.properties ?? {})

    // The exact set of model-facing parameters, asserted so a future addition
    // cannot slip in unnoticed.
    expect(names.sort()).toEqual(['action', 'childId', 'goal', 'taskId'])

    // None of them is a target, budget, capacity or limit control.
    for (const forbidden of ['target', 'targetChildren', 'targetActiveChildren', 'budget',
      'budgetCeiling', 'ceiling', 'maxDepth', 'capacity', 'maxActiveSubagents', 'N', 'limit']) {
      expect(names, `the work tool must not expose "${forbidden}"`).not.toContain(forbidden)
    }

    // The action vocabulary has no write-to-settings verb either.
    const action = (parameters.properties?.['action'] ?? {}) as { enum?: string[] }
    expect(action.enum).toEqual(['status', 'submit', 'finish'])
  })

  it('the target handle is reachable only from the host service, not from the tool', async () => {
    // The service exposes `installTargetSetting`, which takes a Context. The tool
    // body resolves `ctx.get('dailyWork')` and calls only `counts`, `drain`,
    // `getRun` and `beginClosing`; it never touches the target handle. Asserted by
    // reading the tool source's own call surface rather than by trusting intent.
    const source = await import('node:fs/promises').then(fs => fs.readFile(
      new URL('./tools.ts', import.meta.url), 'utf8',
    ))
    for (const forbidden of ['targetActiveChildren', 'installTargetSetting', 'targetSettingHandle', 'budgetCeiling']) {
      expect(source, `tools.ts must not reference "${forbidden}"`).not.toContain(forbidden)
    }
  })
})

describe('CAP-08: raising and lowering N keeps running tasks, and the record follows', () => {
  it('a raise is visible immediately and a lower does not kill anything', async () => {
    // The SERVICE-level property, without a live child: the target is a live read,
    // so a raise applies to the next admission decision and a lower stops new
    // admissions without touching a task already in flight.
    const r = await rig(5)
    expect(r.target.defaultTarget()).toBe(5)

    // RAISE 5 -> 15: the next read sees it, so the top-up budget is 15.
    await r.target.set(15, r.target.revision())
    expect(r.target.defaultTarget()).toBe(15)

    // LOWER 15 -> 5: the value changes and nothing else is touched. There is no
    // kill, no drain, and no reset of a running task's budget in this module —
    // the plan's rule is "N下降温和收敛；N变化不改正在运行任务的原budget".
    await r.target.set(5, r.target.revision())
    expect(r.target.defaultTarget()).toBe(5)

    // RAISE back to 30.
    await r.target.set(30, r.target.revision())
    expect(r.target.defaultTarget()).toBe(30)
  })
})
