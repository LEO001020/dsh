import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
const REPO_ROOT = resolve(import.meta.dirname, '..', '..')
const DSH_SRC = process.env.DSH_SRC_ROOT ?? 'D:/DSH/src/dsh-src'
const ts = createRequire(join(DSH_SRC, 'node_modules', 'typescript', 'package.json'))('typescript')
const FORBIDDEN = /^@deepseek-ai\/[a-z0-9-]+\/src\//u
const out = []
for (const name of ['artifacts.ts', 'data-service.ts']) {
  const path = join(REPO_ROOT, '.probe', 'r2f4', 'before-src', name)
  const parsed = ts.preProcessFile(readFileSync(path, 'utf8'), true, true)
  for (const e of parsed.importedFiles) {
    if (FORBIDDEN.test(e.fileName)) out.push({ file: `packages/dsh-daily-work/src/${name}`, specifier: e.fileName, line: readFileSync(path,'utf8').split('\n').findIndex(l=>l.includes(e.fileName))+1 })
  }
}
console.log(JSON.stringify({ at: new Date().toISOString(), source: 'git show HEAD:packages/dsh-daily-work/src/*.ts', forbiddenImportsInProductionSources: out }, null, 2))
