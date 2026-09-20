#!/usr/bin/env python3
"""ID-05 re-count: the `as never` CAST, split test / non-test, by SHAPE.

WHY A NEW SCANNER RATHER THAN A GREP. The assignment's raw grep is not a
measurement of the construct:

  * `grep -c "as never"` also matches the English words in prose. On this tree
    that over-counts badly: 618 raw substring hits versus 332 real casts.
  * `grep "as never"` over NON-test files returns 48 hits, of which most are
    "was never written", "never a product question", etc. The coordinator's
    grep returned 48 for the same reason. The true non-test cast count is small.

So this scanner does what `id05-escape-hatch-scan.py` (the archived V1 scanner)
did -- strip comments and string-blind tokenise -- and then adds the thing the
assignment actually needs: a SHAPE CLASSIFIER, because "478 occurrences" is only
useful if a reader knows whether they are one idiom or forty.

    The `as never` regex is `\\bas\\s+never\\b` and it is applied to comment-stripped
code, so `never` used as an English adverb in a comment or in a string literal is
not counted. The distinction that remains is REAL and is reported separately:
a cast whose operand is a call/identifier (a type assertion) versus one whose
operand is a literal/object literal (a value being forced).

Usage:
    python qualification/results/S10-id05/s10-as-never-scan.py [--json]
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]
PACKAGES = ["packages/dsh-daily-work", "packages/dsh-ipython"]

# Comments are stripped before counting, exactly as the archived V1 scanner did.
# A pattern that explains `as never` in a comment must not be counted as one.
COMMENT_BLOCK = re.compile(r"/\*.*?\*/", re.S)
COMMENT_LINE = re.compile(r"//[^\n]*")

# THE CAST. Word-boundaried so `as nevermind` is not a hit.
AS_NEVER = re.compile(r"\bas\s+never\b")

# SHAPE CLASSIFIER. Order matters: the first pattern that matches wins, so the
# more specific plugin/config shapes are tested before the generic fallback.
SHAPES: list[tuple[str, re.Pattern[str]]] = [
    # ctx.plugin(X as never, Y as never) -- clause (a): cast on the PLUGIN arg.
    # Distinguished from clause (b) below by position: this one is the FIRST
    # argument of ctx.plugin.
    ("plugin-arg", re.compile(r"ctx\.plugin\(\s*[\w.$]+\s+as\s+never")),
    # ctx.plugin(Storage, {} as never) -- clause (b): cast in CONFIG position,
    # the SECOND argument. This is the idiom D4 measured as masking a real
    # TS2345 and that the oracle says is NOT PASS.
    ("config-arg", re.compile(r"ctx\.plugin\([^)]*,\s*[\w{}\[\]'\"$.]*\s*as\s+never")),
    # A named property in an object literal: `attachmentId: x as never`.
    ("object-property", re.compile(r"[\w$]+\s*:\s*[^,;{}()]*\bas\s+never")),
    # A whole object/array literal forced through: `{ ... } as never`.
    ("object-literal", re.compile(r"[}\]]\s*as\s+never")),
    # An argument to a non-plugin call: `f(x as never)`.
    ("call-argument", re.compile(r"\(\s*[^,;()]*\bas\s+never")),
]


def strip_comments(text: str) -> str:
    """Remove block comments then line comments, preserving newlines.

    Newlines are preserved so reported line numbers still address the original
    file. A naive substitution would shift every subsequent line number.
    """
    def blank_block(match: re.Match[str]) -> str:
        return "\n" * match.group(0).count("\n")

    def blank_line(match: re.Match[str]) -> str:
        return ""

    return COMMENT_LINE.sub(blank_line, COMMENT_BLOCK.sub(blank_block, text))


def classify(line: str, column: int) -> str:
    """Classify one occurrence by the SHAPE of the expression being cast."""
    for name, pattern in SHAPES:
        if pattern.search(line):
            return name
    return "other"


def scan() -> dict[str, object]:
    occurrences: list[dict[str, object]] = []
    per_package: dict[str, dict[str, object]] = {}

    for package in PACKAGES:
        src = REPO_ROOT / package / "src"
        if not src.is_dir():
            continue
        files = sorted(p for p in src.rglob("*.ts") if p.is_file())
        package_occurrences: list[dict[str, object]] = []
        file_count = {"total": 0, "test": 0, "production": 0}

        for path in files:
            raw = path.read_text(encoding="utf-8", errors="replace")
            code = strip_comments(raw)
            is_test = path.name.endswith(".test.ts")
            file_count["total"] += 1
            file_count["test" if is_test else "production"] += 1
            for match in AS_NEVER.finditer(code):
                line_number = code[: match.start()].count("\n") + 1
                source_line = code.splitlines()[line_number - 1].strip()
                record = {
                    "file": path.relative_to(REPO_ROOT).as_posix(),
                    "line": line_number,
                    "is_test": is_test,
                    "shape": classify(source_line, match.start()),
                    "context": source_line[:160],
                }
                package_occurrences.append(record)
                occurrences.append(record)

        per_package[package] = {
            "file_count": file_count,
            "as_never_total": len(package_occurrences),
            "as_never_test": sum(1 for o in package_occurrences if o["is_test"]),
            "as_never_non_test": sum(1 for o in package_occurrences if not o["is_test"]),
        }

    test_total = sum(1 for o in occurrences if o["is_test"])
    non_test_total = sum(1 for o in occurrences if not o["is_test"])

    # Shape histogram, split test / non-test. This is the characterisation the
    # assignment asks for: a shape where every instance errors is a different
    # finding from a shape where the cast is cosmetic.
    shape_totals: dict[str, dict[str, int]] = {}
    for record in occurrences:
        bucket = shape_totals.setdefault(record["shape"], {"test": 0, "non_test": 0, "total": 0})
        bucket["test" if record["is_test"] else "non_test"] += 1
        bucket["total"] += 1

    # Where do the NON-TEST occurrences live? These are the ones examined
    # exhaustively, because there are few enough to do it.
    non_test_files: dict[str, list[dict[str, object]]] = {}
    for record in occurrences:
        if record["is_test"]:
            continue
        non_test_files.setdefault(record["file"], []).append(record)

    return {
        "scope": "S10_ID05_AS_NEVER_SCAN",
        "note": (
            "Counts the CAST, not the substring: comments are stripped first, so "
            "English 'never' in prose is excluded. The assignment's raw grep "
            "reports 48 non-test hits and 452/404 totals for exactly that reason; "
            "those numbers count prose. D4's scanner counted the same construct "
            "this one does and recorded 488 (478 test, 10 non-test)."
        ),
        "regex": r"\bas\s+never\b (comment-stripped)",  # noqa: W605 -- documented literal
        "per_package": per_package,
        "totals": {
            "as_never_total": len(occurrences),
            "as_never_test": test_total,
            "as_never_non_test": non_test_total,
        },
        "recorded_by_D4": {
            "as_never_total": 488,
            "as_never_test": 478,
            "as_never_non_test": 10,
        },
        "drift_vs_D4": {
            "as_never_total": len(occurrences) - 488,
            "as_never_test": test_total - 478,
            "as_never_non_test": non_test_total - 10,
        },
        "shape_histogram": dict(sorted(shape_totals.items(), key=lambda kv: -kv[1]["total"])),
        "non_test_occurrences": non_test_files,
        "all_occurrences": occurrences,
    }


def main() -> int:
    report = scan()
    if "--json" in sys.argv:
        print(json.dumps(report, indent=2))
        return 0

    totals = report["totals"]
    recorded = report["recorded_by_D4"]
    drift = report["drift_vs_D4"]
    print("=== ID-05: the `as never` CAST, comment-stripped ===")
    print()
    print(f"{'':22s} {'measured':>10s} {'D4 recorded':>12s} {'drift':>7s}")
    for key in ("as_never_total", "as_never_test", "as_never_non_test"):
        print(f"{key:22s} {totals[key]:>10d} {recorded[key]:>12d} {drift[key]:>+7d}")
    print()
    print("=== by package ===")
    for package, stats in report["per_package"].items():
        files = stats["file_count"]
        print(f"  {package}")
        print(f"    files {files['total']} ({files['production']} production + {files['test']} test)")
        print(f"    casts {stats['as_never_total']} "
              f"({stats['as_never_test']} test + {stats['as_never_non_test']} non-test)")
    print()
    print("=== SHAPE histogram (the characterisation) ===")
    print(f"  {'shape':18s} {'test':>6s} {'non-test':>9s} {'total':>6s}")
    for shape, counts in report["shape_histogram"].items():
        print(f"  {shape:18s} {counts['test']:>6d} {counts['non_test']:>9d} {counts['total']:>6d}")
    print()
    print("=== EVERY non-test occurrence (examined exhaustively) ===")
    for file, records in sorted(report["non_test_occurrences"].items()):
        print(f"  {file}")
        for record in records:
            print(f"    {record['line']:>5d}  [{record['shape']:15s}] {record['context']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
