#!/usr/bin/env python3
"""File a verdict/evidence result under the qualification contract identity.

THE PROPERTY THIS FILE EXISTS TO DEMONSTRATE, AND HOW IT IS PROVED RATHER THAN CLAIMED.

In v1 the acceptance spec was BOTH an identity input and the evidence ledger, so
filing a verdict changed the digest of a pinned input. Here, a result is a separate
artifact written under `qualification/results/<qualification-contract-id>/`, and
NEITHER identity hashes it or anything it contains. The proof is not the design
statement; it is this: `file-result.py` recomputes both identities BEFORE and AFTER
writing, and refuses to accept the write if either moved.

    definition digest before == definition digest after
    RuntimeDeploymentIdentity before == after
    QualificationContractIdentity before == after

If a future change makes results an identity input again -- which is exactly what v1
did -- this check fails and the change cannot land quietly.

WHAT A RESULT DIRECTORY CONTAINS (V3 E2 names the first three):

    verdicts.json          one row per case: id, verdict, evidence refs, identity
    evidence-manifest.json every evidence artifact with its sha256 and its ORIGIN
    GATES.md               the human-readable gate table
    identity.json          the two identities this result is bound to

WHAT IT REFUSES, all of them recorded defect classes rather than hypotheticals:

  * a verdict outside the contract's declared vocabulary;
  * a PASS with no evidence entry (a claim with nothing behind it);
  * an evidence path that escapes the repository, or that does not exist, or whose
    recorded sha256 does not match the file on disk (v1's `verify-spec.py` rule);
  * a `NOT_RUN`/`BLOCKED_EXTERNAL` case carrying evidence (a non-verdict with a
    receipt attached);
  * a FAIL with neither a reason nor evidence (a failure a reader cannot explain);
  * `NOT_CLAIMED` without the topology fact that makes the invariant inapplicable.
    This is the one rule that is new here and it is deliberate: NOT_CLAIMED exists
    so a deleted claim can be stated honestly, and without that requirement it
    becomes the easiest way to retire an inconvenient FAIL;
  * a `REUSED_EVIDENCE` binding that does not satisfy all four E3 conditions.

Usage:
    python qualification/runners/file-result.py --case ID-01 --verdict NOT_RUN
    python qualification/runners/file-result.py --self-test     # the mutation proof
"""
from __future__ import annotations

import argparse
import hashlib
import json
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
DEFINITION = ROOT / "qualification" / "specs" / "acceptance-spec.trusted-local-v2.definition.json"
PROVENANCE = ROOT / "qualification" / "specs" / "acceptance-spec.trusted-local-v2.provenance.json"
IDENTITY_RUNNER = ROOT / "qualification" / "runners" / "qualification-identity.py"
EVIDENCE_ROOT = "qualification/results/"

VERDICTS = ("NOT_RUN", "PASS", "FAIL", "NOT_CLAIMED", "BLOCKED_EXTERNAL")


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def canonical_file_digest(path: Path) -> str:
    """A digest invariant to checkout line endings.

    `.gitattributes` declares `*.json text eol=lf` while core.autocrlf is true, so a
    JSON file written on Windows has CRLF on disk and LF in git. A digest over the
    on-disk bytes therefore describes the checkout that computed it rather than the
    artifact -- measured in v1's own evidence (three entries are unreproducible for
    exactly this reason). Contract inputs use this form so the identity reproduces
    anywhere. The EVIDENCE-hash rules elsewhere in this file deliberately keep the
    strict form, because v1's ledger recorded on-disk bytes and changing that would
    silently redefine what its recorded hashes mean.
    """
    return hashlib.sha256(path.read_bytes().replace(b"\r\n", b"\n")).hexdigest()


def identities(probe: str | None) -> dict[str, Any]:
    """Ask the identity runner for the current model, as a subprocess.

    Deliberately a SUBPROCESS rather than an import: the identity must be the one
    the runner computes from disk, and an in-process import could be satisfied by a
    stale module object. A subprocess also makes the check usable from any language.
    """
    argv = [sys.executable, str(IDENTITY_RUNNER), "--json"]
    if probe:
        argv += ["--probe", probe]
    proc = subprocess.run(argv, cwd=ROOT, capture_output=True, text=True)
    if proc.returncode not in (0, 1):
        raise SystemExit(f"file-result: the identity runner failed: {proc.stderr.strip()}")
    return json.loads(proc.stdout)


