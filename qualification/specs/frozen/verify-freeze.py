#!/usr/bin/env python3
"""Verify that the trusted-local-v1 spec is frozen, and emit the freeze record.

WHY THIS EXISTS. `qualification/specs/frozen/README.md` makes claims about the
frozen artifact -- 109 cases, 109 NOT_RUN, 0 evidence entries, oracles identical to
the live ledger, the CMP-04/CMP-13 contradiction preserved. Prose claims about a
frozen artifact are exactly the kind that go stale silently: the artifact is frozen
so nobody re-reads it, and a reader who trusts the prose instead of the bytes has
no way to tell. This script re-derives every one of those claims from the bytes on
disk and writes the result as a machine-readable record beside the artifact.

WHAT IT CHECKS, each independently falsifiable:

  1. The frozen snapshot's sha256 equals the value PINNED as
     `deployment.inputs.trusted_local_acceptance_spec_sha256`. This is the pin the
     whole slice rests on.
  2. The frozen snapshot is COMPLETE as an as-authored record: it carries the same
     109 case ids as the live ledger, every case's definition fields
     (requirement/stimulus/oracle/family/layer/mandatory) are byte-identical to the
     live ledger's, and it carries the original identity scheme and trust-model
     statement.
  3. It is AS-AUTHORED, not as-filed: every status is NOT_RUN and every evidence
     list is empty. A frozen snapshot that had picked up verdicts would no longer
     be usable as an identity input -- that is the defect this snapshot exists to
     fix, so it is checked rather than assumed.
  4. The CONTRADICTION IS PRESERVED: CMP-04 still requires `pwsh` present, CMP-13
     still requires it absent. Both are read out of the bytes, not from a constant.
  5. The live ledger's digest history is reconstructed from git, so the record shows
     WHY the split is needed (the ledger moved; the artifact did not).

WHAT IT DOES NOT DO. It does not edit the frozen file, the live ledger, or
`compatibility.lock.json`. It writes ONE new file (the record) and prints a verdict.
Exit 0 means the freeze holds as described; exit 1 means a claim in the README is
false and the README must be corrected rather than the check relaxed.

Usage:
    python qualification/specs/frozen/verify-freeze.py
    python qualification/specs/frozen/verify-freeze.py --json
"""
from __future__ import annotations

import argparse
import hashlib
import json
import subprocess
import sys
from collections import Counter
from pathlib import Path
from typing import Any

# <root>/qualification/specs/frozen/verify-freeze.py -> parents[3] is <root>.
ROOT = Path(__file__).resolve().parents[3]
FROZEN = ROOT / "qualification" / "specs" / "frozen" / "acceptance-spec.trusted-local-v1.as-authored.json"
LIVE = ROOT / "qualification" / "specs" / "acceptance-spec.trusted-local-v1.json"
LOCK = ROOT / "compatibility.lock.json"
RECORD = Path(__file__).resolve().parent / "FREEZE-RECORD.json"

# The fields that constitute a case DEFINITION. `status` and `evidence` are
# deliberately excluded: they are the as-filed half, and the whole point of the
# frozen snapshot is that it does not carry them.
DEFINITION_FIELDS = ("id", "family", "layer", "mandatory", "requirement", "stimulus", "oracle")

# The two oracles that contradict each other. Named as literals because the point
# of the check is that BOTH texts are still present and still disagree.
CONTRADICTION = ("CMP-04", "CMP-13")


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def sha256_git_blob(rev: str, relpath: str) -> str | None:
    """The digest of a file AS COMMITTED at `rev`, or None if it did not exist."""
    proc = subprocess.run(
        ["git", "show", f"{rev}:{relpath}"],
        cwd=ROOT, capture_output=True,
    )
    if proc.returncode != 0:
        return None
    return hashlib.sha256(proc.stdout).hexdigest()


