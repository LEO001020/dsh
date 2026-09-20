#!/usr/bin/env python3
"""ID-05: characterise the TEST occurrences by SHAPE.

WHY THIS IS A CHARACTERISATION AND NOT A SWEEP. There are 509 test-file casts
across 64 test files. Removing them one at a time and compiling each time is ~509
compiles of a 92-file program, which is hours of the shared CPU this wave is
explicitly told not to consume. So this script does NOT sweep. It:

  1. groups every test cast by the SHAPE of the expression cast (the same
     classifier the scanner uses);
  2. picks the N most frequent shapes;
  3. for ONE REPRESENTATIVE site per shape, removes the cast and compiles, and
     reports what happened.

WHAT THIS ESTABLISHES AND WHAT IT DOES NOT. It establishes, per shape, whether the
cast at that representative site is removable or masking. It does NOT establish
that every instance of the shape behaves the same way, because the operand types
differ from site to site -- a `ctx.plugin(x as never, cfg as never)` whose plugin
has a `Config` schema behaves differently from one whose plugin has none. The
report says so in `what_this_does_not_establish`.

Usage:
    python qualification/results/S10-id05/s10-test-shape-probe.py [--per-shape N]
"""
from __future__ import annotations

import hashlib
import json
import re
import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]
TSC = Path("D:/DSH/src/dsh-src/node_modules/typescript/bin/tsc")
AS_NEVER = re.compile(r"\bas\s+never\b")
COMMENT_BLOCK = re.compile(r"/\*.*?\*/", re.S)
COMMENT_LINE = re.compile(r"//[^\n]*")

# The SAME classifier the scanner uses, so the histogram and the probe agree on
# what a "shape" is. Order matters: most specific first.
SHAPES: list[tuple[str, re.Pattern[str]]] = [
    ("plugin-arg", re.compile(r"ctx\.plugin\(\s*[\w.$]+\s+as\s+never")),
    ("config-arg", re.compile(r"ctx\.plugin\([^)]*,\s*[\w{}\[\]'\"$.]*\s*as\s+never")),
    ("object-property", re.compile(r"[\w$]+\s*:\s*[^,;{}()]*\bas\s+never")),
    ("object-literal", re.compile(r"[}\]]\s*as\s+never")),
    ("call-argument", re.compile(r"\(\s*[^,;()]*\bas\s+never")),
]


def comment_mask(text: str) -> list[bool]:
    mask = [False] * len(text)
    for pattern in (COMMENT_BLOCK, COMMENT_LINE):
        for match in pattern.finditer(text):
            for index in range(match.start(), match.end()):
                mask[index] = True
    return mask


def classify(line: str) -> str:
    for name, pattern in SHAPES:
        if pattern.search(line):
            return name
    return "other"


def collect() -> list[dict[str, object]]:
    rows: list[dict[str, object]] = []
    for package in ("packages/dsh-daily-work", "packages/dsh-ipython"):
        src = REPO_ROOT / package / "src"
        for path in sorted(p for p in src.rglob("*.test.ts") if p.is_file()):
            text = path.read_text(encoding="utf-8", errors="replace")
            mask = comment_mask(text)
            for match in AS_NEVER.finditer(text):
                if mask[match.start()]:
                    continue
                line_number = text[: match.start()].count("\n") + 1
                line = text.splitlines()[line_number - 1]
                rows.append({
                    "path": path,
                    "offset": match.start(),
                    "line": line_number,
                    "shape": classify(line.strip()),
                    "text": line.strip()[:170],
                })
    return rows


def compile_package(pkg_dir: Path) -> dict[str, object]:
    proc = subprocess.run(
        ["node", str(TSC), "-p", "tsconfig.check.json"],
        cwd=str(pkg_dir), capture_output=True, text=True,
        encoding="utf-8", errors="replace",
    )
    return {"exit_code": proc.returncode, "output": f"{proc.stdout}{proc.stderr}".strip()}


def parse_diagnostics(output: str) -> list[dict[str, object]]:
    rows = []
    for line in output.splitlines():
        match = re.match(r"^(.+?)\((\d+),(\d+)\): error (TS\d+): (.*)$", line.strip())
        if match:
            rows.append({
                "file": match.group(1), "line": int(match.group(2)),
                "column": int(match.group(3)), "code": match.group(4),
                "message": match.group(5),
            })
    return rows


