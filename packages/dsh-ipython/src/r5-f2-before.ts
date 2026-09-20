/**
 * R5 / F2 — the BEFORE reproduction, archived before the behaviour changed.
 *
 * WHY THIS FILE IS COMMITTED RATHER THAN RUN AND DELETED. The shared brief's §7
 * requires the old reproduction to be archived BEFORE the change, so the
 * before/after pair is on disk and a reader can see what was actually broken
 * instead of taking a changelog's word for it. This file is that archive, and it
 * is deliberately written so it keeps working AFTER the fix: the arms below
 * measure the same two facts either way, and the AFTER run of the same
 * instrument is what makes the pair meaningful.
 *
 * WHAT IT MEASURES. The two halves of `G-SEAM-34`/`F2` and the record half of
 * `G-SEAM-54`/`BR-07`:
 *
 *   1. REACHABILITY. The transitive closure of this package's own `exports`
 *      roots — the modules a profile boot can actually load — does not include
 *      `bridge.ts` or `native-call.ts`. Measured from the real `package.json`
 *      `exports` map, not from a hand-listed entry set.
 *   2. CONSTRUCTION. `new BridgeServer` has no production call site. Measured by
 *      scanning every non-test module in the package for the constructor and
 *      excluding the probe/measurement modules, so a probe cannot count as a
 *      product caller (that is precisely the weaker-oracle substitution the
 *      brief forbids).
 *   3. DISPOSITION VOCABULARY. `disposition`, `jobId` and `handoff` appear zero
 *      times on the bridge route and 21 times on the scope route. Counted, not
 *      asserted.
 *
 * WHAT IT DOES NOT DO. It does not boot a kernel and it does not start a
 * `BridgeServer`. Both of those are heavier and are measured by the tests that
 * own them; this instrument is the reachability/record half only, so it can run
 * in the same breath as everything else without competing for CPU.
 *
 * Run:  node --experimental-strip-types src/r5-f2-before.ts
 * Out:  JSON on stdout, and to $R5_OUT when that is set.
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PACKAGE_ROOT = dirname(HERE)
const REPO_ROOT = dirname(dirname(PACKAGE_ROOT))

/**
 * Modules that are INSTRUMENTS rather than product.
 *
 * Excluded from the "production call site" scan for the reason the brief gives:
 * a probe that constructs the bridge proves the module works and proves nothing
 * about the product. Counting one as a caller is how this project filed its
 * false reachability claims. `t7-measure.ts` and the `v4-*-probe.ts` family are
 * hand-run CLIs, not loadable exports.
 */
const INSTRUMENT_MODULES = new Set([
  't7-measure.ts',
  'v4-bridge-probe.ts',
  'v4-bridge-approval-probe.ts',
  'v4-bridge-drain-probe.ts',
  'r5-f2-before.ts',
  'r5-f2-after.ts',
])

/** Every `src/*.ts` module of one package. */
function srcModules(pkgDir: string): string[] {
  return readdirSync(join(pkgDir, 'src')).filter(file => file.endsWith('.ts')).sort()
}

const isTest = (file: string): boolean => /\.test\.ts$/.test(file)

/**
 * Resolve one relative specifier to a `src/*.ts` path.
 *
 * `allowImportingTsExtensions` means the sources write `./bridge.ts`, so the
 * specifier is usually already the file name; the `.js` and `/index.ts` arms
 * exist so a compiled-style specifier maps back rather than being reported as
 * external, which would silently drop a real edge from the closure.
 */
function resolveSpecifier(fromFile: string, spec: string, modules: readonly string[]): string | undefined {
  if (!spec.startsWith('.')) return undefined
  const absolute = resolve(dirname(join(PACKAGE_ROOT, fromFile)), spec)
  const rel = relative(join(PACKAGE_ROOT, 'src'), absolute).replace(/\\/g, '/')
  for (const candidate of [rel, rel.replace(/\.js$/, '.ts'), `${rel}/index.ts`]) {
    if (modules.includes(candidate)) return candidate
  }
  return undefined
}

