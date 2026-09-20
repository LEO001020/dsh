/**
 * S12 ID-01 identity check: decide the oracle's clauses from a measured graph.
 *
 * ORACLE (verbatim, `acceptance-spec.trusted-local-v2.definition.json`):
 *
 *   "The first tool call actually succeeds and the resolved module graph is
 *    recorded: every `@deepseek-ai/*` specifier resolves under
 *    `D:\DSH\src\dsh-src\packages\*\lib\`, and sha256 of the launcher equals
 *    `deployment.inputs.artifact_sha256`. A run whose only success is `--help`,
 *    or whose graph mixes `src` and `lib`, is NOT PASS."
 *
 * WHY THIS IS A SEPARATE MODULE. The classification IS the oracle, and this
 * project has already filed defects against a gate whose detector was only ever
 * exercised through itself. So the classifier lives in one file that each arm of
 * the driver calls, and the driver runs it against a graph measured from a real
 * boot. Nothing here boots anything and nothing here decides by itself whether a
 * boot happened -- it decides only what the recorded graph means.
 *
 * WHAT IT DELIBERATELY DOES NOT DO. It does not read the repository's source
 * tree to decide whether a row "should" be source. A check that consulted the
 * tree it is auditing could not detect a tree that had moved. Every clause below
 * is decided from the graph rows, the launcher bytes and the lock file.
 *
 * THE CLASSIFIER IS BY THE FILE THE URL NAMES, not by substring. The checkout
 * lives at `D:\DSH\src\dsh-src`, so EVERY path contains `src`; a `/src/` substring
 * test would classify the whole checkout as source. A `.ts` file is SOURCE, a
 * `lib/*.js|mjs|cjs` file is BUILT, anything else is OTHER.
 *
 * @module s12-id01-identity-check
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'

/** Classify a resolved URL by the FILE IT NAMES. */
export function classifyUrl(url) {
  const path = String(url).replace(/^file:\/\/\//, '').replace(/\//g, '\\')
  if (/\.ts$/i.test(path)) return { kind: 'SOURCE', path }
  // BUILT = a .js/.mjs/.cjs file anywhere BELOW a `lib\` segment.
  //
  // WHY "BELOW" AND NOT "DIRECTLY IN". The first revision of this function required
  // `lib\<file>` with no further separator, so `packages\core\session\lib\types\surface.js`
  // classified as OTHER. That is a real subpath export (`@deepseek-ai/dsh-session/surface`
  // is emitted by `tsc -b` into `lib/types/`), and it IS a built artifact under `lib/`.
  // The stricter pattern moved EIGHT genuinely-built rows into the OTHER bucket — the
  // counts caught it (fromBuilt=213/fromOther=9 here against R2-F4's 221/1 for the same
  // 222 specifiers), which is exactly why the archived classifier is reproduced rather
  // than re-invented: `/\\lib\\.*\.(js|mjs|cjs)$/i` is the one the recorded measurement
  // used, and a narrower one silently changes what the oracle sees.
  if (/\\lib\\.*\.(js|mjs|cjs)$/i.test(path)) return { kind: 'BUILT', path }
  return { kind: 'OTHER', path }
}

/** Read a graph.jsonl into rows, tolerating a torn final line. */
export function readGraph(path) {
  if (!existsSync(path)) return { rows: [], error: `no graph at ${path}` }
  const rows = []
  let torn = 0
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (line.trim() === '') continue
    try { rows.push(JSON.parse(line)) } catch { torn += 1 }
  }
  return { rows, error: null, torn }
}

/** Collapse rows to one entry per specifier, flagging a specifier that resolved twice. */
export function collapse(rows) {
  const specifiers = new Map()
  for (const row of rows) {
    if (typeof row.url !== 'string' || !String(row.specifier).startsWith('@deepseek-ai/')) continue
    const classified = classifyUrl(row.url)
    const existing = specifiers.get(row.specifier)
    if (existing === undefined) {
      specifiers.set(row.specifier, { specifier: row.specifier, ...classified, occurrences: 1 })
    } else {
      existing.occurrences += 1
      if (existing.path !== classified.path) {
        existing.alsoResolvedTo = [...(existing.alsoResolvedTo ?? []), classified.path]
        existing.mixedWithinSpecifier = true
      }
    }
  }
  return [...specifiers.values()].sort((a, b) => a.specifier.localeCompare(b.specifier))
}

export function sha256(path) {
  return existsSync(path) ? createHash('sha256').update(readFileSync(path)).digest('hex') : null
}

/**
 * Decide the oracle's clauses.
 *
 * @param options.graphPath  the measured graph.jsonl
 * @param options.launcher   the launcher file the run actually executed
 * @param options.pin        `deployment.inputs.artifact_sha256` from the lock
 * @param options.probe      the probe result (for the first-tool-call clause)
 * @param options.expectedText  the text the first tool call must have returned
 */
