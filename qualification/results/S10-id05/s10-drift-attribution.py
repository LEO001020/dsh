#!/usr/bin/env python3
"""ID-05 drift attribution: count the `as never` CAST at two revisions, with the
SAME scanner, so a count difference is attributable to the TREE rather than to
the tool.

WHY THIS EXISTS. The assignment records 488 total (478 test, 10 non-test) from
decision D4. A fresh scan of the current tree says 520 (509, 11). Two competing
explanations fit that gap and they mean opposite things:

  1. different scanners -- one of the two counted prose or missed a syntax;
  2. the tree moved -- writers added casts after D4 measured.

(1) is a measurement defect in this slice. (2) is normal drift. This script
settles it by running ONE scanner (the same `as_never` regex and the same
comment-stripping as the archived V1 scanner) over the blobs at a named
revision. If the old revision also reports 520, the scanner is the difference.
If it reports 488, the tree is.

Usage:
    python qualification/results/S10-id05/s10-drift-attribution.py <rev> [<rev> ...]
"""
from __future__ import annotations

import re
import subprocess
import sys
from collections import Counter

REPO_ROOT = __file__.replace("\\", "/").rsplit("/qualification/", 1)[0]

COMMENT_BLOCK = re.compile(r"/\*.*?\*/", re.S)
COMMENT_LINE = re.compile(r"//[^\n]*")
# Deliberately the ARCHIVED V1 SCANNER's pattern, not a stricter one: the point
# is to reproduce D4's number, so the pattern must be D4's.
AS_NEVER = re.compile(r"\bas\s+never\b")


def strip_comments(text: str) -> str:
    return COMMENT_LINE.sub("", COMMENT_BLOCK.sub("", text))


def files_at(rev: str) -> list[str]:
    out = subprocess.run(
        ["git", "ls-tree", "-r", "--name-only", rev],
        cwd=REPO_ROOT, capture_output=True, text=True, encoding="utf-8",
    ).stdout
    return [
        line for line in out.splitlines()
        if line.startswith("packages/") and "/src/" in line and line.endswith(".ts")
    ]


def blob_at(rev: str, path: str) -> str:
    proc = subprocess.run(
        ["git", "show", f"{rev}:{path}"],
        cwd=REPO_ROOT, capture_output=True, encoding="utf-8", errors="replace",
    )
    return proc.stdout


def count(rev: str) -> dict[str, object]:
    test = 0
    non_test = 0
    per_file: dict[str, int] = {}
    for path in files_at(rev):
        code = strip_comments(blob_at(rev, path))
        hits = len(AS_NEVER.findall(code))
        if not hits:
            continue
        per_file[path] = hits
        if path.endswith(".test.ts"):
            test += hits
        else:
            non_test += hits
    return {
        "rev": rev,
        "total": test + non_test,
        "test": test,
        "non_test": non_test,
        "file_count": len(per_file),
        "non_test_files": {k: v for k, v in per_file.items() if not k.endswith(".test.ts")},
    }


def main() -> int:
    revs = sys.argv[1:] or ["HEAD"]
    print(f"scanner: the archived V1 scanner's pattern {AS_NEVER.pattern!r}, comment-stripped")
    print()
    print(f"{'rev':12s} {'total':>7s} {'test':>7s} {'non-test':>9s} {'files':>6s}")
    results = []
    for rev in revs:
        result = count(rev)
        results.append(result)
        label = subprocess.run(
            ["git", "log", "-1", "--format=%h %s", rev],
            cwd=REPO_ROOT, capture_output=True, text=True, encoding="utf-8",
        ).stdout.strip()[:70]
        print(f"{rev[:10]:12s} {result['total']:>7d} {result['test']:>7d} "
              f"{result['non_test']:>9d} {result['file_count']:>6d}   {label}")
    print()
    print("recorded by D4 (in docs/decisions/V3-v2-oracle-resolutions.md):")
    print(f"{'D4 recorded':12s} {488:>7d} {478:>7d} {10:>9d}")
    print()
    for result in results:
        print(f"non-test files at {result['rev'][:10]}:")
        for path, n in sorted(result["non_test_files"].items()):
            print(f"  {n:>3d}  {path}")
        print()
    return 0


if __name__ == "__main__":
    sys.exit(main())