/** Every relative specifier in a file, without a parser: import/export/from/dynamic import. */
function specifiersOf(text: string): string[] {
  const found: string[] = []
  const patterns = [
    /(?:^|\n)\s*import\s+[^'\n]*?from\s*'([^']+)'/gu,
    /(?:^|\n)\s*import\s*'([^']+)'/gu,
    /(?:^|\n)\s*export\s+[^'\n]*?from\s*'([^']+)'/gu,
    /import\s*\(\s*'([^']+)'\s*\)/gu,
  ]
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      if (match[1] !== undefined) found.push(match[1])
    }
  }
  return found
}

/** The `src/*.ts` modules reachable from the package's own `exports` roots. */
function reachableFromExports(): { roots: string[], reachable: Set<string> } {
  const manifest = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8')) as {
    exports: Record<string, { default?: string } | string>
  }
  const modules = srcModules(PACKAGE_ROOT)
  const roots: string[] = []
  for (const [sub, target] of Object.entries(manifest.exports)) {
    if (sub === './package.json') continue
    const def = typeof target === 'string' ? target : target.default
    if (def === undefined) continue
    // `<pkg>/lib/x.js` is built from `<pkg>/src/x.ts`.
    const match = /^\.\/lib\/(.+)\.js$/u.exec(def)
    if (match?.[1] === undefined) continue
    roots.push(`src/${match[1]}.ts`)
  }
  const reachable = new Set<string>()
  const queue = [...roots]
  while (queue.length > 0) {
    const current = queue.shift()
    if (current === undefined || reachable.has(current)) continue
    reachable.add(current)
    if (!modules.includes(current.replace(/^src\//u, ''))) continue
    const text = readFileSync(join(PACKAGE_ROOT, current), 'utf8')
    for (const spec of specifiersOf(text)) {
      const target = resolveSpecifier(current, spec, modules)
      if (target !== undefined && !reachable.has(`src/${target}`)) queue.push(`src/${target}`)
    }
  }
  return { roots: [...new Set(roots)].sort(), reachable }
}

/** Non-test, non-instrument modules that mention a symbol. */
function productionMentions(needle: string): string[] {
  const hits: string[] = []
  for (const file of srcModules(PACKAGE_ROOT)) {
    if (isTest(file) || INSTRUMENT_MODULES.has(file)) continue
    const text = readFileSync(join(PACKAGE_ROOT, 'src', file), 'utf8')
    if (text.includes(needle)) hits.push(file)
  }
  return hits
}

/** How many times a word appears in a file, or 0 when the file is absent. */
function countIn(path: string, word: string): number {
  try {
    const text = readFileSync(path, 'utf8')
    return text.split(word).length - 1
  } catch {
    return 0
  }
}

const { roots, reachable } = reachableFromExports()
const bridgeReachable = reachable.has('src/bridge.ts')
const nativeCallReachable = reachable.has('src/native-call.ts')

const bridgeRoute = join(PACKAGE_ROOT, 'src', 'bridge.ts')
const nativeCallRoute = join(PACKAGE_ROOT, 'src', 'native-call.ts')
const scopeRoute = join(REPO_ROOT, 'packages', 'dsh-daily-work', 'src', 'programmatic-scope.ts')

const observed = {
  instrument: 'r5-f2-before',
  tree: PACKAGE_ROOT,
  /**
   * The identity this was measured under. The point is that a reader can tell
   * this was taken on THIS worktree's sources and not on a stale `lib/` or
   * another checkout — the failure mode that produced G-SEAM-29/36.
   */
  identity: {
    packageRoot: PACKAGE_ROOT,
    measuredFrom: 'src/*.ts',
    bridgeClientDigest: (() => {
      const text = readFileSync(bridgeRoute, 'utf8')
      const match = /export const PYTHON_CLIENT_SOURCE = `([\s\S]*?)`\n\n\/\*\* The bytes/u.exec(text)
      return match?.[1] === undefined ? null : match[1].length
    })(),
  },
  exportsRoots: roots,
  reachableModules: [...reachable].sort(),
  f2: {
    bridgeReachableFromExports: bridgeReachable,
    nativeCallReachableFromExports: nativeCallReachable,
    newBridgeServerProductionCallSites: productionMentions('new BridgeServer'),
    nonTestImportersOfBridge: productionMentions("from './bridge.ts'"),
    nonTestImportersOfNativeCall: productionMentions("from './native-call.ts'"),
    verdict: bridgeReachable
      ? 'REACHABLE — a profile boot can load the bridge.'
      : 'UNREACHABLE — the mechanism exists and no product path reaches it (F2 / G-SEAM-34).',
  },
  br07: {
    words: ['disposition', 'jobId', 'handoff'] as const,
    countsOnBridgeRoute: Object.fromEntries(
      (['disposition', 'jobId', 'handoff'] as const).map(word => [word, countIn(bridgeRoute, word) + countIn(nativeCallRoute, word)]),
    ),
    countsOnScopeRoute: Object.fromEntries(
      (['disposition', 'jobId', 'handoff'] as const).map(word => [word, countIn(scopeRoute, word)]),
    ),
  },
}

const text = JSON.stringify(observed, null, 2)
const out = process.env['R5_OUT']
if (out !== undefined && out !== '') writeFileSync(out, text + '\n', 'utf8')
process.stdout.write(text + '\n')
