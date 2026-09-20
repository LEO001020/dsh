/**
 * S11 — CMP-02 and CMP-04 measured on ONE real boot of the deliverable profile,
 * plus a sensitivity arm that makes "this probe adds no tool row" falsifiable.
 *
 * WHY ONE PROBE AND ONE SESSION. CMP-02 and CMP-04 are two reads of the SAME
 * live composition, and the CPU directive for this wave is one boot at a time.
 * Booting once and reading it twice is stronger than two boots: the facts are
 * then provably about ONE composition. Exactly ONE real Session is created,
 * because CMP-04's stimulus says "the model-visible catalog for one real
 * session" -- creating three would make the artifact answer a question the case
 * does not ask.
 *
 * WHAT CMP-02 ASKS (v2 definition, verbatim):
 *   "A row with `id: sandbox-policy` is present (NOT deleted), its configured
 *    mode is `danger-full-access`, and its `workspaceRoot` resolves to an
 *    absolute path."
 * So the probe reads THREE things and keeps them separable:
 *   1. the row AS COMPOSED, from the loader's own entry table (`options.config`),
 *      which is what shows whether the value is a LITERAL or an unresolved
 *      `!!js` expression;
 *   2. the EFFECTIVE values from the mounted service, including
 *      `resolve({ session })` for a REAL session, because `resolve()` is
 *      `request.mode ?? overrideOf(session) ?? defaultMode`
 *      (`sandbox-policy/src/index.ts:164-171`) -- a correct default does NOT
 *      imply a correct per-session value;
 *   3. the NARRATION, by RUNNING `ctx.systemPrompt.assemble(...)` and reading the
 *      rendered `sandbox:policy` context text. This is the sentence that reaches
 *      the request: `AgentLoop` does exactly this at
 *      `packages/core/agent-loop/src/agent.ts:246-249` with
 *      `assembleContextFor(agent)` === `{ agent, scope: agent }`
 *      (`packages/core/agent/src/dispatch.ts:174-176`). Asserting the source
 *      sentence instead would be the weaker oracle this project keeps recording:
 *      it would still pass if the provider were never registered.
 *
 * WHAT CMP-04 ASKS, and why the count is NOT a pass condition. The v2 oracle
 * explicitly refuses a pinned integer: "The measured count is recorded verbatim
 * in the evidence ... A pinned integer is deliberately NOT a pass condition
 * here". So this probe records the full NAME SET, in the order the registry
 * returns it, and its sorted form, and never compares it to 27 or 28.
 *
 * ── THE SENSITIVITY ARM, WHICH IS THE POINT OF THIS FILE ───────────────────
 *
 * CMP-04's stimulus is "a probe that adds NO row", and its oracle says a
 * catalog "measured through a verification overlay that INSERTS the tool row
 * does NOT establish this case". A probe that silently added a tool row would
 * therefore produce an artifact that looks perfect and proves nothing -- and
 * that is a defect class this project has recorded five times (G-FIX-04/05/12).
 *
 * So "this probe adds no row" is not asserted here. It is made FALSIFIABLE: the
 * probe takes the real catalog, then REGISTERS A SENTINEL TOOL through the live
 * registry, then re-reads the catalog, then disposes the sentinel and reads
 * again. If the measurement channel is sensitive to a probe-added tool row --
 * which is the premise the whole case rests on -- the sentinel MUST appear and
 * the count MUST rise by one. An arm that failed to see it would mean the
 * catalog reading cannot detect a probe's own row at all, and the real
 * measurement above it would be worthless.
 *
 * The real catalog is read BEFORE the sentinel exists, so the sentinel cannot
 * contaminate the CMP-04 measurement, and the post-dispose read shows the
 * channel returns to its original value.
 *
 * WHAT IT DOES NOT DO. It inserts no product row and reconfigures nothing. The
 * one row the overlay adds is the probe ITSELF (`s11-cmp-probe`), and the
 * ownership stamp (`presetRoots`) is written first so `readResult()` can prove
 * the artifact belongs to the home the caller booted -- a probe writing to a
 * fixed path is a SHARED MUTABLE RESOURCE (G-FIX-13).
 *
 * `inject` is `['sessionController']` ONLY. A hard inject is a READINESS GATE:
 * a probe that injected a service it wants to ASSERT is present would never run
 * when that service is missing, so the artifact would be ABSENT instead of
 * reporting the absence. Every other service is read through `ctx.get`, which
 * returns `undefined` honestly.
 */
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { writeFileSync } from 'node:fs'