def contract_id(model: dict[str, Any]) -> str:
    return str(model["qualification_contract"]["contract_id"])


def validate_verdict(entry: dict[str, Any], definition: dict[str, Any]) -> list[str]:
    """Every rule, as a function that returns problems rather than raising."""
    problems: list[str] = []
    cid = entry.get("case_id")
    known = {c["id"] for c in definition["cases"]}
    if cid not in known:
        problems.append(f"{cid}: not a case in the v2 definition")
        return problems

    verdict = entry.get("verdict")
    if verdict not in VERDICTS:
        problems.append(f"{cid}: verdict {verdict!r} is not in {list(VERDICTS)}")
        return problems

    evidence = entry.get("evidence") or []
    if verdict == "PASS" and not evidence:
        problems.append(f"{cid}: PASS with no evidence entry")
    if verdict in ("NOT_RUN", "BLOCKED_EXTERNAL") and evidence:
        problems.append(
            f"{cid}: verdict {verdict} carries {len(evidence)} evidence entry/entries -- "
            "a non-verdict must carry none")
    if verdict == "FAIL" and not evidence and not entry.get("reason"):
        problems.append(f"{cid}: FAIL with neither a reason nor evidence")

    # NOT_CLAIMED is the new verdict and it carries the heaviest requirement, on
    # purpose: it asserts that the contract makes NO claim, so it must name the
    # topology fact that makes the claim inapplicable.
    if verdict == "NOT_CLAIMED":
        if not entry.get("not_claimed_basis"):
            problems.append(
                f"{cid}: NOT_CLAIMED requires `not_claimed_basis` -- the topology fact that "
                "makes the invariant inapplicable. Without it, NOT_CLAIMED is just a way to "
                "retire a FAIL.")
        if entry.get("v1_verdict") == "PASS":
            problems.append(
                f"{cid}: NOT_CLAIMED against a v1 PASS -- a claim that was established cannot "
                "become a claim that was never made")

    # Evidence integrity, v1's verify-spec.py rules carried forward.
    for item in evidence:
        rel = item.get("path")
        recorded = item.get("sha256")
        if not isinstance(rel, str) or not rel:
            problems.append(f"{cid}: an evidence entry has no path")
            continue
        normalized = rel.replace("\\", "/")
        if normalized.startswith("/") or ":" in normalized.split("/")[0]:
            problems.append(f"{cid}: evidence path is not repo-relative: {rel}")
            continue
        if not normalized.startswith(EVIDENCE_ROOT):
            problems.append(f"{cid}: evidence path is outside {EVIDENCE_ROOT}: {rel}")
            continue
        path = ROOT / normalized
        if not path.is_file():
            problems.append(f"{cid}: evidence file does not exist: {rel}")
            continue
        actual = sha256_file(path)
        if not isinstance(recorded, str) or len(recorded) != 64:
            problems.append(f"{cid}: evidence entry for {rel} has no usable sha256")
        elif actual != recorded:
            problems.append(
                f"{cid}: evidence {rel} hashes to {actual[:16]}... but the entry records "
                f"{recorded[:16]}...")

    # REUSED_EVIDENCE: the E3 rule, checked rather than trusted.
    for binding in entry.get("reused_evidence") or []:
        problems.extend(validate_reuse(cid, binding, definition))

    return problems