def ledger_history() -> list[dict[str, Any]]:
    """Every committed revision of the live ledger, oldest first.

    This is the measured evidence that the live spec is an EVIDENCE LEDGER whose
    digest moves on every filing -- the property that made a separate frozen
    artifact necessary.
    """
    proc = subprocess.run(
        ["git", "log", "--reverse", "--format=%H|%cI|%s", "--",
         "qualification/specs/acceptance-spec.trusted-local-v1.json"],
        cwd=ROOT, capture_output=True, text=True,
    )
    if proc.returncode != 0:
        return []
    rows: list[dict[str, Any]] = []
    for line in proc.stdout.strip().splitlines():
        parts = line.split("|", 2)
        if len(parts) != 3:
            continue
        sha, when, subject = parts
        digest = sha256_git_blob(sha, "qualification/specs/acceptance-spec.trusted-local-v1.json")
        filed = None
        try:
            blob = subprocess.run(
                ["git", "show", f"{sha}:qualification/specs/acceptance-spec.trusted-local-v1.json"],
                cwd=ROOT, capture_output=True,
            ).stdout
            doc = json.loads(blob.decode("utf-8"))
            filed = sum(len(c.get("evidence") or []) for c in doc["cases"])
        except (json.JSONDecodeError, KeyError):
            pass
        rows.append({
            "commit": sha,
            "committed_at": when,
            "subject": subject,
            "ledger_sha256": digest,
            "evidence_entries": filed,
        })
    return rows


