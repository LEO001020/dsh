/**
 * P7 / UI-DISCOVERY: what the pinned checkout's client-module scan does with
 * `dsh-daily-work`, measured rather than inferred.
 *
 * V5 section 13 warns: "Also verify whether any browser client card exists for
 * the `daily-work` namespace. Do not infer a UI from `installSection`. The
 * upstream `SubagentLimitsCardController` is for the `subagent` namespace, not
 * automatically this project namespace."
 *
 * This script drives the PINNED CHECKOUT'S OWN FUNCTIONS
 * (`packages/client/modules/src/client/manifest.ts`) against this project's real
 * `package.json` and real loader-row names. It answers two questions:
 *
 *   1. Does `dsh-daily-work` declare a client bundle today? (parseDshClient)
 *   2. Would the scan even LOOK, given the row names this profile uses?
 *      (exactPackageSpecifier / locatePkgJson's classification)
 *
 * Run: node qualification/results/P7-ui/probe-client-discovery.mjs
 *
 * It writes nothing and starts no host. It is a measurement of the discovery
 * mechanism, not of a boot.
 */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'

const REPO = 'D:/DSH/work/wt-p7'
const CHECKOUT = 'D:/DSH/src/dsh-src'

// The pinned checkout's own parser, loaded from the checkout. Importing the real
// functions is the point: a re-implementation would measure my understanding of
// the rule rather than the rule.
const manifestUrl = `file:///${CHECKOUT}/packages/client/modules/src/client/manifest.ts`
const { exactPackageSpecifier, parseDshClient, stripClientSuffix } = await import(manifestUrl)

/** `clientExportOf`, copied from `packages/client/modules/src/index.ts:187`. */
function clientExportOf(pkgName, exportsField) {
  if (typeof exportsField !== 'object' || exportsField === null) return undefined
  const client = exportsField['./client']
  if (client === undefined) return undefined
  if (typeof client === 'string') return client
  if (typeof client === 'object' && client !== null) {
    const fallback = client.default
    if (typeof fallback === 'string') return fallback
  }
  throw new Error(`client-modules: ${pkgName} exports["./client"] must be a string or an object with a string default`)
}

const out = { repo: REPO, checkout: CHECKOUT, packages: [], rows: [], conclusion: {} }

for (const dir of ['dsh-daily-work', 'dsh-ipython']) {
  const pkgPath = join(REPO, 'packages', dir, 'package.json')
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
  const name = pkg.name
  const dsh = pkg.dsh
  const decl = parseDshClient(name, dsh !== null && typeof dsh === 'object' ? dsh.client : undefined)
  let clientRel
  let exportError
  try {
    clientRel = clientExportOf(name, pkg.exports)
  } catch (error) {
    exportError = error.message
  }
  out.packages.push({
    package: name,
    manifest: pkgPath,
    'dsh.client declaration': decl === undefined ? null : decl,
    // The scan's gate, restated from index.ts:799: a row is a client row only
    // when a declaration exists AND its platform is 'web'.
    'would be a client row': decl !== undefined && decl.platform === 'web',
    'exports["./client"]': clientRel ?? null,
    'export error': exportError ?? null,
    // The bundle the scan would read (index.ts:808 joins this onto the manifest
    // directory). Its existence is checked below.
    'bundle path': clientRel === undefined ? null : join(REPO, 'packages', dir, clientRel),
  })
}

// The loader-row names this project's own bundle patch inserts. Read from the
// patch rather than hand-listed, so a row added later appears here.
const patch = readFileSync(join(REPO, 'packages/dsh-daily-work/cordis.patch.yml'), 'utf8')
const rowNames = [...patch.matchAll(/^\s*name:\s*(dsh-[^\s]+)\s*$/gmu)].map(match => match[1])
const profilePatch = readFileSync(join(REPO, 'profiles/daily-candidate/cordis.patch.yml'), 'utf8')
const profileRowNames = [...profilePatch.matchAll(/^\s*name:\s*(dsh-[^\s]+)\s*$/gmu)].map(match => match[1])

for (const rowName of [...new Set([...rowNames, ...profileRowNames])]) {
  // `locatePkgJson` (index.ts:829-833) bails before any filesystem work when the
  // row name is a subpath, a path, or a scheme-qualified specifier.
  const expected = exactPackageSpecifier(rowName)
  out.rows.push({
    'loader row name': rowName,
    'exactPackageSpecifier': expected ?? null,
    // A null here means `locatePkgJson` returns undefined immediately and the
    // row is cached as "permanently not a client row" (index.ts:786-791).
    'scan reaches a manifest': expected !== undefined,
  })
}

// Does the built bundle exist? `lib/` is gitignored and built by tsc, which
// emits .js/.d.ts only -- a client bundle is a tsdown artifact, not a tsc one.
const { existsSync } = await import('node:fs')
out.conclusion = {
  'dsh-daily-work declares dsh.client': out.packages[0]['dsh.client declaration'] !== null,
  'dsh-daily-work client bundle exists': out.packages[0]['bundle path'] !== null
    && existsSync(out.packages[0]['bundle path']),
  'every loader row is a subpath': out.rows.every(row => !row['scan reaches a manifest']),
  'any browser card exists for the daily-work namespace': false,
}

console.log(JSON.stringify(out, null, 2))
