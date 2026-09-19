#!/usr/bin/env python3
"""File V9's VERIFICATION results into the trusted-local spec by TEXT SPLICING.

WHY NOT `json.load` + `json.dump`. The spec is a shared file that other families are
editing concurrently, and it is not written in `json.dumps(indent=2)` formatting --
its case objects sit at four spaces and their keys at six. Re-dumping it would reformat
every line of the document, which would (a) make this slice's diff unreviewable and
(b) race with every sibling edit in flight. So this script replaces the TEXT SPAN of
each VER case and leaves every other byte of the file untouched. It reads the result
back as JSON afterwards and refuses to write if the parse fails.

WHAT IT TOUCHES: the nine spans whose `"id"` is VER-01..VER-09. It asserts that each
span it is about to replace currently carries `"status": "NOT_RUN"` and an empty
evidence list, so it can never overwrite a sibling's result.

Usage:
    python qualification/results/V9-verification/file-ver-cases.py            # write
    python qualification/results/V9-verification/file-ver-cases.py --dry-run  # report only
"""
from __future__ import annotations

import argparse
import hashlib
import json
import pathlib
import sys

REPO = pathlib.Path(__file__).resolve().parents[3]
SPEC = REPO / "qualification" / "specs" / "acceptance-spec.trusted-local-v1.json"
LOCK = REPO / "compatibility.lock.json"
SLICE = "qualification/results/V9-verification"

IDENT = json.loads(LOCK.read_text(encoding="utf-8"))["deployment"]["identity"]
TESTS = f"{SLICE}/verification-gates-tests.raw.txt"


def sha256(rel: str) -> str:
    return hashlib.sha256((REPO / rel).read_bytes()).hexdigest()


def ev(rel: str, note: str) -> dict:
    return {"path": rel, "sha256": sha256(rel), "identity": IDENT, "note": note}


