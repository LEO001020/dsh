// Second-level scan: for every EXPORTED NAME of every non-test module, is that
// name referenced by any NON-TEST file anywhere in the package?
//
// WHY THIS IS A SEPARATE CHECK. The module-level scan in `import-graph.mjs` asks
// "does anything import this FILE". A file can be imported for one helper while
// its actual product-facing entry point (`runAcceptance`, `resume`) is called by
// nobody but tests. That is the same defect one level down, and the module-level
// graph is structurally blind to it: `verify.ts` is REACHABLE because
// `worktree-isolation.ts` imports two digest helpers from it, so a module-level
// check would report it as fine while its acceptance runner has zero production
// callers.
//
// The reference test is textual over NON-TEST files (including .mjs runners and
// .yml patches, which is where a real production caller could also live). It
// deliberately over-counts a name that merely appears in a comment, so a
// reported "wired" is a LOWER bound on wiring: a name this reports as unwired
// genuinely has no textual occurrence outside tests, which is the stronger and
// more useful direction for a defect hunt.
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { createRequire } from 'node:module'

const repoRoot = 'D:/DSH/work/dsh-native-daily'
const pkgRoot = join(repoRoot, 'packages/dsh-daily-work')
const srcDir = join(pkgRoot, 'src')
const ts = createRequire(join('D:/DSH/src/dsh-src/node_modules/typescript', 'package.json'))('typescript')

const srcFiles = readdirSync(srcDir).filter((f) => f.endsWith('.ts'))
const isTest = (f) => /\.test\.ts$/.test(f)

// --- every file outside src/*.test.ts that could be a caller ------------------
function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.git' || entry === 'lib' || entry === '.probe') continue
    const full = join(dir, entry)
    const st = statSync(full)
    if (st.isDirectory()) walk(full, out)
    else if (/\.(ts|mjs|js|yml|yaml|json|md)$/.test(entry)) out.push(full)
  }
  return out
}
const allRepoFiles = walk(repoRoot)

/** Non-test, non-this-package-src files, i.e. everything that could be a caller. */
const callerFiles = allRepoFiles.filter((f) => {
  const rel = relative(repoRoot, f).replace(/\\/g, '/')
  if (rel.startsWith('packages/dsh-daily-work/src/')) return !isTest(rel.split('/').pop())
  if (rel.startsWith('packages/dsh-daily-work/lib/')) return false
  if (rel.startsWith('docs/')) return false // documentation is not a caller
  return true
})

const callerText = callerFiles.map((f) => ({
  rel: relative(repoRoot, f).replace(/\\/g, '/'),
  text: readFileSync(f, 'utf8'),
}))

/**
 * Exported names of one module, parsed (not regexed), split into VALUE exports
 * and TYPE exports.
 *
 * The split is the whole point. An `interface` or `type` alias has no runtime
 * existence, so "no caller references this name" is not a finding about it: a
 * type is consumed in type positions and a textual search over caller files
 * cannot tell a type reference from a same-named local. Reporting types as
 * unwired produces a 307-row list that buries the handful of real findings. Only
 * a value export (function, class, const, enum) can be an unwired CAPABILITY.
 */
function exportedNames(file) {
  const text = readFileSync(file, 'utf8')
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.ES2024, true, ts.ScriptKind.TS)
  const values = []
  const types = []
  for (const stmt of sf.statements) {
    const isExported = stmt.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
    if (!isExported) continue
    if (ts.isFunctionDeclaration(stmt) && stmt.name) values.push(stmt.name.text)
    else if (ts.isClassDeclaration(stmt) && stmt.name) values.push(stmt.name.text)
    else if (ts.isEnumDeclaration(stmt) && stmt.name) values.push(stmt.name.text)
    else if (ts.isInterfaceDeclaration(stmt) || ts.isTypeAliasDeclaration(stmt)) {
      if (stmt.name) types.push(stmt.name.text)
    } else if (ts.isVariableStatement(stmt)) {
      for (const d of stmt.declarationList.declarations) {
        if (ts.isIdentifier(d.name)) values.push(d.name.text)
      }
    }
  }
  return { values: [...new Set(values)], types: [...new Set(types)] }
}

const rows = []
const typeCounts = { total: 0, unreferenced: 0 }
for (const f of srcFiles.filter((x) => !isTest(x))) {
  const file = join(srcDir, f)
  const self = `packages/dsh-daily-work/src/${f}`
  const { values, types } = exportedNames(file)

  // Types are counted but not reported, and the count is recorded so the
  // exclusion is visible rather than silent.
  for (const name of types) {
    typeCounts.total++
    const re = new RegExp(`\\b${name.replace(/[$]/g, '\\$')}\\b`)
    const hit = callerText.some((c) => c.rel !== self && re.test(c.text))
    if (!hit) typeCounts.unreferenced++
  }

  for (const name of values) {
    // A name with fewer than 4 characters collides with ordinary prose; record
    // it but mark the search as weak so it is not read as evidence.
    const weak = name.length < 4
    const re = new RegExp(`\\b${name.replace(/[$]/g, '\\$')}\\b`)
    const callers = []
    for (const c of callerText) {
      if (c.rel === self) continue
      if (re.test(c.text)) callers.push(c.rel)
    }
    // Split callers by tier so a test-tier caller cannot be mistaken for a product one.
    const productTier = callers.filter((c) => !/\.test\.ts$/.test(c) && !c.startsWith('qualification/'))
    const qualTier = callers.filter((c) => c.startsWith('qualification/'))
    const testTier = callers.filter((c) => /\.test\.ts$/.test(c))
    rows.push({ module: self, name, weak, productTier, qualTier, testTier })
  }
}

console.log('=== VALUE EXPORTS WITH NO PRODUCT-TIER CALLER ===')
console.log('(product tier = non-test src, other packages, profiles/; a .test.ts or')
console.log(' qualification/ hit is recorded separately and is NOT a product caller)')
console.log('(TYPE exports are excluded and counted in the summary: an interface has no')
console.log(' runtime existence, so "unreferenced" is not a finding about it)')
console.log('')
const unwired = rows.filter((r) => r.productTier.length === 0)
for (const r of unwired) {
  console.log(`  ${r.module.replace('packages/dsh-daily-work/src/', '')} :: ${r.name}${r.weak ? '  [weak: <4 chars]' : ''}`)
  console.log(`        product: (NONE)`)
  console.log(`        qualification: ${r.qualTier.length ? r.qualTier.join(', ') : '(none)'}`)
  console.log(`        tests: ${r.testTier.length ? r.testTier.join(', ') : '(none)'}`)
}

console.log(`\n=== SUMMARY ===`)
console.log(`value exports scanned: ${rows.length}`)
console.log(`with a product-tier caller: ${rows.length - unwired.length}`)
console.log(`with NO product-tier caller: ${unwired.length}`)
console.log(`\ntype exports (interfaces + type aliases) excluded from the list above: ${typeCounts.total}`)
console.log(`  of those, unreferenced by any non-test file: ${typeCounts.unreferenced}`)
console.log('  (not a finding: a type has no runtime existence, and a textual search')
console.log('   cannot distinguish a type reference from a same-named local)')
const byModule = new Map()
for (const r of unwired) byModule.set(r.module, (byModule.get(r.module) ?? 0) + 1)
console.log('\nunwired VALUE exports per module:')
for (const [m, n] of [...byModule].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${m.replace('packages/dsh-daily-work/src/', '')}: ${n}`)
}
