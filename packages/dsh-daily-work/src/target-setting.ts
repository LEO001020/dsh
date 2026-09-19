/**
 * The UI-settable sustained child target `targetActiveChildren` in [1, 30].
 *
 * WHY A SETTINGS SECTION AND NOT A CONFIG KEY. `targetChildren` in
 * `WorkServiceConfig` and in `cordis.patch.yml` is a composition value: changing
 * it needs a restart, and the user has no control surface. The audit requires
 * "targetActiveChildren 只由UI经authenticated Remote改，带expectedRevision"
 * (ARCHITECTURE.zh-CN.md section 14) — a live, revision-fenced, host-persisted
 * value.
 *
 * THE REAL SEAM, quoted from source. `SettingsProvider.installSection`
 * (`packages/settings/settings/src/index.ts:472`):
 *
 *   installSection<const Namespace extends string, T>(
 *     owner: Context,
 *     ns: Namespace & SettingsNamespaceInput<Namespace>,
 *     schema: z<T>,
 *     entry: T,
 *     hooks: SettingsSectionHooks<T>,
 *   ): void
 *
 * The shape copied here is `SubagentRuntime`'s
 * (`packages/subagent/subagent/src/index.ts:214-230`): a `settingsSource:
 * () => Config` field initialised to the composition value, `ctx.inject(
 * ['settings'], ...)` installing the section with `setSource` replacing that
 * thunk, and EVERY read going through the thunk. That is what makes a change
 * take effect without a restart: `setSource` hands over a live reader of the
 * resolved section, and `onChange` re-judges derived facts.
 *
 * VALIDATION AT BOTH BOUNDARIES. The schema rejects a non-integer, an
 * out-of-range value, a string, NaN and a fractional number, and the section's
 * `validate` hook re-states the range so a resolved value the owner could not
 * act on refuses the WRITE rather than silently disabling the owner
 * (`SettingsRegisterOptions.validate`, index.ts:68-81). The host reads the
 * validated section; the UI's own control (`SubagentLimitsCardController`'s
 * `limitField`) rejects the same inputs client-side so the user sees the refusal
 * without a round trip. Both boundaries are tested.
 *
 * REVISION FENCING. `SettingsProvider.update(ns, patch, expectedRevision)`
 * (`index.ts:562`) checks the revision INSIDE the serialized write queue
 * (`index.ts:668`) and throws `SettingsConflictError` (`index.ts:154`,
 * `code: 'SETTINGS_CONFLICT'`, carrying `expected` and `actual`). Two clients
 * writing the same revision therefore produce exactly one success and one
 * explicit stale rejection — never a silent last-write-wins. This module does
 * not re-implement that; it exposes the fenced write and reports the conflict
 * as its own typed outcome so a caller cannot confuse it with a validation
 * failure.
 *
 * @module target-setting
 */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { SettingsProvider } from '@deepseek-ai/dsh-settings'
import { SettingsConflictError } from '@deepseek-ai/dsh-settings'
import { HARD_CHILD_CAPACITY } from './capacity.ts'

/**
 * The settings namespace this project owns.
 *
 * Deliberately NOT `subagent`. That namespace belongs to `SubagentRuntime`,
 * whose `maxActiveSubagents` is a per-family continuable pool bound — a
 * different quantity from this deployment's sustained host target. Sharing one
 * namespace would put two owners on one document section and would let the
 * control that edits `maxActiveSubagents` appear to edit the hard cap.
 */
export const DAILY_WORK_NS = 'daily-work'

/** The lower bound of the sustained target. `0` is refused, not clamped. */
export const MIN_TARGET_ACTIVE_CHILDREN = 1

/** The upper bound of the sustained target. `31` is refused, not clamped. */
export const MAX_TARGET_ACTIVE_CHILDREN = HARD_CHILD_CAPACITY

/**
 * The section schema.
 *
 * `.step(1)` is what rejects a fractional value: Schemastery's number resolver
 * checks `isMultipleOf(data, meta.min ?? 0, step)`
 * (`schemastery/src/index.ts:643`) and throws
 * `expected number multiple of 1 but got 2.5`. `.min(1).max(30)` rejects 0 and
 * 31. A string, NaN and `Infinity` are rejected by the `typeof data !== 'number'`
 * arm at :640 and by `checkWithinRange` at :604 — `Infinity > 30` is true, so it
 * throws rather than being admitted.
 *
 * `.required()` is NOT set, and the composition entry supplies the default: an
 * absent user section must resolve to the composition value rather than to a
 * schema default that could drift from `cordis.patch.yml`.
 */
export const DailyWorkConfig: z<{ targetActiveChildren: number }> = z.object({
  targetActiveChildren: z.number().step(1)
    .min(MIN_TARGET_ACTIVE_CHILDREN)
    .max(MAX_TARGET_ACTIVE_CHILDREN),
})

/** The resolved section, as the owner reads it. */
export interface DailyWorkSettings {
  readonly targetActiveChildren: number
}

/**
 * Reject a resolved section this owner could not act on.
 *
 * This restates the schema's range on purpose. The schema is also what a
 * configuration surface renders and what an absent section resolves through, so
 * folding an owner-level check into it would change both. Keeping it here means
 * a stored section that fails refuses the write that produced it
 * (`installSection` passes `hooks.validate` into `register`, index.ts:481-483).
 */
