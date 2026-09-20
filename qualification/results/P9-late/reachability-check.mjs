/**
 * P9 reachability measurement: does the INSTALLED profile resolve the DELIVERY
 * code that was built from THIS worktree?
 *
 * WHY THIS EXISTS SEPARATELY FROM THE TESTS. Every test in this slice runs from
 * `src/` through vitest's transform. The PRODUCT loads `lib/`, through the
 * profile's `link:` target, through `package.json` `exports`. Those are three
 * different resolution paths, and this project has already filed two FALSE
 * findings (G-SEAM-29, G-SEAM-36) by measuring a stale built `lib/`. So the
 * claim "the product reaches this change" is measured here rather than inferred
 * from a green test.
 *
 * It asserts rather than prints: a `false` anywhere exits non-zero, so this is a
 * check that can fail.
 *
 * Run: node qualification/results/P9-late/reachability-check.mjs
 */
import { createRequire } from 'node:module'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const PROFILE = 'D:/DSH/home/p9/profiles/daily/package.json'
const WORKTREE = 'D:\\DSH\\work\\wt-p9'
const OUT = resolve(import.meta.dirname, 'reachability.json')

const require_ = createRequire(PROFILE)
const profile = JSON.parse(readFileSync(PROFILE, 'utf8'))

const out = {
  measuredAt: new Date().toISOString(),
  note: 'PRODUCT REACHABILITY: measured through the INSTALLED profile at D:/DSH/home/p9, not through src/',
  installedProfileLinkTargets: profile.dependencies,
  presetRow: {
    file: 'profiles/daily-candidate/presets/daily-standard/agent.cordis.yml:406',
    name: 'dsh-ipython/tool',
  },
}

const toolPath = require_.resolve('dsh-ipython/tool')
const pluginPath = require_.resolve('dsh-ipython/plugin')
out.toolResolvesTo = toolPath
out.pluginResolvesTo = pluginPath
out.toolIsInThisWorktree = toolPath.startsWith(WORKTREE)
out.pluginIsInThisWorktree = pluginPath.startsWith(WORKTREE)

const toolSource = readFileSync(toolPath, 'utf8')
const pluginSource = readFileSync(pluginPath, 'utf8')
out.builtToolCarriesDelivery = toolSource.includes('deliverLateNotices')
out.builtToolCarriesNoticeRenderer = toolSource.includes('Runtime notice: background output')
out.builtToolNoticePluginId = toolSource.includes('dsh-ipython-late-output')
out.builtKernelPluginCarriesQueue = pluginSource.includes('drainLateNotices')
out.builtKernelPluginCarriesQueueFeed = pluginSource.includes('lateNotices.push')
out.builtKernelPluginCarriesAccount = pluginSource.includes('lateNoticeAccount')
// The promise the model reads, as BUILT -- so the text the product serves is the
// text this slice wrote, not a src-only edit.
//
// MEASURED FROM THE DESCRIPTION ARRAY, not by a substring search over the whole
// file. The first version of this check searched the file, found the old sentence
// inside this slice's OWN docstring (which quotes the defect it fixes), and
// reported NOT REACHABLE. That was a false negative in the CHECK, and it is
// recorded rather than quietly corrected: a raw text search cannot tell the
// model-facing description from prose about it. The description is therefore
// located and extracted, and only its text is asserted on.
const descriptionStart = toolSource.indexOf("description: [")
const descriptionEnd = descriptionStart === -1 ? -1 : toolSource.indexOf("].join('\\n')", descriptionStart)
if (descriptionStart === -1 || descriptionEnd === -1) {
  throw new Error('could not locate the built tool description array; the check must not guess')
}
const description = toolSource.slice(descriptionStart, descriptionEnd)
out.descriptionExtracted = description.length > 0
out.builtToolPromiseText = description.includes('It is reported separately, in its own runtime-notice message')
out.builtToolNamesTheUndecidableCase = description.includes('UNDECIDABLE')
out.builtToolNamesTheBound = description.includes('bounded: if a background thread floods')
out.builtToolSaysNoTurnIsStarted = description.includes('never starts a turn of its own')
out.builtToolNoLongerClaimsUnattributedOnly = !description.includes('reported separately as unattributed output')
out.builtToolStillSaysBackgroundIsNotPartOfResult = description.includes('is NOT part of the result')

const checks = [
  'toolIsInThisWorktree',
  'pluginIsInThisWorktree',
  'builtToolCarriesDelivery',
  'builtToolCarriesNoticeRenderer',
  'builtToolNoticePluginId',
  'builtKernelPluginCarriesQueue',
  'builtKernelPluginCarriesQueueFeed',
  'builtKernelPluginCarriesAccount',
  'descriptionExtracted',
  'builtToolPromiseText',
  'builtToolNamesTheUndecidableCase',
  'builtToolNamesTheBound',
  'builtToolSaysNoTurnIsStarted',
  'builtToolNoLongerClaimsUnattributedOnly',
  'builtToolStillSaysBackgroundIsNotPartOfResult',
]
out.failed = checks.filter(name => out[name] !== true)
out.verdict = out.failed.length === 0
  ? 'REACHABLE: the installed profile resolves this worktree, and the BUILT tool and plugin carry the delivery path'
  : `NOT REACHABLE: ${out.failed.join(', ')}`

writeFileSync(OUT, JSON.stringify(out, null, 2), 'utf8')
process.stdout.write(JSON.stringify(out, null, 2) + '\n')
if (out.failed.length > 0) process.exitCode = 1
