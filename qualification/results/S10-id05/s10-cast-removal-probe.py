#!/usr/bin/env python3
"""ID-05: the real work. Remove ONE `as never` cast at a time and report the
diagnostic that appears -- or that none does.

WHY ONE AT A TIME AND NOT ALL AT ONCE. Removing every cast in a file at once
produces a diagnostic list whose entries cannot be attributed: tsc reports errors
in source order, and a single removed cast can cascade (an inferred type changes,
and three later expressions become errors). This harness therefore removes exactly
ONE occurrence per compile and records the diagnostics whose line numbers are the
mutated line or the few lines after it, flagging anything further away as a
possible cascade rather than silently attributing it.

THE CLASSIFICATION IS THE POINT, and it is not mechanical:

  * MASK -- removing the cast reveals a diagnostic. The cast was suppressing a
    real type error. This is what ID-05's clause (b) names.
  * LEGITIMATE -- removing the cast reveals NO diagnostic. Either the cast is
    redundant (the expression already had that type) or it is a deliberate
    narrowing that the checker accepts.

  A `LEGITIMATE` verdict is NOT the same as "the cast is fine". A redundant cast
  is still removable, and the assignment's rule is that a cast may not be used to
  make a gate pass. So a redundant cast is reported as REMOVABLE.

Usage:
    python qualification/results/S10-id05/s10-cast-removal-probe.py <package>
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


def strip_comments(text: str) -> str:
    return COMMENT_LINE.sub("", COMMENT_BLOCK.sub("", text))


def comment_mask(text: str) -> list[bool]:
    """Mark every character that lies inside a comment.

    WHY A MASK AND NOT A STRIPPED COPY. The first version of this harness located
    an occurrence by line number in the comment-stripped text and then mutated the
    RAW text by the same line number. That is wrong in two ways that both bit:
    stripping preserves newlines but not character offsets, and a single line can
    carry TWO casts (`ctx.plugin(a as never, { b } as never)`) so "the match on
    this line" is ambiguous. A mask keeps the raw offsets exact and lets the
    caller ask "is THIS raw match inside a comment?" directly.
    """
    mask = [False] * len(text)
    for pattern in (COMMENT_BLOCK, COMMENT_LINE):
        for match in pattern.finditer(text):
            for index in range(match.start(), match.end()):
                mask[index] = True
    return mask


def cast_offsets(text: str) -> list[int]:
    """Byte offsets of every `as never` CAST -- comments excluded."""
    mask = comment_mask(text)
    return [m.start() for m in AS_NEVER.finditer(text) if not mask[m.start()]]


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
                "file": match.group(1),
                "line": int(match.group(2)),
                "column": int(match.group(3)),
                "code": match.group(4),
                "message": match.group(5),
            })
    return rows


def main() -> int:
    package = sys.argv[1] if len(sys.argv) > 1 else "dsh-daily-work"
    pkg_dir = REPO_ROOT / "packages" / package
    src = pkg_dir / "src"

    # Find every non-test occurrence, keyed by its exact BYTE offset so the
    # mutation is exact and two casts on one line are still two distinct targets.
    targets: list[dict[str, object]] = []
    for path in sorted(p for p in src.rglob("*.ts") if p.is_file()):
        if path.name.endswith(".test.ts"):
            continue
        text = path.read_text(encoding="utf-8", errors="replace")
        for offset in cast_offsets(text):
            line = text[:offset].count("\n") + 1
            column = offset - (text.rfind("\n", 0, offset) + 1) + 1
            targets.append({
                "path": path,
                "offset": offset,
                "line": line,
                "column": column,
                "text": text.splitlines()[line - 1].strip()[:170],
            })

    print(f"package: {package}")
    print(f"non-test `as never` occurrences: {len(targets)}")
    print()

    baseline = compile_package(pkg_dir)
    print(f"baseline (nothing mutated): exit {baseline['exit_code']}, "
          f"{len(parse_diagnostics(baseline['output']))} diagnostic(s)")
    if baseline["exit_code"] != 0:
        print("BASELINE IS NOT CLEAN -- aborting, a removal probe cannot be read "
              "against a dirty baseline.")
        print(baseline["output"][:2000])
        return 2
    print()

    results = []
    for index, target in enumerate(targets, start=1):
        path: Path = target["path"]  # type: ignore[assignment]
        original = path.read_bytes()
        before_digest = hashlib.sha256(original).hexdigest()
        code = original.decode("utf-8", errors="replace")

        # THE MUTATION, by exact offset: delete "as never" plus the whitespace
        # before it, so the expression stands alone.
        start = int(target["offset"])  # type: ignore[arg-type]
        end = start + len("as never")
        while start > 0 and code[start - 1] in " \t":
            start -= 1
        mutated = code[:start] + code[end:]

        try:
            path.write_bytes(mutated.encode("utf-8"))
            compiled = compile_package(pkg_dir)
        finally:
            path.write_bytes(original)

        after_digest = hashlib.sha256(path.read_bytes()).hexdigest()
        diagnostics = parse_diagnostics(compiled["output"])
        local = [d for d in diagnostics if abs(d["line"] - target["line"]) <= 3]
        distant = [d for d in diagnostics if abs(d["line"] - target["line"]) > 3]

        results.append({
            "file": path.relative_to(REPO_ROOT).as_posix(),
            "line": target["line"],
            "column": target["column"],
            "text": target["text"],
            "restore_byte_exact": after_digest == before_digest,
            "exit_code": compiled["exit_code"],
            "diagnostic_count": len(diagnostics),
            "local_diagnostics": local,
            "distant_diagnostics": distant,
            "verdict": (
                "MASK" if compiled["exit_code"] != 0
                else "REDUNDANT-OR-LEGITIMATE"
            ),
        })
        print(f"[{index}/{len(targets)}] {target['path'].name}:{target['line']} "
              f"exit {compiled['exit_code']} ({len(diagnostics)} diag) "
              f"restore_exact={after_digest == before_digest}", flush=True)

    report = {
        "scope": "S10_ID05_CAST_REMOVAL_PROBE",
        "package": package,
        "baseline": baseline,
        "occurrence_count": len(targets),
        "results": results,
        "masks": [
            {k: r[k] for k in ("file", "line", "text", "exit_code", "local_diagnostics")}
            for r in results if r.get("verdict") == "MASK"
        ],
        "clean_removals": [
            {k: r[k] for k in ("file", "line", "text")}
            for r in results if r.get("verdict") == "REDUNDANT-OR-LEGITIMATE"
        ],
    }
    out = REPO_ROOT / "qualification" / "results" / "S10-id05" / f"08-removal-probe-{package}.json"
    out.write_text(json.dumps(report, indent=2, default=str), encoding="utf-8")
    print()
    print(f"wrote {out.relative_to(REPO_ROOT).as_posix()}")
    print()
    print("=== MASKED (removing the cast reveals a diagnostic) ===")
    for mask in report["masks"]:
        print(f"  {mask['file']}:{mask['line']}")
        print(f"    source: {mask['text']}")
        for d in mask["local_diagnostics"]:
            print(f"    -> {d['code']} ({d['line']},{d['column']}): {d['message']}")
    print()
    print("=== CLEAN REMOVAL (no diagnostic appears) ===")
    for clean in report["clean_removals"]:
        print(f"  {clean['file']}:{clean['line']}  {clean['text']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
