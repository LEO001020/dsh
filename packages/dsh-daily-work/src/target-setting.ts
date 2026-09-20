/**
 * The DEFAULT sustained child target for NEW runs, in [1, 30].
 *
 * WHY THIS FIELD IS NAMED `defaultTargetActiveChildren` AND NOT
 * `targetActiveChildren`. V5 section 13 measured the defect this rename closes:
 *
 *   "`target-setting.ts` defines global `daily-work.targetActiveChildren`. But
 *   active run admission uses durable `record.requestedTarget`. The setting is
 *   read when a new run is created unless a command supplies N. `onChange` is
 *   empty. Therefore the setting is a default for a future run, not the live
 *   target of an existing run."
 *
 * The old name asserted a relationship the code never had. An operator who
 * changed it while a run was live would reasonably expect the live run to move;
 * nothing did, and nothing said so. V5 section 13 splits the two concepts:
 *
 *   A. this global/user default for NEW runs (revision-fenced, 1..30);
 *   B. `RunRecord.requestedTarget`, run/session scoped, changed ONLY by a
 *      `/work target N` domain operation or the identical domain action invoked
 *      from the UI, persisted in the Work record.
 *
 * The name now says which one this is. The active run's target is reachable
 * through `/work target N` and is NOT reachable from here — this module has no
 * code path that writes a run record, which is what makes that a structural
 * fact rather than a promise.
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
 * WHAT `onChange` IS FOR HERE, and it is deliberately still empty. The hook
 * re-judges facts DERIVED from the source. Nothing in this module derives a fact
 * from the default: the default is read at run creation and nowhere else, so
 * there is nothing to re-judge. The empty body is now a TRUE statement about a
 * default rather than the silent contradiction it was when the field claimed to
 * be a live run target.
 *
 * VALIDATION AT BOTH BOUNDARIES. The schema rejects a non-integer, an
 * out-of-range value, a string, NaN and a fractional number, and the section's
 * `validate` hook re-states the range so a resolved value the owner could not
 * act on refuses the WRITE rather than silently disabling the owner
 * (`SettingsRegisterOptions.validate`, index.ts:68-81). The host reads the
 * validated section; the UI's own control rejects the same inputs client-side so
 * the user sees the refusal without a round trip. Both boundaries are tested.
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

/** The settings field this module owns, named once so a rename cannot half-apply. */
export const DEFAULT_TARGET_FIELD = 'defaultTargetActiveChildren'

/**
 * The pre-split field name, kept ONLY to refuse it by name.
 *
 * V5 section 13 renames the concept. A stored document written under the old
 * name would otherwise be SILENTLY IGNORED, because the schema resolver is
 * non-strict (`vendor/schemastery/src/index.ts:761` runs `merge(result, data)`
 * for any key the schema does not declare — measured: a document
 * `{targetActiveChildren: 12}` resolved to
 * `{"targetActiveChildren":12,"defaultTargetActiveChildren":6}`). A setting that
 * silently does nothing is the exact failure mode this project records most
 * often, so the old key is refused loudly instead.
 *
 * WHY REFUSING IS SAFE HERE, measured rather than assumed: no settings document
 * on this machine contains the `daily-work` namespace at all (`grep -rl
 * '"daily-work"' /d/DSH/home/` matches only profile/lock/package files, never a
 * settings document), so the refusal cannot break an existing deployment. It
 * can only catch a writer that is still using the old name.
 */
export const LEGACY_TARGET_FIELD = 'targetActiveChildren'

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
export const DailyWorkConfig: z<{ defaultTargetActiveChildren: number }> = z.object({
  defaultTargetActiveChildren: z.number().step(1)
    .min(MIN_TARGET_ACTIVE_CHILDREN)
    .max(MAX_TARGET_ACTIVE_CHILDREN),
})

/** The resolved section, as the owner reads it. */
export interface DailyWorkSettings {
  readonly defaultTargetActiveChildren: number
}

