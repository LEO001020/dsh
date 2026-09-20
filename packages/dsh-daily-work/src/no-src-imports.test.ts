/**
 * F4 BUILD GATE — emitted production JS must not import an upstream source path.
 *
 * WHAT THIS GATE EXISTS FOR
 *
 * `packages/dsh-daily-work/lib/artifacts.js` (a BUILT file, so the PRODUCT's path
 * and not a test's) used to contain:
 *
 *     import { publishImmutableObjectStream } from '@deepseek-ai/dsh-attachment-local/src/store.ts'
 *
 * Node 24 loads a `.ts` file by native type stripping, which is why it worked and
 * went unnoticed. It was a real defect for two independent reasons:
 *
 *   1. It mixes DSH's SOURCE plane with its ARTIFACT plane. On the audited build,
 *      223 distinct `@deepseek-ai/*` specifiers resolved in a real boot; 221 resolved
 *      under a `packages/<name>/lib/` path and that one did not, which is why
 *      `ID-01`'s graph clause read FAIL while every other clause passed.
 *   2. It creates a SECOND PHYSICAL MODULE INSTANCE of the provider package, so
 *      module-local state splits. `TOOL_RUNTIME_SCHEDULER` is a module-local
 *      `Symbol()` in the same shape, and a second copy of its package makes it
 *      undefined (upstream Discussion #6529).
 *
 * SCOPE OF THIS GATE, STATED EXACTLY — the tension is real and is not papered over
 *
 * The audit's wording is "production emitted JS contains no forbidden source import"
 * and "production runtime imports must be zero". This gate therefore covers:
 *
 *   COVERED     every emitted `lib/**\/*.js` in EVERY package of this repository.
 *               This is the production runtime graph: the profile loads
 *               `main: lib/host-plugin.js`, so these files are what actually
 *               executes in a boot.
 *   COVERED     every non-test `src/**\/*.ts` in every package. A source file that
 *               names a forbidden specifier is the same defect one build away, so
 *               the gate refuses it at the source as well as in the artifact.
 *   NOT COVERED `src/**\/*.test.ts`. Several test files DELIBERATELY deep-import
 *               `src/*` to exercise the REAL parser rather than a re-implementation
 *               (`dsh-tool-fs/src/read-render.ts`, `dsh-tool-fs/src/read.ts`,
 *               `dsh-tool-fs-search/src/search-core.ts`, `dsh-tool-fs-search/src/grep.ts`,
 *               `dsh-tool-web/src/trust.ts`, `dsh-headless/src/json-stream.ts`).
 *               That is a real tension with the audit's wording, and the resolution
 *               recorded here is: those imports never reach the emitted artifact
 *               (tsconfig excludes test files from the build), and they are the only
 *               way to test against the real implementation. They are therefore
 *               ENUMERATED AND JUSTIFIED below rather than silently allowed, and the
 *               list is a frozen set — a NEW test-side deep import fails this gate
 *               until someone adds it here with a reason.
 *
 * WHY THE ALLOWLIST IS A FROZEN SET RATHER THAN A PATTERN. A gate that allowed "any
 * test file" would let the production defect return through a test that a later
 * refactor moved into the build. The frozen list makes every deep import an explicit
 * decision with a named reason, and the negative control below proves the gate
 * actually fails when a new one appears.
 *
 * HOW IT READS THE FILES. It does NOT regex the raw text for the substring, because
 * a comment or a string literal that merely NAMES a specifier is not an import (this
 * module's own comments cite the forbidden path while explaining the defect). It uses
 * the TypeScript compiler's own preprocessor — the same instrument
 * `qualification/runners/import-graph.mjs` uses — so specifiers come from parsing
 * rather than pattern matching.
 */
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, relative, resolve, sep } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * The TypeScript compiler, resolved from the PINNED CHECKOUT rather than from this
 * package's own farm.
 *
 * `qualification/runners/import-graph.mjs` resolves it the same way and for the same
 * reason: the compiler is a property of the qualified checkout, and a farm junction
 * that happened to be absent would turn this gate into a resolution error instead of
 * a verdict. The narrow type below is what this file actually uses, so the compiler
 * is not re-declared as a whole API surface.
 */
