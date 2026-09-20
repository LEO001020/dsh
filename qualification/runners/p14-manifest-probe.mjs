/**
 * P14 MANIFEST PROBE: observe the ACTUAL resolved runtime graph and the ACTUAL
 * model tool catalog from a live boot of the exact built candidate.
 *
 * WHY A LIVE BOOT IS THE ONLY ACCEPTABLE SOURCE, stated as the project measured it.
 *
 * V5 section 14: "Graph dump must be freshly observed from exact built candidate.
 * Static import scan remains useful but is NOT the runtime graph proof."
 *
 * This project has the measurement that makes that concrete. `homelock.ts:126`
 * holds a module specifier IN A VARIABLE, so a parser cannot see it; and
 * `qualification/results/ROOT-round2/identity-input-unchecked-and-stale.md`
 * records that the old identity's `resolved_plugin_graph_digest` was the sha256 of
 * a DUMP FILE -- what the loader DECLARED -- from a commit BEFORE F3, whose
 * `sandbox-policy.mode` still reads the confining `workspace-write`. So an
 * identity input certified a graph in which the deployment resolved to the exact
 * defect CMP-02 exists to catch. A dump is not a graph.
 *
 * WHY IT RESOLVES REALPATHS RATHER THAN READING `name:`.
 *
 * V5 section 18 requires GRAPH-REALPATH: "a foreign worktree or module realpath
 * must FAIL the gate". This project has retracted two root-agent findings
 * (G-SEAM-29, G-SEAM-36) because a measurement ran against the wrong tree, and
 * `cross-tree-paths.test.ts` exists because of `G-SEAM-66`. Reading a row's
 * `name:` cannot answer the question: `dsh-daily-work/host` is a SPECIFIER, and
 * WHICH FILE it lands on depends on the resolution roots -- the profile's
 * `node_modules` links, which `helpers/new-writer.ps1` rewrites per writer. So the
 * realpath is obtained by asking the SAME resolver the loader uses:
 *
 *     loader.internal.resolveSync(baseUrl, { specifier })   // Node 24 shape (v2)
 *     loader.internal.resolveSync(specifier, baseUrl, {})   // Node 22 shape (v1)
 *
 * and then `realpathSync(fileURLToPath(url))`, which collapses a symlink to its
 * target. That is the value a foreign tree cannot fake: a boot from another
 * worktree resolves its own package, and the manifest then names THAT tree.
 *
 * WHAT IT DOES NOT DO.
 *  - It inserts NO tool row and NO product row. The one row it adds is ITSELF, and
 *    it excludes its own row from the graph it digests, so the catalog it reads is
 *    the catalog the PRODUCT composes. A probe that inserted a tool row would make
 *    its own catalog a measurement of the overlay -- the G-FIX-04/G-FIX-05/G-FIX-12
 *    defect class this project has recorded repeatedly.
 *  - It does NOT judge. It reports numbers and paths; the generator decides, and
 *    the generator's GRAPH-REALPATH check is where a foreign tree fails.
 *  - It does NOT treat an unresolved row as absent. A row whose specifier does not
 *    resolve is recorded with its error, because "the resolver refused this" and
 *    "this row does not exist" are different facts and only one of them is a
 *    composition failure.
 *
 * @module p14-manifest-probe
 */
import { createHash } from 'node:crypto'
import { realpathSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

export const name = 'p14-manifest-probe'

// `inject` is a READINESS GATE, so it names ONLY the services without which no
// measurement is possible. Naming a service the probe wants to ASSERT would mean
// the probe never runs when that service is missing, and the artifact would be
// ABSENT rather than reporting `false` -- the opposite of honest.
export const inject = ['sessionController']

/** FiberState.ACTIVE === 2 (`vendor/cordis/src/fiber.ts:147-155`). */
const FIBER_ACTIVE = 2

/**
 * The cwd a SESSION is created with, which is NOT the boot cwd.
 *
 * MEASURED FAILURE THIS FIELD EXISTS FOR. A probe that created its session with
 * `process.cwd()` while the driver deliberately booted from a FOREIGN cwd (`C:/`)
 * got `EPERM: operation not permitted, mkdir 'C:\'` and reported `tools=0` with an
 * empty catalog -- a measurement of a FAILED SESSION read as an empty product
 * surface. The boot cwd stays foreign (that is what proves the preset root is
 * anchored at the profile); the SESSION cwd is named explicitly.
 */
const SESSION_CWD = process.env.P14_SESSION_CWD ?? process.cwd()

/** Deterministic serialisation: sorted object keys, no whitespace. */
function canonical(value) {
  return JSON.stringify(sortKeys(value))
}

function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value).sort().map(key => [key, sortKeys(value[key])]),
    )
  }
  return value
}

