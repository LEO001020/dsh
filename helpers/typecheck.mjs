/**
 * THE authoritative typecheck for this repository — `pnpm typecheck`.
 *
 * WHY A SCRIPT AND NOT A ONE-LINE `tsc -p ...` IN package.json.
 *
 * F10 / `ID-05`: there is no root `tsconfig.json` at all, and the two configs
 * that exist are per-package and mean DIFFERENT things:
 *
 *   packages/<pkg>/tsconfig.json        include src/**\/*.ts, EXCLUDE src/**\/*.test.ts
 *                                       -> correct for the BUILD (test code must
 *                                          never emit into lib/)
 *   packages/<pkg>/tsconfig.check.json  extends it, clears ONLY the exclude,
 *                                       adds noEmit
 *                                       -> correct for the CHECK
 *
 * `tsc -p tsconfig.json --noEmit` therefore exits 0 **with or without** a test
 * file present. That is a FALSE PASS for any gate whose evidence is "the tests
 * type-check", and it is measured, not asserted: the V1 audit injected one type
 * error and got exit 0 from `tsconfig.json` while `tsconfig.check.json` exited 2
 * at exactly the injected line.
 *
 * The audit's judgement (V3 §G3) is that root/solution configs and product-check
 * configs must NOT be forced to mean the same thing -- DSH's own convention keeps
 * the different compiler faces explicit. So the fix is not "merge the configs".
 * The fix is ONE OFFICIAL COMMAND whose identity a reader can cite, which covers
 * the COMPLETE production graph, and which cannot silently degrade.
 *
 * THREE THINGS THIS SCRIPT DOES THAT A BARE `tsc` LINE CANNOT:
 *
 * 1. COVERS EVERY PACKAGE, derived rather than listed. A hand-written list of
 *    packages is a list that goes stale the moment a third package is added, and
 *    a typecheck that silently stops covering a package is the same defect class
 *    as `tsconfig.json` excluding tests: a green light over a smaller graph than
 *    the reader believes. The package set is discovered from
 *    `packages/ *\/tsconfig.check.json`.
 *
 * 2. ASSERTS THE CHECK CONFIG ACTUALLY SEES TEST FILES. This is the guard
 *    against F10 recurring. It resolves each config with `--showConfig` and
 *    refuses to report success if the resolved file list contains no
 *    `*.test.ts`. A future edit that re-adds the exclude to `tsconfig.check.json`
 *    -- or a well-meaning "simplification" that points this script at
 *    `tsconfig.json` -- fails LOUDLY here instead of passing quietly.
 *
 * 3. RESOLVES `tsc` FROM A NAMED PLACE AND PRINTS IT. "Which compiler ran" is
 *    part of the evidence. This project has already filed two FALSE findings by
 *    measuring a stale build (G-SEAM-29, G-SEAM-36), so the script reports the
 *    tsc path and version it used, and the config each package resolved.
 *
 * IT RUNS ONE PACKAGE AT A TIME, DELIBERATELY. Typechecking is the heaviest
 * thing this repository does, and the standing instruction is not to stress the
 * CPU. Sequential is also the only order in which a diagnostic can be
 * attributed to the package it came from without interleaved output.
 *
 * WHAT IT DOES NOT DO. It does not build. It does not run tests. It does not
 * emit anything (both check configs set `noEmit`). A green run here means the
 * COMPLETE production graph, tests included, type-checks -- nothing about
 * runtime behaviour, which is what the qualification gates are for.
 *
 * Exit codes:
 *   0  every package type-checks, and every check config was verified to include
 *      its test files
 *   1  a package failed to type-check, or a check config was found to exclude
 *      the test files (a degraded gate, treated as a failure rather than a pass)
 *   2  the invocation or the toolchain is unusable -- no `tsc`, no configs, a
 *      config that does not resolve. NOT a verdict about the code.
 *
 * Usage:
 *   pnpm typecheck              # every package
 *   pnpm typecheck --json       # machine-readable summary
 *   pnpm typecheck --pkg dsh-ipython
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

const REPO_ROOT = resolve(import.meta.dirname, '..')
const PACKAGES_DIR = join(REPO_ROOT, 'packages')
const CHECK_CONFIG = 'tsconfig.check.json'

function die(message) {
  process.stderr.write(`typecheck: ${message}\n`)
  process.exit(2)
}

function parseArgs(argv) {
  const options = { json: false, only: null, verbose: false }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--json') options.json = true
    else if (arg === '--verbose') options.verbose = true
    else if (arg === '--pkg') {
      options.only = argv[i + 1] ?? null
      if (options.only === null) die('--pkg needs a package name')
      i += 1
    } else die(`unrecognised argument: ${arg}`)
  }
  return options
}

/**
 * Resolve `tsc` from a named, reportable place, in a documented order.
 *
 * The repository has no root `node_modules` and no root lockfile: this project
 * links the pinned checkout's packages into each package's `node_modules` by
 * junction (`packages/*\/link-all-dsh.ps1`), and `typescript` is declared as a
 * per-package devDependency but is resolved from the checkout's install. So the
 * candidates are, in order:
 *
 *   1. the package's own `node_modules/typescript`  (a real `pnpm install`)
 *   2. `$DSH_SRC/node_modules/typescript`           (this machine's layout)
 *   3. `tsc` on PATH                                (a global install)
 *
 * `DSH_SRC` is derived from the lock's `launcher_realpath` when it is not set in
 * the environment, so the checkout is named in ONE place (the same discipline as
 * `build-gates.py` reading the identity out of the lock).
 */