/** The repository root of the tree THIS FILE was loaded from. */
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..').replace(/\\/g, '/')

export const name = 's11-cmp-probe'

export const inject = ['sessionController']

const OUT = process.env.DSH_PROBE_OUT
  ?? join(REPO_ROOT, 'qualification/results/S11-cmp/probe.json')

/** The mode the trusted-local contract requires. */
const TRUSTED_LOCAL_MODE = 'danger-full-access'

/** The confining-mode marker the narration renders (`sandbox-policy/src/index.ts:46-47`). */
const CONFINING_MARKER = 'workspace-write'

/** The unconfined marker (`:48-49`). */
const UNCONFINED_MARKER = 'danger-full-access'

/**
 * Names that would mean a shell reached the model surface.
 *
 * WIDENED DELIBERATELY past `pwsh`: CMP-13's oracle says "`pwsh` (and any
 * equivalent shell tool)". Checking only the literal name would pass a
 * deployment that handed the model `bash` or the PTC `run_code` transport
 * instead, which is the same interface under another name.
 */
const SHELL_EQUIVALENT_NAMES = ['pwsh', 'bash', 'shell', 'run_code']

/**
 * The sentinel name for the sensitivity arm.
 *
 * Chosen so it cannot collide with a product tool and so it is unmistakable in
 * the artifact: if a reader ever sees this name in a REAL catalog read, the
 * instrument is broken and the measurement must be discarded.
 */
const SENTINEL_TOOL_NAME = 's11_probe_sensitivity_sentinel'

/** FiberState.ACTIVE === 2 (`vendor/cordis/src/fiber.ts:147-155`). */
const FIBER_ACTIVE = 2

/**
 * How long the settle re-read waits for entries to leave LOADING.
 *
 * Bounded for the same reason `STARTUP_POLICY_WAIT_MS` is: an unbounded wait
 * would stop this probe from ever writing its artifact, and a probe that never
 * writes is indistinguishable from a boot that never ran. On a healthy tree this
 * bound is never approached -- the entries observed mid-mount settle within the
 * probe's own work.
 */
const SETTLE_WAIT_MS = 3_000

/** Serialise a live value for the artifact, without letting a cycle abort the probe. */
function plain(value) {
  try {
    return JSON.parse(JSON.stringify(value))
  } catch (error) {
    return `unserialisable: ${error instanceof Error ? error.message : String(error)}`
  }
}

/**
 * Whether a path is absolute in this execution world's terms.
 *
 * Structural rather than `node:path.isAbsolute`, which is platform-dependent:
 * the same composed value must not pass or fail depending on which OS read it.
 * A drive-letter root, a POSIX root and a UNC root are all absolute.
 */
function isAbsolutePath(path) {
  return typeof path === 'string'
    && (/^[A-Za-z]:[\\/]/u.test(path) || path.startsWith('/') || path.startsWith('\\\\'))
}

/** One tool catalog read, with everything the two cases need from it. */
function readCatalog(tools, agent) {
  const schemas = tools.schemas(agent)
  const names = schemas.map(schema => schema.name)
  const sorted = [...names].sort()
  const ipython = schemas.find(schema => schema.name === 'ipython')
  return {
    toolCount: schemas.length,
    // VERBATIM, in registry order, so a change in composition is visible as a
    // diff. The sorted form is recorded alongside because a reader comparing two
    // artifacts should not have to know the registry's ordering rules.
    toolNamesInRegistryOrder: names,
    toolNamesSorted: sorted,
    ipythonPresent: names.includes('ipython'),
    workPresent: names.includes('work'),
    pwshPresent: names.includes('pwsh'),
    shellEquivalentsPresent: SHELL_EQUIVALENT_NAMES.filter(candidate => names.includes(candidate)),
    // If this is ever true, the instrument is contaminated and every catalog
    // number in the artifact must be discarded rather than reported.
    catalogContainsSentinelName: names.includes(SENTINEL_TOOL_NAME),
    ipythonParameters: ipython === undefined
      ? null
      : Object.keys(ipython.parameters?.['properties'] ?? {}),
  }
}

