/**
 * V2 IDENTITY probe: measure the two runtime inputs the deployment identity needs
 * but the lock does not yet carry -- the resolved host graph and the resolved
 * per-Agent tool catalog/schema/ORDER digest.
 *
 * WHY A BOOT IS REQUIRED AND A FILE READ IS NOT ENOUGH.
 * `deployment.inputs.resolved_plugin_graph_digest` is the sha256 of a DUMP FILE
 * (`qualification/results/M3.1-c2-profile/dump-config-daily-candidate.yml`). A dump
 * is what the loader DECLARED; the resolved graph is what it actually ACTIVATED.
 * Those are different facts, and this project has recorded the difference more than
 * twelve times (a row that is mounted but not selected; a package with no
 * `dsh.bundle`; a bundle that activates a layer the profile never reached). So the
 * catalog and the host row table are read from a LIVE boot, and their digests are
 * computed over what the host actually resolved.
 *
 * THE ORDER IS PART OF THE DIGEST, DELIBERATELY.
 * `ctx.tools.schemas(agent)` returns schemas in the order the model reads them.
 * Two boots offering the same 27 names in a different order are a different
 * deployment: the first tool is what the model reaches for. A digest over a SORTED
 * name set would call that change invisible, so the digest covers the order, and
 * the sorted set is recorded beside it for a reader who wants the diff.
 *
 * THE SCHEMA IS PART OF THE DIGEST, DELIBERATELY.
 * A tool whose NAME is stable and whose PARAMETERS changed is a different tool
 * surface. `parameters` is serialised canonically (sorted keys) so that key order
 * in the source does not move the digest but a real parameter change does.
 *
 * WHAT IT DOES NOT DO. It inserts NO tool row and reconfigures NO product row. The
 * one row it adds is ITSELF. A probe that inserted a tool row would make its own
 * catalog a measurement of the overlay -- the G-FIX-04 / G-FIX-05 / G-FIX-12 defect
 * class. It does not judge anything: it reports numbers, and the runner decides.
 */
import { createHash } from 'node:crypto'
import { writeFileSync } from 'node:fs'

export const name = 'v2-identity-probe'

// `inject` is a READINESS GATE, so it names ONLY the service without which no
// measurement is possible. Naming a service the probe wants to ASSERT would mean
// the probe never runs when that service is missing, and the artifact would be
// ABSENT rather than reporting `false` -- the opposite of honest.
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

/** The repository root of the tree THIS FILE was loaded from. */
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..').replace(/\\/g, '/')

export const inject = ['sessionController']

const OUT = process.env.DSH_PROBE_OUT
  ?? join(REPO_ROOT, 'qualification/results/trusted-local-v2/probe.json')

/**
 * The cwd a SESSION is created with, which is NOT the boot cwd.
 *
 * MEASURED FAILURE THIS FIELD EXISTS FOR. The first run of this probe created its
 * session with `process.cwd()`. The driver deliberately boots from a FOREIGN cwd
 * (`C:/`) to establish that the preset root is anchored at the profile rather than
 * at the process cwd -- and session creation then failed outright:
 *
 *     RemoteError: failed to create session ... Error: failed to ensure project
 *     directory "C:\\": Error: EPERM: operation not permitted, mkdir 'C:\\'
 *
 * So `tools=0` with `namesInHeaderOrder=[]` was a measurement of a FAILED SESSION,
 * not of an empty catalog. Reading that as "the product offers the model no tools"
 * would have been a false finding about the product caused by the probe's own
 * argument -- the same defect class as G-FIX-06. The boot cwd stays foreign; the
 * SESSION cwd is named explicitly and is a real directory.
 */
const SESSION_CWD = process.env.V2_IDENTITY_SESSION_CWD ?? REPO_ROOT

/** FiberState.ACTIVE === 2 (`vendor/cordis/src/fiber.ts:147-155`). */
const FIBER_ACTIVE = 2

/** Deterministic serialisation: sorted object keys, no whitespace. */
function canonical(value) {
  return JSON.stringify(sortKeys(value))
}

