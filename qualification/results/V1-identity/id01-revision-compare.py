#!/usr/bin/env python3
"""Decide the revision question for the ID-01 finding using TypeScript itself.

WHY NOT A REGEX. The previous two versions of this comparison used hand-rolled
regexes to erase type annotations, and each produced a WRONG answer in a
different direction: the first compared signatures and reported a divergence
that was only erased types; the second mangled the object literal
`{ sha256: staged.sha256 }` into `{ sha256 }` and reported a divergence that was
its own corruption. A hand-rolled approximation of a compiler is a second
compiler, and this project has already recorded what happens when two
instruments disagree about one module (R3 vs T9 on the import graph).

So this uses `ts.transpileModule` -- the TypeScript compiler the build itself
uses -- to strip types from `src/store.ts`, and compares the result with the
build's own output. If the compiler says they are the same text modulo
formatting, that is a statement about the compiler's output, not about a regex.

WHAT IT DOES NOT DO. It does not decide whether the duplicate instance matters.
It decides whether the two copies are the same revision.

Usage:
    python qualification/results/V1-identity/id01-revision-compare.py
"""
from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]
TSC_DIR = "D:/DSH/src/dsh-src/node_modules/typescript"
PKG = Path("D:/DSH/src/dsh-src/packages/attachment/attachment-local")
FUNCTION = "publishImmutableObjectStream"

JS_COMPARE = r"""
// ANCHOR THE REQUIRE AT THE CHECKOUT, NOT AT THIS FILE. A bare `require('typescript')`
// resolves from THIS script's directory, and this script lives under
// `qualification/results/V1-identity/`, which has no `node_modules` ancestor --
// measured: `Error: Cannot find module 'typescript'`. `NODE_PATH` does not fix it
// for a CJS require in Node 24 either. The checkout's own directory carries the
// dependency, so `createRequire` is anchored there. This is the same resolution
// rule the T17 overlay documents for a boot probe.
const { createRequire } = require('node:module')
const requireFromCheckout = createRequire('D:/DSH/src/dsh-src/package.json')
const ts = requireFromCheckout('typescript')
const fs = require('fs')

// ARGUMENT INDICES. When node runs a FILE, `process.argv` is
// [node, <script path>, ...args] -- so the first caller argument is argv[2], not
// argv[1]. The first version used argv[1] and was therefore shifted by one:
// `functionName` became `undefined`, `body()` found nothing, and the script
// printed `identicalAfterTranspile: false` with null bodies -- a DIVERGENT
// finding produced entirely by an off-by-one. The count is asserted below so a
// future shift fails loudly instead of silently comparing the wrong things.
if (process.argv.length < 5) {
  console.error('usage: node <script> <srcPath> <builtPath> <functionName>')
  process.exit(2)
}
const srcPath = process.argv[2]
const builtPath = process.argv[3]
const functionName = process.argv[4]

const source = fs.readFileSync(srcPath, 'utf8')
// `transpileModule` is the same type-erasing path the build uses for a single
// file. `isolatedModules` keeps it from type-checking (which is not the
// question here) while still erasing annotations.
const transpiled = ts.transpileModule(source, {
  compilerOptions: {
    target: ts.ScriptTarget.ES2024,
    module: ts.ModuleKind.ESNext,
    isolatedModules: true,
    removeComments: true,
  },
}).outputText

const built = fs.readFileSync(builtPath, 'utf8')

/** The brace body of a named function, or null. */
function body(text, name) {
  const re = new RegExp('\\b(?:async\\s+)?function\\s+' + name + '\\b')
  const m = re.exec(text)
  if (m === null) return null
  const start = text.indexOf('{', m.index + m[0].length)
  if (start < 0) return null
  let depth = 0
  for (let i = start; i < text.length; i += 1) {
    if (text[i] === '{') depth += 1
    else if (text[i] === '}') {
      depth -= 1
      if (depth === 0) return text.slice(start, i + 1)
    }
  }
  return null
}

/** Collapse whitespace so formatting is not a difference. */
function flat(text) {
  return text.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\s+/g, ' ').trim()
}

const fromSrc = body(transpiled, functionName)
const fromBuilt = body(built, functionName)

const result = {
  transpiledFunctionFound: fromSrc !== null,
  builtFunctionFound: fromBuilt !== null,
  identicalAfterTranspile: fromSrc !== null && fromBuilt !== null && flat(fromSrc) === flat(fromBuilt),
  transpiledBody: fromSrc === null ? null : flat(fromSrc),
  builtBody: fromBuilt === null ? null : flat(fromBuilt),
  transpiledBytes: transpiled.length,
}
console.log(JSON.stringify(result, null, 2))
"""


def main() -> int:
    script = REPO_ROOT / "qualification" / "results" / "V1-identity" / "_tmp_transpile_compare.cjs"
    script.write_text(JS_COMPARE, encoding="utf-8")
    try:
        proc = subprocess.run(
            ["node", str(script), str(PKG / "src" / "store.ts"),
             str(PKG / "lib" / "types" / "store.js"), FUNCTION],
            capture_output=True, text=True, timeout=180,
            env={**__import__("os").environ, "NODE_PATH": TSC_DIR},
        )
    finally:
        script.unlink(missing_ok=True)

    print("=== does TypeScript's own type-erasure make the two copies identical? ===")
    print(f"command: node <tmp> {PKG / 'src' / 'store.ts'} {PKG / 'lib' / 'types' / 'store.js'} {FUNCTION}")
    print()
    if proc.returncode != 0:
        print("the transpile comparison did not run:")
        print(proc.stdout)
        print(proc.stderr)
        return 2
    print(proc.stdout)
    try:
        data = json.loads(proc.stdout)
    except ValueError:
        return 2
    if data.get("identicalAfterTranspile") is True:
        print("VERDICT: the deep-imported copy and the built copy are the SAME REVISION.")
        print("         The duplicate module instance therefore splits module state and")
        print("         duplicates work; it does not produce divergent behaviour.")
    else:
        print("VERDICT: the copies DIFFER after type erasure. Residual shown above; this")
        print("         is the stronger finding and must not be reported as benign.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
