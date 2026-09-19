/**
 * Boot-time probe: did switching `ctx.shell` to the LOCAL pwsh executor, and
 * turning OFF the permission control plane, leave the composition healthy?
 *
 * WHY A DIRECT `ctx.plugin()` MOUNT IS NOT EVIDENCE. A test that mounts
 * `PwshLocalExecutor` proves the module runs. It does NOT prove the profile
 * mounts it, nor that removing `permission-presets` left some OTHER row stuck
 * `pending`. This project has retracted that class of over-claim repeatedly
 * (G-FIX-04, G-FIX-12, G-FIX-13). So this probe runs INSIDE a real composed
 * profile boot and reads the facts off the live Loader.
 *
 * THE FOUR ASSERTIONS, in order of what they can catch:
 *
 *   1. THE ACTIVATION-WARNING COUNT IS ZERO, OVER THE PRODUCT'S ROWS. This is
 *      the load-bearing one. The measured failure mode (AUDIT-REQUEST fact F)
 *      is a row that never activates: `inject` is a READINESS GATE, so one
 *      `pending` row can take out a whole agent preset
 *      (`packages/preset/agent-presets/src/mount.ts:396`) and the model's tool
 *      face collapses to `toolCount: 0`. A disabled row is NOT reported as
 *      inactive (`packages/boot/app-boot/src/index.ts:774`), so "I disabled it"
 *      and "nothing else broke" are DIFFERENT facts and this count is the only
 *      thing that separates them.
 *
 *      IT IS MEASURED TWICE, ON PURPOSE, because the two checkpoints answer
 *      different questions and only the second is the product's own view:
 *
 *        (a) MID-APPLY, with the probe's own row excluded. A fiber reaches
 *            ACTIVE only after its `apply` RESOLVES
 *            (`vendor/cordis/src/fiber.ts:323`), so the probe's row is
 *            necessarily LOADING (state 1) while the probe is running. Leaving
 *            it in reports a warning on a healthy composition -- a
 *            self-inflicted false positive of the class G-FIX-09 records.
 *        (b) POST-AUDIT, with NO exclusion. `auditStartupEntries` runs after
 *            `loader.await()` (`packages/boot/app-boot/src/index.ts:956-957`)
 *            and `appReady` is committed only after `boot()` returns
 *            (`apps/cli/src/profile-boot.ts:326-328`), so a listener on
 *            `appReady` observes the tree strictly AFTER the product's own
 *            audit. This checkpoint needs no filter, and it doubles as the
 *            POSITIVE CONTROL for the whole probe: an empty stderr warning
 *            block is ambiguous on its own, because a host killed before the
 *            audit printed would also show nothing. The post-audit snapshot
 *            existing proves the audit RAN and states what it saw.
 *
 *   2. `permissionPresets` IS ABSENT from the resolved graph. Asserted by
 *      reading the service (`ctx.get`) AND the loader entry table, because the
 *      service being unreachable and the row being absent are different claims.
 *
 *   3. THE MOUNTED SHELL REPORTS `sandboxMode === undefined`. That is the fact
 *      that makes `permission-presets` throw
 *      (`packages/interaction/permission-presets/src/index.ts:214-216`), so it
 *      is also the proof that the two changes are mutually consistent rather
 *      than accidentally co-occurring.
 *
 *   4. THE MODEL'S TOOL FACE STILL CONTAINS `ipython` AND THE NATIVE FS TOOLS,
 *      and the full count is reported. A green result with `toolCount: 0` would
 *      be the exact failure this probe exists to catch, so the count is
 *      recorded as a number rather than summarised as a boolean.
 *
 * WHAT THIS DOES NOT PROVE, stated so a green result is not over-read:
 *   - It does not prove the `pwsh` TOOL can execute a command. It proves the
 *     executor is the local one and that the tool row activated. Executing a
 *     real command through it is T2/other agents' surface.
 *   - It does not prove `permission-presets` WOULD throw; that is a source-level
 *     fact read at `index.ts:214-216` and is not re-derived at runtime. What is
 *     measured is the absence of the row and the undefined `sandboxMode` that
 *     together make the throw reachable.
 *   - It does not prove the `approval` row's policy is `never` at the model's
 *     runtime-context boundary. The policy value is read from the live service
 *     config; whether the model's prompt contains the sentence is not asserted.
 *   - No CPU-saturating or load arm is run: the machine is shared and a
 *     load-dependent oracle already produced a false PASS in this project.
 */

