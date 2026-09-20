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
     with status FAIL has a reason recorded somewhere in its evidence or note. The
     point is that the status and the artifacts agree.
  8. A case with status FLAKY carries the record of its instability (evidence or a
     note naming it). FLAKY is a VERDICT about observed mixed results, so it must
     be as explainable to a reader as a FAIL.

WHAT IT DOES NOT DO. It does not judge whether an oracle was established. It
cannot: that is a reading of the evidence, and a script that claimed to decide it
would be a second oracle. It checks the MECHANICAL properties -- existence, hash,
identity, status/artifact agreement -- which is the part that can be checked
without interpretation, and which is exactly the part that gets skipped when a
result is written up in a hurry.

It also does not decide whether the candidate may be RELEASED. That is
`release-gate.py`'s job, and the two are deliberately separate files: this one
answers "is the recorded evidence well-formed and bound to this identity?", the
other answers "may this exact candidate ship?". A single tool answering both would
have to be lenient about one of them.

--------------------------------------------------------------------------------
THE ONE-ValidationResult RULE (V5 §4.1), WHICH IS WHY THIS FILE WAS REWRITTEN
--------------------------------------------------------------------------------

This file used to do this:

    if args.summary:
        counts = Counter(...)
        print(...)
        return 0                      # <-- BEFORE all validation
    # ...full validation happens here, 317 problems found, exit 1

Measured on 2e1b2c2: `--summary` exited **0** while the full path exited **1**
with **317 problems**. The summary was not WRONG about what it printed -- the
tally really was 95 PASS / 13 FAIL / 1 BLOCKED_EXTERNAL -- but it printed a
PASS-shaped line and exited 0 while 317 binding problems existed. A CI step or a
reader that runs `--summary` gets a green light and stops. The `0` is what a gate
consumer reads, and it was the number that lied. The trap was silent in the
direction that matters: nothing distinguished "no problems" from "problems not
looked for on this path".

The structure is now the one V5 §4.1 requires:

    result = validate_everything(...)     # ONE result, all checks, always run
    render_full(result) | render_summary(result)
    return result.exit_code

Both renderers consume the SAME `ValidationResult`. Neither can return early,
because neither performs any validation at all: all checking happens in
`validate_everything`, before any renderer is chosen. The only way to reach a
renderer is to have already validated everything.

Both renderers also emit the same machine-readable first line,
`VALIDATION=PASS|FAIL|CANNOT_RUN`, so a consumer that greps for one string gets
the same answer from either. A summary showing case counts while validation fails
begins with `VALIDATION=FAIL` and exits nonzero.

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
from dataclasses import dataclass, field

ROOT = pathlib.Path(__file__).resolve().parents[2]
SPEC = ROOT / "qualification" / "specs" / "acceptance-spec.trusted-local-v1.json"
LOCK = ROOT / "compatibility.lock.json"

# `FLAKY` is a RELEASE-BLOCKING verdict, not a soft PASS (V5 §4.4). It is in this
# vocabulary because a case whose runs disagreed is a fact about the candidate that
# has to be recordable; `release-gate.py` is what refuses to release on it.
#
# `INVALIDATED` is the identity-move verdict: evidence that was valid under a
# superseded deployment identity and has not been re-measured. `release-gate.py`
# refuses to release on it too.
VOCABULARY = {
    "NOT_RUN", "RUNNING", "PASS", "FAIL", "BLOCKED_EXTERNAL", "NOT_APPLICABLE",
    "FLAKY", "INVALIDATED",
}
# Statuses that are a statement about a MEASUREMENT, and therefore must be
# explainable: a reader has to be able to see why. A non-verdict must carry no
# evidence at all (rule 7).
VERDICT_STATUSES = {"PASS", "FAIL", "FLAKY"}
NON_VERDICT_STATUSES = {"NOT_RUN", "BLOCKED_EXTERNAL", "RUNNING"}
EVIDENCE_ROOT = "qualification/results/"


