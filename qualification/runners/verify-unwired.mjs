/**
 * Boot-time probe: is the `daily-work` TARGET SETTING reachable in a REAL
 * composed profile, and does a change through it actually move the target?
 *
 * WHY A BOOT PROBE AND NOT A DIRECT-MOUNT TEST
 *
 * `src/target-setting.ts` is the mechanism behind the user's live N. Its unit
 * test (`target-setting.test.ts`) mounts a settings provider and calls
 * `installDailyWorkTargetSetting` DIRECTLY. That proves the mechanism and says
 * nothing about whether the product uses it: the defect class this project has
 * already shipped three times (`setLaunchPort` and `takeContinuation` each had
 * zero production callers; a `dsh-ipython` bundle declared no `dsh.bundle`).
 * `docs/GAPS.md` G-FIX-04 states the lesson: an oracle weaker than its scenario
 * passes while the product is broken.
 *
 * So this probe runs INSIDE a real `daily-candidate` boot, through the real
 * profile resolver, and asserts:
 *
 *   1. `ctx.dailyWork` is present and its `targetActiveChildren()` is a number.
 *      That reader is the one `createRun` uses to seed a run's target, so if it
 *      is live the PRODUCT path from the composed profile to the setting exists.
 *   2. `ctx.get('settings')` is present and the `daily-work` namespace is
 *      REGISTERED in it. The registration is the activation edge of
 *      `installSection` inside `host-plugin.ts -> installTargetSetting`; if the
 *      namespace is absent, `targetActiveChildren()` can only ever return the
 *      composition value and the live control is decorative.
 *   3. The setting is READ THROUGH the settings document, not from config: a
 *      write through `settings.update` at the observed revision is read back by
 *      `service.targetActiveChildren()`. This is what distinguishes a live
 *      reader from a value captured at construction -- the property
 *      `host.ts` claims in prose ("a UI change takes effect without a restart")
 *      and which nothing on the boot tier had measured.
 *
 * WHAT THIS DOES NOT PROVE, stated so a green result is not over-read:
 *   - It does not prove an authenticated Remote control exists. This package
 *     registers NO Remote surface (`grep -rn 'TypertRemote' src/` outside tests
 *     returns nothing), so today the only writers of this namespace are the
 *     settings document itself and any UI the DEPLOYMENT mounts. The probe
 *     writes through the same `settings.update` a UI would, so it measures the
 *     host half of the claim, not the UI half.
 *   - It does not prove the model can change N. That is the point: `work` cannot
 *     write this value, and the probe does not claim otherwise.
 *
 * `inject` is a READINESS GATE, not a wish list (G-FIX-09). `dailyWork` is the
 * service under test, so gating on it means this probe activates only once the
 * work service is genuinely live.
 *
 * `settings` IS ALSO IN `inject`, and the first version of this file omitted it
 * and produced a FALSE ABSENCE. Measured: gating only on `dailyWork` made the
 * probe activate on the work service's own edge, which is EARLIER than the
 * settings provider's (`settings` is row 58 of the resolved tree, `daily-work-host`
 * is row 580). The probe then read `ctx.get('settings') === undefined` and
 * reported "the daily-work namespace has no provider" -- a claim about the
 * product derived from the probe's own race. This is the same measurement error
 * `docs/GAPS.md` G-FIX-09 records for an earlier probe, and the fix is the same:
 * declare the service you are about to read.
 *
 * The cost of injecting it is that on a profile with NO settings provider this
 * probe never activates. That is the correct trade here and it is stated rather
 * than hidden: the boot then prints it under "Plugins waiting for services
 * (missing: settings)", which is a visible signal about the profile rather than
 * a silent false absence. `settingsPresent` is still recorded so a future
 * provider that registers and then detaches is distinguishable.
 */
import { writeFileSync } from 'node:fs'

export const name = 'verify-unwired'
export const inject = ['dailyWork', 'settings']

// ---------------------------------------------------------------------------
// THE OUTPUT PATH IS DERIVED FROM THIS FILE'S OWN LOCATION, not hardcoded.
//
// It used to be the literal `'D:/DSH/work/dsh-native-daily/qualification/results/R3-unwired/profile-boot.json'`.
// That is a cross-tree WRITE: a writer running this probe from a git worktree
// (which the multi-agent discipline requires) deposited its finding into the MAIN
// tree, and the artifact it landed on is the one a verdict READS. It is invisible
// as a diff because the finding is a small JSON object that looks the same from
// either tree, so the overwrite reads as "the value is what it always was" rather
// than "another tree wrote here". This is the write-side hazard of `G-SEAM-61`
// and the same class as `G-SEAM-66`.
//
// `import.meta.url` is `.../qualification/runners/verify-unwired.mjs`, so two levels up is the
// repository root of WHICHEVER tree is running -- verified for a worktree, where
// it resolves to that worktree rather than to the main checkout. The finding
// therefore lands in that tree's evidence directory, beside the run record it
// describes. `R3_OUT` still overrides for an explicit target.
// ---------------------------------------------------------------------------
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

/** The repository root of the tree THIS FILE was loaded from. */
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

const OUT = process.env.R3_OUT ?? join(REPO_ROOT, 'qualification/results/R3-unwired/profile-boot.json')


/** The namespace `target-setting.ts` owns. Duplicated on purpose: a probe that
 *  imported it would be reading the same constant it is meant to verify, and a
 *  typo'd import would silently test nothing. */
const NS = 'daily-work'

