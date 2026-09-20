// Build the REAL import graph for a DSH extension package.
//
// THE STANDING CHECK from docs/GAPS.md, as one shared instrument instead of prose
// each agent re-implements. Three agents built this independently and two of the
// three DISAGREED on one module, so the divergence is recorded here rather than
// left to recur:
//
//   R3 (this file, compiler-based `ts.preProcessFile`) reported `reconcile.ts`
//   has no non-test importer. T9 (a vitest case) found one:
//   `durability-runner.ts`. CAUSE: R3 restricts its importer map to the
//   REACHABLE subgraph, so it never visits the unreachable CLI, and therefore
//   never records that CLI as an importer. Both were correct for their own
//   scope. This file now prints BOTH facts separately, because collapsing them
//   repeats the "presence is not reachability" error in the other direction:
//     - `directImporters` is computed over ALL non-test modules, reachable or not
//     - `reachableBy` is the closure from the package's `exports` roots
//   A module can therefore be listed as "has a non-test importer" AND
//   "unreachable from every entry point" at the same time. That is not a
//   contradiction; it is the finding.
//
// WHY NOT A REGEX. The first version of this scan used a hand-rolled regex and
// reported six modules as unreachable, because a multi-line
// a multi-line import statement (braces spanning three lines, then the
// from-clause) does not match a single-line pattern.
// It also produced a FALSE POSITIVE from a test containing the literal text
// a from-clause inside a string literal. So specifiers come from the
// TypeScript compiler's own preprocessor, which parses rather than
// pattern-matches.
//
// USAGE
//   node qualification/runners/import-graph.mjs [packageDir]
// Default package is dsh-daily-work. Pass the ipython package to scan it:
//   node qualification/runners/import-graph.mjs packages/dsh-ipython
//
// WHAT IT DOES NOT DO. It does not decide whether an unreachable module SHOULD
// be reachable. That is a product question. It reports the graph; the reader
// applies the standing check.

import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { dirname, resolve, relative, join } from 'node:path'
import { createRequire } from 'node:module'

const arg = process.argv[2] ?? 'packages/dsh-daily-work'
const REPO_ROOT = resolve(import.meta.dirname, '..', '..')
const pkgRoot = resolve(REPO_ROOT, arg)
if (!existsSync(pkgRoot)) {
  console.error(`no such package directory: ${pkgRoot}`)
  process.exit(2)
}
const tscRoot = 'D:/DSH/src/dsh-src/node_modules/typescript'
const require = createRequire(join(tscRoot, 'package.json'))
const ts = require('typescript')

const pkg = JSON.parse(readFileSync(join(pkgRoot, 'package.json'), 'utf8'))

const allSrc = readdirSync(join(pkgRoot, 'src'))
  .filter((f) => f.endsWith('.ts'))
  .map((f) => `src/${f}`)
const isTest = (p) => /\.test\.ts$/.test(p)

/** Every module specifier in a file, via the real TS preprocessor. */
function specifiersOf(file) {
  const text = readFileSync(resolve(pkgRoot, file), 'utf8')
  const info = ts.preProcessFile(text, /* readImportFiles */ true, /* detectJavaScriptImports */ true)
  const out = []
  for (const group of [info.importedFiles, info.referencedFiles, info.libReferenceDirectives]) {
    for (const ref of group ?? []) out.push(ref.fileName)
  }
  return out
}

/** Resolve a relative specifier to a src/*.ts path, or null if external. */
function resolveSpec(fromFile, spec) {
  if (!spec.startsWith('.')) return null
  const abs = resolve(dirname(resolve(pkgRoot, fromFile)), spec)
  const rel = relative(pkgRoot, abs).replace(/\\/g, '/')
  if (allSrc.includes(rel)) return rel
  // allowImportingTsExtensions means './x.ts'; a compiled-style './x.js' maps back.
  const asTs = rel.replace(/\.js$/, '.ts')
  if (allSrc.includes(asTs)) return asTs
  const asIndex = `${rel}/index.ts`
  if (allSrc.includes(asIndex)) return asIndex
  return `UNRESOLVED:${rel}`
}

// --- exports roots: the product's entry points -------------------------------
const entries = []
for (const [sub, target] of Object.entries(pkg.exports)) {
  if (sub === './package.json') continue
  const def = typeof target === 'string' ? target : (target.default ?? target.types)
  const m = /^\.\/lib\/(.+)\.js$/.exec(def)
  if (!m) {
    entries.push({ sub, lib: def, src: `UNMAPPED:${def}` })
    continue
  }
  entries.push({ sub, lib: def, src: `src/${m[1]}.ts` })
}

