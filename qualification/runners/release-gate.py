"""The release decision: may THIS exact candidate ship?

WHY THIS IS A SEPARATE FILE FROM `verify-spec.py` (V5 §4.2).

`verify-spec.py` answers ONE question: *is the recorded evidence well-formed and
bound to this identity?* It checks schema, evidence path, hash, identity binding
and status/evidence coherence. It deliberately does NOT judge whether an oracle was
established, and it does not decide whether the candidate may ship.

This file answers the OTHER question: *may this exact candidate be released?* The
two are separate because they fail for different reasons and have different owners:

  * `verify-spec` fails when a hash is wrong -- a FILING error, fixable by
    re-filing evidence, and it says nothing about the product;
  * `release-gate` fails when the candidate is not releasable -- no FAIL, no FLAKY,
    no NOT_RUN, no INVALIDATED, no stale evidence, no unauthorized BLOCKED_EXTERNAL,
    fresh identity, and post-integration assembled-product evidence.

A single tool answering both would have to be lenient about one of them. That is
exactly how the `--summary` false green came to exist: one file, two questions, and
a path that answered the easy one. So the release decision is its own program, it
consumes `verify-spec`'s result rather than re-implementing its checks, and it can
be pointed at a candidate by identity.

WHAT IT CHECKS, and the failure each check rules out:

  1. `verify-spec` PASSES. Rules out: releasing on evidence that is unreadable,
     mis-hashed, or filed under a different deployment. A release gate that ran its
     own weaker copy of these checks would drift from them.
  2. THE IDENTITY IS FRESH. The lock's recorded identity must equal the identity
     recomputed from the tree. Rules out: shipping the artifact the evidence
     describes while the tree has moved on -- the "stale evidence" case V5 §23
     names, and the reason identity exists at all. Measured on this tree: the
     recorded identity is `533c8cb0…` and the recomputed one is `709a0fce…`, so this
     check FAILS today, correctly.
  3. NO FAIL. Rules out: releasing with a known-broken mandatory case.
  4. NO FLAKY (V5 §4.4). Read from the append-only stability ledger, so a green
     rerun cannot clear it. Rules out: majority-vote release, and "it passed the
     second time".
  5. NO NOT_RUN among mandatory cases. Rules out: silence reading as green. A case
     nobody ran has no verdict.
  6. NO INVALIDATED. Rules out: counting evidence that a previous identity move
     superseded as if it were current.
  7. NO STALE EVIDENCE. Every evidence path exists and hashes. Rules out: an
     artifact edited after its digest was filed.
  8. ONLY EXPLICITLY ALLOWLISTED BLOCKED_EXTERNAL. A case may stay blocked ONLY
     when it is named in the allowlist below AND the allowlist's stated
     authorization condition still holds. Rules out: a blocked case being quietly
     tolerated because it was blocked last time -- the allowlist is a list of
     REASONS, and each one is re-checked against the lock rather than trusted.
  9. POST-INTEGRATION ASSEMBLED-PRODUCT EVIDENCE. At least one case whose oracle
     requires the ASSEMBLED product (layer T2/T3/T4/T6 -- a real boot, real disk,
     real processes) must carry evidence produced at the current identity.
     Rules out: the measured failure this whole slice exists for -- a correct gate
     landed at 19:03:03, offending files merged at 19:10:27, nobody re-ran the
     gate, and the defect was found after publication by a post-hoc audit.

WHAT IT DOES NOT DO. It does not run the product, boot anything, or decide whether
an oracle was established. It reads recorded verdicts and refuses to release unless
they are current, complete, and green. A green release-gate is a statement that the
RECORD is releasable, not that the product is correct -- and the record is only as
good as the oracles in it, which this file cannot judge.

Exit codes, matching verify-spec's convention so a caller can treat them alike:
    0  the candidate may be released
    1  it may not; the reasons are printed
    2  the gate could not run (missing lock, unreadable spec, missing dependency)

Usage:
    python qualification/runners/release-gate.py [--json] [--quiet]
    python qualification/runners/release-gate.py --candidate <identity>
"""
from __future__ import annotations