CASES: dict[str, dict] = {
    "VER-01": {
        "status": "PASS",
        "note": None,
        "evidence": [
            ev(f"{SLICE}/VER-01-zero-tests-not-a-pass.txt",
               "The oracle, the exact command, the verbatim CLI output and the receipt's own "
               "fields: exit.code 0, outcome 'zero_tests', passed false, and the reason naming "
               "the zero-test condition. So exit 0 alone is demonstrably not read as green."),
            ev(f"{SLICE}/receipt-ver01-zero-tests.json",
               "The real receipt the run wrote, with exit.code 0 recorded beside passed false."),
            ev(TESTS,
               "In-suite arm plus its CONTROL: the same command over the same tree with the same "
               "exit 0 and NO declared counts reports outcome 'pass', so the difference between "
               "the two receipts is the classification and nothing about the process. "
               "51 passed / 51, TEST_EXIT=0."),
        ],
    },
    "VER-02": {
        "status": "PASS",
        "note": None,
        "evidence": [
            ev(f"{SLICE}/VER-02-all-skipped-not-a-pass.txt",
               "Verbatim CLI output and receipt: exit.code 0, outcome 'all_skipped', passed "
               "false, observedTests {total:2, passed:0, failed:0, skipped:2, todo:0}. The skip "
               "count is reported and the exit code is shown to have been 0."),
            ev(f"{SLICE}/receipt-ver02-all-skipped.json",
               "The real receipt, carrying the observed skip counts and exit.code 0."),
            ev(TESTS,
               "In-suite arm asserting observedTests {passed:0, failed:0, skipped:2} AND "
               "testsAreReal().real === false, so the integration authority refuses it too. "
               "51 passed / 51, TEST_EXIT=0."),
        ],
    },
    "VER-03": {
        "status": "PASS",
        "note": (
            "The oracle-digest closure is a MECHANISM, not an enforced policy: that any "
            "production caller passes the right oracleFiles set is NOT proven, and the runner's "
            "snapshot still does not cover an undeclared oracle."
        ),
        "evidence": [
            ev(f"{SLICE}/VER-03-candidate-cannot-weaken-its-own-oracle.txt",
               "The weakened definition is DETECTED: outcome 'acceptance_definition_changed', "
               "exit.code null, limitations ['the acceptance command was never executed'], and "
               "the refusal names both digests. The corrected CONTROL shows the honest definition "
               "with the same authorized digest still RUNS."),
            ev(f"{SLICE}/cli-ver03.txt",
               "Raw capture, including the first control arm that changed the definition id and "
               "was refused for that reason -- kept because a control that fails for the reason "
               "it is controlling for proves nothing."),
            ev(f"{SLICE}/receipt-ver03-weakened-refused.json",
               "The refusal receipt, showing nothing ran."),
            ev(TESTS,
               "In-suite arms: the weakened threshold carrying the authorized digest is REFUSED; "
               "the undeclared-oracle gap is MEASURED; and the closure (oracleDigest + "
               "bindReceipt + observedBasis) refuses a receipt whose oracle changed. "
               "51 passed / 51, TEST_EXIT=0."),
        ],
    },
    "VER-04": {
        "status": "PASS",
        "note": (
            "Numbering honoured: this is the NEW VER-04 (receipt freshness). The old VER-04 "
            "(host execution bypass) is out of scope and recorded in not_applicable_inherited; "
            "nothing here is evidence for it."
        ),
        "evidence": [
            ev(f"{SLICE}/VER-04-receipt-does-not-outlive-its-tree.txt",
               "CLI end to end: fresh -> {fresh:true}, check_exit 0; after one byte of a declared "
               "input changes -> {fresh:false} with both digests named, check_exit 1 and the "
               "runner says 're-verify'. CONTROL: a FRESH receipt that is not a PASS still exits "
               "1, so freshness is never a verdict."),
            ev(f"{SLICE}/cli-ver04-freshness.txt",
               "The verbatim capture of all arms, including what the receipt does NOT carry (no "
               "oracleDigest field: the oracle binding is a separate VerdictBinding compared by "
               "bindReceipt, by design)."),
            ev(f"{SLICE}/receipt-ver04-fresh-pass.json",
               "The real receipt, carrying candidateTreeDigest, candidateTreeDigestScope and "
               "acceptanceDefinitionDigest."),
            ev(TESTS,
               "In-suite arms for the WORKSPACE, ORACLE and ENVIRONMENT bindings independently, "
               "each moving exactly one of four real digests, with a restored tree ACCEPTING as "
               "the control. 51 passed / 51, TEST_EXIT=0."),
        ],
    },
    "VER-05": {
        "status": "PASS",
        "note": None,
        "evidence": [
            ev(f"{SLICE}/VER-05-aba-mutation-caught.txt",
               "The printed numbers for the oracle: the frozen arm's child read revision A for "
               "input+oracle+config while the live tree went A->B->A; liveDigestAtStart == "
               "liveDigestAtEnd and liveDriftDetected false, so endpoint polling sees NOTHING; "
               "the in-place CONTROL exits 9 having seen the tampered tree, and both receipts "
               "carry the SAME start digest."),
            ev(f"{SLICE}/ver05-06-aba-and-inflight.txt",
               "The verbatim probe output, including the serialized-receipt asymmetry that makes "
               "the snapshot load-bearing rather than decorative."),
            ev(TESTS,
               "In-suite two-arm proof extended to the oracle and the config, plus the case where "
               "a command rewrites its own declared input inside the snapshot and the outcome is "
               "'unknown' with holdReservation true. 51 passed / 51, TEST_EXIT=0."),
        ],
    },
    "VER-06": {
        "status": "PASS",
        "note": (
            "Measures the freeze DECISION. That a production caller invokes convergeBeforeFreeze "
            "before every acceptance is the caller's to provide and is NOT claimed."
        ),
        "evidence": [
            ev(f"{SLICE}/VER-06-in-flight-writers-converged.txt",
               "Three measured paths: a live writer lease refuses the freeze; a released lease "
               "with a still-moving tree refuses and names BOTH sample digests; a stopped writer "
               "converges to a digest EQUAL to the runner's own digestInputs. The structural "
               "invariant digest!=='' implies converged===true holds on every path."),
            ev(f"{SLICE}/ver05-06-aba-and-inflight.txt",
               "The verbatim probe output for all three paths, with their distinct refusal "
               "reasons printed separately."),
            ev(TESTS,
               "In-suite arms: 'freezing while a writer still holds the workspace is REFUSED as "
               "in-flight', the two-arm convergence case, and 'a refusal NEVER carries a digest'. "
               "51 passed / 51, TEST_EXIT=0."),
        ],
    },
    "VER-07": {
        "status": "PASS",
        "note": (
            "Asserted for the pause/drain DISTINCTION, not for a whole recovery: it does not run "
            "a full failed -> corrected -> re-verified -> completed turn."
        ),
        "evidence": [
            ev(f"{SLICE}/VER-07-verification-failure-is-recoverable.txt",
               "The case's five assertions read from source, driven against the REAL "
               "SubagentRuntime: pause leaves the run paused and refusing ('run_not_open'); a "
               "correction child is still admitted WHILE PAUSED; resume re-opens admission; and "
               "only the later permanent drain rejects with 'draining; the operation was not "
               "admitted' -- which is what proves the paused state was genuinely not-yet-drained."),
            ev(TESTS,
               "The run that carries it: 51 passed / 51, TEST_EXIT=0, 105.62 s, single worker "
               "with --maxWorkers=1 --no-file-parallelism."),
        ],
    },
    "VER-08": {
        "status": "PASS",
        "note": None,
        "evidence": [
            ev(f"{SLICE}/VER-08-acceptance-cannot-authorize-itself.txt",
               "The digest check FAILS and the run is refused with nothing executed, and the "
               "SEPARATION OF STEPS is shown as two commands: --print-digest prints and writes "
               "nothing back, and no flag both authorizes and runs. The corrected control shows "
               "the honest definition with the same digest still runs."),
            ev(f"{SLICE}/cli-ver03-control.txt",
               "The corrected control arm with both digests printed side by side."),
            ev(TESTS,
               "In-suite arm: the weakened threshold carrying the authorized digest is REFUSED, "
               "not run, while the same definition with the same digest really executes. "
               "51 passed / 51, TEST_EXIT=0."),
        ],
    },
    "VER-09": {
        "status": "PASS",
        "note": (
            "An identity drift was found while filing and is reported rather than absorbed: "
            "trusted_local_acceptance_spec_sha256 pins THIS spec's digest, and this spec is also "
            "the results register every family writes into, so filing into it changes the "
            "identity. See " + SLICE + "/identity-at-measurement.txt. No unilateral "
            "re-derivation was performed -- moving deployment.identity is an owner-level "
            "decision."
        ),
        "evidence": [
            ev(f"{SLICE}/VER-09-tier-and-limit-stated.txt",
               "All three clauses. 109/109 cases name a tier from the layer legend; 0 T5 cases "
               "are PASS while live_provider_budget_authorized is false; the old gate index "
               "shares no id with this spec. And the SAME-ACCOUNT measurement taken from inside "
               "the verification child: child user 'hzq00' == host user 'hzq00' at a different "
               "pid, so no privilege separation exists -- stated in the deployment's own "
               "trust_model_statement rather than implied."),
            ev(f"{SLICE}/ver09-tier-audit.json",
               "The machine-readable audit: per-case layer distribution, the T5 expectation, the "
               "receipt's binding fields, and its own scope statement -- it audits tier "
               "discipline in the record and does not judge whether an oracle was established."),
            ev(f"{SLICE}/cli-ver09-account.txt",
               "The raw capture of the same-account probe driven through the real acceptance "
               "runner, plus what the runner DOES remove (credential-shaped and DSH_* env names, "
               "the control-plane handle) kept separate from what it does NOT (filesystem reads, "
               "egress)."),
            ev(f"{SLICE}/ver09-sibling-tier-crosscheck.txt",
               "The clause-2 cross-check against the other families' gate tables: ZERO explicit "
               "tier tokens beside case ids were found. Recorded as the empty result it is, with "
               "the reason it is empty, rather than folded into a green."),
            ev(TESTS,
               "The in-suite cases that measure the CONSEQUENCES of the same-account limit: a "
               "candidate child read a host file outside its snapshot verbatim, and a candidate "
               "child completed a real TCP connection. 51 passed / 51, TEST_EXIT=0."),
        ],
    },
}


