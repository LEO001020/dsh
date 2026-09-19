#!/usr/bin/env python3
"""ID-05 second half: scan for the escape hatches the oracle forbids, and for
deep cross-package imports of private symbols.

WHY A SCANNER AND NOT A COMPILE FLAG. `tsc` has no flag for "no `any`", and
`noExplicitAny` in ESLint is a lint rule this repository does not run over these
packages. The oracle says "No `any` cast, no `as never`, and no non-null `!` is
used to hide a genuinely undefined value". The first two are mechanically
visible. The third is NOT: whether a `!` "hides a genuinely undefined value" is
a judgement about the code, not a token. So this scanner reports the third as a
COUNTED, LOCATED LIST for a reader to judge, and says so rather than emitting a
false green.

WHAT IS MECHANICAL, and therefore decided here:
  * `as any` / `<any>` / `: any` casts and annotations
  * `as never`
  * deep imports that cross a package boundary into another package's `src/`
    (the oracle's "no private symbol is deep-imported across a package boundary")

WHAT IS NOT, and is only listed: non-null assertions (`!`).

Usage:
    python qualification/results/V1-identity/id05-escape-hatch-scan.py
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]
PACKAGES = ["packages/dsh-daily-work", "packages/dsh-ipython"]

# Comments and string literals can contain these tokens, and a scan that counted
# them would over-report. These patterns are applied to CODE with comments
# stripped, so the counts are of real occurrences.
COMMENT_BLOCK = re.compile(r"/\*.*?\*/", re.S)
COMMENT_LINE = re.compile(r"//[^\n]*")

PATTERNS: dict[str, re.Pattern[str]] = {
    "as_any": re.compile(r"\bas\s+any\b"),
    "angle_any": re.compile(r"<\s*any\s*>"),
    "colon_any": re.compile(r":\s*any\b"),
    "as_never": re.compile(r"\bas\s+never\b"),
    "non_null_assertion": re.compile(r"[\w\)\]]!(?=[\s.,;\)\]\}])"),
    "ts_ignore": re.compile(r"@ts-(?:ignore|nocheck|expect-error)"),
}

# A deep import crossing INTO another package's src. `@deepseek-ai/dsh-*/src/*`
# is the checkout's exported deep path and is deliberate in a few tests; the
# oracle is about PRIVATE symbols, so this records the specifier and the file
# rather than judging it.
DEEP_IMPORT = re.compile(r"""from\s+['"](@deepseek-ai/[^'"]+/src/[^'"]+)['"]""")


def strip_comments(text: str) -> str:
    return COMMENT_LINE.sub("", COMMENT_BLOCK.sub("", text))


def main() -> int:
    report: dict[str, object] = {
        "scope": "ID05_ESCAPE_HATCH_SCAN",
        "note": (
            "as_any/as_never/angle_any/colon_any and deep imports are decided here. "
            "non_null_assertion is COUNTED AND LOCATED ONLY: whether a given `!` hides a "
            "genuinely undefined value is a reading, not a token match, so this scanner "
            "does not claim a verdict on it."
        ),
        "packages": {},
    }
    totals: dict[str, int] = {key: 0 for key in PATTERNS}
    deep_imports: list[dict[str, str]] = []
    non_null_rows: list[dict[str, object]] = []

    for package in PACKAGES:
        src = REPO_ROOT / package / "src"
        files = sorted(p for p in src.rglob("*.ts") if p.is_file())
        per_file: dict[str, dict[str, int]] = {}
        for path in files:
            raw = path.read_text(encoding="utf-8", errors="replace")
            code = strip_comments(raw)
            counts: dict[str, int] = {}
            for key, pattern in PATTERNS.items():
                hits = pattern.findall(code)
                if hits:
                    counts[key] = len(hits)
                    totals[key] += len(hits)
                if key == "non_null_assertion" and hits:
                    for match in pattern.finditer(code):
                        line = code[: match.start()].count("\n") + 1
                        non_null_rows.append({
                            "file": path.relative_to(REPO_ROOT).as_posix(),
                            "line": line,
                            "context": code.splitlines()[line - 1].strip()[:120],
                        })
            for match in DEEP_IMPORT.finditer(code):
                deep_imports.append({
                    "file": path.relative_to(REPO_ROOT).as_posix(),
                    "specifier": match.group(1),
                })
            if counts:
                per_file[path.relative_to(REPO_ROOT).as_posix()] = counts
        report["packages"][package] = {"file_count": len(files), "per_file": per_file}

    report["totals"] = totals
    report["deep_cross_package_imports"] = deep_imports
    report["non_null_assertions"] = non_null_rows

    forbidden = {k: totals[k] for k in ("as_any", "angle_any", "colon_any", "as_never", "ts_ignore")}
    report["forbidden_construct_totals"] = forbidden
    report["forbidden_constructs_absent"] = all(v == 0 for v in forbidden.values())

    print(json.dumps(report, indent=2))
    print()
    print("--- summary ---")
    for key, count in sorted(totals.items()):
        print(f"  {key:22s} {count}")
    print(f"  deep cross-package imports: {len(deep_imports)}")
    print()
    print(f"forbidden constructs absent : {report['forbidden_constructs_absent']}")
    print(f"non-null assertions (listed, not judged): {len(non_null_rows)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
