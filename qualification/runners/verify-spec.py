"""Verify the trusted-local acceptance spec's evidence, and refuse to be lenient.

WHY THIS EXISTS. Ten agents are filing evidence into
`qualification/specs/acceptance-spec.trusted-local-v1.json` in parallel, and until
this file existed NOTHING read it back. A spec whose cases are marked PASS by the
same agent that ran the measurement, with no independent check that the evidence
file exists, hashes correctly, and is recorded under the current identity, is a
spec that records claims rather than verifying them. This is the independent half.

WHAT IT ENFORCES, each taken from the spec's own stated rules:
  1. Every case id is unique and matches its family prefix.
  2. Every case's `status` is in the declared vocabulary.
  3. No case in `cases` is NOT_APPLICABLE (the spec forbids it explicitly; the
     five inherited isolation gates live in `not_applicable_inherited`, which is
     not a case list).
  4. A case with status PASS has at least one evidence entry, and every entry
     names a file that EXISTS under the repository and whose recorded sha256
     MATCHES the file on disk. A PASS whose evidence moved is not a PASS.
  5. Every evidence path is repo-relative and lives under qualification/results/,
     so evidence cannot point outside the recorded tree.
  6. The evidence was filed under the CURRENT deployment identity: the runner
     takes the identity from compatibility.lock.json and requires each evidence
     entry to carry it, when the entry records an identity at all.
  7. A case with status NOT_RUN or BLOCKED_EXTERNAL has NO evidence, and a case
     with FAIL has a reason recorded somewhere in its evidence or note. The point
     is that the status and the artifacts agree.

WHAT IT DOES NOT DO. It does not judge whether an oracle was established. It
cannot: that is a reading of the evidence, and a script that claimed to decide it
would be a second oracle. It checks the MECHANICAL properties -- existence, hash,
identity, status/artifact agreement -- which is the part that can be checked
without interpretation, and which is exactly the part that gets skipped when a
result is written up in a hurry.

Exit codes:
    0  every check passed
    1  at least one problem
    2  the invocation or a required file is unusable

Usage:
    python qualification/runners/verify-spec.py [--quiet] [--summary]
"""
from __future__ import annotations

import argparse
import hashlib
import json
import pathlib
import sys
from collections import Counter

ROOT = pathlib.Path(__file__).resolve().parents[2]
SPEC = ROOT / "qualification" / "specs" / "acceptance-spec.trusted-local-v1.json"
LOCK = ROOT / "compatibility.lock.json"

VOCABULARY = {"NOT_RUN", "RUNNING", "PASS", "FAIL", "BLOCKED_EXTERNAL", "NOT_APPLICABLE"}
EVIDENCE_ROOT = "qualification/results/"