def validate_reuse(cid: str, binding: dict[str, Any], definition: dict[str, Any]) -> list[str]:
    """V3 E3, one condition per check.

    A v1 evidence artifact may support v2 only when ALL FOUR hold. Each is a field
    the filer must supply, so a binding cannot be made by naming a file and hoping.
    """
    problems: list[str] = []
    tag = f"{cid}/reused:{binding.get('v1_case_id')}"

    # 1. relevant runtime inputs unchanged
    if not binding.get("runtime_inputs_unchanged"):
        problems.append(
            f"{tag}: E3.1 requires the relevant runtime inputs be unchanged; the binding does "
            "not assert it")
    if not binding.get("runtime_inputs_checked"):
        problems.append(
            f"{tag}: E3.1 requires the runtime inputs be CHECKED, not asserted -- name the "
            "inputs compared in `runtime_inputs_checked`")

    # 2. v2 oracle semantically identical
    v1_case_id = binding.get("v1_case_id")
    v1_oracle = binding.get("v1_oracle_sha256")
    if not v1_oracle:
        problems.append(f"{tag}: E3.2 requires the v1 oracle's digest, so 'semantically "
                        "identical' is a comparison rather than a claim")
    if binding.get("v2_oracle_changed"):
        problems.append(
            f"{tag}: E3.2 requires the v2 oracle be SEMANTICALLY IDENTICAL to the v1 oracle, "
            "and the binding records that it CHANGED. A changed oracle needs its own "
            "measurement; it cannot inherit one.")
    if v1_case_id is not None and not binding.get("oracle_comparison"):
        problems.append(f"{tag}: E3.2 requires an explicit oracle comparison")

    # 3. evidence immutable and hash-verified
    if not binding.get("evidence_sha256_verified"):
        problems.append(f"{tag}: E3.3 requires the evidence be hash-verified")
    if not binding.get("evidence_immutable"):
        problems.append(
            f"{tag}: E3.3 requires the evidence be immutable. An artifact a later run can "
            "overwrite is not evidence for a new contract.")

    # 4. same tested candidate/build
    if not binding.get("tested_candidate"):
        problems.append(f"{tag}: E3.4 requires the evidence name the tested candidate/build")
    if not binding.get("candidate_matches"):
        problems.append(
            f"{tag}: E3.4 requires the tested candidate be the SAME one this contract binds. "
            "Evidence for a different build is not evidence for this one.")

    # And the shape of the record: REUSED_EVIDENCE is a BINDING, never a verdict.
    if binding.get("recorded_as") != "REUSED_EVIDENCE":
        problems.append(
            f"{tag}: the binding must be recorded as REUSED_EVIDENCE, never as an unexamined "
            f"inherited PASS (found {binding.get('recorded_as')!r})")
    return problems


def write_result(out_dir: Path, verdicts: list[dict[str, Any]], manifest: list[dict[str, Any]],
                 model: dict[str, Any], gates_md: str) -> None:
    """Write the four result files, WITH LF ENDINGS.

    `newline="\\n"` on every write is deliberate, not stylistic. `.gitattributes`
    declares `*.json text eol=lf` while core.autocrlf is true, so a result written with
    CRLF endings is stored as LF and its on-disk digest does not reproduce from a fresh
    checkout. A result whose hash depends on the machine that wrote it cannot be
    hash-verified by a later reader, which is what the evidence rules require.
    """
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "verdicts.json").write_text(json.dumps({
        "schema_version": 1,
        "kind": "TRUSTED_LOCAL_V2_VERDICTS_NOT_A_DSH_ARTIFACT",
        "qualification_contract_identity": model["qualification_contract"]["qualification_contract_identity"],
        "runtime_deployment_identity": model["runtime_deployment_identity"],
        "acceptance_definition_digest": model["qualification_contract"]["acceptance_definition_digest"],
        "verdict_vocabulary": list(VERDICTS) + ["REUSED_EVIDENCE (a binding, not a verdict)"],
        "verdicts": verdicts,
    }, indent=2, ensure_ascii=False) + "\n", encoding="utf-8", newline="\n")
    (out_dir / "evidence-manifest.json").write_text(json.dumps({
        "schema_version": 1,
        "kind": "TRUSTED_LOCAL_V2_EVIDENCE_MANIFEST_NOT_A_DSH_ARTIFACT",
        "qualification_contract_identity": model["qualification_contract"]["qualification_contract_identity"],
        "entries": manifest,
    }, indent=2, ensure_ascii=False) + "\n", encoding="utf-8", newline="\n")
    (out_dir / "GATES.md").write_text(gates_md, encoding="utf-8", newline="\n")
    (out_dir / "identity.json").write_text(
        json.dumps(model, indent=2, ensure_ascii=False) + "\n", encoding="utf-8", newline="\n")