interface PreProcessedFile {
  importedFiles: ReadonlyArray<{ fileName: string }>
  referencedFiles: ReadonlyArray<{ fileName: string }>
}
const DSH_SRC = process.env.DSH_SRC_ROOT ?? 'D:/DSH/src/dsh-src'
const ts = createRequire(join(DSH_SRC, 'node_modules', 'typescript', 'package.json'))('typescript') as {
  preProcessFile(text: string, readImportFiles?: boolean, detectJavaScriptImports?: boolean): PreProcessedFile
}

const REPO_ROOT = resolve(import.meta.dirname, '..', '..', '..')

/** The packages this repository ships. Both are loaded by the daily profile. */
const PACKAGES = ['dsh-daily-work', 'dsh-ipython'] as const

/**
 * The forbidden specifier shape.
 *
 * `@deepseek-ai/dsh-<name>/src/<anything>`. Deliberately anchored on `/src/` and not
 * on `.ts`: a specifier that resolves into a source tree is the defect regardless of
 * the extension it names, and pinning the extension would let `src/x.js` through.
 */
const FORBIDDEN = /^@deepseek-ai\/[a-z0-9-]+\/src\//u

/**
 * The test-side deep imports that are DELIBERATE, each with its reason and the
 * oracle it serves.
 *
 * Every one of these exercises a REAL upstream implementation instead of a
 * re-implementation, which is the only way the claim "the product's own parser does
 * X" can be tested. They are excluded from the build by `tsconfig.json`'s
 * `exclude: ["src/**\/*.test.ts"]`, so none of them can reach emitted JS.
 */
const JUSTIFIED_TEST_IMPORTS: Readonly<Record<string, string>> = {
  'packages/dsh-daily-work/src/data-plane.test.ts':
    'DAT-01/07: drives the REAL `buildWindow` and the REAL `read` tool so the truncation claim is measured against the shipped implementation, not a copy of it. Also `resolveRgPath`/`runRipgrep`/`parseGrepMatches` for the real ripgrep raw-cap path.',
  'packages/dsh-daily-work/src/history-web.test.ts':
    'Asserts this package\'s untrusted-content notice is EQUAL to DSH\'s own literal, so an upstream divergence is a FAIL rather than a silent drift.',
  'packages/dsh-daily-work/src/eco.test.ts':
    'Asserts this package\'s JSON-line bounder agrees with the headless runner\'s, so the two cannot drift apart unnoticed.',
}

/** Every `lib/**\/*.js` under a package directory, recursively. */
function emittedJs(packageDir: string): string[] {
  const out: string[] = []
  const walk = (dir: string): void => {
    if (!existsSync(dir)) return
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.name.endsWith('.js')) out.push(full)
    }
  }
  walk(join(packageDir, 'lib'))
  return out.sort()
}

/** Every `src/**\/*.ts` under a package directory, split into production and test. */
function sourceTs(packageDir: string): { production: string[]; tests: string[] } {
  const production: string[] = []
  const tests: string[] = []
  const walk = (dir: string): void => {
    if (!existsSync(dir)) return
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.name.endsWith('.ts')) {
        if (entry.name.endsWith('.test.ts')) tests.push(full)
        else production.push(full)
      }
    }
  }
  walk(join(packageDir, 'src'))
  return { production: production.sort(), tests: tests.sort() }
}

/**
 * The module specifiers a file actually imports, from the TypeScript compiler's own
 * preprocessor.
 *
 * WHY NOT A REGEX. A hand-rolled pattern both misses a multi-line import (braces
 * spanning lines, then the from-clause) and produces FALSE POSITIVES from a
 * specifier named inside a string literal or a comment. `ts.preProcessFile` parses,
 * so the answer is the set of real import specifiers. This is the same reason
 * `qualification/runners/import-graph.mjs` uses it, and that file records the
 * measured divergence between the two approaches.
 */
function importSpecifiers(path: string): string[] {
  const text = readFileSync(path, 'utf8')
  const parsed = ts.preProcessFile(text, true, true)
  return [
    ...parsed.importedFiles.map((entry: { fileName: string }) => entry.fileName),
    ...parsed.referencedFiles.map((entry: { fileName: string }) => entry.fileName),
  ].filter((name: string) => name.startsWith('@deepseek-ai/'))
}

