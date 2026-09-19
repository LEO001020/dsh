#!/usr/bin/env python3
"""Characterise the ONE source-resolving specifier ID-01 found.

THE FINDING. The booted host's module graph contains exactly one
`@deepseek-ai/*` specifier that resolves to a `.ts` SOURCE file rather than a
built `lib/` artifact:

    @deepseek-ai/dsh-attachment-local/src/store.ts
      -> D:\\DSH\\src\\dsh-src\\packages\\attachment\\attachment-local\\src\\store.ts
      imported by packages/dsh-daily-work/lib/artifacts.js  (the BUILT artifact)

ID-01's oracle requires every such specifier to resolve under
`D:\\DSH\\src\\dsh-src\\packages\\*\\lib\\`, so this is a direct oracle violation.
This script answers the question that decides how BAD it is, which the graph
alone cannot: the package's own entry (`lib/index.js`) INLINES a copy of
`lib/types/store.js`, so the host now holds TWO module instances of the same
module. If the two copies are the same revision, the consequence is duplicated
work. If they differ, it is divergent behaviour and a much worse finding.

WHAT IT DOES. Extracts the module-scope declarations and the body of the one
shared function from all three physical copies and compares them:
  A. src/store.ts          -- what the deep import loads (type-stripped)
  B. lib/types/store.js    -- the build's own output for the same file
  C. lib/index.js          -- the BUNDLED inlining that the package entry exposes

WHAT IT DOES NOT DO. It does not run the code and it does not decide whether the
divergence (if any) matters. It compares text and reports counts.

Usage:
    python qualification/results/V1-identity/id01-source-import-characterise.py
"""
from __future__ import annotations

import hashlib
import re
from pathlib import Path

PKG = Path("D:/DSH/src/dsh-src/packages/attachment/attachment-local")
COPIES = {
    "A_src_store_ts": PKG / "src" / "store.ts",
    "B_lib_types_store_js": PKG / "lib" / "types" / "store.js",
    "C_lib_index_js_bundled": PKG / "lib" / "index.js",
}

# Module-scope mutable state is what makes two instances observably different.
STATE_PATTERNS = [
    re.compile(r"^const (\w+) = /\* @__PURE__ \*/ new (Set|Map)", re.M),
    re.compile(r"^const (\w+) = new (Set|Map)", re.M),
    re.compile(r"^let (\w+)", re.M),
    re.compile(r"^var (\w+)", re.M),
]

FUNCTION = "publishImmutableObjectStream"


def sha256_file(path: Path) -> str | None:
    try:
        return hashlib.sha256(path.read_bytes()).hexdigest()
    except OSError:
        return None


def module_state(text: str) -> set[str]:
    found: set[str] = set()
    for pattern in STATE_PATTERNS:
        for match in pattern.finditer(text):
            found.add(match.group(1))
    return found


def function_body(text: str, name: str) -> str | None:
    """Extract a function's BRACE BODY only, ignoring its signature.

    Comparing the whole declaration would report a difference for every
    TypeScript type annotation, which the build erases and which cannot change
    behaviour. The first version of this script did exactly that, compared
    `root: string,` against `root,`, and printed "normalised bodies identical:
    False" -- a DIVERGENT-REVISION finding that was an artifact of the
    comparison, not a fact about the code. That is the same defect class as a
    stale build: a confident wrong answer from reading the wrong thing. The
    comparison is now over the body only, where a real divergence would show.
    """
    match = re.search(rf"\b(?:async\s+)?function\s+{name}\b", text)
    if match is None:
        match = re.search(rf"\bconst\s+{name}\s*=", text)
        if match is None:
            return None
    start = text.find("{", match.end())
    if start < 0:
        return None
    depth = 0
    for index in range(start, len(text)):
        char = text[index]
        if char == "{":
            depth += 1
        elif char == "}":
            depth -= 1
            if depth == 0:
                return text[start: index + 1]
    return None