/**
 * The pre-split composition entry, accepted so the host call site keeps compiling.
 *
 * WHY THIS EXISTS RATHER THAN A ONE-LINE EDIT IN `host.ts`. `host.ts` is another
 * writer's region this round (P5 owns it), so this module normalizes the old key
 * instead of forcing a cross-region edit. The NAMESPACE field is the new name
 * either way — only the composition entry the host passes is still spelled the
 * old way, and it is normalized before it becomes the section's base layer.
 *
 * REPORTED, NOT FIXED HERE: `host.ts:481` should pass
 * `{ defaultTargetActiveChildren: this.config.targetChildren }`. Until it does,
 * `WorkService.targetActiveChildren()` is a SERVICE method whose name still
 * reads as "the active run's target" when it returns this default. That is a
 * naming defect in the other writer's file and is recorded in the P7 report
 * rather than patched from here.
 */
export interface LegacyDailyWorkSettingsEntry {
  readonly targetActiveChildren: number
}

/** The composition entry a caller may hand this module, in either spelling. */
export type DailyWorkSettingsEntry = DailyWorkSettings | LegacyDailyWorkSettingsEntry

/** Normalize either entry spelling onto the section's own field name. */
function normalizeEntry(entry: DailyWorkSettingsEntry): DailyWorkSettings {
  return LEGACY_TARGET_FIELD in entry
    ? { defaultTargetActiveChildren: entry.targetActiveChildren }
    : { defaultTargetActiveChildren: entry.defaultTargetActiveChildren }
}

/**
 * Reject a resolved section this owner could not act on.
 *
 * This restates the schema's range on purpose. The schema is also what a
 * configuration surface renders and what an absent section resolves through, so
 * folding an owner-level check into it would change both. Keeping it here means
 * a stored section that fails refuses the write that produced it
 * (`installSection` passes `hooks.validate` into `register`, index.ts:481-483).
 *
 * IT ALSO REFUSES THE PRE-SPLIT KEY BY NAME. See {@link LEGACY_TARGET_FIELD}:
 * the schema is non-strict, so a document still using `targetActiveChildren`
 * would resolve with that key carried through untouched and the new field
 * silently taking the composition default. That is a setting that appears to be
 * stored and does nothing, so the validate hook refuses it instead.
 */
export function assertTargetActiveChildren(value: number): void {
  if (!Number.isSafeInteger(value)) {
    throw new TypeError(
      `daily-work ${DEFAULT_TARGET_FIELD} must be a whole number; got ${String(value)}. A fractional or `
      + 'non-numeric target would make the top-up arithmetic non-integral, which is not a target.',
    )
  }
  if (Object.is(value, -0)) {
    throw new TypeError(`daily-work ${DEFAULT_TARGET_FIELD} must not be negative zero`)
  }
  if (value < MIN_TARGET_ACTIVE_CHILDREN || value > MAX_TARGET_ACTIVE_CHILDREN) {
    throw new TypeError(
      `daily-work ${DEFAULT_TARGET_FIELD} must be between ${MIN_TARGET_ACTIVE_CHILDREN} and `
      + `${MAX_TARGET_ACTIVE_CHILDREN}; got ${value}. ${MAX_TARGET_ACTIVE_CHILDREN} is the deployment's hard `
      + 'child capacity, so a larger target is not a bigger budget — it is a refusal.',
    )
  }
}

/**
 * Refuse a section that still carries the pre-split key.
 *
 * Separated from {@link assertTargetActiveChildren} because the two are different
 * failures with different fixes: an out-of-range number is a bad value, a legacy
 * key is a bad document, and a caller told "out of range" would go looking in the
 * wrong place.
 */