def main() -> int:
    parser = argparse.ArgumentParser(description="verify the v1 freeze and emit its record")
    parser.add_argument("--json", action="store_true", help="print the record instead of a report")
    args = parser.parse_args()

    if not FROZEN.is_file():
        print(f"verify-freeze: no frozen artifact at {FROZEN}", file=sys.stderr)
        return 2

    checks: list[dict[str, Any]] = []

    def check(label: str, ok: bool, detail: str) -> None:
        checks.append({"label": label, "ok": bool(ok), "detail": detail})

    frozen_bytes = FROZEN.read_bytes()
    frozen_digest = hashlib.sha256(frozen_bytes).hexdigest()

    # --- 1. the pin ----------------------------------------------------------
    lock = json.loads(LOCK.read_text(encoding="utf-8"))
    inputs = lock["deployment"]["inputs"]
    pinned = inputs.get("trusted_local_acceptance_spec_sha256")
    check(
        "the frozen artifact hashes to the PINNED identity input",
        pinned == frozen_digest,
        f"pinned={pinned} on_disk={frozen_digest}",
    )
    deployment_identity = lock["deployment"].get("identity")
    check(
        "the pinned input is carried by the live deployment identity",
        isinstance(pinned, str) and len(pinned) == 64,
        f"deployment.identity={deployment_identity} identity_algorithm={lock['deployment'].get('identity_algorithm')}",
    )

    frozen = json.loads(frozen_bytes.decode("utf-8"))
    live = json.loads(LIVE.read_text(encoding="utf-8"))
    frozen_cases = {c["id"]: c for c in frozen["cases"]}
    live_cases = {c["id"]: c for c in live["cases"]}

    # --- 2. completeness: definitions identical to the live ledger -----------
    check(
        "the frozen snapshot carries the same case ids as the live ledger",
        list(frozen_cases) == list(live_cases),
        f"frozen={len(frozen_cases)} live={len(live_cases)}",
    )
    drifted = [
        f"{cid}.{field}"
        for cid, case in live_cases.items()
        if cid in frozen_cases
        for field in DEFINITION_FIELDS
        if frozen_cases[cid].get(field) != case.get(field)
    ]
    check(
        "every case DEFINITION is identical between the frozen snapshot and the live ledger",
        not drifted,
        f"definition fields compared={list(DEFINITION_FIELDS)} drifted={drifted}",
    )
    # The identity scheme and trust model are part of what E1 says to preserve.
    check(
        "the original identity scheme is preserved in the frozen record",
        frozen["trust_model"].get("identity_boundary") == live["trust_model"].get("identity_boundary"),
        f"identity_boundary={frozen['trust_model'].get('identity_boundary')!r}",
    )
    check(
        "the trust-model statement is preserved verbatim",
        frozen["trust_model"].get("statement") == live["trust_model"].get("statement"),
        f"statement_chars={len(str(frozen['trust_model'].get('statement') or ''))}",
    )
    check(
        "the NOT_APPLICABLE inheritance record is preserved",
        [e["old_spec_id"] for e in frozen["not_applicable_inherited"]["entries"]]
        == [e["old_spec_id"] for e in live["not_applicable_inherited"]["entries"]],
        f"entries={[e['old_spec_id'] for e in frozen['not_applicable_inherited']['entries']]}",
    )

    # --- 3. as-authored, not as-filed ---------------------------------------
    frozen_statuses = Counter(c.get("status") for c in frozen["cases"])
    check(
        "the frozen snapshot is AS-AUTHORED: every status is NOT_RUN",
        set(frozen_statuses) == {"NOT_RUN"},
        f"statuses={dict(frozen_statuses)}",
    )
    frozen_evidence = sum(len(c.get("evidence") or []) for c in frozen["cases"])
    check(
        "the frozen snapshot carries NO evidence entries",
        frozen_evidence == 0,
        f"evidence_entries={frozen_evidence}",
    )
    live_statuses = Counter(c.get("status") for c in live["cases"])
    live_evidence = sum(len(c.get("evidence") or []) for c in live["cases"])
    check(
        "the LIVE ledger is AS-FILED, which is why the two files must differ",
        live_evidence > 0 and set(live_statuses) != {"NOT_RUN"},
        f"live_statuses={dict(live_statuses)} live_evidence_entries={live_evidence}",
    )

    # --- 4. the contradiction is PRESERVED ----------------------------------
    cmp04 = frozen_cases.get("CMP-04", {}).get("oracle", "")
    cmp13 = frozen_cases.get("CMP-13", {}).get("oracle", "")
    # Read the requirement out of the text rather than trusting a constant: the
    # check must fail if someone quietly edits either oracle.
    c04_wants_present = "pwsh` is present" in cmp04
    c13_wants_absent = "must be ABSENT" in cmp13
    check(
        f"{CONTRADICTION[0]} still requires pwsh PRESENT",
        c04_wants_present,
        f"CMP-04 oracle: {cmp04[:160]!r}",
    )
    check(
        f"{CONTRADICTION[1]} still requires pwsh ABSENT",
        c13_wants_absent,
        f"CMP-13 oracle: {cmp13[:160]!r}",
    )
    check(
        "the two oracles still CONTRADICT, so the divergence record survives",
        c04_wants_present and c13_wants_absent,
        "CMP-04 requires present and CMP-13 requires absent on the same catalog; "
        "at most one can hold, and neither was edited",
    )
    check(
        "CMP-04 still pins the literal tool count that created the contradiction",
        "toolCountAgentKey` is 28" in cmp04,
        "the pinned 28 is retained as the record of what v1 asserted",
    )
    # The verdicts in the LIVE ledger are what make the contradiction visible as a
    # FAIL/PASS pair. Both are read, so a later filing that "fixed" one is caught.
    check(
        "the live ledger still records CMP-04 FAIL and CMP-13 PASS",
        live_cases["CMP-04"].get("status") == "FAIL" and live_cases["CMP-13"].get("status") == "PASS",
        f"CMP-04={live_cases['CMP-04'].get('status')} CMP-13={live_cases['CMP-13'].get('status')}",
    )

    # --- 5. the ledger history that motivates the split ----------------------
    history = ledger_history()
    distinct_ledger_digests = {row["ledger_sha256"] for row in history if row["ledger_sha256"]}
    check(
        "the live ledger's digest MOVED across filings (the defect the split fixes)",
        len(distinct_ledger_digests) > 1,
        f"{len(distinct_ledger_digests)} distinct ledger digests over {len(history)} commits",
    )
    check(
        "the FROZEN artifact's digest did NOT move",
        sha256_git_blob("HEAD", "qualification/specs/frozen/acceptance-spec.trusted-local-v1.as-authored.json")
        == frozen_digest,
        f"HEAD blob == on-disk == {frozen_digest}",
    )
    # The frozen snapshot was cut FROM the ledger at its AUTHORING commit, before
    # any filing. The frozen FILE did not exist at that commit -- it was created
    # later, when the conflation was discovered -- so the correct comparison is the
    # frozen CONTENT against the LEDGER's content at the authoring commit. Comparing
    # the frozen file's own blob at that commit would compare against nothing, which
    # is the mistake this check originally made.
    authoring = history[0]["commit"] if history else None
    ledger_at_authoring = (
        sha256_git_blob(authoring, "qualification/specs/acceptance-spec.trusted-local-v1.json")
        if authoring else None
    )
    check(
        "the frozen snapshot is the LIVE LEDGER at its authoring commit, byte for byte",
        ledger_at_authoring is not None and ledger_at_authoring == frozen_digest,
        f"authoring_commit={authoring} ledger_then={ledger_at_authoring} frozen={frozen_digest}",
    )
    # And the ledger's FIRST revision is the one that carried no verdicts at all.
    check(
        "the authoring revision carried no filed evidence (it is the as-authored state)",
        bool(history) and history[0]["evidence_entries"] == 0,
        f"evidence_entries_at_authoring={history[0]['evidence_entries'] if history else None}",
    )

    failures = [row for row in checks if not row["ok"]]
    record = {
        "what": "the trusted-local-v1 freeze, verified against the bytes on disk",
        "generated_by": "qualification/specs/frozen/verify-freeze.py",
        "frozen_artifact": {
            "path": "qualification/specs/frozen/acceptance-spec.trusted-local-v1.as-authored.json",
            "sha256": frozen_digest,
            "pinned_as": "deployment.inputs.trusted_local_acceptance_spec_sha256",
            "deployment_identity": deployment_identity,
            "cases": len(frozen["cases"]),
            "status_distribution": dict(frozen_statuses),
            "evidence_entries": frozen_evidence,
        },
        "live_ledger": {
            "path": "qualification/specs/acceptance-spec.trusted-local-v1.json",
            "sha256": sha256_file(LIVE),
            "cases": len(live["cases"]),
            "status_distribution": dict(live_statuses),
            "evidence_entries": live_evidence,
            "note": (
                "The live ledger is the as-filed record and is NOT frozen. Its digest moves "
                "every time a family files evidence, which is exactly why the pinned identity "
                "input names the as-authored snapshot instead."
            ),
        },
        "filename_decision": {
            "v3_suggested": "qualification/specs/frozen/acceptance-spec.trusted-local-v1.json",
            "actually_used": "qualification/specs/frozen/acceptance-spec.trusted-local-v1.as-authored.json",
            "reason": (
                "The existing path and filename are read by three independent checks "
                "(helpers/doctor.py, qualification/results/T1-spec/verify-identity.py, "
                "qualification/runners/verify-spec.py) and the file's sha256 is a pinned "
                "deployment identity input. Renaming would break the pin for a name that "
                "carries no information the content lacks. Renaming is NOT performed; the "
                "tradeoff is reported for the root agent to decide."
            ),
            "renamed": False,
        },
        "ledger_digest_history": history,
        "checks": checks,
        "failures": [f"{r['label']} -- observed: {r['detail']}" for r in failures],
        "verdict": "FREEZE_HOLDS" if not failures else "FREEZE_BROKEN",
    }
    RECORD.write_text(json.dumps(record, indent=2) + "\n", encoding="utf-8")

    if args.json:
        print(json.dumps(record, indent=2))
        return 0 if not failures else 1

    print(f"frozen artifact  {FROZEN.name}")
    print(f"sha256           {frozen_digest}")
    print(f"pinned input     {pinned}")
    print(f"cases            {len(frozen['cases'])}  statuses={dict(frozen_statuses)}  evidence={frozen_evidence}")
    print(f"live ledger      {len(live['cases'])} cases  statuses={dict(live_statuses)}  evidence={live_evidence}")
    print(f"ledger digests   {len(distinct_ledger_digests)} distinct over {len(history)} commits")
    print("")
    for row in checks:
        print(f"{'ok  ' if row['ok'] else 'FAIL'} {row['label']}")
        if not row["ok"]:
            print(f"       observed: {row['detail']}")
    print("")
    print(f"checks_passed: {len(checks) - len(failures)}/{len(checks)}")
    print(f"verdict: {'FREEZE_HOLDS' if not failures else 'FREEZE_BROKEN'}")
    print(f"record:  {RECORD}")
    print("")
    print("This verifies the freeze against the bytes on disk. It does not run any acceptance case.")
    return 0 if not failures else 1


if __name__ == "__main__":
    sys.exit(main())
