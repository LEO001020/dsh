#!/usr/bin/env python3
"""ID-05 control arm: prove that `tsconfig.json` alone would have MISSED the error.

WHY THIS ARM EXISTS AND WHY IT IS NOT OPTIONAL.
The oracle's last sentence is: "A green run under `tsconfig.json` alone is NOT
PASS, because that config excludes the test files." That sentence is the whole
reason the case exists -- it is the difference between a config that type-checks
the tests and one that only looks like it does. Without this arm, a PASS on
"clean tree exits 0 and the injected error fails the compile" would be
established by `tsconfig.check.json` alone, and a reader could not tell whether
the check config was doing any work or whether `tsconfig.json` would have caught
the same error.

So the SAME injected type error is compiled under BOTH configs, in ONE mutation
window, and the two exit codes are the contrast:

    tsconfig.json        (excludes src/**/*.test.ts)  -> expected exit 0, the error is INVISIBLE
    tsconfig.check.json  (excludes nothing)           -> expected exit != 0, the error is CAUGHT

An exit 0 from the build config is not a failure of this arm; it is the arm's
RESULT, and it is what makes the check config load-bearing.

THE MUTATION IS A TYPE ERROR, NOT A SYNTAX ERROR, deliberately: `vitest.config.ts`
runs `pool: 'forks'` with no type-checking step, so a type error cannot break a
concurrent sibling's test run. A syntax error could, and is not used.

RESTORE IS ASSERTED BY sha256 IN A `finally`.

Usage:
    python qualification/results/V1-identity/id05-control-arm.py
"""
from __future__ import annotations

import hashlib
import json
import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]
TSC = "D:/DSH/src/dsh-src/node_modules/typescript/bin/tsc"
PACKAGE = REPO_ROOT / "packages" / "dsh-daily-work"
TARGET = PACKAGE / "src" / "dep-gates.test.ts"

MUTATION = (
    "\n// ID-05 CONTROL ARM: deliberate type error, removed immediately after the\n"
    "// two compiles. If present when you read this, the restore failed.\n"
    "const id05ControlTypeError: number = 'this is not a number'\n"
)


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def compile_with(config: str) -> dict[str, object]:
    proc = subprocess.run(
        ["node", TSC, "-p", config],
        cwd=str(PACKAGE), capture_output=True, text=True, timeout=600,
    )
    return {"config": config, "exit_code": proc.returncode,
            "stdout": proc.stdout.strip(), "stderr": proc.stderr.strip()}


def main() -> int:
    if not TARGET.is_file():
        print(f"no such test file: {TARGET}", file=sys.stderr)
        return 2

    original = TARGET.read_bytes()
    original_sha = sha256_bytes(original)
    mutated = original + MUTATION.encode("utf-8")
    injected_offset = mutated.index(b"const id05ControlTypeError")
    injected_line = mutated[:injected_offset].count(b"\n") + 1

    report: dict[str, object] = {
        "scope": "ID05_CONTROL_ARM",
        "package": "packages/dsh-daily-work",
        "target_file": "packages/dsh-daily-work/src/dep-gates.test.ts",
        "mutation": "append one type error: const id05ControlTypeError: number = 'this is not a number'",
        "injected_line_number": injected_line,
        "pre_mutation_sha256": original_sha,
        "compiles": [],
    }

    try:
        TARGET.write_bytes(mutated)
        report["mutation_landed"] = sha256_bytes(TARGET.read_bytes()) == sha256_bytes(mutated)
        # ORDER MATTERS ONLY FOR READABILITY: both run inside one window so the
        # tree cannot move between them.
        report["compiles"].append(compile_with("tsconfig.json"))
        report["compiles"].append(compile_with("tsconfig.check.json"))
    finally:
        TARGET.write_bytes(original)

    restored_sha = sha256_bytes(TARGET.read_bytes())
    report["restored_sha256"] = restored_sha
    report["restore_is_byte_exact"] = restored_sha == original_sha

    build = report["compiles"][0]
    check = report["compiles"][1]
    build_green = build["exit_code"] == 0
    check_red = check["exit_code"] not in (0, None)
    check_names_line = f"dep-gates.test.ts({injected_line}," in str(check["stdout"]) + str(check["stderr"])

    report["build_config_exit"] = build["exit_code"]
    report["check_config_exit"] = check["exit_code"]
    report["build_config_missed_the_error"] = build_green
    report["check_config_caught_the_error"] = check_red and check_names_line
    report["control_arm_established"] = (
        build_green and check_red and check_names_line and report["restore_is_byte_exact"] is True
    )

    print(json.dumps(report, indent=2))
    print()
    print("--- the contrast ---")
    print(f"  tsconfig.json        (excludes tests) exit={build['exit_code']}  -> error INVISIBLE: {build_green}")
    print(f"    output: {build['stdout'] or '(none)'}")
    print(f"  tsconfig.check.json  (all files)      exit={check['exit_code']}  -> error CAUGHT: {check_red}")
    print(f"    output: {check['stdout'] or '(none)'}")
    print(f"  error reported at the injected line {injected_line}: {check_names_line}")
    print(f"  restore byte-exact: {report['restore_is_byte_exact']}")
    print()
    print(f"CONTROL ARM ESTABLISHED: {report['control_arm_established']}")
    print("  A green run under tsconfig.json alone would NOT have been a PASS, and that")
    print("  is now a measured contrast rather than a claim in a comment.")
    return 0 if report["control_arm_established"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
