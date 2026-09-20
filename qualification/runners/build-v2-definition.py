#!/usr/bin/env python3
"""Build the trusted-local-v2 acceptance DEFINITION from v1, with explicit provenance.

WHY THIS IS A GENERATOR AND NOT A HAND-WRITTEN FILE.

Two reasons, and both are about not repeating recorded defects.

1. THE TREATMENT OF EVERY V1 CASE MUST BE EXPLICIT AND AUDITABLE. v2 is allowed to
   carry a v1 oracle verbatim, rewrite it, split it, or drop it -- but a DROPPED
   invariant must be recorded as dropped, never silently omitted (V3 R0, and
   `docs/decisions/V3-v2-oracle-resolutions.md`). A hand-written 109-case JSON makes
   that provenance unverifiable: a reader cannot tell a case that was deliberately
   dropped from one that was forgotten. Here the treatment is a table, the generator
   checks that every v1 case appears in it exactly once, and the emitted provenance
   file carries the reason for each non-verbatim decision.

2. THE DEFINITION MUST NOT CARRY A STATUS, AN EVIDENCE PATH, OR A VERDICT. That is
   the structural property the whole split exists for, and it is easy to violate by
   accident when a case is copied from the live ledger -- which HAS those fields.
   The generator reads the FROZEN as-authored snapshot (109 NOT_RUN, 0 evidence) and
   emits only the eight definition fields, so a leak is impossible rather than
   unlikely. A separate check re-verifies the emitted file against that rule.

THE DEFINITION FIELD SET IS CLOSED. V3 section E2 names exactly: id, family,
requirement, stimulus, oracle, mandatory/optional, dependencies, definition version.
Nothing else is emitted. In particular a case carries no `status`, no `evidence`, no
`verdict`, no `note` -- the last of which is a real temptation because the v1 live
ledger's `note` field is where the FAIL explanations live. Those explanations are
carried in the PROVENANCE file instead, which is a contract artifact, not a
definition.

Usage:
    python qualification/runners/build-v2-definition.py            # write the files
    python qualification/runners/build-v2-definition.py --check     # verify, do not write
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from collections import Counter
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
FROZEN = ROOT / "qualification" / "specs" / "frozen" / "acceptance-spec.trusted-local-v1.as-authored.json"
LIVE = ROOT / "qualification" / "specs" / "acceptance-spec.trusted-local-v1.json"
DEFINITION = ROOT / "qualification" / "specs" / "acceptance-spec.trusted-local-v2.definition.json"
PROVENANCE = ROOT / "qualification" / "specs" / "acceptance-spec.trusted-local-v2.provenance.json"

DEFINITION_VERSION = "trusted-local-v2.definition/1"
CONTRACT_ID = "trusted-local-v2"

# The eight fields V3 E2 permits, and the only fields this generator may emit.
DEFINITION_FIELDS = (
    "id", "family", "requirement", "stimulus", "oracle",
    "mandatory", "dependencies", "definition_version",
)
FORBIDDEN_FIELDS = ("status", "evidence", "verdict", "note", "result", "identity")

# ─────────────────────────────────────────────────────────────────────────────
# THE TREATMENT TABLE. It records DEVIATIONS from v1, not a per-case ledger.
#
#   verbatim   -- the v1 oracle is carried unchanged.
#   rewritten  -- the oracle text changes; `reason` is required.
#   split      -- v1's one case becomes two; `adds` names the new case(s).
#   not_claimed-- v2 does not claim the invariant; `reason` required.
#
# WHY THE DEFAULT IS VERBATIM AND WHY THAT IS NOT A LOOPHOLE. The generator
# iterates the FROZEN v1 cases, so every v1 case is emitted whether or not it
# appears below -- a silent DROP is impossible by construction, not by discipline.
# What is possible by accident is a silent CHANGE to an oracle, so that is the
# thing gated: the generator compares each emitted oracle against v1's, and any
# case whose text differs MUST appear here with a `reason`. A case that appears
# here for no reason is also refused. So the table is the complete list of every
# place v2 says something different from v1, and the provenance file emits all 109
# rows with their treatment, including the verbatim majority.
#
# An entry with `reason` is a contract decision. Entries without one are the
# mechanical majority and carry no judgement.
# ─────────────────────────────────────────────────────────────────────────────
VERBATIM = "verbatim"
REWRITTEN = "rewritten"
SPLIT = "split"
NOT_CLAIMED = "not_claimed"

TREATMENT: dict[str, dict[str, Any]] = {
    # ── D6: ID-01's failure is a PRODUCT defect, so the oracle does not move. ──
    "ID-01": {"treatment": VERBATIM, "authority": "D6",
              "reason": "The failure is a product defect (an upstream `src/*` import "
                        "reached at runtime), not a spec defect. Root's decision D6: carry "
                        "it into v2 verbatim and do not soften it."},

    # ── D1: CMP-04 is the rewritten half of the contradiction. ───────────────
    "CMP-04": {"treatment": REWRITTEN, "authority": "D1",
               "reason": "v1 pinned `toolCountAgentKey is 28` and required `pwsh` present. "
                         "The pinned literal encoded a COMPOSITION FACT as a pass condition, "
                         "which is what created the contradiction with CMP-13 (which requires "
                         "`pwsh` absent) when commit 35c829d disabled tool-pwsh 19 minutes "
                         "after this case was authored. v2 states the CURRENT architecture: "
                         "`ipython` present, `work` present, `pwsh` absent, `error` null, and "
                         "the tool count MEASURED INTO THE EVIDENCE rather than pinned. The "
                         "count remains a change detector in evidence; it is not a pass "
                         "condition. CMP-13 is unchanged.",
               "dropped_assertions": ["toolCountAgentKey is 28", "pwsh is present"],
               "why_not_a_loss": "Both dropped assertions are recorded as dropped, and the "
                                 "measured count they pinned is still required in evidence. "
                                 "Nothing is silently omitted."},

    # ── D2: DATA-09 splits acquisition from projection. ─────────────────────
    "DATA-09": {"treatment": SPLIT, "authority": "D2",
                "reason": "v1 conflated two different epistemic things in one closed set: "
                          "whether the WORLD gave us complete data (an acquisition fact) and "
                          "how much of complete data the LLM was shown (a projection choice). "
                          "v2 splits them. This case keeps the acquisition half.",
                "adds": ["DATA-13"],
                "dropped_assertions": ["`transport` as a required acquisition stage",
                                       "`model-projection` as a required acquisition stage"],
                "why_not_a_loss": "`transport` has no producer because the product REJECTS an "
                                  "oversized frame before any successful value exists, so there "
                                  "is no partial success to attribute; requiring the stage would "
                                  "mean degrading a hard failure into a silent one. "
                                  "`model-projection` becomes DATA-13's ProjectionManifest, where "
                                  "an intentional projection is recorded as a manifest rather "
                                  "than as a loss."},

    # ── D2: IPY-15 keeps fail-hard and drops the dead counter. ───────────────
    "IPY-15": {"treatment": REWRITTEN, "authority": "D2",
               "reason": "v1 required an over-limit frame be 'reported as LOST with a count'. "
                         "Measured: `CellResult.stdout.droppedFrames` is structurally always 0 "
                         "and `OutputBuffer.note_dropped_frame` (its only writer) has zero call "
                         "sites, so the v1 clause describes drop-and-continue behaviour the "
                         "product does not have and should not have. The product rejects: the "
                         "encoder refuses and the decoder refuses on the DECLARED length before "
                         "buffering. v2 keeps fail-hard and requires a structured refusal that "
                         "names the limit.",
               "dropped_assertions": ["an over-limit frame is reported as LOST with a count"],
               "why_not_a_loss": "A failed transport is a failed OPERATION, not a partial "
                                 "successful observation. Requiring a drop counter would require "
                                 "inventing a producer for a behaviour the product deliberately "
                                 "does not have."},

    # ── D3: REC-09/REC-10 must be able to express either topology outcome. ───
    "REC-09": {"treatment": REWRITTEN, "authority": "D3",
               "reason": "v1 presumed fencing is REQUIRED and FAILed because a stale "
                         "settlement lands on the reachable write path. Writer R9 is measuring "
                         "whether stale-generation settlement is physically possible at all. "
                         "v2 must express either outcome, so this oracle is satisfied by a "
                         "refusal OR by an explicit statement that the guarantee is not claimed, "
                         "naming the topology fact that makes settlement impossible. The "
                         "NOT_CLAIMED verdict exists for the second arm; neither arm is a PASS.",
               "why_not_a_loss": "The invariant is not dropped -- it is made honest in both "
                                 "directions. What is forbidden is manufacturing a caller to "
                                 "make it green, and what is forbidden is forcing a deleted "
                                 "claim into FAIL."},
    "REC-10": {"treatment": REWRITTEN, "authority": "D3",
               "reason": "v1 required the epoch guard be reachable from a non-test production "
                         "path, and measured it INERT. Same topology dependency as REC-09: if "
                         "R9 finds stale-generation settlement impossible, the guard is deleted "
                         "and the case becomes NOT_CLAIMED with the v1 FAIL preserved. v2 "
                         "therefore states the reachability requirement CONDITIONAL on the "
                         "claim being made at all.",
               "why_not_a_loss": "Reachability remains the requirement WHENEVER the guard "
                                 "exists. The case stops asserting that a guard must exist."},

    # ── D4: ID-05's escape-hatch clause is kept; the sweep is deferred. ───────
    "ID-05": {"treatment": REWRITTEN, "authority": "D4",
              "reason": "v1 FAILed on the `as never` clause alone, with the oracle naming "
                        "neither carve-out. D4 measured that the clause is about something real "
                        "in CONFIG position (`ctx.plugin(Storage, {} as never)` MASKS a true "
                        "diagnostic) while the cast on the PLUGIN argument is noise. v2 keeps "
                        "the clause and names the two idioms so the case can be decided without "
                        "a judgement call, and so `as never` is never traded for an invisible "
                        "`as any`. The sweep is deliberately deferred to round 2 (D4) because "
                        "478 of the 488 occurrences are in test files under concurrent edit.",
              "note_on_counts": "v1's note says 475; D4's scanner says 488 (478 test, 10 "
                                "non-test). The 13-count delta is NOT reconciled and v2 states "
                                "no count, so v2 cannot inherit an unreconciled number."},

    # ── D5: BR-07 is kept verbatim; writer R5 adopts the scope vocabulary. ───
    "BR-07": {"treatment": VERBATIM, "authority": "D5",
              "reason": "Root's decision D5: the oracle is kept unchanged, and the bridge "
                        "adopts the programmatic-scope route's EXISTING disposition vocabulary "
                        "rather than inventing a parallel one. R5 owns the implementation."},
}

# The V3 section-U requirements that v1 has NO case for. Recorded as a named gap list
# rather than as invented oracles: an oracle written by the structural writer to close
# its own gap is exactly the fabrication this project keeps recording.
U_REQUIREMENTS_WITHOUT_A_V1_CASE = [
    {"u_section": "U1", "requirement": "DSH singleton realpaths",
     "why_absent": "v1 has no oracle for it. T17 measured it (singletonVerdict: 6 peers from "
                   "the BUILT entry, 0 from source) but no v1 case states it."},
    {"u_section": "U1", "requirement": "clean qualification source checkout (F11)",
     "why_absent": "ID-06 measures checkout cleanliness but under v1's absolute oracle, which "
                   "FAILs on untracked generated state. V3 G2 wants the source plane split from "
                   "the generated plane, which is a different requirement from 'the tree is "
                   "clean'."},
    {"u_section": "U1", "requirement": "authoritative typecheck mutation-sensitive (F10)",
     "why_absent": "ID-05 covers a mutation-sensitive compile, but under the product's own "
                   "tsconfig.check.json rather than one official `pnpm typecheck` command. V3 G3 "
                   "requires naming exactly one official command."},
    {"u_section": "U2", "requirement": "fs-local active; fs-observation-policy active",
     "why_absent": "v1 has no case naming either row."},
    {"u_section": "U2", "requirement": "final ToolRuntime presentation mode = native; "
                                       "Node PTC / run_code / workflow-ptc absent",
     "why_absent": "v1 has no case for the presentation mode. This is a R1 (F3) requirement."},
    {"u_section": "U2", "requirement": "permission-presets absent; ui-permission absent",
     "why_absent": "CMP-06 measures the approval policy and its non-model-writability, but no v1 "
                   "case requires these two rows be absent."},
    {"u_section": "U2", "requirement": "Agent Preset GRAPH verified, not only the host graph",
     "why_absent": "CMP-08/CMP-10 read the preset's own inventory, but no v1 oracle requires the "
                   "preset graph be resolved and digested as an identity input. v2 adds that "
                   "digest as a RUNTIME identity input, so it is measured even without a case."},
    {"u_section": "U3", "requirement": "explicit `/work start` product path (F1)",
     "why_absent": "No v1 case states it. G-SEAM-31 records that WorkService.createRun has no "
                   "production caller, so no N=10 measurement exercised the composed profile."},
    {"u_section": "U4", "requirement": "top-level await (U4) and Session/kernel epoch identity",
     "why_absent": "IPY-03 covers top-level await. Epoch IDENTITY as a durable binding (as "
                   "opposed to IPY-14's epoch ADVANCE) has no v1 case."},
    {"u_section": "U4", "requirement": "graceful shutdown cleans descendants",
     "why_absent": "dsh-ipython/src/cleanup.test.ts asserts it; no v1 case states it."},
    {"u_section": "U5", "requirement": "product-reachable BridgeServer owner",
     "why_absent": "No BR oracle asks whether the product STARTS the bridge -- the family "
                   "records it as reachability_fail (G-SEAM-34) precisely because asserting it "
                   "on a BR case would claim an oracle that case does not state. V3 U5 requires "
                   "it as a v2 case, so it must be WRITTEN, not inferred."},
    {"u_section": "U5", "requirement": "one bridge per kernel epoch; request-id dedupe/conflict; "
                                       "expired lease reject; wrong epoch reject",
     "why_absent": "BR-02/BR-10 measure revocation and close, but not these four."},
    {"u_section": "U6", "requirement": "provider truncation honest; no per-page whole-log reload",
     "why_absent": "RES-04 and OBS-04 measure the two facts, but no v1 case states them as "
                   "requirements."},
    {"u_section": "U9", "requirement": "isolated writer worktree; integrated tree reverified; "
                                       "Git expected-ref publication",
     "why_absent": "v1's VER family covers verification integrity but not the writer-isolation "
                   "and publication discipline V3 U9 requires."},
    {"u_section": "U10", "requirement": "stable tool catalog/order",
     "why_absent": "CMP-13 records the measured name SET; no v1 case requires the ORDER be "
                   "stable across boots. v2 makes the order part of the runtime identity's "
                   "tool-catalog digest, which detects drift, but a case stating the invariant "
                   "is still needed."},
]

CROSS_REF = re.compile(r"\b((?:ID|CMP|IPY|BR|DATA|REC|FS|CAP|VER|RES|OBS)-\d{2}[a-z]?)\b")


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def dependencies_for(case: dict[str, Any], known: set[str]) -> list[str]:
    """Case ids this case's own text refers to, excluding itself.

    Derived mechanically so the list is reproducible rather than asserted, and
    restricted to ids that exist in the definition so a stale reference is dropped
    rather than carried as a dangling edge.
    """
    text = " ".join(str(case.get(k) or "") for k in ("oracle", "stimulus", "requirement"))
    refs = {m for m in CROSS_REF.findall(text)} - {case["id"]}
    return sorted(r for r in refs if r in known)


def main() -> int:
    parser = argparse.ArgumentParser(description="build the v2 acceptance definition from v1")
    parser.add_argument("--check", action="store_true",
                        help="verify the emitted files are current and well-formed; write nothing")
    args = parser.parse_args()

    frozen = json.loads(FROZEN.read_text(encoding="utf-8"))
    live = json.loads(LIVE.read_text(encoding="utf-8"))
    live_cases = {c["id"]: c for c in live["cases"]}

    v1_ids = [c["id"] for c in frozen["cases"]]
    v1_set = set(v1_ids)

    # --- the deviation table must be HONEST ----------------------------------
    # Every v1 case is emitted regardless (the loop below iterates the frozen
    # cases), so a silent drop is structurally impossible. The two real risks are
    # a silent CHANGE and an entry that claims a change it does not make.
    problems: list[str] = []
    unknown = [cid for cid in TREATMENT if cid not in v1_set]
    if unknown:
        problems.append(f"the treatment table names cases that do not exist in v1: {unknown}")
    for cid, entry in TREATMENT.items():
        if entry["treatment"] != VERBATIM and not entry.get("reason"):
            problems.append(f"{cid}: treatment {entry['treatment']!r} requires a `reason`")
        if entry["treatment"] == SPLIT and not entry.get("adds"):
            problems.append(f"{cid}: a split must name the case(s) it adds")
    if problems:
        for p in problems:
            print(f"build-v2-definition: {p}", file=sys.stderr)
        return 2

    # --- emit the definition ------------------------------------------------
    cases: list[dict[str, Any]] = []
    provenance_rows: list[dict[str, Any]] = []
    known = set(v1_ids) | {"DATA-13"}
    silently_changed: list[str] = []
    claimed_but_identical: list[str] = []

    for v1 in frozen["cases"]:
        cid = v1["id"]
        entry = TREATMENT.get(cid, {"treatment": VERBATIM})
        treatment = entry["treatment"]
        oracle = v1["oracle"]
        requirement = v1["requirement"]
        stimulus = v1["stimulus"]
        new_ids: list[str] = []

        if treatment == REWRITTEN:
            oracle, requirement, stimulus = rewrite(cid, v1)
        elif treatment == SPLIT:
            oracle, requirement, stimulus = split_acquisition(cid, v1)
            new_ids = entry["adds"]

        # THE GATE. An oracle that differs from v1 without a recorded decision is a
        # silent rewrite, which is what V3 R0 forbids. An entry claiming a rewrite
        # that leaves the text identical is a stale decision, which is how a
        # provenance record becomes fiction.
        text_changed = (oracle, requirement, stimulus) != (v1["oracle"], v1["requirement"], v1["stimulus"])
        if text_changed and cid not in TREATMENT:
            silently_changed.append(cid)
        if not text_changed and cid in TREATMENT and treatment in (REWRITTEN, SPLIT):
            claimed_but_identical.append(cid)

        cases.append({
            "id": cid,
            "family": v1["family"],
            "requirement": requirement,
            "stimulus": stimulus,
            "oracle": oracle,
            "mandatory": True,
            "dependencies": dependencies_for(
                {"id": cid, "oracle": oracle, "stimulus": stimulus, "requirement": requirement},
                known),
            "definition_version": DEFINITION_VERSION,
        })

        provenance_rows.append({
            "v1_case_id": cid,
            "v2_case_ids": [cid, *new_ids],
            "treatment": treatment,
            "oracle_changed": text_changed,
            "authority": entry.get("authority"),
            "reason": entry.get("reason"),
            "dropped_assertions": entry.get("dropped_assertions", []),
            "why_not_a_loss": entry.get("why_not_a_loss"),
            "note_on_counts": entry.get("note_on_counts"),
        })

    if silently_changed:
        print(f"build-v2-definition: {len(silently_changed)} case(s) have a CHANGED oracle with no "
              f"recorded decision: {silently_changed}", file=sys.stderr)
        return 2
    if claimed_but_identical:
        print(f"build-v2-definition: {len(claimed_but_identical)} case(s) claim a rewrite but the "
              f"text is identical to v1: {claimed_but_identical}", file=sys.stderr)
        return 2

    # the case DATA-09's split adds
    cases.append(projection_manifest_case(known))

    cases.sort(key=lambda c: (family_order(c["family"]), c["id"]))

    definition = {
        "schema_version": 1,
        "kind": "TRUSTED_LOCAL_ACCEPTANCE_DEFINITION_NOT_A_DSH_ARTIFACT",
        "contract_id": CONTRACT_ID,
        "definition_version": DEFINITION_VERSION,
        "title": "DSH trusted-local acceptance definition v2 (Windows, no sandbox)",
        "derived_from": {
            "v1_spec_id": frozen["spec_id"],
            "v1_frozen_path": "qualification/specs/frozen/acceptance-spec.trusted-local-v1.as-authored.json",
            "v1_frozen_sha256": sha256_file(FROZEN),
            "derivation_statement": (
                "v2 is DERIVED from v1 and does not replace it. v1 stays frozen with its "
                "verdicts and its CMP-04/CMP-13 contradiction intact. The per-case provenance "
                "of every carried, rewritten, split or unclaimed invariant is in "
                "acceptance-spec.trusted-local-v2.provenance.json."),
        },
        "trust_model": frozen["trust_model"],
        "layer_legend": frozen["layer_legend"],
        "case_shape": {
            "id": "family prefix + 2-digit ordinal; v1 ids are REUSED where the case carries over",
            "family": "the v1 family name, unchanged",
            "requirement": "the invariant this case is about",
            "stimulus": "the exact thing an operator does to the system",
            "oracle": "the observation that decides PASS, naming its own failure case",
            "mandatory": "true for every case in this definition",
            "dependencies": "case ids this case's own text refers to, derived mechanically",
            "definition_version": "the definition revision this case was authored at",
        },
        "definition_contains": list(DEFINITION_FIELDS),
        "definition_forbids": list(FORBIDDEN_FIELDS),
        "no_status_rule": (
            "THIS FILE CARRIES NO STATUS, NO EVIDENCE PATH AND NO VERDICT. Results live under "
            "qualification/results/<qualification-contract-id>/. The separation is what allows a "
            "result to be filed without changing this file's digest, and therefore without "
            "invalidating the qualification contract identity it is bound to. In v1 the spec was "
            "BOTH an identity input and the evidence ledger, so filing evidence broke the "
            "identity check -- measured: the live ledger's digest moved across 11 revisions."),
        "mandatory_rule": "Every case in this file is mandatory.",
        "verdict_vocabulary": {
            "NOT_RUN": "no verdict has been filed for this case under this contract identity.",
            "PASS": "the oracle was established, and the verdict names the evidence that "
                    "establishes it under this contract identity.",
            "FAIL": "the contract CLAIMS this invariant, it was measured, and it was not "
                    "established. A FAIL asserts a claim, so a FAIL may not be filed against an "
                    "invariant the contract does not claim.",
            "NOT_CLAIMED": "the contract deliberately does NOT claim this invariant. This is a "
                           "first-class verdict and NOT a soft FAIL: it asserts that no claim is "
                           "being made, and the record must name what would have to be true for "
                           "the claim to exist. It exists so a deleted claim can be stated "
                           "honestly instead of being forced into PASS or FAIL. NOT_CLAIMED may "
                           "not be used to retire an inconvenient FAIL without naming the "
                           "topology fact that makes the invariant inapplicable.",
            "BLOCKED_EXTERNAL": "the case needs an external resource that is not authorized "
                                "(live_provider_budget_authorized is false). A recorded blocker, "
                                "never a PASS.",
            "REUSED_EVIDENCE": "not a verdict: a BINDING of an existing v1 evidence artifact to "
                               "a v2 case under the E3 reuse rule. It accompanies a PASS or a "
                               "FAIL and never substitutes for one.",
        },
        "results_location": "qualification/results/<qualification-contract-id>/",
        "families": [{"prefix": f["prefix"], "name": f["name"], "subject": f["subject"]}
                     for f in frozen["families"]],
        "cases": cases,
        "total_cases": len(cases),
    }

    # --- the structural rule, checked rather than asserted -------------------
    for case in cases:
        extra = set(case) - set(DEFINITION_FIELDS)
        if extra:
            print(f"build-v2-definition: case {case['id']} carries forbidden field(s) {sorted(extra)}",
                  file=sys.stderr)
            return 2
        for bad in FORBIDDEN_FIELDS:
            if bad in case:
                print(f"build-v2-definition: case {case['id']} carries {bad!r}", file=sys.stderr)
                return 2

    provenance = {
        "schema_version": 1,
        "kind": "TRUSTED_LOCAL_V2_CASE_PROVENANCE_NOT_A_DSH_ARTIFACT",
        "contract_id": CONTRACT_ID,
        "definition_version": DEFINITION_VERSION,
        "why_this_file_exists": (
            "V3 R0 requires that a dropped invariant be recorded as dropped rather than silently "
            "omitted. This file is that record. It is a CONTRACT artifact: it describes what v2 "
            "says about each v1 case, and carries no status, no evidence and no verdict -- the "
            "explanations here are about the CONTRACT, not about a measurement."),
        "totals": {
            "v1_cases": len(v1_ids),
            "v2_cases": len(cases),
            "by_treatment": dict(Counter(r["treatment"] for r in provenance_rows)),
            "carried_verbatim": sorted(r["v1_case_id"] for r in provenance_rows
                                       if r["treatment"] == VERBATIM),
            "rewritten": sorted(r["v1_case_id"] for r in provenance_rows
                                if r["treatment"] == REWRITTEN),
            "split": sorted(r["v1_case_id"] for r in provenance_rows if r["treatment"] == SPLIT),
            "not_claimed": sorted(r["v1_case_id"] for r in provenance_rows
                                  if r["treatment"] == NOT_CLAIMED),
            "oracles_changed": sorted(r["v1_case_id"] for r in provenance_rows
                                      if r["oracle_changed"]),
            "untreated": [],
            "v2_only_cases": sorted(c["id"] for c in cases if c["id"] not in v1_set),
        },
        "rule": ("Every v1 case is EMITTED, because the generator iterates the frozen v1 cases. "
                 "A silent drop is therefore impossible by construction. Every case whose oracle "
                 "text differs from v1 appears in `decisions` below with a reason; a changed "
                 "oracle with no recorded decision fails the build, and so does a decision that "
                 "claims a rewrite the text does not make."),
        "decisions": provenance_rows,
        "v2_requirements_without_a_v1_case": U_REQUIREMENTS_WITHOUT_A_V1_CASE,
        "unresolved_counts": [
            {"what": "ID-05 `as never` occurrence count",
             "v1_note_says": 475,
             "d4_scanner_says": 488,
             "delta": 13,
             "status": "NOT RECONCILED -- the two counts may use different scanners. v2 states no "
                       "count, so v2 cannot inherit an unreconciled number."},
        ],
        "v1_contradiction_preserved": {
            "cases": ["CMP-04", "CMP-13"],
            "statement": ("v1 requires `pwsh` present (CMP-04) and absent (CMP-13) on one catalog. "
                          "v1 keeps both, and its CMP-04 FAIL / CMP-13 PASS pair is the record that "
                          "the spec and the deployment diverged. v2 rewrites CMP-04 only."),
            "v1_verdicts_unchanged": {
                "CMP-04": live_cases["CMP-04"]["status"],
                "CMP-13": live_cases["CMP-13"]["status"],
            },
        },
    }

    if args.check:
        for path, want in ((DEFINITION, definition), (PROVENANCE, provenance)):
            if not path.is_file():
                print(f"build-v2-definition: {path} does not exist", file=sys.stderr)
                return 2
            have = json.loads(path.read_text(encoding="utf-8"))
            if have != want:
                print(f"build-v2-definition: {path.name} is STALE -- regenerate it", file=sys.stderr)
                return 2
        print(f"build-v2-definition: {DEFINITION.name} and {PROVENANCE.name} are current "
              f"({len(cases)} cases, {len(provenance_rows)} recorded decisions)")
        return 0

    # WRITTEN WITH LF ENDINGS, deliberately, and this is not cosmetic.
    # `.gitattributes` declares `*.json text eol=lf` while core.autocrlf is true, so a
    # file written with CRLF endings is stored as LF in git. The FIRST build of this
    # file had 1244 CRLF pairs on disk, which made its digest depend on the checkout
    # that computed it -- the same defect that left three v1 evidence entries
    # unreproducible. Writing LF and hashing LF-normalised makes the digest the same
    # everywhere. `newline="\n"` is what enforces it; a plain write on Windows uses
    # os.linesep.
    DEFINITION.write_text(json.dumps(definition, indent=2, ensure_ascii=False) + "\n",
                          encoding="utf-8", newline="\n")
    PROVENANCE.write_text(json.dumps(provenance, indent=2, ensure_ascii=False) + "\n",
                          encoding="utf-8", newline="\n")

    print(f"definition  {DEFINITION.name}  {len(cases)} cases  sha256={sha256_file(DEFINITION)}")
    print(f"provenance  {PROVENANCE.name}  {len(provenance_rows)} v1 cases recorded")
    print(f"  verbatim={len(provenance['totals']['carried_verbatim'])} "
          f"rewritten={len(provenance['totals']['rewritten'])} "
          f"split={len(provenance['totals']['split'])} "
          f"not_claimed={len(provenance['totals']['not_claimed'])}")
    print(f"  oracles actually changed: {provenance['totals']['oracles_changed']}")
    print(f"  v2-only cases: {provenance['totals']['v2_only_cases']}")
    print(f"  V3 section-U requirements with no v1 case: "
          f"{len(U_REQUIREMENTS_WITHOUT_A_V1_CASE)} (recorded, NOT invented)")
    return 0


def family_order(family: str) -> int:
    order = ["IDENTITY", "COMPOSITION", "IPYTHON", "NATIVE BRIDGE", "DATA", "RECOVERY",
             "FILESYSTEM", "CONCURRENCY", "VERIFICATION", "RESEARCH", "CACHE/OBSERVABILITY"]
    return order.index(family) if family in order else len(order)


def rewrite(cid: str, v1: dict[str, Any]) -> tuple[str, str, str]:
    """The rewritten oracle, requirement and stimulus for a v1 case."""
    if cid == "CMP-04":
        return (
            "The model-visible tool surface is intact and named, and the tool count is MEASURED "
            "AND RECORDED IN THE EVIDENCE rather than pinned in this oracle. The catalog for one "
            "real Session, measured through a probe that INSERTS NO TOOL ROW, must show `ipython` "
            "present, `work` present, `pwsh` absent, `error` null, and `presetRoots` naming the "
            "home that was actually booted. A catalog measured through a verification overlay "
            "that inserts the tool row does NOT establish this case. The measured count is "
            "recorded verbatim in the evidence, together with the full measured name set, so a "
            "change in composition is VISIBLE as a diff without being a failure of this case. "
            "A pinned integer is deliberately NOT a pass condition here: the v1 oracle pinned "
            "`toolCountAgentKey is 28`, and that pin -- not the product -- is what created v1's "
            "contradiction with CMP-13.",
            "the model-visible tool surface is intact and named",
            "Boot the real profile from a cwd unrelated to the profile directory, using a probe "
            "that adds NO row, and read the model-visible catalog for one real session. Record "
            "the count and the full name set verbatim.",
        )
    if cid == "IPY-15":
        return (
            "The transport is IPC or TCP with CurveZMQ keys and encryption required; a "
            "plaintext-TCP start is recorded as a FINDING and is NOT PASS. An over-limit frame is "
            "REFUSED in both directions -- the encoder refuses to emit it and the decoder refuses "
            "on the DECLARED length before buffering -- and the refusal is a structured, "
            "machine-readable outcome naming the byte limit in force and the declared length that "
            "exceeded it. The kernel remains usable after the refusal. An over-limit frame that "
            "is silently dropped, silently truncated, or presented as empty output is NOT PASS. "
            "A `droppedFrames`-style drop-and-continue counter is explicitly NOT required: a "
            "failed transport is a failed OPERATION, not a partial successful observation.",
            "the kernel transport is authenticated and frames are bounded",
            "Read the transport facts for a live kernel (transport kind, encryption, connection-file "
            "permissions) and send an over-limit frame in each direction; then send a normal cell "
            "and record whether the kernel is still usable.",
        )
    if cid == "REC-09":
        return (
            "One of two arms must hold, and the record must say WHICH. ARM A (the guarantee is "
            "claimed): the authoritative write REFUSES the stale-generation settlement, the "
            "refusal is retained as diagnostic evidence rather than discarded, and the comparison "
            "happens inside the same durable update that releases the reservation. ARM B (the "
            "guarantee is NOT claimed): the record states that stale-generation settlement is not "
            "claimed, names the TOPOLOGY FACT that makes it physically impossible, and the case "
            "is filed NOT_CLAIMED -- never PASS. A settlement from a superseded generation that "
            "LANDS while the deployment claims the guarantee is NOT PASS. Filing ARM B without "
            "naming the topology fact is NOT PASS either: NOT_CLAIMED is a statement about the "
            "deployment, so it carries the same burden of proof as a claim.",
            "a stale epoch cannot write authority",
            "After a restart, have an old worker submit a settlement carrying its old epoch. If "
            "no such worker can exist, state the topology fact that makes it impossible instead "
            "of constructing one.",
        )
    if cid == "REC-10":
        return (
            "WHEN the deployment claims stale-generation settlement (REC-09 ARM A), the guard is "
            "reachable from at least one non-test production path, demonstrated by a call graph "
            "or a live boot rather than by the guard's own unit test, and an epoch field that "
            "nothing reads or writes after initialisation is INERT and is NOT PASS. WHEN the "
            "deployment does not claim it (REC-09 ARM B), the guard is DELETED and this case is "
            "NOT_CLAIMED, naming the topology fact -- an unreachable guard left in the tree is "
            "NOT PASS in either arm, because a mechanism the product cannot reach is the defect "
            "class this project has recorded more than twelve times.",
            "the epoch guard is reachable from a production path whenever the guard exists",
            "Trace the guard that rejects a stale-epoch settlement from the entry point a real "
            "host uses, or record that the deployment makes no such claim and the guard is gone.",
        )
    if cid == "ID-05":
        return (
            "The clean tree exits 0 and the injected error makes the compile FAIL. A green run "
            "under `tsconfig.json` alone is NOT PASS, because that config excludes the test "
            "files. TWO IDIOMS ARE NAMED so this clause is decidable without a judgement call: "
            "(a) `ctx.plugin(plugin as never, cfg as never)` -- the cast on the PLUGIN argument is "
            "noise, because `ctx.plugin(plugin, cfg)` compiles clean; (b) "
            "`ctx.plugin(Storage, {} as never)` -- in CONFIG position the cast MASKS a true "
            "diagnostic (`Argument of type '{}' is not assignable to parameter of type "
            "'undefined'`), and the argument should be OMITTED. A config-position `as never` is "
            "NOT PASS. `as never` must NEVER be replaced by `as any`, which trades a visible cast "
            "for an invisible one. No non-null `!` may be used to hide a genuinely undefined "
            "value; no private symbol may be deep-imported across a package boundary.",
            "public export boundary compiles under the strict config, with no cast hiding an "
            "undefined value",
            "Compile all production packages and tests with `tsconfig.check.json` (the config "
            "that INCLUDES `src/**/*.test.ts`), then inject one type error into a test file and "
            "recompile. Then scan for `as never` in both plugin and config position.",
        )
    raise AssertionError(f"no rewrite defined for {cid}")


def split_acquisition(cid: str, v1: dict[str, Any]) -> tuple[str, str, str]:
    assert cid == "DATA-09"
    return (
        "Every ACQUISITION gap -- a gap in what the world or the capture path actually gave us -- "
        "appears in `acquisition.gaps` with its stage from the closed set `provider-acquisition`, "
        "`native-acquisition`, `transform`, `retention`, plus a recovery from "
        "`page`/`refetch`/`none`/`unknown`. A loss at one of those four stages that is not "
        "recorded as a gap is NOT PASS. TWO STAGES ARE DELIBERATELY ABSENT FROM THIS SET and "
        "their absence is the point: `model-projection` is not an acquisition gap but a "
        "projection choice, and is measured by DATA-13 as a ProjectionManifest; `transport` is "
        "not an acquisition gap because the product REJECTS an over-limit frame before any "
        "successful value exists, so there is no partial success to attribute. Recording a "
        "deliberate projection as a loss, or inventing a partial-success transport to have "
        "something to attribute, is NOT PASS.",
        "every ACQUISITION gap is attributed to a stage",
        "Produce captures that lose bytes at known stages: provider cap, native tool cap, a "
        "lossy transform, and a storage refusal.",
    )


def projection_manifest_case(known: set[str]) -> dict[str, Any]:
    oracle = (
        "A deliberate reduction of complete data before the model sees it is recorded as a "
        "`ProjectionManifest` carrying: `sourceRef` (what complete thing was projected), "
        "`selected` and `omitted` counts or bytes, a `recoverable` ref when the omitted part is "
        "recoverable, and a `projectionReason` from a closed set naming WHY. The manifest must "
        "not appear in `acquisition.gaps`: a deliberate projection is NOT a loss, and recording "
        "one as a loss makes an honest system look broken and a broken system look honest. An "
        "intentional projection that is recorded nowhere is NOT PASS. A projection whose "
        "`recoverable` ref does not actually resolve is NOT PASS. This case is the projection "
        "half of v1's DATA-09, which conflated the two."
    )
    return {
        "id": "DATA-13",
        "family": "DATA",
        "requirement": "an intentional model projection is recorded as a manifest, not as a loss",
        "stimulus": "Project a complete capture down to what the model will see, then read the "
                    "projection record and try to resolve the omitted part through the ref it names.",
        "oracle": oracle,
        "mandatory": True,
        "dependencies": ["DATA-09"],
        "definition_version": DEFINITION_VERSION,
    }


if __name__ == "__main__":
    sys.exit(main())
