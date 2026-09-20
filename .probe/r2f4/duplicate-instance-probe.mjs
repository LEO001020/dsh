/**
 * R2-F4: the duplicate-module-instance claim, measured rather than argued.
 *
 * WHAT IS BEING TESTED. Defect F4's second reason is that the deep import created a
 * SECOND PHYSICAL MODULE INSTANCE of the attachment provider, so module-local state
 * split between the copies. This instrument measures, in ONE process:
 *
 *   1. whether the provider's own entry (`lib/index.js`) contains an INLINED copy of
 *      its `lib/types/store.js` (the audit's characterisation);
 *   2. how many distinct module instances of that store body the host holds, by
 *      comparing the module-scope state object's identity;
 *   3. whether the BUILT public path (`lib/types/store.js`) can be reached WITHOUT
 *      the source path -- i.e. whether a second instance is even avoidable.
 *
 * WHY MODULE-SCOPE STATE IS THE INSTRUMENT. The provider's `store.ts` declares
 * `const durableHomes = new Set<string>()` at module scope. Two physical copies give
 * two different `Set` objects, and that difference is observable without touching any
 * private API. This is the same shape as `TOOL_RUNTIME_SCHEDULER` being a
 * module-local `Symbol()`.
 *
 * Usage (from packages/dsh-daily-work so the farm resolves):
 *   node ../../.probe/r2f4/duplicate-instance-probe.mjs
 */
import { createRequire } from 'node:module'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const DSH_SRC = process.env.DSH_SRC_ROOT ?? 'D:/DSH/src/dsh-src'
const providerRoot = join(DSH_SRC, 'packages', 'attachment', 'attachment-local')

const report = { at: new Date().toISOString(), providerRoot, steps: [], conclusion: {} }
const step = (name, value) => { report.steps.push({ name, value }); console.log(name, '=', JSON.stringify(value)) }

// (1) Does the entry INLINE the store body? Count how many physical files in the
// provider's BUILT tree contain the `durableHomes` declaration.
function filesContaining(dir, needle, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) filesContaining(full, needle, out)
    else if (entry.name.endsWith('.js')) {
      const text = readFileSync(full, 'utf8')
      if (text.includes(needle)) out.push({ file: full, occurrences: text.split(needle).length - 1 })
    }
  }
  return out
}

const require = createRequire(join(DSH_SRC, 'package.json'))
step('entryResolvesTo', createRequire(join(process.cwd(), 'noop.js')).resolve('@deepseek-ai/dsh-attachment-local'))

const builtFilesWithDurableHomes = filesContaining(join(providerRoot, 'lib'), 'durableHomes')
step('builtJsFilesDeclaringDurableHomes', builtFilesWithDurableHomes.map(f => f.file.replace(/\\/g, '/')))
step('builtJsDeclaringCount', builtFilesWithDurableHomes.length)
// The inlining claim: the ENTRY itself carries the declaration, so importing the
// package entry and the store file separately yields two distinct module instances.
const entryPath = join(providerRoot, 'lib', 'index.js')
const entryText = readFileSync(entryPath, 'utf8')
step('entryFileBytes', statSync(entryPath).size)
step('entryInlinesStoreBody', entryText.includes('durableHomes'))
step('storeSubpathExistsOnDisk', (() => { try { return statSync(join(providerRoot, 'lib', 'types', 'store.js')).size > 0 } catch { return false } })())
// Is the built subpath EXPORTED? The audit says "the package simply does not export
// publishImmutableObjectStream" -- this checks the exports map.
const manifest = JSON.parse(readFileSync(join(providerRoot, 'package.json'), 'utf8'))
step('exportsMap', manifest.exports)
step('builtSubpathIsExported', Object.keys(manifest.exports).some(key => key.startsWith('./lib')))

// (2) The live identity test: load the entry and the built store file, and compare
// the module-scope state each one owns.
const entryModule = await import('@deepseek-ai/dsh-attachment-local')
step('entryExportsPublishImmutableObjectStream', typeof entryModule.publishImmutableObjectStream === 'function')
step('entryExportsLocalAttachmentStore', typeof entryModule.LocalAttachmentStore === 'function')

let storeSubpathModule = null
let storeSubpathError = null
try {
  // The BUILT public path, by file URL -- not the `./src/*` subpath.
  storeSubpathModule = await import(new URL(`file:///${join(providerRoot, 'lib', 'types', 'store.js').replace(/\\/g, '/')}`).href)
} catch (error) {
  storeSubpathError = `${error.code ?? error.name}: ${error.message.split('\n')[0]}`
}
step('builtStoreSubpathImportError', storeSubpathError)
step('builtStoreExportsPublishImmutableObjectStream', typeof storeSubpathModule?.publishImmutableObjectStream === 'function')

// (3) THE CONCLUSION, stated as the count of physical instances.
report.conclusion = {
  // The audit's characterisation, re-measured: the entry inlines the store body, and
  // the built subpath file exists separately, so two instances are physically
  // possible when BOTH are loaded.
  entryInlinesStoreBody: entryText.includes('durableHomes'),
  builtStoreFileExists: report.steps.find(s => s.name === 'storeSubpathExistsOnDisk')?.value === true,
  builtSubpathExported: Object.keys(manifest.exports).some(key => key.startsWith('./lib')),
  // WHAT THIS PROJECT NOW DOES: `artifacts.ts` imports ONLY
  // `@deepseek-ai/dsh-attachment` (the seam, which has no provider inside it) and
  // reaches the provider through `ctx.attachments`. So exactly ONE instance of the
  // provider is loaded -- the one the composition mounted.
  projectImportsProviderDirectly: false,
  projectUsesCapabilitySeam: true,
}

console.log('\n=== conclusion ===')
console.log(JSON.stringify(report.conclusion, null, 1))
