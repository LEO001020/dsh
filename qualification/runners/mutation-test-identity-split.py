#!/usr/bin/env python3
"""Prove the v2 identity split by MUTATION, in both directions.

THE EXIT CRITERION THIS FILE EXISTS FOR (V3 E2):

    "independent mutation tests prove runtime drift and spec drift produce
     DIFFERENT identity failures."

An assertion that the two identities are separate is worth nothing; v1 also
*asserted* that its spec was an identity input and an evidence ledger, and those two
assertions were incompatible. So the separation is established the only way that
survives a later edit: by perturbing each side and measuring which identity moves.

THE FOUR ARMS, and what each one rules out:

  A. RUNTIME DRIFT (a measured runtime input changes)
     -> RuntimeDeploymentIdentity MOVES, and QualificationContractIdentity MOVES TOO,
        because the contract identity hashes the runtime identity.
     Rules out: a runtime change that leaves verdicts apparently valid.

  B. SPEC DRIFT (an oracle's text changes)
     -> QualificationContractIdentity MOVES and RuntimeDeploymentIdentity DOES NOT.
     Rules out: the v1 failure, where the deployment identity was entangled with the
     acceptance spec, so redefining a case made the DEPLOYMENT look changed.

  C. CONTRACT-METADATA DRIFT (a case's dependencies change, with no oracle edit)
     -> QualificationContractIdentity MOVES, RuntimeDeploymentIdentity DOES NOT.
     Rules out: "only oracle text is hashed", which would let a case's structure --
     what it depends on -- change under a stable contract identity.

  D. RUNNER/GATE DRIFT (a qualification runner changes)
     -> QualificationContractIdentity MOVES, RuntimeDeploymentIdentity DOES NOT.
     Rules out: a changed VERDICT DECIDER that leaves verdicts looking valid. V3 E2
     names "qualification-runner/gate digests" as contract inputs for this reason.

  E. RESULT FEEDBACK (a new artifact is written into the results directory)
     -> NEITHER identity moves.
     Rules out the v1 defect returning by a side door. v1's conflict was that the spec
     was BOTH an identity input and the evidence ledger, so filing a verdict moved a
     pinned input. If v2's results directory were ever made an identity input -- even
     indirectly, e.g. by digesting the whole tree under qualification/ -- then arm E
     fails and the regression is caught here rather than in production.

THE MUTATION DISCIPLINE, taken from `qualification/results/V1-identity/rederive-identity.py`
which established it for the v1 spec:

  * every in-place mutation is restored BYTE-FOR-BYTE and the restore is VERIFIED by
    sha256, not assumed;
  * the mutation window is milliseconds;
  * the restore is asserted even when the measurement throws, so a failure cannot
    leave the tree mutated;
  * the probe JSON is mutated on a COPY, because it is a measurement artifact and
    destroying it would destroy the runtime identity's measured half.

WHAT THIS DOES NOT DO. It does not decide any acceptance case, and it does not move
`compatibility.lock.json`. It mutates the DEFINITION (which v2 owns and which is not
a v1 pinned input) and a COPY of the probe.

Usage:
    python qualification/runners/mutation-test-identity-split.py
    python qualification/runners/mutation-test-identity-split.py --json
"""
from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
DEFINITION = ROOT / "qualification" / "specs" / "acceptance-spec.trusted-local-v2.definition.json"
IDENTITY_RUNNER = ROOT / "qualification" / "runners" / "qualification-identity.py"
PROBE = ROOT / "qualification" / "results" / "trusted-local-v2-identity" / "probe.json"
OUT_DIR = ROOT / "qualification" / "results" / "trusted-local-v2-identity"
# A runner whose digest is a CONTRACT input. Chosen because it is the smallest of
# them and its mutation is one added comment line.
RUNNER_TO_MUTATE = ROOT / "qualification" / "runners" / "build-v2-definition.py"


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256_file(path: Path) -> str:
    return sha256_bytes(path.read_bytes())


def identities(probe: Path) -> dict[str, str]:
    """Recompute both identities through the real runner, as a subprocess."""
    proc = subprocess.run(
        [sys.executable, str(IDENTITY_RUNNER), "--json", "--probe", str(probe)],
        cwd=ROOT, capture_output=True, text=True,
    )
    if proc.returncode not in (0, 1):
        raise RuntimeError(f"the identity runner failed: {proc.stderr.strip()}")
    model = json.loads(proc.stdout)
    return {
        "runtime": model["runtime_deployment_identity"],
        "contract": model["qualification_contract"]["qualification_contract_identity"],
        "definition": model["qualification_contract"]["acceptance_definition_digest"],
    }


def classify(before: dict[str, str], after: dict[str, str]) -> dict[str, Any]:
    return {
        "runtime_moved": before["runtime"] != after["runtime"],
        "contract_moved": before["contract"] != after["contract"],
        "definition_moved": before["definition"] != after["definition"],
        "before": before,
        "after": after,
    }