import argparse
import importlib.util
import json
import pathlib
import sys
from dataclasses import dataclass, field

ROOT = pathlib.Path(__file__).resolve().parents[2]
SPEC = ROOT / "qualification" / "specs" / "acceptance-spec.trusted-local-v1.json"
LOCK = ROOT / "compatibility.lock.json"

# --------------------------------------------------------------------------------
# THE BLOCKED_EXTERNAL ALLOWLIST. Each entry is a REASON with a CONDITION, not a
# permanent excuse: `condition` is re-evaluated against the lock on every run, so
# when the authorization flips the entry stops applying by itself. An allowlist of
# bare case ids would be a list of permissions; this is a list of justifications.
# --------------------------------------------------------------------------------
BLOCKED_EXTERNAL_ALLOWLIST: dict[str, dict] = {
    "IPY-08": {
        "reason": (
            "IPY-08 needs a live provider driving a real continuation: the oracle is "
            "that a natural activation end either rebinds the kernel to the continuing "
            "session or states the epoch loss explicitly, and neither can be observed "
            "without a live model. The case's own oracle text says it is expected "
            "BLOCKED_EXTERNAL while live_provider_budget_authorized is false."),
        "condition": ("runtime_authorization", "live_provider_budget_authorized", False),
    },
}

# Layers whose oracle requires the ASSEMBLED product rather than a unit under test.
# T0 is a pure function and T1 is services with a mock provider: neither can show
# that the assembled product works, so neither satisfies check 9.
ASSEMBLED_PRODUCT_LAYERS = {"T2", "T3", "T4", "T6"}

# Statuses that are a verdict about the CANDIDATE and therefore block a release.
BLOCKING_STATUSES = {"FAIL", "FLAKY", "INVALIDATED"}


def _load_sibling(name: str, filename: str, base: pathlib.Path | None = None):
    """Import a module by path, registering it so @dataclass can resolve.

    `base` defaults to the runners directory; `rederive-identity.py` lives under
    `helpers/` instead, so the caller passes ROOT and a repo-relative path.
    """
    path = (base / filename) if base is not None else (ROOT / "qualification" / "runners" / filename)
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


def _lock_condition_holds(lock: dict, condition: tuple) -> bool:
    """Re-evaluate one allowlist condition against the lock."""
    section, key, expected = condition
    actual = (lock.get(section) or {}).get(key)
    return actual == expected


def _recompute_identity(lock: dict) -> tuple[str | None, list[str]]:
    """Recompute the deployment identity from the tree.

    Delegates to `helpers/rederive-identity.py`, which owns the file-input map. A
    second copy of that map here would drift from the one `doctor.py` uses, and the
    drift would be invisible because both would agree with themselves.
    """
    rederive = _load_sibling("rederive_identity", "rederive-identity.py", base=ROOT / "helpers")
    try:
        recorded_inputs = (lock.get("deployment") or {}).get("inputs") or {}
        if not recorded_inputs:
            return None, ["the lock carries no deployment.inputs"]
        recomputed = dict(recorded_inputs)
        for name, rel in rederive.FILE_INPUTS.items():
            if name not in recomputed:
                continue
            path = rederive.ROOT / rel
            if path.exists():
                recomputed[name] = rederive.sha256_file(path)
        launcher_rel = recorded_inputs.get(rederive.LAUNCHER_INPUT)
        if launcher_rel and pathlib.Path(launcher_rel).exists():
            recomputed[rederive.ARTIFACT_INPUT] = rederive.sha256_file(
                pathlib.Path(launcher_rel))
        return rederive.identity_digest(recomputed), []
    except Exception as exc:                       # noqa: BLE001 -- reported, not swallowed
        return None, [f"the identity could not be recomputed: {exc}"]