/** A repo-relative path with forward slashes, for stable allowlist keys and messages. */
function repoRel(path: string): string {
  return relative(REPO_ROOT, path).split(sep).join('/')
}

/** Every forbidden specifier found in a file, as `specifier` strings. */
function forbiddenIn(path: string): string[] {
  return importSpecifiers(path).filter(specifier => FORBIDDEN.test(specifier))
}

describe('F4 gate: no emitted production JS imports an upstream `src/*` path', () => {
  it('the emitted `lib/` of every package is clean, and the check is not vacuous', () => {
    const scanned: Array<{ file: string; bytes: number }> = []
    const offenders: Array<{ file: string; specifier: string }> = []
    for (const pkg of PACKAGES) {
      for (const file of emittedJs(join(REPO_ROOT, 'packages', pkg))) {
        scanned.push({ file: repoRel(file), bytes: statSync(file).size })
        for (const specifier of forbiddenIn(file)) offenders.push({ file: repoRel(file), specifier })
      }
    }
    // NON-VACUITY. A gate that scanned zero files would pass forever, and this
    // project has already filed a defect against exactly that shape of green. The
    // build must have produced output, and the artifact that carried the original
    // defect must be among the files scanned by name.
    expect(scanned.length, 'the build must have emitted JS for this gate to mean anything').toBeGreaterThan(0)
    expect(
      scanned.map(entry => entry.file),
      'the built artifact that carried defect F4 must be in the scanned set',
    ).toContain('packages/dsh-daily-work/lib/artifacts.js')

    expect(
      offenders,
      `emitted production JS must contain ZERO \`@deepseek-ai/dsh-*/src/*\` imports.\n`
      + `Scanned ${String(scanned.length)} files:\n`
      + scanned.map(entry => `  ${entry.file} (${String(entry.bytes)} bytes)`).join('\n'),
    ).toEqual([])
  })

  it('non-test `src/` is clean too, so the defect cannot return one build away', () => {
    const offenders: Array<{ file: string; specifier: string }> = []
    let scanned = 0
    for (const pkg of PACKAGES) {
      const { production } = sourceTs(join(REPO_ROOT, 'packages', pkg))
      for (const file of production) {
        scanned += 1
        for (const specifier of forbiddenIn(file)) offenders.push({ file: repoRel(file), specifier })
      }
    }
    expect(scanned, 'the packages must have production sources').toBeGreaterThan(0)
    expect(
      offenders,
      'a production SOURCE that names a forbidden specifier is the same defect one build away',
    ).toEqual([])
  })

  it('the only remaining deep imports are the frozen, justified test set', () => {
    const found = new Map<string, string[]>()
    for (const pkg of PACKAGES) {
      const { tests } = sourceTs(join(REPO_ROOT, 'packages', pkg))
      for (const file of tests) {
        const specifiers = forbiddenIn(file)
        if (specifiers.length > 0) found.set(repoRel(file), specifiers)
      }
    }

    // The allowlist is EXACT in both directions: an unlisted deep import fails, and
    // a stale allowlist entry also fails (so the list cannot rot into a fiction).
    const unlisted = [...found.keys()].filter(file => JUSTIFIED_TEST_IMPORTS[file] === undefined)
    expect(
      unlisted,
      'a NEW test-side deep import must be added to JUSTIFIED_TEST_IMPORTS with a reason, '
      + 'not silently allowed',
    ).toEqual([])

    const stale = Object.keys(JUSTIFIED_TEST_IMPORTS).filter(file => !found.has(file))
    expect(stale, 'an allowlist entry with no matching import is stale and must be removed').toEqual([])

    // And the justified set is reported so a reader sees what is being tolerated.
    expect([...found.keys()].sort()).toEqual(Object.keys(JUSTIFIED_TEST_IMPORTS).sort())
  })

  /**
   * THE NEGATIVE CONTROL. A gate that cannot fail is not a gate, so the forbidden
   * specifier is INJECTED into a real production source file, the gate's own
   * detector is run over it, and the file is restored.
   *
   * WHY THE DETECTOR AND NOT THE WHOLE TEST. The two assertions above read the tree
   * from disk; re-running the file would be a second vitest process. Injecting into
   * the real file and calling the same `forbiddenIn` the assertions call exercises
   * the exact code path that decides PASS/FAIL, and the file is restored in a
   * `finally` with the restoration ASSERTED — a failed restore would leave the
   * product mutated, which is worse than a red gate.
   *
   * The full end-to-end failure (a fresh `tsc` build of a mutated source, then this
   * gate run against the mutated `lib/`) is recorded as a MEASURED transcript in the
   * slice's report rather than re-run here, because it needs a second process.
   */
  it('the detector FAILS when a forbidden specifier is injected, then the file is restored', () => {
    const target = join(REPO_ROOT, 'packages', 'dsh-daily-work', 'src', 'artifacts.ts')
    const original = readFileSync(target, 'utf8')
    const injection = "import { publishImmutableObjectStream } from '@deepseek-ai/dsh-attachment-local/src/store.ts'\n"
    try {
      // CONTROL 1 — clean before the injection, so a later failure is attributable.
      expect(forbiddenIn(target), 'the real file must be clean before the injection').toEqual([])

      // INJECT. Appended rather than spliced: the point is that a forbidden
      // specifier is PRESENT, and appending cannot corrupt the rest of the file if
      // the restore fails.
      writeFileSyncRaw(target, `${original}${injection}`)
      const detected = forbiddenIn(target)
      expect(detected, 'the detector MUST see an injected forbidden specifier').toEqual([
        '@deepseek-ai/dsh-attachment-local/src/store.ts',
      ])
    } finally {
      writeFileSyncRaw(target, original)
    }

    // CONTROL 2 — the restoration is ASSERTED, so a failed restore is loud rather
    // than a product left mutated.
    expect(readFileSync(target, 'utf8')).toBe(original)
    expect(forbiddenIn(target), 'the restored file must be clean again').toEqual([])
  })

  it('the same detector finds the specifier in the BUILT artifact form, so the gate is not source-only', () => {
    // The emitted form differs from the source form only in quoting and the
    // semicolon, and the gate must see it there too. This is asserted on a
    // SYNTHETIC emitted file rather than by mutating a real `lib/`, because a
    // mutated `lib/` is what the product would boot, and the end-to-end version of
    // this proof is run as a separate measured command.
    const specifier = '@deepseek-ai/dsh-attachment-local/src/store.ts'
    const emittedForm = `import { publishImmutableObjectStream } from '${specifier}';\n`
    expect(importSpecifiersFromText(emittedForm)).toContain(specifier)
    expect(importSpecifiersFromText(emittedForm).filter(s => FORBIDDEN.test(s))).toEqual([specifier])
    // A COMMENT that merely names the path is NOT an import, which is why this gate
    // parses rather than greps: `artifacts.ts` cites the forbidden path in its own
    // documentation of the defect and must not fail itself.
    const commentOnly = `// see ${specifier} for the original defect\n`
    expect(importSpecifiersFromText(commentOnly)).toEqual([])
    const stringOnly = `export const citation = '${specifier}'\n`
    expect(importSpecifiersFromText(stringOnly)).toEqual([])
  })
})

/** `ts.preProcessFile` over in-memory text, so the emitted form can be checked without a file. */
function importSpecifiersFromText(text: string): string[] {
  const parsed = ts.preProcessFile(text, true, true)
  return [
    ...parsed.importedFiles.map((entry: { fileName: string }) => entry.fileName),
    ...parsed.referencedFiles.map((entry: { fileName: string }) => entry.fileName),
  ].filter((name: string) => name.startsWith('@deepseek-ai/'))
}

/** Write text back exactly, so the restore is byte-identical. */
function writeFileSyncRaw(path: string, text: string): void {
  // `utf8` with no BOM and no newline translation. The gate asserts an EXACT
  // restore, so anything that rewrote the bytes would be caught rather than
  // silently accepted.
  writeFileSync(path, text, { encoding: 'utf8' })
}
