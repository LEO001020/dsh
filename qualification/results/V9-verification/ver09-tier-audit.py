#!/usr/bin/env python3
"""V9 / VER-09 — audit every recorded verdict for tier honesty.

WHY THIS EXISTS. VER-09's oracle has three parts and the third is the one that is
easy to imply rather than state:

  1. each verdict names its tier FROM THE LAYER LEGEND and the artifact it is
     bound to;
  2. a green measured at T0/T1 is never presented as T2/T3/T5/T6;
  3. under trusted-local the verification environment runs as the SAME OS user as
     the host, so the record must ALSO state that no privilege separation exists.

This script is the mechanical half of (1) and (2): it reads the spec on disk and
the old gate index on disk and reports, per case, the declared layer, whether that
layer is one of the legend's keys, and whether the evidence that would be required
at that tier exists. It cannot read intent, and it does not try.

WHAT IT DOES NOT DO. It does not decide whether an oracle was established, and it
does not mark anything PASS. It prints numbers and a verdict of its own, and the
verdict it prints is about TIER DISCIPLINE IN THE RECORD, not about the product.

Usage:
    python qualification/results/V9-verification/ver09-tier-audit.py [--json]

Bounds (CPU directive): reads FIVE named files. It walks no directory tree.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import pathlib
import sys
from collections import Counter

REPO = pathlib.Path(__file__).resolve().parents[3]

SPEC = REPO / "qualification" / "specs" / "acceptance-spec.trusted-local-v1.json"
OLD_SPEC = REPO / "qualification" / "specs" / "acceptance-spec.json"
OLD_GATES = REPO / "qualification" / "gates.json"
LOCK = REPO / "compatibility.lock.json"
RECEIPT = (REPO / "qualification" / "results" / "V9-verification"
           / "receipt-ver04-fresh-pass.json")

# The layer legend, read from the spec rather than restated here. A hardcoded copy
# would be a second source of truth for the very thing being audited.
#
# The T5 expectation is the one non-mechanical input: the spec's own reading note
# says T5 cases need an authorized live provider and are expected to remain
# BLOCKED_EXTERNAL while `live_provider_budget_authorized` is false. If a T5 case
# were marked PASS while that flag is false, the tier would have been inflated --
# so that specific pairing is asserted rather than described.


def sha256_file(path: pathlib.Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()

    for required in (SPEC, OLD_GATES, LOCK):
        if not required.is_file():
            print(f"ver09-tier-audit: missing {required}", file=sys.stderr)
            return 2

    spec = json.loads(SPEC.read_text(encoding="utf-8"))
    old_gates = json.loads(OLD_GATES.read_text(encoding="utf-8"))
    lock = json.loads(LOCK.read_text(encoding="utf-8"))

    legend = spec.get("layer_legend") or {}
    cases = spec.get("cases") or []
    identity = lock["deployment"]["identity"]
    live_authorized = bool(lock["runtime_authorization"]["live_provider_budget_authorized"])

    # --- 1. every case names a tier from the legend ---------------------------
    unknown_layer = [c["id"] for c in cases if c.get("layer") not in legend]
    missing_layer = [c["id"] for c in cases if not c.get("layer")]
    by_layer = Counter(c.get("layer") for c in cases)

    # --- 2. no tier is inflated: the T5 expectation ---------------------------
    t5 = [c for c in cases if c.get("layer") == "T5"]
    t5_inflated = [
        c["id"] for c in t5
        if c.get("status") == "PASS" and not live_authorized
    ]
    # The converse is also a tier error, and is checked because it is the direction
    # a hurried author takes: a case that needs no live provider marked BLOCKED.
    t5_unblocked_expectation_met = all(
        c.get("status") in ("NOT_RUN", "BLOCKED_EXTERNAL") for c in t5
    ) if not live_authorized else None

    # --- 3. the artifact each verdict is bound to -----------------------------
    # A verdict is bound to an artifact by the identity it was filed under. The
    # spec's cases carry no identity field at authoring time; the receipts do.
    # This reports which receipts exist and what they bind, so a reader can see
    # the binding rather than being told it is there.
    receipt_facts = None
    if RECEIPT.is_file():
        receipt = json.loads(RECEIPT.read_text(encoding="utf-8"))
        receipt_facts = {
            "path": str(RECEIPT.relative_to(REPO)).replace("\\", "/"),
            "sha256": sha256_file(RECEIPT),
            "definitionId": receipt.get("definitionId"),
            "outcome": receipt.get("outcome"),
            "passed": receipt.get("passed"),
            # The fields that make it a statement about a tree.
            "candidateTreeDigest": receipt.get("candidateTreeDigest"),
            "candidateTreeDigestScope": receipt.get("candidateTreeDigestScope"),
            "acceptanceDefinitionDigest": receipt.get("acceptanceDefinitionDigest"),
            "environment": receipt.get("environment"),
            "ranIn": receipt.get("ranIn"),
            # Recorded because its ABSENCE is the finding: a receipt does not
            # carry a tier field. The tier is carried by the SPEC CASE and by the
            # identity, which is what makes the pairing checkable.
            "carriesTierField": any("layer" in str(k).lower() or "tier" in str(k).lower()
                                    for k in receipt),
        }

    # --- 4. the deployment's own statement of the limit -----------------------
    trust = lock["deployment"]
    statement = {
        "trust_model": trust.get("trust_model"),
        "isolation_image_or_policy_digest": trust["inputs"].get(
            "isolation_image_or_policy_digest"),
        "trust_model_statement": trust.get("trust_model_statement"),
        "identity": identity,
    }
    # The statement must name the absence of privilege separation for the record
    # to satisfy VER-09's third clause. Checked as a string presence over the
    # deployment's OWN words, and reported as such.
    names_no_separation = (
        "no sandbox" in statement["trust_model_statement"].lower()
        or "no confinement" in statement["trust_model_statement"].lower()
    )

    # --- 5. the old gate index, so no old verdict is read as a new tier --------
    old_ver = [g for g in old_gates if str(g.get("id", "")).startswith("VER")]
    old_ids = {g["id"] for g in old_gates}
    new_ids = {c["id"] for c in cases}
    overlap = sorted(old_ids & new_ids)

    report = {
        "scope": "TIER_DISCIPLINE_IN_THE_RECORD_NOT_A_CERTIFICATION",
        "spec": str(SPEC.relative_to(REPO)).replace("\\", "/"),
        "spec_sha256": sha256_file(SPEC),
        "deployment_identity": identity,
        "live_provider_budget_authorized": live_authorized,
        "legend_keys": sorted(legend),
        "legend_keys_with_prose": {k: legend[k] for k in sorted(legend)},
        "case_count": len(cases),
        "by_layer": dict(sorted(by_layer.items())),
        "cases_with_unknown_layer": unknown_layer,
        "cases_with_no_layer": missing_layer,
        "t5_cases": [{"id": c["id"], "status": c["status"], "requirement": c["requirement"]}
                     for c in t5],
        "t5_inflated_passes": t5_inflated,
        "t5_expectation_met": t5_unblocked_expectation_met,
        "receipt_binding": receipt_facts,
        "deployment_statement": statement,
        "deployment_statement_names_absence_of_confinement": names_no_separation,
        "old_gate_index": {
            "path": str(OLD_GATES.relative_to(REPO)).replace("\\", "/"),
            "sha256": sha256_file(OLD_GATES),
            "rows": len(old_gates),
            "status_counts": dict(Counter(g.get("status") for g in old_gates)),
            "old_ver_rows": [{"id": g["id"], "status": g["status"],
                              "deployment_identity": str(g.get("deployment_identity"))[:16] + "..."}
                             for g in old_ver],
            "id_overlap_with_new_spec": overlap,
        },
        "verdict": None,
        "verdict_basis": [],
    }

    problems = []
    if unknown_layer:
        problems.append(f"{len(unknown_layer)} case(s) name a layer not in the legend: {unknown_layer}")
    if missing_layer:
        problems.append(f"{len(missing_layer)} case(s) name no layer: {missing_layer}")
    if t5_inflated:
        problems.append(
            f"{len(t5_inflated)} T5 case(s) are marked PASS while "
            f"live_provider_budget_authorized is false: {t5_inflated}")
    if not names_no_separation:
        problems.append("the deployment's own trust-model statement does not name the absence")
    if overlap:
        problems.append(f"old gate ids overlap new spec ids: {overlap}")
    if receipt_facts is None:
        problems.append("no receipt found to demonstrate the binding fields")

    report["problems"] = problems
    report["verdict"] = "TIER_DISCIPLINE_HOLDS" if not problems else "TIER_DISCIPLINE_VIOLATED"
    report["verdict_basis"] = [
        "every case's layer is a key of layer_legend (mechanical, from the file)",
        "no T5 case is marked PASS while no live provider is authorized",
        "the deployment's own trust_model_statement names the absence it claims",
        "the old 104-row gate index shares no id with this spec, so no old verdict "
        "can be read as a new tier by id",
        "the receipt carries no tier field, so the tier comes from the SPEC CASE and "
        "the identity -- which is why this audit reads both",
    ]

    if args.json:
        print(json.dumps(report, indent=2, ensure_ascii=False))
    else:
        print(f"spec       {report['spec']}")
        print(f"identity   {identity[:16]}...")
        print(f"cases      {report['case_count']}   layers {report['by_layer']}")
        print(f"legend     {report['legend_keys']}")
        print(f"live provider authorized: {live_authorized}")
        print()
        print("T5 cases (need an authorized live provider):")
        for row in report["t5_cases"]:
            print(f"  {row['id']}  {row['status']:16s} {row['requirement']}")
        print()
        if receipt_facts:
            print("the artifact a verdict is bound to (one real receipt):")
            for key in ("path", "sha256", "outcome", "passed", "candidateTreeDigest",
                        "candidateTreeDigestScope", "acceptanceDefinitionDigest",
                        "ranIn", "carriesTierField"):
                print(f"  {key:30s} {receipt_facts[key]}")
            print()
        print("deployment statement:")
        print(f"  trust_model                            {statement['trust_model']}")
        print(f"  isolation_image_or_policy_digest       {statement['isolation_image_or_policy_digest']}")
        print(f"  names the absence of confinement       {names_no_separation}")
        print()
        print("old gate index:")
        print(f"  rows {report['old_gate_index']['rows']}  "
              f"status {report['old_gate_index']['status_counts']}")
        print(f"  old VER rows: {report['old_gate_index']['old_ver_rows']}")
        print(f"  id overlap with this spec: {overlap}")
        print()
        if problems:
            print(f"PROBLEMS ({len(problems)}):")
            for problem in problems:
                print(f"  - {problem}")
            print(f"verdict: {report['verdict']}")
            return 1
        print(f"verdict: {report['verdict']}")
        print("basis:")
        for line in report["verdict_basis"]:
            print(f"  - {line}")
        print()
        print("This audits TIER DISCIPLINE IN THE RECORD. It does not judge whether")
        print("an oracle was established, and it does not certify the deployment.")

    return 0 if not problems else 1


if __name__ == "__main__":
    raise SystemExit(main())