/**
 * The services this probe needs before its assertions mean anything.
 *
 * `sessionController` is in the gate for a MEASURED reason, copied from
 * `verify-t2-fs.mjs` where the same bug was already hit: a probe that injects
 * only early-publishing services activates BEFORE `session-controller`,
 * `webserver` and `agent-presets` settle, then reports an empty roster and dies
 * on `ctx.get('sessionController').create` being undefined -- a probe failure
 * that says nothing about the product.
 *
 * `shell` is deliberately NOT in `inject`, even though it is the subject.
 * Gating on it would make a MISSING shell executor look like this probe's own
 * absence instead of a finding. It is read with `ctx.get`, which returns
 * `undefined` honestly, and the result records which happened.
 */
export const inject = ['sessionController', 'tools']

import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'

const REPO = 'D:/DSH/work/dsh-native-daily'
const RESULT_DIR = `${REPO}/qualification/results/T3-shell`
/** The output path. `DSH_PROBE_OUT` lets the shared harness own this file, so
 * two agents cannot read each other's result (the G-FIX-13 false PASS). */
const OUT = process.env.DSH_PROBE_OUT ?? `${RESULT_DIR}/boot.json`

/** The session workspace this probe creates its session in. */
const WORKSPACE = `${RESULT_DIR}/workspace`

/** FiberState.ACTIVE === 2 (`vendor/cordis/src/fiber.ts:147-154`). */
const FIBER_ACTIVE = 2

/**
 * Read the loader's entry table as plain data.
 *
 * Extracted so the SAME read can be taken at two different checkpoints (see
 * assertion 1 in the header): mid-`apply`, and again after the product's own
 * startup audit. Two calls to one function, so the two snapshots cannot drift.
 *
 * @param ctx - the settled context whose Loader entries to read.
 * @returns one plain row per entry.
 */
function readEntries(ctx) {
  const rows = []
  const loader = ctx.get('loader')
  if (loader === undefined) return rows
  for (const entry of loader.entries()) {
    rows.push({
      id: entry.options.id,
      name: entry.options.name,
      disabled: entry.disabled === true,
      fiberState: entry.fiber?.state ?? null,
      // The services a still-unactivated row is waiting for, so a non-zero
      // count names WHAT it is blocked on instead of only that it is.
      missing: entry.fiber?.inject === undefined
        ? []
        : Object.keys(entry.fiber.inject).filter(service => ctx.get(service) === undefined),
    })
  }
  return rows
}

/** Rows that the product's own audit would report: not ACTIVE and not disabled.
 *
 * A disabled row is SKIPPED by `inactiveEntries`
 * (`packages/boot/app-boot/src/index.ts:774`), so it is skipped here too --
 * otherwise "I disabled it" would be counted as a regression.
 *
 * @param entries - rows from {@link readEntries}.
 * @returns the rows the audit would report.
 */
function inactiveRows(entries) {
  return entries.filter(row => row.fiberState !== FIBER_ACTIVE && !row.disabled)
}