def main() -> int:
    per_shape = 1
    if "--per-shape" in sys.argv:
        per_shape = int(sys.argv[sys.argv.index("--per-shape") + 1])

    rows = collect()
    histogram: dict[str, int] = {}
    for row in rows:
        histogram[row["shape"]] = histogram.get(row["shape"], 0) + 1

    print(f"test-file `as never` casts: {len(rows)}")
    print()
    print("SHAPE histogram (all of them; the probe covers the top shapes):")
    for shape, count in sorted(histogram.items(), key=lambda kv: -kv[1]):
        print(f"  {shape:18s} {count:>5d}")
    print()

    # Probe the most frequent shapes first. `other` is included so the residual is
    # not silently unexamined.
    order = [name for name, _ in sorted(histogram.items(), key=lambda kv: -kv[1])]

    results = []
    for shape in order:
        candidates = [r for r in rows if r["shape"] == shape]
        for row in candidates[:per_shape]:
            path: Path = row["path"]  # type: ignore[assignment]
            original = path.read_bytes()
            before = hashlib.sha256(original).hexdigest()
            code = original.decode("utf-8", errors="replace")
            start = int(row["offset"])  # type: ignore[arg-type]
            end = start + len("as never")
            while start > 0 and code[start - 1] in " \t":
                start -= 1
            mutated = code[:start] + code[end:]

            pkg_dir = REPO_ROOT / "packages" / path.relative_to(REPO_ROOT / "packages").parts[0]
            try:
                path.write_bytes(mutated.encode("utf-8"))
                compiled = compile_package(pkg_dir)
            finally:
                path.write_bytes(original)
            after = hashlib.sha256(path.read_bytes()).hexdigest()

            diagnostics = parse_diagnostics(compiled["output"])
            local = [d for d in diagnostics if abs(d["line"] - int(row["line"])) <= 3]  # type: ignore[arg-type]
            results.append({
                "shape": shape,
                "file": path.relative_to(REPO_ROOT).as_posix(),
                "line": row["line"],
                "text": row["text"],
                "restore_byte_exact": after == before,
                "exit_code": compiled["exit_code"],
                "diagnostic_count": len(diagnostics),
                "local_diagnostics": local,
                "verdict": "MASK" if compiled["exit_code"] != 0 else "REMOVABLE",
            })
            print(f"[{shape}] {path.name}:{row['line']} exit {compiled['exit_code']} "
                  f"({len(diagnostics)} diag) restore_exact={after == before}", flush=True)

    report = {
        "scope": "S10_ID05_TEST_SHAPE_PROBE",
        "test_cast_count": len(rows),
        "shape_histogram": dict(sorted(histogram.items(), key=lambda kv: -kv[1])),
        "probes": results,
        "what_this_establishes": (
            "Per SHAPE, whether removing the cast at ONE representative site is "
            "accepted by the checker."
        ),
        "what_this_does_not_establish": (
            f"Only {len(results)} of {len(rows)} test casts were actually mutated and "
            "compiled. The remaining ones are CHARACTERISED by shape, not examined. "
            "Instances of one shape are not guaranteed to behave alike: a "
            "`ctx.plugin(x as never, cfg as never)` whose plugin declares a `Config` "
            "schema differs from one whose plugin declares none, and the operand types "
            "differ site to site. No claim is made that the count could be driven to "
            "zero without per-site review."
        ),
    }
    out = REPO_ROOT / "qualification" / "results" / "S10-id05" / "12-test-shape-probe.json"
    out.write_text(json.dumps(report, indent=2, default=str), encoding="utf-8")
    print()
    print(f"wrote {out.relative_to(REPO_ROOT).as_posix()}")
    print()
    print("=== per-shape result ===")
    for result in results:
        print(f"  [{result['shape']:15s}] {result['verdict']:9s} {result['file']}:{result['line']}")
        for d in result["local_diagnostics"]:
            print(f"      -> {d['code']} ({d['line']},{d['column']}): {d['message'][:130]}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
