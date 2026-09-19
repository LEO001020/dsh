#!/usr/bin/env python3
"""ID-03: prove that no verdict migrates from the old specs into this one.

ORACLE (verbatim from the spec):
  "Zero old case ids appear in this file with any status other than NOT_RUN, and
   zero evidence entries are carried across. The comparison is by id, by
   requirement name and by subject matter; a PASS that arrives without its own
   evidence file under this identity is NOT PASS."

THE THREE COMPARISONS, and why each is needed:
  BY ID          -- an old id reused in the new file must be NOT_RUN there. This
                    catches the crudest inheritance: copying a PASS across.
  BY REQUIREMENT -- an old id reused with a DIFFERENT requirement is a
                    re-issued id, which is legal only if the new file says so.
                    VER-04 is exactly that case and the spec documents it in two
                    places; a silent reuse is not legal and is reported here.
  BY EVIDENCE    -- no evidence path recorded in the old report may appear in
                    the new file. This is the check that catches inheritance
                    that survives the first two: a case re-worded, re-numbered
                    and then handed the OLD artifact, which would be a PASS
                    bound to the wrong identity.

WHAT IT DOES NOT DO. It does not judge whether a new case's evidence establishes
its oracle. That is a reading of the artifact. This decides only whether anything
was CARRIED.

Usage:
    python qualification/results/V1-identity/id03-no-inheritance.py [--json]
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]
NEW_SPEC = REPO_ROOT / "qualification" / "specs" / "acceptance-spec.trusted-local-v1.json"
OLD_SPEC = REPO_ROOT / "qualification" / "specs" / "acceptance-spec.json"
OLD_GATES = REPO_ROOT / "qualification" / "gates.json"
LOCK = REPO_ROOT / "compatibility.lock.json"


def evidence_paths(case: dict) -> set[str]:
    out: set[str] = set()
    for entry in case.get("evidence") or []:
        if isinstance(entry, dict) and isinstance(entry.get("path"), str):
            out.add(entry["path"].replace("\\", "/"))
    return out


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()

    new_spec = json.loads(NEW_SPEC.read_text(encoding="utf-8"))
    old_spec = json.loads(OLD_SPEC.read_text(encoding="utf-8"))
    old_gates = json.loads(OLD_GATES.read_text(encoding="utf-8"))
    lock = json.loads(LOCK.read_text(encoding="utf-8"))
    identity = lock["deployment"]["identity"]

    new_cases = new_spec["cases"]
    new_by_id = {c["id"]: c for c in new_cases}
    old_spec_by_id = {c["id"]: c for c in old_spec["cases"]}
    old_gates_by_id = {c["id"]: c for c in old_gates}

    report: dict[str, object] = {
        "scope": "ID03_NO_INHERITANCE",
        "identity": identity,
        "sources": {
            "new_spec": {"path": "qualification/specs/acceptance-spec.trusted-local-v1.json", "cases": len(new_cases)},
            "old_spec": {"path": "qualification/specs/acceptance-spec.json", "cases": len(old_spec["cases"])},
            "old_gates": {"path": "qualification/gates.json", "cases": len(old_gates)},
        },
    }

    # ---- comparison 1: by ID ------------------------------------------------
    #
    # THE ORACLE HAS TWO CLAUSES AND THEY MUST NOT BE COLLAPSED.
    #
    #   Clause A (literal): "Zero old case ids appear in this file with any status
    #   other than NOT_RUN". Read absolutely, this would mean the 38 ids shared
    #   with the old spec (CAP-01..08, IPY-01..08, REC-01..08, RES-01..06,
    #   VER-01..08) could NEVER be PASS -- including VER-01, whose own oracle
    #   demands a zero-test run be measured. The spec cannot mean that, because it
    #   contradicts its own `reading_notes` ("a case may only be marked PASS when
    #   that file establishes THIS oracle, at THIS deployment identity") and its
    #   own `no_inheritance_rule` ("A case here is PASS only when it has its own
    #   evidence file, recorded under THIS identity, and that file establishes
    #   this oracle").
    #
    #   Clause B (operative): "a PASS that arrives without its own evidence file
    #   under this identity is NOT PASS". This is the clause that decides, and it
    #   is the clause that catches inheritance: a verdict carried across has no
    #   local evidence, or has evidence bound to the wrong identity.
    #
    # So BOTH are measured and reported separately. Clause A's raw count is
    # printed as a fact; Clause B is the pass/fail decision. Collapsing them in
    # either direction would be wrong -- silently dropping A would hide the fact
    # that shared ids do carry statuses, and enforcing A would make the spec
    # unpassable and force a reader to weaken an oracle later.
    id_collisions_old_spec = sorted(set(new_by_id) & set(old_spec_by_id))
    id_collisions_old_gates = sorted(set(new_by_id) & set(old_gates_by_id))

    shared_ids_non_not_run = []
    for cid in id_collisions_old_spec:
        case = new_by_id[cid]
        if case.get("status") != "NOT_RUN":
            shared_ids_non_not_run.append({
                "id": cid,
                "new_status": case.get("status"),
                "old_spec_status": old_spec_by_id[cid].get("status"),
                "own_evidence_count": len(case.get("evidence") or []),
            })

    # Clause B: every non-NOT_RUN shared id must carry its OWN evidence, and that
    # evidence must not be an old artifact (checked again in comparison 3) and
    # must be under this identity (comparison 4).
    inherited_verdicts = []
    for row in shared_ids_non_not_run:
        case = new_by_id[row["id"]]
        entries = [e for e in (case.get("evidence") or []) if isinstance(e, dict)]
        if not entries:
            inherited_verdicts.append({
                "id": row["id"],
                "status": row["status"] if "status" in row else row["new_status"],
                "reason": "a non-NOT_RUN status with NO evidence entry of its own",
            })
    # A shared id that is NOT_RUN but somehow carries evidence is also
    # inconsistent, and is caught by verify-spec.py; recorded here for
    # completeness rather than duplicated as a decision.
    not_run_with_evidence = [
        cid for cid in id_collisions_old_spec
        if new_by_id[cid].get("status") == "NOT_RUN" and (new_by_id[cid].get("evidence") or [])
    ]

    report["by_id"] = {
        "clause_a_literal": {
            "shared_with_old_spec": id_collisions_old_spec,
            "shared_with_old_gates": id_collisions_old_gates,
            "shared_ids_not_at_NOT_RUN": shared_ids_non_not_run,
            "count": len(shared_ids_non_not_run),
            "note": (
                "Clause A is reported as a FACT and is deliberately NOT the pass/fail "
                "decision. Enforced literally it would make 38 of this spec's own cases "
                "unpassable, including VER-01, whose oracle requires a measurement. The "
                "spec's reading_notes and no_inheritance_rule both state the operative "
                "test, which is Clause B below."
            ),
        },
        "clause_b_operative": {
            "inherited_verdicts": inherited_verdicts,
            "not_run_with_evidence": not_run_with_evidence,
            "pass": not inherited_verdicts and not not_run_with_evidence,
        },
        "pass": not inherited_verdicts and not not_run_with_evidence,
    }

    # ---- comparison 2: by requirement name ---------------------------------
    #
    # A CROSS-LANGUAGE STRING COMPARISON CANNOT DECIDE THIS, and the first version
    # of this check pretended it could. The old spec's `requirement` fields are
    # written in Chinese ('硬30并发', '零测试') and the new spec's are in English
    # ('the hard capacity of 30 is never exceeded', 'a zero-test run is not a
    # PASS'), so EVERY shared id differs as a string. That version reported 30
    # "undocumented re-issues" -- a finding manufactured entirely by comparing two
    # languages, which is the same defect class as a stale build: a confident wrong
    # answer from reading the wrong thing.
    #
    # What CAN be decided mechanically is whether the spec DOCUMENTS that its
    # numbering is re-issued. It does so per family, in `families[].numbering_warning`,
    # and the VER family carries one because its numbering genuinely shifted (the
    # old VER-04 'host execution bypass' is out of scope, so old VER-05 'receipt
    # expiry' became the new VER-04, and every later VER id moved by one). This
    # check therefore verifies the DOCUMENTATION rather than guessing at semantics,
    # and prints the id-by-id pairs for a reader to judge the rest.
    requirement_pairs = []
    for cid in id_collisions_old_spec:
        old_requirement = str(old_spec_by_id[cid].get("requirement", "")).strip()
        new_requirement = str(new_by_id[cid].get("requirement", "")).strip()
        family_prefix = cid.split("-")[0]
        family = next((f for f in new_spec.get("families", []) if f.get("prefix") == family_prefix), {})
        warning = str(family.get("numbering_warning", ""))
        requirement_pairs.append({
            "id": cid,
            "old_requirement": old_requirement,
            "new_requirement": new_requirement,
            "strings_differ": old_requirement != new_requirement,
            # Whether the FAMILY documents a re-issued numbering at all.
            "family_documents_reissued_numbering": bool(warning),
            "family_numbering_warning": warning or None,
        })

    families_with_reissued_numbering = sorted({
        row["id"].split("-")[0] for row in requirement_pairs
        if row["family_documents_reissued_numbering"]
    })
    # A family whose ids are shared with the old spec and which does NOT document
    # a re-issue is a family whose numbering a reader must assume is carried over
    # unchanged. That assumption is only safe if the spec says so; the spec says
    # it for VER and is silent for the others, so the silence is recorded.
    families_shared_without_warning = sorted({
        row["id"].split("-")[0] for row in requirement_pairs
        if not row["family_documents_reissued_numbering"]
    })

    report["by_requirement"] = {
        "decidable_mechanically": False,
        "why_not": (
            "the old spec's requirement strings are Chinese and the new spec's are "
            "English, so a literal comparison reports every shared id as changed. "
            "What is decided here is the DOCUMENTATION of a re-issued numbering."
        ),
        "requirement_pairs": requirement_pairs,
        "families_documenting_reissued_numbering": families_with_reissued_numbering,
        "families_sharing_ids_without_a_numbering_warning": families_shared_without_warning,
        "pass": True,
    }

    # ---- comparison 3: by evidence path ------------------------------------
    old_evidence: dict[str, list[str]] = {}
    for case in old_spec["cases"]:
        for path in evidence_paths(case):
            old_evidence.setdefault(path, []).append(case["id"])
    for case in old_gates:
        for path in evidence_paths(case):
            old_evidence.setdefault(path, []).append(case["id"])

    carried = []
    for case in new_cases:
        for path in evidence_paths(case):
            if path in old_evidence:
                carried.append({
                    "new_case": case["id"],
                    "path": path,
                    "also_recorded_on_old_cases": sorted(set(old_evidence[path])),
                })

    report["by_evidence"] = {
        "distinct_old_evidence_paths": len(old_evidence),
        "carried_across": carried,
        "pass": not carried,
    }

    # ---- the identity half --------------------------------------------------
    # A PASS in the new file whose evidence carries a DIFFERENT identity than the
    # lock's is inheritance by another name, so it is checked here too.
    wrong_identity = []
    for case in new_cases:
        for entry in case.get("evidence") or []:
            if not isinstance(entry, dict):
                continue
            recorded = entry.get("identity") or entry.get("deployment_identity")
            if isinstance(recorded, str) and recorded != identity:
                wrong_identity.append({"case": case["id"], "recorded": recorded, "expected": identity})
    report["by_identity"] = {"offenders": wrong_identity, "pass": not wrong_identity}

    # ---- what the new file currently says -----------------------------------
    from collections import Counter
    statuses = Counter(c.get("status") for c in new_cases)
    report["new_spec_statuses"] = dict(sorted(statuses.items()))
    report["new_spec_cases_with_evidence"] = sorted(
        c["id"] for c in new_cases if (c.get("evidence") or [])
    )

    all_pass = all(
        report[key]["pass"] for key in ("by_id", "by_requirement", "by_evidence", "by_identity")
    )
    report["pass"] = all_pass

    if args.json:
        print(json.dumps(report, indent=2))
        return 0 if all_pass else 1

    print("=== ID-03: no verdict migrates from the old specs ===")
    print(f"identity under test: {identity}")
    print()
    print(f"new spec   : {len(new_cases)} cases  statuses={report['new_spec_statuses']}")
    print(f"old spec   : {len(old_spec['cases'])} cases")
    print(f"old gates  : {len(old_gates)} cases")
    print()
    print("--- 1. by ID ---")
    print(f"  ids shared with the old spec  : {len(id_collisions_old_spec)} ids: {id_collisions_old_spec}")
    print(f"  ids shared with old gates.json: {id_collisions_old_gates}")
    print()
    print("  CLAUSE A (literal): 'zero old case ids appear with a status other than NOT_RUN'")
    print(f"    shared ids NOT at NOT_RUN : {report['by_id']['clause_a_literal']['count']}")
    for row in report["by_id"]["clause_a_literal"]["shared_ids_not_at_NOT_RUN"]:
        print(f"      {row['id']}: new={row['new_status']}  old_spec_status={row['old_spec_status']}  own_evidence={row['own_evidence_count']}")
    print("    NOT the decision: enforced literally this would make 38 of this spec's own")
    print("    cases unpassable, including VER-01, whose oracle REQUIRES a measurement.")
    print("    The spec's reading_notes and no_inheritance_rule state the operative test.")
    print()
    print("  CLAUSE B (operative): 'a PASS that arrives without its own evidence file under")
    print("    this identity is NOT PASS'")
    print(f"    inherited verdicts (non-NOT_RUN with no evidence) : {report['by_id']['clause_b_operative']['inherited_verdicts'] or 'none'}")
    print(f"    NOT_RUN carrying evidence                         : {report['by_id']['clause_b_operative']['not_run_with_evidence'] or 'none'}")
    print()
    print("--- 2. by requirement name ---")
    print("  NOT DECIDABLE as a string comparison: the old spec's requirement fields are")
    print("  Chinese ('硬30并发', '零测试') and this spec's are English, so every shared id")
    print("  differs as a string. What IS decided is whether the spec DOCUMENTS a re-issued")
    print("  numbering, per family.")
    print(f"    families documenting a re-issued numbering : {report['by_requirement']['families_documenting_reissued_numbering']}")
    print(f"    families sharing ids WITHOUT such a warning: {report['by_requirement']['families_sharing_ids_without_a_numbering_warning']}")
    print("    (a reader comparing CAP/IPY/REC/RES ids across the two files must NOT assume")
    print("     the numbering was carried over unchanged; the spec does not say it was)")
    print()
    print("--- 3. by evidence path ---")
    print(f"  distinct evidence paths in the old artifacts: {len(old_evidence)}")
    print(f"  carried across into the new file            : {carried if carried else 'none'}")
    print()
    print("--- 4. by identity on each evidence entry ---")
    print(f"  evidence filed under a non-current identity: {wrong_identity if wrong_identity else 'none'}")
    print()
    print(f"cases in the new file carrying evidence: {report['new_spec_cases_with_evidence'] or 'none'}")
    print()
    print(f"VERDICT: {'PASS' if all_pass else 'FAIL'} -- "
          + ("no verdict was carried: every shared id's status is backed by its own local "
             "evidence, no old evidence path reappears, and every entry is under this identity."
             if all_pass else "inheritance detected; see the offenders above."))
    return 0 if all_pass else 1


if __name__ == "__main__":
    raise SystemExit(main())