def mutate_in_place(path: Path, edit, label: str) -> dict[str, Any]:
    """Apply one edit to a file, measure, then restore byte-exactly.

    The restore is verified by sha256 and the verification result is RETURNED, so a
    failed restore is a recorded finding rather than a silent tree corruption. The
    restore also runs on the exception path, so a throwing measurement cannot leave
    the tree mutated.
    """
    original = path.read_bytes()
    original_digest = sha256_bytes(original)
    before = identities(PROBE)
    try:
        mutated = edit(original)
        if mutated == original:
            raise AssertionError(f"{label}: the edit changed nothing, so nothing was tested")
        path.write_bytes(mutated)
        after = identities(PROBE)
        outcome = classify(before, after)
    finally:
        path.write_bytes(original)
    restored_digest = sha256_file(path)
    outcome["restored"] = restored_digest == original_digest
    outcome["original_sha256"] = original_digest
    outcome["restored_sha256"] = restored_digest
    return outcome


def edit_oracle_text(original: bytes) -> bytes:
    """Arm B: change ONE WORD of one oracle, nothing else."""
    text = original.decode("utf-8")
    needle = "the model-visible tool surface is intact and named"
    if needle not in text:
        raise AssertionError("arm B: the needle is absent, so the arm would test nothing")
    return text.replace(needle, "the model-visible tool surface is intact and NAMED", 1).encode("utf-8")


def edit_dependencies(original: bytes) -> bytes:
    """Arm C: change a case's DEPENDENCIES, leaving every oracle byte-identical."""
    doc = json.loads(original.decode("utf-8"))
    target = next(c for c in doc["cases"] if c["id"] == "CMP-04")
    if target["dependencies"] != ["CMP-13"]:
        raise AssertionError(f"arm C: CMP-04's dependencies are {target['dependencies']!r}, "
                             "not the expected ['CMP-13'], so the arm would test a different fact")
    target["dependencies"] = ["CMP-13", "CMP-05"]
    return (json.dumps(doc, indent=2, ensure_ascii=False) + "\n").encode("utf-8")


def edit_runner(original: bytes) -> bytes:
    """Arm D: add one comment line to a runner whose digest is a contract input."""
    return original + b"\n# mutation-test arm D: one added line, no behaviour change\n"


def edit_probe(original: bytes) -> bytes:
    """Arm A: change one measured runtime input -- the resolved tool catalog digest."""
    doc = json.loads(original.decode("utf-8"))
    doc["agentCatalog"]["schemaDigest"] = "0" * 64
    return (json.dumps(doc, indent=2) + "\n").encode("utf-8")