export function assertTargetActiveChildren(value: number): void {
  if (!Number.isSafeInteger(value)) {
    throw new TypeError(
      `daily-work targetActiveChildren must be a whole number; got ${String(value)}. A fractional or `
      + 'non-numeric target would make the top-up arithmetic non-integral, which is not a target.',
    )
  }
  if (Object.is(value, -0)) {
    throw new TypeError('daily-work targetActiveChildren must not be negative zero')
  }
  if (value < MIN_TARGET_ACTIVE_CHILDREN || value > MAX_TARGET_ACTIVE_CHILDREN) {
    throw new TypeError(
      `daily-work targetActiveChildren must be between ${MIN_TARGET_ACTIVE_CHILDREN} and `
      + `${MAX_TARGET_ACTIVE_CHILDREN}; got ${value}. ${MAX_TARGET_ACTIVE_CHILDREN} is the deployment's hard `
      + 'child capacity, so a larger target is not a bigger budget — it is a refusal.',
    )
  }
}

/** What a fenced write did. */
export type TargetWriteOutcome =
  | { readonly ok: true; readonly target: number; readonly revision: number }
  /** Another writer moved the namespace past the caller's revision. */
  | { readonly ok: false; readonly reason: 'stale'; readonly expected: number; readonly actual: number }
  /** The value was not a target this owner can act on. */
  | { readonly ok: false; readonly reason: 'invalid'; readonly message: string }

/** The owner's handle: a live reader plus the fenced writer. */
export interface TargetSettingHandle {
  /**
   * The CURRENT target, read live.
   *
   * This is a function, not a captured number, and that is the whole point: a
   * change committed by the UI must take effect on the next read without a
   * restart. It delegates to `settingsSource()`, which `installSection` swaps to
   * the settings scope's reader at attach.
   */
  target(): number
  /** The namespace revision, as a UI must read it before writing. */
  revision(): number
  /**
   * Write a new target, fenced on `expectedRevision`.
   *
   * @param value - the new target; must be a whole number in [1, 30].
   * @param expectedRevision - the revision the caller READ. Omitting it writes
   *   unfenced, which is what an explicit human "set this now" action may do and
   *   what no automated caller may do. The UI's card always passes one.
   */
  set(value: number, expectedRevision?: number): Promise<TargetWriteOutcome>
}

/** The section's `validate` hook runs on the RESOLVED value, so it sees defaults. */
function validateResolved(value: DailyWorkSettings): void {
  assertTargetActiveChildren(value.targetActiveChildren)
}

/**
 * Install the `daily-work` section and return the owner's handle.
 *
 * @param owner - the owner context whose unload suppresses fallback work.
 *   `installSection` uses `isUnloading(owner)` to decide whether losing the
 *   settings PROVIDER should fall back to the composition entry; unloading the
 *   OWNER must not.
 * @param entry - the composition value, used as the base layer and as the
 *   fallback when no settings provider is mounted. Read from host config, never
 *   from a request.
 * @returns the handle. When no settings provider is ever mounted, `target()`
 *   keeps returning `entry` and `set()` reports `invalid`-style failure by
 *   throwing from the provider lookup — a host with no settings service has no
 *   UI, so there is no writer to serve.
 */
export function installDailyWorkTargetSetting(
  owner: Context,
  entry: DailyWorkSettings,
): TargetSettingHandle {
  // Validate the composition entry at mount: a host configured with an
  // out-of-range target must fail loudly at boot rather than refuse every write
  // later with a confusing message.
  assertTargetActiveChildren(entry.targetActiveChildren)
  let settingsSource: () => DailyWorkSettings = () => entry
  owner.inject(['settings'], (settingsCtx) => {
    settingsCtx.settings.installSection(owner, DAILY_WORK_NS, DailyWorkConfig, entry, {
      validate: validateResolved,
      setSource: (source) => { settingsSource = source },
      onChange: () => {},
    })
  })
  const provider = (): SettingsProvider => {
    const settings = owner.get('settings')
    if (settings === undefined) {
      throw new Error(
        `daily-work: the settings service is not mounted, so "${DAILY_WORK_NS}" has no writer. The UI `
        + 'reaches this namespace through the host settings document; without a provider there is no '
        + 'document to write and no revision to fence on.',
      )
    }
    return settings
  }
  const readRevision = (): number => {
    const descriptor = provider().describe({ redactSecrets: true })
      .find(candidate => candidate.ns === DAILY_WORK_NS)
    if (descriptor === undefined) {
      throw new Error(`daily-work: the "${DAILY_WORK_NS}" namespace is not registered`)
    }
    return descriptor.revision
  }
  return {
    target: () => settingsSource().targetActiveChildren,
    revision: readRevision,
    async set(value, expectedRevision) {
      // The owner-level check runs FIRST so a hostile payload gets the same
      // message at the host boundary as at the UI boundary, without depending on
      // the schema's own error text.
      try {
        assertTargetActiveChildren(value)
      } catch (error) {
        return { ok: false, reason: 'invalid', message: error instanceof Error ? error.message : String(error) }
      }
      const settings = provider()
      try {
        await settings.update(DAILY_WORK_NS, { targetActiveChildren: value }, expectedRevision)
      } catch (error) {
        if (error instanceof SettingsConflictError) {
          return { ok: false, reason: 'stale', expected: error.expected, actual: error.actual }
        }
        // A schema or `validate` rejection surfaces as its own error. Reported as
        // `invalid` so a caller cannot mistake a refusal for a conflict.
        return { ok: false, reason: 'invalid', message: error instanceof Error ? error.message : String(error) }
      }
      return { ok: true, target: value, revision: readRevision() }
    },
  }
}
