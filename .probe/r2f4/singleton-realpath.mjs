/**
 * R2-F4: singleton realpath check for critical DSH modules.
 *
 * THE AUDIT'S THIRD STATIC GATE (V3 §G1):
 *   - runtime critical DSH modules resolve to one physical package identity;
 *   - no local import map / tsx path silently aliases source and built copies together.
 *
 * WHAT THIS MEASURES. For every `@deepseek-ai/*` package this project's two packages
 * name, it resolves the specifier and reports the PHYSICAL realpath, then groups the
 * results by package. Two different realpaths for one package name is the defect.
 * It also reports, for each package, whether the resolved file is a BUILT `lib/*.js`
 * or a SOURCE `.ts` -- a package that resolves to source is a source-plane leak even
 * if only one path is involved.
 *
 * WHY REALPATH AND NOT THE SPECIFIER. A junction or symlink farm (which this project
 * uses by design, `link-all-dsh.ps1`) means the same package can be reached by
 * several specifier strings while being ONE physical directory. Only realpath
 * distinguishes "two names for one package" (fine) from "two physical copies" (the
 * defect).
 *
 * Usage (from packages/dsh-daily-work so its farm resolves):
 *   node ../../.probe/r2f4/singleton-realpath.mjs
 */
import { readFileSync, realpathSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, relative, resolve, sep } from 'node:path'

const DSH_SRC = process.env.DSH_SRC_ROOT ?? 'D:/DSH/src/dsh-src'
const PACKAGES = ['dsh-daily-work', 'dsh-ipython']
const REPO_ROOT = resolve(process.cwd(), '..', '..')

/** Every `@deepseek-ai/*` name any source file in a package mentions. */
function namedPackages(pkgDir) {
  const names = new Set()
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.name.endsWith('.ts')) {
        for (const match of readFileSync(full, 'utf8').matchAll(/@deepseek-ai\/[a-z0-9-]+/gu)) names.add(match[0])
      }
    }
  }
  walk(join(pkgDir, 'src'))
  return [...names].sort()
}

const require = createRequire(join(REPO_ROOT, 'packages', 'dsh-daily-work', 'package.json'))
const report = {
  at: new Date().toISOString(),
  dshSrc: DSH_SRC,
  packages: {},
  duplicateIdentities: [],
  sourcePlaneResolutions: [],
}

for (const pkg of PACKAGES) {
  const names = namedPackages(join(REPO_ROOT, 'packages', pkg))
  const byPackage = {}
  for (const name of names) {
    let resolved = null
    let error = null
    try {
      resolved = require.resolve(name)
    } catch (e) {
      error = e.code ?? String(e)
    }
    if (resolved === null) {
      byPackage[name] = { resolved: null, error }
      continue
    }
    let physical = null
    try { physical = realpathSync(resolved) } catch { physical = resolved }
    byPackage[name] = {
      resolved: resolved.replace(/\\/g, '/'),
      realpath: physical.replace(/\\/g, '/'),
      kind: /\.ts$/u.test(physical) ? 'SOURCE' : /[\\/]lib[\\/].*\.(js|mjs|cjs)$/u.test(physical) ? 'BUILT' : 'OTHER',
    }
  }
  report.packages[pkg] = byPackage
}

// (a) one physical identity per package name.
const perName = new Map()
for (const [pkg, entries] of Object.entries(report.packages)) {
  for (const [name, info] of Object.entries(entries)) {
    if (info.realpath === undefined || info.realpath === null) continue
    const key = `${name}`
    const existing = perName.get(key) ?? new Set()
    existing.add(info.realpath)
    perName.set(key, existing)
  }
}
for (const [name, paths] of perName) {
  if (paths.size > 1) report.duplicateIdentities.push({ package: name, realpaths: [...paths] })
}

// (b) no source-plane resolution at all.
for (const [pkg, entries] of Object.entries(report.packages)) {
  for (const [name, info] of Object.entries(entries)) {
    if (info.kind === 'SOURCE') report.sourcePlaneResolutions.push({ from: pkg, package: name, realpath: info.realpath })
  }
}

const unresolved = []
for (const [pkg, entries] of Object.entries(report.packages)) {
  for (const [name, info] of Object.entries(entries)) {
    if (info.resolved === null) unresolved.push({ from: pkg, package: name, error: info.error })
  }
}

report.summary = {
  distinctPackageNamesResolved: perName.size,
  duplicateIdentities: report.duplicateIdentities.length,
  sourcePlaneResolutions: report.sourcePlaneResolutions.length,
  unresolved,
}
// `unresolved` is REPORTED, not a failure: a source file may name a package in a
// comment or a doc, and the farm links by need. It is listed so a real resolution
// failure cannot hide behind a passing count.
report.verdict = report.duplicateIdentities.length === 0 && report.sourcePlaneResolutions.length === 0 ? 'PASS' : 'FAIL'

console.log(JSON.stringify(report, null, 2))
process.exitCode = report.verdict === 'PASS' ? 0 : 1