def sha256_file(path: pathlib.Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


@dataclass
class ValidationResult:
    """The ONE result both renderers consume. Holds no rendering logic at all.

    `cannot_run_reason` is what makes exit 2 reachable through the same object
    rather than through a second early-return path -- a second path is how the
    original defect got in.
    """

    spec_name: str = "(unknown)"
    identity: str | None = None
    case_count: int = 0
    status_counts: Counter = field(default_factory=Counter)
    by_family: dict = field(default_factory=dict)
    problems: list = field(default_factory=list)
    cannot_run_reason: str | None = None

    @property
    def exit_code(self) -> int:
        if self.cannot_run_reason is not None:
            return 2
        return 1 if self.problems else 0

    @property
    def verdict(self) -> str:
        if self.cannot_run_reason is not None:
            return "CANNOT_RUN"
        return "FAIL" if self.problems else "PASS"

    @property
    def machine_line(self) -> str:
        """The line both renderers print first, so a consumer cannot tell them apart."""
        return (
            f"VALIDATION={self.verdict} problems={len(self.problems)} "
            f"cases={self.case_count} identity={str(self.identity)[:16]}"
        )


def _check_family_counts(spec: dict, cases: list, problems: list) -> None:
    """The declared family counts must sum to the number of cases.

    Otherwise one of the two is wrong and a reader comparing them would be misled
    either way.
    """
    declared_counts = spec.get("family_counts") or {}
    if not declared_counts:
        return
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


def _check_shape_vocabulary_and_prefixes(spec: dict, cases: list, problems: list) -> None:
    """Rules 1/2/3: unique ids, declared vocabulary, no NOT_APPLICABLE case."""
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


def _check_evidence(
    cases: list, problems: list, identity: str | None, root: pathlib.Path,
) -> None:
    """Rules 4/5/6: evidence exists, hashes, and is under the recorded root."""
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
            path = root / normalized
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


def _check_status_artifact_coherence(cases: list, problems: list) -> None:
    """Rule 7/8: the status and the artifacts agree."""
    for case in cases:
        cid = case.get("id", "?")
        status = case.get("status")
        evidence = case.get("evidence") or []
        if status in NON_VERDICT_STATUSES and evidence:
            problems.append(
                f"{cid}: status {status} but {len(evidence)} evidence entry/entries "
                "-- a non-verdict should carry none")
        if status in VERDICT_STATUSES and status != "PASS":
            # A FAIL or a FLAKY is a legitimate deliverable, and it must say why.
            # Accept the reason in the case's own note OR in the evidence it names.
            note = str(case.get("note") or "")
            if not note and not evidence:
                problems.append(
                    f"{cid}: {status} with no note and no evidence -- a {status} must be "
                    "explainable by a reader")


def validate_everything(
    spec_path: pathlib.Path = SPEC,
    lock_path: pathlib.Path = LOCK,
    root: pathlib.Path = ROOT,
) -> ValidationResult:
    """Run EVERY check and return ONE result. This is the only checker.

    Nothing here renders, and nothing here returns early: a caller gets a result
    describing all problems, whether it intends to print a summary or a full
    report. That is what makes the two renderers equivalent as gates.
    """
    result = ValidationResult()

    if not spec_path.is_file():
        result.cannot_run_reason = f"no spec at {spec_path}"
        return result
    try:
        spec = json.loads(spec_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        result.cannot_run_reason = f"the spec is unreadable: {exc}"
        return result

    result.spec_name = spec_path.name

    identity = None
    if lock_path.is_file():
        try:
            identity = json.loads(lock_path.read_text(encoding="utf-8"))["deployment"]["identity"]
        except (OSError, KeyError, json.JSONDecodeError):
            identity = None
    result.identity = identity

    cases = spec.get("cases") or []
    if not isinstance(cases, list):
        result.cannot_run_reason = "the spec's `cases` is not a list"
        return result
    result.case_count = len(cases)

    problems: list[str] = []
    _check_family_counts(spec, cases, problems)
    _check_shape_vocabulary_and_prefixes(spec, cases, problems)
    _check_evidence(cases, problems, identity, root)
    _check_status_artifact_coherence(cases, problems)
    result.problems = problems

    result.status_counts = Counter(c.get("status") for c in cases)
    by_family: dict[str, Counter] = {}
    for c in cases:
        by_family.setdefault(c.get("family", "?"), Counter())[c.get("status")] += 1
    result.by_family = by_family
    return result


def render_summary(result: ValidationResult) -> None:
    """Per-family counts. Consumes the SAME result the full renderer does.

    The first line is always the machine-readable verdict, so a reader or a CI
    step that only looks at the counts still sees the failure on line 1.
    """
    print(result.machine_line)
    if result.cannot_run_reason is not None:
        print(f"verify-spec: cannot run: {result.cannot_run_reason}", file=sys.stderr)
        return
    for family in sorted(result.by_family):
        row = result.by_family[family]
        parts = ", ".join(f"{k}={v}" for k, v in sorted(row.items()))
        print(f"  {family:22s} {parts}")
    print("  " + ", ".join(f"{k}={v}" for k, v in sorted(result.status_counts.items())))
    if result.problems:
        print(f"verify-spec: {len(result.problems)} problem(s) -- the counts above are NOT a "
              "verdict; run without --summary to see them.")


def render_full(result: ValidationResult, quiet: bool = False) -> None:
    """The full report. Consumes the SAME result the summary renderer does."""
    print(result.machine_line)
    if result.cannot_run_reason is not None:
        print(f"verify-spec: cannot run: {result.cannot_run_reason}", file=sys.stderr)
        return

    if not quiet:
        print(f"spec      {result.spec_name}")
        print(f"identity  {str(result.identity)[:16]}..." if result.identity
              else "identity  (no lock)")
        print(f"cases     {result.case_count}")
        print("  " + ", ".join(f"{k}={v}" for k, v in sorted(result.status_counts.items())))
        print("")

    if result.problems:
        print(f"verify-spec: {len(result.problems)} problem(s).")
        for problem in result.problems[:80]:
            print(f"  - {problem}")
        if len(result.problems) > 80:
            print(f"  ... and {len(result.problems) - 80} more")
        return

    print("verify-spec: every recorded status agrees with its evidence.")
    print("This checks existence, hashes, identity and status/artifact agreement.")
    print("It does NOT judge whether an oracle was established -- that is a reading.")


def main() -> int:
    parser = argparse.ArgumentParser(description="verify the trusted-local spec's evidence")
    parser.add_argument("--quiet", action="store_true")
    parser.add_argument("--summary", action="store_true", help="print only per-family counts")
    args = parser.parse_args()

    # ONE validation, always, before any renderer is chosen. There is no path from
    # argument parsing to a renderer that skips this call.
    result = validate_everything()

    if args.summary:
        render_summary(result)
    else:
        render_full(result, quiet=args.quiet)

    return result.exit_code


if __name__ == "__main__":
    sys.exit(main())