// --- transitive closure from each entry, non-test only -----------------------
const reachableBy = new Map()
const directImporters = new Map()
const unresolved = []
for (const e of entries) {
  if (!allSrc.includes(e.src)) continue
  const queue = [e.src]
  const seen = new Set([e.src])
  while (queue.length) {
    const cur = queue.shift()
    if (!reachableBy.has(cur)) reachableBy.set(cur, new Set())
    reachableBy.get(cur).add(e.sub)
    for (const spec of specifiersOf(cur)) {
      const tgt = resolveSpec(cur, spec)
      if (!tgt) continue
      if (tgt.startsWith('UNRESOLVED:')) {
        unresolved.push(`${cur} -> ${spec}`)
        continue
      }
      if (!directImporters.has(tgt)) directImporters.set(tgt, new Set())
      directImporters.get(tgt).add(cur)
      if (!seen.has(tgt)) {
        seen.add(tgt)
        queue.push(tgt)
      }
    }
  }
}

// --- the FULL importer map, over every non-test module -----------------------
//
// This pass is deliberately separate from the closure walk above. The closure
// only visits modules REACHABLE from an entry point, so an importer that is
// itself unreachable (e.g. `durability-runner.ts`, a hand-run CLI) is never
// visited and never recorded -- which is exactly how R3 came to report that
// `reconcile.ts` has no non-test importer while T9 found one. Recording the
// importer map over ALL non-test modules removes that blind spot.
const allImporters = new Map()
for (const from of allSrc) {
  if (isTest(from)) continue
  for (const spec of specifiersOf(from)) {
    const tgt = resolveSpec(from, spec)
    if (!tgt || tgt.startsWith('UNRESOLVED:')) continue
    if (!allImporters.has(tgt)) allImporters.set(tgt, new Set())
    allImporters.get(tgt).add(from)
  }
}

// --- test-side importers, direct and transitive ------------------------------
const tests = allSrc.filter(isTest)
const testDirect = new Map()
const testReach = new Map()
for (const t of tests) {
  const queue = [t]
  const seen = new Set([t])
  while (queue.length) {
    const cur = queue.shift()
    for (const spec of specifiersOf(cur)) {
      const tgt = resolveSpec(cur, spec)
      if (!tgt || tgt.startsWith('UNRESOLVED:') || seen.has(tgt)) continue
      seen.add(tgt)
      if (!testReach.has(tgt)) testReach.set(tgt, new Set())
      testReach.get(tgt).add(t)
      if (cur === t) {
        if (!testDirect.has(tgt)) testDirect.set(tgt, new Set())
        testDirect.get(tgt).add(t)
      }
      queue.push(tgt)
    }
  }
}

const entrySet = new Set(entries.map((e) => e.src))

console.log('=== EXPORT ROOTS (the product\'s entry points) ===')
for (const e of entries) console.log(`  ${e.sub.padEnd(24)} -> ${e.src}`)

const reach = allSrc.filter((f) => !isTest(f) && reachableBy.has(f)).sort()
const unreach = allSrc.filter((f) => !isTest(f) && !reachableBy.has(f)).sort()

console.log(`\n=== REACHABLE non-test modules (${reach.length}) ===`)
for (const f of reach) {
  const via = [...reachableBy.get(f)].sort().join(',')
  const imp = [...(allImporters.get(f) ?? [])]
  const tag = entrySet.has(f) ? 'ENTRY' : 'REACH'
  console.log(`  ${tag} ${f.padEnd(32)} via=${via}`)
  console.log(`        non-test importers: ${imp.length ? imp.join(', ') : '(is an entry root)'}`)
}

console.log(`\n=== UNREACHABLE non-test modules (${unreach.length}) — THE WORK QUEUE ===`)
for (const f of unreach) {
  const nonTest = [...(allImporters.get(f) ?? [])]
  const dt = [...(testDirect.get(f) ?? [])]
  const it = [...(testReach.get(f) ?? [])].filter((x) => !dt.includes(x))
  console.log(`  ${f}`)
  console.log(`        non-test importers: ${nonTest.length ? nonTest.join(', ') : '(NONE)'}`)
  console.log(`        direct test importers: ${dt.length ? dt.join(', ') : '(NONE)'}`)
  console.log(`        indirect test reachers: ${it.length ? it.join(', ') : '(NONE)'}`)
}

if (unresolved.length) {
  console.log('\n=== UNRESOLVED relative specifiers ===')
  for (const u of [...new Set(unresolved)]) console.log(`  ${u}`)
}

console.log(`\nTOTAL src modules: ${allSrc.length}  non-test: ${allSrc.length - tests.length}`)
console.log(`REACHABLE: ${reach.length}   UNREACHABLE: ${unreach.length}`)