def main() -> int:
    parser = argparse.ArgumentParser(description="mutation-test the v2 identity split")
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()

    if not PROBE.is_file():
        print(f"mutation-test: no probe at {PROBE}; run qualification/runners/run-v2-identity.mjs first",
              file=sys.stderr)
        return 2
    for path in (DEFINITION, IDENTITY_RUNNER, RUNNER_TO_MUTATE):
        if not path.is_file():
            print(f"mutation-test: missing {path}", file=sys.stderr)
            return 2

    baseline = identities(PROBE)
    arms: list[dict[str, Any]] = []

    # ── ARM A: runtime drift, measured on a COPY of the probe ────────────────
    # The probe is mutated on a copy rather than in place: it IS the runtime
    # identity's measured half, so corrupting it in place would destroy the very
    # input whose sensitivity is being demonstrated.
    with tempfile.TemporaryDirectory() as tmp:
        probe_copy = Path(tmp) / "probe.json"
        shutil.copyfile(PROBE, probe_copy)
        original = probe_copy.read_bytes()
        before = identities(PROBE)
        probe_copy.write_bytes(edit_probe(original))
        after = identities(probe_copy)
        arm_a = classify(before, after)
        arm_a["restored"] = True
        arm_a["restored_sha256"] = sha256_bytes(original)
        arm_a["note"] = "mutated on a COPY: the real probe is the runtime identity's measured half"
    arms.append({
        "arm": "A",
        "what": "RUNTIME DRIFT: one measured runtime input changes (the resolved per-Agent "
                "tool catalog schema digest, a V3 E2 runtime identity term)",
        "expected": "RuntimeDeploymentIdentity MOVES; QualificationContractIdentity MOVES (it "
                    "hashes the runtime identity)",
        "expect_runtime_moved": True,
        "expect_contract_moved": True,
        **arm_a,
    })

    # ── ARM B: spec drift, one word of one oracle ────────────────────────────
    arms.append({
        "arm": "B",
        "what": "SPEC DRIFT: ONE WORD of one oracle changes, nothing else",
        "expected": "QualificationContractIdentity MOVES; RuntimeDeploymentIdentity DOES NOT",
        "expect_runtime_moved": False,
        "expect_contract_moved": True,
        **mutate_in_place(DEFINITION, edit_oracle_text, "arm B"),
    })

    # ── ARM C: contract-metadata drift, dependencies only ────────────────────
    arms.append({
        "arm": "C",
        "what": "CONTRACT-METADATA DRIFT: a case's DEPENDENCIES change and every oracle is "
                "byte-identical",
        "expected": "QualificationContractIdentity MOVES; RuntimeDeploymentIdentity DOES NOT",
        "expect_runtime_moved": False,
        "expect_contract_moved": True,
        **mutate_in_place(DEFINITION, edit_dependencies, "arm C"),
    })

    # ── ARM D: runner/gate drift ─────────────────────────────────────────────
    arms.append({
        "arm": "D",
        "what": "RUNNER/GATE DRIFT: one line added to a qualification runner whose digest is a "
                "contract input",
        "expected": "QualificationContractIdentity MOVES; RuntimeDeploymentIdentity DOES NOT",
        "expect_runtime_moved": False,
        "expect_contract_moved": True,
        **mutate_in_place(RUNNER_TO_MUTATE, edit_runner, "arm D"),
    })

    # ── ARM E: result feedback ───────────────────────────────────────────────
    # Writes a REAL file into the results directory and checks that neither identity
    # moves. This is the direct test of root's question: could a re-run of the
    # mutation test -- or any other filing -- feed back into the identity? The file
    # is removed afterwards, and the removal is verified.
    results_dir = OUT_DIR
    canary = results_dir / "mutation-test-arm-e-canary.json"
    before_e = identities(PROBE)
    canary.write_text(json.dumps({"arm": "E", "writtenAt": "probe", "note":
                                  "a file written into the results tree to prove the tree is "
                                  "not an identity input"}) + "\n", encoding="utf-8")
    after_e = identities(PROBE)
    arm_e = classify(before_e, after_e)
    canary.unlink()
    arm_e["restored"] = not canary.exists()
    arm_e["restored_sha256"] = "n/a (a created file, removed)"
    arm_e["note"] = ("a real file was CREATED in the results directory and then removed; the "
                     "removal is verified")
    arms.append({
        "arm": "E",
        "what": "RESULT FEEDBACK: a new artifact is written into the results directory",
        "expected": "NEITHER identity moves -- results are OUTPUTS, not inputs",
        "expect_runtime_moved": False,
        "expect_contract_moved": False,
        **arm_e,
    })

    # ── judge ────────────────────────────────────────────────────────────────
    failures: list[str] = []
    for arm in arms:
        if arm["runtime_moved"] != arm["expect_runtime_moved"]:
            failures.append(
                f"arm {arm['arm']}: RuntimeDeploymentIdentity moved={arm['runtime_moved']}, "
                f"expected {arm['expect_runtime_moved']}")
        if arm["contract_moved"] != arm["expect_contract_moved"]:
            failures.append(
                f"arm {arm['arm']}: QualificationContractIdentity moved={arm['contract_moved']}, "
                f"expected {arm['expect_contract_moved']}")
        if not arm["restored"]:
            failures.append(
                f"arm {arm['arm']}: the mutation was NOT restored byte-for-byte "
                f"({arm['original_sha256']} -> {arm['restored_sha256']})")

    # The cross-arm claim, stated as its own check: the two drifts must be
    # DISTINGUISHABLE, not merely both detected.
    a, b = arms[0], arms[1]
    distinguishable = a["runtime_moved"] and not b["runtime_moved"]
    if not distinguishable:
        failures.append(
            "the two drifts are NOT distinguishable: runtime drift moved the runtime identity="
            f"{a['runtime_moved']}, and spec drift moved it={b['runtime_moved']} (expected False)")

    # And the tree must be exactly where it started.
    final = identities(PROBE)
    tree_restored = final == baseline
    if not tree_restored:
        failures.append(f"the tree did NOT return to its baseline identity: {baseline} -> {final}")

    # ── the structural check behind arm E, stated over the input sets ────────
    # Arm E shows that writing a result TODAY does not move the identity. That is a
    # measurement of the current code; this is the reason it holds, checked directly:
    # no identity input set names anything under the results root. If a later change
    # added such a field -- the exact shape of v1's defect -- this fails even if the
    # file it names happens not to exist yet.
    model = json.loads(subprocess.run(
        [sys.executable, str(IDENTITY_RUNNER), "--json", "--probe", str(PROBE)],
        cwd=ROOT, capture_output=True, text=True).stdout)
    runtime_blob = json.dumps(model["runtime_inputs"], ensure_ascii=True)
    contract_blob = json.dumps(model["qualification_contract"], ensure_ascii=True)
    results_root = "qualification/results/"
    results_location_only = "results_location" in contract_blob
    # THE PRECISE CHECK, and the coarse one is deliberately NOT used: the contract
    # REPORT carries `results_location`, which is a POINTER for a reader and is not
    # part of either hash's input set. The hash covers `acceptance_definition_digest`
    # and `qualification_runner_digests` only. So the check is against the sets as
    # they are HASHED, and a report field that merely names the directory is not a
    # finding. An earlier version of this check tested the whole report and reported a
    # failure for a correct model -- the check was wrong, not the model.
    hashed_contract = json.dumps({
        "acceptance_definition_digest": model["qualification_contract"]["acceptance_definition_digest"],
        "qualification_runner_digests": model["qualification_contract"]["qualification_runner_digests"],
    }, ensure_ascii=True)
    results_in_hashed_inputs = results_root in hashed_contract
    if results_in_hashed_inputs:
        failures.append(
            "THE HASHED CONTRACT INPUT SET NAMES A RESULTS PATH. This is the v1 defect "
            "returning: filing a result would move the identity it is filed under.")
    # `runtime_inputs` IS the hashed set for the runtime identity, so this is direct.
    results_in_runtime_inputs = results_root in runtime_blob
    if results_in_runtime_inputs:
        failures.append(
            "THE HASHED RUNTIME INPUT SET NAMES A RESULTS PATH. Filing a result would move "
            "the runtime identity.")

    record = {
        "what": "the v2 identity split, proved by mutation in both directions",
        "generated_by": "qualification/runners/mutation-test-identity-split.py",
        "baseline": baseline,
        "final": final,
        "tree_restored": tree_restored,
        "arms": arms,
        "distinguishable": distinguishable,
        "results_are_not_identity_inputs": {
            "results_root": results_root,
            "results_path_in_runtime_hashed_inputs": results_in_runtime_inputs,
            "results_path_in_contract_hashed_inputs": results_in_hashed_inputs,
            "results_location_is_reported_but_not_hashed": results_location_only,
            "arm_e_measured_neither_identity_moved": not arm_e["runtime_moved"] and not arm_e["contract_moved"],
            "statement": (
                "Results are OUTPUTS bound to the contract identity. Arm E writes a real file "
                "into the results tree and neither identity moves; this block additionally "
                "checks that no identity input set NAMES a results path, so the property does "
                "not depend on the file not existing. The contract report carries "
                "`results_location` as a POINTER for a reader, which is why the check is against "
                "the HASHED input sets rather than against the whole report."),
        },
        "failures": failures,
        "verdict": "SPLIT_PROVED" if not failures else "SPLIT_BROKEN",
        "what_this_does_not_prove": [
            "It does not prove any acceptance case. It mutates files and reads two digests.",
            "It does not prove the runtime identity covers EVERY runtime fact. It proves the "
            "measured runtime inputs it carries are load-bearing, by moving one and observing "
            "the runtime identity move.",
            "It does not prove the identity is COMPLETE for a deployment it has not seen. It "
            "proves the failure DIRECTIONS are separated, which is what the exit criterion asks.",
        ],
    }
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    (OUT_DIR / "mutation-test.json").write_text(
        json.dumps(record, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")

    if args.json:
        print(json.dumps(record, indent=2, ensure_ascii=False))
        return 1 if failures else 0

    print(f"baseline  runtime={baseline['runtime'][:16]} contract={baseline['contract'][:16]}")
    print("")
    for arm in arms:
        print(f"ARM {arm['arm']}  {arm['what']}")
        print(f"   runtime  {arm['before']['runtime'][:16]} -> {arm['after']['runtime'][:16]}"
              f"  {'MOVED' if arm['runtime_moved'] else 'unchanged'}"
              f"   (expected {'MOVED' if arm['expect_runtime_moved'] else 'unchanged'})")
        print(f"   contract {arm['before']['contract'][:16]} -> {arm['after']['contract'][:16]}"
              f"  {'MOVED' if arm['contract_moved'] else 'unchanged'}"
              f"   (expected {'MOVED' if arm['expect_contract_moved'] else 'unchanged'})")
        print(f"   restored byte-for-byte: {arm['restored']}")
        print("")
    print(f"the two drifts are DISTINGUISHABLE: {distinguishable}")
    print(f"the tree returned to its baseline identity: {tree_restored}")
    print("")
    if failures:
        print("FAILURES:")
        for failure in failures:
            print(f"  - {failure}")
        print(f"\nverdict: SPLIT_BROKEN")
        return 1
    print("verdict: SPLIT_PROVED")
    print("Runtime drift moves BOTH identities; spec, contract-metadata and runner drift move")
    print("ONLY the contract identity. That difference is the whole point of the split.")
    print(f"record: {OUT_DIR / 'mutation-test.json'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