export async function apply(ctx) {
  const finding = {
    profileName: ctx.get('profileContext')?.profile?.name ?? 'unknown',
    servicePresent: false,
    targetBefore: null,
    settingsPresent: false,
    namespaceRegistered: false,
    namespaceWaitMs: null,
    namespacesSeen: null,
    namespaceRevision: null,
    namespaceValue: null,
    targetSettingHandlePresent: false,
    writeAttempted: false,
    writeOk: false,
    writeReason: null,
    targetAfterWrite: null,
    liveReaderObserved: false,
    restoreOk: null,
    restoreNote: null,
    error: null,
  }
  try {
    const service = ctx.get('dailyWork')
    if (service === undefined) {
      finding.error = 'ctx.dailyWork is ABSENT: the host row did not resolve through the profile'
      throw new Error(finding.error)
    }
    finding.servicePresent = true
    finding.targetBefore = service.targetActiveChildren()
    finding.targetSettingHandlePresent = service.targetSettingHandle !== undefined

    const settings = ctx.get('settings')
    finding.settingsPresent = settings !== undefined
    if (settings === undefined) {
      // Honest partial: the service is live but the LIVE control is not, so the
      // target can only come from composition config.
      finding.error = 'ctx.settings is ABSENT: the daily-work namespace has no provider, so targetActiveChildren() is the composition value only'
    } else {
      // WAIT for the registration, with a bounded budget, and RECORD the wait.
      //
      // `installDailyWorkTargetSetting` registers the section from inside
      // `owner.inject(['settings'], ...)`, so the namespace appears on the
      // SETTINGS readiness edge -- the same edge this probe activates on. A
      // single immediate read therefore measures which fiber cordis happened to
      // notify first, not whether the product registers the section at all.
      // Reporting "not registered" from that race would be a claim about the
      // product derived from the probe's own scheduling, which is the
      // measurement-error class G-FIX-09 records.
      //
      // So the probe polls, and `namespaceWaitMs` is part of the finding: a
      // non-zero wait is evidence that the registration is edge-ordered, and a
      // wait that exhausts the budget is evidence about the product.
      const describeNamespace = () => settings.describe({ redactSecrets: true })
        .find(candidate => candidate.ns === NS)
      const deadline = Date.now() + 5000
      let descriptor = describeNamespace()
      while (descriptor === undefined && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 25))
        descriptor = describeNamespace()
      }
      finding.namespaceWaitMs = Date.now() - (deadline - 5000)
      finding.namespacesSeen = settings.describe({ redactSecrets: true })
        .map(candidate => candidate.ns).sort()

      if (descriptor === undefined) {
        finding.error = `the "${NS}" namespace is NOT registered after ${finding.namespaceWaitMs}ms: installTargetSetting did not reach the settings provider`
      } else {
        finding.namespaceRegistered = true
        finding.namespaceRevision = descriptor.revision
        finding.namespaceValue = descriptor.value

        // Write through the SAME API an authenticated UI would use, at the
        // revision just observed, then read the service's own reader. A target
        // captured at construction would not move.
        const next = Number(finding.targetBefore) === 10 ? 11 : 10
        finding.writeAttempted = true
        try {
          await settings.update(NS, { targetActiveChildren: next }, descriptor.revision)
          finding.writeOk = true
        } catch (error) {
          finding.writeOk = false
          finding.writeReason = error instanceof Error ? error.message : String(error)
        }
        finding.targetAfterWrite = service.targetActiveChildren()
        finding.liveReaderObserved = finding.writeOk && finding.targetAfterWrite === next
        if (finding.writeOk && !finding.liveReaderObserved) {
          finding.error = `the write succeeded but the service still reads ${String(finding.targetAfterWrite)}; targetActiveChildren() is NOT a live reader of the settings section`
        }

        // RESTORE, because the measurement is a WRITE and this runs against a
        // real DSH_HOME. `settings.update` persists to the deployment's settings
        // document (`$DSH_HOME/settings.yaml`), so a probe that left the raised
        // value behind would change the deployment it measured -- and the next
        // probe run would then observe its own residue instead of the product's
        // composition value.
        //
        // The restore writes the ORIGINAL RESOLVED value back. It cannot remove
        // the `daily-work` section the write created, so the document gains an
        // explicit user layer that resolves to the same number. That residual is
        // recorded in `restoreNote` rather than smoothed over: the resolved
        // configuration is identical, but the file is not byte-identical to its
        // pre-probe state.
        if (finding.writeOk) {
          const after = settings.describe({ redactSecrets: true })
            .find(candidate => candidate.ns === NS)
          try {
            await settings.update(NS, { targetActiveChildren: finding.targetBefore }, after?.revision ?? descriptor.revision)
            finding.restoreOk = service.targetActiveChildren() === finding.targetBefore
            finding.restoreNote = 'wrote the original resolved value back; the daily-work section remains as an explicit user layer resolving to the same number'
          } catch (error) {
            finding.restoreOk = false
            finding.restoreNote = `RESTORE FAILED: ${error instanceof Error ? error.message : String(error)}. The deployment settings document was left holding targetActiveChildren=${String(next)}.`
          }
        }
      }
    }
  } catch (error) {
    finding.error = finding.error ?? (error instanceof Error ? error.message : String(error))
  }
  writeFileSync(OUT, JSON.stringify(finding, null, 2))
  process.stdout.write(`VERIFY-UNWIRED: ${JSON.stringify(finding)}\n`)
}