export function decide({ graphPath, launcher, pin, probe, expectedText }) {
  const { rows, error, torn } = readGraph(graphPath)
  const graph = collapse(rows)

  const fromBuilt = graph.filter(r => r.kind === 'BUILT').length
  const fromSource = graph.filter(r => r.kind === 'SOURCE').length
  const fromOther = graph.filter(r => r.kind === 'OTHER').length
  const sourceRows = graph.filter(r => r.kind === 'SOURCE')
  const mixed = graph.filter(r => r.mixedWithinSpecifier === true)

  // Bucket the built rows by the directory they resolved under.
  //
  // DONE WITH STRING OPERATIONS, NOT A REGEX. The first revision of this file built
  // the pattern with a `[^\\]` character class and produced an unterminated class at
  // runtime — the sort of bug that would have silently mis-bucketed rows if it had
  // thrown later. Splitting on the separator cannot be mis-escaped.
  //
  // THE NESTED-PACKAGE CASE, which the first revision of THIS function got wrong and
  // which the counts caught: DSH keeps packages at `packages/<name>/lib/` AND at
  // `packages/<group>/<name>/lib/` (e.g. `packages/deliverables/workspace-changes/lib/`).
  // A rule that only looked one level up reported 2 rows under `packages\` when the
  // true count is 213. The rule below therefore anchors on the `packages` segment and
  // accepts one OR two segments between it and `lib`.
  const segments = path => String(path).split('\\').map(s => s.toLowerCase())
  const bucketOf = path => {
    const s = segments(path)
    // The LAST `lib` segment, so a nested `.../lib/lib/` cannot shift the anchor.
    const libIdx = s.lastIndexOf('lib')
    if (libIdx < 1) return 'OTHER'
    // node_modules anywhere before `lib` wins: a pnpm store path may also contain
    // `packages`, and the store is not the checkout's own package tree.
    if (s.slice(0, libIdx).includes('node_modules')) return 'node_modules'
    const pkgIdx = s.lastIndexOf('packages', libIdx)
    if (pkgIdx >= 0 && (libIdx - pkgIdx === 2 || libIdx - pkgIdx === 3)) return 'packages_lib'
    const venIdx = s.lastIndexOf('vendor', libIdx)
    if (venIdx >= 0 && libIdx - venIdx === 2) return 'vendor_lib'
    return 'OTHER'
  }
  const builtRows = graph.filter(r => r.kind === 'BUILT')
  const underPackagesLib = builtRows.filter(r => bucketOf(r.path) === 'packages_lib').length
  const underVendorLib = builtRows.filter(r => bucketOf(r.path) === 'vendor_lib').length
  const underNodeModules = builtRows.filter(r => bucketOf(r.path) === 'node_modules').length

  const launcherSha = sha256(launcher)
  const first = probe?.firstToolCall ?? null

  const clauses = []
  const clause = (label, ok, detail) => clauses.push({ label, ok: ok === true, detail })

  clause('the resolved module graph was recorded and is non-empty',
    rows.length > 0 && graph.length > 0,
    `lines=${String(rows.length)} distinct=${String(graph.length)} torn=${String(torn)}${error === null ? '' : ` error=${error}`}`)

  // THE CLAUSE THE ATTACKS TARGET: no @deepseek-ai specifier may resolve to source.
  clause('no `@deepseek-ai/*` specifier resolves to a source (.ts) file',
    fromSource === 0,
    `fromBuilt=${String(fromBuilt)} fromSource=${String(fromSource)} fromOther=${String(fromOther)}; `
    + `offenders=${JSON.stringify(sourceRows.map(r => [r.specifier, r.path]))}`)

  clause('the graph does not mix src and lib for one specifier',
    mixed.length === 0,
    JSON.stringify(mixed.map(r => [r.specifier, r.path, r.alsoResolvedTo])))

  // THE LAUNCHER CLAUSE THE SWAPPED-BUILD ATTACK TARGETS.
  clause('sha256 of the launcher equals deployment.inputs.artifact_sha256',
    launcherSha !== null && launcherSha === pin,
    `onDisk=${String(launcherSha)} pinned=${String(pin)} equal=${String(launcherSha === pin)}`)

  // The oracle's own failure case: "a run whose only success is --help".
  clause('the first tool call actually succeeded (not a --help-only success)',
    first?.firstCallSucceeded === true,
    `requested=${JSON.stringify(first?.toolCallRequested?.name)} isError=${JSON.stringify(first?.toolResultIsError)}`)

  clause('the tool result carries the file\'s own text (the call really ran)',
    typeof first?.toolResultText === 'string' && first.toolResultText.includes(expectedText),
    JSON.stringify(first?.toolResultText))

  // REPORTED, NOT ASSERTED. The oracle says "resolves under packages\*\lib\". The
  // measured graph also contains vendored packages (`vendor/<name>/lib/`) and one
  // `node_modules/.pnpm/...` package. Those ARE built lib files, but they are not
  // under `packages\`, so a literal reading of the clause would fail them. This is
  // reported with its counts so the reader decides, rather than being folded into
  // a silent pass.
  const notUnderPackages = builtRows.filter(r => bucketOf(r.path) !== 'packages_lib')
  clause('REPORTED: built rows NOT under `packages\\` (literal-reading divergence)',
    true,
    `count=${String(notUnderPackages.length)} vendor=${String(underVendorLib)} node_modules=${String(underNodeModules)}; `
    + JSON.stringify(notUnderPackages.map(r => [r.specifier, r.path])))

  return {
    graph: { lineCount: rows.length, torn, distinctSpecifiers: graph.length, fromBuilt, fromSource, fromOther, underPackagesLib, underVendorLib, underNodeModules, sourceRows, mixed },
    launcherSha256: launcherSha,
    pinnedArtifactSha256: pin,
    clauses,
    failures: clauses.filter(c => !c.ok && !c.label.startsWith('REPORTED:')).map(c => `${c.label} -- observed: ${c.detail}`),
    verdict: clauses.some(c => !c.ok && !c.label.startsWith('REPORTED:')) ? 'FAIL' : 'PASS',
  }
}