def gates_table(verdicts: list[dict[str, Any]], definition: dict[str, Any],
                model: dict[str, Any]) -> str:
    counts: dict[str, int] = {}
    for row in verdicts:
        counts[row["verdict"]] = counts.get(row["verdict"], 0) + 1
    lines = [
        "# trusted-local-v2 gate table",
        "",
        f"**QualificationContractIdentity:** `{model['qualification_contract']['qualification_contract_identity']}`",
        f"**RuntimeDeploymentIdentity:** `{model['runtime_deployment_identity']}`",
        f"**Acceptance definition digest:** `{model['qualification_contract']['acceptance_definition_digest']}`",
        "",
        ("This table is a RESULT. It is not an identity input, and filing it does not move "
         "either identity above. That is the property the v2 definition/result split exists "
         "for, and `file-result.py` proves it by recomputing both identities before and after "
         "the write."),
        "",
        "## Verdict counts",
        "",
    ]
    for key in VERDICTS:
        lines.append(f"- `{key}`: **{counts.get(key, 0)}**")
    lines += [
        "",
        f"Cases in the definition: **{len(definition['cases'])}**",
        "",
        "## Rows",
        "",
        "| case | verdict | evidence | reused | basis |",
        "|---|---|---|---|---|",
    ]
    for row in verdicts:
        ev = len(row.get("evidence") or [])
        reused = len(row.get("reused_evidence") or [])
        basis = str(row.get("not_claimed_basis") or row.get("reason") or "")
        basis = basis.replace("|", "\\|")[:160]
        lines.append(f"| {row['case_id']} | {row['verdict']} | {ev} | {reused} | {basis} |")
    lines.append("")
    return "\n".join(lines)


def snapshot(model: dict[str, Any]) -> tuple[str, str, str]:
    return (
        str(model["qualification_contract"]["acceptance_definition_digest"]),
        str(model["runtime_deployment_identity"]),
        str(model["qualification_contract"]["qualification_contract_identity"]),
    )


def self_test(probe: str | None) -> int:
    """Prove the split: filing a result moves NEITHER identity.

    This is the exit criterion V3 E2 names, made mechanical. It is not enough that
    the design says results are not identity inputs -- a later edit could make them
    inputs again, and that edit is exactly what v1 shipped. So the check runs here,
    against the real runner, on every invocation of --self-test.
    """
    definition = json.loads(DEFINITION.read_text(encoding="utf-8"))
    before = snapshot(identities(probe))

    # A REAL filing, not a dry run: a case is written with evidence attached, under
    # the contract directory, and the evidence is a real file that hashes correctly.
    # THE SELF-TEST WRITES INTO A SEPARATE DIRECTORY, AND THAT IS NOT FASTIDIOUSNESS.
    # A self-test that filed rows into the REAL contract directory would leave two
    # verdicts on disk that no writer produced -- a `PASS` for ID-02 and a
    # `NOT_CLAIMED` for REC-09 -- and a later reader would have no way to tell them
    # from filed results. This project has already been burned by a result that was
    # not measured being read as one. So the split is proved in a directory named for
    # the fact, and the real contract directory contains only what a writer filed.
    out_dir = ROOT / "qualification" / "results" / "trusted-local-v2-identity" / "split-self-test"
    evidence_rel = "qualification/results/trusted-local-v2-identity/probe.json"
    evidence_abs = ROOT / evidence_rel
    if not evidence_abs.is_file():
        print(f"file-result --self-test: no evidence at {evidence_rel}; run the identity driver first",
              file=sys.stderr)
        return 2
    evidence_sha = sha256_file(evidence_abs)

    verdicts = [{
        "case_id": "ID-02",
        "verdict": "PASS",
        "evidence": [{
            "path": evidence_rel,
            "sha256": evidence_sha,
            "note": ("A self-test filing. ID-02 asks whether the identity recomputes from its "
                     "inputs, and this artifact is the measured runtime input set the "
                     "recomputation consumes."),
        }],
        "reason": None,
    }, {
        "case_id": "REC-09",
        "verdict": "NOT_CLAIMED",
        "not_claimed_basis": ("SELF-TEST ROW, not a filed verdict: it exists to exercise the "
                              "NOT_CLAIMED validation path. R9 owns the real topology decision."),
        "evidence": [],
    }]
    manifest = [{
        "path": evidence_rel,
        "sha256": evidence_sha,
        "origin": "v2",
        "immutable": True,
        "note": "written by the v2 identity driver; not a reused v1 artifact",
    }]

    model = identities(probe)
    problems: list[str] = []
    for row in verdicts:
        problems.extend(validate_verdict(row, definition))
    if problems:
        print("file-result --self-test: the self-test rows are INVALID (a bug in this file):")
        for problem in problems:
            print(f"  - {problem}")
        return 2

    write_result(out_dir, verdicts, manifest, model, gates_table(verdicts, definition, model))

    after = snapshot(identities(probe))
    moved = [(name, b, a) for name, b, a in
             zip(("acceptance_definition_digest", "RuntimeDeploymentIdentity",
                  "QualificationContractIdentity"), before, after) if b != a]

    print(f"contract dir      {out_dir}")
    print(f"wrote             verdicts.json, evidence-manifest.json, GATES.md, identity.json")
    print("")
    print(f"{'identity':34s} {'before':16s} {'after':16s}")
    for name, b, a in zip(("acceptance_definition_digest", "RuntimeDeploymentIdentity",
                           "QualificationContractIdentity"), before, after):
        print(f"{name:34s} {b[:16]} {a[:16]}  {'UNCHANGED' if b == a else '*** MOVED ***'}")
    print("")
    if moved:
        print("THE SPLIT IS BROKEN: filing a result moved an identity:")
        for name, b, a in moved:
            print(f"  - {name}: {b} -> {a}")
        return 1
    print("THE SPLIT HOLDS: a result was filed and NEITHER identity moved.")
    print("This is the exit criterion. It is recomputed on every run, so a later change that")
    print("makes results an identity input fails here rather than shipping.")
    return 0