function digest(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/** Serialise a live value without letting a cycle abort the probe. */
function plain(value) {
  try {
    return JSON.parse(JSON.stringify(value))
  } catch (error) {
    return `unserialisable: ${error instanceof Error ? error.message : String(error)}`
  }
}

/**
 * Wait, with a DEADLINE, until every loader entry other than this probe's own is
 * settled, then report whether it settled.
 *
 * WHY THIS IS NECESSARY FOR AN IDENTITY INPUT, measured rather than supposed. Two
 * consecutive boots of this same tree produced DIFFERENT host-graph digests
 * (`rows=177 active=145` then `rows=177 active=144`), because `hmr` and
 * `ui-deliverables` were still in FiberState.LOADING at the moment the first probe
 * sampled. A digest over a tree that is still moving is not an identity.
 *
 * WHY NOT `loader.await()`. The obvious call is a DEADLOCK: `EntryTree.await()`
 * loops while `getTasks()` is non-empty, and a fiber's `inertia` is the promise of
 * its CURRENT lifecycle job (`vendor/cordis/src/fiber.ts:629-635`) -- which, while
 * this probe's own `apply` is running, IS the call to `apply`. So `await()` would
 * spin forever waiting on itself.
 */
async function waitForSettle(ctx, timeoutMs) {
  const record = {
    method: 'poll loader.entries() for non-ACTIVE non-disabled entries, excluding this probe row',
    excludedOwnRowId: name,
    timeoutMs,
    settled: false,
    waitedMs: 0,
    entryCount: null,
    stillMoving: [],
    note: 'loader.await() is NOT used: it waits on this probe\'s own fiber inertia and would deadlock.',
  }
  const loader = ctx.get('loader')
  if (loader === undefined) {
    record.stillMoving.push('ctx.loader is absent; the tree cannot be observed')
    return record
  }
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    const moving = []
    let total = 0
    for (const entry of loader.entries()) {
      total += 1
      if (entry.options.id === name) continue
      let disabled = false
      try {
        disabled = entry.disabled === true
      } catch {
        // A throwing `disabled` expression is itself an entry failure; treat it as
        // settled so it is reported rather than waited on.
        continue
      }
      if (disabled) continue
      const state = entry.fiber?.state ?? null
      if (state !== FIBER_ACTIVE) moving.push({ id: entry.options.id, state })
    }
    record.entryCount = total
    record.stillMoving = moving
    if (moving.length === 0) {
      record.settled = true
      break
    }
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  record.waitedMs = Date.now() - started
  return record
}

/**
 * A specifier the LOADER resolves itself, with no file behind it.
 *
 * WHY THIS IS A CLASSIFICATION AND NOT A TOLERATED FAILURE, measured rather than
 * supposed. The first run of this probe reported `cordis:include` as UNRESOLVED
 * (`ERR_INVALID_URL_SCHEME: The URL must be of scheme file`) and the driver's
 * "every row resolved to a realpath" check went RED. The check was right to fire
 * and the row is not a defect: `EntryTree.import()` short-circuits any specifier
 * beginning `cordis:` to `this.ctx.loader.builtins[name.slice(7)]`
 * (`vendor/loader/src/config/tree.ts:118-121`), so a builtin has NO FILE by
 * construction and there is nothing to realpath.
 *
 * THE ALTERNATIVE WOULD HAVE BEEN TO WEAKEN THE CHECK to "at most N unresolved
 * rows", which would have made the check unable to distinguish a builtin from a
 * package that failed to resolve -- and a failed resolution is EXACTLY the
 * composition defect this graph exists to catch. So the builtin is named as a
 * builtin, and every OTHER row must resolve.
 *
 * The set is closed by the loader's own implementation (`cordis:` prefix), not by
 * a list of known names, so a new builtin is covered without an edit here.
 */
function isLoaderBuiltin(specifier) {
  return typeof specifier === 'string' && specifier.startsWith('cordis:')
}

/**
 * Resolve one specifier to a URL with the SAME resolver the loader uses.
 *
 * THE SHAPE DEPENDS ON NODE, NOT ON A VERSION TEST. `ModuleLoader.fromInternal`
 * classifies by which module-job API the loader owns, never by Node version,
 * because v2 landed in 24.12.0 and a major-version test mistags every 24.0-24.11.1
 * loader as v2 and makes consumers call `resolveSync` with reversed parameters.
 * (`vendor/loader/src/internal.ts:117-133`.) Arity is not usable either --
 * `resolveSync` reports 2 under both shapes. So the version TAG is read, and the
 * same tag DSH's own HMR service switches on is used (`packages/boot/hmr/src/index.ts:189-193`).
 */
function resolveSpecifier(loader, baseUrl, specifier) {
  if (isLoaderBuiltin(specifier)) {
    // Recorded as a RESOLVED row with `builtin: true` and no realpath, so the row
    // still contributes to the composition digest (its presence and activation are
    // real facts) while being excluded from the realpath set by CLASSIFICATION
    // rather than by an exception.
    return { url: null, realpath: null, builtin: true, error: null }
  }
  const internal = loader.internal
  if (internal === undefined) {
    return { url: null, realpath: null, builtin: false, error: 'ctx.loader.internal is absent: no resolver is reachable' }
  }
  let url
  try {
    const resolved = internal.version === 'v2'
      ? internal.resolveSync(baseUrl, { specifier })
      : internal.resolveSync(specifier, baseUrl, {})
    url = resolved?.url ?? null
  } catch (error) {
    return { url: null, realpath: null, builtin: false, error: `${error?.code ?? error?.name ?? 'Error'}: ${String(error?.message ?? error).slice(0, 300)}` }
  }
  if (url === null) {
    return { url: null, realpath: null, builtin: false, error: 'the resolver returned no url' }
  }
  // `realpathSync` collapses a symlink to its target, which is the whole point:
  // the profile's node_modules entries are `link:` symlinks into a checkout, and a
  // foreign checkout's link resolves to the FOREIGN tree. The URL alone would show
  // the link; the realpath shows where it points.
  let realpath
  try {
    realpath = realpathSync(fileURLToPath(url)).replace(/\\/g, '/')
  } catch (error) {
    return { url, realpath: null, builtin: false, error: `realpath failed: ${error?.code ?? error?.name}: ${String(error?.message ?? error).slice(0, 200)}` }
  }
  return { url, realpath, builtin: false, error: null }
}

export async function apply(ctx) {
  const f = {
    probe: 'p14-manifest',
    schemaVersion: 1,
    ranAt: new Date().toISOString(),
    // Reported FIRST and unconditionally: this is the ownership guard. A probe
    // writing to a shared path cannot be checked for ownership without it.
    dshHome: process.env.DSH_HOME ?? null,
    presetRoots: [],
    presetDefaultId: null,
    nodeVersion: process.version,
    execPath: process.execPath,
    cwd: process.cwd(),
    error: null,
    settle: null,
    // The resolver actually used, so a reader can reproduce the shape.
    resolver: null,
    graph: {
      rowCount: 0,
      activeRowCount: 0,
      resolvedRowCount: 0,
      unresolvedRows: [],
      rows: [],
      digest: null,
      rowsDigest: null,
      realpathDigest: null,
      autoGeneratedIdRows: null,
    },
    extensionRows: [],
    catalog: {
      sessionCreated: false,
      sessionId: null,
      sessionCwd: SESSION_CWD,
      toolCount: 0,
      namesInHeaderOrder: [],
      namesSorted: [],
      schemaDigest: null,
      orderDigest: null,
      hasRunCode: null,
      error: null,
    },
    // Selected rows whose CONFIG is a manifest fact rather than a graph fact. Read
    // from `options.config` (what the loader was given) -- see the report for why
    // this is the declared value and not the schema-resolved one.
    selectedRowConfigs: {},
  }

  try {
    const roster = ctx.get('agentPresets')
    if (roster !== undefined) {
      f.presetDefaultId = roster.defaultId ?? null
      f.presetRoots = (roster.roots ?? [])
        .map(root => ({ path: String(root.path), trust: String(root.trust) }))
    }

    const loader = ctx.get('loader')
    if (loader === undefined) {
      f.error = 'ctx.loader is absent: the probe cannot audit the resolved host graph'
      writeFileSync(process.env.P14_OUT, `${JSON.stringify(f, null, 2)}\n`)
      return
    }
    f.resolver = loader.internal === undefined
      ? null
      : { version: loader.internal.version, shape: loader.internal.version === 'v2' ? 'resolveSync(baseUrl, {specifier})' : 'resolveSync(specifier, baseUrl, {})' }

    // FIRST settle the tree, then read it. Reading a tree that is still loading
    // produced two different digests on two consecutive boots of the same build.
    f.settle = await waitForSettle(ctx, Number(process.env.P14_SETTLE_MS ?? 30_000))

    const baseUrl = loader.ctx.baseUrl
    f.baseUrl = baseUrl

    const raw = []
    for (const entry of loader.entries()) {
      const id = entry.options?.id
      if (id === undefined) continue
      if (id === name) continue // the probe is not part of the product
      raw.push({
        id: String(id),
        name: entry.options?.name === undefined ? null : String(entry.options.name),
        fiberState: entry.fiber?.state ?? null,
        active: entry.fiber?.state === FIBER_ACTIVE,
      })
    }

    // ── THE AUTO-GENERATED-ID PROBLEM, measured rather than supposed ────────
    //
    // `vendor/loader/src/config/tree.ts:54` assigns
    // `options.id = Math.random().toString(16).slice(2, 10)` to any row that
    // declares no id. Four such rows exist in this composition, so a digest over
    // raw ids would report RUNTIME DRIFT on every single boot -- and a mutation
    // test built on it would prove nothing, because everything would look like
    // drift.
    //
    // The fix is NOT to drop the rows: their presence and activation are real
    // facts, and dropping them would make the digest blind to a directory-picker
    // row failing to activate. The fix is to key them by the STABLE fact -- their
    // module -- and record the excluded ids explicitly, so the substitution is
    // visible in the artifact rather than silent.
    const autoId = /^[0-9a-f]{8}$/
    const autoGenerated = raw.filter(row => autoId.test(row.id))
    const stable = raw.filter(row => !autoId.test(row.id))

    const ordinals = {}
    const keyed = stable.map(row => ({ key: row.id, ...row }))
    for (const row of autoGenerated.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
      const base = `auto-id:${row.moduleName ?? row.name ?? 'unknown'}`
      ordinals[base] = (ordinals[base] ?? 0) + 1
      keyed.push({ key: `${base}#${String(ordinals[base])}`, ...row })
    }
    keyed.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))

    // ── RESOLVE EVERY ROW. This is the part a static scan cannot do. ─────────
    const resolvedRows = keyed.map((row) => {
      const resolution = row.name === null
        ? { url: null, realpath: null, builtin: false, error: 'the row declares no module specifier' }
        : resolveSpecifier(loader, baseUrl, row.name)
      return {
        key: row.key,
        name: row.name,
        fiberState: row.fiberState,
        active: row.active,
        resolvedUrl: resolution.url,
        realpath: resolution.realpath,
        loaderBuiltin: resolution.builtin,
        resolveError: resolution.error,
      }
    })

    f.graph.rows = resolvedRows
    f.graph.rowCount = resolvedRows.length
    f.graph.activeRowCount = resolvedRows.filter(row => row.active).length
    // `resolvedRowCount` counts rows with a realpath. `builtinRowCount` counts the
    // rows that CANNOT have one by construction, so the two together must equal the
    // row count -- which is what makes "every row resolved" a falsifiable check
    // rather than a weakened one.
    f.graph.resolvedRowCount = resolvedRows.filter(row => row.realpath !== null).length
    f.graph.builtinRowCount = resolvedRows.filter(row => row.loaderBuiltin).length
    f.graph.unresolvedRows = resolvedRows
      .filter(row => row.realpath === null && !row.loaderBuiltin)
      .map(row => ({ key: row.key, name: row.name, resolveError: row.resolveError }))

    // THREE DIGESTS, because they answer three different questions and collapsing
    // them would hide which one moved.
    //   digest        key + module + activation   -- "is the composition the same"
    //   rowsDigest    key + module + activation + RESOLVED URL
    //                                             -- "does it still load the same files"
    //   realpathDigest key + REALPATH             -- "does it still load the same TREE"
    // The realpath digest is the one GRAPH-REALPATH turns on: a boot from a foreign
    // worktree has an identical composition and an entirely different realpath set.
    // Builtin rows enter it as an explicit marker, so a builtin row that CHANGED is
    // still visible while a builtin can never be mistaken for a resolved file.
    f.graph.digest = digest(canonical(resolvedRows.map(r => ({ key: r.key, name: r.name, fiberState: r.fiberState, active: r.active }))))
    f.graph.rowsDigest = digest(canonical(resolvedRows.map(r => ({ key: r.key, name: r.name, active: r.active, resolvedUrl: r.resolvedUrl }))))
    f.graph.realpathDigest = digest(canonical(resolvedRows.map(r => ({
      key: r.key,
      realpath: r.loaderBuiltin ? '<loader-builtin:no-file>' : r.realpath,
    }))))
    f.graph.measuredAfterSettle = f.settle.settled
    f.graph.autoGeneratedIdRows = {
      count: autoGenerated.length,
      modules: [...new Set(autoGenerated.map(row => row.name))].sort(),
      why: ('vendor/loader/src/config/tree.ts:54 assigns '
            + '`options.id = Math.random().toString(16).slice(2, 10)` to any row that '
            + 'declares no id, so these ids differ on every boot. They are keyed by '
            + 'MODULE in the digest, and the raw ids are recorded here rather than '
            + 'discarded, so the substitution is visible. The rows are NOT dropped: '
            + 'their presence and activation are real facts this digest must cover.'),
      rawIdsObservedThisBoot: autoGenerated.map(row => row.id).sort(),
    }

    // ── THE EXTENSION ROWS, called out because GRAPH-REALPATH is about them ──
    //
    // The two in-repo packages are THE IMPLEMENTATION. A manifest that named only
    // their digests would be satisfied by a boot that loaded a SIBLING's copy of
    // them, which is the exact failure G-SEAM-29/G-SEAM-36 were retracted for. So
    // their resolved realpaths are lifted out of the row table by NAME (the
    // specifier prefix is the package name, which is stable) rather than by row id
    // (which a composition may rename).
    f.extensionRows = resolvedRows
      .filter(row => typeof row.name === 'string' && /^dsh-daily-work(\/|$)|^dsh-ipython(\/|$)/.test(row.name))
      .map(row => ({ key: row.key, name: row.name, realpath: row.realpath, active: row.active, resolveError: row.resolveError }))

    // ── SELECTED ROW CONFIGS that are manifest facts ────────────────────────
    const WANTED_CONFIGS = [
      'tools', 'subagent', 'sandbox-policy', 'agent-presets', 'agent-default-model',
      'daily-work-host', 'ipython-kernel-host', 'agent-loop', 'webserver',
    ]
    for (const entry of loader.entries()) {
      const id = String(entry.options?.id ?? '')
      if (!WANTED_CONFIGS.includes(id)) continue
      f.selectedRowConfigs[id] = {
        name: entry.options?.name ?? null,
        config: plain(entry.options?.config ?? null),
        note: ('`options.config` is the value the LOADER was given, including '
               + '`!!js` expressions as `{__jsExpr: ...}`. It is NOT the schema-resolved '
               + 'config: a key the row omits has its schema default applied at plugin '
               + 'construction, which the probe cannot read without reaching into the '
               + 'plugin instance. So a reader must not read a missing key here as '
               + '"no value" -- see the report\'s named gap on resolved defaults.'),
      }
    }

    // ── THE PER-AGENT TOOL CATALOG, for a REAL Session ──────────────────────
    const sc = ctx.get('sessionController')
    const created = await sc.create({ cwd: SESSION_CWD })
    const sessionId = created?.sessionId ?? created?.id ?? null
    f.catalog.sessionId = sessionId
    f.catalog.sessionCreated = sessionId !== null

    const agent = ctx.get('agents')?.get(sessionId)
    if (agent === undefined) {
      f.catalog.error = 'the created session has no live agent in this process'
    } else {
      // The AGENT OBJECT is the scope key, not its context: AgentLoop builds the
      // scope with `createScope(loopCtx, this)` and DSH's own PTC harvests with
      // `registry.schemas(exec.agent)`. Passing `agent.ctx` yields a key owning no
      // scope layer and collapses the view to the global layer, which holds zero
      // agent tools -- the false negative recorded as G-FIX-06.
      const schemas = ctx.get('tools').schemas(agent)
      f.catalog.toolCount = schemas.length
      f.catalog.namesInHeaderOrder = schemas.map(schema => schema.name)
      f.catalog.namesSorted = [...f.catalog.namesInHeaderOrder].sort()
      // ORDER is covered: the digest is over the array as returned, not over a sort.
      // Two boots offering the same names in a different order are a different
      // deployment: the first tool is what the model reaches for.
      f.catalog.orderDigest = digest(canonical(f.catalog.namesInHeaderOrder))
      // SCHEMA is covered: names in header order, each with its canonical parameters.
      f.catalog.schemaDigest = digest(canonical(
        schemas.map(schema => [schema.name, sortKeys(plain(schema.parameters ?? {}))]),
      ))
      // A NEGATIVE OBSERVATION THAT DECIDES THE PRESENTATION MODE. `run_code` exists
      // only under `ptc`/`both` (`packages/core/tools/src/index.ts:1331`: a native
      // name is denied when `modeFor(scope) === 'ptc'` and the name is not
      // RUN_CODE_NAME). Its ABSENCE from a non-empty catalog is therefore positive
      // evidence of `native`, which is the requirement compatibility.expected.json
      // declares -- and it is measured rather than read from a config file.
      f.catalog.hasRunCode = f.catalog.namesInHeaderOrder.includes('run_code')
    }
  } catch (error) {
    f.error = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
  }

  writeFileSync(process.env.P14_OUT, `${JSON.stringify(f, null, 2)}\n`)
}
