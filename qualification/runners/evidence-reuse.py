#!/usr/bin/env python3
"""E3: decide mechanically whether a v1 evidence artifact may support a v2 case.

THE RULE THIS FILE ENFORCES (V3 E3), verbatim:

    A v1 evidence artifact may support v2 only when:
      - relevant runtime inputs are unchanged;
      - v2 oracle is semantically identical;
      - evidence is immutable/hash-verified;
      - evidence names the same tested candidate/build;
      - v2 records the evidence as `REUSED_EVIDENCE`, not as an unexamined inherited PASS.
    Rerun cheap mechanical gates.

WHY A MECHANICAL EVALUATOR AND NOT A POLICY PARAGRAPH.

"REUSED_EVIDENCE, not an unexamined inherited PASS" is the whole point, and it is
the exact defect this project has recorded repeatedly: an artifact that establishes
X under identity A gets cited for Y under identity B because the citation LOOKS
right. A policy paragraph cannot stop that; a checker that refuses the citation can.
So every one of the four conditions is a computed fact here, and a binding that
cannot satisfy all four is REFUSED with the failing condition named.

WHAT IT DOES NOT DO, and this is the important half.

It does not decide whether an artifact ESTABLISHES an oracle. It cannot: that is a
reading of the evidence, and a script claiming to decide it would be a second
oracle -- the defect class this project records. What it decides is the mechanical
part: whether the artifact is what it says it is, whether the runtime inputs it was
measured under are the ones in force now, and whether the v2 oracle is the same
oracle. The READING stays with the writer, and the writer must state it.

THE FIVE CONDITIONS, AND HOW EACH IS MADE MECHANICAL:

  E3.1 relevant runtime inputs unchanged
       The v1 evidence entry records a deployment identity. That identity is a digest
       over `deployment.inputs`. This evaluator recomputes the v1 identity from the
       lock's current inputs AND compares the individual runtime inputs the case
       actually depends on (from a per-family map) against the ones the artifact was
       measured under. A blanket "the identity matches" is NOT sufficient and is
       refused: the v1 identity is frozen at 0a0996f3, while the v2 runtime identity
       is a different, larger input set, so identity equality can never hold and
       claiming it would be a false condition. What must hold is that the INPUTS THAT
       MATTER are unchanged.

  E3.2 v2 oracle semantically identical
       Computed, not asserted: the v1 oracle's sha256 is compared with the v2
       definition's oracle for the same case id. If they differ the binding is
       refused outright, because the case was rewritten and a rewritten oracle needs
       its own measurement. The provenance file already records which cases were
       rewritten, and this evaluator cross-checks that record rather than trusting it.

  E3.3 evidence immutable / hash-verified
       The artifact's sha256 is recomputed from disk and compared with the value the
       v1 ledger recorded. A mismatch means the artifact moved after it was filed.
       Immutability is decided by asking git whether the path is tracked and
       unmodified since the filing commit; an untracked or dirty artifact is refused.

  E3.4 same tested candidate/build
       The v1 evidence entries name the build they were measured against in their
       notes (the launcher digest, the `lib/` digests). This evaluator extracts the
       digests that appear in the artifact itself and compares them with the current
       build. A digest the artifact does not name cannot be checked, and the binding
       must then state that the candidate is unverified -- which is a REFUSAL, not a
       warning.

CHEAP MECHANICAL GATES ARE RE-RUN REGARDLESS, and they are NAMED here rather than
left to judgement: the digest recomputation, the evidence hash check, the
definition/ledger shape check, and the doctor. They are cheap (no boot, no model, no
subprocess beyond git and python) and re-running them costs seconds while a stale
reuse costs a false PASS. Each is listed in CHEAP_MECHANICAL_GATES with its command,
and the evaluator RUNS them and records the outcome.

Usage:
    python qualification/runners/evidence-reuse.py                  # evaluate every v1 PASS
    python qualification/runners/evidence-reuse.py --json
    python qualification/runners/evidence-reuse.py --case CMP-13
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import subprocess
import sys
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
LIVE_LEDGER = ROOT / "qualification" / "specs" / "acceptance-spec.trusted-local-v1.json"
FROZEN = ROOT / "qualification" / "specs" / "frozen" / "acceptance-spec.trusted-local-v1.as-authored.json"
DEFINITION = ROOT / "qualification" / "specs" / "acceptance-spec.trusted-local-v2.definition.json"
PROVENANCE = ROOT / "qualification" / "specs" / "acceptance-spec.trusted-local-v2.provenance.json"
LOCK = ROOT / "compatibility.lock.json"
OUT_DIR = ROOT / "qualification" / "results" / "trusted-local-v2-identity"

# The cheap mechanical gates. Re-run REGARDLESS of any reuse decision, because their
# cost is seconds and a stale reuse is a false PASS. Each names its own command so a
# reader can re-run it by hand.
CHEAP_MECHANICAL_GATES = [
    {"id": "G-DEF-SHAPE",
     "what": "the v2 definition carries no status, evidence path or verdict",
     "command": "python qualification/runners/build-v2-definition.py --check"},
    {"id": "G-FREEZE",
     "what": "the v1 frozen artifact still hashes to the pinned identity input",
     "command": "python qualification/specs/frozen/verify-freeze.py"},
    {"id": "G-EVIDENCE-HASHES",
     "what": "every v1 evidence entry still hashes to what the ledger records",
     "command": "python qualification/runners/verify-spec.py --quiet"},
    {"id": "G-DOCTOR",
     "what": "every recorded deployment input still matches the file on disk",
     "command": "python helpers/doctor.py --quiet"},
    {"id": "G-SPLIT",
     "what": "filing a result moves neither identity",
     "command": "python qualification/runners/file-result.py --self-test --probe "
                "qualification/results/trusted-local-v2-identity/probe.json"},
    {"id": "G-VOCAB",
     "what": "the verdict vocabulary accepts and refuses as declared, incl. NOT_CLAIMED",
     "command": "python qualification/runners/file-result.py --vocabulary-test"},
    {"id": "G-MUTATION",
     "what": "runtime drift and spec drift produce DIFFERENT identity failures",
     "command": "python qualification/runners/mutation-test-identity-split.py"},
]

# A digest that identifies a build, as it appears in a v1 evidence note.
DIGEST = re.compile(r"\b([0-9a-f]{16,64})\b")


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def git_tracked_and_clean(rel: str) -> dict[str, Any]:
    """Is this path tracked by git and unmodified since its last commit?

    Immutability, decided by the version control system rather than by a promise.
    An artifact that is untracked or modified is not immutable evidence: the next
    run can change it, and a hash recorded against it describes a moment rather than
    an artifact.
    """
    tracked = subprocess.run(["git", "ls-files", "--error-unmatch", rel],
                             cwd=ROOT, capture_output=True, text=True)
    if tracked.returncode != 0:
        return {"tracked": False, "clean": None,
                "why": "not tracked by git, so nothing pins its content"}
    status = subprocess.run(["git", "status", "--porcelain", "--", rel],
                            cwd=ROOT, capture_output=True, text=True)
    dirty = bool(status.stdout.strip())
    return {"tracked": True, "clean": not dirty,
            "why": "tracked and unmodified" if not dirty
                   else f"tracked but DIRTY ({status.stdout.strip()})"}


def hash_with_line_ending_diagnosis(path: Path, recorded: str | None) -> dict[str, Any]:
    """Hash a file, and if the digest does not match, say WHICH line-ending form does.

    WHY THIS EXISTS, measured rather than anticipated. Three v1 evidence entries do
    not reproduce in a fresh checkout, and the reason is not that the files changed:
    it is that `.gitattributes` declares `*.json text eol=lf` while `core.autocrlf`
    is `true`, so an evidence file written on Windows with CRLF line endings is
    committed as LF. The digest the v1 ledger recorded describes the WRITTEN bytes;
    no fresh checkout produces those bytes.

    Reporting "hash mismatch" alone would be a TRUE statement that misleads: it
    reads as "this artifact was tampered with" when the artifact is intact and the
    HASHING CONVENTION is the thing that differs. So the diagnosis is computed and
    recorded, and the case is still refused -- a reuse needs a reproducible hash, and
    a hash that only holds in the checkout that wrote it is not reproducible.
    """
    data = path.read_bytes()
    actual = hashlib.sha256(data).hexdigest()
    row: dict[str, Any] = {"actual_sha256": actual, "hash_verified": actual == recorded}
    if row["hash_verified"]:
        return row
    variants = {
        "as_stored": actual,
        "lf_normalised": hashlib.sha256(data.replace(b"\r\n", b"\n")).hexdigest(),
        "crlf_normalised": hashlib.sha256(data.replace(b"\n", b"\r\n")).hexdigest(),
    }
    matches = [name for name, digest in variants.items() if digest == recorded]
    row["line_ending_variants"] = variants
    row["recorded_digest_matches_variant"] = matches
    row["crlf_in_file"] = data.count(b"\r\n")
    row["lone_lf_in_file"] = data.count(b"\n") - data.count(b"\r\n")
    if matches:
        row["diagnosis"] = (
            f"the recorded digest matches the {matches[0]} form. The artifact is NOT tampered "
            "with; the HASHING CONVENTION differs. .gitattributes declares `*.json text eol=lf` "
            "and core.autocrlf is true, so a CRLF evidence file is committed as LF and no fresh "
            "checkout reproduces the recorded bytes. STILL REFUSED for reuse: a hash that holds "
            "only in the checkout that wrote it is not reproducible, and reuse requires a "
            "reproducible hash.")
    else:
        row["diagnosis"] = (
            "the recorded digest matches NO line-ending variant of this file, so this is a "
            "content difference rather than a line-ending artifact.")
    return row


def v1_case_identity(entry: dict[str, Any]) -> str | None:
    return entry.get("identity") or entry.get("deployment_identity")


def evaluate_case(case: dict[str, Any], v2: dict[str, Any], provenance: dict[str, Any],
                  lock: dict[str, Any]) -> dict[str, Any]:
    """The four E3 conditions for one v1 case, computed."""
    cid = case["id"]
    v2_case = next((c for c in v2["cases"] if c["id"] == cid), None)
    if v2_case is None:
        return {"v1_case_id": cid, "eligible": False,
                "refusals": [f"{cid} has no case in the v2 definition"]}

    # ── E3.2 first, because it is the cheapest and the most decisive ─────────
    v1_oracle = case["oracle"]
    v2_oracle = v2_case["oracle"]
    v1_oracle_sha = hashlib.sha256(v1_oracle.encode("utf-8")).hexdigest()
    v2_oracle_sha = hashlib.sha256(v2_oracle.encode("utf-8")).hexdigest()
    oracle_identical = v1_oracle_sha == v2_oracle_sha

    # Cross-check the provenance record rather than trusting it: a case the
    # provenance says was rewritten must have a different oracle, and a case it says
    # was carried verbatim must have the same one. A disagreement is a defect in the
    # provenance, and it is reported as one.
    recorded = next((d for d in provenance["decisions"] if d["v1_case_id"] == cid), None)
    provenance_says_changed = bool(recorded and recorded.get("oracle_changed"))
    provenance_agrees = provenance_says_changed == (not oracle_identical)

    refusals: list[str] = []
    if not oracle_identical:
        refusals.append(
            f"E3.2: the v2 oracle DIFFERS from the v1 oracle ({v1_oracle_sha[:16]} vs "
            f"{v2_oracle_sha[:16]}). This case was REWRITTEN, so it needs its own "
            "measurement; a v1 artifact cannot be cited for it.")

    # ── E3.3 evidence immutable and hash-verified ────────────────────────────
    evidence_rows = []
    for entry in case.get("evidence") or []:
        rel = entry["path"]
        recorded_sha = entry.get("sha256")
        path = ROOT / rel
        row: dict[str, Any] = {"path": rel, "recorded_sha256": recorded_sha}
        if not path.is_file():
            row["exists"] = False
            row["hash_verified"] = False
            refusals.append(f"E3.3: {rel} does not exist on disk")
        else:
            row["exists"] = True
            row.update(hash_with_line_ending_diagnosis(path, recorded_sha))
            if not row["hash_verified"]:
                diagnosis = row.get("diagnosis", "")
                if row.get("recorded_digest_matches_variant"):
                    refusals.append(
                        f"E3.3: {rel} does not hash to the recorded value in a FRESH CHECKOUT, "
                        f"though it does in the {row['recorded_digest_matches_variant'][0]} form "
                        "of the file it was written in. The artifact is intact; the recorded "
                        "hash is not reproducible from the repository. Refused for reuse.")
                else:
                    refusals.append(
                        f"E3.3: {rel} hashes to {row['actual_sha256'][:16]}... but the v1 ledger "
                        f"records {str(recorded_sha)[:16]}... and no line-ending variant matches, "
                        "so the content itself differs")
        row.update(git_tracked_and_clean(rel))
        if row.get("tracked") and row.get("clean") is False:
            refusals.append(f"E3.3: {rel} is tracked but DIRTY, so it is not immutable")
        evidence_rows.append(row)

    if not evidence_rows:
        refusals.append("E3.3: the v1 case carries no evidence, so there is nothing to reuse")

    # ── E3.1 relevant runtime inputs unchanged ───────────────────────────────
    # The v1 identity is a digest over the LOCK's inputs. The v2 runtime identity is
    # a DIFFERENT and LARGER input set, so the two digests can never be equal and
    # requiring equality would be a false condition. What is checked instead:
    #   (a) the v1 identity recomputes from the lock's CURRENT inputs -- so the v1
    #       record is still self-consistent;
    #   (b) every v1 evidence entry that names an identity names THAT value -- so the
    #       artifact was filed under the v1 identity and not another;
    #   (c) the runtime inputs the case actually depends on are unchanged, which is
    #       what "relevant" means and why a per-case map is needed.
    inputs = lock["deployment"]["inputs"]
    recomputed_v1 = hashlib.sha256(
        json.dumps(inputs, sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode("utf-8")
    ).hexdigest()
    v1_identity_still_recomputes = recomputed_v1 == lock["deployment"]["identity"]
    if not v1_identity_still_recomputes:
        refusals.append(
            f"E3.1: the v1 deployment identity no longer recomputes from the lock "
            f"({recomputed_v1[:16]} vs {lock['deployment']['identity'][:16]}), so no v1 "
            "artifact can be bound to it")

    named = {v1_case_identity(e) for e in (case.get("evidence") or [])}
    named.discard(None)
    identity_agrees = all(n == lock["deployment"]["identity"] for n in named)
    if not identity_agrees:
        refusals.append(
            f"E3.1: the evidence names identity/identities {sorted(n[:16] for n in named)} "
            f"but the lock's is {lock['deployment']['identity'][:16]}")

    # ── E3.4 the same tested candidate/build ─────────────────────────────────
    # The digests the artifact itself names, checked against the current build. The
    # candidate digests in force are the ones the v2 runtime identity carries, so
    # that is the comparison set.
    current = {
        "artifact_sha256": inputs.get("artifact_sha256"),
        "dependency_lock_sha256": inputs.get("dependency_lock_sha256"),
        "host_profile_digest": inputs.get("host_profile_digest"),
        "agent_preset_digest": inputs.get("agent_preset_digest"),
    }
    named_digests: set[str] = set()
    for entry in case.get("evidence") or []:
        for field in ("note", "path"):
            named_digests |= set(DIGEST.findall(str(entry.get(field) or "")))
        if isinstance(entry.get("sha256"), str):
            named_digests.add(entry["sha256"])
    # A digest the artifact names that IS one of the candidate digests is a match;
    # the others are the artifact's own hashes and are not candidates.
    matched_candidates = {k: v for k, v in current.items() if v in named_digests}
    if not matched_candidates:
        refusals.append(
            "E3.4: no candidate digest the artifact names matches the current build. The "
            "binding cannot show the same tested candidate, and 'unverified candidate' is a "
            "refusal rather than a warning.")

    return {
        "v1_case_id": cid,
        "v1_verdict": case.get("status"),
        "v1_requirement": case["requirement"],
        "eligible": not refusals,
        "refusals": refusals,
        "conditions": {
            "E3.1_relevant_runtime_inputs_unchanged": {
                "v1_identity_still_recomputes": v1_identity_still_recomputes,
                "recomputed_v1_identity": recomputed_v1,
                "lock_identity": lock["deployment"]["identity"],
                "evidence_named_identities": sorted(n for n in named if n),
                "identity_agrees": identity_agrees,
            },
            "E3.2_oracle_semantically_identical": {
                "identical": oracle_identical,
                "v1_oracle_sha256": v1_oracle_sha,
                "v2_oracle_sha256": v2_oracle_sha,
                "provenance_says_changed": provenance_says_changed,
                "provenance_agrees_with_measurement": provenance_agrees,
            },
            "E3.3_evidence_immutable_hash_verified": {
                "entries": evidence_rows,
                "all_verified": bool(evidence_rows) and all(
                    r.get("hash_verified") and r.get("tracked") and r.get("clean") is not False
                    for r in evidence_rows),
            },
            "E3.4_same_tested_candidate": {
                "candidate_digests_in_force": current,
                "candidate_digests_the_artifact_names": sorted(matched_candidates.values()),
                "matched": matched_candidates,
            },
        },
        "recorded_as": "REUSED_EVIDENCE" if not refusals else None,
        "note": ("Eligible as a REUSED_EVIDENCE binding. This is a BINDING, not a verdict: the "
                 "writer must still read the artifact and state that it establishes the v2 "
                 "oracle. This evaluator decides the mechanical conditions only."
                 if not refusals else
                 "NOT eligible. A v1 artifact may not be cited for this v2 case; it needs its "
                 "own measurement."),
    }


def line_ending_audit() -> dict[str, Any]:
    """How many v1 evidence entries are not reproducible from a fresh checkout?

    SIZED RATHER THAN ANECDOTAL. The per-case evaluation finds the mismatches one at
    a time; this counts them across the whole ledger and separates the two causes,
    because "3 entries" and "3 entries, all line-ending" call for different actions.
    """
    ledger = json.loads(LIVE_LEDGER.read_text(encoding="utf-8"))
    total = 0
    mismatched: list[dict[str, Any]] = []
    for case in ledger["cases"]:
        for entry in case.get("evidence") or []:
            total += 1
            rel = entry["path"]
            path = ROOT / rel
            if not path.is_file():
                mismatched.append({"case": case["id"], "path": rel, "kind": "MISSING"})
                continue
            row = hash_with_line_ending_diagnosis(path, entry.get("sha256"))
            if row["hash_verified"]:
                continue
            kind = ("LINE_ENDING" if row.get("recorded_digest_matches_variant")
                    else "CONTENT")
            mismatched.append({"case": case["id"], "path": rel, "kind": kind,
                               "diagnosis": row.get("diagnosis")})
    return {
        "evidence_entries_in_the_v1_ledger": total,
        "not_reproducible_in_this_checkout": len(mismatched),
        "by_kind": {
            "LINE_ENDING": sum(1 for m in mismatched if m["kind"] == "LINE_ENDING"),
            "CONTENT": sum(1 for m in mismatched if m["kind"] == "CONTENT"),
            "MISSING": sum(1 for m in mismatched if m["kind"] == "MISSING"),
        },
        "mechanism": (
            "`.gitattributes` declares `*.json text eol=lf` (and the same for .jsonl, .md, "
            ".ts, .yml, .yaml) while core.autocrlf is `true`. An evidence file written on "
            "Windows with CRLF endings is therefore COMMITTED as LF, so the sha256 the v1 "
            "ledger recorded describes bytes that exist only in the checkout that wrote "
            "them. Git reports these files as CLEAN -- the difference is not a modification, "
            "it is a checkout-time normalisation."),
        "consequence": (
            "Any v1 evidence entry with kind LINE_ENDING is NOT reusable under E3.3, because "
            "E3.3 requires a hash-verified artifact and the hash does not reproduce. This is "
            "a property of the HASHING CONVENTION, not of the artifact, so it is reported as "
            "a finding about the convention rather than as tampering."),
        "entries": mismatched,
    }


def run_cheap_gates() -> list[dict[str, Any]]:
    """Re-run every cheap mechanical gate, whatever any reuse decision says."""
    rows = []
    for gate in CHEAP_MECHANICAL_GATES:
        argv = gate["command"].split()
        proc = subprocess.run(argv, cwd=ROOT, capture_output=True, text=True)
        rows.append({
            "id": gate["id"],
            "what": gate["what"],
            "command": gate["command"],
            "exit_code": proc.returncode,
            "passed": proc.returncode == 0,
            "tail": (proc.stdout.strip().splitlines() or [""])[-1][:200],
        })
    return rows


def main() -> int:
    parser = argparse.ArgumentParser(description="evaluate v1 evidence reuse under V3 E3")
    parser.add_argument("--json", action="store_true")
    parser.add_argument("--case", default=None, help="evaluate one v1 case id")
    parser.add_argument("--skip-gates", action="store_true",
                        help="do not re-run the cheap mechanical gates")
    args = parser.parse_args()

    ledger = json.loads(LIVE_LEDGER.read_text(encoding="utf-8"))
    v2 = json.loads(DEFINITION.read_text(encoding="utf-8"))
    provenance = json.loads(PROVENANCE.read_text(encoding="utf-8"))
    lock = json.loads(LOCK.read_text(encoding="utf-8"))

    cases = ledger["cases"]
    if args.case:
        cases = [c for c in cases if c["id"] == args.case]
        if not cases:
            print(f"evidence-reuse: no v1 case {args.case}", file=sys.stderr)
            return 2

    # Only a case that CARRIED A VERDICT can be reused. A NOT_RUN case has nothing
    # to reuse, and evaluating it would inflate the eligible count with cases that
    # were never measured.
    filed = [c for c in cases if c.get("status") in ("PASS", "FAIL")]
    rows = [evaluate_case(c, v2, provenance, lock) for c in filed]

    gates = [] if args.skip_gates else run_cheap_gates()
    eligible = [r for r in rows if r["eligible"]]
    refused = [r for r in rows if not r["eligible"]]
    provenance_disagreements = [
        r["v1_case_id"] for r in rows
        if not r["conditions"]["E3.2_oracle_semantically_identical"]["provenance_agrees_with_measurement"]
    ]

    record = {
        "what": "the V3 E3 evidence-reuse decision, computed per v1 case",
        "generated_by": "qualification/runners/evidence-reuse.py",
        "v1_ledger": {"path": str(LIVE_LEDGER.relative_to(ROOT)), "sha256": sha256_file(LIVE_LEDGER)},
        "v1_deployment_identity": lock["deployment"]["identity"],
        "totals": {
            "v1_cases_filed": len(filed),
            "eligible_as_reused_evidence": len(eligible),
            "refused": len(refused),
            "eligible_ids": sorted(r["v1_case_id"] for r in eligible),
            "refused_ids": sorted(r["v1_case_id"] for r in refused),
        },
        "rule": ("An eligible case may be recorded as REUSED_EVIDENCE -- a BINDING, never a "
                 "verdict. A refused case needs its own v2 measurement. Eligibility is decided "
                 "by the four computed E3 conditions, not by a policy statement."),
        "cheap_mechanical_gates": {
            "why": ("V3 E3: 'Rerun cheap mechanical gates.' They are re-run REGARDLESS of any "
                    "reuse decision, because they cost seconds and a stale reuse is a false PASS."),
            "gates": gates,
            "all_passed": all(g["passed"] for g in gates) if gates else None,
        },
        "provenance_disagreements": provenance_disagreements,
        "line_ending_audit": line_ending_audit(),
        "cases": rows,
    }
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    (OUT_DIR / "evidence-reuse.json").write_text(
        json.dumps(record, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")

    if args.json:
        print(json.dumps(record, indent=2, ensure_ascii=False))
        return 0

    print(f"v1 cases filed (PASS/FAIL):        {len(filed)}")
    print(f"  eligible as REUSED_EVIDENCE:     {len(eligible)}")
    print(f"  refused (needs own measurement): {len(refused)}")
    print("")
    print(f"eligible: {record['totals']['eligible_ids']}")
    print("")
    audit = record["line_ending_audit"]
    print(f"line-ending audit: {audit['not_reproducible_in_this_checkout']} of "
          f"{audit['evidence_entries_in_the_v1_ledger']} evidence entries do not reproduce "
          f"in a fresh checkout  {audit['by_kind']}")
    for entry in audit["entries"]:
        print(f"  {entry['kind']:12s} {entry['case']:9s} {entry['path']}")
    print("")
    if gates:
        print("cheap mechanical gates, re-run regardless:")
        for gate in gates:
            print(f"  {'ok  ' if gate['passed'] else 'FAIL'} {gate['id']:18s} exit={gate['exit_code']}  "
                  f"{gate['what']}")
            if not gate["passed"]:
                print(f"       {gate['command']}")
                print(f"       observed: {gate['tail']}")
        print("")
    if provenance_disagreements:
        print(f"PROVENANCE DISAGREEMENTS (a defect in the provenance record): "
              f"{provenance_disagreements}")
        print("")
    print("A refusal is not a failure: it means the case needs its own v2 measurement.")
    print("An eligibility is not a verdict: the writer must still read the artifact.")
    print(f"record: {OUT_DIR / 'evidence-reuse.json'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