function resolveTsc(pkgDir) {
  const candidates = []

  const local = join(pkgDir, 'node_modules', 'typescript', 'bin', 'tsc')
  if (existsSync(local)) candidates.push({ how: 'package node_modules', path: local })

  const dshSrc = process.env.DSH_SRC ?? deriveDshSrcFromLock()
  if (dshSrc !== null) {
    const fromCheckout = join(dshSrc, 'node_modules', 'typescript', 'bin', 'tsc')
    if (existsSync(fromCheckout)) candidates.push({ how: 'pinned checkout node_modules', path: fromCheckout })
  }

  if (candidates.length === 0) {
    return { how: 'PATH', path: 'tsc' }
  }
  return candidates[0]
}

function deriveDshSrcFromLock() {
  const lockPath = join(REPO_ROOT, 'compatibility.lock.json')
  if (!existsSync(lockPath)) return null
  try {
    const lock = JSON.parse(readFileSync(lockPath, 'utf8'))
    const launcher = lock?.deployment?.inputs?.launcher_realpath
    if (typeof launcher !== 'string' || launcher.length === 0) return null
    // .../<checkout>/apps/cli/lib/bin.js -> <checkout>
    return resolve(dirname(dirname(dirname(dirname(launcher)))))
  } catch {
    return null
  }
}

/**
 * `tsc` on Windows is a shell script; `execFileSync` cannot run a `.CMD` and the
 * extensionless `bin/tsc` is a Node shim. Running it THROUGH node is what makes
 * this work identically from Git Bash, PowerShell and cmd -- and the project has
 * already recorded an `execFileSync`-cannot-run-a-`.CMD` failure (M-DEP-SEC-UPG
 * FINDINGS §6.2), so this is a fixed defect rather than a hypothetical.
 */
function runTsc(tscPath, args, cwd) {
  const result = { exitCode: 0, stdout: '', stderr: '' }
  const invoke = (program, argv) => execFileSync(program, argv, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
  })
  try {
    if (tscPath === 'tsc') {
      result.stdout = invoke('tsc', args)
    } else {
      result.stdout = invoke(process.execPath, [tscPath, ...args])
    }
  } catch (error) {
    result.exitCode = typeof error.status === 'number' ? error.status : 1
    result.stdout = String(error.stdout ?? '')
    result.stderr = String(error.stderr ?? '')
  }
  return result
}