@dataclass
class ReleaseDecision:
    """The ONE decision object. Both renderers consume it; nothing else computes it."""

    releasable: bool = False
    cannot_run_reason: str | None = None
    candidate_identity: str | None = None
    recorded_identity: str | None = None
    recomputed_identity: str | None = None
    identity_fresh: bool = False
    checks: list = field(default_factory=list)      # (name, passed, detail)
    blockers: list = field(default_factory=list)
    counts: dict = field(default_factory=dict)

    @property
    def exit_code(self) -> int:
        if self.cannot_run_reason is not None:
            return 2
        return 0 if self.releasable else 1

    @property
    def verdict(self) -> str:
        if self.cannot_run_reason is not None:
            return "CANNOT_RUN"
        return "READY" if self.releasable else "NOT_READY"

    @property
    def machine_line(self) -> str:
        return (f"RELEASE={self.verdict} blockers={len(self.blockers)} "
                f"candidate={str(self.candidate_identity)[:16]}")


def decide(
    spec_path: pathlib.Path = SPEC,
    lock_path: pathlib.Path = LOCK,
    ledger_path: pathlib.Path | None = None,
    candidate_identity: str | None = None,
) -> ReleaseDecision:
    """Run every release check and return ONE decision.

    Every check runs; none short-circuits. A reader needs the whole list of reasons,
    not the first one -- and a short-circuit is how a gate comes to be reported as
    "it failed on identity" when four other things were also wrong.
    """
    decision = ReleaseDecision()

    verify_spec = _load_sibling("verify_spec", "verify-spec.py")
    stability = _load_sibling("stability", "stability.py")

    if not lock_path.is_file():
        decision.cannot_run_reason = f"no lock at {lock_path}"
        return decision
    try:
        lock = json.loads(lock_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        decision.cannot_run_reason = f"the lock is unreadable: {exc}"
        return decision

    recorded = (lock.get("deployment") or {}).get("identity")
    decision.recorded_identity = recorded
    decision.candidate_identity = candidate_identity or recorded

    # --- 1. verify-spec must pass ---------------------------------------------
    spec_result = verify_spec.validate_everything(spec_path=spec_path, lock_path=lock_path)
    if spec_result.cannot_run_reason is not None:
        decision.cannot_run_reason = (
            f"verify-spec cannot run: {spec_result.cannot_run_reason}")
        return decision
    decision.checks.append((
        "1 verify-spec passes",
        spec_result.exit_code == 0,
        f"{len(spec_result.problems)} problem(s)" if spec_result.problems else "clean",
    ))

    try:
        spec = json.loads(spec_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        decision.cannot_run_reason = f"the spec is unreadable: {exc}"
        return decision
    cases = spec.get("cases") or []
    decision.counts = dict(spec_result.status_counts)

    # --- 2. the identity is fresh ---------------------------------------------
    recomputed, problems = _recompute_identity(lock)
    decision.recomputed_identity = recomputed
    if problems:
        decision.checks.append(("2 identity is fresh", False, "; ".join(problems)))
    else:
        fresh = recomputed == recorded
        decision.identity_fresh = fresh
        decision.checks.append((
            "2 identity is fresh",
            fresh,
            "the lock matches the tree" if fresh
            else f"lock records {str(recorded)[:16]}... but the tree recomputes "
                 f"{str(recomputed)[:16]}... -- the evidence describes a different artifact",
        ))
        if not fresh:
            decision.blockers.append(
                f"STALE IDENTITY: recorded {str(recorded)[:16]}... != recomputed "
                f"{str(recomputed)[:16]}...")

    # --- 2b. an explicitly requested candidate must be the recorded one --------
    if candidate_identity is not None and candidate_identity != recorded:
        decision.checks.append((
            f"2b candidate {candidate_identity[:16]}... is the recorded identity",
            False,
            f"the lock records {str(recorded)[:16]}...",
        ))
        decision.blockers.append(
            f"the requested candidate {candidate_identity[:16]}... is not the identity "
            "the lock records, so no evidence in this tree describes it")

    # --- 3/5/6. per-case status blockers --------------------------------------
    fail_ids = [c.get("id") for c in cases if c.get("status") == "FAIL"]
    flaky_ids = [c.get("id") for c in cases if c.get("status") == "FLAKY"]
    invalidated_ids = [c.get("id") for c in cases if c.get("status") == "INVALIDATED"]
    mandatory = [c for c in cases if c.get("mandatory")]
    not_run_ids = [c.get("id") for c in mandatory if c.get("status") == "NOT_RUN"]
    running_ids = [c.get("id") for c in mandatory if c.get("status") == "RUNNING"]

    decision.checks.append((
        "3 no FAIL",
        not fail_ids,
        "none" if not fail_ids else f"{len(fail_ids)}: {', '.join(map(str, fail_ids[:8]))}",
    ))
    if fail_ids:
        decision.blockers.append(f"FAIL: {len(fail_ids)} mandatory case(s) failed")

    # 4. FLAKY, read from the append-only ledger AND from the spec's own statuses.
    #    Two sources on purpose: the spec status is what a case's author recorded,
    #    the ledger is the append-only observation record. A case is FLAKY if
    #    EITHER says so, and the ledger is the one a rerun cannot edit.
    ledger, ledger_problems = stability.load_ledger(
        ledger_path if ledger_path is not None else stability.LEDGER)
    case_ids = [c.get("id") for c in cases if isinstance(c.get("id"), str)]
    ledger_flaky = [v.case_id for v in stability.flaky_cases(ledger, case_ids)]
    if ledger_problems:
        decision.checks.append((
            "4 no FLAKY (stability ledger)",
            False,
            f"the ledger itself is malformed: {'; '.join(ledger_problems[:3])}",
        ))
        decision.blockers.append(
            f"the stability ledger is malformed ({len(ledger_problems)} problem(s)), so "
            "stability is UNKNOWN and an unknown is not a pass")
    else:
        combined = sorted(set(flaky_ids) | set(ledger_flaky))
        decision.checks.append((
            "4 no FLAKY (spec status and stability ledger)",
            not combined,
            "none" if not combined else
            f"{len(combined)}: {', '.join(combined[:8])} (a green rerun does not clear these)",
        ))
        if combined:
            decision.blockers.append(
                f"FLAKY: {len(combined)} case(s) produced mixed results on the same "
                "candidate; only a new candidate with a causal fix clears them")

    decision.checks.append((
        "5 no NOT_RUN among mandatory cases",
        not not_run_ids and not running_ids,
        "none" if not (not_run_ids or running_ids) else
        f"{len(not_run_ids)} NOT_RUN, {len(running_ids)} RUNNING",
    ))
    if not_run_ids or running_ids:
        decision.blockers.append(
            f"NOT_RUN/RUNNING: {len(not_run_ids) + len(running_ids)} mandatory case(s) "
            "have no verdict; silence is not a pass")

    decision.checks.append((
        "6 no INVALIDATED",
        not invalidated_ids,
        "none" if not invalidated_ids else f"{len(invalidated_ids)} case(s)",
    ))
    if invalidated_ids:
        decision.blockers.append(
            f"INVALIDATED: {len(invalidated_ids)} case(s) carry evidence a previous "
            "identity move superseded")

    # --- 7. no stale evidence -------------------------------------------------
    # verify-spec already checks hashes and existence; this reports the count so the
    # decision shows WHICH case made it stale rather than only that something did.
    stale = [p for p in spec_result.problems
             if "does not exist" in p or "hashes to" in p]
    decision.checks.append((
        "7 no stale evidence",
        not stale,
        "none" if not stale else f"{len(stale)} stale/missing evidence reference(s)",
    ))
    if stale:
        decision.blockers.append(
            f"STALE EVIDENCE: {len(stale)} evidence file(s) missing or hash-mismatched")

    # --- 8. only explicitly allowlisted BLOCKED_EXTERNAL ----------------------
    blocked = [c for c in cases if c.get("status") == "BLOCKED_EXTERNAL"]
    unauthorized: list[str] = []
    for case in blocked:
        cid = case.get("id")
        entry = BLOCKED_EXTERNAL_ALLOWLIST.get(cid)
        if entry is None:
            unauthorized.append(f"{cid} (not on the allowlist)")
            continue
        if not _lock_condition_holds(lock, entry["condition"]):
            unauthorized.append(
                f"{cid} (allowlisted only while "
                f"{entry['condition'][0]}.{entry['condition'][1]}=={entry['condition'][2]}, "
                "which no longer holds, so the case is now required)")
    decision.checks.append((
        "8 only allowlisted BLOCKED_EXTERNAL",
        not unauthorized,
        "none" if not unauthorized else "; ".join(unauthorized),
    ))
    if unauthorized:
        decision.blockers.append(
            f"UNAUTHORIZED BLOCKED_EXTERNAL: {len(unauthorized)} case(s) are blocked "
            "without an allowlist entry whose condition still holds")

    # --- 9. post-integration assembled-product evidence -----------------------
    assembled_cases = [
        c for c in cases
        if c.get("layer") in ASSEMBLED_PRODUCT_LAYERS and c.get("status") == "PASS"
    ]
    assembled_with_evidence = [
        c for c in assembled_cases
        if any(isinstance(e, dict) and e.get("identity") == recorded
               for e in (c.get("evidence") or []))
    ]
    decision.checks.append((
        "9 post-integration assembled-product evidence at the current identity",
        bool(assembled_with_evidence),
        f"{len(assembled_with_evidence)} of {len(assembled_cases)} assembled-product "
        "PASS case(s) carry evidence stamped with the current identity"
        if assembled_cases else
        "no assembled-product (T2/T3/T4/T6) PASS case exists at all",
    ))
    if not assembled_with_evidence:
        decision.blockers.append(
            "NO POST-INTEGRATION ASSEMBLED-PRODUCT EVIDENCE: no T2/T3/T4/T6 case carries "
            "a PASS with evidence stamped at the current identity. This is the check that "
            "makes 'a gate that is not run post-integration is not a gate' mechanical")

    decision.releasable = not decision.blockers and all(p for _, p, _ in decision.checks)
    return decision


def render(decision: ReleaseDecision, as_json: bool = False, quiet: bool = False) -> None:
    if as_json:
        print(json.dumps({
            "verdict": decision.verdict,
            "releasable": decision.releasable,
            "blockers": decision.blockers,
            "checks": [{"name": n, "passed": p, "detail": d} for n, p, d in decision.checks],
            "recorded_identity": decision.recorded_identity,
            "recomputed_identity": decision.recomputed_identity,
            "identity_fresh": decision.identity_fresh,
            "counts": decision.counts,
            "cannot_run_reason": decision.cannot_run_reason,
        }, indent=2, sort_keys=True))
        return

    print(decision.machine_line)
    if decision.cannot_run_reason is not None:
        print(f"release-gate: cannot run: {decision.cannot_run_reason}", file=sys.stderr)
        return
    if not quiet:
        print(f"candidate   {str(decision.candidate_identity)[:16]}...")
        print(f"recorded    {str(decision.recorded_identity)[:16]}...")
        print(f"recomputed  {str(decision.recomputed_identity)[:16]}...")
        print("  " + ", ".join(f"{k}={v}" for k, v in sorted(decision.counts.items())))
        print("")
    for name, passed, detail in decision.checks:
        print(f"  [{'ok  ' if passed else 'FAIL'}] {name}")
        print(f"          {detail}")
    print("")
    if decision.blockers:
        print(f"release-gate: NOT_READY -- {len(decision.blockers)} blocker(s):")
        for b in decision.blockers:
            print(f"  - {b}")
        return
    print("release-gate: READY. Every release condition holds.")
    print("This says the RECORD is releasable, not that the product is correct:")
    print("it cannot judge whether the oracles in that record are the right ones.")


def main() -> int:
    parser = argparse.ArgumentParser(description="decide whether this candidate may be released")
    parser.add_argument("--json", action="store_true")
    parser.add_argument("--quiet", action="store_true")
    parser.add_argument("--candidate", default=None,
                        help="require this exact candidate identity to be the recorded one")
    args = parser.parse_args()

    decision = decide(candidate_identity=args.candidate)
    render(decision, as_json=args.json, quiet=args.quiet)
    return decision.exit_code


if __name__ == "__main__":
    sys.exit(main())