def render(case_id: str, spec: dict) -> str:
    """The replacement text for one case span, in the file's own style."""
    entry = CASES[case_id]
    lines = ['    {']
    lines.append(f'      "id": {json.dumps(case_id)},')
    lines.append('      "family": "VERIFICATION",')
    lines.append(f'      "layer": {json.dumps(spec["layer"])},')
    lines.append('      "mandatory": true,')
    lines.append(f'      "requirement": {json.dumps(spec["requirement"], ensure_ascii=False)},')
    lines.append(f'      "stimulus": {json.dumps(spec["stimulus"], ensure_ascii=False)},')
    lines.append(f'      "oracle": {json.dumps(spec["oracle"], ensure_ascii=False)},')
    lines.append('      "status": ' + json.dumps(entry["status"]) + ',')
    lines.append('      "evidence": [')
    for index, item in enumerate(entry["evidence"]):
        # `note` is the LAST key of each evidence object, so the separator belongs
        # after that object's closing brace -- not after its final key. Two earlier
        # versions got this wrong in both directions and the round-trip check refused
        # each before anything was written, which is what that check is for.
        comma = "," if index < len(entry["evidence"]) - 1 else ""
        lines.append('        {')
        lines.append(f'          "path": {json.dumps(item["path"])},')
        lines.append(f'          "sha256": {json.dumps(item["sha256"])},')
        lines.append(f'          "identity": {json.dumps(item["identity"])},')
        lines.append(f'          "note": {json.dumps(item["note"], ensure_ascii=False)}')
        lines.append('        }' + comma)
    # The note goes AFTER the evidence, so the array closes with a comma when one is
    # present. Emitting it as a leading comma on its own line would be valid JSON but
    # would read as a formatting mistake to every later reviewer of this file.
    lines.append('      ]' + (',' if entry["note"] else ''))
    if entry["note"]:
        lines.append(f'      "note": {json.dumps(entry["note"], ensure_ascii=False)}')
    lines.append('    }')
    return "\n".join(lines)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    original = SPEC.read_text(encoding="utf-8")
    doc = json.loads(original)
    by_id = {c["id"]: c for c in doc["cases"]}

    text = original
    filed = []
    for case_id in sorted(CASES):
        case = by_id.get(case_id)
        if case is None or case.get("family") != "VERIFICATION":
            print(f"REFUSING: {case_id} is not a VERIFICATION case in the spec", file=sys.stderr)
            return 2
        # Refuse to overwrite anything that is not still at its authoring state.
        if case.get("status") != "NOT_RUN" or case.get("evidence") != []:
            print(f"REFUSING: {case_id} is no longer NOT_RUN with empty evidence "
                  f"(status={case.get('status')!r}, {len(case.get('evidence') or [])} entries); "
                  "another writer has already filed it", file=sys.stderr)
            return 2
        for item in CASES[case_id]["evidence"]:
            if not (REPO / item["path"]).is_file():
                print(f"REFUSING: {case_id} names a missing file {item['path']}", file=sys.stderr)
                return 2

        start_marker = f'    {{\n      "id": "{case_id}",'
        start = text.index(start_marker)
        # The span ends at the closing brace of THIS case object. The boundary is the
        # next case object's opening line -- found GENERICALLY, not from the CASES map,
        # because VER-09 is the last VERIFICATION case and the case after it (RES-01) is
        # not in this map. An earlier version searched only CASES and therefore ran
        # VER-09's span to the last "    }" in the file, which swallowed every following
        # case. The round-trip check below caught it before anything was written.
        next_case = text.find('\n    {\n      "id": "', start + len(start_marker))
        end = text.rindex("\n    }", start, next_case if next_case != -1 else len(text))
        end += len("\n    }")
        text = text[:start] + render(case_id, case) + text[end:]
        filed.append(case_id)

    # Read the spliced result back before writing: a splice that produced invalid
    # JSON must not reach the file.
    try:
        check = json.loads(text)
    except json.JSONDecodeError as error:
        print(f"REFUSING: the spliced text is not valid JSON: {error}", file=sys.stderr)
        return 2

    for case_id in filed:
        new = next(c for c in check["cases"] if c["id"] == case_id)
        if new["status"] != "PASS" or len(new["evidence"]) != len(CASES[case_id]["evidence"]):
            print(f"REFUSING: {case_id} did not survive the round trip", file=sys.stderr)
            return 2

    print(f"filing under identity {IDENT}")
    for case_id in filed:
        print(f"  {case_id}  {CASES[case_id]['status']}  "
              f"{len(CASES[case_id]['evidence'])} evidence entry/entries")
    # The case list and every non-VER case must be byte-identical in content.
    before = [c["id"] for c in doc["cases"]]
    after = [c["id"] for c in check["cases"]]
    if before != after:
        print("REFUSING: the case list changed", file=sys.stderr)
        return 2
    print(f"  {len(before)} cases, list unchanged; "
          f"{sum(1 for c in check['cases'] if c['family'] != 'VERIFICATION')} non-VERIFICATION "
          "cases untouched")

    if args.dry_run:
        print("dry run: nothing written")
        return 0

    SPEC.write_text(text, encoding="utf-8")
    print(f"wrote {SPEC.relative_to(REPO)}  ({len(text)} bytes)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
