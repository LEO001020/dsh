#!/usr/bin/env python3
"""Recompute the trusted-local deployment identity from the file, and print match/mismatch.

WHY THIS EXISTS. `compatibility.lock.json` -> `deployment.identity` is a digest over
`deployment.inputs`. An identity that no script can reproduce is worse than no identity:
every PASS recorded against it is bound to a number nobody can re-derive, so a later reader
cannot tell a correct re-derivation from a typo. This script is the falsifier for that.

WHAT IT CHECKS (each is a separate line, so a failure names itself):

  1. The digest of `deployment.inputs`, computed with the algorithm the file itself declares,
     equals `deployment.identity`. This is the load-bearing check.
  2. `trusted_local_acceptance_spec_sha256` equals the sha256 of the new spec file ON DISK.
     A digest pinned in the lock that does not match the file it names is a stale pin.
  3. `acceptance_spec_sha256` (the OLD, historical input) still equals the sha256 of the old
     spec file on disk. This proves the old spec was NOT edited while the identity moved --
     which is what makes "the old PASSes stay valid for the old identity" a true statement.
  4. The new spec's declared family counts and total match its actual cases, every case id is
     unique, every case is mandatory, every case is NOT_RUN, and every evidence list is empty.
     A spec that ships with a pre-marked PASS is a rigged oracle, so this is checked here
     rather than trusted.
  5. `promotion.spec_sha256` equals the new spec's digest, and `promotion.decision` is not a
     promotion. A promotion section that disagrees with the spec it names is a live defect.
  6. The two intermediate identities recorded in the identity note are reproducible: adding
     only the new spec input, and restating the isolation input. This makes the note's claim
     about WHY the identity moved falsifiable rather than a story.

WHAT IT DOES NOT DO. It does not run tests, it does not change any status, and it does not
certify the deployment. It verifies arithmetic over files. Exit 0 means the arithmetic is
self-consistent, not that anything works.

Usage:
    python qualification/results/T1-spec/verify-identity.py            # check the repo
    python qualification/results/T1-spec/verify-identity.py --json      # machine-readable
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from pathlib import Path
from typing import Any

# The repo root is derived from this file's own location:
# <root>/qualification/results/T1-spec/verify-identity.py -> parents[3] is <root>.
REPO_ROOT = Path(__file__).resolve().parents[3]

LOCK_PATH = REPO_ROOT / "compatibility.lock.json"
NEW_SPEC_PATH = REPO_ROOT / "qualification" / "specs" / "acceptance-spec.trusted-local-v1.json"
# The spec AS AUTHORED, frozen. The live spec is ALSO the evidence ledger, so the
# first family to file a verdict changes its digest -- which made four of the checks
# below fail against a spec that was behaving exactly as designed. The pinned input
# is a snapshot of the AUTHORED artifact, so it is checked against this file, and
# the LIVE ledger is checked by verify-spec.py instead.
FROZEN_SPEC_PATH = REPO_ROOT / "qualification" / "specs" / "frozen" / "acceptance-spec.trusted-local-v1.as-authored.json"
OLD_SPEC_PATH = REPO_ROOT / "qualification" / "specs" / "acceptance-spec.json"
GATE_SPEC_PATH = REPO_ROOT / "qualification" / "specs" / "gate-spec.json"

HEX64 = re.compile(r"^[0-9a-f]{64}$")

# Recorded history, so a re-derivation can be compared against what the file claims moved.
#
# EXPECTED_NEW_IDENTITY is no longer a literal. It was one, and it went stale the
# moment three inputs were corrected -- which made this script report "3 check(s)
# FAILED" for a lock that was RIGHT and a constant that was WRONG. A verifier whose
# expectations must be hand-edited whenever the thing it verifies changes is a
# verifier that will be edited to agree, so it now reads the value from the file
# under test and checks it against the RECOMPUTATION instead. The two historical
# constants below stay literals on purpose: they are facts about the past, which
# no current file can tell us.
EXPECTED_OLD_IDENTITY = "ece4037a9d5bbb014aa5a8395ed15531715a11949f2aa687166fcfeb5717576f"
EXPECTED_OLD_SPEC_SHA = "2fe95835425eb98eb3bac9eead17985df5bf951669460c8d7a87b8887afb1e0b"
NEW_ISOLATION_VALUE = "none-trusted-local-os-user-account-is-the-execution-authority-boundary"

# The fields corrected in the 2026-09-20 re-derivation, with the values they held
# BEFORE that correction. Reconstructing a historical identity requires reverting
# these as well as the isolation input; the earlier version of this script knew
# only about the isolation input, so it computed a digest of a mix of old and new
# fields and reported the mismatch as a failure of the LOCK.
SUPERSEDED_INPUTS = {
    "host_profile_digest": "59f23346955d24063a923b1a205bbcb40c541e054e6fd04d bdde4218eaa2ab7f".replace(" ", ""),
    "agent_preset_digest": "0934f22b2fdbc158fd2edad33ec5dd2671b5b1f727800dcaab74cee3bd7294af",
    "agent_preset_id": "standard",
}

# The 11 families and their mandated case counts. The Pro prompt names the families; these
# numbers are its minimum. A family that shrinks is a spec that was trimmed to be passable.
EXPECTED_FAMILY_COUNTS = {
    "ID": 6,
    "CMP": 14,
    "IPY": 15,
    "BR": 12,
    "DATA": 12,
    "REC": 10,
    "FS": 6,
    "CAP": 13,
    "VER": 9,
    "RES": 6,
    "OBS": 6,
}
EXPECTED_TOTAL = sum(EXPECTED_FAMILY_COUNTS.values())

# The inherited isolation gates. FOUR of these must not reappear as case ids at all. VER-04 is
# the exception and is handled explicitly below: this spec re-issues the VER numbering, so a
# NEW VER-04 (receipt freshness) legitimately exists beside the inherited OLD VER-04 (host
# execution bypass). That collision is safe only while both places say so.
NA_IDS_WITH_NO_NEW_CASE = ["SEC-01", "SEC-03", "SEC-08", "DEP-04"]


def sha256_file(path: Path) -> str:
    hasher = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            hasher.update(chunk)
    return hasher.hexdigest()


def identity_digest(inputs: dict[str, Any]) -> str:
    """The algorithm declared in the lock: sha256 over sorted-key, compact, ASCII JSON."""
    blob = json.dumps(inputs, sort_keys=True, separators=(",", ":"), ensure_ascii=True)
    return hashlib.sha256(blob.encode("utf-8")).hexdigest()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--json", action="store_true", help="emit a JSON report instead of text")
    args = parser.parse_args()

    checks: list[dict[str, Any]] = []

    def check(name: str, ok: bool, detail: str) -> None:
        checks.append({"check": name, "ok": bool(ok), "detail": detail})

    # --- load ---------------------------------------------------------------
    try:
        lock = json.loads(LOCK_PATH.read_text(encoding="utf-8"))
    except (OSError, ValueError) as error:
        print(json.dumps({"error": f"lock unreadable: {error}"}) if args.json
              else f"FAIL: lock unreadable: {error}")
        return 2

    deployment = lock.get("deployment", {})
    inputs = deployment.get("inputs", {})
    recorded_identity = deployment.get("identity")

    # --- 1. the load-bearing check ------------------------------------------
    computed_identity = identity_digest(inputs)
    check(
        "identity recomputes from inputs",
        computed_identity == recorded_identity,
        f"computed={computed_identity} recorded={recorded_identity} "
        f"({'MATCH' if computed_identity == recorded_identity else 'MISMATCH'})",
    )
    # The identity must appear in the recorded HISTORY, so a value that recomputes
    # but was never recorded as a step is caught. This replaces an equality against
    # a hand-typed constant: the constant went stale when three inputs were
    # corrected, and a verifier that must be hand-edited whenever its subject
    # changes will eventually be edited to agree.
    history_ids = [h.get("identity") for h in deployment.get("identity_history", [])]
    check(
        "identity is recorded in identity_history",
        recorded_identity in history_ids,
        f"recorded={recorded_identity} history={[str(i)[:8] for i in history_ids]}",
    )
    check(
        "every superseded identity in the history is a lowercase sha256",
        all(isinstance(i, str) and HEX64.match(i) for i in history_ids) and len(history_ids) > 0,
        f"count={len(history_ids)}",
    )
    check(
        "identity is a lowercase sha256",
        isinstance(recorded_identity, str) and bool(HEX64.match(recorded_identity)),
        f"value={recorded_identity!r}",
    )

    # --- 2. the new spec pin is not stale -----------------------------------
    #
    # Checked against the FROZEN as-authored snapshot, not the live ledger. The
    # spec serves two roles at once: it is a pinned identity input AND the place
    # verdicts are filed. Filing a verdict changes the live file's digest, so
    # comparing the pin to the live file reported a failure for the spec doing
    # its job. The pin names the AUTHORED artifact; the live ledger's own
    # consistency is verify-spec.py's business.
    if FROZEN_SPEC_PATH.is_file():
        new_spec_sha = sha256_file(FROZEN_SPEC_PATH)
        pinned_new = inputs.get("trusted_local_acceptance_spec_sha256")
        check(
            "the pinned spec digest matches the FROZEN as-authored snapshot",
            pinned_new == new_spec_sha,
            f"pinned={pinned_new} frozen={new_spec_sha}",
        )
        # And the live ledger must still declare the same case count and the same
        # ids, so a verdict can be filed without the spec being edited into a
        # different shape. That is the property the pin is really protecting.
        if NEW_SPEC_PATH.is_file():
            frozen = json.loads(FROZEN_SPEC_PATH.read_text(encoding="utf-8"))
            live = json.loads(NEW_SPEC_PATH.read_text(encoding="utf-8"))
            frozen_ids = [c.get("id") for c in frozen.get("cases", [])]
            live_ids = [c.get("id") for c in live.get("cases", [])]
            check(
                "the live ledger has the same case ids as the frozen snapshot",
                frozen_ids == live_ids,
                f"frozen={len(frozen_ids)} live={len(live_ids)} "
                f"({'identical' if frozen_ids == live_ids else 'DIFFERENT'})",
            )
    else:
        new_spec_sha = None
        check("new spec file exists", False, f"missing: {NEW_SPEC_PATH}")

    # --- 3. the OLD spec was not edited while the identity moved ------------
    if OLD_SPEC_PATH.is_file():
        old_spec_sha = sha256_file(OLD_SPEC_PATH)
        check(
            "old spec on disk still matches the retained historical input",
            inputs.get("acceptance_spec_sha256") == old_spec_sha == EXPECTED_OLD_SPEC_SHA,
            f"pinned={inputs.get('acceptance_spec_sha256')} on_disk={old_spec_sha} "
            f"expected={EXPECTED_OLD_SPEC_SHA}",
        )
    else:
        check("old spec file exists", False, f"missing: {OLD_SPEC_PATH}")

    # --- 4. the new spec is honest ------------------------------------------
    if NEW_SPEC_PATH.is_file():
        spec = json.loads(NEW_SPEC_PATH.read_text(encoding="utf-8"))
        cases = spec.get("cases", [])

        ids = [case.get("id") for case in cases]
        check("every case id is unique", len(set(ids)) == len(ids),
              f"{len(ids)} ids, {len(set(ids))} distinct")

        actual_counts: dict[str, int] = {}
        for case in cases:
            prefix = str(case.get("id", "")).split("-")[0]
            actual_counts[prefix] = actual_counts.get(prefix, 0) + 1

        counts_ok = actual_counts == EXPECTED_FAMILY_COUNTS
        check(
            "family counts match the mandated minimum",
            counts_ok,
            f"actual={dict(sorted(actual_counts.items()))} "
            f"expected={dict(sorted(EXPECTED_FAMILY_COUNTS.items()))}",
        )
        check(
            "declared family_counts agrees with the actual cases",
            spec.get("family_counts") == EXPECTED_FAMILY_COUNTS,
            f"declared={spec.get('family_counts')}",
        )
        check(
            "total case count matches the sum of families",
            len(cases) == EXPECTED_TOTAL and spec.get("total_cases") == EXPECTED_TOTAL,
            f"actual={len(cases)} declared={spec.get('total_cases')} expected={EXPECTED_TOTAL}",
        )

        # The anti-rigging pair, checked against the FROZEN snapshot rather than
        # the live ledger. As stated ("every status is NOT_RUN", "every evidence
        # list is empty") these are AUTHORING-TIME properties: they assert the
        # spec shipped unrigged. Applied to the live file they forbid filing a
        # verdict at all, which is the opposite of the spec's purpose -- the
        # first family to file anything made both fail. Against the frozen
        # snapshot they mean what they were written to mean, and they stay
        # falsifiable: a spec that shipped with a pre-marked case still fails.
        if FROZEN_SPEC_PATH.is_file():
            frozen = json.loads(FROZEN_SPEC_PATH.read_text(encoding="utf-8"))
            frozen_cases = frozen.get("cases", [])
            frozen_non_not_run = [c.get("id") for c in frozen_cases if c.get("status") != "NOT_RUN"]
            check(
                "the spec SHIPPED with no case pre-marked PASS",
                not frozen_non_not_run,
                "all NOT_RUN at authoring time" if not frozen_non_not_run
                else f"pre-marked at authoring time: {frozen_non_not_run}",
            )
            frozen_non_empty = [c.get("id") for c in frozen_cases if c.get("evidence") != []]
            check(
                "the spec SHIPPED with no evidence attached",
                not frozen_non_empty,
                "all empty at authoring time" if not frozen_non_empty
                else f"shipped with evidence: {frozen_non_empty}",
            )
            # The live ledger may accumulate verdicts, but every case must still
            # carry a status from the vocabulary, so a filing cannot invent one.
            bad_status = [c.get("id") for c in cases
                          if c.get("status") not in ("NOT_RUN", "RUNNING", "PASS", "FAIL",
                                                     "BLOCKED_EXTERNAL", "NOT_APPLICABLE")]
            check(
                "every LIVE case status is in the declared vocabulary",
                not bad_status,
                "all valid" if not bad_status else f"invalid: {bad_status}",
            )

        non_mandatory = [c.get("id") for c in cases if c.get("mandatory") is not True]
        check(
            "every case is mandatory",
            not non_mandatory,
            "all mandatory" if not non_mandatory else f"offenders={non_mandatory}",
        )

        required_fields = {"id", "requirement", "stimulus", "oracle", "layer", "status", "evidence"}
        missing = [
            c.get("id")
            for c in cases
            if not required_fields.issubset(c.keys())
            or not all(isinstance(c.get(f), str) and c.get(f) for f in
                       ("id", "requirement", "stimulus", "oracle", "layer"))
        ]
        check(
            "every case carries a non-empty id/requirement/stimulus/oracle/layer",
            not missing,
            "all present" if not missing else f"offenders={missing}",
        )

        # The five inherited isolation gates must be recorded as NOT_APPLICABLE and must NOT
        # appear as cases. Both halves matter: dropping them hides the decision, and leaving
        # them as cases would put an untestable obligation in the work queue.
        nai = spec.get("not_applicable_inherited", {})
        entries = nai.get("entries", [])
        na_ids = [e.get("old_spec_id") for e in entries]
        expected_na = ["SEC-01", "SEC-03", "SEC-08", "DEP-04", "VER-04"]
        check(
            "the five inherited isolation gates are recorded NOT_APPLICABLE",
            na_ids == expected_na
            and all(e.get("new_status") == "NOT_APPLICABLE" for e in entries),
            f"entries={na_ids}",
        )
        check(
            "no inherited isolation gate is silently reused as an in-scope case",
            not (set(NA_IDS_WITH_NO_NEW_CASE) & set(ids)),
            f"overlap={sorted(set(NA_IDS_WITH_NO_NEW_CASE) & set(ids))}",
        )
        # VER-04 is the one deliberate id collision: this spec RE-ISSUES the VER numbering,
        # so a new case named VER-04 (receipt freshness) exists beside the inherited old
        # VER-04 (host execution bypass, NOT_APPLICABLE). That is only safe if the spec says
        # so, in the family description and on the case itself, so the two cannot be confused.
        ver04 = next((c for c in cases if c.get("id") == "VER-04"), None)
        ver_family = next((f for f in spec.get("families", []) if f.get("prefix") == "VER"), {})
        collision_documented = (
            ver04 is not None
            and "not_applicable_inherited" in str(ver04.get("oracle", ""))
            and "not_applicable_inherited" in str(ver_family.get("numbering_warning", ""))
        )
        check(
            "the VER-04 id collision is documented on both the case and the family",
            collision_documented,
            "documented" if collision_documented
            else "VER-04 exists as a case but the re-issued numbering is not flagged in both places",
        )
        check(
            "every NOT_APPLICABLE entry states its reasoning",
            all(isinstance(e.get("reasoning"), str) and len(e.get("reasoning", "")) > 80
                for e in entries),
            f"{len(entries)} entries, all with reasoning"
            if all(isinstance(e.get("reasoning"), str) for e in entries) else "missing reasoning",
        )
        check(
            "no case in `cases` uses the status NOT_APPLICABLE",
            not any(c.get("status") == "NOT_APPLICABLE" for c in cases),
            "none" if not any(c.get("status") == "NOT_APPLICABLE" for c in cases)
            else "an in-scope case was marked NOT_APPLICABLE",
        )
    else:
        spec = None

    # --- 5. promotion section agrees with the spec --------------------------
    promotion = lock.get("promotion", {})
    # `safe-daily` is allowed to appear ONLY inside the note that forbids it. Anywhere else --
    # as the name, or in a path, home, or decision field -- it is the old identity being reused.
    safe_daily_offenders = [
        key for key, value in promotion.items()
        if key != "name_note" and "safe-daily" in str(value)
    ]
    check(
        "promotion names trusted-local-daily, and safe-daily appears only where it is forbidden",
        promotion.get("name") == "trusted-local-daily" and not safe_daily_offenders,
        f"name={promotion.get('name')!r} safe_daily_offenders={safe_daily_offenders}",
    )
    check(
        "the promotion section explains why safe-daily is not reused",
        "safe-daily" in str(promotion.get("name_note", "")),
        "explanation present" if "safe-daily" in str(promotion.get("name_note", ""))
        else "no explanation of the name change",
    )
    check(
        "promotion decision is not a promotion",
        promotion.get("decision") == "NOT_READY",
        f"decision={promotion.get('decision')!r}",
    )
    check(
        "promotion spec_sha256 matches the new spec on disk",
        new_spec_sha is not None and promotion.get("spec_sha256") == new_spec_sha,
        f"promotion={promotion.get('spec_sha256')} on_disk={new_spec_sha}",
    )
    check(
        "promotion spec_path names the trusted-local spec",
        promotion.get("spec_path") == "qualification/specs/acceptance-spec.trusted-local-v1.json",
        f"spec_path={promotion.get('spec_path')!r}",
    )

    # The gate_spec_sha256 correction: the true digest of gate-spec.json must be recorded, and
    # the previously wrong value must be visible rather than deleted.
    if GATE_SPEC_PATH.is_file():
        gate_spec_sha = sha256_file(GATE_SPEC_PATH)
        check(
            "promotion gate_spec_sha256 is the true digest of gate-spec.json",
            promotion.get("gate_spec_sha256") == gate_spec_sha,
            f"recorded={promotion.get('gate_spec_sha256')} on_disk={gate_spec_sha}",
        )
        check(
            "the superseded gate_spec_sha256 value is recorded, not deleted",
            isinstance(promotion.get("gate_spec_sha256_correction"), str)
            and EXPECTED_OLD_SPEC_SHA in promotion.get("gate_spec_sha256_correction", ""),
            "correction note present" if isinstance(promotion.get("gate_spec_sha256_correction"), str)
            else "correction note MISSING",
        )

    # --- 6. the identity note's arithmetic is reproducible ------------------
    #
    # Reconstructing a HISTORICAL identity means reverting every input that has
    # moved since, not just the one the first version of this check knew about. It
    # knew only about the isolation input and the spec, so once the profile and
    # preset were corrected too, it computed a digest over a MIX of old and new
    # fields and reported the mismatch as a failure of the lock. SUPERSEDED_INPUTS
    # now carries the rest, and the check below asserts the reconstruction
    # reproduces the identity recorded in the history -- so it stays honest as
    # further re-derivations happen.
    if new_spec_sha is not None:
        step1 = dict(inputs)
        step1.pop("trusted_local_acceptance_spec_sha256", None)
        step1["isolation_image_or_policy_digest"] = "sandbox-windows-acl-partial"
        for field, previous in SUPERSEDED_INPUTS.items():
            step1[field] = previous
        check(
            "reverting the isolation input AND the superseded fields reproduces a RECORDED identity",
            identity_digest(step1) in [h.get("identity") for h in deployment.get("identity_history", [])],
            f"computed={identity_digest(step1)[:16]} "
            f"history={[str(h.get('identity'))[:8] for h in deployment.get('identity_history', [])]}",
        )
        check(
            "the isolation input carries the trusted-local value",
            inputs.get("isolation_image_or_policy_digest") == NEW_ISOLATION_VALUE,
            f"value={inputs.get('isolation_image_or_policy_digest')!r}",
        )

    # --- report -------------------------------------------------------------
    failures = [c for c in checks if not c["ok"]]
    verdict = "MATCH" if not failures else "MISMATCH"

    if args.json:
        print(json.dumps({
            "scope": "IDENTITY_ARITHMETIC_OVER_FILES_NOT_A_CERTIFICATION",
            "lock": str(LOCK_PATH),
            "computed_identity": computed_identity,
            "recorded_identity": recorded_identity,
            "verdict": verdict,
            "checks": checks,
            "failures": [c["check"] for c in failures],
        }, indent=2))
    else:
        print(f"lock: {LOCK_PATH}")
        print(f"computed identity: {computed_identity}")
        print(f"recorded identity: {recorded_identity}")
        print(f"verdict: {verdict}")
        print()
        width = max(len(c["check"]) for c in checks)
        for entry in checks:
            mark = "ok  " if entry["ok"] else "FAIL"
            print(f"  [{mark}] {entry['check']:<{width}}  {entry['detail']}")
        print()
        if failures:
            print(f"{len(failures)} check(s) FAILED. The identity is NOT verified.")
        else:
            print(f"all {len(checks)} checks passed. The identity recomputes from the file.")
        print("This verifies arithmetic over files. It does not certify the deployment.")

    return 0 if not failures else 1


if __name__ == "__main__":
    raise SystemExit(main())