/**
 * Wait, with a DEADLINE, until every loader entry other than this probe's own is
 * settled, then report whether it settled.
 *
 * WHY THIS IS NECESSARY FOR AN IDENTITY INPUT, measured rather than supposed. Two
 * consecutive boots of this same tree produced DIFFERENT host-graph digests
 * (`rows=177 active=145` then `rows=177 active=144`), because `hmr` and
 * `ui-deliverables` were still in FiberState.LOADING (1) at the moment the first
 * probe sampled and had reached ACTIVE (2) by the second. A digest over a tree that
 * is still moving is not an identity: it would report runtime drift on every boot
 * and make the mutation test meaningless. So the probe WAITS for the tree to stop
 * moving, and records how long it waited and what was still moving if it did not.
 *
 * WHY NOT `loader.await()`. The obvious call is a DEADLOCK, and it is worth writing
 * down because it looks correct: `EntryTree.await()` loops while `getTasks()` is
 * non-empty, `getTasks()` maps every entry to `entry._initTask || entry.fiber?.inertia`
 * (`vendor/loader/src/config/tree.ts:36-49`), and a fiber's `inertia` is the promise
 * of its CURRENT lifecycle job (`vendor/cordis/src/fiber.ts:629-635`) -- which, while
 * this probe's own `apply` is running, IS the call to `apply`. So `await()` would
 * spin forever waiting on itself.
 *
 * The wait is BOUNDED, and a tree that does not settle is recorded as NOT SETTLED
 * rather than silently digested anyway: an unsettled graph is not a stable identity
 * input, and the driver fails on it.
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
    note: "loader.await() is NOT used: it waits on this probe's own fiber inertia and would deadlock.",
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

export async function apply(ctx) {
  const f = {
    probe: 'v2-identity',
    schemaVersion: 1,
    ranAt: new Date().toISOString(),
    // Reported FIRST and unconditionally: this is the ownership guard. A probe
    // writing to a shared path cannot be checked for ownership without it.
    presetRoots: [],
    presetDefaultId: null,
    dshHome: process.env.DSH_HOME ?? null,
    nodeVersion: process.version,
    execPath: process.execPath,
    cwd: process.cwd(),
    error: null,
    // ── whether the tree had stopped moving when it was read ────────────────
    settle: null,
    // ── the resolved HOST graph, as actually activated ──────────────────────
    hostGraph: {
      rowCount: 0,
      activeRowCount: 0,
      rows: [],
      digest: null,
      sortedRowIdsDigest: null,
    },
    // ── the resolved per-AGENT tool catalog ─────────────────────────────────
    agentCatalog: {
      sessionCreated: false,
      sessionId: null,
      toolCount: 0,
      namesInHeaderOrder: [],
      namesSorted: [],
      schemaDigest: null,
      orderDigest: null,
      parametersByName: {},
      error: null,
    },
  }

  try {
    const roster = ctx.get('agentPresets')
    if (roster !== undefined) {
      f.presetDefaultId = roster.defaultId ?? null
      f.presetRoots = (roster.roots ?? [])
        .map(root => ({ path: String(root.path), trust: String(root.trust) }))
    }

    // ── (1) the host row table, read from the live loader ────────────────────
    // FIRST settle the tree, then read it. Reading a tree that is still loading
    // produced two different digests on two consecutive boots of the same build.
    f.settle = await waitForSettle(ctx, Number(process.env.V2_IDENTITY_SETTLE_MS ?? 30_000))

    const loader = ctx.get('loader')
    if (loader === undefined) {
      f.error = 'ctx.loader is absent: the probe cannot audit the resolved host graph'
    } else {
      const raw = []
      for (const entry of loader.entries()) {
        const id = entry.options?.id
        if (id === undefined) continue
        if (id === name) continue // the probe is not part of the product
        raw.push({
          id: String(id),
          moduleName: entry.options?.name === undefined ? null : String(entry.options.name),
          fiberState: entry.fiber?.state ?? null,
          active: entry.fiber?.state === FIBER_ACTIVE,
        })
      }

      // ── THE AUTO-GENERATED-ID PROBLEM, measured rather than supposed ──────
      //
      // Two consecutive boots of this SAME build produced different host-graph
      // digests with identical row counts and identical activation states. The
      // cause is in the product's loader, not in the probe:
      //
      //     vendor/loader/src/config/tree.ts:54
      //       options.id = Math.random().toString(16).slice(2, 10)
      //
      // A row that declares no `id` is given a RANDOM 8-hex-digit id at every
      // boot. Four such rows exist in this composition (two
      // `dsh-host-directory-picker-native`, two
      // `dsh-client-ui-directory-picker-native`), so a digest over raw ids would
      // report RUNTIME DRIFT on every single boot -- and a mutation test built on
      // it would prove nothing, because everything would look like drift.
      //
      // The fix is NOT to drop the rows: their presence and activation are real
      // facts, and dropping them would make the digest blind to a directory-picker
      // row failing to activate. The fix is to key them by the STABLE fact -- their
      // module -- and record the excluded ids explicitly, so the substitution is
      // visible in the artifact rather than silent.
      const autoId = /^[0-9a-f]{8}$/
      const autoGenerated = raw.filter(row => autoId.test(row.id))
      const stable = raw.filter(row => !autoId.test(row.id))

      // A stable row key: the declared id when there is one, otherwise the module
      // name plus its ordinal among same-module auto-id rows (the two directory
      // picker modules each appear twice, so the ordinal keeps them distinct
      // without inventing an identity).
      const ordinals = {}
      const keyed = stable.map(row => ({ key: row.id, ...row }))
      for (const row of autoGenerated.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
        const base = `auto-id:${row.moduleName ?? 'unknown'}`
        ordinals[base] = (ordinals[base] ?? 0) + 1
        keyed.push({ key: `${base}#${String(ordinals[base])}`, ...row })
      }
      keyed.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))

      const digested = keyed.map(row => ({
        key: row.key,
        moduleName: row.moduleName,
        fiberState: row.fiberState,
        active: row.active,
      }))

      f.hostGraph.rows = digested
      f.hostGraph.rowCount = digested.length
      f.hostGraph.activeRowCount = digested.filter(row => row.active).length
      // The digest covers the STABLE key + module + ACTIVATION STATE. Activation is
      // the fact a declared dump cannot supply, so leaving it out would make the
      // digest blind to the exact defect class it exists to catch.
      //
      // It is computed over the SETTLED tree, and `settled` is recorded beside it.
      // An unsettled tree still gets a digest -- omitting one would turn a race into
      // an absent field -- but the driver refuses the measurement, so a moving graph
      // can never be bound into the runtime identity.
      f.hostGraph.digest = digest(canonical(digested))
      f.hostGraph.sortedRowIdsDigest = digest(canonical(digested.map(row => row.key)))
      f.hostGraph.measuredAfterSettle = f.settle.settled
      f.hostGraph.autoGeneratedIdRows = {
        count: autoGenerated.length,
        modules: [...new Set(autoGenerated.map(row => row.moduleName))].sort(),
        why: ('vendor/loader/src/config/tree.ts:54 assigns '
              + '`options.id = Math.random().toString(16).slice(2, 10)` to any row that '
              + 'declares no id, so these ids differ on every boot. They are keyed by '
              + 'MODULE in the digest, and the raw ids are recorded here rather than '
              + 'discarded, so the substitution is visible. The rows are NOT dropped: '
              + 'their presence and activation are real facts this digest must cover.'),
        rawIdsObservedThisBoot: autoGenerated.map(row => row.id).sort(),
      }
    }

    // ── (2) the per-Agent tool catalog, for a REAL Session ──────────────────
    const sc = ctx.get('sessionController')
    const created = await sc.create({ cwd: SESSION_CWD })
    const sessionId = created?.sessionId ?? created?.id ?? null
    f.agentCatalog.sessionId = sessionId
    f.agentCatalog.sessionCreated = sessionId !== null
    f.agentCatalog.sessionCwd = SESSION_CWD

    const agent = ctx.get('agents')?.get(sessionId)
    if (agent === undefined) {
      f.agentCatalog.error = 'the created session has no live agent in this process'
    } else {
      // The AGENT OBJECT is the scope key, not its context: AgentLoop builds the
      // scope with `createScope(loopCtx, this)` and DSH's own PTC harvests with
      // `registry.schemas(exec.agent)`. Passing `agent.ctx` yields a key owning no
      // scope layer and collapses the view to the global layer, which holds zero
      // agent tools -- the false negative recorded as G-FIX-06.
      const schemas = ctx.get('tools').schemas(agent)
      f.agentCatalog.toolCount = schemas.length
      f.agentCatalog.namesInHeaderOrder = schemas.map(schema => schema.name)
      f.agentCatalog.namesSorted = [...f.agentCatalog.namesInHeaderOrder].sort()
      f.agentCatalog.parametersByName = Object.fromEntries(
        schemas.map(schema => [schema.name, sortKeys(plain(schema.parameters ?? {}))]),
      )
      // ORDER is covered: the digest is over the array as returned, not over a sort.
      f.agentCatalog.orderDigest = digest(canonical(f.agentCatalog.namesInHeaderOrder))
      // SCHEMA is covered: names in header order, each with its canonical parameters.
      f.agentCatalog.schemaDigest = digest(canonical(
        schemas.map(schema => [schema.name, sortKeys(plain(schema.parameters ?? {}))]),
      ))
    }
  } catch (error) {
    f.error = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
  }

  writeFileSync(OUT, `${JSON.stringify(f, null, 2)}\n`)
}
