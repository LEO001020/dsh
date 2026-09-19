#!/usr/bin/env python3
"""Read the ID-01 graph artifact back and report the two questions the oracle asks.

Kept as a separate reader so the classification can be inspected without
re-running a boot. It prints, rather than judges: the verdict lives in
`verdict.json` and this file only makes its rows readable.

Usage:
    python qualification/results/V1-identity/id01-graph-report.py
"""
from __future__ import annotations

import json
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]
RUN = REPO_ROOT / "qualification" / "results" / "V1-identity" / "runs" / "id01"
BACKSLASH = chr(92)


def main() -> int:
    verdict = json.loads((RUN / "verdict.json").read_text(encoding="utf-8"))
    resolutions = verdict["graph"]["resolutions"]

    print("=== ID-01 module graph, read back from the booted host ===")
    print(f"resolution lines      : {verdict['graph']['lineCount']}")
    print(f"distinct specifiers   : {verdict['graph']['distinctSpecifiers']}")
    print(f"from BUILT (lib/*.js) : {verdict['graph']['fromBuilt']}")
    print(f"from SOURCE (.ts)     : {verdict['graph']['fromSource']}")
    print(f"under packages{BAK}*{BAK}lib{BAK}  : {verdict['graph']['underPackagesLib']}".replace(BAK, BACKSLASH))
    print(f"under vendor{BAK}*{BAK}lib{BAK}    : {verdict['graph']['underVendorLib']}".replace(BAK, BACKSLASH))
    print()

    print("=== the specifiers that resolved to a SOURCE file ===")
    source_rows = [r for r in resolutions if r["kind"] == "SOURCE"]
    if not source_rows:
        print("  (none)")
    for row in source_rows:
        print(f"  {row['specifier']}")
        print(f"      -> {row['path']}")
        print(f"      occurrences: {row['occurrences']}")
    print()

    print("=== every resolution under the checkout's vendor/ tree ===")
    vendor_rows = [r for r in resolutions if f"{BACKSLASH}vendor{BACKSLASH}" in r["path"]]
    for row in vendor_rows:
        print(f"  {row['specifier']} -> {row['path']}")
    print()

    print("=== the parents of the SOURCE resolutions, from the raw jsonl ===")
    for line in (RUN / "graph.jsonl").read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        row = json.loads(line)
        url = str(row.get("url", ""))
        if url.endswith(".ts"):
            print(f"  specifier  = {row['specifier']}")
            print(f"  parentURL  = {row.get('parentURL')}")
            print(f"  atMs       = {row.get('atMs')}")
    print()

    print("=== the specifiers NOT under packages/ or vendor/ ===")
    others = [
        r for r in resolutions
        if f"{BACKSLASH}packages{BACKSLASH}" not in r["path"]
        and f"{BACKSLASH}vendor{BACKSLASH}" not in r["path"]
    ]
    if not others:
        print("  (none)")
    for row in others:
        print(f"  {row['specifier']} -> {row['path']} ({row['kind']})")
    return 0


BAK = "~"
if __name__ == "__main__":
    raise SystemExit(main())
