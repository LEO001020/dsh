/**
 * R2-F4 measurement: the production emitted-import graph, BEFORE and AFTER.
 *
 * WHY A PARSER AND NOT A GREP. The module's own comments cite the forbidden
 * specifier while explaining the defect it caused, so a `grep` for the
 * `@deepseek-ai/dsh-<name>/src/` shape reports hits that are NOT imports. The
 * audited build's own record has the same shape: `lib/artifacts.js:73` was a real
 * `import` statement while lines 109 and 1112 were comment text. This instrument
 * reports the two separately, so "zero forbidden imports" is a claim about import
 * statements rather than about a substring count.
 *
 * It uses the TypeScript compiler's own preprocessor (the same instrument
 * `qualification/runners/import-graph.mjs` uses) so specifiers come from parsing.
 *
 * Usage (from the repository root):
 *   node .probe/r2f4/measure-emitted-imports.mjs
 */
import { createRequire } from 'node:module'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'

const REPO_ROOT = resolve(import.meta.dirname, '..', '..')
const DSH_SRC = process.env.DSH_SRC_ROOT ?? 'D:/DSH/src/dsh-src'
const ts = createRequire(join(DSH_SRC, 'node_modules', 'typescript', 'package.json'))('typescript')

const FORBIDDEN = /^@deepseek-ai\/[a-z0-9-]+\/src\//u
const PACKAGES = ['dsh-daily-work', 'dsh-ipython']

function walk(dir, filter, out = []) {
  if (!existsSync(dir)) return out
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) walk(full, filter, out)
    else if (filter(entry.name)) out.push(full)
  }
  return out.sort()
}

function specifiersIn(path) {
  const parsed = ts.preProcessFile(readFileSync(path, 'utf8'), true, true)
  return [
    ...parsed.importedFiles.map(e => e.fileName),
    ...parsed.referencedFiles.map(e => e.fileName),
  ]
}

/** Comment/string CITATIONS of a forbidden path, which are not imports. */
function citationsIn(path) {
  const text = readFileSync(path, 'utf8')
  const lines = []
  for (const [index, line] of text.split('\n').entries()) {
    const trimmed = line.trim()
    const isComment = trimmed.startsWith('*') || trimmed.startsWith('//') || trimmed.startsWith('/*')
    if (isComment && FORBIDDEN.test(line.replace(/^[\s*/]+/u, ''))) {
      lines.push({ line: index + 1, text: trimmed.slice(0, 110) })
    }
  }
  return lines
}

const report = { at: new Date().toISOString(), repoRoot: REPO_ROOT, packages: {}, total: {} }
let totalEmitted = 0
let totalForbiddenImports = 0
let totalCitations = 0
const allOffenders = []

for (const pkg of PACKAGES) {
  const pkgDir = join(REPO_ROOT, 'packages', pkg)
  const emitted = walk(join(pkgDir, 'lib'), name => name.endsWith('.js'))
  const productionSources = walk(join(pkgDir, 'src'), name => name.endsWith('.ts') && !name.endsWith('.test.ts'))
  const testSources = walk(join(pkgDir, 'src'), name => name.endsWith('.test.ts'))

  const forbiddenImports = []
  const citations = []
  let bytes = 0
  for (const file of emitted) {
    bytes += statSync(file).size
    for (const specifier of specifiersIn(file)) {
      if (FORBIDDEN.test(specifier)) {
        forbiddenImports.push({ file: relative(REPO_ROOT, file).split(sep).join('/'), specifier })
      }
    }
    for (const citation of citationsIn(file)) {
      citations.push({ file: relative(REPO_ROOT, file).split(sep).join('/'), ...citation })
    }
  }

  const forbiddenInProductionSources = []
  for (const file of productionSources) {
    for (const specifier of specifiersIn(file)) {
      if (FORBIDDEN.test(specifier)) {
        forbiddenInProductionSources.push({ file: relative(REPO_ROOT, file).split(sep).join('/'), specifier })
      }
    }
  }

  const forbiddenInTests = []
  for (const file of testSources) {
    for (const specifier of specifiersIn(file)) {
      if (FORBIDDEN.test(specifier)) {
        forbiddenInTests.push({ file: relative(REPO_ROOT, file).split(sep).join('/'), specifier })
      }
    }
  }

  report.packages[pkg] = {
    emittedJsFiles: emitted.length,
    emittedJsBytes: bytes,
    forbiddenImportsInEmitted: forbiddenImports,
    forbiddenImportsInProductionSources: forbiddenInProductionSources,
    forbiddenImportsInTests: forbiddenInTests,
    commentCitationsInEmitted: citations,
  }
  totalEmitted += emitted.length
  totalForbiddenImports += forbiddenImports.length + forbiddenInProductionSources.length
  totalCitations += citations.length
  allOffenders.push(...forbiddenImports, ...forbiddenInProductionSources)
}

report.total = {
  emittedJsFiles: totalEmitted,
  forbiddenImportsInProduction: totalForbiddenImports,
  commentCitationsInEmitted: totalCitations,
  offenders: allOffenders,
}

console.log(JSON.stringify(report, null, 2))
process.exitCode = totalForbiddenImports === 0 ? 0 : 1
