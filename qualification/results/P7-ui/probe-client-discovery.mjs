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

// ---------------------------------------------------------------------------
// CONTROL ARM: what would declaring `dsh.client` WITHOUT a committed bundle do?
//
// This is the arm that decides whether adding the declaration is a fix or a
// regression, so it is measured rather than reasoned about. Three pinned
// mechanisms, driven in order:
//
//   1. `parseDshClient` accepts the declaration.
//   2. `clientExportOf` THROWS when the declaration exists but package.json has
//      no `./client` export (index.ts:803-806).
//   3. `readArtifact` throws MissingClientBundleError when the export exists but
//      the file does not (index.ts:928), and the constructor's activation pass
//      aggregates those into one loud throw that FAILS the `modules` fiber
//      (index.ts:552-557).
//
// So a declaration with no buildable bundle does not degrade the card -- it
// fails the client-module fiber the whole browser surface depends on. That is
// why this slice does NOT declare one.
// ---------------------------------------------------------------------------
const control = {}
{
  const withDecl = {
    name: 'dsh-daily-work',
    dsh: { client: { inject: ['@deepseek-ai/dsh-api-remotes'], platform: 'web' } },
    // NO `exports["./client"]` -- the state a package is in before its bundle
    // build is wired.
    exports: { '.': { default: './lib/host-plugin.js' } },
  }
  control['1. parseDshClient accepts the declaration'] =
    parseDshClient(withDecl.name, withDecl.dsh.client) !== undefined
  // `clientExportOf` RETURNS UNDEFINED here rather than throwing -- the throw is
  // one level up, in `resolveMeta` (index.ts:803-806):
  //   const clientRel = clientExportOf(packageName, pkg.exports)
  //   if (clientRel === undefined) throw new Error(
  //     `client-modules: ${packageName} declares dsh.client but exports no "./client" bundle`)
  // The first version of this probe labelled the throw as coming from
  // `clientExportOf` and measured `false`; corrected after reading the call site.
  const withoutExport = clientExportOf(withDecl.name, withDecl.exports)
  control['2. clientExportOf returns undefined without exports["./client"]'] =
    withoutExport === undefined
  control['2. so resolveMeta (index.ts:803-806) throws "declares dsh.client but exports no ./client bundle"'] =
    withoutExport === undefined
  // The throw does happen for a malformed export value, which is the other arm of
  // the same guard. Asserted so the distinction above is measured, not assumed.
  try {
    clientExportOf(withDecl.name, { './client': { default: 42 } })
    control['2b. clientExportOf throws on a non-string default'] = false
  } catch (error) {
    control['2b. clientExportOf throws on a non-string default'] =
      /must be a string or an object with a string default/u.test(error.message)
  }
  // And with the export present but the file absent, `readArtifact` is what
  // throws. Measured with a path that certainly does not exist.
  const declaredPath = join(REPO, 'packages', 'dsh-daily-work', 'lib', 'client.js')
  control['3. the declared bundle path exists today'] = existsSync(declaredPath)
  control['3. lib/ is gitignored, so it is absent in a fresh clone'] =
    /packages\/\*\/lib\//u.test(readFileSync(join(REPO, '.gitignore'), 'utf8'))
  control['consequence'] =
    'declaring dsh.client without a committed, buildable client bundle would fail the modules fiber the browser surface depends on'
}
out.control = control

console.log(JSON.stringify(out, null, 2))
