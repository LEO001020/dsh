/**
 * F10 / `ID-05` mutation test — reproducible evidence for the official command.
 *
 * WHAT THIS PROVES, in both directions, which is what the oracle demands:
 *
 *   1. clean tree            -> `pnpm typecheck` exits 0
 *   2. type error injected   -> `pnpm typecheck` exits non-zero and names the file
 *   3. restored byte-exact   -> `pnpm typecheck` exits 0 again
 *
 * plus the CONTROL ARM the oracle itself names: the same injected error compiled
 * under `tsc -p tsconfig.json` exits 0 and MISSES it, because that config
 * excludes `src/**\/*.test.ts`. That contrast is why a green run under
 * `tsconfig.json` alone is not acceptable evidence.
 *
 * TWO MEASUREMENT TRAPS THIS SCRIPT IS BUILT AROUND, both of which produced a
 * wrong reading once before this file existed:
 *
 *   TRAP 1 -- NEWLINE TRANSLATION ON RESTORE. Python's `read_text`/`write_text`
 *   translate newlines on Windows, so a "restore" rewrote 332 LF as 332 CRLF and
 *   the file stopped being byte-exact (sha `25349859...` instead of
 *   `c38f7ee8...`). The restore here writes BYTES, taken from `git cat-file blob
 *   HEAD:<path>` -- the index's own content, not a re-serialisation -- and the
 *   hash is printed on both sides so "byte-exact" is checkable rather than
 *   asserted.
 *
 *   TRAP 2 -- `tsc` IS A NODE SHIM. `bin/tsc` is a script, not a Windows
 *   executable, so spawning it directly fails with `WinError 193: %1 is not a
 *   valid Win32 application`. Every invocation here goes through
 *   `process.execPath`, which also makes the command identical from Git Bash,
 *   PowerShell and cmd.
 *
 * The mutation is a TYPE error on purpose: a syntax error would be caught by the
 * BUILD config too and would not exercise the clause this case is about.
 *
 * Run:  node qualification/results/R2-F10F11/mutation-test.mjs
 * Exit: 0 the oracle is established, 1 it is not, 2 the rig is unusable
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const REPO = resolve(import.meta.dirname, '..', '..', '..')
const PKG = join(REPO, 'packages', 'dsh-ipython')
const PROD = join(PKG, 'src', 'protocol.ts')
const TEST = join(PKG, 'src', 'protocol.test.ts')
const DSH_SRC = process.env.DSH_SRC ?? 'D:/DSH/src/dsh-src'
const TSC = join(DSH_SRC, 'node_modules', 'typescript', 'bin', 'tsc')

const sha256 = (path) => createHash('sha256').update(readFileSync(path)).digest('hex')

/** Run a command with no shell, so a path with a space is not re-split. */
function run(program, args, cwd) {
  const started = Date.now()
  try {
    const stdout = execFileSync(program, args, {
      cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024,
    })
    return { exitCode: 0, output: stdout, ms: Date.now() - started }
  } catch (error) {
    return {
      exitCode: typeof error.status === 'number' ? error.status : 1,
      output: `${String(error.stdout ?? '')}${String(error.stderr ?? '')}`,
      ms: Date.now() - started,
    }
  }
}

/**
 * The OFFICIAL command, exactly as a reader would type it.
 *
 * TRAP 3 -- `pnpm` ON WINDOWS IS NOT AN EXECUTABLE. It is a shell script
 * (`pnpm`) plus a `pnpm.cmd` batch wrapper, so `execFileSync('pnpm', ...)` fails
 * with `ENOENT` in ~2 ms and a script that treated that as "the command failed"
 * would report the mutation as caught for the wrong reason. This is the same
 * defect class the project already recorded for `tsc` (M-DEP-SEC-UPG FINDINGS
 * §6.2, "execFileSync cannot run a .CMD on Windows"). Going through `cmd.exe`
 * is what makes this the command a reader actually types, rather than an
 * approximation of it that happens to run.
 */