export async function apply(ctx) {
  const f = {
    probe: 's11-cmp-probe',
    ranAt: new Date().toISOString(),
    // FIRST and unconditional: the harness asserts the artifact names the home
    // this caller booted.
    presetRoots: [],
    presetDefaultId: null,
    /** The cwd the HOST was started from, which CMP-04's stimulus constrains. */
    bootCwd: process.cwd(),
    /** The cwd the Session was created with. `resolve()` prefers `session.header.cwd`. */
    sessionCwd: null,
    error: null,

    // ── CMP-02 ───────────────────────────────────────────────────────────────
    cmp02: {
      declared: {
        rowPresent: null,
        rowIdAsComposed: null,
        rowFiberState: null,
        rowDisabled: null,
        configAsComposed: null,
        configKeys: [],
        modeIsLiteral: null,
      },
      effective: {
        policyServicePresent: false,
        defaultMode: null,
        workspaceRoot: null,
        workspaceRootIsAbsolute: null,
        modeSource: 'unobservable',
        resolveNoSession: null,
        perSession: [],
      },
      narration: {
        systemPromptServicePresent: false,
        assembleRan: false,
        assembleError: null,
        policyContextPresent: false,
        policyContextText: null,
        contextNames: [],
        saysConfining: null,
        saysUnconfined: null,
      },
      ptc: {
        runtimePresent: false,
        runtimeName: null,
        sandboxMode: null,
        confineDecision: null,
        runCodeOnSurface: null,
      },
      guard: {
        servicePresent: false,
        reportOk: null,
        violations: [],
        startupBoundaryRecorded: null,
        startupBoundaryRecord: null,
      },
    },

    // ── CMP-04 ───────────────────────────────────────────────────────────────
    cmp04: {
      sessionId: null,
      agentPreset: null,
      agentPresent: false,
      sessionCreateError: null,
      catalog: null,
      /**
       * THE SECOND INSTRUMENT for the same fact.
       *
       * `tools.schemas(agent)` is the registry's own view. This is the tool list
       * the ASSEMBLY produces, which is what `AgentLoop` folds into the request
       * header (`agent-loop/src/agent.ts:246-249` then `toolsChanged`/
       * `canonicalHeader`). Two instruments reaching the same name set is
       * stronger than one, and they are not the same call: the assembly runs the
       * `system-prompt/assemble` waterfall and `orderTools`, so a provider that
       * restricted or reordered the surface would show up as a DIFFERENCE here
       * rather than as a matching number.
       */
      assembledToolNamesSorted: null,
      assembledToolCount: null,
      assembledMatchesRegistry: null,
      /**
       * The `error` clause of CMP-04's oracle. It stays `null` unless the
       * catalog read itself failed -- an absent catalog and an empty one are
       * different facts, and reporting the first as the second is the
       * G-FIX-06 false negative this project already recorded.
       */
      error: null,
    },

    // ── CMP-13, judged from the SAME catalog ─────────────────────────────────
    cmp13: {
      pwshAbsent: null,
      shellEquivalentsPresent: [],
      ipythonPresent: null,
      fullNameSetRecorded: null,
      note: 'Read from the same session catalog as cmp04. CMP-04 DEPENDS on CMP-13 in the v2 definition, so this half is what decides whether a CMP-04 verdict is even available.',
    },

    // ── the instrument's own falsification arm ───────────────────────────────
    probeAddsNoRow: {
      overlayToolRows: [],
      overlayRows: [],
      toolRowsRegisteredByProbeBeforeSensitivityArm: 0,
      sensitivity: {
        ran: false,
        error: null,
        before: null,
        afterRegister: null,
        deltaNames: [],
        afterDispose: null,
        channelDetectsAProbeAddedRow: null,
        returnedToOriginal: null,
      },
    },

    loader: {
      entryCount: null,
      probeRowIds: [],
      /**
       * The non-ACTIVE entries at the instant this probe's `apply` ran.
       *
       * KEPT AS A RAW OBSERVATION, and re-read below after the tree is allowed to
       * settle, because an entry observed mid-mount is NOT an entry that failed
       * to activate. `apply` runs while the tree is still coming up, so a
       * `LOADING` (state 1) reading here is a TIMING fact about the probe's own
       * instant. Reporting it as a composition defect would be the
       * "unreadable reported as absent" mistake in a new place, and reporting it
       * as healthy without checking would be the same mistake with the sign
       * flipped. So both readings are recorded and the comparison is the finding.
       */
      nonActiveEntries: [],
      /** The same read after the tree is allowed to settle, for the comparison above. */
      nonActiveEntriesAfterSettle: null,
      /** Entries still non-ACTIVE after settling. Non-empty here is a REAL finding. */
      stillNonActiveAfterSettle: null,
    },
  }

  let tools = undefined
  let agent = undefined

  try {
    // ── the ownership stamp, read before anything else can throw ─────────────
    const roster = ctx.get('agentPresets')
    if (roster !== undefined) {
      f.presetDefaultId = roster.defaultId ?? null
      f.presetRoots = (roster.roots ?? []).map(root => ({ path: String(root.path), trust: String(root.trust) }))
    }

    // ═══ CMP-02.1 — the row AS COMPOSED, from the loader's entry table ══════
    //
    // The loader table is the deployment's OWN declaration. Reading the mounted
    // service alone could not distinguish "the profile declared
    // danger-full-access" from "something else made the service resolve that
    // way", and the v1 FAIL was exactly a declaration defect: the composed
    // config was an unresolved `!!js process.env.DSH_PERMISSION_MODE ??
    // 'workspace-write'` and the variable was unset.
    const loader = ctx.get('loader')
    if (loader === undefined) {
      f.error = 'ctx.loader is absent: the composed row config cannot be read'
    } else {
      for (const entry of loader.entries()) {
        const id = entry.options.id
        const entryName = String(entry.options.name ?? '')
        if (typeof id === 'string' && id.startsWith('s11-')) f.loader.probeRowIds.push(id)
        if (id === 'sandbox-policy') {
          const config = plain(entry.options.config ?? null)
          f.cmp02.declared.rowPresent = true
          f.cmp02.declared.rowIdAsComposed = id
          f.cmp02.declared.rowFiberState = entry.fiber?.state ?? null
          f.cmp02.declared.rowDisabled = entry.disabled === true
          f.cmp02.declared.configAsComposed = config
          f.cmp02.declared.configKeys = config === null || typeof config !== 'object'
            ? []
            : Object.keys(config)
          // A literal string is what makes the declaration SELF-CONTAINED. An
          // object here is an unresolved `!!js` expression (the loader leaves it
          // as `{__jsExpr: ...}`), which is the shape the v1 FAIL recorded.
          f.cmp02.declared.modeIsLiteral = typeof config?.mode === 'string'
        }
        // The overlay's own rows, recorded by NAME so a reader can see that the
        // only row the probe added is itself. A tool row would show up here as a
        // package name rather than as this probe's module URL.
        if (entryName.includes('/qualification/runners/s11-') || entryName.includes('.probe/s11-')) {
          f.probeAddsNoRow.overlayRows.push({ id, name: entryName })
        }
        if (entry.fiber?.state !== FIBER_ACTIVE && entry.disabled !== true) {
          f.loader.nonActiveEntries.push({
            id: id ?? null,
            name: entryName,
            state: entry.fiber?.state ?? 'never-started',
          })
        }
      }
      f.loader.entryCount = loader.entries().length
      f.cmp02.declared.rowPresent = f.cmp02.declared.rowPresent ?? false
      // The overlay adds exactly one row and it is NOT a tool row. Both halves
      // are recorded so "the probe inserts no tool row" is a reading, not a
      // promise: a row whose `name` resolves to a tool package would appear here.
      f.probeAddsNoRow.overlayToolRows = f.probeAddsNoRow.overlayRows
        .filter(row => !String(row.name).includes('s11-cmp-probe'))
    }

    // ═══ CMP-02.2 — the EFFECTIVE values from the mounted service ═══════════
    const policy = ctx.get('sandboxPolicy')
    f.cmp02.effective.policyServicePresent = policy !== undefined
    if (policy !== undefined) {
      f.cmp02.effective.defaultMode = policy.defaultMode ?? null
      f.cmp02.effective.workspaceRoot = policy.workspaceRoot ?? null
      f.cmp02.effective.workspaceRootIsAbsolute = isAbsolutePath(policy.workspaceRoot)
      try {
        const resolved = policy.resolve({})
        f.cmp02.effective.resolveNoSession = {
          mode: resolved.mode ?? null,
          workspaceRoot: resolved.workspaceRoot ?? null,
        }
      } catch (error) {
        f.cmp02.effective.resolveNoSessionError = String(error?.message ?? error)
      }
    }

    // ═══ the PTC half, recomputed from the same resolved policy ════════════
    const ptc = ctx.get('ptcRuntime')
    f.cmp02.ptc.runtimePresent = ptc !== undefined
    f.cmp02.ptc.runtimeName = ptc === undefined ? null : (Reflect.get(ptc, 'constructor')?.name ?? 'unknown')
    f.cmp02.ptc.sandboxMode = ptc?.sandboxMode ?? null
    if (policy !== undefined) {
      const mode = f.cmp02.effective.resolveNoSession?.mode ?? null
      f.cmp02.ptc.confineDecision = mode === null
        ? 'undecidable: no resolved mode'
        : mode === TRUSTED_LOCAL_MODE
          ? `no confinement (mode is exactly '${TRUSTED_LOCAL_MODE}')`
          : `WOULD CONFINDE (mode is '${mode}', and ptc-runtime-node:224 confines unless mode === '${TRUSTED_LOCAL_MODE}')`
    }

    // ═══ the guard's own verdict on THIS graph ══════════════════════════════
    const contract = ctx.get('noSandboxContract')
    f.cmp02.guard.servicePresent = contract !== undefined
    if (contract !== undefined) {
      const report = contract.checkDeployment()
      f.cmp02.guard.reportOk = report.ok
      f.cmp02.guard.violations = [...report.violations]
      // The startup boundary's own RECORD, so "the guard ran at boot" is read
      // rather than assumed. On a refused deployment the guard's entry dies at
      // `apply`, so this service is absent -- which is why absence is reported
      // as a field rather than treated as an error.
      const history = contract.boundaryHistory()
      const startup = history.find(record => record.boundary === 'startup') ?? null
      f.cmp02.guard.startupBoundaryRecorded = startup !== null
      f.cmp02.guard.startupBoundaryRecord = startup === null ? null : plain(startup)
    }

    // ═══ ONE real Session: CMP-02's per-session half and CMP-04's catalog ═══
    const sc = ctx.get('sessionController')
    const agents = ctx.get('agents')
    tools = ctx.get('tools')

    if (sc === undefined) {
      f.cmp04.error = 'ctx.sessionController is absent, so no real Session could be created'
    } else {
      // The session's cwd is the BOOT's cwd. CMP-04's stimulus fixes the boot
      // cwd to one unrelated to the profile directory, and `resolve()` prefers
      // `session.header.cwd`, so the narration below names this value.
      const cwd = process.cwd()
      f.sessionCwd = cwd
      let created = null
      try {
        created = await sc.create({ cwd })
      } catch (error) {
        f.cmp04.sessionCreateError = `${error?.name ?? 'Error'}: ${error?.message ?? String(error)}`
      }
      const sessionId = created?.sessionId ?? created?.id ?? null
      f.cmp04.sessionId = sessionId
      f.cmp04.agentPreset = created?.agentPreset ?? null
      agent = sessionId === null ? undefined : agents?.get(sessionId)
      f.cmp04.agentPresent = agent !== undefined

      // ── CMP-02.2b: the per-session mode, kept separable from the default ──
      if (policy !== undefined && agent !== undefined) {
        const row = {
          sessionId,
          agentPreset: f.cmp04.agentPreset,
          agentPresent: true,
          override: null,
          resolved: null,
          resolvedWorkspaceRoot: null,
        }
        try {
          row.override = policy.overrideOf(agent.session) ?? null
          const resolved = policy.resolve({ session: agent.session })
          row.resolved = resolved.mode ?? null
          row.resolvedWorkspaceRoot = resolved.workspaceRoot ?? null
        } catch (error) {
          row.error = String(error?.message ?? error)
        }
        f.cmp02.effective.perSession.push(row)
      }

      // ── CMP-02.3: the model-facing narration, by RUNNING the assembly ─────
      const prompt = ctx.get('systemPrompt')
      f.cmp02.narration.systemPromptServicePresent = prompt !== undefined
      if (prompt !== undefined && agent !== undefined) {
        try {
          const assembly = await prompt.assemble({ agent, scope: agent })
          f.cmp02.narration.assembleRan = true
          const contexts = Array.isArray(assembly?.contexts) ? assembly.contexts : []
          f.cmp02.narration.contextNames = contexts.map(entry => String(entry.name))
          const entry = contexts.find(candidate => String(candidate.name) === 'sandbox:policy')
          f.cmp02.narration.policyContextPresent = entry !== undefined
          const text = entry === undefined ? '' : String(entry.text)
          f.cmp02.narration.policyContextText = entry === undefined ? null : text
          f.cmp02.narration.saysConfining = text.includes(CONFINING_MARKER)
          f.cmp02.narration.saysUnconfined = text.includes(UNCONFINED_MARKER)
          // CMP-04's second instrument, read from the SAME assembly call so the
          // two facts are provably about one composition instant.
          const assembled = Array.isArray(assembly?.tools) ? assembly.tools.map(tool => String(tool.name)) : []
          f.cmp04.assembledToolNamesSorted = [...assembled].sort()
          f.cmp04.assembledToolCount = assembled.length
        } catch (error) {
          f.cmp02.narration.assembleError = `${error?.name ?? 'Error'}: ${error?.message ?? String(error)}`
        }
      }

      // ═══ CMP-04: THE catalog, read BEFORE any sentinel exists ═════════════
      if (tools !== undefined && agent !== undefined) {
        try {
          f.cmp04.catalog = readCatalog(tools, agent)
          f.cmp02.ptc.runCodeOnSurface = f.cmp04.catalog.shellEquivalentsPresent.includes('run_code')
        } catch (error) {
          f.cmp04.error = `${error?.name ?? 'Error'}: ${error?.message ?? String(error)}`
        }
      } else if (tools === undefined) {
        f.cmp04.error = 'ctx.tools is absent: there is no model surface to read (a DEPLOYMENT fact, not "the model has no tools")'
      } else {
        f.cmp04.error = 'no live Agent for the created Session, so no agent-keyed catalog exists'
      }

      // ═══ CMP-13, judged from the same catalog ═════════════════════════════
      if (f.cmp04.catalog !== null) {
        f.cmp13.pwshAbsent = f.cmp04.catalog.pwshPresent === false
        f.cmp13.shellEquivalentsPresent = f.cmp04.catalog.shellEquivalentsPresent
        f.cmp13.ipythonPresent = f.cmp04.catalog.ipythonPresent
        f.cmp13.fullNameSetRecorded = f.cmp04.catalog.toolNamesSorted.length === f.cmp04.catalog.toolCount
      }
      // The two instruments, compared rather than both merely recorded. A
      // difference means the registry view and the assembled request header
      // disagree, which would be its own finding -- and reporting a MATCH as
      // "both are right" is exactly the inference this comparison avoids.
      f.cmp04.assembledMatchesRegistry = f.cmp04.assembledToolNamesSorted === null
        ? null
        : JSON.stringify(f.cmp04.assembledToolNamesSorted)
          === JSON.stringify(f.cmp04.catalog?.toolNamesSorted ?? [])

      // The TWO readings, in the same artifact, so a reader does not have to
      // hold two numbers in their head to see whether they agree.
      f.cmp02.effective.defaultModeIsTrustedLocal = f.cmp02.effective.defaultMode === TRUSTED_LOCAL_MODE
      f.cmp02.effective.perSessionResolvesTrustedLocal = f.cmp02.effective.perSession.length > 0
        && f.cmp02.effective.perSession.every(row => row.resolved === TRUSTED_LOCAL_MODE)

      // ═══ THE SENSITIVITY ARM ══════════════════════════════════════════════
      //
      // Everything above this line is the measurement. This is the attempt to
      // BREAK it: register a tool row through the live registry and check that
      // the channel that produced the measurement actually sees it. If it does
      // not, the measurement above cannot distinguish the product's catalog from
      // a probe's, and CMP-04 is unmeasurable by this instrument.
      if (tools !== undefined && agent !== undefined && f.cmp04.catalog !== null) {
        const sensitivity = f.probeAddsNoRow.sensitivity
        sensitivity.before = {
          toolCount: f.cmp04.catalog.toolCount,
          toolNamesSorted: [...f.cmp04.catalog.toolNamesSorted],
        }
        try {
          if (typeof tools.register !== 'function') {
            throw new TypeError('ctx.tools.register is not a function, so the sentinel cannot be registered')
          }
          const dispose = tools.register({
            name: SENTINEL_TOOL_NAME,
            description: 'S11 instrument sensitivity sentinel. Registered and disposed inside one probe read; it is never part of the product catalog.',
            parameters: { type: 'object', properties: {}, additionalProperties: true },
            output: { schema: { type: 'object' }, render: () => [] },
            execute: async () => ({}),
          })
          sensitivity.ran = true
          const afterRegister = readCatalog(tools, agent)
          sensitivity.afterRegister = {
            toolCount: afterRegister.toolCount,
            toolNamesSorted: afterRegister.toolNamesSorted,
          }
          sensitivity.deltaNames = afterRegister.toolNamesSorted
            .filter(candidate => !sensitivity.before.toolNamesSorted.includes(candidate))
          dispose()
          const afterDispose = readCatalog(tools, agent)
          sensitivity.afterDispose = {
            toolCount: afterDispose.toolCount,
            toolNamesSorted: afterDispose.toolNamesSorted,
          }
          // The two claims, computed rather than left to a reader.
          sensitivity.channelDetectsAProbeAddedRow = afterRegister.toolCount === sensitivity.before.toolCount + 1
            && afterRegister.toolNamesSorted.includes(SENTINEL_TOOL_NAME)
          sensitivity.returnedToOriginal = afterDispose.toolCount === sensitivity.before.toolCount
            && !afterDispose.toolNamesSorted.includes(SENTINEL_TOOL_NAME)
          f.probeAddsNoRow.toolRowsRegisteredByProbeBeforeSensitivityArm = 0
        } catch (error) {
          sensitivity.error = `${error?.name ?? 'Error'}: ${error?.message ?? String(error)}`
          f.probeAddsNoRow.toolRowsRegisteredByProbeBeforeSensitivityArm = null
        }
      }
    }
  } catch (error) {
    f.error = `${error?.name ?? 'Error'}: ${error?.message ?? String(error)}`
  }

  // ═══ THE SETTLE RE-READ ═══════════════════════════════════════════════════
  //
  // WHY THIS EXISTS, MEASURED. The first run of this probe reported two entries
  // in a non-ACTIVE state (`ui-deliverables` and this probe itself, both state 1
  // = LOADING). That reading was taken while `apply` was still running, so it is
  // a TIMING fact about the probe's own instant rather than a statement about the
  // composition -- and the product's OWN activation audit, which runs after
  // `loader.await()` (`packages/boot/app-boot/src/index.ts:955-957`), reports
  // zero inactive entries on the same boot. Both readings are correct and they
  // answer different questions.
  //
  // So the probe waits for the tree to settle and reads AGAIN, and the artifact
  // carries both. A difference between them is the finding that the first reading
  // was a race; an entry still non-ACTIVE after settling would be a REAL
  // composition finding, and would show up as such rather than being averaged
  // away. The wait is bounded for the same reason the guard's own startup wait is
  // bounded: an unbounded wait would stop the probe from ever writing its result.
  try {
    const loader = ctx.get('loader')
    if (loader !== undefined) {
      const deadline = Date.now() + SETTLE_WAIT_MS
      while (Date.now() < deadline) {
        await new Promise(resolve => { setTimeout(resolve, 25) })
        const pending = loader.entries().filter(entry => {
          if (entry.disabled === true) return false
          const state = entry.fiber?.state
          return state !== FIBER_ACTIVE && state !== 3 /* FAILED: settled, and a real finding */
        })
        if (pending.length === 0) break
      }
      const after = []
      for (const entry of loader.entries()) {
        if (entry.disabled === true) continue
        const state = entry.fiber?.state
        if (state === FIBER_ACTIVE) continue
        after.push({
          id: entry.options.id ?? null,
          name: String(entry.options.name ?? ''),
          state: state ?? 'never-started',
          // Named explicitly so a reader can tell "settled and failed" (a real
          // finding) from "still loading" (a race).
          classification: state === 3 ? 'FAILED (settled)' : 'NOT SETTLED',
        })
      }
      f.loader.nonActiveEntriesAfterSettle = after
      f.loader.stillNonActiveAfterSettle = after.filter(entry => entry.classification === 'FAILED (settled)')
    }
  } catch (error) {
    f.loader.settleReadError = `${error?.name ?? 'Error'}: ${error?.message ?? String(error)}`
  }

  writeFileSync(OUT, `${JSON.stringify(f, null, 1)}\n`, 'utf8')
  // The probe is a read and it terminates the boot so the harness does not wait
  // for the timeout. This throw is visible on stderr, which is why the loudness
  // pair is measured by a SEPARATE probe-free driver.
  throw new Error('probe-complete')
}