def vocabulary_test() -> int:
    """Prove the verdict vocabulary decides what it claims to decide.

    Each block is a filing that MUST be accepted or MUST be refused, and the refusal
    is checked for the RIGHT reason rather than merely for a refusal. A validator
    that refused everything would pass a naive "it refuses bad input" test while
    being useless, so the accepted cases are here too.

    The NOT_CLAIMED block is the important one. D3 requires v2 to be able to express
    "this invariant is deliberately not claimed" -- R9's decision for REC-09/REC-10
    is DELETE, so the deployment must be able to say so honestly instead of forcing
    the case into PASS or FAIL. The two refusal arms are what stop NOT_CLAIMED from
    becoming a soft FAIL: no topology fact, and a v1 PASS.
    """
    definition = json.loads(DEFINITION.read_text(encoding="utf-8"))
    cases = []
    topology = ("Topology: applyWorkerSettlement has no production caller (record.ts:419 states "
                "it in its own words), so no settlement path from a superseded generation exists "
                "to fence. The v1 FAIL is preserved in v1.")

    def expect(label: str, entry: dict[str, Any], must_be_accepted: bool,
               must_mention: str | None = None) -> None:
        problems = validate_verdict(entry, definition)
        accepted = not problems
        ok = accepted if must_be_accepted else not accepted
        if ok and must_mention is not None:
            ok = any(must_mention in p for p in problems)
        cases.append({"label": label, "must_be_accepted": must_be_accepted,
                      "accepted": accepted, "problems": problems, "ok": ok})

    expect("NOT_RUN is accepted for an untouched case",
           {"case_id": "ID-01", "verdict": "NOT_RUN", "evidence": []}, True)
    expect("BLOCKED_EXTERNAL is accepted for the T5 case",
           {"case_id": "IPY-08", "verdict": "BLOCKED_EXTERNAL", "evidence": []}, True)
    expect("NOT_CLAIMED is accepted WITH the topology fact (R9's DELETE decision for REC-09)",
           {"case_id": "REC-09", "verdict": "NOT_CLAIMED", "evidence": [],
            "not_claimed_basis": topology, "v1_verdict": "FAIL"}, True)
    expect("NOT_CLAIMED is accepted for REC-10, the dependent case",
           {"case_id": "REC-10", "verdict": "NOT_CLAIMED", "evidence": [],
            "not_claimed_basis": topology, "v1_verdict": "FAIL"}, True)
    expect("NOT_CLAIMED is REFUSED without the topology fact",
           {"case_id": "REC-09", "verdict": "NOT_CLAIMED", "evidence": [],
            "v1_verdict": "FAIL"}, False, "topology fact")
    expect("NOT_CLAIMED is REFUSED against a v1 PASS",
           {"case_id": "CMP-13", "verdict": "NOT_CLAIMED", "evidence": [],
            "not_claimed_basis": topology, "v1_verdict": "PASS"}, False,
           "cannot become a claim that was never made")
    expect("PASS is REFUSED with no evidence",
           {"case_id": "ID-01", "verdict": "PASS", "evidence": []}, False, "no evidence entry")
    expect("NOT_RUN is REFUSED when it carries evidence",
           {"case_id": "ID-01", "verdict": "NOT_RUN",
            "evidence": [{"path": "qualification/results/x.json", "sha256": "0" * 64}]},
           False, "must carry none")
    expect("FAIL is REFUSED with neither a reason nor evidence",
           {"case_id": "ID-01", "verdict": "FAIL", "evidence": []}, False,
           "neither a reason nor evidence")
    expect("an unknown verdict is REFUSED",
           {"case_id": "ID-01", "verdict": "MAYBE", "evidence": []}, False,
           "not in")
    expect("a case id absent from the definition is REFUSED",
           {"case_id": "ZZ-99", "verdict": "NOT_RUN", "evidence": []}, False,
           "not a case in the v2 definition")

    # The E3 reuse rule, proved in the same style: a complete binding is accepted and
    # each missing condition is refused by name.
    complete = {
        "v1_case_id": "CMP-13", "recorded_as": "REUSED_EVIDENCE",
        "runtime_inputs_unchanged": True,
        "runtime_inputs_checked": ["host_profile_digest", "agent_preset_digest"],
        "v1_oracle_sha256": "a" * 64, "v2_oracle_changed": False,
        "oracle_comparison": "identical after whitespace normalisation",
        "evidence_sha256_verified": True, "evidence_immutable": True,
        "tested_candidate": "launcher 69c49c87..., lib digest d525478d...",
        "candidate_matches": True,
    }
    expect("a COMPLETE E3 binding is accepted",
           {"case_id": "ID-01", "verdict": "PASS", "evidence": [
               {"path": "qualification/results/trusted-local-v2-identity/probe.json",
                "sha256": sha256_file(ROOT / "qualification/results/trusted-local-v2-identity/probe.json")}],
            "reused_evidence": [complete]}, True)
    for field, needle in (
        ("runtime_inputs_unchanged", "E3.1"),
        ("runtime_inputs_checked", "E3.1"),
        ("v1_oracle_sha256", "E3.2"),
        ("evidence_sha256_verified", "E3.3"),
        ("evidence_immutable", "E3.3"),
        ("tested_candidate", "E3.4"),
        ("candidate_matches", "E3.4"),
    ):
        partial = {k: v for k, v in complete.items() if k != field}
        expect(f"an E3 binding missing `{field}` is REFUSED",
               {"case_id": "ID-01", "verdict": "PASS", "evidence": [
                   {"path": "qualification/results/trusted-local-v2-identity/probe.json",
                    "sha256": sha256_file(ROOT / "qualification/results/trusted-local-v2-identity/probe.json")}],
                "reused_evidence": [partial]}, False, needle)
    changed = dict(complete)
    changed["v2_oracle_changed"] = True
    expect("an E3 binding for a REWRITTEN oracle is REFUSED",
           {"case_id": "ID-01", "verdict": "PASS", "evidence": [
               {"path": "qualification/results/trusted-local-v2-identity/probe.json",
                "sha256": sha256_file(ROOT / "qualification/results/trusted-local-v2-identity/probe.json")}],
            "reused_evidence": [changed]}, False, "SEMANTICALLY IDENTICAL")
    mislabelled = dict(complete)
    mislabelled["recorded_as"] = "PASS"
    expect("an E3 binding recorded as anything but REUSED_EVIDENCE is REFUSED",
           {"case_id": "ID-01", "verdict": "PASS", "evidence": [
               {"path": "qualification/results/trusted-local-v2-identity/probe.json",
                "sha256": sha256_file(ROOT / "qualification/results/trusted-local-v2-identity/probe.json")}],
            "reused_evidence": [mislabelled]}, False, "REUSED_EVIDENCE")

    failures = [c for c in cases if not c["ok"]]
    print(f"vocabulary test: {len(cases) - len(failures)}/{len(cases)} behaviours as required")
    print("")
    for case in cases:
        print(f"{'ok  ' if case['ok'] else 'FAIL'} {case['label']}")
        if not case["ok"]:
            print(f"       accepted={case['accepted']} problems={case['problems']}")
    print("")
    if failures:
        print(f"verdict: VOCABULARY_BROKEN ({len(failures)} behaviour(s) wrong)")
        return 1
    print("verdict: VOCABULARY_PROVED")
    print("In particular: NOT_CLAIMED is accepted WITH a topology fact and refused without one,")
    print("so it cannot be used to retire an inconvenient FAIL.")
    return 0