const COMSPEC = process.env.ComSpec ?? 'cmd.exe'
const official = () => run(COMSPEC, ['/d', '/c', 'pnpm', 'typecheck'], REPO)
/** The config the oracle says is NOT acceptable evidence. Through node (trap 2). */
const buildConfig = () => run(process.execPath, [TSC, '-p', 'tsconfig.json', '--noEmit'], PKG)

/** Restore from the index's own blob, as BYTES (trap 1). */
function restore(relPath, dest) {
  const blob = execFileSync('git', ['-C', REPO, 'cat-file', 'blob', `HEAD:${relPath}`], {
    maxBuffer: 64 * 1024 * 1024,
  })
  writeFileSync(dest, blob)
  return sha256(dest)
}

function report(label, result, grep) {
  console.log(`$ ${label}`)
  console.log(`exit=${String(result.exitCode)} in ${String(result.ms)}ms`)
  for (const line of result.output.split('\n')) {
    if (grep.some((needle) => line.includes(needle))) console.log(line)
  }
  return result.exitCode
}

function main() {
  if (!existsSync(TSC)) {
    process.stderr.write(`mutation-test: no compiler at ${TSC}\n`)
    process.exit(2)
  }
  for (const p of [PROD, TEST]) {
    if (!existsSync(p)) {
      process.stderr.write(`mutation-test: missing ${p}\n`)
      process.exit(2)
    }
  }

  const prodRel = 'packages/dsh-ipython/src/protocol.ts'
  const testRel = 'packages/dsh-ipython/src/protocol.test.ts'
  const prodBefore = sha256(PROD)
  const testBefore = sha256(TEST)
  const tscVersion = run(process.execPath, [TSC, '--version'], REPO).output.trim()

  console.log('=== F10 / ID-05 MUTATION TEST -- the official command must be sensitive in BOTH directions ===')
  console.log()
  console.log('Identity measured under:')
  console.log(`  tree      : ${REPO}   (branch wt/r2b, a worktree of the pinned repository)`)
  console.log(`  compiler  : ${TSC}`)
  console.log(`  version   : ${tscVersion}`)
  console.log('  command   : pnpm typecheck  ->  node helpers/typecheck.mjs')
  console.log(`  prod file : ${prodRel}  sha256 ${prodBefore}`)
  console.log(`  test file : ${testRel}  sha256 ${testBefore}`)
  console.log()

  const PROD_INJECTION = [
    '',
    '// R2-F10 MUTATION -- injected type error on a PRODUCTION file.',
    "const R2_F10_MUTATION: number = 'not a number'",
    'export const R2_F10_MUTATION_USE = R2_F10_MUTATION',
    '',
  ].join('\n')
  const TEST_INJECTION = [
    '',
    '// R2-F10 MUTATION -- injected type error on a TEST file.',
    "const R2_F10_TEST_MUTATION: number = 'not a number'",
    'export const R2_F10_TEST_MUTATION_USE = R2_F10_TEST_MUTATION',
    '',
  ].join('\n')

  // ---- ARM 1 --------------------------------------------------------------
  console.log('=== ARM 1: CLEAN TREE -> the official command MUST pass ===')
  const arm1 = report('pnpm typecheck', official(), ['typecheck:', '[ok  ]', '[FAIL]']) === 0
  console.log(`ARM 1: ${arm1 ? 'PASS -- clean tree exits 0' : 'UNEXPECTED -- clean tree did not exit 0'}`)
  console.log()

  // ---- ARM 2: production file ---------------------------------------------
  console.log('=== ARM 2: TYPE ERROR INJECTED INTO A PRODUCTION FILE -> the official command MUST fail ===')
  writeFileSync(PROD, readFileSync(PROD) + PROD_INJECTION)
  console.log(`injected into protocol.ts (TS2322, a TYPE error, not a syntax error)`)
  const r2 = official()
  const r2code = report('pnpm typecheck', r2, ['protocol.ts', 'typecheck:', '[FAIL]'])
  const arm2 = r2code !== 0 && r2.output.includes('protocol.ts')
  console.log(`ARM 2: ${arm2 ? 'PASS -- non-zero exit, and the injected file is named' : 'FAIL -- the mutation was not caught'}`)
  const prodRestored1 = restore(prodRel, PROD)
  console.log(`restored protocol.ts: sha256 ${prodRestored1}  byte-exact=${String(prodRestored1 === prodBefore)}`)
  console.log()

  // ---- CONTROL ARM --------------------------------------------------------
  console.log('=== CONTROL ARM -- the contrast ID-05 names: the same error under `tsc -p tsconfig.json` ===')
  console.log()
  console.log('The F10 trap is only visible on a file the BUILD config excludes, so both arms')
  console.log('are run twice: once against a production file, once against a test file.')
  console.log()

  console.log('--- control 2a: the error in the PRODUCTION file ---')
  writeFileSync(PROD, readFileSync(PROD) + PROD_INJECTION)
  const c2a = report('tsc -p tsconfig.json --noEmit   (cwd: packages/dsh-ipython)', buildConfig(), ['protocol.ts'])
  console.log('   -> tsconfig.json INCLUDES this file (it is not a test), so it catches it too.')
  const prodRestored2 = restore(prodRel, PROD)
  console.log(`   restored: byte-exact=${String(prodRestored2 === prodBefore)}`)
  console.log()

  console.log('--- control 2b: the error in the TEST file (the case the oracle is actually about) ---')
  writeFileSync(TEST, readFileSync(TEST) + TEST_INJECTION)
  const c2b = report('tsc -p tsconfig.json --noEmit   (cwd: packages/dsh-ipython)', buildConfig(), ['protocol.test.ts'])
  console.log('   -> EXCLUDES src/**/*.test.ts, so it MISSES the error entirely.')
  const controlMisses = c2b === 0
  console.log()

  console.log('--- and the OFFICIAL command on the SAME mutation, still in place ---')
  const rOfficial = official()
  const officialCatches = report('pnpm typecheck', rOfficial, ['protocol.test.ts', 'typecheck:', '[FAIL]']) !== 0
    && rOfficial.output.includes('protocol.test.ts')
  console.log()
  console.log(`CONTROL: tsc -p tsconfig.json exit=${String(c2b)} (${controlMisses ? 'MISSED' : 'caught'})` +
    `  |  pnpm typecheck exit=${String(rOfficial.exitCode)} (${officialCatches ? 'CAUGHT' : 'missed'})`)
  const testRestored = restore(testRel, TEST)
  console.log(`restored protocol.test.ts: sha256 ${testRestored}  byte-exact=${String(testRestored === testBefore)}`)
  console.log()

  // ---- ARM 3 --------------------------------------------------------------
  console.log('=== ARM 3: RESTORED TREE -> the official command MUST pass again ===')
  const arm3 = report('pnpm typecheck', official(), ['typecheck:', '[ok  ]', '[FAIL]']) === 0
  console.log(`ARM 3: ${arm3 ? 'PASS -- exits 0 again after restore' : 'UNEXPECTED -- restored tree did not exit 0'}`)
  console.log()

  const prodAfter = sha256(PROD)
  const testAfter = sha256(TEST)

  console.log('=== VERDICT ===')
  console.log(`arm1    clean -> exit 0                        : ${String(arm1)}`)
  console.log(`arm2    production mutation -> non-zero exit    : ${String(arm2)}`)
  console.log(`arm3    restored -> exit 0                      : ${String(arm3)}`)
  console.log(`control tsconfig.json MISSES the test error     : ${String(controlMisses)}`)
  console.log(`control pnpm typecheck CATCHES it               : ${String(officialCatches)}`)
  console.log(`restore protocol.ts      byte-exact             : ${String(prodAfter === prodBefore)}  (${prodAfter})`)
  console.log(`restore protocol.test.ts byte-exact             : ${String(testAfter === testBefore)}  (${testAfter})`)
  console.log()
  console.log('(control 2a, the production-file arm under tsconfig.json, exits ' +
    `${String(c2a)} -- recorded for completeness, not part of the verdict)`)

  const established = arm1 && arm2 && arm3 && controlMisses && officialCatches
    && prodAfter === prodBefore && testAfter === testBefore
  console.log()
  console.log(established ? 'ORACLE ESTABLISHED' : 'ORACLE NOT ESTABLISHED')
  process.exit(established ? 0 : 1)
}

main()
