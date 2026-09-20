/**
 * S12 independent src/-specifier scan.
 *
 * WHY THIS EXISTS SEPARATELY FROM THE GATE. `no-src-imports.test.ts` states its own
 * scope: it covers the packages listed in its `PACKAGES` constant. An independent
 * check must not inherit that constant, or a package added later is invisible to
 * both. This scanner discovers packages from the filesystem instead, and it reports
 * what it scanned so a zero can be read as "measured zero" rather than "scanned
 * nothing".
 *
 * IT PARSES, IT DOES NOT GREP. `artifacts.ts` cites the forbidden path in its own
 * documentation comment, and a grep reports that comment as an import — measured:
 * a plain `grep -rn` over this repo returns 1 hit, which is that comment. The
 * TypeScript preprocessor returns the real specifier set.
 *
 * Usage: node qualification/results/S12-identity/scan-src-imports.mjs
 */
import { createRequire } from 'node:module'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'

const REPO = resolve(import.meta.dirname, '..', '..', '..')
const DSH_SRC = process.env.DSH_SRC_ROOT ?? 'D:/DSH/src/dsh-src'
const ts = createRequire(join(DSH_SRC, 'node_modules', 'typescript', 'package.json'))('typescript')

/** @type {RegExp} `@deepseek-ai/<name>/src/<anything>` */
const FORBIDDEN = /^@deepseek-ai\/[a-z0-9-]+\/src\//u

function walk(dir, predicate) {
  const out = []
  if (!existsSync(dir)) return out
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue
      out.push(...walk(full, predicate))
    } else if (predicate(entry.name)) out.push(full)
  }
  return out.sort()
}

function specifiersOf(path) {
  const parsed = ts.preProcessFile(readFileSync(path, 'utf8'), true, true)
  return [
    ...parsed.importedFiles.map(e => e.fileName),
    ...parsed.referencedFiles.map(e => e.fileName),
  ].filter(n => typeof n === 'string' && n.startsWith('@deepseek-ai/'))
}

/** Discover packages from the filesystem, NOT from a constant. */
const packagesDir = join(REPO, 'packages')
const packages = readdirSync(packagesDir, { withFileTypes: true })
  .filter(e => e.isDirectory())
  .map(e => e.name)
  .sort()

console.log(`# S12 independent src/-specifier scan`)
console.log(`# repo: ${REPO}`)
console.log(`# packages discovered from the filesystem: ${String(packages.length)} -> ${packages.join(', ')}`)
console.log()

let totalScanned = 0
const offenders = []
const scanned = []

for (const pkg of packages) {
  const srcDir = join(packagesDir, pkg, 'src')
  const libDir = join(packagesDir, pkg, 'lib')

  const srcFiles = walk(srcDir, n => n.endsWith('.ts'))
  const libFiles = walk(libDir, n => n.endsWith('.js') || n.endsWith('.mjs') || n.endsWith('.cjs'))

  const srcProd = srcFiles.filter(f => !f.endsWith('.test.ts'))
  const srcTest = srcFiles.filter(f => f.endsWith('.test.ts'))

  for (const file of [...srcProd, ...libFiles, ...srcTest]) {
    totalScanned += 1
    const rel = relative(REPO, file).split(sep).join('/')
    const hits = specifiersOf(file).filter(s => FORBIDDEN.test(s))
    if (hits.length > 0) offenders.push({ file: rel, hits, test: file.endsWith('.test.ts') })
  }

  scanned.push({
    package: pkg,
    productionSrc: srcProd.length,
    testSrc: srcTest.length,
    emittedLib: libFiles.length,
    hasLib: existsSync(libDir),
  })
}

console.log('## what was scanned')
for (const row of scanned) {
  console.log(`   ${row.package.padEnd(18)} production-src=${String(row.productionSrc).padStart(3)} test-src=${String(row.testSrc).padStart(3)} emitted-lib=${String(row.emittedLib).padStart(3)} libPresent=${String(row.hasLib)}`)
}
console.log(`   TOTAL FILES SCANNED: ${String(totalScanned)}`)
console.log()

const prodOffenders = offenders.filter(o => !o.test)
const testOffenders = offenders.filter(o => o.test)

console.log('## PRODUCTION offenders (src/ import in non-test source, or in emitted lib/)')
console.log(prodOffenders.length === 0
  ? '   NONE — measured zero, over ' + String(totalScanned) + ' files'
  : JSON.stringify(prodOffenders, null, 2))
console.log()
console.log('## TEST-side offenders (deep imports in *.test.ts; allowed only if justified in the gate)')
console.log(testOffenders.length === 0
  ? '   NONE'
  : testOffenders.map(o => `   ${o.file} -> ${o.hits.join(', ')}`).join('\n'))
console.log()
console.log(`VERDICT: production ${prodOffenders.length === 0 ? 'CLEAN' : 'DIRTY'} (${String(prodOffenders.length)} offenders)`)
