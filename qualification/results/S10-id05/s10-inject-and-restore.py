#!/usr/bin/env python3
"""ID-05 arm 2: inject ONE type error into a TEST file, show the check catches it,
show `tsconfig.json` alone MISSES it, and restore byte-exact.

WHY THE CONTROL ARM IS IN THE SAME SCRIPT AND THE SAME MUTATION WINDOW.
`ID-05`'s oracle says "a green run under `tsconfig.json` alone is NOT PASS, because
that config excludes the test files". That is a claim about a CONTRAST, so the
contrast has to be measured inside one window: if the two compiles were run in two
separate mutation windows, a reader could not tell whether the second one saw the
error at all. Both compiles therefore run while the injected byte is on disk, and
the file is restored in a `finally` block with a sha256 assertion.

THE INJECTED ERROR IS DELIBERATELY A TYPE ERROR, NOT A SYNTAX ERROR. A syntax error
would be caught by `tsconfig.json` too (it parses the file only if the file is in
the program -- which is the point: an excluded file is not even parsed). The claim
under test is that the CHECK config puts the test file INTO THE PROGRAM, and the
sharpest evidence for that is an error that is invisible to the excluding config
and visible to the including one.

Usage:
    python qualification/results/S10-id05/s10-inject-and-restore.py <package>
"""
from __future__ import annotations

import hashlib
import json
import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]
CHECK_CONFIG = "tsconfig.check.json"
BUILD_CONFIG = "tsconfig.json"

# The injected line. A `const` with an explicit `number` annotation assigned a
# string is TS2322 -- a pure type error, no syntax error, no runtime effect (the
# file is never executed here), and vitest is not involved at all.
MARKER = "const __s10InjectedTypeError: number = 's10-injected'"


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def run_tsc(pkg_dir: Path, config: str) -> dict[str, object]:
    # The compiler is resolved the same way helpers/typecheck.mjs resolves it:
    # from the pinned checkout's install, named in ONE place.
    tsc = Path("D:/DSH/src/dsh-src/node_modules/typescript/bin/tsc")
    if not tsc.exists():
        raise SystemExit(f"no tsc at {tsc}")
    proc = subprocess.run(
        ["node", str(tsc), "-p", config],
        cwd=str(pkg_dir),
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    return {
        "config": config,
        "exit_code": proc.returncode,
        "stdout": proc.stdout,
        "stderr": proc.stderr,
    }


def main() -> int:
    package = sys.argv[1] if len(sys.argv) > 1 else "dsh-ipython"
    pkg_dir = REPO_ROOT / "packages" / package
    # A test file that the build config EXCLUDES, so the control arm is a real
    # contrast rather than a second look at the same program.
    candidates = sorted(p for p in (pkg_dir / "src").glob("*.test.ts"))
    if not candidates:
        print(f"no test file in {pkg_dir}", file=sys.stderr)
        return 2
    target = candidates[0]

    before_digest = sha256(target)
    # BYTES, NOT TEXT. The first version of this harness read with
    # `read_text()` and wrote with `write_text()`, and Python's default newline
    # translation rewrote the file's 1320 LF endings to CRLF. Git reported the
    # file CLEAN anyway, because `.gitattributes` normalizes `*.ts` to LF -- so
    # the damage was invisible to `git status` while the on-disk bytes had
    # changed. That is the same class of artifact as R2-F11F10's `' M'` entry
    # (identical blob hash, different bytes). A restore assertion that hashes the
    # ENCODED bytes is what catches it, and text-mode I/O is what causes it.
    original = target.read_bytes()
    lines = original.split(b"\n")

    # Insert AFTER the last import line, so the marker is inside the module body
    # and not inside an import statement.
    insert_at = 0
    for index, line in enumerate(lines):
        if line.startswith(b"import ") or line.startswith(b"} from "):
            insert_at = index + 1
    lines.insert(insert_at, MARKER.encode("utf-8"))
    mutated = b"\n".join(lines)

    report: dict[str, object] = {
        "scope": "S10_ID05_INJECTION_ARM",
        "package": package,
        "target_file": target.relative_to(REPO_ROOT).as_posix(),
        "target_sha256_before": before_digest,
        "injected_line_number": insert_at + 1,
        "injected_text": MARKER,
        "expected_error_code": "TS2322",
        "arms": [],
    }

    try:
        target.write_bytes(mutated)
        check = run_tsc(pkg_dir, CHECK_CONFIG)
        build = run_tsc(pkg_dir, BUILD_CONFIG)
        report["arms"] = [check, build]
    finally:
        target.write_bytes(original)

    after_digest = sha256(target)
    report["target_sha256_after"] = after_digest
    report["restore_byte_exact"] = after_digest == before_digest

    check = report["arms"][0]  # type: ignore[index]
    build = report["arms"][1]  # type: ignore[index]
    check_diag = f"{check['stdout']}{check['stderr']}"  # type: ignore[index]
    build_diag = f"{build['stdout']}{build['stderr']}"  # type: ignore[index]

    report["verdict"] = {
        "check_config_caught_the_error": check["exit_code"] != 0 and "TS2322" in check_diag,  # type: ignore[index]
        "check_config_exit_code": check["exit_code"],  # type: ignore[index]
        "check_config_named_the_injected_line": f"({insert_at + 1}," in check_diag,
        "build_config_missed_the_error": build["exit_code"] == 0 and "TS2322" not in build_diag,  # type: ignore[index]
        "build_config_exit_code": build["exit_code"],  # type: ignore[index]
        "restore_byte_exact": after_digest == before_digest,
    }
    report["oracle_established"] = all([
        report["verdict"]["check_config_caught_the_error"],  # type: ignore[index]
        report["verdict"]["check_config_named_the_injected_line"],  # type: ignore[index]
        report["verdict"]["build_config_missed_the_error"],  # type: ignore[index]
        report["verdict"]["restore_byte_exact"],  # type: ignore[index]
    ])

    print(json.dumps(report, indent=2))
    print()
    print("--- the injected line, from the CHECK config's diagnostics ---")
    for line in check_diag.splitlines():
        if "s10Injected" in line or "TS2322" in line:
            print(f"  {line.strip()}")
    print()
    print("--- the BUILD config's diagnostics (the control arm) ---")
    print(f"  exit {build['exit_code']}; output {'EMPTY' if not build_diag.strip() else build_diag.strip()[:400]}")
    return 0 if report["oracle_established"] else 1


if __name__ == "__main__":
    sys.exit(main())