function discoverPackages(only) {
  if (!existsSync(PACKAGES_DIR)) die(`no packages directory at ${PACKAGES_DIR}`)
  const found = []
  for (const entry of readdirSync(PACKAGES_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    if (only !== null && entry.name !== only) continue
    const dir = join(PACKAGES_DIR, entry.name)
    if (existsSync(join(dir, CHECK_CONFIG))) found.push({ name: entry.name, dir })
  }
  found.sort((a, b) => a.name.localeCompare(b.name))
  if (found.length === 0) {
    die(only === null
      ? `no package carries a ${CHECK_CONFIG}; the authoritative check has nothing to run`
      : `package "${only}" has no ${CHECK_CONFIG}`)
  }
  if (only !== null && found.length === 0) die(`no such package: ${only}`)
  return found
}

/**
 * Resolve the config with `--showConfig` and confirm it actually INCLUDES the
 * test files. This is the anti-regression guard described in the header.
 */
function inspectConfig(tscPath, pkg) {
  const resolved = runTsc(tscPath, ['-p', CHECK_CONFIG, '--showConfig'], pkg.dir)
  if (resolved.exitCode !== 0) {
    return {
      ok: false,
      reason: `--showConfig failed (exit ${String(resolved.exitCode)})`,
      detail: (resolved.stderr || resolved.stdout).split('\n').slice(0, 12).join('\n'),
    }
  }
  let parsed
  try {
    parsed = JSON.parse(resolved.stdout)
  } catch (error) {
    return { ok: false, reason: `--showConfig output is not JSON: ${String(error.message)}` }
  }
  const files = Array.isArray(parsed.files) ? parsed.files : []
  const testFiles = files.filter((f) => /\.test\.tsx?$/.test(f))
  const productionFiles = files.filter((f) => !/\.test\.tsx?$/.test(f))
  return {
    ok: testFiles.length > 0,
    reason: testFiles.length > 0
      ? null
      : 'the resolved program contains NO *.test.ts file -- this config excludes the test ' +
        'files, so a green run here would be a FALSE PASS (the F10/ID-05 defect)',
    fileCount: files.length,
    testFileCount: testFiles.length,
    productionFileCount: productionFiles.length,
    noEmit: parsed.compilerOptions?.noEmit === true,
    strict: parsed.compilerOptions?.strict === true,
  }
}

function main() {
  const options = parseArgs(process.argv.slice(2))
  const packages = discoverPackages(options.only)

  // One tsc identity for the whole run: resolving per package could silently
  // measure two different compilers and report one verdict.
  const tsc = resolveTsc(packages[0].dir)
  const versionRun = runTsc(tsc.path, ['--version'], REPO_ROOT)
  const version = versionRun.stdout.trim() || versionRun.stderr.trim() || 'unknown'
  if (versionRun.exitCode !== 0 && tsc.path !== 'tsc') {
    die(`could not run the TypeScript compiler at ${tsc.path}: ${version}`)
  }

  const say = (line) => {
    if (!options.json) process.stdout.write(`${line}\n`)
  }

  say('=== the authoritative typecheck (F10 / ID-05) ===')
  say(`repo:       ${REPO_ROOT}`)
  say(`tsc:        ${tsc.path}`)
  say(`tsc source: ${tsc.how}`)
  say(`version:    ${version}`)
  say(`config:     ${CHECK_CONFIG} in each package (extends tsconfig.json, clears ONLY the exclude)`)
  say(`packages:   ${packages.map((p) => p.name).join(', ')}`)
  say('')

  const results = []
  let failed = 0

  for (const pkg of packages) {
    say(`--- ${pkg.name} ---`)

    // The coverage guard runs FIRST: a config that cannot see the tests is a
    // broken gate, and reporting its exit code as a pass is the defect itself.
    const coverage = inspectConfig(tsc.path, pkg)
    if (!coverage.ok) {
      failed += 1
      results.push({ package: pkg.name, status: 'DEGRADED_GATE', ...coverage })
      say(`[FAIL] ${coverage.reason}`)
      if (coverage.detail) say(coverage.detail)
      say('')
      continue
    }
    say(`[ok  ] the resolved program covers ${String(coverage.fileCount)} files ` +
      `(${String(coverage.productionFileCount)} production + ${String(coverage.testFileCount)} test)`)
    if (!coverage.noEmit) say('[warn] noEmit is not set in the resolved config; nothing should be emitted by a check')
    if (!coverage.strict) say('[warn] strict is not set in the resolved config')

    const started = Date.now()
    const run = runTsc(tsc.path, ['-p', CHECK_CONFIG], pkg.dir)
    const ms = Date.now() - started
    const diagnostics = `${run.stdout}${run.stderr}`.trim()

    if (run.exitCode === 0) {
      say(`[ok  ] typecheck exit 0 in ${String(ms)}ms`)
      if (diagnostics.length > 0) say(diagnostics)
      results.push({
        package: pkg.name,
        status: 'PASS',
        exitCode: 0,
        ms,
        files: coverage.fileCount,
        testFiles: coverage.testFileCount,
      })
    } else {
      failed += 1
      say(`[FAIL] typecheck exit ${String(run.exitCode)} in ${String(ms)}ms`)
      say(diagnostics)
      results.push({
        package: pkg.name,
        status: 'FAIL',
        exitCode: run.exitCode,
        ms,
        files: coverage.fileCount,
        testFiles: coverage.testFileCount,
        diagnostics,
      })
    }
    say('')
  }

  if (options.json) {
    process.stdout.write(`${JSON.stringify({
      tsc: { path: tsc.path, how: tsc.how, version },
      packages: results,
      verdict: failed === 0 ? 'PASS' : 'FAIL',
    }, null, 2)}\n`)
  } else {
    say(failed === 0
      ? `typecheck: PASS -- ${String(packages.length)} package(s), complete production graph, tests included.`
      : `typecheck: FAIL -- ${String(failed)} of ${String(packages.length)} package(s) did not pass.`)
    say('This is the ONE official command. Do not cite `tsc -p tsconfig.json` as its')
    say('equivalent: that config excludes src/**/*.test.ts and exits 0 with or without')
    say('a test file present, which is the F10 / ID-05 false pass.')
  }

  process.exit(failed === 0 ? 0 : 1)
}

main()