def sha256_file(path: pathlib.Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def main() -> int:
    parser = argparse.ArgumentParser(description="verify the trusted-local spec's evidence")
    parser.add_argument("--quiet", action="store_true")
    parser.add_argument("--summary", action="store_true", help="print only per-family counts")
    args = parser.parse_args()

    if not SPEC.is_file():
        print(f"verify-spec: no spec at {SPEC}", file=sys.stderr)
        return 2
    try:
        spec = json.loads(SPEC.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        print(f"verify-spec: the spec is unreadable: {exc}", file=sys.stderr)
        return 2

    identity = None
    if LOCK.is_file():
        try:
            identity = json.loads(LOCK.read_text(encoding="utf-8"))["deployment"]["identity"]
        except (OSError, KeyError, json.JSONDecodeError):
            identity = None

    cases = spec.get("cases") or []
    problems: list[str] = []

    # The declared family counts must sum to the number of cases, or one of the
    # two is wrong and a reader comparing them would be misled either way.
    declared_counts = spec.get("family_counts") or {}
    if declared_counts:
        declared_total = sum(declared_counts.values())
        if declared_total != len(cases):
            problems.append(
                f"family_counts sums to {declared_total} but there are {len(cases)} cases")
        actual = Counter(c.get("id", "?").split("-")[0] for c in cases)
        for prefix, count in declared_counts.items():
            if actual.get(prefix, 0) != count:
                problems.append(
                    f"family_counts says {prefix}={count} but {actual.get(prefix, 0)} "
                    "cases carry that prefix")

    if args.summary:
        counts = Counter(c.get("status") for c in cases)
        by_family: dict[str, Counter] = {}
        for c in cases:
            by_family.setdefault(c.get("family", "?"), Counter())[c.get("status")] += 1
        print(f"identity {str(identity)[:16]}...  total {len(cases)}")
        for family in sorted(by_family):
            row = by_family[family]
            parts = ", ".join(f"{k}={v}" for k, v in sorted(row.items()))
            print(f"  {family:22s} {parts}")
        print("  " + ", ".join(f"{k}={v}" for k, v in sorted(counts.items())))
        return 0

    # --- 1/2/3. shape, vocabulary, and the NOT_APPLICABLE prohibition ---------
    seen: set[str] = set()
    for case in cases:
        cid = case.get("id")
        if not isinstance(cid, str) or not cid:
            problems.append(f"a case has no id: {json.dumps(case)[:120]}")
            continue
        if cid in seen:
            problems.append(f"{cid}: duplicate case id")
        seen.add(cid)

        status = case.get("status")
        if status not in VOCABULARY:
            problems.append(f"{cid}: status {status!r} is not in the declared vocabulary")
        if status == "NOT_APPLICABLE":
            problems.append(
                f"{cid}: NOT_APPLICABLE is forbidden for any case in `cases`; "
                "the inherited isolation gates belong in not_applicable_inherited")

        # The spec's case_shape says "family prefix + 2-digit ordinal", and
        # `family_counts` IS the prefix->count map, so the prefix is checked
        # against that rather than against the family's descriptive name. An
        # earlier version of this check compared the prefix to the family string
        # and reported all 109 cases as wrong, because the family is named
        # "CONCURRENCY" while its prefix is "CAP" -- the check was broken, not
        # the spec.
        prefix = cid.split("-")[0]
        declared = spec.get("family_counts") or {}
        if prefix not in declared:
            problems.append(
                f"{cid}: id prefix {prefix!r} is not one of the declared "
                f"family prefixes {sorted(declared)}")

    # --- 4/5/6. evidence exists, hashes, and is under the recorded root -------
    for case in cases:
        cid = case.get("id", "?")
        status = case.get("status")
        evidence = case.get("evidence") or []
        if not isinstance(evidence, list):
            problems.append(f"{cid}: evidence is not a list")
            continue

        if status == "PASS" and not evidence:
            problems.append(f"{cid}: PASS with no evidence entry")

        for entry in evidence:
            if not isinstance(entry, dict):
                problems.append(f"{cid}: an evidence entry is not an object: {entry!r}")
                continue
            rel = entry.get("path")
            recorded = entry.get("sha256")
            if not isinstance(rel, str) or not rel:
                problems.append(f"{cid}: an evidence entry has no path")
                continue
            # 5. repo-relative, under qualification/results/
            normalized = rel.replace("\\", "/")
            if normalized.startswith("/") or ":" in normalized.split("/")[0]:
                problems.append(f"{cid}: evidence path is not repo-relative: {rel}")
            if not normalized.startswith(EVIDENCE_ROOT):
                problems.append(
                    f"{cid}: evidence path is outside {EVIDENCE_ROOT}: {rel}")
            path = ROOT / normalized
            if not path.is_file():
                problems.append(f"{cid}: evidence file does not exist: {rel}")
                continue
            actual = sha256_file(path)
            if not isinstance(recorded, str) or len(recorded) != 64:
                problems.append(f"{cid}: evidence entry for {rel} has no usable sha256")
            elif actual != recorded:
                problems.append(
                    f"{cid}: evidence {rel} hashes to {actual[:16]}... "
                    f"but the case records {recorded[:16]}...")
            # 6. the identity, when the entry records one
            entry_identity = entry.get("identity") or entry.get("deployment_identity")
            if isinstance(entry_identity, str) and identity and entry_identity != identity:
                problems.append(
                    f"{cid}: evidence was filed under identity {entry_identity[:16]}... "
                    f"but the lock's identity is {identity[:16]}...")

    # --- 7. status and artifacts agree ---------------------------------------
    for case in cases:
        cid = case.get("id", "?")
        status = case.get("status")
        evidence = case.get("evidence") or []
        if status in ("NOT_RUN", "BLOCKED_EXTERNAL") and evidence:
            problems.append(
                f"{cid}: status {status} but {len(evidence)} evidence entry/entries "
                "-- a non-verdict should carry none")
        if status == "FAIL":
            # A FAIL is a legitimate deliverable, and it must say why. Accept the
            # reason in the case's own note OR in the evidence it names.
            note = str(case.get("note") or "")
            if not note and not evidence:
                problems.append(
                    f"{cid}: FAIL with no note and no evidence -- a failure must be "
                    "explainable by a reader")

    # --- report --------------------------------------------------------------
    counts = Counter(c.get("status") for c in cases)
    if not args.quiet:
        print(f"spec      {SPEC.name}")
        print(f"identity  {str(identity)[:16]}..." if identity else "identity  (no lock)")
        print(f"cases     {len(cases)}")
        print("  " + ", ".join(f"{k}={v}" for k, v in sorted(counts.items())))
        print("")

    if problems:
        print(f"verify-spec: {len(problems)} problem(s).")
        for problem in problems[:80]:
            print(f"  - {problem}")
        if len(problems) > 80:
            print(f"  ... and {len(problems) - 80} more")
        return 1

    print("verify-spec: every recorded status agrees with its evidence.")
    print("This checks existence, hashes, identity and status/artifact agreement.")
    print("It does NOT judge whether an oracle was established -- that is a reading.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
