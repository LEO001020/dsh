// Build the REAL import graph for the dsh-daily-work package.
//
// The standing check in docs/GAPS.md, applied literally:
//   1. Build the import graph from the package's `exports` roots, not from a
//      directory listing.
//   2. For each module, ask whether any NON-TEST importer reaches it.
//
// A hand-rolled regex over the source is NOT good enough and this file records
// why: the first version used one and reported `artifacts.ts`, `observations.ts`,
// `capacity.ts`, `target-setting.ts`, `reconcile.ts` and `programmatic-scope.ts`
// as unreachable, because a multi-line `import {\n  a,\n  b,\n} from './x.ts'`
// does not match a single-line pattern. It also produced a FALSE POSITIVE from a
// test that contains the literal text `from './kernel-lifecycle.ts'` inside a
// string. So the specifier list comes from the TypeScript compiler's own
// preprocessor, which parses rather than pattern-matches.
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { dirname, resolve, relative, join } from 'node:path'
import { createRequire } from 'node:module'

const pkgRoot = 'D:/DSH/work/dsh-native-daily/packages/dsh-daily-work'
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
  const imp = [...(directImporters.get(f) ?? [])].filter((x) => !isTest(x))
  const tag = entrySet.has(f) ? 'ENTRY' : 'REACH'
  console.log(`  ${tag} ${f.padEnd(32)} via=${via}`)
  console.log(`        non-test importers: ${imp.length ? imp.join(', ') : '(is an entry root)'}`)
}

console.log(`\n=== UNREACHABLE non-test modules (${unreach.length}) — THE WORK QUEUE ===`)
for (const f of unreach) {
  const nonTest = [...(directImporters.get(f) ?? [])].filter((x) => !isTest(x))
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