export function assertNoLegacyTargetField(section: Record<string, unknown>): void {
  if (LEGACY_TARGET_FIELD in section) {
    throw new TypeError(
      `daily-work: the "${DAILY_WORK_NS}" section still carries the pre-split key `
      + `"${LEGACY_TARGET_FIELD}". It was renamed to "${DEFAULT_TARGET_FIELD}" because the old name claimed a `
      + 'relationship to the ACTIVE RUN that the code never had (V5 section 13): a run is governed by its own '
      + 'durable requestedTarget, and this setting is only the default for NEW runs. Rewrite the stored key — '
      + `leaving it would silently take the composition default instead of the stored value.`,
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
   * The CURRENT DEFAULT for new runs, read live.
   *
   * This is a function, not a captured number, and that is the whole point: a
   * change committed by the UI must take effect on the next read without a
   * restart. It delegates to `settingsSource()`, which `installSection` swaps to
   * the settings scope's reader at attach.
   *
   * WHAT IT IS NOT. It is not the active run's target and no call here changes
   * one. A run's target is `RunRecord.requestedTarget`, reached through
   * `/work target N`; this value only seeds a run at creation. The previous name
   * of this method's field implied otherwise, which is the defect V5 section 13
   * names.
   */
  defaultTarget(): number
  /**
   * @deprecated The pre-split name, kept ONLY so `host.ts` keeps compiling.
   *
   * `host.ts` is another writer's region this round (P5 owns it), so this module
   * does not force a cross-region edit. The method returns exactly what
   * {@link defaultTarget} returns — the default for new runs — so the alias
   * cannot produce a different number. It is a NAME defect, not a behaviour one:
   * a reader of `WorkService.targetActiveChildren()` (host.ts:460) would still
   * reasonably believe it is the active run's target.
   *
   * REPORTED, NOT FIXED HERE: `host.ts:460` should be
   * `defaultTargetActiveChildren()` and `host.ts:461` should call
   * `defaultTarget()`. Both are one-line renames in P5's file.
   */
  target(): number
  /** The namespace revision, as a UI must read it before writing. */
  revision(): number
  /**
   * Write a new default, fenced on `expectedRevision`.
   *
   * @param value - the new default; must be a whole number in [1, 30].
   * @param expectedRevision - the revision the caller READ. Omitting it writes
   *   unfenced, which is what an explicit human "set this now" action may do and
   *   what no automated caller may do. The UI's card always passes one.
   */
  set(value: number, expectedRevision?: number): Promise<TargetWriteOutcome>
}

/**
 * The section's `validate` hook runs on the RESOLVED value, so it sees defaults.
 *
 * It checks BOTH the legacy key and the range, in that order: a document that is
 * both stale and out of range should be reported as stale, because rewriting the
 * key is the fix that comes first and the range check would pass once the stored
 * value is dropped.
 */
function validateResolved(value: DailyWorkSettings): void {
  assertNoLegacyTargetField(value as unknown as Record<string, unknown>)
  assertTargetActiveChildren(value.defaultTargetActiveChildren)
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
 *   from a request. Accepts the pre-split spelling so the `host.ts` call site
 *   (another writer's region this round) keeps compiling; see
 *   {@link LegacyDailyWorkSettingsEntry}.
 * @returns the handle. When no settings provider is ever mounted,
 *   `defaultTarget()` keeps returning `entry` and `set()` reports `invalid`-style
 *   failure by throwing from the provider lookup — a host with no settings
 *   service has no UI, so there is no writer to serve.
 */
export function installDailyWorkTargetSetting(
  owner: Context,
  entry: DailyWorkSettingsEntry,
): TargetSettingHandle {
  const normalized = normalizeEntry(entry)
  // Validate the composition entry at mount: a host configured with an
  // out-of-range target must fail loudly at boot rather than refuse every write
  // later with a confusing message.
  assertTargetActiveChildren(normalized.defaultTargetActiveChildren)
  let settingsSource: () => DailyWorkSettings = () => normalized
  owner.inject(['settings'], (settingsCtx) => {
    settingsCtx.settings.installSection(owner, DAILY_WORK_NS, DailyWorkConfig, normalized, {
      validate: validateResolved,
      setSource: (source) => { settingsSource = source },
      // EMPTY ON PURPOSE, and now it is an honest empty. Nothing here derives a
      // fact from the default: it is read at run creation and nowhere else, so
      // there is no derived state to re-judge. See the module header.
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
    defaultTarget: () => settingsSource().defaultTargetActiveChildren,
    // Same function, second name. Not a wrapper that could drift: the SAME
    // arrow, so the two names cannot return different numbers.
    target(): number { return this.defaultTarget() },
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
        await settings.update(
          DAILY_WORK_NS, { [DEFAULT_TARGET_FIELD]: value }, expectedRevision,
        )
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