export async function apply(ctx) {
  const finding = {
    probe: 'verify-t3-shell',
    dshHome: process.env.DSH_HOME ?? null,
    bootCwd: process.cwd(),
    // `presetRoots` is what `readResult()` in boot-harness.mjs asserts against,
    // binding this result to the home that was booted. It also proves the
    // preset root resolved from a FOREIGN cwd, which is the G-FIX-13 trap.
    presetRoots: [],
    presetDefaultId: null,
    error: null,
  }

  // ── the post-audit checkpoint, registered FIRST so it is armed even if the
  //    body below throws ─────────────────────────────────────────────────────
  //
  // WHY THIS IS THE AUTHORITATIVE ACTIVATION MEASUREMENT. Everything the body
  // reads is read from INSIDE this probe's own `apply`, and a fiber is ACTIVE
  // only once its `apply` resolves (`vendor/cordis/src/fiber.ts:323`). So the
  // mid-apply snapshot necessarily shows THIS row as LOADING (state 1) and
  // cannot show the tree as the product's audit sees it. `appReady` is
  // committed strictly after `boot()` returns
  // (`apps/cli/src/profile-boot.ts:326-328`), and `boot()` runs
  // `loader.await()` then `auditStartupEntries` before returning
  // (`packages/boot/app-boot/src/index.ts:956-957`). A listener on it therefore
  // observes the entry table AFTER the product's own audit, with NO row
  // excluded -- including this probe's, which by then is ACTIVE.
  //
  // IT IS ALSO THE PROBE'S POSITIVE CONTROL. An empty stderr warning block is
  // ambiguous on its own: a host killed before the audit printed would also
  // show nothing, and "no warning" would then mean "no audit" rather than "no
  // inactive row". `postAuditRan: true` proves the audit reached its
  // checkpoint, so a zero count can be read as a measurement.
  let writeOnce = null
  let written = false
  const appReady = ctx.get('appReady')
  finding.appReadyServicePresent = appReady !== undefined
  finding.postAuditRan = false
  if (appReady !== undefined) {
    appReady.onReady(() => {
      try {
        const rows = readEntries(ctx)
        const inactive = inactiveRows(rows)
        finding.postAuditEntryCount = rows.length
        finding.postAuditInactiveEntries = inactive
        finding.postAuditActivationWarningCount = inactive.length
        finding.postAuditActivationWarningsZero = inactive.length === 0
        // The probe's OWN row, at the checkpoint where it must be ACTIVE. This
        // is the direct evidence that the mid-apply `fiberState: 1` was the
        // observation point rather than a real failure to activate.
        finding.postAuditProbeRowState = rows.find(row => row.id === 'verify-t3-shell')?.fiberState ?? null
        finding.postAuditActiveRowCount = rows.filter(row => row.fiberState === FIBER_ACTIVE).length
        finding.postAuditRan = true
      } catch (error) {
        finding.postAuditError = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
      }
      writeOnce?.()
    })
  }

  // A bounded guard: if `appReady` never fires (a boot that dies before
  // committing), the result is still written so the harness reports a
  // MEASURED failure rather than a 90s timeout with no data. Recorded
  // explicitly rather than silently degrading the assertion.
  const guard = setTimeout(() => {
    finding.postAuditTimedOut = true
    writeOnce?.()
  }, 20_000)

  try {
    // ── the preset roster: names the home, and proves the root resolved ─────
    const roster = ctx.get('agentPresets')
    if (roster !== undefined) {
      finding.presetDefaultId = roster.defaultId ?? null
      finding.presetRoots = (roster.roots ?? []).map(root => ({ path: String(root.path), trust: String(root.trust) }))
      finding.presetIds = (await roster.list()).map(p => p.id).sort()
    }

    // ── 1. the loader entry table: the activation facts ─────────────────────
    const entries = readEntries(ctx)
    finding.loaderPresent = ctx.get('loader') !== undefined
    finding.entryCount = entries.length

    // THE LOAD-BEARING NUMBER, checkpoint (a): mid-apply, probe row EXCLUDED.
    //
    // THE PROBE'S OWN ROW IS EXCLUDED, and the reason is a measured property of
    // the Loader rather than convenience. A fiber reaches ACTIVE only after its
    // `apply` has RESOLVED (`vendor/cordis/src/fiber.ts:323`), so a probe
    // inspecting the tree from inside its own `apply` can only ever observe
    // ITSELF as LOADING (state 1). Leaving it in reported
    // `activationWarningCount: 1` on a composition where every real row was
    // ACTIVE -- a self-inflicted false positive of exactly the class G-FIX-09
    // records. BOTH numbers are recorded so the exclusion is auditable rather
    // than a silent filter.
    const PROBE_ROW_ID = 'verify-t3-shell'
    const inactiveAll = inactiveRows(entries)
    finding.inactiveEntriesIncludingProbe = inactiveAll
    finding.inactiveEntries = inactiveAll.filter(row => row.id !== PROBE_ROW_ID)
    finding.activationWarningCount = finding.inactiveEntries.length
    finding.activationWarningsZero = finding.activationWarningCount === 0
    finding.probeRowObservedState = entries.find(row => row.id === PROBE_ROW_ID)?.fiberState ?? null
    // Every OTHER row's state, so a reader can see the tree settled without
    // trusting the filtered count.
    finding.activeRowCount = entries.filter(row => row.fiberState === FIBER_ACTIVE).length
    finding.disabledRowCount = entries.filter(row => row.disabled).length

    // ── 0. WHICH BUILD DID THIS MEASUREMENT RUN AGAINST ────────────────────
    //
    // Every home on this machine installs `dsh-ipython` and `dsh-daily-work`
    // through a `link:` (verified: `$DSH_HOME/profiles/daily/node_modules/`
    // holds exactly those two, both symlinks into this repo). A booted profile
    // therefore executes the repo's BUILT `lib/`, never its `src/`. So this
    // probe's tool-face assertions are measurements of an ARTIFACT, and a
    // result that does not name the artifact is not reproducible.
    //
    // This is recorded because the project has been burned three times by a
    // stale build being read as a product defect (docs/GAPS.md G-SEAM-29 is the
    // most recent). The digests below bind THIS result to the bytes that were
    // actually imported, so a later reader can tell whether a re-run measured
    // the same build. `staleAgainstSource` is deliberately NOT an assertion --
    // it is a warning label, because a stale `lib/` that is off this probe's
    // load path is not a defect in this gate.
    finding.buildIdentity = (() => {
      const REPO = 'D:/DSH/work/dsh-native-daily'
      const targets = [
        'packages/dsh-ipython/lib/ipython-tool.js',
        'packages/dsh-ipython/lib/kernel.js',
        'packages/dsh-ipython/lib/kernel-plugin.js',
        'packages/dsh-ipython/lib/host-plugin.js',
        'packages/dsh-daily-work/lib/tools.js',
        'packages/dsh-daily-work/lib/host-plugin.js',
      ]
      const sources = [
        ['packages/dsh-ipython/src/ipython-tool.ts', 'packages/dsh-ipython/lib/ipython-tool.js'],
        ['packages/dsh-ipython/src/kernel.ts', 'packages/dsh-ipython/lib/kernel.js'],
        ['packages/dsh-ipython/src/kernel-plugin.ts', 'packages/dsh-ipython/lib/kernel-plugin.js'],
        ['packages/dsh-ipython/src/host-plugin.ts', 'packages/dsh-ipython/lib/host-plugin.js'],
        ['packages/dsh-daily-work/src/tools.ts', 'packages/dsh-daily-work/lib/tools.js'],
        ['packages/dsh-daily-work/src/host-plugin.ts', 'packages/dsh-daily-work/lib/host-plugin.js'],
      ]
      const digest = rel => {
        try {
          return createHash('sha256').update(readFileSync(`${REPO}/${rel}`)).digest('hex')
        } catch {
          return null
        }
      }
      return {
        repo: REPO,
        // The libs on this probe's load path, by content.
        libDigests: Object.fromEntries(targets.map(rel => [rel, digest(rel)])),
        // src-vs-lib freshness for those same modules.
        //
        // THIS COMPARES MTIMES, NOT CONTENT, and the reason is a bug this
        // field had in its first version: it hashed both files and called a
        // differing pair "stale". A `.ts` source and its compiled `.js` output
        // ALWAYS differ in bytes, so every pair reported `stale: true` -- a
        // constant, and therefore not evidence. The question a reader actually
        // has is "was this lib rebuilt after its source last changed", and only
        // ordering answers that. `libNewerThanSrc: false` means the compiled
        // artifact predates the source it claims to implement.
        srcLibPairs: sources.map(([src, lib]) => {
          const mtime = rel => {
            try {
              return statSync(`${REPO}/${rel}`).mtimeMs
            } catch {
              return null
            }
          }
          const srcMs = mtime(src)
          const libMs = mtime(lib)
          return {
            src,
            lib,
            srcMtimeMs: srcMs,
            libMtimeMs: libMs,
            // `null` when either side is missing, so a missing file cannot
            // read as "fresh".
            libNewerThanSrc: srcMs === null || libMs === null ? null : libMs > srcMs,
          }
        }),
      }
    })()

    // ── 2. the rows this change owns, by id ─────────────────────────────────
    //
    // `byId` returns the RAW row from `readEntries`, which has no `present`
    // field -- absence is represented by `null`. Every consumer below must
    // therefore normalise through this shape rather than testing
    // `row.present`, which is `undefined` on a row that exists. That mistake
    // was live in the prior run: `modelShellRowIsPending` read
    // `row.present === true`, which is false for a PRESENT row, so it reported
    // `false` vacuously and was not evidence of anything. Recorded here because
    // it is exactly the "green for the wrong reason" defect this project
    // tracks, and it was found by this run's new `pwshAbsenceIsIntentional`
    // assertion contradicting it.
    const byId = id => entries.find(row => row.id === id) ?? null
    const rowShape = id => {
      const row = byId(id)
      return row === null
        ? { present: false }
        : { present: true, disabled: row.disabled, fiberState: row.fiberState, name: row.name, missing: row.missing }
    }
    finding.rows = {}
    for (const id of ['pwsh-sandbox', 'pwsh-local', 'permission', 'ui-permission', 'approval', 'sandbox', 'sandbox-policy']) {
      finding.rows[id] = rowShape(id)
    }
    // The MODEL-FACING shell row, reported because its state is the difference
    // between "the tool is absent because another change disabled it" and "the
    // tool is absent because THIS change left it waiting on a service". Those
    // are different findings and a bare `pwshToolPresent: false` cannot tell
    // them apart. `tool-pwsh` injects `['tools','shell','systemPrompt','shellEnv']`
    // (`packages/shell/tool-pwsh/src/index.ts:48`), none of which this change
    // removes, so it must be either ACTIVE or DISABLED -- never PENDING.
    finding.modelShellRow = rowShape('tool-pwsh')
    finding.modelShellRowIsPending = finding.modelShellRow.present === true
      && finding.modelShellRow.disabled === false
      && finding.modelShellRow.fiberState !== FIBER_ACTIVE
    finding.modelShellRowDisabledByPreset = finding.modelShellRow.disabled === true
    // `pwshToolPresent: false` is EXPECTED on this deployment, and the
    // distinction that matters is WHY. T4 disabled the model-facing row
    // deliberately (`profiles/daily-candidate/presets/daily-standard/agent.cordis.yml`,
    // `- id: tool-pwsh` / `disabled: true`) so IPython is the only model
    // execution surface. That is a different fact from "the row is enabled and
    // never activated", which would be a regression -- and a bare
    // `pwshToolPresent: false` cannot tell them apart.
    //
    // So the absence is recorded as a two-sided measurement: the row must be
    // PRESENT and DISABLED (intentional), never present-and-pending. If the
    // preset's `disabled: true` were ever dropped, this flips to a finding.
    finding.pwshAbsenceIsIntentional = finding.modelShellRow.present === true
      && finding.modelShellRow.disabled === true
      && finding.modelShellRow.fiberState === null
    // The other half of the swap is the tool CATALOG, which is a different
    // measurement from the row table and is taken below once the session's
    // schemas are read (`ipythonReplacesPwsh`).

    // `permissionPresets` absent: asked of BOTH the service registry and the
    // loader entry table, because those are different claims. A service can be
    // unreachable while its row still exists, and vice versa.
    finding.permissionPresetsServicePresent = ctx.get('permissionPresets') !== undefined
    finding.permissionPresetsRowPresent = entries.some(row => row.id === 'permission')
    finding.permissionPresetsAbsent = !finding.permissionPresetsServicePresent
      && finding.rows.permission?.disabled === true
    // The `permissions` session projection is registered by that same row and
    // read only by the UI half; both are gone together. Reported as the presence
    // of the projection SERVICE, which is a different fact from whether any key
    // is registered in it.
    finding.sessionProjectionsServicePresent = ctx.get('sessionProjections') !== undefined

    // ── 3. the mounted shell executor and its capability fact ───────────────
    const shell = ctx.get('shell')
    finding.shellPresent = shell !== undefined
    if (shell === undefined) {
      finding.shellError = 'ctx.shell is ABSENT: no executor mounted, so the tool face cannot carry pwsh'
    } else {
      // Unwrap cordis's trace proxy before asking for the constructor name:
      // `ctx.shell.constructor` is a WRAPPED constructor
      // (`vendor/cordis/src/reflect.ts:154`, `utils.ts:173`), which would report
      // an anonymous proxy rather than the provider class.
      const ORIGINAL = Symbol.for('cordis.original')
      const rawShell = shell[ORIGINAL] ?? shell
      finding.shellWasTraceProxy = rawShell !== shell
      finding.shellClassName = rawShell.constructor?.name ?? null
      finding.shellPrototypeChain = (() => {
        const chain = []
        for (let proto = Object.getPrototypeOf(rawShell); proto !== null && proto !== Object.prototype; proto = Object.getPrototypeOf(proto)) {
          chain.push(proto.constructor?.name ?? '<anonymous>')
        }
        return chain
      })()
      // THE ASSERTION: `undefined` here is what makes permission-presets throw,
      // and it is also the proof this is the LOCAL executor (the sandboxed
      // subclass overrides the getter to return the configured mode,
      // `packages/shell/pwsh-sandbox/src/index.ts:83`).
      finding.shellSandboxMode = shell.sandboxMode === undefined ? null : shell.sandboxMode
      finding.shellSandboxModeIsUndefined = shell.sandboxMode === undefined
      finding.shellIsSandboxSubclass = finding.shellPrototypeChain.includes('SandboxPwshExecutor')
    }

    // The approval policy, read from the live service. Reported as-is: `null`
    // means the service is absent, which is a different fact from `'ask'`.
    const approval = ctx.get('approval')
    finding.approvalServicePresent = approval !== undefined
    finding.approvalPolicy = approval?.config?.policy ?? null
    finding.approvalPolicyIsNever = finding.approvalPolicy === 'never'

    // ── 4. a real Session, and its real tool face ───────────────────────────
    const sc = ctx.get('sessionController')
    finding.sessionControllerPresent = sc !== undefined
    if (sc === undefined) throw new Error('ctx.sessionController is absent; this probe must gate on it (see the inject note)')
    const created = await sc.create({ cwd: WORKSPACE })
    const sessionId = created?.sessionId ?? created?.id ?? null
    finding.sessionCreated = sessionId !== null
    finding.sessionId = sessionId

    const agent = ctx.get('agents')?.get(sessionId)
    finding.agentPresent = agent !== undefined
    const schemas = ctx.get('tools').schemas(agent)
    const names = schemas.map(schema => schema.name).sort()
    // REPORTED AS A NUMBER, not a boolean: a green run with 0 tools would be
    // the exact FACT F failure, and a boolean would hide it.
    finding.toolCount = names.length
    finding.tools = names
    finding.ipythonToolPresent = names.includes('ipython')
    finding.pwshToolPresent = names.includes('pwsh')
    finding.nativeFsToolsPresent = ['read', 'write', 'edit'].filter(name => names.includes(name))
    finding.nativeFsToolsAllPresent = finding.nativeFsToolsPresent.length === 3
    // THE SWAP, measured on the CATALOG rather than the row table: the model
    // must have `ipython` and must NOT have `pwsh`. Both halves are read from
    // the real Session's schema list, so this is independent of
    // `pwshAbsenceIsIntentional` (which reads the loader rows). The pair is
    // what distinguishes "IPython replaced the shell" from "the model lost its
    // execution surface entirely" -- and the second would also show
    // `toolCount: 0`, which is why that count is asserted separately.
    finding.ipythonReplacesPwsh = finding.ipythonToolPresent === true
      && finding.pwshToolPresent === false
      && finding.nativeFsToolsAllPresent === true

    // The escalation parameters are advertised only under a confining backend
    // (`packages/shell/tool-pwsh/src/index.ts:196-197,268`), so their absence
    // is a second, independent read of the same capability fact.
    const propertiesOf = toolName => Object.keys(schemas.find(s => s.name === toolName)?.parameters?.properties ?? {})
    finding.pwshParameters = propertiesOf('pwsh')
    finding.pwshEscalationFields = finding.pwshParameters.filter(k => k === 'sandbox_permissions' || k === 'justification')
    finding.pwshEscalationFieldsAbsent = finding.pwshEscalationFields.length === 0

    // ── 5. the corroborating verdict inputs ─────────────────────────────────
    //
    // THE VERDICT ITSELF IS COMPUTED IN `writeOnce`, not here, because the
    // AUTHORITATIVE activation number does not exist yet at this point: it is
    // taken by the post-audit listener below. Computing `allAssertionsPass`
    // here would read `undefined` for the post-audit fields and freeze a
    // verdict taken before the evidence arrived -- the exact pre-written
    // decision this project's evidence gate exists to reject.
    finding.preAuditAssertions = {
      permissionPresetsAbsent: finding.permissionPresetsAbsent,
      shellSandboxModeUndefined: finding.shellSandboxModeIsUndefined === true,
      ipythonPresent: finding.ipythonToolPresent === true,
      nativeFsToolsPresent: finding.nativeFsToolsAllPresent === true,
      toolCountNonZero: finding.toolCount > 0,
      midApplyActivationWarningsZero: finding.activationWarningsZero === true,
      // NOT `pwshToolPresent` -- that is EXPECTED to be false here. The
      // assertion is that its ABSENCE IS INTENTIONAL (row present, disabled),
      // which is the only version of this fact that can fail on a regression.
      pwshAbsenceIsIntentional: finding.pwshAbsenceIsIntentional === true,
      modelShellRowNotPending: finding.modelShellRowIsPending === false,
      ipythonReplacesPwsh: finding.ipythonReplacesPwsh === true,
    }
  } catch (error) {
    finding.error = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
  }

  // THE RESULT IS WRITTEN EXACTLY ONCE, AND ONLY FROM THE POST-AUDIT
  // CHECKPOINT. `bootAndWait` kills the host as soon as `OUT` exists (plus a
  // settle delay), so writing here and again on `appReady` would make the file
  // appear at the earlier, mid-apply moment and the harness would kill the host
  // before the post-audit numbers were ever taken -- silently degrading the
  // assertion this change exists to make honest. The guard below is the only
  // other writer, and it records `postAuditTimedOut` so a boot that never
  // commits reports a MEASURED failure instead of an empty timeout.
  writeOnce = () => {
    if (written) return
    written = true
    clearTimeout(guard)

    // THE VERDICT, computed NOW -- after the post-audit checkpoint has either
    // reported or timed out. Every entry is a measured boolean; `undefined`
    // never reads as a pass because each is compared against `=== true`.
    //
    // THE ACTIVATION ASSERTION IS THE POST-AUDIT ONE. It is the product's own
    // checkpoint (after `loader.await()` and `auditStartupEntries`), it applies
    // NO exclusion, and it therefore also requires THIS probe's row to be
    // ACTIVE. `postAuditCheckpointReached` is a separate conjunct because a
    // zero count that was never taken is not a pass: without it, a host killed
    // before the audit would report a clean tree it never looked at.
    //
    // The mid-apply count is kept as a CORROBORATING conjunct, so neither
    // checkpoint can carry the verdict alone.
    const pre = finding.preAuditAssertions ?? {}
    finding.verdict = {
      activationWarningsZero: finding.postAuditActivationWarningsZero === true,
      postAuditCheckpointReached: finding.postAuditRan === true,
      midApplyActivationWarningsZero: pre.midApplyActivationWarningsZero === true,
      permissionPresetsAbsent: pre.permissionPresetsAbsent === true,
      shellSandboxModeUndefined: pre.shellSandboxModeUndefined === true,
      ipythonPresent: pre.ipythonPresent === true,
      nativeFsToolsPresent: pre.nativeFsToolsPresent === true,
      toolCountNonZero: pre.toolCountNonZero === true,
      pwshAbsenceIsIntentional: pre.pwshAbsenceIsIntentional === true,
      modelShellRowNotPending: pre.modelShellRowNotPending === true,
      ipythonReplacesPwsh: pre.ipythonReplacesPwsh === true,
      // A probe body that threw before the tool face was read cannot pass on
      // the strength of the fields it did manage to write.
      noProbeError: finding.error === null,
    }
    finding.allAssertionsPass = Object.values(finding.verdict).every(Boolean)

    mkdirSync(RESULT_DIR, { recursive: true })
    writeFileSync(OUT, JSON.stringify(finding, null, 2))
    process.stdout.write(`VERIFY-T3-SHELL: ${JSON.stringify({
      activationWarningCount: finding.activationWarningCount,
      inactiveEntryIds: (finding.inactiveEntries ?? []).map(r => r.id),
      postAuditActivationWarningCount: finding.postAuditActivationWarningCount,
      postAuditInactiveEntryIds: (finding.postAuditInactiveEntries ?? []).map(r => r.id),
      postAuditProbeRowState: finding.postAuditProbeRowState,
      postAuditRan: finding.postAuditRan,
      postAuditTimedOut: finding.postAuditTimedOut ?? false,
      permissionPresetsAbsent: finding.permissionPresetsAbsent,
      shellSandboxMode: finding.shellSandboxMode,
      toolCount: finding.toolCount,
      allAssertionsPass: finding.allAssertionsPass,
      verdict: finding.verdict,
      error: finding.error,
    })}\n`)
  }
  // If `appReady` already fired between registration and here, this is the
  // only write. If it fires later, the listener writes. If it never fires, the
  // guard writes.
  if (finding.postAuditRan === true) writeOnce()
}
