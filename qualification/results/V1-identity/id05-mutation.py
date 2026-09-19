#!/usr/bin/env python3
"""ID-05 mutation arm: inject ONE type error into a test file, compile, restore.

WHY THE MUTATION IS A TYPE ERROR AND NOT A SYNTAX ERROR. `vitest.config.ts` runs
`pool: 'forks'` with no type-checking step, and `tsconfig.json` EXCLUDES
`src/**/*.test.ts`, so vitest never type-checks. A pure TYPE error therefore
changes nothing for a concurrent vitest run: the file still parses and still
executes. That is what makes this mutation safe to perform on a tree nine agents
share. A syntax error would break their runs and is deliberately not used.

WHY IT RESTORES IN A `finally`. A mutation experiment that leaves its subject
changed is indistinguishable from tampering. The restore is verified by sha256,
and the pre-state is re-compared after the restore, so "restored" is a measured
fact rather than an intention.

WHAT IT PROVES. The clean tree exits 0 AND the injected error makes the compile
FAIL. Only both halves together show the oracle is load-bearing: a config that
type-checked nothing would pass the clean arm and pass the mutation arm too.

Usage:
    python qualification/results/V1-identity/id05-mutation.py
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

# A genuine type error, appended at module scope. It parses, it executes, and
# vitest is unaffected -- but tsc under `strict` must reject it.
MUTATION = (
    "\n// ID-05 MUTATION ARM: this line is a deliberate type error and is removed\n"
    "// by qualification/results/V1-identity/id05-mutation.py immediately after the\n"
    "// compile. If it is present when you read this, the restore failed.\n"
    "const id05InjectedTypeError: number = 'this is not a number'\n"
)


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def compile_once() -> dict[str, object]:
    proc = subprocess.run(
        ["node", TSC, "-p", "tsconfig.check.json"],
        cwd=str(PACKAGE), capture_output=True, text=True, timeout=600,
    )
    return {
        "exit_code": proc.returncode,
        "stdout": proc.stdout,
        "stderr": proc.stderr,
    }


def main() -> int:
    if not TARGET.is_file():
        print(f"no such test file: {TARGET}", file=sys.stderr)
        return 2

    original = TARGET.read_bytes()
    original_sha = sha256_bytes(original)

    report: dict[str, object] = {
        "scope": "ID05_MUTATION_ARM",
        "package": "packages/dsh-daily-work",
        "config": "tsconfig.check.json",
        "target_file": "packages/dsh-daily-work/src/dep-gates.test.ts",
        "mutation": "append one type error: const id05InjectedTypeError: number = 'this is not a number'",
        "pre_mutation_sha256": original_sha,
    }

    mutated = original + MUTATION.encode("utf-8")
    report["mutated_sha256"] = sha256_bytes(mutated)
    # tsc reports errors by LINE AND COLUMN, not by symbol name. The first version
    # of this check looked for the injected identifier in tsc's output, found none
    # (correctly -- tsc does not print the symbol), and reported the arm as
    # unestablished. That was a false negative in the ASSERTION, not in the
    # measurement: the compile had in fact failed at exactly the injected line.
    # The check is now the precise one -- the error must be reported at the line
    # the mutation landed on. The line number is DERIVED from the mutated bytes
    # rather than computed by an off-by-one-prone formula: it is the count of
    # newlines before the injected statement, plus one.
    injected_offset = mutated.index(b"const id05InjectedTypeError")
    injected_line = mutated[:injected_offset].count(b"\n") + 1
    report["injected_line_number"] = injected_line

    try:
        TARGET.write_bytes(mutated)
        after_write_sha = sha256_bytes(TARGET.read_bytes())
        report["mutation_landed"] = after_write_sha == report["mutated_sha256"]
        result = compile_once()
        report["mutation_compile"] = result
    finally:
        TARGET.write_bytes(original)

    restored_sha = sha256_bytes(TARGET.read_bytes())
    report["restored_sha256"] = restored_sha
    report["restore_is_byte_exact"] = restored_sha == original_sha

    # The verdict, as booleans a reader can check without trusting prose.
    mutation_compile = report.get("mutation_compile") or {}
    combined = str(mutation_compile.get("stdout", "")) + str(mutation_compile.get("stderr", ""))
    report["mutation_exit_code"] = mutation_compile.get("exit_code")
    # The diagnostic must name THIS file at THIS line, with the type-mismatch code.
    at_injected_line = f"src/dep-gates.test.ts({injected_line}," in combined
    report["error_reported_at_the_injected_line"] = at_injected_line
    report["error_code_is_type_mismatch"] = "TS2322" in combined
    report["oracle_established"] = (
        mutation_compile.get("exit_code") not in (0, None)
        and at_injected_line
        and "TS2322" in combined
        and report["restore_is_byte_exact"] is True
    )

    print(json.dumps(report, indent=2))

    print()
    print(f"mutation landed          : {report.get('mutation_landed')}")
    print(f"mutation compile exit    : {report['mutation_exit_code']}")
    print(f"error at injected line   : {report['error_reported_at_the_injected_line']} (line {injected_line})")
    print(f"error is TS2322          : {report['error_code_is_type_mismatch']}")
    print(f"restore byte-exact       : {report['restore_is_byte_exact']}")
    print(f"oracle established       : {report['oracle_established']}")
    print()
    print("--- the compile's own output, verbatim ---")
    print(str(mutation_compile.get("stdout", "")))
    print(str(mutation_compile.get("stderr", "")))
    return 0 if report["oracle_established"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