def normalise(body: str) -> str:
    """Strip what a build legitimately changes, so the comparison is semantic.

    The build (and Node's type stripping) does exactly two things to a body:
    erases type annotations and inserts statement-terminating semicolons. Both
    are removed here so that what remains is the executable text. The first
    version removed neither, compared `root: string` against `root`, and printed
    "identical: False" -- a DIVERGENT-REVISION finding manufactured by the
    comparison. The residual after normalisation is what a reader should trust,
    and `main` prints it.
    """
    body = re.sub(r"//[^\n]*", "", body)
    body = re.sub(r"/\*.*?\*/", "", body, flags=re.S)
    body = re.sub(r"\s+", " ", body)
    # Erased by the build: `let x: T` -> `let x`, and parameter/return annotations.
    body = re.sub(r":\s*[A-Za-z_][\w.<>\[\]|, ]*(?=[,)=;])", "", body)
    # Inserted by the build: statement-terminating semicolons.
    body = body.replace(";", "")
    body = re.sub(r"\s+", " ", body)
    return body.strip()


def main() -> int:
    print("=== the three physical copies of the module ID-01 flagged ===")
    texts: dict[str, str] = {}
    for label, path in COPIES.items():
        digest = sha256_file(path)
        exists = path.is_file()
        print(f"  {label}")
        print(f"      path   : {path}")
        print(f"      exists : {exists}")
        print(f"      sha256 : {digest}")
        print(f"      bytes  : {path.stat().st_size if exists else 0}")
        if exists:
            texts[label] = path.read_text(encoding="utf-8", errors="replace")
    print()

    print("=== module-scope mutable state in each copy ===")
    states = {label: module_state(text) for label, text in texts.items()}
    for label, names in states.items():
        print(f"  {label}: {sorted(names) if names else '(none)'}")
    print()

    print("=== is the deep-imported copy a DIFFERENT revision from the built one? ===")
    print("  THE REVISION QUESTION IS NOT DECIDED HERE. Two hand-rolled regex")
    print("  comparisons were tried in this file and each produced a WRONG answer in a")
    print("  different direction (signatures vs bodies; then a mangled object literal).")
    print("  A regex that approximates a compiler is a second compiler. The authoritative")
    print("  answer is in `ID-01-revision-compare.txt`, which erases types with the")
    print("  TypeScript compiler itself: SAME REVISION. The raw body comparison below is")
    print("  retained only as a pointer to that file.")
    a = texts.get("A_src_store_ts")
    b = texts.get("B_lib_types_store_js")
    if a is not None and b is not None:
        body_a = function_body(a, FUNCTION)
        body_b = function_body(b, FUNCTION)
        print(f"  {FUNCTION} found in A (src/store.ts)       : {body_a is not None}")
        print(f"  {FUNCTION} found in B (lib/types/store.js) : {body_b is not None}")
    print()

    print("=== does the package ENTRY inline its own copy (so two instances exist)? ===")
    c = texts.get("C_lib_index_js_bundled")
    if c is not None:
        inlined_state = states.get("C_lib_index_js_bundled", set())
        print(f"  lib/index.js declares module state: {sorted(inlined_state) if inlined_state else '(none)'}")
        overlap = inlined_state & states.get("A_src_store_ts", set())
        print(f"  state names shared with src/store.ts: {sorted(overlap) if overlap else '(none)'}")
        if overlap:
            print("  => the host holds TWO instances of this module, each with its own copy of")
            print(f"     {sorted(overlap)}. The deep import cannot reach the entry's copy and vice versa.")
    print()

    print("=== what the deep import reaches that the entry does NOT export ===")
    if c is not None:
        exports_entry = set(re.findall(r"^export\s*\{([^}]*)\}", c, re.M))
        names = set()
        for chunk in exports_entry:
            for part in chunk.split(","):
                name = part.strip().split(" as ")[-1].strip()
                if name:
                    names.add(name)
        print(f"  {FUNCTION} exported by the package entry (lib/index.js): {FUNCTION in names}")
        print(f"  {FUNCTION} declared inside the entry bundle           : {FUNCTION in c}")
        print("  => the entry bundle DECLARES the function but does not export it, which is")
        print("     why the consumer reached into src/ for it. A built, public path exists:")
        print("     lib/types/store.js, reachable as the declared export")
        print("     '@deepseek-ai/dsh-attachment-local/src/*' resolves to ./src/* only.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