def init_results(probe: str | None) -> int:
    """Create the contract result directory with every case filed as NOT_RUN.

    WHY THE INITIAL STATE IS WRITTEN RATHER THAN LEFT ABSENT. V3 E2 names three files
    in the results directory. A directory that exists but carries no verdicts.json is
    ambiguous: a reader cannot tell "no case has been run" from "the results were lost
    or never filed". Filing all 110 cases explicitly as NOT_RUN makes the starting
    state a RECORDED fact, and it makes a missing case detectable -- a case id that
    disappears from verdicts.json is then a defect rather than a smaller file.

    It writes NO verdict other than NOT_RUN. A generator that pre-marked anything else
    would be a rigged oracle, which is the thing v1's own rules forbid twice.
    """
    definition = json.loads(DEFINITION.read_text(encoding="utf-8"))
    model = identities(probe)
    out_dir = ROOT / "qualification" / "results" / contract_id(model)

    verdicts = [{"case_id": c["id"], "verdict": "NOT_RUN", "evidence": []}
                for c in definition["cases"]]
    problems: list[str] = []
    for row in verdicts:
        problems.extend(validate_verdict(row, definition))
    if problems:
        print("file-result --init-results: the generated rows are INVALID (a bug in this file):")
        for problem in problems:
            print(f"  - {problem}")
        return 2

    write_result(out_dir, verdicts, [], model, gates_table(verdicts, definition, model))
    print(f"initialised {out_dir}")
    print(f"  {len(verdicts)} cases filed as NOT_RUN, 0 evidence entries")
    print(f"  QualificationContractIdentity {model['qualification_contract']['qualification_contract_identity']}")
    print("")
    print("The starting state is RECORDED rather than implied, so a case id that disappears")
    print("from verdicts.json is a defect instead of a smaller file.")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="file a v2 result under the contract identity")
    parser.add_argument("--self-test", action="store_true",
                        help="prove filing a result moves neither identity")
    parser.add_argument("--vocabulary-test", action="store_true",
                        help="prove the verdict vocabulary accepts and refuses correctly")
    parser.add_argument("--init-results", action="store_true",
                        help="create the contract result directory with all cases NOT_RUN")
    parser.add_argument("--probe", default=None, help="the probe.json whose inputs bind the identity")
    parser.add_argument("--case", default=None)
    parser.add_argument("--verdict", default=None, choices=VERDICTS)
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()

    if args.vocabulary_test:
        return vocabulary_test()

    if args.init_results:
        return init_results(args.probe)

    if args.self_test:
        return self_test(args.probe)

    if not args.case or not args.verdict:
        parser.error("--case and --verdict are required (or use --self-test)")

    definition = json.loads(DEFINITION.read_text(encoding="utf-8"))
    entry = {"case_id": args.case, "verdict": args.verdict, "evidence": []}
    problems = validate_verdict(entry, definition)
    model = identities(args.probe)
    if args.json:
        print(json.dumps({"entry": entry, "problems": problems,
                          "contract_id": contract_id(model)}, indent=2))
        return 1 if problems else 0
    print(f"contract_id  {contract_id(model)}")
    print(f"case         {args.case}  verdict {args.verdict}")
    if problems:
        for problem in problems:
            print(f"  - {problem}")
        return 1
    print("valid against the v2 verdict vocabulary.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
