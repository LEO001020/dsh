#!/usr/bin/env python3
"""Record the exact source tree the type-check ran against.

WHY THIS EXISTS. `tsconfig.check.json` is an oracle over the SOURCE tree, and nine
agents share this working tree. A compile result is only a statement about the
bytes that were on disk when it ran, so this script pins them: it hashes every
`src/**/*.ts` file in a package and prints a single tree digest plus a per-file
listing. Run it immediately before and immediately after the compile; if the two
digests differ, the tree moved under the measurement and the result must be
re-taken rather than reported.

WHAT IT DOES NOT DO. It does not run tsc and it does not decide the case. It is a
fence around the measurement, not the measurement.

Usage:
    python qualification/results/V1-identity/src-tree-digest.py <package-dir> [...]
"""
from __future__ import annotations

import hashlib
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]


def tree_digest(package: str) -> tuple[str, list[tuple[str, str, int]]]:
    src = REPO_ROOT / package / "src"
    files = sorted(p for p in src.rglob("*.ts") if p.is_file())
    rows: list[tuple[str, str, int]] = []
    overall = hashlib.sha256()
    for path in files:
        rel = path.relative_to(REPO_ROOT / package).as_posix()
        data = path.read_bytes()
        digest = hashlib.sha256(data).hexdigest()
        rows.append((rel, digest, len(data)))
        overall.update(rel.encode("utf-8"))
        overall.update(data)
    return overall.hexdigest(), rows


def main() -> int:
    packages = sys.argv[1:] or ["packages/dsh-daily-work", "packages/dsh-ipython"]
    for package in packages:
        digest, rows = tree_digest(package)
        print(f"package {package}")
        print(f"  files: {len(rows)}")
        print(f"  src tree digest: {digest}")
        for rel, file_digest, size in rows:
            print(f"    {file_digest}  {size:>7}  {rel}")
        print()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
